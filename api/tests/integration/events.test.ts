import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  createFullTestEnvironment,
  createTestMetric,
  createAuthenticatedClient,
  deleteTestMetric,
  createTestCustomer,
  ClientType,
  queryQuestDbDirectly,
  clearEventData,
} from "../test-helpers";
import { getRedisClient } from "../../src/lib/redis";
import { createId } from "@lumen/common";
import questDbService from "../../src/db/questDbService";
import { env } from "../../src/env";
import { EventInput } from "@lumen/common/validators";
import { z } from "zod";
import { db } from "../../src/db/client";
import { events as eventsSchema } from "@lumen/common/schema";
import { eq, and } from "drizzle-orm";
import { eventPersistenceQueue } from "../../src/lib/queues";
import { logger } from "../../src/helpers/logging"; // Import the logger
import { nanoid } from "nanoid";

// Define schema for the expected metric value response (keep for structure validation)
const metricValueResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  customerId: z.string(),
  value: z.number(),
  queryType: z.string(),
  timeframe: z.object({ type: z.string() }).optional(),
});

// Simple interface for metric objects returned by helpers
interface TestMetric {
  id: string;
  eventName?: string | null;
  [key: string]: any;
}

// Define placeholder PostgreSQL query helper type if not imported
declare function queryPostgresDbDirectly(
  query: string
): Promise<{ rowCount: number; rows: any[] }>;

// Helper function for consistency with route
function buildRedisIdempotencyKey(merchantId: string, key: string): string {
  return `idem:${merchantId}:${key}`;
}

// --- Test Setup ---

describe("Events and Metrics Integration (Post-QuestDB)", () => {
  let client: ClientType;
  let testMerchantId: string;
  let testCustomerId: string;
  let cleanupMetricIds: { id: string; eventName?: string | null }[] = [];
  let countMetric: TestMetric,
    sumMetric: TestMetric,
    uniqueCountMetric: TestMetric,
    maxMetric: TestMetric,
    minMetric: TestMetric;

  beforeAll(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    testMerchantId = merchant.id;
    try {
      const {
        QUESTDB_HOST,
        QUESTDB_INGEST_PORT,
        QUESTDB_QUERY_PORT,
        QUESTDB_USER,
        QUESTDB_PASSWORD,
      } = env;
      await questDbService.initialize(
        QUESTDB_HOST,
        QUESTDB_INGEST_PORT,
        QUESTDB_QUERY_PORT,
        QUESTDB_USER,
        QUESTDB_PASSWORD!
      );
    } catch (error) {
      console.error("Failed to initialize QuestDB for events.test.ts:", error);
      throw error;
    }

    client = await createAuthenticatedClient(user.email, user.password);
    const customer = await createTestCustomer({
      merchantId: testMerchantId,
      name: "Events API Test Customer",
      email: `events_api_test_${Date.now()}@example.com`,
    });
    testCustomerId = customer.id;

    await clearEventData();
    const redis = await getRedisClient();
    const keys = await redis.keys(`*:${testMerchantId}:*`);
    if (keys.length > 0) await redis.del(keys);
  });

  afterAll(async () => {
    // --- Cleanup Metrics ---
    for (const { id, eventName } of cleanupMetricIds) {
      try {
        await deleteTestMetric(id, testMerchantId, eventName || "");
      } catch (error) {
        logger.warn(
          `Warn: Failed to cleanup metric ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    await clearEventData();

    console.log("Closing QuestDB service for events.test.ts...");
    try {
      await questDbService.close();
      console.log("QuestDB service closed successfully for events.test.ts.");
    } catch (error) {
      logger.error(
        "Failed to close QuestDB:",
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  describe("Event Ingestion API", () => {
    beforeEach(async () => {
      const redis = await getRedisClient();
      const singleKey = buildRedisIdempotencyKey(
        testMerchantId,
        "single-test-key"
      );
      const batchKeys = ["A", "B", "C"].map((k) =>
        buildRedisIdempotencyKey(testMerchantId, `batch-test-key-${k}`)
      );
      const dedupKey = buildRedisIdempotencyKey(
        testMerchantId,
        "dedup-test-key"
      );
      const keysToDelete = [singleKey, ...batchKeys, dedupKey].filter(Boolean);
      if (keysToDelete.length > 0) {
        await redis.del(keysToDelete);
      }

      try {
        await eventPersistenceQueue.clean(1000, 0, "wait");
        await eventPersistenceQueue.clean(1000, 0, "active");
        await eventPersistenceQueue.clean(1000, 0, "completed");
        await eventPersistenceQueue.clean(1000, 0, "failed");
        await eventPersistenceQueue.clean(1000, 0, "delayed");
        const counts = await eventPersistenceQueue.getJobCounts();
        logger.debug(`Queue cleaned. Counts: ${JSON.stringify(counts)}`);
      } catch (err) {
        logger.error("Error cleaning queue:", err);
      }
    });

    it("POST /events should accept a single valid event and persist to QuestDB and PostgreSQL", async () => {
      const idempotencyKey = `single-test-key`;
      const eventName = "test.single.event";
      const timestamp = new Date();
      const eventPayload: EventInput = {
        eventName: eventName,
        customerId: testCustomerId,
        idempotencyKey: idempotencyKey,
        eventTimestamp: timestamp,
        eventValue: 123.45,
        properties: { source: "test" },
      };

      const apiPayload = {
        ...eventPayload,
        eventTimestamp: timestamp.toISOString(),
      };

      const response = await client.events.$post({ json: apiPayload });
      expect(response.status).toBe(202);
      const body = await response.json();
      if ("error" in body) throw new Error(`API error: ${body.error}`);
      expect(body.message).toBe("Event accepted");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const questResult = await queryQuestDbDirectly(
        `SELECT * FROM events WHERE merchant_id = '${testMerchantId}' AND idempotency_key = '${idempotencyKey}' LIMIT 1;`
      );
      expect(questResult.rowCount).toBe(1);
      // Extract values from the row
      const row = questResult.rows[0];

      // Based on the implementation of queryQuestDbDirectly, it returns an array of values
      // Verify merchant_id
      expect(Object.values(row).some((val) => val === testMerchantId)).toBe(
        true
      );

      // Verify idempotency_key
      expect(Object.values(row).some((val) => val === idempotencyKey)).toBe(
        true
      );

      // Verify event_name
      expect(Object.values(row).some((val) => val === eventName)).toBe(true);

      // Verify customer_id
      expect(Object.values(row).some((val) => val === testCustomerId)).toBe(
        true
      );

      // Verify event_value (number)
      expect(Object.values(row).some((val) => val === 123.45)).toBe(true);

      // Verify properties - look for a string that can be parsed into the expected object
      const propertiesFound = Object.values(row).some((val) => {
        if (typeof val === "string") {
          try {
            const parsed = JSON.parse(val);
            return (
              JSON.stringify(parsed) === JSON.stringify(eventPayload.properties)
            );
          } catch {
            return false;
          }
        } else if (typeof val === "object" && val !== null) {
          return (
            JSON.stringify(val) === JSON.stringify(eventPayload.properties)
          );
        }
        return false;
      });

      expect(propertiesFound).toBe(true);

      const POSTGRES_QUEUE_DELAY = 2000;
      await new Promise((resolve) => setTimeout(resolve, POSTGRES_QUEUE_DELAY));
      const pgResult = await db.query.events.findFirst({
        where: and(
          eq(eventsSchema.merchantId, testMerchantId),
          eq(eventsSchema.idempotencyKey, idempotencyKey)
        ),
      });

      expect(pgResult).toBeDefined();
      expect(pgResult?.merchantId).toBe(testMerchantId);
      expect(pgResult?.customerId).toBe(testCustomerId);
      expect(pgResult?.eventName).toBe(eventName);
      expect(pgResult?.eventValue).toBe(123.45);
      expect(pgResult?.properties).toEqual({ source: "test" });
      expect(pgResult?.eventTimestamp?.toISOString()).toBe(
        timestamp.toISOString()
      );
    });

    it("POST /events should accept a single valid event without idempotencyKey and eventTimestamp and persist to QuestDB and PostgreSQL", async () => {
      const eventName = "test.single.event";
      const timestamp = new Date();
      const eventValue = Date.now();
      const eventPayload: EventInput = {
        eventName: eventName,
        customerId: testCustomerId,
        eventValue,
        properties: { source: "test" },
      };

      const apiPayload = {
        ...eventPayload,
        eventTimestamp: timestamp.toISOString(),
      };

      const response = await client.events.$post({ json: apiPayload });
      expect(response.status).toBe(202);
      const body = await response.json();
      if ("error" in body) throw new Error(`API error: ${body.error}`);
      expect(body.message).toBe("Event accepted");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const questResult = await queryQuestDbDirectly(
        `SELECT * FROM events WHERE merchant_id = '${testMerchantId}' AND event_value = ${eventValue} LIMIT 1;`
      );
      expect(questResult.rowCount).toBe(1);
      // Extract values from the row
      const row = questResult.rows[0];

      // Based on the implementation of queryQuestDbDirectly, it returns an array of values
      // Verify merchant_id
      expect(Object.values(row).some((val) => val === testMerchantId)).toBe(
        true
      );

      // Verify event_name
      expect(Object.values(row).some((val) => val === eventName)).toBe(true);

      // Verify customer_id
      expect(Object.values(row).some((val) => val === testCustomerId)).toBe(
        true
      );

      // Verify event_value (number)
      expect(Object.values(row).some((val) => val === eventValue)).toBe(true);

      // Verify properties - look for a string that can be parsed into the expected object
      const propertiesFound = Object.values(row).some((val) => {
        if (typeof val === "string") {
          try {
            const parsed = JSON.parse(val);
            return (
              JSON.stringify(parsed) === JSON.stringify(eventPayload.properties)
            );
          } catch {
            return false;
          }
        } else if (typeof val === "object" && val !== null) {
          return (
            JSON.stringify(val) === JSON.stringify(eventPayload.properties)
          );
        }
        return false;
      });

      expect(propertiesFound).toBe(true);

      const POSTGRES_QUEUE_DELAY = 2000;
      await new Promise((resolve) => setTimeout(resolve, POSTGRES_QUEUE_DELAY));
      const pgResult = await db.query.events.findFirst({
        where: and(
          eq(eventsSchema.merchantId, testMerchantId),
          eq(eventsSchema.eventValue, eventValue)
        ),
      });

      expect(pgResult).toBeDefined();
      expect(pgResult?.merchantId).toBe(testMerchantId);
      expect(pgResult?.customerId).toBe(testCustomerId);
      expect(pgResult?.eventName).toBe(eventName);
      expect(pgResult?.eventValue).toBe(eventValue);
      expect(pgResult?.properties).toEqual({ source: "test" });
      expect(pgResult?.eventTimestamp?.toISOString()).toBe(
        timestamp.toISOString()
      );
    });

    it("POST /events/batch should accept multiple valid events and persist to QuestDB and PostgreSQL", async () => {
      const batchSize = 3;
      const baseName = "test.batch.event";
      const eventsInput: EventInput[] = [];
      const idempotencyKeys: string[] = [];

      for (let i = 0; i < batchSize; i++) {
        const key = `batch-test-key-${String.fromCharCode(65 + i)}`; // A, B, C
        idempotencyKeys.push(key);
        eventsInput.push({
          eventName: `${baseName}.${i}`,
          customerId: testCustomerId,
          idempotencyKey: key,
          eventTimestamp: new Date(Date.now() + i * 100),
          eventValue: 10 * (i + 1),
          properties: { batchIndex: i },
        });
      }

      const apiPayload = {
        events: eventsInput.map((ev, i) => ({
          ...ev,
          eventTimestamp: ev.eventTimestamp!.toISOString(),
        })),
      };

      const response = await client.events.batch.$post({
        json: apiPayload,
      });
      expect(response.status).toBe(202);
      const bodyBatch = await response.json();
      if ("error" in bodyBatch)
        throw new Error(`API error: ${bodyBatch.error}`);
      expect(bodyBatch.message).toContain(`Processed ${batchSize} new events.`);

      // 1. Verify QuestDB (Primary Storage)
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let i = 0; i < batchSize; i++) {
        const questResult = await queryQuestDbDirectly(
          `SELECT event_value FROM events WHERE merchant_id = '${testMerchantId}' AND idempotency_key = '${idempotencyKeys[i]}' LIMIT 1;`
        );
        expect(questResult.rowCount).toBe(1);

        const expectedValue = 10 * (i + 1);
        const row = questResult.rows[0];

        const valueFound = Object.values(row).some(
          (val) =>
            val === expectedValue ||
            (typeof val === "string" && Number(val) === expectedValue)
        );

        expect(valueFound).toBe(true);
      }

      // 2. Verify PostgreSQL (Secondary Storage via Queue)
      const POSTGRES_BATCH_QUEUE_DELAY = 1000; // Allow more time for batch worker
      await new Promise((resolve) =>
        setTimeout(resolve, POSTGRES_BATCH_QUEUE_DELAY)
      );
      for (let i = 0; i < batchSize; i++) {
        const pgResult = await db.query.events.findFirst({
          where: and(
            eq(eventsSchema.merchantId, testMerchantId),
            eq(eventsSchema.idempotencyKey, idempotencyKeys[i])
          ),
        });
        expect(pgResult).toBeDefined();
        expect(pgResult?.eventValue).toBe(10 * (i + 1));
      }
    });

    it("POST /events/batch should accept multiple valid events without idempotencyKey and eventTimestamp and persist to QuestDB and PostgreSQL", async () => {
      const batchSize = 3;
      const eventsInput: EventInput[] = [];
      const eventNames: string[] = [];

      for (let i = 0; i < batchSize; i++) {
        const eventName = nanoid();
        eventNames.push(eventName);
        eventsInput.push({
          eventName,
          customerId: testCustomerId,
          eventValue: 10 * (i + 1),
          properties: { batchIndex: i },
        });
      }

      const apiPayload = {
        events: eventsInput.map((ev) => ({
          ...ev,
          eventTimestamp: undefined,
        })),
      };

      const response = await client.events.batch.$post({
        json: apiPayload,
      });
      expect(response.status).toBe(202);
      const bodyBatch = await response.json();
      if ("error" in bodyBatch)
        throw new Error(`API error: ${bodyBatch.error}`);
      expect(bodyBatch.message).toContain(`Processed ${batchSize} new events.`);

      // 1. Verify QuestDB (Primary Storage)
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let i = 0; i < batchSize; i++) {
        const questResult = await queryQuestDbDirectly(
          `SELECT event_value FROM events WHERE merchant_id = '${testMerchantId}' AND event_name = '${eventNames[i]}' LIMIT 1;`
        );
        expect(questResult.rowCount).toBe(1);

        const expectedValue = 10 * (i + 1);
        const row = questResult.rows[0];

        const valueFound = Object.values(row).some(
          (val) =>
            val === expectedValue ||
            (typeof val === "string" && Number(val) === expectedValue)
        );

        expect(valueFound).toBe(true);
      }

      // 2. Verify PostgreSQL (Secondary Storage via Queue)
      const POSTGRES_BATCH_QUEUE_DELAY = 1000; // Allow more time for batch worker
      await new Promise((resolve) =>
        setTimeout(resolve, POSTGRES_BATCH_QUEUE_DELAY)
      );
      for (let i = 0; i < batchSize; i++) {
        const pgResult = await db.query.events.findFirst({
          where: and(
            eq(eventsSchema.merchantId, testMerchantId),
            eq(eventsSchema.eventName, eventNames[i])
          ),
        });
        expect(pgResult).toBeDefined();
        expect(pgResult?.eventValue).toBe(10 * (i + 1));
      }
    });

    it("POST /events should skip duplicate using Redis idempotency check", async () => {
      const idempotencyKey = `dedup-test-key`;
      const redisKey = buildRedisIdempotencyKey(testMerchantId, idempotencyKey);
      const eventName = "test.dedup.event";
      const timestamp1 = new Date();
      const eventPayload1: EventInput = {
        eventName: eventName,
        customerId: testCustomerId,
        idempotencyKey: idempotencyKey,
        eventTimestamp: timestamp1,
        eventValue: 1,
      };
      const apiPayload1 = {
        ...eventPayload1,
        eventTimestamp: timestamp1.toISOString(),
      };

      const res1 = await client.events.$post({ json: apiPayload1 });
      expect(res1.status).toBe(202);
      const body1 = await res1.json();
      if ("error" in body1) throw new Error(`API error: ${body1.error}`);
      expect(body1.message).toBe("Event accepted");

      // Verify Redis key exists
      const redis = await getRedisClient(); // Get the client first
      const redisVal1 = await redis.get(redisKey); // Call get on the instance
      expect(redisVal1).toBe("1");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const questResult1 = await queryQuestDbDirectly(
        `SELECT event_value, event_timestamp FROM events WHERE merchant_id = '${testMerchantId}' AND idempotency_key = '${idempotencyKey}';`
      );
      expect(questResult1.rowCount).toBe(1);

      // Check event_value
      const row1 = questResult1.rows[0];
      const eventValueFound = Object.values(row1).some(
        (val) => val === 1 || (typeof val === "string" && Number(val) === 1)
      );
      expect(eventValueFound).toBe(true);

      // Check timestamp - find a value that can be converted to a date matching timestamp1
      const timestampFound = Object.values(row1).some((val) => {
        if (val instanceof Date) {
          return val.toISOString() === timestamp1.toISOString();
        }
        if (typeof val === "string") {
          try {
            return new Date(val).toISOString() === timestamp1.toISOString();
          } catch {
            return false;
          }
        }
        return false;
      });
      expect(timestampFound).toBe(true);

      const POSTGRES_QUEUE_DELAY = 2000;
      await new Promise((resolve) => setTimeout(resolve, POSTGRES_QUEUE_DELAY));
      const pgResult1 = await db.query.events.findFirst({
        where: and(
          eq(eventsSchema.merchantId, testMerchantId),
          eq(eventsSchema.idempotencyKey, idempotencyKey)
        ),
      });
      expect(pgResult1).toBeDefined();
      expect(pgResult1?.eventValue).toBe(1);
      expect(pgResult1?.eventTimestamp?.toISOString()).toBe(
        timestamp1.toISOString()
      );

      const timestamp2 = new Date();
      const eventPayload2 = {
        ...eventPayload1,
        eventTimestamp: timestamp2,
        eventValue: 2,
      };
      const apiPayload2 = {
        ...eventPayload2,
        eventTimestamp: timestamp2.toISOString(),
      };

      const res2 = await client.events.$post({ json: apiPayload2 });
      expect(res2.status).toBe(202);
      const body2 = await res2.json();
      if ("error" in body2) throw new Error(`API error: ${body2.error}`);
      expect(body2.message).toBe("Event accepted (duplicate handled)");

      const redisVal2 = await redis.get(redisKey);
      expect(redisVal2).toBe("1");

      const questResult2 = await queryQuestDbDirectly(
        `SELECT COUNT(*), event_value, event_timestamp FROM events WHERE merchant_id = '${testMerchantId}' AND idempotency_key = '${idempotencyKey}';`
      );

      // Find the COUNT(*) result - it should be 1
      const row2 = questResult2.rows[0];
      const countFound = Object.values(row2).some(
        (val) => val === 1 || (typeof val === "string" && Number(val) === 1)
      );
      expect(countFound).toBe(true);

      // Check event_value is still 1 (from the original event, not the duplicate's value of 2)
      const eventValueFound2 = Object.values(row2).some(
        (val) => val === 1 || (typeof val === "string" && Number(val) === 1)
      );
      expect(eventValueFound2).toBe(true);

      // Check timestamp is still from the original event
      const timestampFound2 = Object.values(row2).some((val) => {
        if (val instanceof Date) {
          return val.toISOString() === timestamp1.toISOString();
        }
        if (typeof val === "string") {
          try {
            return new Date(val).toISOString() === timestamp1.toISOString();
          } catch {
            return false;
          }
        }
        return false;
      });
      expect(timestampFound2).toBe(true);

      const pgResult2 = await db.query.events.findFirst({
        where: and(
          eq(eventsSchema.merchantId, testMerchantId),
          eq(eventsSchema.idempotencyKey, idempotencyKey)
        ),
      });
      expect(pgResult2).toBeDefined();
      expect(pgResult2?.eventValue).toBe(1);
      expect(pgResult2?.eventTimestamp?.toISOString()).toBe(
        timestamp1.toISOString()
      );
    });
  });

  describe("Metric Value Calculation from Events", () => {
    beforeAll(async () => {
      // Clear data once before creating metrics for the suite
      await clearEventData();

      const eventNameForMetrics = `test.metric.calc.${createId()}`;

      // After QuestDB migration:
      // - We no longer use propertyName field (it's been removed)
      // - Simple metrics automatically use event_value for NUMERIC types
      // - Simple metrics automatically use event_string for STRING types
      // - SET aggregation type has been renamed to UNIQUE_COUNT

      countMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Test Calc COUNT",
        eventName: eventNameForMetrics,
        aggregationType: "COUNT",
        queryType: "simple",
        valueType: "NUMERIC", // Required for all metric types after migration
      });
      cleanupMetricIds.push({
        id: countMetric.id,
        eventName: countMetric.eventName,
      });

      sumMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Test Calc SUM",
        eventName: eventNameForMetrics,
        aggregationType: "SUM",
        queryType: "simple",
        valueType: "NUMERIC", // Uses event_value column
      });
      cleanupMetricIds.push({
        id: sumMetric.id,
        eventName: sumMetric.eventName,
      });

      uniqueCountMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Test Calc UNIQUE_COUNT",
        eventName: eventNameForMetrics,
        aggregationType: "UNIQUE_COUNT", // Renamed from SET
        queryType: "simple",
        valueType: "STRING", // Uses event_string column
      });
      cleanupMetricIds.push({
        id: uniqueCountMetric.id,
        eventName: uniqueCountMetric.eventName,
      });

      maxMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Test Calc MAX",
        eventName: eventNameForMetrics,
        aggregationType: "MAX",
        queryType: "simple",
        valueType: "NUMERIC", // Uses event_value column
      });
      cleanupMetricIds.push({
        id: maxMetric.id,
        eventName: maxMetric.eventName,
      });

      minMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Test Calc MIN",
        eventName: eventNameForMetrics,
        aggregationType: "MIN",
        queryType: "simple",
        valueType: "NUMERIC", // Uses event_value column
      });
      cleanupMetricIds.push({
        id: minMetric.id,
        eventName: minMetric.eventName,
      });

      // Verify Redis cache after creation to ensure metric definitions are correctly cached
      // After QuestDB migration, Redis still serves as the fast lookup for metric definitions,
      // but no longer stores aggregated values (those come directly from QuestDB queries)
      const redis = await getRedisClient();
      const countDefKey = `metric_def:${testMerchantId}:${countMetric.id}`;
      const maxDefKey = `metric_def:${testMerchantId}:${maxMetric.id}`;
      const minDefKey = `metric_def:${testMerchantId}:${minMetric.id}`;

      // This key is still relevant - it maps events to metrics for fast lookup
      // when determining which metrics to calculate for an incoming event
      const eventIdxKey = `metrics_for_event:${testMerchantId}:${eventNameForMetrics}`;

      const countDef = await redis.hGetAll(countDefKey);
      const maxDef = await redis.hGetAll(maxDefKey);
      const minDef = await redis.hGetAll(minDefKey);
      const eventIdxMembers = await redis.sMembers(eventIdxKey);

      // Verify COUNT metric definition - after migration no propertyName field should exist
      expect(countDef.name).toBe("Test Calc COUNT");
      expect(countDef.aggregationType).toBe("COUNT");
      expect(countDef.valueType).toBe("NUMERIC");
      expect(countDef).not.toHaveProperty("propertyName"); // Crucial check - propertyName was removed

      // Verify metric IDs are in the event index (used to find metrics for incoming events)
      expect(eventIdxMembers).toContain(countMetric.id);
      expect(eventIdxMembers).toContain(sumMetric.id);
      expect(eventIdxMembers).toContain(uniqueCountMetric.id);

      // Verify MAX metric definition
      expect(maxDef.name).toBe("Test Calc MAX");
      expect(maxDef.aggregationType).toBe("MAX");
      expect(maxDef.valueType).toBe("NUMERIC");
      expect(maxDef).not.toHaveProperty("propertyName"); // Should be removed

      // Verify MIN metric definition
      expect(minDef.name).toBe("Test Calc MIN");
      expect(minDef.aggregationType).toBe("MIN");
      expect(minDef.valueType).toBe("NUMERIC");
      expect(minDef).not.toHaveProperty("propertyName"); // Should be removed

      // Final check that all metrics are registered for this event
      expect(eventIdxMembers).toContain(countMetric.id);
      expect(eventIdxMembers).toContain(sumMetric.id);
      expect(eventIdxMembers).toContain(uniqueCountMetric.id);
      expect(eventIdxMembers).toContain(maxMetric.id);
      expect(eventIdxMembers).toContain(minMetric.id);
    });

    beforeEach(async () => {
      await clearEventData(); // Clear before ingesting for this specific test

      const eventNameForMetrics = countMetric.eventName; // Reuse from beforeAll
      if (!eventNameForMetrics)
        throw new Error("Event name not set for metrics");

      const eventsToIngest: Omit<EventInput, "eventTimestamp">[] = [
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-val-1-${createId()}`,
          eventValue: 10,
        },
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-val-2-${createId()}`,
          eventValue: 25,
        },
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-val-3-${createId()}`,
          eventValue: 5,
        },
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-val-4-${createId()}`,
          eventValue: 0,
        },
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-str-1-${createId()}`,
          eventString: "userA",
        },
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-str-2-${createId()}`,
          eventString: "userB",
        },
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-str-3-${createId()}`,
          eventString: "userA",
        },
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-str-4-${createId()}`,
          eventString: "userC",
        },
        {
          eventName: eventNameForMetrics,
          customerId: testCustomerId,
          idempotencyKey: `calc-ev-str-5-${createId()}`,
          eventString: "userD",
        },
      ];

      const now = Date.now();
      const eventsWithTimestamps = eventsToIngest.map((ev, i) => ({
        ...ev,
        eventTimestamp: new Date(now - (eventsToIngest.length - i) * 1000),
      }));

      const apiPayload = {
        events: eventsWithTimestamps.map((ev) => ({
          ...ev,
          eventTimestamp: ev.eventTimestamp.toISOString(),
        })),
      };
      const response = await client.events.batch.$post({ json: apiPayload });
      if (response.status !== 202) {
        throw new Error(
          `Batch event ingestion failed in beforeEach with status ${response.status}`
        );
      }
      const bodyBatch = await response.json();
      if ("error" in bodyBatch)
        throw new Error(`API error in beforeEach: ${bodyBatch.error}`);

      // Increase wait time significantly to allow QuestDB flush before test runs
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });

    it("should get correct COUNT value via API", async () => {
      const response = await client.metrics[":id"].value.$get({
        param: { id: countMetric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) throw new Error(`API error: ${data.error}`);

      const validatedData = metricValueResponseSchema.parse(data);
      expect(validatedData.id).toBe(countMetric.id);
      // Updated expected COUNT value
      expect(validatedData.value).toBe(9);
    });

    it("should get correct SUM value via API", async () => {
      const response = await client.metrics[":id"].value.$get({
        param: { id: sumMetric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) throw new Error(`API error: ${data.error}`);

      const validatedData = metricValueResponseSchema.parse(data);
      expect(validatedData.id).toBe(sumMetric.id);
      // Updated expected SUM value
      expect(validatedData.value).toBe(10 + 25 + 5 + 0); // 40
    });

    it("should get correct UNIQUE_COUNT value via API", async () => {
      const response = await client.metrics[":id"].value.$get({
        param: { id: uniqueCountMetric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) throw new Error(`API error: ${data.error}`);

      const validatedData = metricValueResponseSchema.parse(data);
      expect(validatedData.id).toBe(uniqueCountMetric.id);
      // Updated expected UNIQUE_COUNT value ('userA', 'userB', 'userC', 'userD')
      expect(validatedData.value).toBe(4);
    });

    it("should get correct MAX value via API", async () => {
      const response = await client.metrics[":id"].value.$get({
        param: { id: maxMetric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) throw new Error(`API error: ${data.error}`);

      const validatedData = metricValueResponseSchema.parse(data);
      expect(validatedData.id).toBe(maxMetric.id);
      // Updated expected MAX value
      expect(validatedData.value).toBe(25);
    });

    it("should get correct MIN value via API", async () => {
      const response = await client.metrics[":id"].value.$get({
        param: { id: minMetric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) throw new Error(`API error: ${data.error}`);

      const validatedData = metricValueResponseSchema.parse(data);
      expect(validatedData.id).toBe(minMetric.id);
      // Updated expected MIN value
      expect(validatedData.value).toBe(0);
    });
  });

  describe("GET /events (Query History from QuestDB)", () => {
    const eventBaseName = `history-test-${createId()}`;
    const customer1Id = testCustomerId; // Reuse existing test customer
    let customer2Id: string;
    let eventsToIngest: EventInput[] = []; // Define eventsToIngest here for beforeEach scope

    // Keep customer creation in beforeAll
    beforeAll(async () => {
      const cust2 = await createTestCustomer({
        merchantId: testMerchantId,
        name: "History Test Customer 2",
        email: `history_test_2_${Date.now()}@example.com`,
      });
      customer2Id = cust2.id;
    });

    // Ingest data fresh before each test
    beforeEach(async () => {
      await clearEventData(); // Clear before ingesting for this specific test

      const now = Date.now();
      // Reset and define eventsToIngest array inside beforeEach
      eventsToIngest = [
        // Customer 1, Event A (3 events)
        {
          eventName: `${eventBaseName}.A`,
          customerId: customer1Id,
          eventTimestamp: new Date(now - 60000),
          idempotencyKey: createId(),
          eventValue: 1,
        },
        {
          eventName: `${eventBaseName}.A`,
          customerId: customer1Id,
          eventTimestamp: new Date(now - 30000),
          idempotencyKey: createId(),
          eventValue: 2,
        },
        {
          eventName: `${eventBaseName}.A`,
          customerId: customer1Id,
          eventTimestamp: new Date(now - 10000),
          idempotencyKey: createId(),
          eventValue: 3,
        },
        // Customer 1, Event B (1 event)
        {
          eventName: `${eventBaseName}.B`,
          customerId: customer1Id,
          eventTimestamp: new Date(now - 20000),
          idempotencyKey: createId(),
          eventValue: 10,
        },
        // Customer 2, Event A (2 events)
        {
          eventName: `${eventBaseName}.A`,
          customerId: customer2Id,
          eventTimestamp: new Date(now - 50000),
          idempotencyKey: createId(),
          eventValue: 100,
        },
        {
          eventName: `${eventBaseName}.A`,
          customerId: customer2Id,
          eventTimestamp: new Date(now - 15000),
          idempotencyKey: createId(),
          eventValue: 200,
        },
      ];

      const apiPayload = {
        events: eventsToIngest.map((ev) => ({
          ...ev,
          eventTimestamp: (ev.eventTimestamp as Date).toISOString(), // Assert Date type
        })),
      };
      const response = await client.events.batch.$post({ json: apiPayload });
      if (response.status !== 202) {
        console.error(
          "Failed to ingest history test events in beforeEach:",
          await response.text()
        );
        throw new Error("Failed to ingest history test events in beforeEach");
      }
      // Wait sufficiently for ingestion and potential indexing
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    it("should fetch all events for the merchant with pagination info", async () => {
      const response = await client.events.$get();
      expect(response.status).toBe(200);
      const body = await response.json();
      if ("error" in body) throw new Error(`API Error: ${body.error}`);

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(eventsToIngest.length);
      expect(
        body.data.some((ev: any) => ev.eventName === `${eventBaseName}.B`)
      ).toBe(true);

      // Check pagination response format
      expect(body.pagination).toBeDefined();
      expect(body.pagination.limit).toBe(100); // Default limit
      expect(body.pagination.offset).toBe(0); // Default offset
      expect(typeof body.pagination.hasMore).toBe("boolean");
    });

    it("should filter events by customerId", async () => {
      const response = await client.events.$get({
        query: { customerId: customer2Id },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      if ("error" in body) throw new Error(`API Error: ${body.error}`);

      expect(body.data.length).toBe(2);
      expect(body.data.every((ev: any) => ev.customerId === customer2Id)).toBe(
        true
      );
    });

    it("should filter events by eventName", async () => {
      const response = await client.events.$get({
        query: { eventName: `${eventBaseName}.B` },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      if ("error" in body) throw new Error(`API Error: ${body.error}`);

      expect(body.data.length).toBe(1);
      expect(body.data[0].eventName).toBe(`${eventBaseName}.B`);
      expect(body.data[0].eventValue).toBe(10);
    });

    it("should filter events by date range", async () => {
      const queryTimestampsSQL = `
        SELECT event_timestamp, idempotency_key
        FROM events
        WHERE merchant_id = '${testMerchantId}'
          AND (
            idempotency_key = '${eventsToIngest[1].idempotencyKey}' OR
            idempotency_key = '${eventsToIngest[3].idempotencyKey}' OR
            idempotency_key = '${eventsToIngest[5].idempotencyKey}'
          )
        ORDER BY event_timestamp ASC
      `;
      const timestampResults = await queryQuestDbDirectly(queryTimestampsSQL);
      expect(timestampResults.rowCount).toBe(3);

      const actualMiddleTimestamp = new Date(
        Object.values(timestampResults.rows[1])[0]
      );
      const actualLastTimestamp = new Date(
        Object.values(timestampResults.rows[2])[0]
      );

      const startDate = new Date(actualMiddleTimestamp.getTime() - 5000);
      const endDate = new Date(actualLastTimestamp.getTime() + 5000);

      const response = await client.events.$get({
        query: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      if ("error" in body) throw new Error(`API Error: ${body.error}`);

      expect(body.data.length).toBeGreaterThanOrEqual(3);

      const relevantEvents = body.data.filter(
        (ev: any) =>
          ev.eventName &&
          (ev.eventName.includes(`${eventBaseName}.A`) ||
            ev.eventName.includes(`${eventBaseName}.B`))
      );

      expect(relevantEvents.length).toBeGreaterThan(0);

      const hasEventInRange = relevantEvents.some((ev: any) => {
        const ts = new Date(ev.eventTimestamp);
        return ts >= startDate && ts <= endDate;
      });

      expect(hasEventInRange).toBe(true);
    });

    it("should filter by customerId AND eventName", async () => {
      const response = await client.events.$get({
        query: { customerId: customer1Id, eventName: `${eventBaseName}.A` },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      if ("error" in body) throw new Error(`API Error: ${body.error}`);

      expect(body.data.length).toBe(3);
      expect(
        body.data.every(
          (ev: any) =>
            ev.customerId === customer1Id &&
            ev.eventName === `${eventBaseName}.A`
        )
      ).toBe(true);
    });

    it("should support array filters for eventName and customerId", async () => {
      // Test eventName array filter
      const eventNameResponse = await client.events.$get({
        query: { eventName: [`${eventBaseName}.A`, `${eventBaseName}.B`] },
      });
      expect(eventNameResponse.status).toBe(200);
      const eventNameBody = await eventNameResponse.json();
      if ("error" in eventNameBody)
        throw new Error(`API Error: ${eventNameBody.error}`);

      expect(eventNameBody.data.length).toBe(eventsToIngest.length); // All events match
      expect(
        eventNameBody.data.every(
          (ev: any) =>
            ev.eventName === `${eventBaseName}.A` ||
            ev.eventName === `${eventBaseName}.B`
        )
      ).toBe(true);

      // Test customerId array filter
      const customerIdResponse = await client.events.$get({
        query: { customerId: [customer1Id, customer2Id] },
      });
      expect(customerIdResponse.status).toBe(200);
      const customerIdBody = await customerIdResponse.json();
      if ("error" in customerIdBody)
        throw new Error(`API Error: ${customerIdBody.error}`);

      expect(customerIdBody.data.length).toBe(eventsToIngest.length); // All events match
      expect(
        customerIdBody.data.every(
          (ev: any) =>
            ev.customerId === customer1Id || ev.customerId === customer2Id
        )
      ).toBe(true);

      // Test combined array filters
      const combinedResponse = await client.events.$get({
        query: {
          customerId: [customer1Id],
          eventName: [`${eventBaseName}.A`],
        },
      });
      expect(combinedResponse.status).toBe(200);
      const combinedBody = await combinedResponse.json();
      if ("error" in combinedBody)
        throw new Error(`API Error: ${combinedBody.error}`);

      expect(combinedBody.data.length).toBe(3); // Only customer1's eventA events
      expect(
        combinedBody.data.every(
          (ev: any) =>
            ev.customerId === customer1Id &&
            ev.eventName === `${eventBaseName}.A`
        )
      ).toBe(true);
    });

    it("should handle pagination with limit and offset", async () => {
      // Test with limit
      const limitResponse = await client.events.$get({
        query: { limit: "2" },
      });
      expect(limitResponse.status).toBe(200);
      const limitBody = await limitResponse.json();
      if ("error" in limitBody)
        throw new Error(`API Error: ${limitBody.error}`);

      expect(limitBody.data.length).toBeLessThanOrEqual(2);
      expect(limitBody.pagination.limit).toBe(2);
      expect(limitBody.pagination.offset).toBe(0);
      expect(limitBody.pagination.hasMore).toBe(limitBody.data.length === 2);

      // Verify OFFSET works
      const offsetResponse = await client.events.$get({
        query: { limit: "2", offset: "2" },
      });
      expect(offsetResponse.status).toBe(200);
      const offsetBody = await offsetResponse.json();
      if ("error" in offsetBody)
        throw new Error(`API Error: ${offsetBody.error}`);
      expect(offsetBody.pagination.limit).toBe(2);
      expect(offsetBody.pagination.offset).toBe(2);
      expect(typeof offsetBody.pagination.hasMore).toBe("boolean");
    });
  });

  describe("New Events Endpoints", () => {
    const eventBaseName = `new-endpoints-test-${createId()}`;
    let customer1Id: string;
    let customer2Id: string;

    beforeAll(async () => {
      // Create test customers
      const cust1 = await createTestCustomer({
        merchantId: testMerchantId,
        name: "New Endpoints Test Customer 1",
        email: `new_endpoints_1_${Date.now()}@example.com`,
        externalCustomerId: `ext_cust_1_${Date.now()}`,
      });
      customer1Id = cust1.id;

      const cust2 = await createTestCustomer({
        merchantId: testMerchantId,
        name: "New Endpoints Test Customer 2",
        email: `new_endpoints_2_${Date.now()}@example.com`,
        externalCustomerId: `ext_cust_2_${Date.now()}`,
      });
      customer2Id = cust2.id;
    });

    beforeEach(async () => {
      await clearEventData();

      const now = Date.now();
      const eventsToIngest: EventInput[] = [
        // Customer 1 events
        {
          eventName: `${eventBaseName}.signup`,
          customerId: customer1Id,
          eventTimestamp: new Date(now - 60000),
          idempotencyKey: createId(),
          eventValue: 1,
        },
        {
          eventName: `${eventBaseName}.login`,
          customerId: customer1Id,
          eventTimestamp: new Date(now - 50000),
          idempotencyKey: createId(),
          eventValue: 1,
        },
        {
          eventName: `${eventBaseName}.purchase`,
          customerId: customer1Id,
          eventTimestamp: new Date(now - 40000),
          idempotencyKey: createId(),
          eventValue: 25,
        },
        // Customer 2 events
        {
          eventName: `${eventBaseName}.signup`,
          customerId: customer2Id,
          eventTimestamp: new Date(now - 30000),
          idempotencyKey: createId(),
          eventValue: 1,
        },
        {
          eventName: `${eventBaseName}.login`,
          customerId: customer2Id,
          eventTimestamp: new Date(now - 20000),
          idempotencyKey: createId(),
          eventValue: 1,
        },
        // Different event for variety
        {
          eventName: `${eventBaseName}.view_product`,
          customerId: customer2Id,
          eventTimestamp: new Date(now - 10000),
          idempotencyKey: createId(),
          eventValue: 1,
        },
      ];

      const apiPayload = {
        events: eventsToIngest.map((ev) => ({
          ...ev,
          eventTimestamp: (ev.eventTimestamp as Date).toISOString(),
        })),
      };
      const response = await client.events.batch.$post({ json: apiPayload });
      if (response.status !== 202) {
        throw new Error("Failed to ingest new endpoints test events");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    it("should get event count with various filters and test unique endpoints", async () => {
      // Test GET /events/count - all events
      const countAllResponse = await client.events.count.$get({ query: {} });
      expect(countAllResponse.status).toBe(200);
      const countAllBody = await countAllResponse.json();
      if ("error" in countAllBody)
        throw new Error(`API Error: ${countAllBody.error}`);
      expect(countAllBody.totalCount).toBe(6);

      // Test GET /events/count - filter by eventName
      const countByEventResponse = await client.events.count.$get({
        query: { eventName: `${eventBaseName}.login` },
      });
      expect(countByEventResponse.status).toBe(200);
      const countByEventBody = await countByEventResponse.json();
      if ("error" in countByEventBody)
        throw new Error(`API Error: ${countByEventBody.error}`);
      expect(countByEventBody.totalCount).toBe(2);

      // Test GET /events/count - filter by customerId
      const countByCustomerResponse = await client.events.count.$get({
        query: { customerId: customer1Id },
      });
      expect(countByCustomerResponse.status).toBe(200);
      const countByCustomerBody = await countByCustomerResponse.json();
      if ("error" in countByCustomerBody)
        throw new Error(`API Error: ${countByCustomerBody.error}`);
      expect(countByCustomerBody.totalCount).toBe(3);

      // Test GET /events/count - array filters
      const countArrayResponse = await client.events.count.$get({
        query: {
          eventName: [`${eventBaseName}.signup`, `${eventBaseName}.purchase`],
        },
      });
      expect(countArrayResponse.status).toBe(200);
      const countArrayBody = await countArrayResponse.json();
      if ("error" in countArrayBody)
        throw new Error(`API Error: ${countArrayBody.error}`);
      expect(countArrayBody.totalCount).toBe(3); // 2 signup + 1 purchase

      // Test GET /events/unique-event-names
      const uniqueNamesResponse =
        await client.events["unique-event-names"].$get();
      expect(uniqueNamesResponse.status).toBe(200);
      const uniqueNamesBody = await uniqueNamesResponse.json();
      if ("error" in uniqueNamesBody)
        throw new Error(`API Error: ${uniqueNamesBody.error}`);

      expect(Array.isArray(uniqueNamesBody.eventNames)).toBe(true);
      expect(uniqueNamesBody.eventNames.length).toBe(4); // signup, login, purchase, view_product
      expect(uniqueNamesBody.eventNames).toContain(`${eventBaseName}.signup`);
      expect(uniqueNamesBody.eventNames).toContain(`${eventBaseName}.login`);
      expect(uniqueNamesBody.eventNames).toContain(`${eventBaseName}.purchase`);
      expect(uniqueNamesBody.eventNames).toContain(
        `${eventBaseName}.view_product`
      );

      // Test GET /events/unique-customer-ids
      const uniqueCustomersResponse =
        await client.events["unique-customer-ids"].$get();
      expect(uniqueCustomersResponse.status).toBe(200);
      const uniqueCustomersBody = await uniqueCustomersResponse.json();
      if ("error" in uniqueCustomersBody)
        throw new Error(`API Error: ${uniqueCustomersBody.error}`);

      expect(Array.isArray(uniqueCustomersBody.customerIds)).toBe(true);
      expect(uniqueCustomersBody.customerIds.length).toBe(2);

      // Check that both customers are present and have correct structure
      const customerIds = uniqueCustomersBody.customerIds.map((c: any) => c.id);
      expect(customerIds).toContain(customer1Id);
      expect(customerIds).toContain(customer2Id);

      // Verify customer data structure
      uniqueCustomersBody.customerIds.forEach((customer: any) => {
        expect(customer.id).toBeDefined();
        expect(customer.type).toBe("customer");
        expect(customer.name).toBeDefined();
        expect(customer.email).toBeDefined();
        if (customer.id === customer1Id || customer.id === customer2Id) {
          // For primary records returned with internal ID, internalId should be defined
          expect(customer.internalId).toBeDefined();
          // externalId may or may not be present depending on whether the
          // endpoint returns the external customer ID variant or the internal
          // one as the primary record. We only assert it if provided.
          if (customer.externalId !== undefined) {
            expect(typeof customer.externalId).toBe("string");
          }
        }
      });
    });

    it("should handle date range filters in count endpoint", async () => {
      const now = Date.now();
      const startDate = new Date(now - 45000); // Middle of our test data range
      const endDate = new Date(now - 15000); // Near the end

      const countByDateResponse = await client.events.count.$get({
        query: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        },
      });
      expect(countByDateResponse.status).toBe(200);
      const countByDateBody = await countByDateResponse.json();
      if ("error" in countByDateBody)
        throw new Error(`API Error: ${countByDateBody.error}`);

      // Should capture events in the middle range
      expect(countByDateBody.totalCount).toBeGreaterThan(0);
      expect(countByDateBody.totalCount).toBeLessThan(6); // Less than total
    });
  });
});
