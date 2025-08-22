import { getRedisClient, RedisClientType } from "../lib/redis";
import { env } from "../env";
// Define the rate limit info interface
export interface RateLimitInfo {
  isAllowed: boolean;
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp in seconds when the window resets
}

// Define the types of identifiers we can rate limit
export type RateLimitType = "key" | "ip";

export class RateLimiter {
  private client: RedisClientType | null = null; // Can be null initially
  private initializationPromise: Promise<void>; // To track async initialization

  // Default limits (used for API Keys or fallback)
  private defaultWindowSeconds: number;
  private defaultMaxRequests: number;
  // IP-specific limits
  private ipWindowSeconds: number;
  private ipMaxRequests: number;

  constructor() {
    // Read general configuration from environment variables
    this.defaultWindowSeconds = env.RATE_LIMIT_WINDOW_SECONDS;
    this.defaultMaxRequests = env.RATE_LIMIT_MAX_REQUESTS;

    // Read IP-specific configuration, falling back to general ones
    this.ipWindowSeconds = env.RATE_LIMIT_IP_WINDOW_SECONDS;
    this.ipMaxRequests = env.RATE_LIMIT_IP_MAX_REQUESTS;

    // Start client initialization, don't block constructor
    this.initializationPromise = this.initializeClient();
  }

  // Separate async initialization function
  private async initializeClient(): Promise<void> {
    try {
      this.client = await getRedisClient();
      console.debug("RateLimiter initialized with Redis client.");
    } catch (error) {
      console.error("RateLimiter failed to initialize Redis client:", error);
      // Keep client as null, checkRateLimit needs to handle this
      this.client = null;
    }
  }

  // Include the type in the Redis key
  private getKey(identifier: string, type: RateLimitType): string {
    return `rate_limit:${type}:${identifier}`;
  }

  // Accept identifier and type, use appropriate limits
  async checkRateLimit(
    identifier: string,
    type: RateLimitType
  ): Promise<RateLimitInfo> {
    // Ensure client is initialized before proceeding
    await this.initializationPromise;

    // Check if client initialization failed
    if (!this.client || !this.client.isReady) {
      console.error(
        "Rate limiter check skipped: Redis client not available or not ready."
      );
      // Fail-open: Allow request but log error
      return {
        isAllowed: true,
        limit: type === "ip" ? this.ipMaxRequests : this.defaultMaxRequests,
        remaining: type === "ip" ? this.ipMaxRequests : this.defaultMaxRequests,
        reset:
          Math.floor(Date.now() / 1000) +
          (type === "ip" ? this.ipWindowSeconds : this.defaultWindowSeconds),
      };
    }

    // Determine limits based on type
    const windowSeconds =
      type === "ip" ? this.ipWindowSeconds : this.defaultWindowSeconds;
    const maxRequests =
      type === "ip" ? this.ipMaxRequests : this.defaultMaxRequests;

    const now = Math.floor(Date.now() / 1000); // Current time in seconds
    const windowStart = now - windowSeconds;
    const key = this.getKey(identifier, type); // Use type in key

    try {
      // Start a Redis transaction
      const multi = this.client.multi();

      // Remove old entries outside the current window
      multi.zRemRangeByScore(key, 0, windowStart);

      // Add the current request timestamp
      multi.zAdd(key, {
        score: now,
        value: now.toString(), // Value doesn't strictly matter here, timestamp is fine
      });

      // Get the count of requests in the current window
      multi.zCard(key);

      // Set the key expiration slightly longer than the window for cleanup
      multi.expire(key, windowSeconds + 60);

      // Execute all commands atomically
      // Need to cast results as Redis client types might be broad
      const results = (await multi.exec()) as Array<string | number | null>;

      if (!results) {
        // If exec returns null, it means WATCH failed (not used here) or command failed
        // Let's treat it like a general error for simplicity
        console.error(
          "Redis transaction failed or returned null results for key:",
          key
        );
        throw new Error("Redis transaction failed");
      }

      // ZCARD result is at index 2 (0: zRemRangeByScore, 1: zAdd, 2: zCard)
      // Ensure result exists and is a number, default to 0 otherwise
      const requestCount = typeof results[2] === "number" ? results[2] : 0;

      // Calculate reset time - when this window resets based on the NOW of the check
      // Note: This is a sliding window, so 'reset' means when the *current* request expires
      // A more accurate reset might be based on the oldest entry + window, but this is simpler.
      const reset = now + windowSeconds;

      // Check if we're within limits
      const isAllowed = requestCount <= maxRequests;
      const remaining = Math.max(0, maxRequests - requestCount);

      return {
        isAllowed,
        limit: maxRequests, // Return the specific limit applied
        remaining,
        reset,
      };
    } catch (error) {
      console.error(
        `Rate limiting error for type ${type}, identifier ${identifier}:`,
        error
      );
      // If Redis fails, we'll allow the request but log the error (Fail-Open)
      return {
        isAllowed: true,
        limit: maxRequests, // Show the intended limit
        remaining: maxRequests, // Assume full remaining on error
        reset: now + windowSeconds,
      };
    }
  }

  async disconnect(): Promise<void> {
    // Ensure client is initialized before trying to disconnect
    await this.initializationPromise;
    // Only attempt disconnect if client was successfully created and is open
    if (this.client && this.client.isOpen) {
      console.debug("Disconnecting RateLimiter Redis client.");
      await this.client.quit();
      this.client = null; // Reset client state
    }
  }
}
