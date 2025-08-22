import {
  createClient,
  RedisClientOptions,
  RedisClientType as OriginalRedisClientType,
} from "redis";
import { env } from "../env";
import { logger } from "../helpers/logging";
import { getSecret } from "../helpers/secrets";

const {
  NODE_ENV: nodeEnv,
  REDIS_HOST: redisHost,
  REDIS_PORT: redisPort,
  REDIS_PASSWORD: devRedisPassword,
  REDIS_TLS_ENABLED: redisTlsEnabled,
  REDIS_RECONNECT_STRATEGY,
  REDIS_RECONNECT_MAX_RETRIES,
  REDIS_RECONNECT_MAX_DELAY_MS,
} = env;

// Enhanced Redis client with retry capabilities
export interface RedisClientType extends OriginalRedisClientType {
  ensureConnection(): Promise<void>;
}

let redisClient: RedisClientType | null = null;
let isConnecting = false;
let connectionPromise: Promise<RedisClientType> | null = null;
let connectionAttempts = 0;
// Defaults if not provided via env
const MAX_RECONNECT_ATTEMPTS = REDIS_RECONNECT_MAX_RETRIES ?? 10;
const MAX_RECONNECT_DELAY_MS = REDIS_RECONNECT_MAX_DELAY_MS ?? 5000;

/**
 * Creates a Redis client with the appropriate configuration and enhanced reconnection capabilities
 */
async function createRedisClient(): Promise<RedisClientType> {
  const redisClientOptions: RedisClientOptions = {};
  let actualRedisPassword: string | undefined | null = null;

  if (nodeEnv === "development" || nodeEnv === "test") {
    const redisUrl = `redis://${redisHost}:${redisPort}`;
    logger.debug(`Using Redis URL: ${redisUrl}`);
    redisClientOptions.url = redisUrl;
    actualRedisPassword = devRedisPassword; // Use env var directly for dev/test
    // No TLS needed typically in local dev/test via docker-compose
    logger.debug("Using Redis password from environment variable (dev/test).");
  } else {
    // Staging/Production
    logger.debug(
      `Configuring Redis for ${nodeEnv}: host=${redisHost}, port=${redisPort}, tls=${redisTlsEnabled}`
    );
    if (!redisTlsEnabled) {
      // Enforce TLS for non-dev environments
      throw new Error(
        "REDIS_TLS_ENABLED must be true for staging/production environment."
      );
    }

    // Construct the secret name based on the environment
    const secretName = `lumen/${nodeEnv}/redis-password`;
    logger.debug(
      `Attempting to fetch Redis password from secret name: ${secretName}`
    );
    try {
      actualRedisPassword = await getSecret(secretName);
      if (actualRedisPassword === null || actualRedisPassword === undefined) {
        // Handle case where secret exists but is null/undefined (should not happen ideally)
        logger.warn(
          `Fetched Redis password from secret ${secretName} is null or undefined. Proceeding without password.`
        );
        actualRedisPassword = null; // Explicitly set to null
      } else if (actualRedisPassword === "") {
        // Handle case where secret exists but is an empty string (might be intentional?)
        logger.warn(
          `Fetched Redis password from secret ${secretName} is an empty string. Proceeding with empty password.`
        );
      } else {
        logger.debug(
          "Successfully fetched non-empty Redis password from Secrets Manager."
        );
      }
    } catch (error) {
      // getSecret already logs the error
      logger.error(
        `Failed to fetch or process Redis password from secret ${secretName}.`
      );
      // Decide if failure to get secret should be fatal. For now, let it proceed without password.
      // throw new Error(`Failed to fetch Redis password from secret ${secretName}: ${error}`);
      actualRedisPassword = null; // Ensure it's null if fetch failed
    }

    // Configure socket with TLS for staging/prod
    redisClientOptions.socket = {
      host: redisHost,
      port: redisPort,
      tls: true, // Enforce TLS
    };
  }

  // Set password if found (either from env var in dev/test or secret in staging/prod)
  // Note: redis client library handles null/undefined password gracefully (no AUTH command sent)
  if (actualRedisPassword !== null && actualRedisPassword !== undefined) {
    redisClientOptions.password = actualRedisPassword;
    logger.debug(
      `Using Redis password authentication (length: ${actualRedisPassword.length}).`
    );
  } else {
    // Log if no password is being used (except potentially in dev/test)
    if (nodeEnv !== "development" && nodeEnv !== "test") {
      logger.info(
        "Connecting to Redis without password authentication (staging/production)."
      );
    }
  }

  // Add reconnection strategy (applies to all environments)
  if (REDIS_RECONNECT_STRATEGY === "backoff") {
    // Exponential backoff strategy
    redisClientOptions.socket = {
      ...redisClientOptions.socket,
      reconnectStrategy: (retries) => {
        connectionAttempts = retries;
        if (retries > MAX_RECONNECT_ATTEMPTS) {
          logger.error(`Redis reconnection failed after ${retries} attempts`);
          return new Error(
            `Redis reconnection failed after ${retries} attempts`
          );
        }

        // Exponential backoff with max delay cap
        const delay = Math.min(
          Math.pow(2, retries) * 100,
          MAX_RECONNECT_DELAY_MS
        );
        logger.debug(`Redis reconnecting in ${delay}ms (attempt ${retries})`);
        return delay;
      },
    };
  } else {
    // Default strategy (immediate retry with a small delay)
    redisClientOptions.socket = {
      ...redisClientOptions.socket,
      reconnectStrategy: (retries) => {
        connectionAttempts = retries;
        if (retries > MAX_RECONNECT_ATTEMPTS) {
          logger.error(`Redis reconnection failed after ${retries} attempts`);
          return new Error(
            `Redis reconnection failed after ${retries} attempts`
          );
        }
        logger.debug(`Redis reconnecting in 500ms (attempt ${retries})`);
        return 500; // Retry after 500ms
      },
    };
  }

  // Create the Redis client
  const client = createClient(redisClientOptions) as RedisClientType;

  // Enhance the client with our custom method for ensuring connections
  client.ensureConnection = async function () {
    if (!this.isReady && !this.isOpen) {
      logger.debug("Redis client not connected, reconnecting...");
      try {
        await this.connect();
        connectionAttempts = 0;
        logger.debug("Redis client reconnected successfully");
      } catch (err) {
        logger.error("Failed to reconnect Redis client:", err);
        throw err;
      }
    }
  };

  // Set up event handlers
  client.on("error", (err) => {
    logger.error("Redis Client Error:", err);
    if (client === redisClient) {
      // Only reset if this is the current client
      redisClient = null;
      isConnecting = false;
      connectionPromise = null;
    }
  });

  client.on("connect", () => {
    logger.debug("Redis client connected");
    connectionAttempts = 0;
  });

  client.on("reconnecting", () => {
    logger.debug(`Redis client reconnecting (attempt ${connectionAttempts})`);
  });

  client.on("end", () => {
    logger.debug("Redis client connection closed");
    if (client === redisClient) {
      // Only reset if this is the current client
      redisClient = null;
      isConnecting = false;
      connectionPromise = null;
    }
  });

  return client;
}

/**
 * Creates or returns a shared Redis client instance, connecting if necessary.
 * Uses memoization to avoid duplicate connections and adds robust reconnection.
 */
export async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient && redisClient.isReady) {
    return redisClient;
  }

  // If the client exists but isn't ready, attempt to reconnect
  if (redisClient && !redisClient.isReady && !isConnecting) {
    try {
      logger.debug(
        "Redis client exists but isn't ready, attempting reconnect..."
      );
      await redisClient.ensureConnection();
      // Check again if connection succeeded
      if (redisClient && redisClient.isReady) {
        logger.debug("Existing Redis client reconnected successfully.");
        return redisClient;
      }
      logger.warn("Attempted reconnect on existing client failed.");
      // Proceed to create new client if reconnect failed
      redisClient = null; // Reset client state
    } catch (err) {
      logger.error("Failed to reconnect existing Redis client:", err);
      // Reset client and continue to create a new one
      redisClient = null;
    }
  }

  if (isConnecting && connectionPromise) {
    logger.debug(
      "Connection attempt already in progress, returning existing promise."
    );
    return connectionPromise;
  }

  isConnecting = true;
  connectionPromise = (async (): Promise<RedisClientType> => {
    logger.debug(`Initializing new Redis client for environment: ${nodeEnv}`);
    try {
      const client = await createRedisClient(); // Await the async creation

      logger.debug("Connecting new Redis client...");
      await client.connect();
      logger.debug("New Redis client connected successfully.");

      redisClient = client;
      isConnecting = false;
      return redisClient;
    } catch (error) {
      logger.error("Error initializing or connecting new Redis client:", error);
      isConnecting = false;
      connectionPromise = null; // Clear promise on failure
      // Propagate error to caller
      throw new Error(`Failed to initialize/connect Redis client: ${error}`);
    }
  })();

  return connectionPromise;
}

/**
 * Function that takes an async Redis operation and ensures it completes
 * by automatically reconnecting if the client is disconnected.
 *
 * @param operation Function that takes a Redis client and performs an operation
 * @returns The result of the operation
 */
export async function withRedisReconnect<T>(
  operation: (client: RedisClientType) => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let retries = 0;

  while (retries <= maxRetries) {
    try {
      // Get potentially new/reconnected client for each attempt
      const client = await getRedisClient();

      // Ensure the client is connected before operation
      // getRedisClient should handle this, but double-check
      if (!client.isReady) {
        logger.warn(
          "Client not ready before operation, attempting ensureConnection..."
        );
        await client.ensureConnection(); // Should ideally not be needed if getRedisClient works
        if (!client.isReady) {
          throw new Error(
            "Client failed to connect/reconnect before operation."
          );
        }
      }

      // Perform the operation
      return await operation(client);
    } catch (error: any) {
      retries++;
      logger.warn(
        `Redis operation failed (attempt ${retries}/${maxRetries}): ${error.message}`
      );

      if (
        error.message?.includes("closed") ||
        error.message?.includes("The client is closed") ||
        error.message?.includes("connection") ||
        error.message?.includes("timeout") ||
        error.message?.includes("Client failed to connect/reconnect") // Catch error from above check
      ) {
        if (retries <= maxRetries) {
          const delay = 100 * Math.pow(2, retries - 1); // Exponential backoff for retries
          logger.warn(
            `Retrying Redis operation due to connection issue in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));

          // Force a reconnection attempt on the next getRedisClient call
          if (redisClient) {
            try {
              if (redisClient.isOpen) {
                logger.debug("Disconnecting existing client before retry...");
                await redisClient.disconnect();
              }
            } catch (disconnectErr) {
              logger.error(
                "Error during disconnect before retry:",
                disconnectErr
              );
            }
          }
          // Reset global state to force re-initialization/reconnection attempt
          redisClient = null;
          isConnecting = false;
          connectionPromise = null;

          continue; // Continue to next iteration of the while loop
        }
      }

      // For non-connection errors or if we've exceeded max retries, propagate the error
      logger.error(
        `Redis operation failed permanently after ${retries} retries:`,
        error
      );
      throw error; // Rethrow the last error
    }
  }

  // Should be unreachable if loop logic is correct, but satisfy TypeScript
  throw new Error(`Redis operation failed after ${maxRetries} retries`);
}
