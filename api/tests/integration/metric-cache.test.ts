import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  createFullTestEnvironment,
  createTestMetric,
  createAuthenticatedClient,
  deleteTestMetric,
} from "../test-helpers";
import { db } from "../../src/db/client";
import { metrics } from "@lumen/common/schema";
import { and, eq } from "drizzle-orm";
import {
  getRedisClient,
  RedisClientType,
  withRedisReconnect,
} from "../../src/lib/redis";
import { bootstrapMetricDefinitions } from "../../src/lib/metricDefinitions";
import { forceReconciliation } from "../../src/lib/cacheSynchronizer";
import { ClientType } from "../test-helpers/api/client";
import { AggregationType, ValueType } from "@lumen/common/schema";

describe("Metric Cache Synchronizer & Redis Handling", () => {
  let client: ClientType;
  let testMerchantId: string;
  let redis: RedisClientType;
  let testMetrics: Array<{ id: string; eventName: string }> = [];

  // Helper type for the Redis metric definition hash
  type RedisMetricDef = {
    id?: string;
    merchantId?: string;
    name?: string;
    description?: string;
    queryType?: "simple" | "indexed" | "complex";
    aggregationType?: AggregationType | null;
    eventName?: string | null;
    valueType?: ValueType; // Changed to ValueType from common/schema
    sqlDefinition?: string | null;
    // NOTE: propertyName is intentionally omitted as per QuestDB migration
  };

  // Helper functions
  async function getRedisMetricDef(
    merchantId: string,
    metricId: string
  ): Promise<Record<string, string> | null> {
    // Use existing redis client if available and ready, otherwise get a fresh one
    const currentRedis =
      redis && redis.isReady ? redis : await getRedisClient();
    if (!currentRedis) throw new Error("Failed to get Redis client");
    return await currentRedis.hGetAll(`metric_def:${merchantId}:${metricId}`);
  }

  async function clearRedisMetricsCache() {
    try {
      const currentRedis =
        redis && redis.isReady ? redis : await getRedisClient();
      if (!currentRedis) throw new Error("Failed to get Redis client");
      // Flush only the test database (database #0 in Redis is default)
      await currentRedis.flushDb();
      // Verify flush was successful
      const keys = await currentRedis.keys("*");
      if (keys.length > 0) {
        console.warn(
          `Redis flush did not clear all keys. Remaining: ${keys.length}`
        );
      }
    } catch (error: any) {
      console.error("Error clearing Redis cache:", error);
    }
  }

  // Mock a Redis disconnect
  async function simulateRedisDisconnect() {
    try {
      await redis.disconnect();
      return true;
    } catch (error) {
      console.error("Error disconnecting Redis:", error);
      return false;
    }
  }

  // Wrap the imported createTestMetric to record cleanup entries
  async function makeTestMetric(
    config: {
      name?: string;
      description?: string;
      aggregationType?: AggregationType;
      eventName?: string;
      valueType?: ValueType; // Added valueType, removed propertyName
      filterCriteria?: Record<string, any>; // Keeping for potential future use?
    } = {}
  ) {
    const defaultConfig = {
      merchantId: testMerchantId,
      name: `Test Metric ${Date.now()}`,
      eventName: `test.event.${Date.now()}`,
      aggregationType: "COUNT" as AggregationType, // Ensure type safety
      valueType: "NUMERIC" as ValueType, // Default valueType
      ...config,
    };

    // Ensure COUNT has valueType NUMERIC, UNIQUE_COUNT has STRING
    if (defaultConfig.aggregationType === "COUNT") {
      defaultConfig.valueType = "NUMERIC";
    } else if (defaultConfig.aggregationType === "UNIQUE_COUNT") {
      defaultConfig.valueType = "STRING";
    }

    // IMPORTANT: propertyName is intentionally NOT passed to createTestMetric
    const metric = await createTestMetric({
      merchantId: defaultConfig.merchantId,
      name: defaultConfig.name,
      eventName: defaultConfig.eventName,
      aggregationType: defaultConfig.aggregationType,
      valueType: defaultConfig.valueType, // Pass valueType
      // description: defaultConfig.description, // Add if createTestMetric supports it
      // filterCriteria: defaultConfig.filterCriteria // Add if createTestMetric supports it
    });

    testMetrics.push({
      id: metric.id,
      eventName: metric.eventName || defaultConfig.eventName,
    });

    return metric;
  }

  beforeAll(async () => {
    // Create test environment with merchant
    const { user, merchant } = await createFullTestEnvironment();
    testMerchantId = merchant.id;

    // Create an authenticated client
    client = await createAuthenticatedClient(user.email, user.password);

    // Connect to Redis
    redis = await getRedisClient();
    if (!redis) {
      throw new Error("Redis client not available for tests");
    }

    // Clear Redis at the beginning
    await clearRedisMetricsCache();
  });

  afterAll(async () => {
    // Clean up created metrics
    for (const metric of testMetrics) {
      try {
        await deleteTestMetric(metric.id, testMerchantId, metric.eventName);
      } catch (error: any) {
        console.warn(`Failed to delete metric ${metric.id}: ${error.message}`);
      }
    }

    // Final Redis cleanup
    await clearRedisMetricsCache();

    // Ensure Redis is connected for cleanup, then disconnect
    if (!redis.isReady) {
      redis = await getRedisClient();
    }
    if (redis && redis.isReady) {
      await redis.disconnect();
    }
  });

  beforeEach(async () => {
    // Clear Redis between tests
    await clearRedisMetricsCache();

    // Ensure Redis is connected
    if (!redis.isReady) {
      redis = await getRedisClient();
    }
  });

  // --- Tests from metric-cache-synchronizer.test.ts ---
  describe("Cache Synchronization Logic", () => {
    it("should successfully bootstrap definitions from Postgres to Redis", async () => {
      // Create a test metric (will insert into PG)
      const metric = await makeTestMetric({
        name: "Bootstrap Test",
        eventName: "bootstrap.test",
        aggregationType: "SUM", // requires NUMERIC valueType (default)
      });

      // Clear Redis again to simulate empty cache before bootstrapping
      await clearRedisMetricsCache();
      const cachedBefore = await getRedisMetricDef(testMerchantId, metric.id);
      expect(Object.keys(cachedBefore || {}).length).toBe(0); // Verify empty

      // Run bootstrap
      await bootstrapMetricDefinitions();

      // Verify Redis now has the metric with correct fields
      const cachedAfter = await getRedisMetricDef(testMerchantId, metric.id);
      expect(cachedAfter).not.toBeNull();
      const cachedMetric = cachedAfter as RedisMetricDef;
      expect(cachedMetric?.name).toBe(metric.name);
      expect(cachedMetric?.eventName ?? null).toBe(metric.eventName ?? null);
      expect(cachedMetric?.aggregationType ?? null).toBe(
        metric.aggregationType ?? null
      );
      expect(cachedMetric?.valueType).toBe("NUMERIC"); // Check valueType
      expect(cachedMetric).not.toHaveProperty("propertyName"); // Assert absence of propertyName
    });

    it("should detect and fix missing metric definitions in Redis via reconciliation", async () => {
      // Create a test metric
      const metric = await makeTestMetric({
        name: "Missing Metric Test",
        eventName: "missing.metric.test",
        aggregationType: "COUNT", // requires NUMERIC valueType (default)
      });

      // Bootstrap Redis cache initially
      await bootstrapMetricDefinitions();
      const cachedBefore = await getRedisMetricDef(testMerchantId, metric.id);
      expect(cachedBefore).not.toBeNull();
      expect(cachedBefore?.name).toBe(metric.name);

      // Delete just this metric from Redis
      await redis.del(`metric_def:${testMerchantId}:${metric.id}`);
      const cachedAfterDelete = await getRedisMetricDef(
        testMerchantId,
        metric.id
      );
      expect(Object.keys(cachedAfterDelete || {}).length).toBe(0); // Verify gone

      // Run reconciliation to fix
      await forceReconciliation();

      // Verify Redis has the metric again with correct fields
      const cachedAfterFix = await getRedisMetricDef(testMerchantId, metric.id);
      expect(cachedAfterFix).not.toBeNull();
      const cachedMetric = cachedAfterFix as RedisMetricDef;
      expect(cachedMetric?.name).toBe(metric.name);
      expect(cachedMetric?.aggregationType).toBe("COUNT");
      expect(cachedMetric?.valueType).toBe("NUMERIC");
      expect(cachedMetric).not.toHaveProperty("propertyName");
    });

    it("should handle both missing defs and extraneous defs in Redis via reconciliation", async () => {
      // 1. Create two metrics in PG
      const metricToKeep = await makeTestMetric({
        name: "Metric To Keep",
        eventName: "keep.test.event",
        aggregationType: "MAX", // NUMERIC
      });
      const metricToDeleteFromPg = await makeTestMetric({
        name: "Metric To Delete From PG",
        eventName: "delete.pg.event",
        aggregationType: "MIN", // NUMERIC
      });

      // 2. Bootstrap cache - both metrics should be in Redis
      await bootstrapMetricDefinitions();
      expect(
        await getRedisMetricDef(testMerchantId, metricToKeep.id)
      ).not.toBeNull();
      expect(
        await getRedisMetricDef(testMerchantId, metricToDeleteFromPg.id)
      ).not.toBeNull();

      // 3. Create an *extraneous* metric definition directly in Redis
      const extraneousMetricId = "metric-extraneous-123";
      await redis.hSet(`metric_def:${testMerchantId}:${extraneousMetricId}`, {
        id: extraneousMetricId,
        merchantId: testMerchantId,
        name: "Extraneous Metric",
        queryType: "simple",
        aggregationType: "COUNT",
        valueType: "NUMERIC",
      });

      // 4. Delete one metric *from Postgres*
      await db
        .delete(metrics)
        .where(
          and(
            eq(metrics.id, metricToDeleteFromPg.id),
            eq(metrics.merchantId, testMerchantId)
          )
        );
      // Remove from cleanup list as it's deleted from DB
      testMetrics = testMetrics.filter((m) => m.id !== metricToDeleteFromPg.id);

      // 5. Delete the *other* metric's definition *from Redis* (but keep PG entry)
      await redis.del(`metric_def:${testMerchantId}:${metricToKeep.id}`);

      // State before reconciliation:
      // - metricToKeep: Exists in PG, Missing Def in Redis
      // - metricToDeleteFromPg: Missing in PG, Exists Def in Redis
      // - extraneousMetric: Missing in PG, Exists Def in Redis

      // 6. Run reconciliation
      await forceReconciliation();

      // 7. Verify final state in Redis
      // - metricToKeep: Definition should be restored
      const fixedKeepDef = await getRedisMetricDef(
        testMerchantId,
        metricToKeep.id
      );
      expect(fixedKeepDef).not.toBeNull();
      expect(fixedKeepDef?.name).toBe(metricToKeep.name);

      // - metricToDeleteFromPg: Definition should be removed
      expect(
        Object.keys(
          (await getRedisMetricDef(testMerchantId, metricToDeleteFromPg.id)) ||
            {}
        ).length
      ).toBe(0);

      // - extraneousMetric: Definition should be removed
      expect(
        Object.keys(
          (await getRedisMetricDef(testMerchantId, extraneousMetricId)) || {}
        ).length
      ).toBe(0);
    });
  });

  // --- Tests from metric-cache-synchronizer-enhancements.test.ts ---
  describe("Reconciliation under Various Discrepancy Scenarios", () => {
    it("should handle metric deletions when definition is removed from Postgres", async () => {
      // Create test metrics
      const metricToDelete = await makeTestMetric({
        name: "Metric To Delete",
        eventName: "delete.test.event",
        aggregationType: "COUNT",
      });
      const metricToKeep = await makeTestMetric({
        name: "Metric To Keep",
        eventName: "keep.test.event",
        aggregationType: "SUM",
      });

      // Bootstrap the cache
      await bootstrapMetricDefinitions();

      // Verify both metrics are in Redis initially
      const deleteCachedBefore = await getRedisMetricDef(
        testMerchantId,
        metricToDelete.id
      );
      const keepCachedBefore = await getRedisMetricDef(
        testMerchantId,
        metricToKeep.id
      );
      expect(deleteCachedBefore).not.toBeNull();
      expect(keepCachedBefore).not.toBeNull();

      // Delete one metric from the database (Postgres)
      await db
        .delete(metrics)
        .where(
          and(
            eq(metrics.id, metricToDelete.id),
            eq(metrics.merchantId, testMerchantId)
          )
        );

      // Run reconciliation
      await forceReconciliation();

      // Verify the deleted metric is now gone from Redis (both def and mapping)
      const deleteCachedAfter = await getRedisMetricDef(
        testMerchantId,
        metricToDelete.id
      );
      const keepCachedAfter = await getRedisMetricDef(
        testMerchantId,
        metricToKeep.id
      );

      expect(Object.keys(deleteCachedAfter || {}).length).toBe(0); // Def gone
      expect(keepCachedAfter).not.toBeNull(); // Other def remains
    });

    it("should handle partially corrupted Redis definition entries and fix them", async () => {
      // Create a test metric
      const metric = await makeTestMetric({
        name: "Corrupt Test",
        eventName: "corrupt.test.event",
        aggregationType: "UNIQUE_COUNT",
        valueType: "STRING",
      });

      // Bootstrap the cache
      await bootstrapMetricDefinitions();

      // Corrupt the Redis entry by setting only some fields (manually)
      const defKey = `metric_def:${testMerchantId}:${metric.id}`;
      await redis.del(defKey); // Delete original hash first
      await redis.hSet(defKey, {
        name: metric.name,
        // Intentionally missing other fields like aggregationType, eventName, valueType
      });

      // Run reconciliation
      await forceReconciliation();

      // Validate the corrected Redis cache entry
      const fixedDef = await redis.hGetAll(defKey);
      const fixedMetric = fixedDef as RedisMetricDef;

      expect(fixedMetric?.name).toBe(metric.name);
      expect(fixedMetric?.aggregationType ?? null).toBe("UNIQUE_COUNT");
      expect(fixedMetric?.eventName ?? null).toBe(metric.eventName ?? null);
      expect(fixedMetric?.valueType ?? null).toBe("STRING");
      expect(fixedMetric).not.toHaveProperty("propertyName"); // Verify absence
    });

    it("should be idempotent: running reconciliation multiple times causes no adverse effects", async () => {
      // Create a test metric
      const metric = await makeTestMetric({
        name: "Idempotency Test",
        eventName: "idem.test.event",
        aggregationType: "MAX",
      });

      // Initial bootstrap
      await bootstrapMetricDefinitions();
      const defKey = `metric_def:${testMerchantId}:${metric.id}`;
      const eventKey = `metrics_for_event:${testMerchantId}:${metric.eventName}`;

      // Get initial state
      const initialStateDef = await redis.hGetAll(defKey);
      const initialStateEvent = await redis.sMembers(eventKey);

      // Run reconciliation first time
      await forceReconciliation();
      const stateAfterRun1Def = await redis.hGetAll(defKey);
      const stateAfterRun1Event = await redis.sMembers(eventKey);
      expect(stateAfterRun1Def).toEqual(initialStateDef);
      expect(stateAfterRun1Event).toEqual(initialStateEvent);

      // Run reconciliation second time
      await forceReconciliation();
      const stateAfterRun2Def = await redis.hGetAll(defKey);
      const stateAfterRun2Event = await redis.sMembers(eventKey);
      expect(stateAfterRun2Def).toEqual(initialStateDef); // Still matches initial
      expect(stateAfterRun2Event).toEqual(initialStateEvent); // Still matches initial

      // Run reconciliation third time
      await forceReconciliation();
      const stateAfterRun3Def = await redis.hGetAll(defKey);
      const stateAfterRun3Event = await redis.sMembers(eventKey);
      expect(stateAfterRun3Def).toEqual(initialStateDef); // Still matches initial
      expect(stateAfterRun3Event).toEqual(initialStateEvent); // Still matches initial
    });
  });

  // --- Tests from metric-cache-synchronizer-reconnect.test.ts ---
  describe("Redis Disconnect/Reconnect Handling", () => {
    // Need afterEach for this specific describe block to ensure clean Redis state after simulated disconnects
    afterEach(async () => {
      if (redis && !redis.isReady) {
        try {
          redis = await getRedisClient(); // Attempt to get a fresh client
        } catch (e) {
          console.error("Failed to reconnect Redis in afterEach", e);
        }
      }
    });

    it("should successfully use withRedisReconnect helper to handle disconnections", async () => {
      // Create test data
      const metric = await makeTestMetric({
        name: "Reconnect Helper Test",
        eventName: "reconnect.helper.test",
        aggregationType: "COUNT",
      });

      // Bootstrap Redis with the data
      await bootstrapMetricDefinitions();

      // Disconnect Redis
      await simulateRedisDisconnect();
      // Check that the shared client might be disconnected (best effort check)
      try {
        await redis.ping(); // This should fail or hang if disconnected
      } catch (e) {
        expect(redis.isReady).toBe(false); // Or check isReady flag
      }

      // Use the withRedisReconnect helper
      let cachedData: Record<string, string> | null = null;
      await withRedisReconnect(async (redisClient) => {
        // Inside the helper, redisClient should be a connected client
        expect(redisClient.isReady).toBe(true);
        cachedData = await redisClient.hGetAll(
          `metric_def:${testMerchantId}:${metric.id}`
        );
      });

      // Verify data was retrieved (should get a fresh client internally)
      expect(cachedData).not.toBeNull();
      expect(cachedData!["name"]).toBe(metric.name);
      expect(cachedData!["aggregationType"]).toBe("COUNT");
      expect(cachedData).not.toHaveProperty("propertyName");
    });

    it("should handle Redis disconnection during bootstrapMetricDefinitions", async () => {
      // Create test metrics
      const metric = await makeTestMetric({
        name: "Bootstrap Reconnect Test",
        eventName: "bootstrap.reconnect.test",
        aggregationType: "SUM",
      });

      // Disconnect Redis *before* bootstrapping
      await simulateRedisDisconnect();
      try {
        await redis.ping();
      } catch (e) {
        expect(redis.isReady).toBe(false);
      }

      // Run bootstrap, which should handle reconnect internally via its own withRedisReconnect usage
      await bootstrapMetricDefinitions();

      // Verify the data was properly bootstrapped using a fresh client check after the fact
      const cachedMetric = await getRedisMetricDef(testMerchantId, metric.id);
      expect(cachedMetric).not.toBeNull();
      expect(cachedMetric!["name"]).toBe(metric.name);
      expect(cachedMetric!["aggregationType"]).toBe("SUM");
    });

    it("should handle Redis disconnection during cache reconciliation", async () => {
      // Create metrics to reconcile
      const metric = await makeTestMetric({
        name: "Reconcile Disconnect Test",
        eventName: "reconcile.disconnect.test",
        aggregationType: "UNIQUE_COUNT",
        valueType: "STRING",
      });

      // Bootstrap data to Redis
      await bootstrapMetricDefinitions();

      // Ensure connected before corruption
      if (!redis.isReady) redis = await getRedisClient();

      // Verify metric exists in Redis
      const defKey = `metric_def:${testMerchantId}:${metric.id}`;
      const beforeMetric = await getRedisMetricDef(testMerchantId, metric.id);
      expect(beforeMetric).not.toBeNull();

      // Corrupt data by partially deleting a field
      await redis.hDel(defKey, "valueType");
      const corruptedMetric = await getRedisMetricDef(
        testMerchantId,
        metric.id
      );
      expect(corruptedMetric?.valueType).toBeUndefined();

      // Disconnect Redis
      await simulateRedisDisconnect();
      try {
        await redis.ping();
      } catch (e) {
        expect(redis.isReady).toBe(false);
      }

      // Run reconciliation, which should handle reconnect internally via withRedisReconnect
      await forceReconciliation();

      // Verify the data was fixed using a fresh check
      const afterMetric = await getRedisMetricDef(testMerchantId, metric.id);
      expect(afterMetric).not.toBeNull();
      expect(afterMetric?.name).toBe(metric.name);
      expect(afterMetric?.aggregationType ?? null).toBe("UNIQUE_COUNT");
      expect(afterMetric?.valueType ?? null).toBe("STRING"); // Verify the fixed field
    });
  });
});
