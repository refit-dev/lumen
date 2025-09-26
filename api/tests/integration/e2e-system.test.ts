import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  invoices,
  invoiceLineItems,
  subscriptionDetails,
  subscriptions,
  subscriptionsScheduledChanges,
  subscriptionFeatures,
  customers,
  plans,
  planFeatures,
  stripe as stripeSchema,
  paymentMethods,
  payments,
  events as eventsSchema,
  user,
  featureMetrics,
  features,
  prices,
  metrics,
  organization,
  pricingTables,
  pricingTablePlans,
  creditDefinitions,
  creditGrants,
  creditUsageTransactions,
  billingTasks,
} from "@lumen/common/schema";
import {
  createFullTestEnvironment,
  createTestCustomer,
  createAuthenticatedClient,
  createTestPlanWithFeatures,
  createTestPrice,
  createBasicSubscription,
  queryQuestDbDirectly,
  clearEventData,
} from "../test-helpers";
import { createTestUsageCreditDefinition } from "../test-helpers/data/credits";
import { processInitialCreditsForSubscription } from "../../src/helpers/credits";
import type { ClientType } from "../test-helpers/api/client";
import { db } from "../../src/db/client";
import { AggregationType as MetricAggregationType } from "@lumen/common/schema";
import { and, eq, sql, desc, isNull } from "drizzle-orm";
import { getRedisClient } from "../../src/lib/redis";
import { verifyNoMetricData } from "../test-helpers/test-utils/questdb-helpers";
import questDbService from "../../src/db/questDbService";
import { env } from "../../src/env";
import { logger } from "../../src/helpers/logging";

describe("End-to-End System Tests", () => {
  let client: ClientType;
  let testMerchantId: string;
  let testCustomerId: string;
  let testSubscriptionId: string; // stable subscription id (public-facing)
  let testSubscriptionInternalId: string; // internal primary key id
  let testPlanId: string;
  let testPriceId: string;
  let cleanupMetricIds: { id: string; eventName: string }[] = [];

  beforeAll(async () => {
    // Initialize QuestDB
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
      logger.info("QuestDB initialized successfully for e2e-system.test.ts");
    } catch (error) {
      logger.error(
        "Failed to initialize QuestDB for e2e-system.test.ts:",
        error
      );
      throw error;
    }

    // Setup merchant and user
    const { user, merchant } = await createFullTestEnvironment({
      createPlan: false,
    });
    testMerchantId = merchant.id;

    // Clear existing event data to start fresh
    await clearEventData();

    // Create customer
    const customer = await createTestCustomer({
      merchantId: testMerchantId,
      name: "E2E Test Customer",
      email: `e2e_test_${Date.now()}@example.com`,
    });
    testCustomerId = customer.id;

    // Authenticated client
    client = await createAuthenticatedClient(user.email, user.password);

    // Create plan (no features needed) and price
    const planResult = await createTestPlanWithFeatures(testMerchantId, [], {
      stablePlanId: `e2e-plan-${Date.now()}`,
      versionNumber: 1,
      planName: "E2E Test Plan",
    });
    testPlanId = planResult.plan.id;
    const price = await createTestPrice({
      planId: testPlanId,
      merchantId: testMerchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Base Fee",
            amount_cents: 0,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    testPriceId = price.id;

    // Create subscription via API
    const subResp = await client.subscriptions.$post({
      json: {
        customerId: testCustomerId,
        planId: testPlanId,
        effectivePriceId: testPriceId,
      },
    });
    const subBody = await subResp.json();
    if (subResp.status !== 201 || "error" in subBody) {
      throw new Error(
        `Subscription creation failed: ${JSON.stringify(subBody)}`
      );
    }
    // Store both stable and internal subscription ids
    testSubscriptionId = subBody.subscription?.stableSubscriptionId || "";
    testSubscriptionInternalId = subBody.subscription?.id || "";
  });

  afterAll(async () => {
    // Clean up persisted events using clearEventData
    await clearEventData();

    // Verify QuestDB data is clean
    await verifyNoMetricData(testMerchantId);

    // Close QuestDB connection
    logger.info("Closing QuestDB service for e2e-system.test.ts...");
    try {
      await questDbService.close();
      logger.info(
        "QuestDB service closed successfully for e2e-system.test.ts."
      );
    } catch (error) {
      logger.error(
        "Failed to close QuestDB for e2e-system.test.ts:",
        error instanceof Error ? error.message : String(error)
      );
    }

    const cleanupQuery = sql`
      DELETE FROM ${creditUsageTransactions};
      DELETE FROM ${creditGrants};
      DELETE FROM ${creditDefinitions};
      DELETE FROM ${payments};
      DELETE FROM ${invoiceLineItems};
      DELETE FROM ${invoices};
      DELETE FROM ${billingTasks};
      DELETE FROM ${subscriptionsScheduledChanges};
      DELETE FROM ${subscriptionFeatures};
      DELETE FROM ${subscriptionDetails};
      DELETE FROM ${metrics};
      DELETE FROM ${eventsSchema};
      DELETE FROM ${subscriptions};
      DELETE FROM ${paymentMethods};
      DELETE FROM ${prices};
      DELETE FROM ${planFeatures};
      DELETE FROM ${features};
      DELETE FROM ${featureMetrics};
      DELETE FROM ${pricingTablePlans};
      DELETE FROM ${pricingTables};
      DELETE FROM ${plans};
      DELETE FROM ${customers};
      DELETE FROM ${user};
      DELETE FROM ${organization};
  `;
    await db.execute(cleanupQuery);
  });

  describe("Mixed Event Patterns", () => {
    beforeEach(async () => {
      // Clear event data before each test
      await clearEventData();
    });

    it("should update only matching metrics for different event types", async () => {
      // Create two COUNT metrics via API
      const metricAResponse = await client.metrics.$post({
        json: {
          name: "Count A",
          aggregationType: "COUNT" as MetricAggregationType,
          eventName: "event.A",
          valueType: "NUMERIC",
          queryType: "simple",
        },
      });
      expect(metricAResponse.status).toBe(201);
      const metricAData = await metricAResponse.json();
      if ("error" in metricAData) {
        throw new Error(
          `Failed to create metric A: ${JSON.stringify(metricAData)}`
        );
      }
      const metricAId = metricAData.id;
      cleanupMetricIds.push({ id: metricAId, eventName: "event.A" });

      const metricBResponse = await client.metrics.$post({
        json: {
          name: "Count B",
          aggregationType: "COUNT" as MetricAggregationType,
          eventName: "event.B",
          valueType: "NUMERIC",
          queryType: "simple",
        },
      });
      expect(metricBResponse.status).toBe(201);
      const metricBData = await metricBResponse.json();
      if ("error" in metricBData) {
        throw new Error(
          `Failed to create metric B: ${JSON.stringify(metricBData)}`
        );
      }
      const metricBId = metricBData.id;
      cleanupMetricIds.push({ id: metricBId, eventName: "event.B" });

      // Post events for event.A via API
      const eventAResults: unknown[] = [];
      for (let i = 0; i < 2; i++) {
        const eventAResponse = await client.events.$post({
          json: {
            eventName: "event.A",
            customerId: testCustomerId,
            eventValue: i,
            idempotencyKey: `event-a-${i}-${Date.now()}`,
            eventTimestamp: new Date().toISOString(),
          },
        });
        expect(eventAResponse.status).toBe(202);
        const eventAResult = await eventAResponse.json();
        if ("error" in eventAResult) {
          throw new Error(
            `Failed to create event A: ${JSON.stringify(eventAResult)}`
          );
        }
        eventAResults.push(eventAResult);
      }

      // Post one event for event.B via API
      const eventBResponse = await client.events.$post({
        json: {
          eventName: "event.B",
          customerId: testCustomerId,
          eventValue: 0,
          idempotencyKey: `event-b-${Date.now()}`,
          eventTimestamp: new Date().toISOString(),
        },
      });
      expect(eventBResponse.status).toBe(202);

      // Allow time for QuestDB ingestion and PostgreSQL persistence
      await new Promise((res) => setTimeout(res, 3000));

      // Verify events are in QuestDB through a direct query
      const questResultA = await queryQuestDbDirectly(
        `SELECT COUNT(*) FROM events WHERE merchant_id = '${testMerchantId}' AND customer_id = '${testCustomerId}' AND event_name = 'event.A'`
      );

      // Extract count from questResultA
      expect(questResultA.rowCount).toBeGreaterThan(0);
      expect(
        Object.values(questResultA.rows[0]).some(
          (val) => val === 2 || Number(val) === 2
        )
      ).toBe(true);

      const questResultB = await queryQuestDbDirectly(
        `SELECT COUNT(*) FROM events WHERE merchant_id = '${testMerchantId}' AND customer_id = '${testCustomerId}' AND event_name = 'event.B'`
      );

      // Extract count from questResultB
      expect(questResultB.rowCount).toBeGreaterThan(0);
      expect(
        Object.values(questResultB.rows[0]).some(
          (val) => val === 1 || Number(val) === 1
        )
      ).toBe(true);

      // Verify COUNT for metric A using API
      const valA = await client.metrics[":id"].value.$get({
        param: { id: metricAId },
        query: { customerId: testCustomerId },
      });
      expect(valA.status).toBe(200);
      const jsonA = await valA.json();
      if ("error" in jsonA)
        throw new Error(
          `Metric value fetch A failed: ${JSON.stringify(jsonA)}`
        );
      expect(jsonA.value).toBe(2);

      // Verify COUNT for metric B using API
      const valB = await client.metrics[":id"].value.$get({
        param: { id: metricBId },
        query: { customerId: testCustomerId },
      });
      expect(valB.status).toBe(200);
      const jsonB = await valB.json();
      if ("error" in jsonB)
        throw new Error(
          `Metric value fetch B failed: ${JSON.stringify(jsonB)}`
        );
      expect(jsonB.value).toBe(1);

      // Verify events in PostgreSQL
      const pgEvents = await db.query.events.findMany({
        where: eq(eventsSchema.merchantId, testMerchantId),
      });

      // Should have 3 total events (2 for event.A, 1 for event.B)
      expect(pgEvents.length).toBe(3);
    });
  });

  describe("Auto-Backfill on New Definitions", () => {
    beforeEach(async () => {
      // Clear event data before each test
      await clearEventData();
    });

    it("should calculate metric value correctly from historical events", async () => {
      // Create unique event name
      const eventName = `hist.event.questdb.${Date.now()}`;

      // Send historical events via API
      const events = [
        {
          eventName: eventName,
          customerId: testCustomerId,
          eventValue: 5,
          idempotencyKey: `hist-event-1-${Date.now()}`,
          eventTimestamp: new Date().toISOString(),
        },
        {
          eventName: eventName,
          customerId: testCustomerId,
          eventValue: 10,
          idempotencyKey: `hist-event-2-${Date.now()}`,
          eventTimestamp: new Date().toISOString(),
        },
      ];

      // Send events
      for (const event of events) {
        const eventResponse = await client.events.$post({ json: event });
        expect(eventResponse.status).toBe(202);
      }

      // Allow time for QuestDB ingestion and PostgreSQL persistence
      await new Promise((res) => setTimeout(res, 3000));

      // Verify events are in QuestDB
      const query = `SELECT SUM(event_value) FROM events WHERE merchant_id = '${testMerchantId}' AND customer_id = '${testCustomerId}' AND event_name = '${eventName}'`;
      const questResult = await queryQuestDbDirectly(query);

      // Ensure we have our events
      expect(questResult.rowCount).toBeGreaterThan(0);

      // Extract the sum from the result
      const sum = Object.values(questResult.rows[0]).find(
        (val) =>
          val === 15 ||
          Number(val) === 15 ||
          (typeof val === "string" && Number(val) === 15)
      );

      // Verify sum directly from QuestDB
      expect(sum).toBeDefined();

      // Create SUM metric via API
      const createResp = await client.metrics.$post({
        json: {
          name: "Hist Sum QuestDB",
          aggregationType: "SUM" as MetricAggregationType,
          eventName: eventName,
          valueType: "NUMERIC",
          queryType: "simple",
        },
      });
      expect(createResp.status).toBe(201);
      const createData = await createResp.json();
      if ("error" in createData) {
        throw new Error(
          `Metric creation failed: ${JSON.stringify(createData)}`
        );
      }
      const metricId = createData.id;
      cleanupMetricIds.push({ id: metricId, eventName: eventName });

      // Verify via Metrics API GET endpoint
      const apiResp = await client.metrics[":id"].value.$get({
        param: { id: metricId },
        query: { customerId: testCustomerId },
      });
      expect(apiResp.status).toBe(200);
      const apiData = await apiResp.json();
      if ("error" in apiData)
        throw new Error(
          `Metric value fetch failed: ${JSON.stringify(apiData)}`
        );

      // The value should be calculated directly from ingested events
      expect(apiData.value).toBe(15);
    });
  });

  describe("Multi-Customer Events", () => {
    // Helper function to create a unique event name
    const createEventName = (suffix: string) =>
      `test.event.${Date.now()}.${suffix}`;

    // We'll store metrics and customer data here
    let multiCustomers: {
      id: string;
      name: string;
      subscriptionId: string;
      internalSubscriptionId: string;
    }[] = [];
    let multiMetrics: { id: string; eventName: string; name: string }[] = [];
    let multiPlan: any;
    let multiPrice: any;

    beforeAll(async () => {
      // Clear event data
      await clearEventData();

      // Create a test plan via API
      const planResult = await createTestPlanWithFeatures(
        testMerchantId,
        [], // No features needed
        {
          stablePlanId: `multi-cust-plan-${Date.now()}`,
          versionNumber: 1,
          planName: "Multi-Customer Test Plan",
        }
      );
      multiPlan = planResult.plan;

      // Create price for the plan via helper (this is part of setup)
      multiPrice = await createTestPrice({
        planId: multiPlan.id,
        merchantId: testMerchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              type: "fixed",
              component_name: "base_fee",
              label: "Base Fee",
              amount_cents: 0,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: false,
            },
          ],
        },
      });

      // Create three metrics we'll use for event testing across customers
      // All via API endpoints!

      // 1. COUNT metric for login events
      const loginEventName = createEventName("login");
      const loginMetricResp = await client.metrics.$post({
        json: {
          name: "Login Count",
          aggregationType: "COUNT" as MetricAggregationType,
          eventName: loginEventName,
          valueType: "NUMERIC",
          queryType: "simple",
        },
      });
      expect(loginMetricResp.status).toBe(201);
      const loginMetricData = await loginMetricResp.json();
      if ("error" in loginMetricData) {
        throw new Error(
          `Failed to create login metric: ${JSON.stringify(loginMetricData)}`
        );
      }
      const loginMetric = {
        id: loginMetricData.id,
        eventName: loginEventName,
        name: "Login Count",
      };

      // 2. SUM metric for transaction amounts
      const transactionEventName = createEventName("transaction");
      const transactionMetricResp = await client.metrics.$post({
        json: {
          name: "Transaction Amount",
          aggregationType: "SUM" as MetricAggregationType,
          eventName: transactionEventName,
          valueType: "NUMERIC",
          queryType: "simple",
        },
      });
      expect(transactionMetricResp.status).toBe(201);
      const transactionMetricData = await transactionMetricResp.json();
      if ("error" in transactionMetricData) {
        throw new Error(
          `Failed to create transaction metric: ${JSON.stringify(transactionMetricData)}`
        );
      }
      const transactionMetric = {
        id: transactionMetricData.id,
        eventName: transactionEventName,
        name: "Transaction Amount",
      };

      // 3. UNIQUE_COUNT metric for unique page views
      const pageViewEventName = createEventName("page_view");
      const pageViewMetricResp = await client.metrics.$post({
        json: {
          name: "Unique Page Views",
          aggregationType: "UNIQUE_COUNT" as MetricAggregationType,
          eventName: pageViewEventName,
          valueType: "STRING",
          queryType: "simple",
        },
      });
      expect(pageViewMetricResp.status).toBe(201);
      const pageViewMetricData = await pageViewMetricResp.json();
      if ("error" in pageViewMetricData) {
        throw new Error(
          `Failed to create page view metric: ${JSON.stringify(pageViewMetricData)}`
        );
      }
      const pageViewMetric = {
        id: pageViewMetricData.id,
        eventName: pageViewEventName,
        name: "Unique Page Views",
      };

      multiMetrics = [loginMetric, transactionMetric, pageViewMetric];

      // Create 2 additional test customers (we already have one)
      for (let i = 0; i < 2; i++) {
        const customerName = `Multi Test Customer ${i + 1}`;
        const customer = await createTestCustomer({
          merchantId: testMerchantId,
          name: customerName,
          email: `multi-test-customer-${i + 1}-${Date.now()}@example.com`,
        });

        // Create a subscription for each customer via API
        const subscriptionResp = await client.subscriptions.$post({
          json: {
            customerId: customer.id,
            planId: multiPlan.id,
            effectivePriceId: multiPrice.id,
          },
        });
        expect(subscriptionResp.status).toBe(201);
        const subscriptionData = await subscriptionResp.json();
        if ("error" in subscriptionData) {
          throw new Error(
            `Failed to create subscription: ${JSON.stringify(subscriptionData)}`
          );
        }

        multiCustomers.push({
          id: customer.id,
          name: customerName,
          subscriptionId: subscriptionData.subscription!.stableSubscriptionId,
          internalSubscriptionId: subscriptionData.subscription!.id,
        });
      }

      // Also add our existing test customer
      multiCustomers.push({
        id: testCustomerId,
        name: "E2E Test Customer",
        subscriptionId: testSubscriptionId,
        internalSubscriptionId: testSubscriptionInternalId,
      });
    });

    beforeEach(async () => {
      // Clear event data before each test
      await clearEventData();
    });

    afterAll(async () => {
      // Clean up Redis metric cache
      const redis = await getRedisClient();
      for (const metric of multiMetrics) {
        const defKey = `metric_def:${testMerchantId}:${metric.id}`;
        const idxKey = `metrics_for_event:${testMerchantId}:${metric.eventName}`;
        await redis.del(defKey);
        await redis.sRem(idxKey, metric.id);
      }

      // Also add metrics to the cleanup list for proper deletion
      for (const metric of multiMetrics) {
        cleanupMetricIds.push({
          id: metric.id,
          eventName: metric.eventName,
        });
      }
    });

    it("should process and isolate events for multiple customers", async () => {
      const [loginMetric, transactionMetric, pageViewMetric] = multiMetrics;

      // Send events for each customer via API
      for (const customer of multiCustomers) {
        // Login event
        const loginEvent = {
          eventName: loginMetric.eventName,
          customerId: customer.id,
          eventValue: 1,
          idempotencyKey: `login-${customer.id}-${Date.now()}`,
          eventTimestamp: new Date().toISOString(),
        };

        // Transaction event with different amounts for each customer
        const customerIndex = multiCustomers.indexOf(customer);
        const amount = 10 * (customerIndex + 1); // 10, 20, 30

        const transactionEvent = {
          eventName: transactionMetric.eventName,
          customerId: customer.id,
          eventValue: amount,
          idempotencyKey: `transaction-${customer.id}-${Date.now()}`,
          eventTimestamp: new Date().toISOString(),
        };

        // Page view event with different pages for each customer
        const page = `/page-${customerIndex + 1}`;
        const pageViewEvent = {
          eventName: pageViewMetric.eventName,
          customerId: customer.id,
          eventString: page,
          idempotencyKey: `pageview-${customer.id}-${Date.now()}`,
          eventTimestamp: new Date().toISOString(),
        };

        // Submit all events through the API
        const loginResp = await client.events.$post({ json: loginEvent });
        expect(loginResp.status).toBe(202);

        const transactionResp = await client.events.$post({
          json: transactionEvent,
        });
        expect(transactionResp.status).toBe(202);

        const pageViewResp = await client.events.$post({ json: pageViewEvent });
        expect(pageViewResp.status).toBe(202);

        logger.info(
          `Created events for customer ${customer.id}: login, transaction(${amount}), pageview(${page})`
        );
      }

      // Allow time for all events to be processed by both QuestDB and PostgreSQL
      await new Promise((resolve) => setTimeout(resolve, 4000));

      // Verify each customer's metrics individually
      for (const customer of multiCustomers) {
        const customerIndex = multiCustomers.indexOf(customer);

        // 1. Verify login count should be 1 for each customer
        const loginResp = await client.metrics[":id"].value.$get({
          param: { id: loginMetric.id },
          query: { customerId: customer.id },
        });

        expect(loginResp.status).toBe(200);
        const loginValue = await loginResp.json();
        if ("error" in loginValue) {
          throw new Error(
            `Failed to get login value: ${JSON.stringify(loginValue)}`
          );
        }
        expect(loginValue.value).toBe(1);

        // 2. Verify transaction amount corresponds to customer index (10, 20, 30)
        const transactionResp = await client.metrics[":id"].value.$get({
          param: { id: transactionMetric.id },
          query: { customerId: customer.id },
        });

        expect(transactionResp.status).toBe(200);
        const transactionValue = await transactionResp.json();
        if ("error" in transactionValue) {
          throw new Error(
            `Failed to get transaction value: ${JSON.stringify(transactionValue)}`
          );
        }
        expect(transactionValue.value).toBe((customerIndex + 1) * 10);

        // 3. Verify page view set has cardinality of 1 (just one page per customer)
        const pageViewResp = await client.metrics[":id"].value.$get({
          param: { id: pageViewMetric.id },
          query: { customerId: customer.id },
        });

        expect(pageViewResp.status).toBe(200);
        const pageViewValue = await pageViewResp.json();
        if ("error" in pageViewValue) {
          throw new Error(
            `Failed to get page view value: ${JSON.stringify(pageViewValue)}`
          );
        }
        expect(pageViewValue.value).toBe(1);
      }

      // Verify total number of events in database
      const storedEvents = await db
        .select()
        .from(eventsSchema)
        .where(
          and(
            eq(eventsSchema.merchantId, testMerchantId),
            eq(eventsSchema.eventName, loginMetric.eventName)
          )
        );

      // Should have 3 login events (one per customer)
      expect(storedEvents.length).toBe(3);
    });

    it("should handle batch events across multiple customers", async () => {
      // Create a metric specifically for batch testing via API
      const batchEventName = createEventName("batch");
      const batchMetricResp = await client.metrics.$post({
        json: {
          name: "Batch Events Test",
          aggregationType: "COUNT" as MetricAggregationType,
          eventName: batchEventName,
          valueType: "NUMERIC",
          queryType: "simple",
        },
      });
      expect(batchMetricResp.status).toBe(201);
      const batchMetricData = await batchMetricResp.json();
      if ("error" in batchMetricData) {
        throw new Error(
          `Failed to create metric: ${JSON.stringify(batchMetricData)}`
        );
      }
      const batchMetricId = batchMetricData.id;

      // Add to metrics array for cleanup
      multiMetrics.push({
        id: batchMetricId,
        eventName: batchEventName,
        name: "Batch Events Test",
      });

      // Create batch events for each customer using the API
      for (const customer of multiCustomers) {
        const events: unknown[] = [];
        // Each customer will have 3 events
        for (let i = 0; i < 3; i++) {
          events.push({
            eventName: batchEventName,
            customerId: customer.id,
            eventValue: i,
            idempotencyKey: `batch-${customer.id}-${i}-${Date.now()}`,
            eventTimestamp: new Date().toISOString(),
          });
        }

        // Submit each event individually (matching how real system works)
        for (const event of events) {
          // @ts-ignore
          const resp = await client.events.$post({ json: event });
          expect(resp.status).toBe(202);
        }
      }

      // Allow time for batch to be processed by both QuestDB and PostgreSQL
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Verify each customer's batch metrics
      for (const customer of multiCustomers) {
        const metricResp = await client.metrics[":id"].value.$get({
          param: { id: batchMetricId },
          query: { customerId: customer.id },
        });

        expect(metricResp.status).toBe(200);
        const metricValue = await metricResp.json();
        if ("error" in metricValue) {
          throw new Error(
            `Failed to get metric value: ${JSON.stringify(metricValue)}`
          );
        }
        expect(metricValue.value).toBe(3); // Each customer sent 3 events

        // Verify persisted events in PostgreSQL
        const batchDbEvents = await db
          .select()
          .from(eventsSchema)
          .where(
            and(
              eq(eventsSchema.merchantId, testMerchantId),
              eq(eventsSchema.eventName, batchEventName)
            )
          );

        // Also verify QuestDB has the events
        const questDbResults = await queryQuestDbDirectly(
          `SELECT COUNT(*) FROM events WHERE merchant_id = '${testMerchantId}' AND event_name = '${batchEventName}'`
        );

        expect(questDbResults.rowCount).toBeGreaterThan(0);

        // Should have 9 events total (3 customers x 3 events each)
        expect(batchDbEvents.length).toBe(9);

        // Verify each customer has their own set of events
        const customerEvents = batchDbEvents.filter(
          (e) => e.customerId === customer.id
        );
        expect(customerEvents.length).toBe(3); // 3 events per customer
      }
    });

    it("should verify entitlements for multiple customers", async () => {
      // Create features for testing entitlements using API
      const apiCallsSlug = `max-api-calls-${Date.now()}`;
      const premiumSupportSlug = `premium-support-${Date.now()}`;

      // Create features via API
      const apiCallsFeatureResp = await client.features.$post({
        json: {
          slug: apiCallsSlug,
          displayName: "Maximum API Calls",
          description: "Maximum number of API calls allowed",
          featureValue: 15, // Limit of 15 API calls
        },
      });
      expect(apiCallsFeatureResp.status).toBe(201);
      const apiCallsFeature = await apiCallsFeatureResp.json();
      if ("error" in apiCallsFeature) {
        throw new Error(
          `Failed to create API calls feature: ${JSON.stringify(apiCallsFeature)}`
        );
      }

      const premiumSupportResp = await client.features.$post({
        json: {
          slug: premiumSupportSlug,
          displayName: "Premium Support",
          description: "Access to premium support",
          featureValue: true,
        },
      });
      expect(premiumSupportResp.status).toBe(201);
      const premiumSupportFeature = await premiumSupportResp.json();
      if ("error" in premiumSupportFeature) {
        throw new Error(
          `Failed to create premium support feature: ${JSON.stringify(premiumSupportFeature)}`
        );
      }

      // Create a dedicated metric for API calls via API
      const apiCallsEventName = createEventName("api_call");
      const apiCallsMetricResp = await client.metrics.$post({
        json: {
          name: "API Calls Counter",
          aggregationType: "COUNT" as MetricAggregationType,
          eventName: apiCallsEventName,
          valueType: "NUMERIC",
          queryType: "simple",
        },
      });
      expect(apiCallsMetricResp.status).toBe(201);
      const apiCallsMetricData = await apiCallsMetricResp.json();
      if ("error" in apiCallsMetricData) {
        throw new Error(
          `Failed to create API calls metric: ${JSON.stringify(apiCallsMetricData)}`
        );
      }
      const apiCallsMetricId = apiCallsMetricData.id;

      // Add to metrics array for cleanup
      multiMetrics.push({
        id: apiCallsMetricId,
        eventName: apiCallsEventName,
        name: "API Calls Counter",
      });

      // Link the feature with the metric via API
      const featureUpdateResp = await client.features[":featureId"].$put({
        param: { featureId: apiCallsFeature.feature.id },
        json: { metricIds: [apiCallsMetricId] },
      });
      expect(featureUpdateResp.status).toBe(200);

      // Create credit definition for the numeric API calls feature with 15 credits limit
      await createTestUsageCreditDefinition({
        merchantId: testMerchantId,
        planId: multiPlan.id,
        featureId: apiCallsFeature.feature.id,
        featureSlug: apiCallsSlug,
        // No priceId provided so credits apply to any price under the plan
        // priceComponentId also omitted because usage credits are plan-level limits
        priceId: undefined as any,
        priceComponentId: undefined as any,
        currency: "USD",
        creditAmount: 15, // 15 API calls limit
        name: `${apiCallsSlug} credits`,
        description: `Free 15 ${apiCallsSlug} credits`,
        applicationType: "usage",
      });

      // Generate varying numbers of API call events for each customer
      // First customer: 5 calls (under limit)
      // Second customer: 10 calls (under limit)
      // Third customer: 15 calls (at limit, should NOT be entitled)
      for (
        let customerIndex = 0;
        customerIndex < multiCustomers.length;
        customerIndex++
      ) {
        const customer = multiCustomers[customerIndex];

        // Calculate events based on customer index
        const numEvents = 5 * (customerIndex + 1);

        // Create API call events via API endpoints
        for (let i = 0; i < numEvents; i++) {
          const apiCallEvent = {
            eventName: apiCallsEventName,
            customerId: customer.id,
            eventValue: i,
            idempotencyKey: `api-call-${customer.id}-${i}-${Date.now()}`,
            eventTimestamp: new Date().toISOString(),
          };

          const resp = await client.events.$post({ json: apiCallEvent });
          expect(resp.status).toBe(202);
        }

        logger.info(
          `Created ${numEvents} API call events for customer ${customer.id}`
        );
      }

      // Allow time for events to be processed
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Add the features to all customer subscriptions via API
      for (const customer of multiCustomers) {
        // Add feature overrides via API
        const overrideResp = await client.subscriptions["feature-overrides"][
          ":id"
        ].$post({
          // API expects the stable subscription id
          param: { id: customer.subscriptionId },
          json: {
            featureIds: [
              apiCallsFeature.feature.id,
              premiumSupportFeature.feature.id,
            ],
          },
        });
        expect(overrideResp.status).toBe(200);

        // Capture the new subscription version returned by the override call
        const overrideData = await overrideResp.json();
        if ("error" in overrideData) {
          throw new Error(
            `Failed to apply overrides: ${JSON.stringify(overrideData)}`
          );
        }

        // The override response maps id → stableSubscriptionId only. We need the real primary-key id.
        // Fetch the freshly-created subscription row directly from the database using the stable id.
        const latestSubRecord = await db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.stableSubscriptionId, customer.subscriptionId),
            eq(subscriptions.merchantId, testMerchantId),
            isNull(subscriptions.deletedAt)
          ),
          orderBy: desc(subscriptions.createdAt),
        });

        if (!latestSubRecord) {
          throw new Error(
            `Latest subscription version not found for ${customer.subscriptionId}`
          );
        }

        customer.internalSubscriptionId = latestSubRecord.id;

        // Process initial credits using the latest internal subscription id
        await processInitialCreditsForSubscription(
          testMerchantId,
          customer.id,
          multiPlan.id,
          customer.internalSubscriptionId
        );
      }

      // Allow time for feature association to take effect
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check entitlements for all customers
      for (
        let customerIndex = 0;
        customerIndex < multiCustomers.length;
        customerIndex++
      ) {
        const customer = multiCustomers[customerIndex];

        // Get all entitlements for the customer via API
        const entitlementsResp = await client.entitlements[":customerId"].$get({
          param: { customerId: customer.id },
          query: { isExtCustId: "false" },
        });
        expect(entitlementsResp.status).toBe(200);

        const entitlementsData = await entitlementsResp.json();
        if ("error" in entitlementsData) {
          throw new Error(
            `Failed to get entitlements: ${JSON.stringify(entitlementsData)}`
          );
        }
        expect(entitlementsData).toHaveProperty("entitlements");
        expect(Array.isArray(entitlementsData.entitlements)).toBe(true);

        // Should have our features
        expect(entitlementsData.entitlements.length).toBeGreaterThanOrEqual(2);

        // Check API calls feature entitlement - varies based on customer's usage
        const apiCallsResp = await client.entitlements[":customerId"].feature[
          ":featureSlug"
        ].$get({
          param: {
            customerId: customer.id,
            featureSlug: apiCallsSlug,
          },
          query: { isExtCustId: "false" },
        });
        expect(apiCallsResp.status).toBe(200);

        const apiCallsEntitlement = await apiCallsResp.json();
        if ("error" in apiCallsEntitlement) {
          throw new Error(
            `Failed to get API calls entitlement: ${JSON.stringify(apiCallsEntitlement)}`
          );
        }
        expect(apiCallsEntitlement).toHaveProperty("feature");
        expect(apiCallsEntitlement.feature).toHaveProperty("value", 15); // All should have limit of 15 from credits
        expect(apiCallsEntitlement.source).toBe("credits");

        // The actual number of events should be 5, 10, or 15 based on customer index
        const expectedEvents = 5 * (customerIndex + 1);

        if (apiCallsEntitlement.usages && apiCallsEntitlement.usages[0]) {
          console.log("apiCallsEntitlement", apiCallsEntitlement);
          const actualUsage = apiCallsEntitlement.usages[0].usage;

          // Verification based on actual usage compared to the limit (15)
          if (expectedEvents < 15) {
            // Usage is under limit - should be entitled
            expect(apiCallsEntitlement.entitled).toBe(true);
          } else {
            // Usage is at or over limit - should not be entitled
            expect(apiCallsEntitlement.entitled).toBe(false);
          }
        }

        // Check premium support feature (boolean feature)
        const premiumResp = await client.entitlements[":customerId"].feature[
          ":featureSlug"
        ].$get({
          param: {
            customerId: customer.id,
            featureSlug: premiumSupportSlug,
          },
          query: { isExtCustId: "false" },
        });
        expect(premiumResp.status).toBe(200);

        const premiumEntitlement = await premiumResp.json();
        if ("error" in premiumEntitlement) {
          throw new Error(
            `Failed to get premium entitlement: ${JSON.stringify(premiumEntitlement)}`
          );
        }
        expect(premiumEntitlement).toHaveProperty("entitled", true); // Boolean feature should always be entitled
        expect(premiumEntitlement.feature).toHaveProperty("value", true);
      }

      // Check batch entitlement checks for all customers
      for (const customer of multiCustomers) {
        const batchResp = await client.entitlements[
          ":customerId"
        ].features.$post({
          param: { customerId: customer.id },
          query: { isExtCustId: "false" },
          json: {
            featureSlugs: [apiCallsSlug, premiumSupportSlug],
          },
        });
        expect(batchResp.status).toBe(200);

        const batchData = await batchResp.json();
        if ("error" in batchData) {
          throw new Error(
            `Failed to get batch entitlements: ${JSON.stringify(batchData)}`
          );
        }
        expect(batchData).toHaveProperty("entitlements");
        expect(Array.isArray(batchData.entitlements)).toBe(true);
        expect(batchData.entitlements.length).toBe(2);

        // Both features should be returned
        const apiCallsFeatureResult = batchData.entitlements.find(
          (e) => e.feature?.slug === apiCallsSlug
        );
        expect(apiCallsFeatureResult).toBeDefined();

        const premiumFeatureResult = batchData.entitlements.find(
          (e) => e.feature?.slug === premiumSupportSlug
        );
        expect(premiumFeatureResult).toBeDefined();
      }
    }, 30000);
  });
});
