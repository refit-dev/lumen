import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { createId, createPrefixedId, ID_PREFIXES } from "@lumen/common";
import {
  createFullTestEnvironment,
  createTestCustomer,
  createAuthenticatedClient,
  createTestMetric,
  deleteTestMetric,
  createPlanWithDefinedFeatures,
  createBasicSubscription,
  createTestEvents,
  ClientType,
} from "../test-helpers";
import { db } from "../../src/db/client";
import {
  metrics,
  events,
  AggregationType as MetricAggregationType,
  ValueType,
} from "@lumen/common/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  getRedisClient,
  RedisClientType,
  withRedisReconnect,
} from "../../src/lib/redis";
import { MetricDefinitionResponse } from "@lumen/common/validators";
// Import already added above
import { bootstrapMetricDefinitions } from "../../src/lib/metricDefinitions";
import { forceReconciliation } from "../../src/lib/cacheSynchronizer";
import { verifyNoMetricData } from "../test-helpers/test-utils/questdb-helpers";
import questDbService from "../../src/db/questDbService";
import { env } from "../../src/env";

// Helper functions

// Helper to check Redis metric definition hash
async function getRedisMetricDef(
  merchantId: string,
  metricId: string
): Promise<Record<string, string> | null> {
  const redisClient = await getRedisClient();
  if (!redisClient) throw new Error("Redis client not initialized");
  const data = await redisClient.hGetAll(
    `metric_def:${merchantId}:${metricId}`
  );
  // hGetAll might return an empty object if key doesn't exist, return null instead
  return Object.keys(data).length > 0 ? data : null;
}

// Helper to check Redis event name set
async function getRedisMetricsForEvent(
  merchantId: string,
  eventName: string
): Promise<string[]> {
  const redisClient = await getRedisClient();
  if (!redisClient) throw new Error("Redis client not initialized");
  return await redisClient.sMembers(
    `metrics_for_event:${merchantId}:${eventName}`
  );
}

// Waits for an event to appear in the PostgreSQL database
async function waitForEvent(
  idempotencyKey: string,
  merchantId: string,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(events)
      .where(
        and(
          eq(events.idempotencyKey, idempotencyKey),
          eq(events.merchantId, merchantId)
        )
      );

    if (result[0]?.count > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.warn(
    `Event ${idempotencyKey} did not appear in DB within ${timeoutMs}ms`
  );
  return false;
}

// Initialize QuestDB before all tests
beforeAll(async () => {
  // Initialize QuestDB service for the test process
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
});

describe("Metric System Integration Tests", () => {
  // Common vars across all test suites
  let client: ClientType;
  let testMerchantId: string;
  let testCustomerId: string;
  let subscriptionId: string;
  let redis: RedisClientType;
  const cleanupMetricIds: { id: string; eventName: string }[] = [];

  // Setup test environment
  beforeAll(async () => {
    // Create test environment with merchant
    const { user, merchant } = await createFullTestEnvironment({
      createPlan: false,
    });
    testMerchantId = merchant.id;

    // Create a test customer
    const customer = await createTestCustomer({
      merchantId: testMerchantId,
      name: "Metrics Test Customer",
      email: `metrics_test_${Date.now()}@example.com`,
    });
    testCustomerId = customer.id;

    // Create authenticated client
    client = await createAuthenticatedClient(user.email, user.password);

    // Create a plan and subscription for the test customer (needed for events)
    const { plan, price } = await createPlanWithDefinedFeatures(
      testMerchantId,
      [],
      { planName: `Metrics Test Plan ${Date.now()}` }
    );
    const sub = await createBasicSubscription(
      testMerchantId,
      testCustomerId,
      plan.id,
      price.id
    );
    subscriptionId = sub.id;

    // Get Redis client
    redis = await getRedisClient();
    if (!redis) {
      throw new Error("Redis client not available for tests");
    }
  });

  // Clean up after all tests
  afterAll(async () => {
    // Clean up created metrics
    for (const { id, eventName } of cleanupMetricIds) {
      try {
        await deleteTestMetric(id, testMerchantId, eventName);
      } catch (error) {
        console.warn(`Failed to delete metric ${id}: ${error}`);
      }
    }

    // Clean up any created events
    try {
      await db
        .delete(events)
        .where(
          and(
            eq(events.merchantId, testMerchantId),
            eq(events.customerId, testCustomerId)
          )
        );
    } catch (error) {
      console.warn(`Failed to clean up events: ${error}`);
    }

    // Close QuestDB connection for the test process
    try {
      await questDbService.close();
    } catch (error) {
      console.error("Failed to close QuestDB for test process:", error);
    }

    // Verify no metric data remains
    await verifyNoMetricData(testMerchantId);
  });

  // 1. Metric Definition API Tests
  describe("Metric Definition API", () => {
    describe("POST /metrics - Creating Metrics", () => {
      it("should create a COUNT metric successfully", async () => {
        const metricData = {
          name: `Test COUNT Metric ${Date.now()}`,
          eventName: "test.event.count",
          aggregationType: "COUNT" as const,
          valueType: "NUMERIC" as const,
          description: "A test count metric",
          sqlDefinition: undefined,
          queryType: "simple" as const,
        };

        const response = await client.metrics.$post({
          json: metricData,
        });
        expect(response.status).toBe(201);

        const responseData = await response.json();
        if ("error" in responseData) {
          throw new Error(`API returned error: ${responseData.error}`);
        }
        const createdMetric = {
          ...responseData,
          createdAt: new Date(responseData.createdAt),
          updatedAt: new Date(responseData.updatedAt),
        } as MetricDefinitionResponse;
        cleanupMetricIds.push({
          id: createdMetric.id,
          eventName: createdMetric.eventName || metricData.eventName,
        });

        // Basic response validation
        expect(createdMetric.id).toBeString();
        expect(createdMetric.merchantId).toBe(testMerchantId);
        expect(createdMetric.name).toBe(metricData.name);
        expect(createdMetric.eventName).toBe(metricData.eventName);
        expect(createdMetric.aggregationType).toBe("COUNT");
        expect(createdMetric.description).toBe(metricData.description);

        // Verify in Postgres
        const dbMetric = await db.query.metrics.findFirst({
          where: and(
            eq(metrics.id, createdMetric.id),
            eq(metrics.merchantId, testMerchantId)
          ),
        });
        expect(dbMetric).toBeDefined();
        expect(dbMetric?.name).toBe(metricData.name);
        expect(dbMetric?.eventName).toBe(metricData.eventName);
        expect(dbMetric?.aggregationType).toBe("COUNT");

        // Verify in Redis
        const redisDef = await getRedisMetricDef(
          testMerchantId,
          createdMetric.id
        );
        expect(redisDef).not.toBeNull();
        expect(redisDef?.name).toBe(metricData.name);
        expect(redisDef?.eventName).toBe(metricData.eventName);
        expect(redisDef?.aggregationType).toBe("COUNT");

        const redisEventMetrics = await getRedisMetricsForEvent(
          testMerchantId,
          metricData.eventName
        );
        expect(redisEventMetrics).toContain(createdMetric.id);
      });

      it("should create a SUM metric successfully", async () => {
        const metricData = {
          name: `Test SUM Metric ${Date.now()}`,
          eventName: "test.event.sum",
          aggregationType: "SUM" as const,
          valueType: "NUMERIC" as const,
          description: "A test sum metric",
          sqlDefinition: undefined,
          queryType: "simple" as const,
        };
        const response = await client.metrics.$post({
          json: metricData,
        });
        expect(response.status).toBe(201);
        const responseData = await response.json();
        if ("error" in responseData) {
          throw new Error(`API returned error: ${responseData.error}`);
        }
        const createdMetric = {
          ...responseData,
          createdAt: new Date(responseData.createdAt),
          updatedAt: new Date(responseData.updatedAt),
        } as MetricDefinitionResponse;
        cleanupMetricIds.push({
          id: createdMetric.id,
          eventName: createdMetric.eventName || metricData.eventName,
        });

        expect(createdMetric.aggregationType).toBe("SUM");

        const dbMetric = await db.query.metrics.findFirst({
          where: eq(metrics.id, createdMetric.id),
        });
        expect(dbMetric?.aggregationType).toBe("SUM");

        const redisDef = await getRedisMetricDef(
          testMerchantId,
          createdMetric.id
        );
        expect(redisDef?.aggregationType).toBe("SUM");
        const redisEventMetrics = await getRedisMetricsForEvent(
          testMerchantId,
          metricData.eventName
        );
        expect(redisEventMetrics).toContain(createdMetric.id);
      });

      it("should create a UNIQUE_COUNT metric successfully", async () => {
        const metricData = {
          name: `Test UNIQUE_COUNT Metric ${Date.now()}`,
          eventName: "test.event.set",
          aggregationType: "UNIQUE_COUNT" as const,
          valueType: "STRING" as const,
          description: "A test unique count metric",
          sqlDefinition: undefined,
          queryType: "simple" as const,
        };
        const response = await client.metrics.$post({
          json: metricData,
        });
        expect(response.status).toBe(201);
        const responseData = await response.json();
        if ("error" in responseData) {
          throw new Error(`API returned error: ${responseData.error}`);
        }
        const createdMetric = {
          ...responseData,
          createdAt: new Date(responseData.createdAt),
          updatedAt: new Date(responseData.updatedAt),
        } as MetricDefinitionResponse;
        cleanupMetricIds.push({
          id: createdMetric.id,
          eventName: createdMetric.eventName || metricData.eventName,
        });

        expect(createdMetric.aggregationType).toBe("UNIQUE_COUNT");

        const dbMetric = await db.query.metrics.findFirst({
          where: eq(metrics.id, createdMetric.id),
        });
        expect(dbMetric?.aggregationType).toBe("UNIQUE_COUNT");

        const redisDef = await getRedisMetricDef(
          testMerchantId,
          createdMetric.id
        );
        expect(redisDef?.aggregationType).toBe("UNIQUE_COUNT");
        const redisEventMetrics = await getRedisMetricsForEvent(
          testMerchantId,
          metricData.eventName
        );
        expect(redisEventMetrics).toContain(createdMetric.id);
      });

      it("should fail to create a metric without eventName", async () => {
        const metricData = {
          name: `Invalid Metric No Event ${Date.now()}`,
          aggregationType: "COUNT" as const,
          // eventName is missing
        };
        const response = await client.metrics.$post({
          json: metricData,
        });
        expect([400, 422]).toContain(response.status);
      });

      it("should fail to create a metric without name", async () => {
        const metricData = {
          eventName: "test.event.no.name",
          aggregationType: "COUNT" as const,
          // name is missing
        };
        const response = await client.metrics.$post({
          json: metricData as any, // Intentionally invalid for test
        });
        expect([400, 422]).toContain(response.status);
      });

      it("should fail to create a metric with invalid aggregationType", async () => {
        const metricData = {
          name: `Invalid Agg Type ${Date.now()}`,
          eventName: "test.event.invalid.agg",
          aggregationType: "AVERAGE", // Invalid type
        };
        const response = await client.metrics.$post({
          json: metricData as any, // Intentionally invalid for test
        });
        expect([400, 422]).toContain(response.status);
      });
    });

    describe("GET /metrics and /metrics/:id", () => {
      let metric1: MetricDefinitionResponse;
      let metric2: MetricDefinitionResponse;

      // Create some metrics before running GET tests
      beforeAll(async () => {
        const data1 = {
          name: `GET Test 1 ${Date.now()}`,
          eventName: "get.test.event1",
          aggregationType: "COUNT" as const,
          valueType: "NUMERIC" as const,
        };
        const res1 = await client.metrics.$post({
          json: data1,
        });
        const res1Json = await res1.json();
        if ("error" in res1Json) {
          throw new Error(
            `metric1 creation failed: ${JSON.stringify(res1Json)}`
          );
        }
        // Parse dates before assigning
        metric1 = {
          ...res1Json,
          createdAt: new Date(res1Json.createdAt),
          updatedAt: new Date(res1Json.updatedAt),
        } as MetricDefinitionResponse;
        cleanupMetricIds.push({
          id: metric1.id,
          eventName: metric1.eventName ?? "",
        });

        const data2 = {
          name: `GET Test 2 ${Date.now()}`,
          eventName: "get.test.event2",
          aggregationType: "SUM" as const,
          valueType: "NUMERIC" as const,
        };
        const res2 = await client.metrics.$post({
          json: data2,
        });
        const res2Json = await res2.json();
        if ("error" in res2Json) {
          throw new Error(
            `metric2 creation failed: ${JSON.stringify(res2Json)}`
          );
        }
        // Parse dates before assigning
        metric2 = {
          ...res2Json,
          createdAt: new Date(res2Json.createdAt),
          updatedAt: new Date(res2Json.updatedAt),
        } as MetricDefinitionResponse;
        cleanupMetricIds.push({
          id: metric2.id,
          eventName: metric2.eventName ?? "",
        });
      });

      it("should retrieve a list of metrics using GET /metrics", async () => {
        const response = await client.metrics.$get({});
        expect(response.status).toBe(200);

        // API returns a direct array
        const responseData = await response.json();

        // Check if the response is an array before asserting the type
        if (!Array.isArray(responseData)) {
          throw new Error(
            `Unexpected response format: Expected array, got ${JSON.stringify(responseData)}`
          );
        }

        // Replace type in cast - requires parsing dates for each item
        const body = responseData.map((item) => {
          if (item.createdAt && item.updatedAt) {
            return {
              ...item,
              createdAt: new Date(item.createdAt),
              updatedAt: new Date(item.updatedAt),
            };
          }
          return item;
        }) as MetricDefinitionResponse[];

        // Check if the created metrics are present in the list
        const found1 = body.find((m) => m.id === metric1.id);
        const found2 = body.find((m) => m.id === metric2.id);

        expect(found1).toBeDefined();
        expect(found2).toBeDefined();
        expect(found1?.name).toBe(metric1.name);
        expect(found2?.name).toBe(metric2.name);
        expect(found1?.aggregationType).toBe("COUNT");
        expect(found2?.aggregationType).toBe("SUM");
      });

      it("should retrieve a specific metric using GET /metrics/:id", async () => {
        const response = await client.metrics[":id"].$get({
          param: { id: metric1.id },
        });
        expect(response.status).toBe(200);

        const responseData = await response.json();
        if ("error" in responseData) {
          // If the API returned an error, handle it (maybe expect 404)
          expect(response.status).toBe(404); // Or appropriate status for not found
        } else {
          // Parse dates before checking
          const fetchedMetric = {
            ...responseData,
            createdAt: new Date(responseData.createdAt),
            updatedAt: new Date(responseData.updatedAt),
          } as MetricDefinitionResponse;
          expect(fetchedMetric.id).toBe(metric1.id);
          expect(fetchedMetric.name).toBe(metric1.name);
        }
      });

      it("should return a 404 for a non-existent metric ID", async () => {
        const fakeId = createId();
        const response = await client.metrics[":id"].$get({
          param: { id: fakeId },
        });
        expect(response.status).toBe(404);
      });
    });

    describe("POST /metrics/:id/update", () => {
      let metricToUpdate: MetricDefinitionResponse;
      const originalEventName = "patch.test.event.original";
      const updatedEventName = "patch.test.event.updated";

      beforeAll(async () => {
        // Create a metric specifically for update tests
        const data = {
          name: `Metric To Update ${Date.now()}`,
          eventName: originalEventName,
          aggregationType: "MAX" as const,
          valueType: "NUMERIC" as const,
          description: "Original description",
        };
        const res = await client.metrics.$post({
          json: data,
        });
        const resJson = await res.json();
        if ("error" in resJson) {
          throw new Error(
            `metricToUpdate creation failed: ${JSON.stringify(resJson)}`
          );
        }
        // Parse dates before assigning
        metricToUpdate = {
          ...resJson,
          createdAt: new Date(resJson.createdAt),
          updatedAt: new Date(resJson.updatedAt),
        } as MetricDefinitionResponse;
        cleanupMetricIds.push({
          id: metricToUpdate.id,
          eventName: updatedEventName,
        }); // Add with final name for cleanup
        cleanupMetricIds.push({
          id: metricToUpdate.id,
          eventName: originalEventName,
        }); // Add original too, just in case update fails
      });

      it("should update metric name and description", async () => {
        const updates = {
          name: `Updated Metric Name ${Date.now()}`,
          description: "Updated description",
        };

        const response = await client.metrics[":id"].update.$post({
          param: { id: metricToUpdate.id },
          json: updates,
        });
        expect(response.status).toBe(200);

        const responseData = await response.json();
        if ("error" in responseData) {
          throw new Error(`Update failed: ${responseData.error}`);
        }
        const updatedMetric = {
          ...responseData,
          createdAt: new Date(responseData.createdAt),
          updatedAt: new Date(responseData.updatedAt),
        } as MetricDefinitionResponse;
        expect(updatedMetric.name).toBe(updates.name);
        expect(updatedMetric.description).toBe(updates.description);
        expect(updatedMetric.eventName).toBe(originalEventName); // Should not change yet

        // Verify in Postgres
        const dbMetric = await db.query.metrics.findFirst({
          where: eq(metrics.id, metricToUpdate.id),
        });
        expect(dbMetric?.name).toBe(updates.name);
        expect(dbMetric?.description).toBe(updates.description);

        // Verify in Redis
        const redisDef = await getRedisMetricDef(
          testMerchantId,
          metricToUpdate.id
        );
        expect(redisDef?.name).toBe(updates.name);
        expect(redisDef?.description).toBe(updates.description);
      });

      it("should update metric eventName and reflect in Redis index", async () => {
        const updates = {
          eventName: updatedEventName,
        };

        // Check original Redis state
        const initialEventMetrics = await getRedisMetricsForEvent(
          testMerchantId,
          originalEventName
        );
        expect(initialEventMetrics).toContain(metricToUpdate.id);
        const updatedEventMetricsBefore = await getRedisMetricsForEvent(
          testMerchantId,
          updatedEventName
        );
        expect(updatedEventMetricsBefore).not.toContain(metricToUpdate.id);

        const response = await client.metrics[":id"].update.$post({
          param: { id: metricToUpdate.id },
          json: updates,
        });
        expect(response.status).toBe(200);

        const responseData = await response.json();
        if ("error" in responseData) {
          throw new Error(`Update failed: ${responseData.error}`);
        }
        const updatedMetric = {
          ...responseData,
          createdAt: new Date(responseData.createdAt),
          updatedAt: new Date(responseData.updatedAt),
        } as MetricDefinitionResponse;
        expect(updatedMetric.eventName).toBe(updatedEventName);

        // Verify in Postgres
        const dbMetric = await db.query.metrics.findFirst({
          where: eq(metrics.id, metricToUpdate.id),
        });
        expect(dbMetric?.eventName).toBe(updatedEventName);

        // Verify in Redis Definition
        const redisDef = await getRedisMetricDef(
          testMerchantId,
          metricToUpdate.id
        );
        expect(redisDef?.eventName).toBe(updatedEventName);

        // Verify Redis Index Update
        const finalOriginalEventMetrics = await getRedisMetricsForEvent(
          testMerchantId,
          originalEventName
        );
        expect(finalOriginalEventMetrics).not.toContain(metricToUpdate.id);
        const finalUpdatedEventMetrics = await getRedisMetricsForEvent(
          testMerchantId,
          updatedEventName
        );
        expect(finalUpdatedEventMetrics).toContain(metricToUpdate.id);

        // Update metricToUpdate for subsequent tests if needed
        metricToUpdate.eventName = updatedEventName;
      });

      it("should not allow updating aggregationType via update", async () => {
        // The update endpoint schema should prevent sending these.
        const updates = {
          aggregationType: "COUNT" as const,
        };

        const response = await client.metrics[":id"].update.$post({
          param: { id: metricToUpdate.id },
          json: updates as any, // Use 'as any' because schema should forbid these fields
        });
        // Expect validation error because these fields are immutable or not allowed in update schema
        expect([400, 422]).toContain(response.status);
      });

      it("should return 404 when trying to update a non-existent metric", async () => {
        const fakeId = createId();
        const updates = { name: "Doesn't Matter" };
        const response = await client.metrics[":id"].update.$post({
          param: { id: fakeId },
          json: updates,
        });
        expect(response.status).toBe(404);
      });
    });

    describe("POST /metrics/:id/delete", () => {
      let metricToDelete: MetricDefinitionResponse;
      const eventNameForDelete = "delete.test.event";

      beforeEach(async () => {
        // Create a fresh metric before each delete test
        const data = {
          name: `Metric To Delete ${Date.now()}`,
          eventName: eventNameForDelete,
          aggregationType: "COUNT" as const,
          valueType: "NUMERIC" as const,
        };
        const res = await client.metrics.$post({
          json: data,
        });
        const resJson = await res.json();
        if ("error" in resJson) {
          throw new Error(
            `metricToDelete creation failed: ${JSON.stringify(resJson)}`
          );
        }
        // Parse dates before assigning
        metricToDelete = {
          ...resJson,
          createdAt: new Date(resJson.createdAt),
          updatedAt: new Date(resJson.updatedAt),
        } as MetricDefinitionResponse;
        // No need to add to cleanupMetricIds here, as successful delete removes it
      });

      it("should delete a metric successfully and remove from DB and Redis", async () => {
        // Verify it exists before delete
        const dbMetricBefore = await db.query.metrics.findFirst({
          where: eq(metrics.id, metricToDelete.id),
        });
        expect(dbMetricBefore).toBeDefined();
        const redisDefBefore = await getRedisMetricDef(
          testMerchantId,
          metricToDelete.id
        );
        expect(redisDefBefore).not.toBeNull();
        const redisEventMetricsBefore = await getRedisMetricsForEvent(
          testMerchantId,
          eventNameForDelete
        );
        expect(redisEventMetricsBefore).toContain(metricToDelete.id);

        // Perform the delete using POST
        const response = await client.metrics[":id"].delete.$post({
          param: { id: metricToDelete.id },
        });
        expect(response.status).toBe(204); // Expect No Content on successful delete

        // Verify removal from Postgres (or check for deletedAt timestamp if soft delete)
        // Soft delete based on implementation
        const dbMetricAfter = await db.query.metrics.findFirst({
          where: eq(metrics.id, metricToDelete.id),
        });
        expect(dbMetricAfter).toBeDefined();
        expect(dbMetricAfter?.deletedAt).toBeDefined();
        expect(dbMetricAfter?.deletedAt).toBeInstanceOf(Date);

        // Verify removal from Redis Definition
        const redisDefAfter = await getRedisMetricDef(
          testMerchantId,
          metricToDelete.id
        );
        // Check if the hash is empty or non-existent
        expect(Object.keys(redisDefAfter || {}).length).toBe(0);

        // Verify removal from Redis Event Index
        const redisEventMetricsAfter = await getRedisMetricsForEvent(
          testMerchantId,
          eventNameForDelete
        );
        expect(redisEventMetricsAfter).not.toContain(metricToDelete.id);
      });

      it("should return 404 when trying to delete a non-existent metric", async () => {
        const fakeId = createId();
        const response = await client.metrics[":id"].delete.$post({
          param: { id: fakeId },
        });
        expect(response.status).toBe(404);
      });

      // Add cleanup for the metric created in beforeEach if the delete test itself failed
      afterEach(async () => {
        if (metricToDelete) {
          try {
            // Attempt hard delete, assuming it might have failed in the test
            await db.delete(metrics).where(eq(metrics.id, metricToDelete.id));
            const redisClient = await getRedisClient();
            if (redisClient) {
              await redisClient.del(
                `metric_def:${testMerchantId}:${metricToDelete.id}`
              );
              await redisClient.sRem(
                `metrics_for_event:${testMerchantId}:${eventNameForDelete}`,
                metricToDelete.id
              );
            }
          } catch (err) {
            // Ignore cleanup errors here, main afterAll will catch stragglers
          }
        }
      });
    });
  });

  // 2. Metric Value Retrieval Tests
  describe("Metric Value Retrieval", () => {
    let metricIds: { [key: string]: MetricDefinitionResponse } = {};

    beforeAll(async () => {
      // Create base metrics needed for tests
      const metricsToCreate: {
        key: string;
        eventName: string;
        aggregationType: MetricAggregationType;
        valueType?: ValueType;
      }[] = [
        {
          key: "countMetric",
          eventName: `test.value.count.${createId()}`,
          aggregationType: "COUNT",
          valueType: "NUMERIC",
        },
        {
          key: "sumMetric",
          eventName: `test.value.sum.${createId()}`,
          aggregationType: "SUM",
          valueType: "NUMERIC",
        },
        {
          key: "maxMetric",
          eventName: `test.value.max.${createId()}`,
          aggregationType: "MAX",
          valueType: "NUMERIC",
        },
        {
          key: "minMetric",
          eventName: `test.value.min.${createId()}`,
          aggregationType: "MIN",
          valueType: "NUMERIC",
        },
        {
          key: "setMetric",
          eventName: `test.value.set.${createId()}`,
          aggregationType: "UNIQUE_COUNT",
          valueType: "STRING",
        },
      ];

      for (const m of metricsToCreate) {
        // Create the metrics
        const createdMetric = await createTestMetric({
          merchantId: testMerchantId,
          name: `${m.key} Test`,
          eventName: m.eventName,
          aggregationType: m.aggregationType,
          valueType: m.valueType,
        });
        metricIds[m.key] = createdMetric;
        cleanupMetricIds.push({
          id: createdMetric.id,
          eventName: createdMetric.eventName!,
        });
      }

      // Generate test events for each metric type
      // COUNT events - just need 5 events with no special properties
      await createTestEvents(
        testMerchantId,
        testCustomerId,
        metricIds.countMetric.eventName!,
        5
      );

      // SUM events - need 3 events with numeric values
      await createTestEvents(
        testMerchantId,
        testCustomerId,
        metricIds.sumMetric.eventName!,
        3,
        [
          { name: "value", value: 10 },
          { name: "value", value: 20 },
          { name: "value", value: 30 },
        ]
      );

      // MAX events - need values with a clear maximum (50)
      await createTestEvents(
        testMerchantId,
        testCustomerId,
        metricIds.maxMetric.eventName!,
        3,
        [
          { name: "value", value: 30 },
          { name: "value", value: 50 },
          { name: "value", value: 10 },
        ]
      );

      // MIN events - need values with a clear minimum (5)
      await createTestEvents(
        testMerchantId,
        testCustomerId,
        metricIds.minMetric.eventName!,
        3,
        [
          { name: "value", value: 15 },
          { name: "value", value: 25 },
          { name: "value", value: 5 },
        ]
      );

      // SET events - need events with unique values to count
      await createTestEvents(
        testMerchantId,
        testCustomerId,
        metricIds.setMetric.eventName!,
        4,
        [
          { name: "userId", value: "user1" },
          { name: "userId", value: "user2" },
          { name: "userId", value: "user3" },
          { name: "userId", value: "user1" }, // Duplicate to test SET behavior
        ]
      );
    });

    it("should retrieve the correct value for a COUNT metric", async () => {
      const metric = metricIds.countMetric;
      const response = await client.metrics[":id"].value.$get({
        param: { id: metric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();

      if ("error" in data) throw new Error(data.error);

      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: metric.eventName!,
        aggregation: "COUNT",
        valueType: "NUMERIC",
        timeframe: { type: "ALL" },
      });

      expect(data.id).toBe(metric.id);
      expect(data.name).toContain("countMetric");
      expect(data.value).toBe(5);
      expect(result.value).not.toBeNull();
      if (result.value !== null) {
        expect(data.value).toBe(result.value as number);
      }
    });

    it("should retrieve the correct value for a SUM metric", async () => {
      const metric = metricIds.sumMetric;
      const response = await client.metrics[":id"].value.$get({
        param: { id: metric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();

      if ("error" in data) throw new Error(data.error);

      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: metric.eventName!,
        aggregation: "SUM",
        valueType: "NUMERIC",
        timeframe: { type: "ALL" },
      });

      expect(data.id).toBe(metric.id);
      expect(data.name).toContain("sumMetric");
      expect(data.value).toBe(60);
      expect(result.value).not.toBeNull();
      if (result.value !== null) {
        expect(data.value).toBe(result.value as number);
      }
    });

    it("should retrieve the correct value for a MAX metric", async () => {
      const metric = metricIds.maxMetric;
      const response = await client.metrics[":id"].value.$get({
        param: { id: metric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();

      if ("error" in data) throw new Error(data.error);

      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: metric.eventName!,
        aggregation: "MAX",
        valueType: "NUMERIC",
        timeframe: { type: "ALL" },
      });

      expect(data.id).toBe(metric.id);
      expect(data.name).toContain("maxMetric");
      expect(data.value).toBe(50);
      expect(result.value).not.toBeNull();
      if (result.value !== null) {
        expect(data.value).toBe(result.value as number);
      }
    });

    it("should retrieve the correct value for a MIN metric", async () => {
      const metric = metricIds.minMetric;
      const response = await client.metrics[":id"].value.$get({
        param: { id: metric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();

      if ("error" in data) throw new Error(data.error);

      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: metric.eventName!,
        aggregation: "MIN",
        valueType: "NUMERIC",
        timeframe: { type: "ALL" },
      });

      expect(data.id).toBe(metric.id);
      expect(data.name).toContain("minMetric");
      expect(data.value).toBe(5);
      expect(result.value).not.toBeNull();
      if (result.value !== null) {
        expect(data.value).toBe(result.value as number);
      }
    });

    it("should retrieve the correct value for a UNIQUE_COUNT metric", async () => {
      const metric = metricIds.setMetric;
      const response = await client.metrics[":id"].value.$get({
        param: { id: metric.id },
        query: { customerId: testCustomerId },
      });
      expect(response.status).toBe(200);
      const data = await response.json();

      if ("error" in data) throw new Error(data.error);

      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: metric.eventName!,
        aggregation: "UNIQUE_COUNT",
        valueType: "STRING",
        timeframe: { type: "ALL" },
      });

      expect(data.id).toBe(metric.id);
      expect(data.name).toContain("setMetric");
      expect(data.value).toBe(3);
      expect(result.value).not.toBeNull();
      if (result.value !== null) {
        expect(data.value).toBe(result.value as number);
      }
    });

    it("should return 0 for a metric with no events", async () => {
      // Create a new metric specifically for this test
      const newMetricEventName = `test.value.empty.${createId()}`;
      const emptyMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Empty Metric Test",
        eventName: newMetricEventName,
        aggregationType: "COUNT",
        valueType: "NUMERIC",
      });
      cleanupMetricIds.push({
        id: emptyMetric.id,
        eventName: emptyMetric.eventName!,
      });

      // Verify value is 0 (or default) without sending events
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: emptyMetric.eventName!,
        aggregation: "COUNT",
        valueType: "NUMERIC",
        timeframe: { type: "ALL" },
      });

      expect(result.value).toBe(0);

      // Also test UNIQUE_COUNT metric cardinality directly
      const emptySetMetricEventName = `test.value.empty.set.${createId()}`;
      const emptySetMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Empty Set Metric Test",
        eventName: emptySetMetricEventName,
        aggregationType: "UNIQUE_COUNT",
        valueType: "STRING",
      });
      cleanupMetricIds.push({
        id: emptySetMetric.id,
        eventName: emptySetMetric.eventName!,
      });

      const cardinality = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: emptySetMetric.eventName!,
        aggregation: "UNIQUE_COUNT",
        valueType: "STRING",
        timeframe: { type: "ALL" },
      });
      expect(cardinality.value).toBe(0);
    });

    it("should handle metric UNIQUE_COUNT with missing properties correctly", async () => {
      const freshMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Missing SET Metric Test",
        eventName: `test.value.set.missing.${createId()}`,
        aggregationType: "UNIQUE_COUNT",
        valueType: "STRING",
      });
      cleanupMetricIds.push({
        id: freshMetric.id,
        eventName: freshMetric.eventName!,
      });

      // 1) Send an event missing the required property (eventString)
      const missingEventId = `set-missing-${createId()}`;
      const missingPayload = {
        eventName: freshMetric.eventName!,
        customerId: testCustomerId,
        subscriptionId: subscriptionId,
        eventValue: 1,
        idempotencyKey: missingEventId,
        properties: {},
        eventTimestamp: new Date().toISOString(),
      };
      const missingResp = await client.events.$post({ json: missingPayload });
      expect(missingResp.status).toBe(202);
      const persistedMissing = await waitForEvent(
        missingEventId,
        testMerchantId
      );
      expect(persistedMissing).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const cardAfterMissing = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: freshMetric.eventName!,
        aggregation: "UNIQUE_COUNT",
        valueType: freshMetric.valueType!,
        timeframe: { type: "ALL" },
      });
      expect(cardAfterMissing.value).toBe(0);

      // 2) Send a valid event with the property present
      const validUser = `user-valid-${createId()}`;
      const validEventId = `set-valid-${createId()}`;
      const validPayload = {
        eventName: freshMetric.eventName!,
        eventString: validUser,
        customerId: testCustomerId,
        subscriptionId: subscriptionId,
        idempotencyKey: validEventId,
        eventTimestamp: new Date().toISOString(),
      };
      const validResp = await client.events.$post({ json: validPayload });
      expect(validResp.status).toBe(202);
      const persistedValid = await waitForEvent(validEventId, testMerchantId);
      expect(persistedValid).toBe(true);

      const cardAfterValid = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: freshMetric.eventName!,
        aggregation: "UNIQUE_COUNT",
        valueType: freshMetric.valueType!,
        timeframe: { type: "ALL" },
      });
      expect(cardAfterValid.value).toBe(1);
    });

    // TESTTODO: Add proper tests for time window constraints
    it("should support time-constrained queries for metrics", async () => {
      // Create a metric for time window testing
      const timeWindowMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Time Window Test Metric",
        eventName: `test.timewindow.${createId()}`,
        aggregationType: "COUNT",
        valueType: "NUMERIC",
      });
      cleanupMetricIds.push({
        id: timeWindowMetric.id,
        eventName: timeWindowMetric.eventName!,
      });

      // Send a few events with different timestamps
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // This is a placeholder test - just check that the capability exists
      // TESTTODO: Implement comprehensive time window tests with actual event data
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        metricType: "simple",
        eventName: timeWindowMetric.eventName!,
        aggregation: "COUNT",
        valueType: "NUMERIC",
        timeframe: {
          type: "ABSOLUTE",
          start: oneHourAgo,
          end: now,
        },
      });

      // Just verify the query doesn't throw an error
      expect(result).toBeDefined();
      expect(typeof result.value).toBe("number");
    });

    // TESTTODO: Add proper tests for non-existent metrics
    it("should handle retrieving values for non-existent metrics", async () => {
      const fakeMetricId = createId();

      // Test the API endpoint for a non-existent metric
      const response = await client.metrics[":id"].value.$get({
        param: { id: fakeMetricId },
        query: { customerId: testCustomerId },
      });

      // Expect appropriate error response (404 Not Found)
      expect(response.status).toBe(404);

      // TESTTODO: Add specific assertions based on your API's error handling behavior
    });

    // TESTTODO: Add proper tests for different customer IDs
    it("should properly isolate metric values between different customers", async () => {
      // Create another test customer
      const secondCustomer = await createTestCustomer({
        merchantId: testMerchantId,
        name: "Second Test Customer",
        email: `second_customer_${Date.now()}@example.com`,
      });

      // Create a test metric
      const multiCustomerMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Multi-Customer Test Metric",
        eventName: `test.multicustomer.${createId()}`,
        aggregationType: "COUNT",
        valueType: "NUMERIC",
      });
      cleanupMetricIds.push({
        id: multiCustomerMetric.id,
        eventName: multiCustomerMetric.eventName!,
      });

      // TESTTODO: Send events for different customers and verify isolation
      // This placeholder just verifies that customer-specific queries don't error
      const result = await questDbService.queryMetrics({
        merchantId: testMerchantId,
        customerId: secondCustomer.id, // Use the second customer ID
        metricType: "simple",
        eventName: multiCustomerMetric.eventName!,
        aggregation: "COUNT",
        valueType: "NUMERIC",
        timeframe: { type: "ALL" },
      });

      expect(result).toBeDefined();
      expect(typeof result.value).toBe("number");
      // Since no events were sent, expect the value to be 0
      expect(result.value).toBe(0);
    });
  });

  // 3. Redis Cache Management Tests
  describe("Redis Cache Management", () => {
    // Helper type for the Redis metric definition hash
    type RedisMetricDef = {
      id?: string;
      merchantId?: string;
      name?: string;
      description?: string;
      queryType?: "simple" | "indexed" | "complex";
      aggregationType?: MetricAggregationType | null;
      eventName?: string | null;
      valueType?: ValueType;
      sqlDefinition?: string | null;
    };

    // Helper functions
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

    beforeEach(async () => {
      // Clear Redis between tests
      await clearRedisMetricsCache();

      // Ensure Redis is connected
      if (!redis.isReady) {
        redis = await getRedisClient();
      }
    });

    describe("Bootstrap and Reconciliation", () => {
      it("should successfully bootstrap definitions from Postgres to Redis", async () => {
        // Create a test metric (will insert into PG)
        const metric = await createTestMetric({
          merchantId: testMerchantId,
          name: "Bootstrap Test",
          eventName: "bootstrap.test",
          aggregationType: "SUM", // requires NUMERIC valueType (default)
        });
        cleanupMetricIds.push({
          id: metric.id,
          eventName: metric.eventName || "",
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
        expect(cachedMetric?.valueType).toBe("NUMERIC");
        expect(cachedMetric).not.toHaveProperty("propertyName");
      });

      it("should detect and fix missing metric definitions in Redis via reconciliation", async () => {
        // Create a test metric
        const metric = await createTestMetric({
          merchantId: testMerchantId,
          name: "Missing Metric Test",
          eventName: "missing.metric.test",
          aggregationType: "COUNT", // requires NUMERIC valueType (default)
        });
        cleanupMetricIds.push({
          id: metric.id,
          eventName: metric.eventName || "",
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
        const cachedAfterFix = await getRedisMetricDef(
          testMerchantId,
          metric.id
        );
        expect(cachedAfterFix).not.toBeNull();
        const cachedMetric = cachedAfterFix as RedisMetricDef;
        expect(cachedMetric?.name).toBe(metric.name);
        expect(cachedMetric?.aggregationType).toBe("COUNT");
        expect(cachedMetric?.valueType).toBe("NUMERIC");
        expect(cachedMetric).not.toHaveProperty("propertyName");
      });

      it("should handle both missing defs and extraneous defs in Redis via reconciliation", async () => {
        // 1. Create two metrics in PG
        const metricToKeep = await createTestMetric({
          merchantId: testMerchantId,
          name: "Metric To Keep",
          eventName: "keep.test.event",
          aggregationType: "MAX", // NUMERIC
        });
        cleanupMetricIds.push({
          id: metricToKeep.id,
          eventName: metricToKeep.eventName || "",
        });

        const metricToDeleteFromPg = await createTestMetric({
          merchantId: testMerchantId,
          name: "Metric To Delete From PG",
          eventName: "delete.pg.event",
          aggregationType: "MIN", // NUMERIC
        });
        cleanupMetricIds.push({
          id: metricToDeleteFromPg.id,
          eventName: metricToDeleteFromPg.eventName || "",
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
        cleanupMetricIds.splice(
          cleanupMetricIds.findIndex((m) => m.id === metricToDeleteFromPg.id),
          1
        );

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
            (await getRedisMetricDef(
              testMerchantId,
              metricToDeleteFromPg.id
            )) || {}
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

    describe("Redis Reconnect Handling", () => {
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
        const metric = await createTestMetric({
          merchantId: testMerchantId,
          name: "Reconnect Helper Test",
          eventName: "reconnect.helper.test",
          aggregationType: "COUNT",
        });
        cleanupMetricIds.push({
          id: metric.id,
          eventName: metric.eventName || "",
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
        const metric = await createTestMetric({
          merchantId: testMerchantId,
          name: "Bootstrap Reconnect Test",
          eventName: "bootstrap.reconnect.test",
          aggregationType: "SUM",
        });
        cleanupMetricIds.push({
          id: metric.id,
          eventName: metric.eventName || "",
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
        const metric = await createTestMetric({
          merchantId: testMerchantId,
          name: "Reconcile Disconnect Test",
          eventName: "reconcile.disconnect.test",
          aggregationType: "UNIQUE_COUNT",
          valueType: "STRING",
        });
        cleanupMetricIds.push({
          id: metric.id,
          eventName: metric.eventName || "",
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

  // 4. Concurrency and Error Handling Tests
  describe("Concurrency, Errors, and History", () => {
    describe("Atomic updates under concurrent events", () => {
      it("should correctly aggregate COUNT metric with concurrent event submissions", async () => {
        // Create a COUNT metric for this test
        const metric = await createTestMetric({
          merchantId: testMerchantId,
          aggregationType: "COUNT",
          eventName: `concurrent.count.event.${Date.now()}`,
        });
        cleanupMetricIds.push({
          id: metric.id,
          eventName: metric.eventName!,
        });

        // Prepare concurrent event payloads
        const totalEvents = 10;
        const events = Array.from({ length: totalEvents }, (_, i) => ({
          eventName: metric.eventName!,
          customerId: testCustomerId,
          subscriptionId: subscriptionId,
          eventValue: 1,
          properties: { index: i },
          idempotencyKey: `conc-${createId()}-${i}`,
          eventTimestamp: new Date(),
        }));

        // Send all events concurrently
        const responses = await Promise.all(
          events.map((ev) => {
            // Ensure eventName is a string and eventTimestamp is ISO string
            return client.events.$post({
              json: {
                ...ev,
                eventName: ev.eventName || "",
                eventTimestamp: ev.eventTimestamp.toISOString(),
              },
            });
          })
        );
        // All should be accepted
        for (const res of responses) {
          expect(res.status).toBe(202);
        }

        // Poll the metric-value endpoint until it reports the expected count
        let seen: number | null = null;
        const deadline = Date.now() + 12_000; // 12s ceiling
        while (Date.now() < deadline) {
          const valRes = await client.metrics[":id"].value.$get({
            param: { id: metric.id },
            query: { customerId: testCustomerId },
          });
          expect(valRes.status).toBe(200);
          const valData = await valRes.json();
          if ("error" in valData) {
            throw new Error(`Value fetch failed: ${valData.error}`);
          }
          if (valData.value === totalEvents) {
            seen = valData.value;
            break;
          }
          // short delay before retry
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(seen).toBe(totalEvents);
      }, 15000);
    });

    describe("Recovery from Redis failures during idempotency", () => {
      it("should accept event and update metrics even if Redis SET fails", async () => {
        // Create a COUNT metric for this test
        const metric = await createTestMetric({
          merchantId: testMerchantId,
          aggregationType: "COUNT",
          eventName: `redis.failure.event.${Date.now()}`,
        });
        cleanupMetricIds.push({
          id: metric.id,
          eventName: metric.eventName!,
        });

        // Stub Redis SET to throw error once on the shared client instance
        const redisModule = await import("../../src/lib/redis");
        const redisClient = await redisModule.getRedisClient();
        const origSet = redisClient.set;
        let failOnce = true;
        // Override set method to simulate failure on first call
        // @ts-ignore
        redisClient.set = async (...args: any[]) => {
          if (failOnce) {
            failOnce = false;
            throw new Error("Simulated Redis failure");
          }
          // @ts-ignore: ignore apply signature mismatch
          return origSet.apply(redisClient, args);
        };
        try {
          // Send a single event which will hit the stubbed Redis.SET
          const eventPayload = {
            eventName: metric.eventName || "",
            customerId: testCustomerId,
            subscriptionId: subscriptionId,
            eventValue: 1,
            eventTimestamp: new Date().toISOString(),
            properties: {},
            idempotencyKey: `evt-${createId()}`,
          };
          const res = await client.events.$post({ json: eventPayload });
          expect(res.status).toBe(202);

          // Despite Redis failure, metrics should be updated
          const valRes = await client.metrics[":id"].value.$get({
            param: { id: metric.id },
            query: { customerId: testCustomerId },
          });
          expect(valRes.status).toBe(200);
          const valData = await valRes.json();
          if ("error" in valData) {
            throw new Error(`Value fetch failed: ${valData.error}`);
          }
          expect(valData.value).toBe(1);
        } finally {
          // Restore original Redis SET method
          // @ts-ignore
          redisClient.set = origSet;
        }
      });
    });

    describe("Metric Calculation from Historical Data", () => {
      it("should correctly calculate metric value from previously ingested events", async () => {
        const eventName = `history.calc.event.${Date.now()}`;

        // Ingest historical events via API first
        await createTestEvents(
          testMerchantId,
          testCustomerId,
          eventName,
          2 // Number of events
        );

        // Allow time for ingestion
        await new Promise((res) => setTimeout(res, 500));

        // Create metric *after* events are ingested (no backfill needed)
        const createRes = await client.metrics.$post({
          json: {
            name: `History Calc Metric ${Date.now()}`,
            eventName,
            aggregationType: "COUNT" as MetricAggregationType,
            valueType: "NUMERIC" as ValueType,
          },
          // query: { backfill: false }, // Backfill flag removed
        });
        expect(createRes.status).toBe(201);
        const created = await createRes.json();
        if ("error" in created)
          throw new Error(`Metric creation failed: ${created.error}`);
        cleanupMetricIds.push({ id: created.id, eventName });

        // Verify via GET value endpoint (queries QuestDB)
        const valRes = await client.metrics[":id"].value.$get({
          param: { id: created.id },
          query: { customerId: testCustomerId },
        });
        expect(valRes.status).toBe(200);
        const valData = await valRes.json();
        if ("error" in valData)
          throw new Error(`Value fetch failed: ${valData.error}`);

        // Value should reflect the 2 events ingested earlier
        expect(valData.value).toBe(2);
      });
    });
  });

  // 5. Metric Backfill Tests (Note: Minimal with QuestDB)
  describe("Metric Backfill", () => {
    let backfillMetric: any;

    beforeAll(async () => {
      // Create a test metric
      backfillMetric = await createTestMetric({
        merchantId: testMerchantId,
        name: "Test Backfill Metric",
        eventName: `test.backfill.${createId()}`,
        aggregationType: "SUM",
        valueType: "NUMERIC",
      });

      // Add to cleanup list
      cleanupMetricIds.push({
        id: backfillMetric.id,
        eventName: backfillMetric.eventName || "",
      });

      // Generate test events that we'll query later
      await createTestEvents(
        testMerchantId,
        testCustomerId,
        backfillMetric.eventName,
        3,
        [
          { name: "amount", value: 10 },
          { name: "amount", value: 20 },
          { name: "amount", value: 30 },
        ]
      );
    });
  });
});
