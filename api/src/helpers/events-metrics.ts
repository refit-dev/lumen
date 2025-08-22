import { createClient, RedisClientOptions } from "redis";
import { env } from "../env";
import { logger } from "./logging";
import { getSecret } from "./secrets"; // Import the secret helper

const {
  NODE_ENV: nodeEnv,
  REDIS_HOST: redisHost,
  REDIS_PORT: redisPort,
  REDIS_PASSWORD: devRedisPassword, // Password used directly only in dev/test
  REDIS_TLS_ENABLED: redisTlsEnabled,
} = env;

// Define the type for the client based on the createClient function's return type
type EventsRedisClientType = ReturnType<typeof createClient>;

// Memoized Redis client instance - use the inferred type + null
let redisClient: EventsRedisClientType | null = null;
let isConnecting = false; // Flag to prevent concurrent connection attempts
let connectionPromise: Promise<EventsRedisClientType> | null = null; // Store the promise

/**
 * Get a configured Redis client instance for the Events and Metrics system.
 * Handles memoization and connection state.
 */
export async function getEventsRedisClient(): Promise<EventsRedisClientType> {
  // If client exists and is ready, return it
  if (redisClient && redisClient.isReady) {
    return redisClient;
  }

  // If connection is in progress, return the existing promise
  if (isConnecting && connectionPromise) {
    return connectionPromise;
  }

  // Start the connection process
  isConnecting = true;

  connectionPromise = (async (): Promise<EventsRedisClientType> => {
    logger.debug(
      `Initializing Events/Metrics Redis client for environment: ${nodeEnv}`
    );
    let client: EventsRedisClientType | null = null; // Local client variable for initialization
    const clientOptions: RedisClientOptions = {};
    let actualRedisPassword: string | null | undefined = null;

    try {
      if (nodeEnv === "development" || nodeEnv === "test") {
        const redisUrlDev = `redis://${redisHost}:${redisPort}`;
        logger.debug(`Using Redis URL: ${redisUrlDev}`);
        clientOptions.url = redisUrlDev;
        actualRedisPassword = devRedisPassword; // Use dev password
        logger.debug(
          "Using Redis password from environment variable (dev/test)."
        );
      } else {
        // Staging or Production
        logger.debug(
          `Configuring Events/Metrics Redis for ${nodeEnv}: host=${redisHost}, port=${redisPort}, tls=${redisTlsEnabled}`
        );
        if (!redisTlsEnabled) {
          throw new Error(
            "REDIS_TLS_ENABLED must be true for staging/production environment."
          );
        }

        // Construct the secret name based on the environment
        const secretName = `lumen/${nodeEnv}/redis-password`;
        logger.debug(
          `Attempting to fetch Events/Metrics Redis password from secret name: ${secretName}`
        );
        try {
          actualRedisPassword = await getSecret(secretName);
          if (
            actualRedisPassword === null ||
            actualRedisPassword === undefined
          ) {
            logger.warn(
              `Fetched Events/Metrics Redis password from secret ${secretName} is null/undefined. Proceeding without password.`
            );
            actualRedisPassword = null;
          } else if (actualRedisPassword === "") {
            logger.warn(
              `Fetched Events/Metrics Redis password from secret ${secretName} is empty string. Proceeding with empty password.`
            );
          } else {
            logger.debug(
              "Successfully fetched non-empty Events/Metrics Redis password from Secrets Manager."
            );
          }
        } catch (error) {
          // getSecret already logs the error
          logger.error(
            `Failed to fetch or process Events/Metrics Redis password from secret ${secretName}.`
          );
          // Decide if failure to get secret should be fatal. For now, let it proceed without password.
          // throw new Error(`Failed to fetch Events/Metrics Redis password from secret ${secretName}: ${error}`);
          actualRedisPassword = null; // Ensure it's null if fetch failed
        }

        clientOptions.socket = {
          host: redisHost,
          port: redisPort,
          tls: true, // Enforce TLS
        };
      }

      // Set password if applicable
      if (actualRedisPassword !== null && actualRedisPassword !== undefined) {
        clientOptions.password = actualRedisPassword; // Use fetched/dev password
        logger.debug(
          `Using Events/Metrics Redis password authentication (length: ${
            actualRedisPassword.length
          }).`
        );
      } else {
        if (nodeEnv !== "development" && nodeEnv !== "test") {
          logger.info(
            "Connecting to Events/Metrics Redis without password authentication (staging/production)."
          );
        }
      }

      // Create client with assembled options
      client = createClient(clientOptions);

      if (!client) {
        // Should not happen if createClient succeeds, but check anyway
        throw new Error("Events/Metrics Redis client creation returned null.");
      }

      client.on("error", (err) => {
        logger.error("Events/Metrics Redis Client Error:", err);
        // Reset state on persistent error
        redisClient = null;
        isConnecting = false;
        connectionPromise = null;
      });

      client.on("ready", () => {
        logger.debug("Events/Metrics Redis client connected and ready.");
      });

      logger.debug("Connecting to Events/Metrics Redis...");
      await client.connect(); // Wait for connection
      logger.debug("Events/Metrics Redis client connected successfully.");

      redisClient = client; // Assign to memoized variable only after successful connect
      isConnecting = false;
      return redisClient; // Return the connected client
    } catch (error) {
      logger.error(
        "Error initializing or connecting Events/Metrics Redis client:",
        error
      );
      isConnecting = false;
      connectionPromise = null; // Clear promise on error
      // Prevent returning a potentially broken or null client
      throw new Error(
        `Failed to initialize/connect Events/Metrics Redis client: ${error}`
      );
    }
  })();

  return connectionPromise;
}

/**
 * Disconnects the Events and Metrics Redis client gracefully.
 * Used for clean shutdown or to reset the connection.
 */
export async function disconnectEventsRedisClient(): Promise<void> {
  if (redisClient && redisClient.isOpen) {
    try {
      await redisClient.quit();
      logger.debug("Events/Metrics Redis client disconnected gracefully.");
    } catch (err) {
      logger.error("Error disconnecting Events/Metrics Redis client:", err);
    } finally {
      redisClient = null;
      isConnecting = false;
      connectionPromise = null;
    }
  }
}
