import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createFullTestEnvironment } from "../test-helpers";
import { createId } from "@lumen/common";
import questDbService from "../../src/db/questDbService";
import { env } from "../../src/env";
import { QuestDbEventInput } from "@lumen/common/validators";
import { logger } from "../../src/helpers/logging";

// Helper to add delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("QuestDB Service Integration Tests", () => {
  let testMerchantId: string;
  const testRunId = createId(); // Unique ID for this test run's events

  // --- Test Setup & Teardown ---
  beforeAll(async () => {
    logger.info("QuestDB Test: Setting up environment...");
    const { merchant } = await createFullTestEnvironment();
    testMerchantId = merchant.id;
    logger.info(`QuestDB Test: Merchant created: ${testMerchantId}`);

    logger.info("QuestDB Test: Initializing QuestDB service...");
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
        QUESTDB_PASSWORD
      );
      logger.info("QuestDB Test: QuestDB service initialized successfully.");
    } catch (error) {
      logger.error("QuestDB Test: Failed to initialize QuestDB:", error);
      throw error;
    }
  });

  afterAll(async () => {
    logger.info("QuestDB Test: Cleaning up...");
    try {
      await questDbService.close();
      logger.info("QuestDB Test: QuestDB service closed successfully.");
    } catch (error) {
      logger.error("QuestDB Test: Failed to close QuestDB:", error);
    }
    // Note: Data remains in QuestDB for manual inspection if needed.
    logger.info("QuestDB Test: Cleanup finished.");
  });

  // --- Ingestion Tests ---
  describe("Event Ingestion", () => {
    const numericEventName = `test.numeric.${testRunId}`;
    const stringEventName = `test.string.${testRunId}`;
    const batchEventName = `test.batch.${testRunId}`;
    const customerId1 = `cust-1-${testRunId}`;
    const customerId2 = `cust-2-${testRunId}`;

    // IMPORTANT: QuestDB requires time after ingestion for data to become queryable,
    // even after flush() is called. This is especially true on constrained environments
    // like GitHub Actions runners. Without delays, queries may return 0 results.
    const INGESTION_DELAY_MS = 1000; // Delay after each ingestion

    it("should ingest a single event with a numeric value", async () => {
      const eventData: QuestDbEventInput = {
        idempotency_key: createId(),
        merchant_id: testMerchantId,
        customer_id: customerId1,
        event_name: numericEventName,
        timestamp: new Date(),
        event_value: 42.5,
        properties: { source: "single_numeric_test" },
      };
      const success = await questDbService.ingestEvent(eventData);
      expect(success).toBe(true);

      // Allow time for QuestDB to make data queryable
      await delay(INGESTION_DELAY_MS);
    });

    it("should ingest a single event with a string value", async () => {
      const eventData: QuestDbEventInput = {
        idempotency_key: createId(),
        merchant_id: testMerchantId,
        customer_id: customerId1,
        event_name: stringEventName,
        timestamp: new Date(),
        event_string: "unique_value_1",
        properties: { source: "single_string_test" },
      };
      const success = await questDbService.ingestEvent(eventData);
      expect(success).toBe(true);

      // Allow time for QuestDB to make data queryable
      await delay(INGESTION_DELAY_MS);
    });

    it("should ingest multiple events using ingestEvents (batch)", async () => {
      const baseTimestamp = new Date(); // Base time for the batch
      const events: QuestDbEventInput[] = [
        {
          // Event 1
          idempotency_key: createId(),
          merchant_id: testMerchantId,
          customer_id: customerId1,
          event_name: batchEventName,
          timestamp: baseTimestamp, // Use base timestamp
          event_value: 10,
          properties: { batch: 1, item: 1 },
        },
        {
          // Event 2
          idempotency_key: createId(),
          merchant_id: testMerchantId,
          customer_id: customerId2, // Different customer
          event_name: batchEventName,
          timestamp: new Date(baseTimestamp.getTime() + 10), // Add 10ms
          event_value: 20,
          event_string: "batch_val_2",
          properties: { batch: 1, item: 2 },
        },
        {
          // Event 3
          idempotency_key: createId(),
          merchant_id: testMerchantId,
          customer_id: customerId1,
          event_name: batchEventName,
          timestamp: new Date(baseTimestamp.getTime() + 20), // Add 20ms
          event_value: 30,
          event_string: "batch_val_3",
          properties: { batch: 1, item: 3 },
        },
      ];
      const success = await questDbService.ingestEvents(events);
      expect(success).toBe(true);

      // Allow more time for ingestion before subsequent query tests
      await delay(1500); // Increased delay
    });
  });

  // --- Query Verification Tests ---
  // These run after the ingestion tests have completed (and waited)
  describe("Query Verification (queryMetrics)", () => {
    const numericEventName = `test.numeric.${testRunId}`;
    const stringEventName = `test.string.${testRunId}`;
    const batchEventName = `test.batch.${testRunId}`;
    const customerId1 = `cust-1-${testRunId}`;
    const customerId2 = `cust-2-${testRunId}`;

    it("should verify COUNT for single numeric event", async () => {
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        metricType: "simple",
        aggregation: "COUNT",
        valueType: "NUMERIC",
        eventName: numericEventName,
        timeframe: { type: "ALL" },
      });
      expect(result.error).toBeUndefined();
      expect(result.value).toBe(1);
    });

    it("should verify COUNT for single string event", async () => {
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        metricType: "simple",
        aggregation: "COUNT",
        valueType: "STRING", // Check based on string value
        eventName: stringEventName,
        timeframe: { type: "ALL" },
      });
      expect(result.error).toBeUndefined();
      expect(result.value).toBe(1);
    });

    it("should verify COUNT for batch events (total)", async () => {
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        metricType: "simple",
        aggregation: "COUNT",
        valueType: "NUMERIC", // COUNT(*) doesn't rely on this
        eventName: batchEventName,
        timeframe: { type: "ALL" },
      });
      expect(result.error).toBeUndefined();
      // We sent 3 events with this name
      expect(result.value).toBe(3);
    });

    it("should verify SUM for batch events", async () => {
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        metricType: "simple",
        aggregation: "SUM",
        valueType: "NUMERIC",
        eventName: batchEventName,
        timeframe: { type: "ALL" },
      });
      expect(result.error).toBeUndefined();
      // Sum was 10 + 20 + 30
      expect(result.value).toBe(60);
    });

    it("should verify UNIQUE_COUNT for batch events (string values)", async () => {
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        metricType: "simple",
        aggregation: "UNIQUE_COUNT",
        valueType: "STRING", // Count distinct event_string
        eventName: batchEventName,
        timeframe: { type: "ALL" },
      });
      expect(result.error).toBeUndefined();
      // We sent "batch_val_2", "batch_val_3" (one event had no string)
      expect(result.value).toBe(2);
    });

    it("should verify COUNT for a specific customer (batch events)", async () => {
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: customerId1, // Filter by customer 1
        metricType: "simple",
        aggregation: "COUNT",
        valueType: "NUMERIC",
        eventName: batchEventName,
        timeframe: { type: "ALL" },
      });
      expect(result.error).toBeUndefined();
      // Customer 1 had 2 events in the batch
      expect(result.value).toBe(2);
    });

    it("should return 0 for COUNT for a non-existent event", async () => {
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        metricType: "simple",
        aggregation: "COUNT",
        valueType: "NUMERIC",
        eventName: `non.existent.${testRunId}`,
        timeframe: { type: "ALL" },
      });
      expect(result.error).toBeUndefined();
      expect(result.value).toBe(0);
    });
  });

  // --- NEW: Tests for queryEvents ---
  describe("Query Verification (queryEvents)", () => {
    const eventBaseName = `queryEvents-test-${testRunId}`;
    const customerId1 = `cust-qe-1-${testRunId}`;
    const customerId2 = `cust-qe-2-${testRunId}`;
    let ingestedEventData: QuestDbEventInput[] = []; // Store for verification

    // Add specific beforeAll for this suite to ingest data
    beforeAll(async () => {
      ingestedEventData = [
        // Event 1 (Cust1, Numeric)
        {
          merchant_id: testMerchantId,
          customer_id: customerId1,
          event_name: `${eventBaseName}.numeric`,
          timestamp: new Date(Date.now() - 50000),
          event_value: 42.5,
          idempotency_key: createId(),
          properties: { testGroup: "queryEvents" },
        },
        // Event 2 (Cust1, String)
        {
          merchant_id: testMerchantId,
          customer_id: customerId1,
          event_name: `${eventBaseName}.string`,
          timestamp: new Date(Date.now() - 40000),
          event_string: "unique_value_qe_1",
          idempotency_key: createId(),
          properties: { testGroup: "queryEvents" },
        },
        // Event 3 (Cust2, BatchLike 1)
        {
          merchant_id: testMerchantId,
          customer_id: customerId2,
          event_name: `${eventBaseName}.batchlike`,
          timestamp: new Date(Date.now() - 30000),
          event_value: 100,
          idempotency_key: createId(),
          properties: { testGroup: "queryEvents", item: 1 },
        },
        // Event 4 (Cust2, BatchLike 2)
        {
          merchant_id: testMerchantId,
          customer_id: customerId2,
          event_name: `${eventBaseName}.batchlike`,
          timestamp: new Date(Date.now() - 20000),
          event_value: 200,
          idempotency_key: createId(),
          properties: { testGroup: "queryEvents", item: 2 },
        },
      ];

      const success = await questDbService.ingestEvents(ingestedEventData);
      if (!success) {
        throw new Error(
          "[queryEvents Test] Failed to ingest events in beforeAll"
        );
      }
      // Wait after ingestion within this specific test suite
      await delay(1000);
    });

    // Helper function to parse properties safely
    const parseProps = (
      propsString: string | undefined | null
    ): Record<string, any> | null => {
      if (!propsString) return null;
      try {
        return JSON.parse(propsString);
      } catch (e) {
        console.error("Failed to parse properties string:", propsString, e);
        return null;
      }
    };

    it("should query all events specific to this test suite", async () => {
      const result = await questDbService.queryEvents({
        merchantId: testMerchantId,
      });
      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.data)).toBe(true);
      // Filter results in test, parsing properties
      const relevantEvents = result.data.filter((ev) => {
        const props = parseProps(ev.properties);
        return props?.testGroup === "queryEvents";
      });
      expect(relevantEvents.length).toBe(ingestedEventData.length);
    });

    it("should filter events by customerId (queryEvents suite)", async () => {
      const result = await questDbService.queryEvents({
        merchantId: testMerchantId,
        customerId: customerId2,
      });
      expect(result.error).toBeUndefined();

      const relevantEvents = result.data.filter((ev) => {
        const props = parseProps(ev.properties);
        return props?.testGroup === "queryEvents";
      });
      expect(relevantEvents.length).toBe(2);
      expect(relevantEvents.every((ev) => ev.customer_id === customerId2)).toBe(
        true
      );
    });

    it("should filter events by eventName (queryEvents suite)", async () => {
      const eventName = `${eventBaseName}.numeric`;
      const result = await questDbService.queryEvents({
        merchantId: testMerchantId,
        eventName: eventName,
      });
      expect(result.error).toBeUndefined();

      const relevantEvents = result.data.filter((ev) => {
        const props = parseProps(ev.properties);
        return props?.testGroup === "queryEvents";
      });
      expect(relevantEvents.length).toBe(1);
      expect(relevantEvents[0].event_name).toBe(eventName);
      expect(relevantEvents[0].event_value).toBe(42.5);
    });
  });
});
