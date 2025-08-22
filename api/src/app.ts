import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db/client";
import { sql } from "drizzle-orm";
import { auth } from "./auth";
import appRoutes from "./routes";
import { logger } from "hono/logger";
import { getRedisClient, withRedisReconnect } from "./lib/redis";
import {
  uploadFile,
  generatePresignedUrl,
  extractBucketAndKeyFromUrl,
  fileExists,
  deleteFile,
} from "./helpers/s3";
import { merchants } from "@lumen/common/schema";
import { count } from "drizzle-orm";
import { env } from "./env";
import questDbService from "./db/questDbService";
import { Sender } from "@questdb/nodejs-client";

// --- Initialize QuestDB Service ---
console.log("[APP] Starting QuestDB initialization...");
(async () => {
  try {
    console.log("[APP] Initializing QuestDB service...");
    await questDbService.initialize(); // No args needed - service will fetch from env and/or Secrets Manager
    console.log("[APP] QuestDB service initialized successfully.");
  } catch (error) {
    console.error("[APP] FATAL: Failed to initialize QuestDB service:", error);
    console.error(
      "[APP] Stack trace:",
      error instanceof Error ? error.stack : "No stack trace available"
    );
    process.exit(1); // Exit if QuestDB connection fails
  }
})().catch((error) => {
  console.error("[APP] QuestDB initialization wrapper caught error:", error);
  console.error(
    "[APP] Stack trace:",
    error instanceof Error ? error.stack : "No stack trace available"
  );
  process.exit(1);
});
// --- End QuestDB Initialization ---

// Create main Hono app
const app = new Hono();

// CORS middleware

app.use(
  "/v1/public/*",
  cors({
    origin: "*",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

const corsOriginList = Array.from(
  new Set([env.CORS_ORIGIN, "http://localhost:3000", "http://localhost:3001"])
); // multiple dev envs
app.use(
  cors({
    origin: corsOriginList,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);
console.log("[APP] General CORS middleware configured");

// Logger
app.use(logger());
console.log("[APP] Logger middleware configured");

// Mount Better Auth handler
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
console.log("[APP] Auth handler configured");

// Health check route
app.get("/health", async (c) => {
  console.log("[/health] Health check initiated.");
  const healthStatus = {
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    services: {
      database: {
        connected: false,
        error: null as string | null,
      },
      redis: {
        connected: false,
        error: null as string | null,
      },
      questdb: {
        connected: false,
        rest_select_ok: false,
        error: null as string | null,
      },
    },
  };

  // Define check functions
  const checkDatabase = async () => {
    try {
      console.log("[/health] Checking database connection...");
      await db.execute(sql`SELECT 1`);
      healthStatus.services.database.connected = true;
      console.log("[/health] Database connection successful.");
      return { connected: true, error: null };
    } catch (error) {
      console.error("[/health] Database health check failed:", error);
      healthStatus.services.database.connected = false; // Ensure this is set on error
      healthStatus.services.database.error =
        error instanceof Error ? error.message : String(error);
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const checkRedis = async () => {
    try {
      console.log(
        "[/health] Checking Redis connection using withRedisReconnect..."
      );
      const successful = await withRedisReconnect(async (client) => {
        // Use a unique key/value per request to avoid race conditions across concurrent health checks
        const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const testKey = `health_check_test_reconnect_${uniqueSuffix}`;
        const testValue = `test_reconnect_${uniqueSuffix}`;

        // Set the key with a short TTL so even if deletion fails it expires quickly
        await client.set(testKey, testValue, { EX: 30 });

        const fetched = await client.get(testKey);

        // Best-effort delete (ignore errors so health check isn’t affected)
        try {
          await client.del(testKey);
        } catch (_) {
          // noop – key will expire thanks to the TTL we set above
        }

        return fetched === testValue;
      });

      healthStatus.services.redis.connected = successful;
      if (successful) {
        console.log(
          "[/health] Redis connection and operations successful via withRedisReconnect."
        );
      } else {
        // This case might not be hit if withRedisReconnect throws on failure before returning false
        // but it's good for logical completeness.
        console.warn(
          "[/health] Redis operations completed via withRedisReconnect but testValue did not match."
        );
        healthStatus.services.redis.error =
          "Redis set/get/del test failed logic.";
      }
      return {
        connected: successful,
        error: healthStatus.services.redis.error,
      };
    } catch (error) {
      console.error(
        "[/health] Redis health check failed (withRedisReconnect wrapper):",
        error
      );
      healthStatus.services.redis.connected = false;
      healthStatus.services.redis.error =
        error instanceof Error ? error.message : String(error);
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const checkQuestDb = async () => {
    const result = {
      connected: false,
      rest_select_ok: false,
      error: null as string | null,
    };

    // Only Check: SELECT 1 via REST API with authentication
    try {
      console.log("[/health] QuestDB: Checking REST API health (SELECT 1)...");
      const selectQuery = encodeURIComponent("SELECT 1");
      const restUrl = `http://${env.QUESTDB_HOST}:${env.QUESTDB_INGEST_PORT}/exec?query=${selectQuery}`;

      const authString = `${env.QUESTDB_USER}:${questDbService.getIlpPassword()}`;
      const encodedAuth = Buffer.from(authString).toString("base64");

      const restResponse = await fetch(restUrl, {
        headers: {
          Authorization: `Basic ${encodedAuth}`,
        },
      });

      if (!restResponse.ok) {
        const errorText = await restResponse.text();
        throw new Error(
          `REST API SELECT 1 failed with status ${restResponse.status}: ${errorText}`
        );
      }
      const jsonResponse = (await restResponse.json()) as {
        dataset?: unknown[][];
      };
      if (
        jsonResponse &&
        jsonResponse.dataset &&
        jsonResponse.dataset[0] &&
        jsonResponse.dataset[0][0] === 1
      ) {
        result.rest_select_ok = true;
        console.log(
          "[/health] QuestDB: REST API health (SELECT 1) successful."
        );
      } else {
        throw new Error(
          "REST API SELECT 1 returned unexpected response format"
        );
      }
    } catch (restError) {
      console.error(
        "[/health] QuestDB: REST API health (SELECT 1) failed:",
        restError
      );
      result.rest_select_ok = false;
      result.error = `QuestDB REST API SELECT 1 failed: ${restError instanceof Error ? restError.message : String(restError)}`;
    }

    result.connected = result.rest_select_ok; // QuestDB connection depends only on REST check now
    healthStatus.services.questdb = result; // Update main healthStatus object

    if (result.connected) {
      console.log("[/health] QuestDB connection (REST API) successful.");
    } else {
      console.log("[/health] QuestDB connection (REST API) failed.");
    }
    return result;
  };

  // Execute checks
  await Promise.all([checkDatabase(), checkRedis(), checkQuestDb()]);

  // Update overall health status based on service checks
  healthStatus.status =
    healthStatus.services.database.connected &&
    healthStatus.services.redis.connected &&
    healthStatus.services.questdb.connected
      ? "ok"
      : "degraded";

  console.log("[/health] All service checks completed.");

  const overallStatus =
    healthStatus.status === "ok"
      ? 200
      : healthStatus.status === "degraded"
        ? 503
        : 500; // Should not reach 500 if logic is correct, but as a fallback
  if (overallStatus === 503) {
    healthStatus.status = "error";
  }

  console.log(
    "[/health] Final health status object:",
    JSON.stringify(healthStatus)
  );
  console.log(`[/health] Responding with status: ${overallStatus}`);
  return c.json(healthStatus, overallStatus);
});
console.log("[APP] Health check route mounted");

// Standalone S3 Health Check Endpoint
app.get("/health-s3", async (c) => {
  try {
    const testKey = "health_check_test.txt";
    const testContent = Buffer.from("Health check test");

    // First check if the file exists and delete it if it does
    console.log("Checking if test file exists in S3");
    const exists = await fileExists(testKey);
    if (exists) {
      console.log("Test file exists, deleting it");
      await deleteFile(testKey);
      console.log("Successfully deleted existing test file");
    } else {
      console.log("Test file does not exist, proceeding with health check");
    }

    // Test upload
    console.log("Uploading file to S3");
    await uploadFile(testKey, testContent, "text/plain");
    console.log("Successfully uploaded file");

    // Test presigned URL generation
    console.log("Generating presigned URL");
    const url = await generatePresignedUrl(testKey, 60);
    console.log("Generated presigned URL");

    // Test URL parsing
    const parsed = extractBucketAndKeyFromUrl(url);
    if (!parsed || parsed.key !== testKey) {
      throw new Error("Failed to validate S3 URL structure");
    }

    return c.json({ connected: true, error: null });
  } catch (error) {
    console.error("S3 connection failed", error);
    return c.json(
      {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      },
      503
    );
  }
});
console.log("[APP] S3 health check route mounted");

app.get("/db-health", async (c) => {
  try {
    // Run a simple count query on the merchants table to check
    // if db operations are working correctly
    const result = await db.select({ count: count() }).from(merchants);

    // Return success response with count
    return c.json(
      {
        status: "healthy",
        message: "Database connection is working correctly",
        count: result[0].count,
      },
      200
    );
  } catch (error) {
    console.error("Database health check failed:", error);
    return c.json(
      {
        status: "unhealthy",
        message: "Database connection failed",
        error: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});
console.log("[APP] DB health check route mounted");

// Mount API routes
app.route("/v1", appRoutes);

// --- New Detailed QuestDB Health Check Endpoint ---
app.get("/questdb-health", async (c) => {
  const result = {
    connected: false,
    http_health: false,
    db_operations: false,
    error: null as string | null,
  };
  const HEALTH_CHECK_TABLE_NAME = "_health_check_table";

  try {
    // Check 1: HTTP health endpoint
    const healthUrl = `http://${env.QUESTDB_HOST}:9003/`;

    // Add HTTP basic authentication for health endpoint
    const authString = `${env.QUESTDB_USER}:${questDbService.getIlpPassword()}`;
    const encodedAuth = Buffer.from(authString).toString("base64");

    const healthResponse = await fetch(healthUrl, {
      headers: {
        Authorization: `Basic ${encodedAuth}`,
      },
    });

    result.http_health = healthResponse.ok;
    if (!result.http_health) {
      throw new Error("QuestDB HTTP health endpoint (/health) failed");
    }

    // Check 2: Create/Write/Read/Verify using fixed table name
    const createTableQuery = encodeURIComponent(`
      CREATE TABLE IF NOT EXISTS ${HEALTH_CHECK_TABLE_NAME} (
        ts TIMESTAMP,
        value STRING
      ) timestamp(ts) PARTITION BY DAY WAL;
    `);
    const createResponse = await fetch(
      `http://${env.QUESTDB_HOST}:${env.QUESTDB_INGEST_PORT}/exec?query=${createTableQuery}`,
      {
        headers: {
          Authorization: `Basic ${encodedAuth}`,
        },
      }
    );

    if (!createResponse.ok) {
      throw new Error(
        `Failed to create table ${HEALTH_CHECK_TABLE_NAME} via REST API`
      );
    }

    const ilpConfig = `http::addr=${env.QUESTDB_HOST}:${env.QUESTDB_INGEST_PORT};username=${env.QUESTDB_USER};password=${questDbService.getIlpPassword()};`;
    const sender = Sender.fromConfig(ilpConfig);
    try {
      const testValue = `test_${Date.now()}`;
      sender.table(HEALTH_CHECK_TABLE_NAME);
      sender.stringColumn("value", testValue);
      sender.atNow();
      await sender.flush();

      const pgPool = (questDbService as any).pgPool;
      if (!pgPool) {
        throw new Error("QuestDB PG pool not initialized in service");
      }
      const client = await pgPool.connect();
      try {
        const readResult = await client.query(
          `SELECT value FROM ${HEALTH_CHECK_TABLE_NAME} WHERE value = $1`,
          [testValue]
        );
        if (!readResult.rows || readResult.rows.length === 0) {
          throw new Error(
            `Failed to read test value from ${HEALTH_CHECK_TABLE_NAME} table`
          );
        }
        result.db_operations = true;
        // Consider connection successful only if both checks pass
        result.connected = result.http_health && result.db_operations;
      } finally {
        client.release();
      }
    } finally {
      await sender.close();
    }
  } catch (error) {
    console.error("Detailed QuestDB health check failed", error);
    result.error = error instanceof Error ? error.message : String(error);
    result.connected = false; // Explicitly set connected to false on error
    result.db_operations = false;
  }

  return c.json(result, result.connected ? 200 : 503);
});
console.log("[APP] QuestDB health check route mounted");
// --- End Detailed QuestDB Health Check Endpoint ---

// Root route
app.get("/", (c) => {
  return c.json({ message: "Welcome to Lumen API" });
});

// Export the configured Hono app instance
console.log("[APP] Exporting Hono app instance");
export { app };
