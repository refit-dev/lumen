import { SSEStreamingApi } from "hono/streaming";
import { getRedisClient, withRedisReconnect } from "./redis";

// Local in-memory map for SSE connections on THIS instance
export const sseClients = new Map<string, SSEStreamingApi>();

// Redis pub/sub channel for broadcasting events across instances
const SSE_CHANNEL = "lumen:sse:events";

// How long to cache events in Redis (in case SSE connects late)
const EVENT_CACHE_TTL_SECONDS = 300; // 5 minutes

// Unique ID for this instance to avoid self-delivery duplication
const INSTANCE_ID =
  process.env.INSTANCE_ID ||
  `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// Subscriber client (separate from main client for pub/sub)
// Note: duplicate() returns a base client without our custom ensureConnection method
let subscriberClient: Awaited<
  ReturnType<Awaited<ReturnType<typeof getRedisClient>>["duplicate"]>
> | null = null;
let isSubscribed = false;
let initializationPromise: Promise<void> | null = null;

/**
 * Initialize the Redis subscriber for SSE events
 * This should be called once when the server starts
 * Uses promise-based guard to prevent race condition from concurrent calls
 */
export async function initializeSSESubscriber() {
  // If already initialized, return immediately
  if (isSubscribed && subscriberClient) {
    console.log("SSE subscriber already initialized");
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    console.log(
      "SSE subscriber initialization already in progress, waiting..."
    );
    return initializationPromise;
  }

  // Create and store the initialization promise
  initializationPromise = (async () => {
    try {
      // Create a DEDICATED subscriber client (separate from the shared client)
      // In node-redis v4, a connection in subscriber mode cannot execute regular commands
      const sharedClient = await getRedisClient();
      const newSubscriber = sharedClient.duplicate();
      await newSubscriber.connect();
      console.log("Dedicated subscriber client created and connected");

      // Subscribe to the SSE events channel
      await newSubscriber.subscribe(SSE_CHANNEL, (message) => {
        try {
          const { intentId, event, sourceId } = JSON.parse(message);

          // Ignore events published by this same instance (we already delivered locally)
          if (sourceId === INSTANCE_ID) {
            return;
          }

          // Check if we have a local SSE connection for this intent
          const clientStream = sseClients.get(intentId);

          if (clientStream) {
            console.log(`Delivering event to local SSE client: ${intentId}`);

            clientStream
              .writeSSE({
                data: JSON.stringify(event),
                event: "stripe_event",
                id: crypto.randomUUID(),
              })
              .catch((error) => {
                console.error(
                  `Failed to write to SSE stream for ${intentId}:`,
                  error
                );
                // Clean up dead connection
                sseClients.delete(intentId);
              });
          } else {
            console.log(
              `No local SSE client found for ${intentId} on this instance`
            );
          }
        } catch (error) {
          console.error("Failed to process SSE message from Redis:", error);
        }
      });

      // Only assign after successful subscription
      subscriberClient = newSubscriber;
      isSubscribed = true;
      console.log("SSE Redis subscriber initialized successfully");
    } catch (error) {
      console.error("Failed to initialize SSE subscriber:", error);
      isSubscribed = false;
      subscriberClient = null;
      initializationPromise = null; // Clear promise on failure
      throw error;
    } finally {
      // Clear the promise after completion (success or failure)
      // Don't set to null in try block as that would prevent awaiting callers from resolving
      if (isSubscribed) {
        initializationPromise = null;
      }
    }
  })();

  return initializationPromise;
}

/**
 * Register a new SSE client connection
 * @param intentId - Payment/Setup Intent ID
 * @param stream - SSE stream
 * @returns Array of cached events (if any)
 */
export async function registerSSEClient(
  intentId: string,
  stream: SSEStreamingApi
): Promise<{ cachedEvents: any[] }> {
  console.log(`Registering SSE client for intent: ${intentId}`);

  // Store locally
  sseClients.set(intentId, stream);

  // Check for cached events in Redis
  const cachedEvents: any[] = [];

  try {
    await withRedisReconnect(async (client) => {
      const cacheKey = `sse:cache:${intentId}`;
      // Use HGETALL to retrieve all unique events from the hash
      const eventHash = await client.hGetAll(cacheKey);

      for (const eventJson of Object.values(eventHash)) {
        try {
          cachedEvents.push(JSON.parse(eventJson));
        } catch (err) {
          console.error("Failed to parse cached event:", err);
        }
      }

      if (cachedEvents.length > 0) {
        console.log(
          `Found ${cachedEvents.length} cached events for ${intentId}`
        );
      }
    });
  } catch (error) {
    console.error(`Failed to retrieve cached events for ${intentId}:`, error);
    // Non-fatal - continue without cached events
  }

  return { cachedEvents };
}

/**
 * Unregister an SSE client connection
 * @param intentId - Payment/Setup Intent ID
 */
export function unregisterSSEClient(intentId: string): void {
  console.log(`Unregistering SSE client for intent: ${intentId}`);
  sseClients.delete(intentId);
}

/**
 * Publish an event to SSE clients across all instances
 * @param intentId - Payment/Setup Intent ID
 * @param event - Event data to send
 * @returns Status of delivery
 */
export async function publishSSEEvent(
  intentId: string,
  event: any
): Promise<{
  deliveredLocally: boolean;
  publishedToRedis: boolean;
  cachedInRedis: boolean;
}> {
  const result = {
    deliveredLocally: false,
    publishedToRedis: false,
    cachedInRedis: false,
  };

  // Try to deliver locally first (fast path)
  const localStream = sseClients.get(intentId);
  if (localStream) {
    try {
      await localStream.writeSSE({
        data: JSON.stringify(event),
        event: "stripe_event",
        id: crypto.randomUUID(),
      });
      result.deliveredLocally = true;
      console.log(`Event delivered locally for ${intentId}`);
    } catch (error) {
      console.error(`Failed to deliver event locally for ${intentId}:`, error);
      // Clean up dead connection
      sseClients.delete(intentId);
    }
  }

  // Publish to Redis for other instances (and for caching)
  try {
    await withRedisReconnect(async (client) => {
      // Publish to channel for real-time delivery
      const message = JSON.stringify({
        intentId,
        event,
        sourceId: INSTANCE_ID,
      });
      await client.publish(SSE_CHANNEL, message);
      result.publishedToRedis = true;

      // Cache the event in case SSE connects late
      // Use SET to avoid duplicates from Stripe webhook retries
      const cacheKey = `sse:cache:${intentId}`;
      const eventKey = `${event.type}:${event.id || Date.now()}`;
      const eventData = JSON.stringify(event);

      // Use HSET to store events by their unique key
      await client.hSet(cacheKey, eventKey, eventData);
      await client.expire(cacheKey, EVENT_CACHE_TTL_SECONDS);
      result.cachedInRedis = true;

      console.log(`Event published to Redis for ${intentId}`);
    });
  } catch (error) {
    console.error(`Failed to publish event to Redis for ${intentId}:`, error);
    // If we delivered locally, that's still a partial success
    // If not, this is a complete failure
    if (!result.deliveredLocally) {
      console.error(`CRITICAL: Event not delivered anywhere for ${intentId}`);
    }
  }

  return result;
}

/**
 * Get current payment status from database (for polling fallback)
 * @param intentId - Payment/Setup Intent ID
 * @returns Payment status or null if not found
 */
export async function getPaymentStatus(intentId: string): Promise<{
  status: string;
  error?: string;
  subscriptionId?: string;
} | null> {
  try {
    // Import here to avoid circular dependency
    const { db } = await import("../db/client");
    const { payments } = await import("@lumen/common/schema");
    const { eq } = await import("drizzle-orm");

    const payment = await db.query.payments.findFirst({
      where: eq(payments.externalPaymentId, intentId),
    });

    if (!payment) {
      return null;
    }

    return {
      status: payment.status,
      error: payment.errorMessage ?? undefined,
      subscriptionId: payment.metadata?.subscription_id as string | undefined,
    };
  } catch (error) {
    console.error(`Failed to get payment status for ${intentId}:`, error);
    throw error;
  }
}

/**
 * Cleanup function for testing and graceful shutdown
 */
export async function shutdownSSESubscriber(): Promise<void> {
  if (subscriberClient) {
    try {
      await subscriberClient.unsubscribe(SSE_CHANNEL);
      // Check if client is still open before disconnecting
      // unsubscribe() may have already closed it
      if (subscriberClient.isOpen) {
        await subscriberClient.disconnect();
      }
      console.log("SSE subscriber disconnected");
    } catch (error) {
      // Ignore "client already closed" errors during shutdown
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("client is closed")) {
        console.error("Error disconnecting SSE subscriber:", error);
      }
    } finally {
      subscriberClient = null;
      isSubscribed = false;
    }
  }
}

/**
 * Cleanup function for testing
 */
export function clearSseClientsForTesting(): void {
  sseClients.clear();
}
