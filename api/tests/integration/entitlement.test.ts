import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  beforeEach,
  setDefaultTimeout,
} from "bun:test";

import {
  createFullTestEnvironment,
  createPlanWithDefinedFeatures,
  createTestFeatures,
  createTestUser,
  createAuthenticatedClient,
  createApiKeyClient,
  createSubscriptionWithOverrides,
} from "../test-helpers";
import { db } from "../../src/db/client";
import {
  organization,
  metrics,
  subscriptionFeatures,
  events,
  customers,
  plans,
  paymentMethods,
  subscriptions,
  featureMetrics,
  prices,
  features,
  planFeatures,
  subscriptionDetails,
  payments,
  invoiceLineItems,
  invoices,
  pricingTablePlans,
  pricingTables,
  creditUsageTransactions,
  creditGrants,
  creditDefinitions,
} from "@lumen/common/schema";
import { and, eq, sql } from "drizzle-orm";
import { createBasicSubscription } from "../test-helpers/data/subscription";
import { createTestApiKeys } from "../test-helpers/data/api-keys";
import { createTestMetric } from "../test-helpers/data/metrics";
import { createTestCustomer } from "../test-helpers/data/customer";
import { createTestUsageCreditDefinition } from "../test-helpers/data/credits";
import { processInitialCreditsForSubscription } from "../../src/helpers/credits";
import type {
  FeatureSelect,
  PlanSelect,
  PriceSelect,
} from "../test-helpers/types";
import type { FeatureEntitlement } from "../../src/routes/entitlements";
import { createId } from "@lumen/common";
import { ClientType } from "../test-helpers/api/client";

setDefaultTimeout(10000);

describe("Entitlements API", () => {
  let client: ClientType;
  let testMerchantId: string;
  let testCustomerId: string;
  // The created subscription for testing entitlements
  let testSubscriptionId: string;
  // The list of test features created for this merchant
  let testFeatures: FeatureSelect[];
  let featuresList: Partial<FeatureSelect>[];
  let price: PriceSelect;
  let plan: PlanSelect;

  // Setup environment before tests
  beforeEach(async () => {
    // Create test environment with merchant
    const { merchant, user: merchantUser } = await createFullTestEnvironment();
    testMerchantId = merchant.id;

    // Create a customer (user)
    const user = await createTestUser({
      name: "Entitlements Test Customer",
      email: `entitlements_test_${Date.now()}@example.com`,
    });

    // Create the associated customer record
    const customer = await createTestCustomer({
      merchantId: testMerchantId,
      name: user.name,
      email: user.email,
      metadata: {
        userId: user.id,
      },
    });
    testCustomerId = customer.id;

    // Create an authenticated client
    client = await createAuthenticatedClient(
      merchantUser.email,
      merchantUser.password
    );

    // Create test features with array-based definition
    // Note: featureValue is no longer used as limit - credit grants will be the limits
    featuresList = [
      {
        slug: "premium-support",
        description: "Access to premium support",
        featureValue: true, // This becomes meaningless - credits define limits
      },
      {
        slug: "max-users",
        description: "Maximum number of users allowed",
        featureValue: 10, // This becomes meaningless - credits define limits
      },
      {
        slug: "storage-limit",
        description: "Storage limit in gigabytes",
        featureValue: 100, // This becomes meaningless - credits define limits
      },
      {
        slug: "custom-domain",
        description: "Ability to use custom domain",
        featureValue: false, // This becomes meaningless - credits define limits
      },
    ];

    // Create test features in DB
    testFeatures = await createTestFeatures(testMerchantId, 4, featuresList);

    // Create a plan with these features
    const PlanAndPrice = await createPlanWithDefinedFeatures(
      testMerchantId,
      testFeatures,
      {
        planName: "Entitlements Test Plan",
        planDescription: "A plan for testing entitlements",
      }
    );
    if (!PlanAndPrice.price) {
      throw new Error("Price was not created");
    }
    price = PlanAndPrice.price;
    plan = PlanAndPrice.plan;

    // Create credit definitions for numeric features (features that need usage tracking)
    const numericFeatures = testFeatures.filter(
      (f) => f.slug === "max-users" || f.slug === "storage-limit"
    );

    for (const feature of numericFeatures) {
      const creditAmount = feature.slug === "max-users" ? 10 : 100;
      await createTestUsageCreditDefinition({
        merchantId: testMerchantId,
        planId: plan.id,
        featureId: feature.id,
        featureSlug: feature.slug,
        priceId: price.id,
        priceComponentId: price.pricingData.components.find(
          (c) => c.type === "fixed"
        )!.component_id!,
        currency: "USD",
        creditAmount,
        name: `${feature.slug} credits`,
        description: `Free ${creditAmount} ${feature.slug} credits`,
        applicationType: "usage",
      });
    }

    // Create a basic subscription for the customer to this plan
    const subscription = await createBasicSubscription(
      testMerchantId,
      testCustomerId,
      plan.id,
      price.id
    );
    testSubscriptionId = subscription.id;
  });

  afterEach(async () => {
    const cleanupQuery = sql`
      DELETE FROM ${payments};
      DELETE FROM ${invoiceLineItems};
      DELETE FROM ${invoices};
      DELETE FROM ${subscriptionFeatures};
      DELETE FROM ${subscriptionDetails};
      DELETE FROM ${metrics};
      DELETE FROM ${events};
      DELETE FROM ${subscriptions};
      DELETE FROM ${paymentMethods};
      DELETE FROM ${creditUsageTransactions};
      DELETE FROM ${creditGrants};
      DELETE FROM ${creditDefinitions};
      DELETE FROM ${prices};
      DELETE FROM ${planFeatures};
      DELETE FROM ${features};
      DELETE FROM ${featureMetrics};
      DELETE FROM ${pricingTablePlans};
      DELETE FROM ${pricingTables};
      DELETE FROM ${plans};
      DELETE FROM ${customers};
      DELETE FROM ${organization};
    `;
    await db.execute(cleanupQuery);
  });

  it("should get all entitlements for a customer", async () => {
    const response = await client.entitlements[":customerId"].$get({
      param: { customerId: testCustomerId },
      query: { isExtCustId: "false" },
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    // Should have entitlements array
    expect(data).toHaveProperty("entitlements");
    if ("error" in data) {
      throw new Error(`Expected entitlements but got error: ${data.error}`);
    }
    expect(Array.isArray(data.entitlements)).toBe(true);

    // Should contain all 4 features
    expect(data.entitlements.length).toBe(4);

    // Verify all features are included with correct structure
    const featureSlugs = featuresList.map((f) => f.slug).filter(Boolean);
    const responseSlugs = data.entitlements
      .filter((e) => e.feature !== null)
      .map((e) => e.feature!.slug);

    featureSlugs.forEach((slug) => {
      expect(responseSlugs).toContain(slug);
    });

    // Check specific feature entitlements
    const premiumSupport = data.entitlements.find(
      (e) => e.feature?.slug === "premium-support"
    );
    expect(premiumSupport?.entitled).toBe(true);
    expect(premiumSupport?.feature?.value).toBe(true); // Boolean features keep their values
    expect(premiumSupport?.source).toBe("plan");

    const maxUsers = data.entitlements.find(
      (e) => e.feature?.slug === "max-users"
    );
    expect(maxUsers?.entitled).toBe(true);
    expect(maxUsers?.feature?.value).toBe(10); // Now comes from credit allowance, not feature value
    expect(maxUsers?.source).toBe("credits"); // Source is now credits, not plan

    // Check storage limit feature
    const storageLimit = data.entitlements.find(
      (e) => e.feature?.slug === "storage-limit"
    );
    expect(storageLimit?.entitled).toBe(true);
    expect(storageLimit?.feature?.value).toBe(100); // Now comes from credit allowance, not feature value
    expect(storageLimit?.source).toBe("credits"); // Source is now credits, not plan

    // Check custom domain feature
    const customDomain = data.entitlements.find(
      (e) => e.feature?.slug === "custom-domain"
    );
    expect(customDomain?.entitled).toBe(true);
    expect(customDomain?.feature?.value).toBe(false); // Boolean features keep their values
    expect(customDomain?.source).toBe("plan");
  });

  it("should check a specific feature entitlement", async () => {
    const response = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: {
        customerId: testCustomerId,
        featureSlug: "premium-support",
      },
      query: { isExtCustId: "false" },
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    if ("error" in data) {
      throw new Error(
        `Expected feature entitlement but got error: ${data.error}`
      );
    }

    // Verify the entitlement structure
    expect(data.entitled).toBe(true);
    expect(data.feature).toHaveProperty("slug", "premium-support");
    expect(data.feature).toHaveProperty("value", true);
    expect(data.source).toBe("plan"); // Boolean features still come from plan
  });

  it("should handle feature that doesn't exist", async () => {
    const response = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: {
        customerId: testCustomerId,
        featureSlug: "nonexistent-feature",
      },
      query: { isExtCustId: "false" },
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    if ("error" in data) {
      throw new Error(
        `Expected feature entitlement but got error: ${data.error}`
      );
    }

    expect(data.entitled).toBe(false);
    expect(data.feature).toBe(null);
    expect(data.source).toBe(null); // Non-existent features remain null
  });

  it("should handle customer with no subscription", async () => {
    const nonExistentCustomerId = createId();
    const response = await client.entitlements[":customerId"].$get({
      param: { customerId: nonExistentCustomerId },
      query: { isExtCustId: "false" },
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    if ("error" in data) {
      throw new Error(`Expected entitlements but got error: ${data.error}`);
    }

    expect(Array.isArray(data.entitlements)).toBe(true);
    expect(data.entitlements.length).toBe(0);
  });

  // Batch entitlement checks for multiple features
  it("should batch check multiple feature entitlements", async () => {
    const slugs = ["premium-support", "max-users", "custom-domain"];
    const resp = await client.entitlements[":customerId"].features.$post({
      param: { customerId: testCustomerId },
      query: { isExtCustId: "false" },
      json: { featureSlugs: slugs },
    });
    expect(resp.status).toBe(200);
    const result = await resp.json();
    if ("error" in result) {
      throw new Error(`Expected entitlements but got error: ${result.error}`);
    }
    expect(result).toHaveProperty("entitlements");
    const ents = result.entitlements;
    expect(Array.isArray(ents)).toBe(true);
    expect(ents.length).toBe(slugs.length);
    // Validate each entitlement
    slugs.forEach((slug) => {
      const e = ents.find((x) => x.feature?.slug === slug);
      expect(e).toBeDefined();
      // Features should be entitled based on their type
      expect(e?.entitled).toBe(true);
      if (slug === "premium-support" || slug === "custom-domain") {
        expect(e?.source).toBe("plan"); // Boolean features from plan
      } else {
        expect(e?.source).toBe("credits"); // Numeric features from credits
      }
    });
  });

  // Numeric feature entitlement based on metric usage
  it("should determine numeric feature entitlement using metric usage and respect billing period", async () => {
    // Create API key for events and metrics
    const { secretKey } = await createTestApiKeys({
      merchantId: testMerchantId,
    });
    const apiKeyClient = createApiKeyClient(secretKey.rawKeyValue);
    // Select a numeric feature (max-users)
    const numFeature = testFeatures.find((f) => f.slug === "max-users");
    expect(numFeature).toBeDefined();
    // Create a test metric and attach to the feature
    const metric = await createTestMetric({ merchantId: testMerchantId });
    // Update feature to include this metric
    await client.features[":featureId"].$put({
      param: { featureId: numFeature!.id },
      json: { metricIds: [metric.id] },
    });
    // Submit usage events under threshold
    // With credit grants, the limit is now 10 from credit allowance, not feature value
    const creditLimit = 10; // This comes from the credit grant we created
    const useCount = Math.floor(creditLimit / 2);
    for (let i = 0; i < useCount; i++) {
      if (!metric.eventName)
        throw new Error(
          "Test metric is missing required eventName for below-threshold events"
        );
      const event = {
        idempotencyKey: `evt-below-${i}`,
        eventName: metric.eventName,
        customerId: testCustomerId,
        eventValue: 1,
        subscriptionId: testSubscriptionId,
        eventTimestamp: new Date().toISOString(),
      };
      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }
    // Check entitlement: should be true
    const resp1 = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "max-users" },
      query: { isExtCustId: "false" },
    });
    expect(resp1.status).toBe(200);
    const data1 = await resp1.json();
    if ("error" in data1) {
      throw new Error(`Expected entitlements but got error: ${data1.error}`);
    }
    expect(data1.entitled).toBe(true);
    expect(Array.isArray(data1.usages)).toBe(true);
    expect(data1.usages?.[0]?.usage).toBe(useCount);
    // Submit additional events to exceed threshold
    for (let i = 0; i < useCount + 1; i++) {
      if (!metric.eventName)
        throw new Error(
          "Test metric is missing required eventName for above-threshold events"
        );
      const event = {
        idempotencyKey: `evt-above-${i}`,
        eventName: metric.eventName,
        customerId: testCustomerId,
        eventValue: 1,
        subscriptionId: testSubscriptionId,
        eventTimestamp: new Date().toISOString(),
      };
      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }
    // Check entitlement: should be false now
    const resp2 = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "max-users" },
      query: { isExtCustId: "false" },
    });
    expect(resp2.status).toBe(200);
    const data2 = await resp2.json();
    if ("error" in data2) {
      throw new Error(`Expected entitlements but got error: ${data2.error}`);
    }
    expect(data2.entitled).toBe(false);
    expect(data2.source).toBe("credits"); // Source is now credits for numeric features
  });

  // Feature override should take precedence over plan
  it("should respect override feature entitlements over plan", async () => {
    // Override 'premium-support' to false
    const premiumFeat = testFeatures.find((f) => f.slug === "premium-support");
    expect(premiumFeat).toBeDefined();
    await createSubscriptionWithOverrides(testSubscriptionId, [
      {
        ...premiumFeat!,
        featureValue: false,
      },
    ]);
    // Check entitlement now reflects override
    const resp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "premium-support" },
      query: { isExtCustId: "false" },
    });
    expect(resp.status).toBe(200);
    const d = await resp.json();
    if ("error" in d) {
      throw new Error(`Expected entitlements but got error: ${d.error}`);
    }
    // Boolean features always return entitled=true when defined, even if overridden to false
    expect(d.entitled).toBe(true);
    // Override source should be reflected and feature value false
    expect(d.source).toBe("override");
    expect(d.feature).toHaveProperty("value", false);
  });

  // Testing different billing periods for metric-based entitlements
  it("should respect subscription time periods for metric entitlements", async () => {
    // Create API key for events
    const { secretKey } = await createTestApiKeys({
      merchantId: testMerchantId,
    });
    const apiKeyClient = createApiKeyClient(secretKey.rawKeyValue);

    // Select a numeric feature - we'll use max-users with limit of 10
    const numFeature = testFeatures.find((f) => f.slug === "max-users");
    expect(numFeature).toBeDefined();

    // Create a test metric and attach it to the feature
    const metric = await createTestMetric({
      merchantId: testMerchantId,
      aggregationType: "COUNT",
      valueType: "NUMERIC",
    });

    // Update the feature to include this metric
    await client.features[":featureId"].$put({
      param: { featureId: numFeature!.id },
      json: { metricIds: [metric.id] },
    });

    // Setup initial subscription billing period
    const now = new Date();
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const subscriptionStartDate = new Date(now.getTime() - 60 * oneDayInMs); // 60 days ago
    const previousBillingDate = new Date(now.getTime() - 30 * oneDayInMs); // 30 days ago
    const currentNextBillingDate = new Date(now.getTime() + 1 * oneDayInMs); // Tomorrow

    // Set up initial subscription billing details
    await db
      .update(subscriptionDetails)
      .set({
        subscriptionId: testSubscriptionId,
        nextBillingDate: currentNextBillingDate,
        subscriptionStartDate: subscriptionStartDate,
        previousBillingDate: previousBillingDate,
        cyclesBilled: 1,
      })
      .where(
        and(
          eq(subscriptionDetails.subscriptionId, testSubscriptionId),
          eq(
            subscriptionDetails.componentId,
            price.pricingData.components.find((c) => c.type === "fixed")!
              .component_id!
          )
        )
      );
    // Create events in current billing period (between previousBillingDate and currentNextBillingDate)
    // We'll create 5 events, each with eventValue = 1, so total should be 5
    for (let i = 0; i < 5; i++) {
      if (!metric.eventName) {
        throw new Error("Test metric is missing eventName");
      }

      // Create timestamp between previous and next billing dates
      const currentPeriodTimestamp = new Date(
        previousBillingDate.getTime() +
          (now.getTime() - previousBillingDate.getTime()) / 2
      );

      const event = {
        idempotencyKey: `evt-current-period-${i}-${Date.now()}`,
        eventName: metric.eventName,
        customerId: testCustomerId,
        eventValue: 1,
        subscriptionId: testSubscriptionId,
        eventTimestamp: currentPeriodTimestamp.toISOString(),
      };

      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check entitlement for current billing period
    // Should show 5 events in the current billing period
    const firstCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "max-users" },
      query: { isExtCustId: "false" },
    });

    expect(firstCheckResp.status).toBe(200);
    const firstCheckData = await firstCheckResp.json();
    if ("error" in firstCheckData) {
      throw new Error(
        `Expected entitlements but got error: ${firstCheckData.error}`
      );
    }

    expect(firstCheckData.entitled).toBe(true);
    expect(Array.isArray(firstCheckData.usages)).toBe(true);
    expect(firstCheckData.usages?.[0]?.usage).toBe(5);

    // Now, simulate a billing cycle roll forward
    // The current nextBillingDate becomes the previousBillingDate
    // And we set a new nextBillingDate 30 days in the future
    const newPreviousBillingDate = currentNextBillingDate;
    const newNextBillingDate = new Date(
      currentNextBillingDate.getTime() + 30 * oneDayInMs
    );

    // Update the subscription billing details to reflect the new cycle
    await db
      .update(subscriptionDetails)
      .set({
        previousBillingDate: newPreviousBillingDate,
        nextBillingDate: newNextBillingDate,
        cyclesBilled: 2,
      })
      .where(
        and(
          eq(subscriptionDetails.subscriptionId, testSubscriptionId),
          eq(
            subscriptionDetails.componentId,
            price.pricingData.components.find((c) => c.type === "fixed")!
              .component_id!
          )
        )
      );

    // Create new events in the next billing period
    // (between newPreviousBillingDate and newNextBillingDate)
    // We'll create 3 events, so total should be 3 for this period
    for (let i = 0; i < 3; i++) {
      if (!metric.eventName) {
        throw new Error("Test metric is missing eventName");
      }

      // Create timestamp in the new billing period
      // (just after the new previous billing date)
      const newPeriodTimestamp = new Date(
        newPreviousBillingDate.getTime() + 2 * oneDayInMs
      );

      const event = {
        idempotencyKey: `evt-new-period-${i}-${Date.now()}`,
        eventName: metric.eventName,
        customerId: testCustomerId,
        eventValue: 1,
        subscriptionId: testSubscriptionId,
        eventTimestamp: newPeriodTimestamp.toISOString(),
      };

      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check entitlement again
    // Should now only show the 3 events from the new billing period,
    // NOT the 5 from the previous period
    const secondCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "max-users" },
      query: { isExtCustId: "false" },
    });

    expect(secondCheckResp.status).toBe(200);
    const secondCheckData = await secondCheckResp.json();
    if ("error" in secondCheckData) {
      throw new Error(
        `Expected entitlements but got error: ${secondCheckData.error}`
      );
    }

    expect(secondCheckData.entitled).toBe(true);
    expect(Array.isArray(secondCheckData.usages)).toBe(true);
    // Only the events from the new billing period should be counted now
    expect(secondCheckData.usages?.[0]?.usage).toBe(3);
  });

  // Test SQL-based indexed metrics with entitlements
  it("should determine entitlements based on indexed SQL metrics", async () => {
    // Create API key for events
    const { secretKey } = await createTestApiKeys({
      merchantId: testMerchantId,
    });
    const apiKeyClient = createApiKeyClient(secretKey.rawKeyValue);

    // Create a new feature for testing SQL metrics
    const sqlMetricFeature = await createTestFeatures(testMerchantId, 1, [
      {
        slug: "sql-indexed-feature",
        description: "Feature with SQL indexed metric",
        featureValue: 5 as const, // This becomes meaningless - credits define limits
      },
    ]);

    // Create a SQL indexed metric
    const metricData = {
      merchantId: testMerchantId,
      name: `SQL Indexed Metric ${Date.now()}`,
      description: "An indexed SQL metric for testing entitlements",
      queryType: "indexed" as const,
      sqlDefinition:
        "SELECT SUM(event_value) FROM filtered_events WHERE event_name = 'test.sql.indexed.event'",
    };

    // Create the metric using the metrics API
    const metricResponse = await client.metrics.$post({
      json: metricData,
    });
    expect(metricResponse.status).toBe(201);
    const metricResponseData = await metricResponse.json();
    if ("error" in metricResponseData) {
      throw new Error(`Failed to create metric: ${metricResponseData.error}`);
    }
    const sqlMetric = metricResponseData;

    // Update the feature to include this SQL-based metric
    await client.features[":featureId"].$put({
      param: { featureId: sqlMetricFeature[0].id },
      json: { metricIds: [sqlMetric.id] },
    });

    // Create credit definition for this feature with 5 credits limit
    await createTestUsageCreditDefinition({
      merchantId: testMerchantId,
      planId: plan.id,
      featureId: sqlMetricFeature[0].id,
      featureSlug: sqlMetricFeature[0].slug,
      priceId: price.id,
      priceComponentId: price.pricingData.components.find(
        (c) => c.type === "fixed"
      )!.component_id!,
      currency: "USD",
      creditAmount: 5, // 5 credits limit
      name: `${sqlMetricFeature[0].slug} credits`,
      description: `Free 5 ${sqlMetricFeature[0].slug} credits`,
      applicationType: "usage",
    });

    // Associate the feature with the subscription
    await createSubscriptionWithOverrides(testSubscriptionId, [
      sqlMetricFeature[0],
    ]);

    // Process initial credits for this new feature
    await processInitialCreditsForSubscription(
      testMerchantId,
      testCustomerId,
      plan.id,
      testSubscriptionId
    );

    // Setup the subscription billing period for the metric
    const now = new Date();
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const subscriptionStartDate = new Date(now.getTime() - 10 * oneDayInMs);
    const previousBillingDate = new Date(now.getTime() - 5 * oneDayInMs);
    const nextBillingDate = new Date(now.getTime() + 25 * oneDayInMs);

    await db
      .update(subscriptionDetails)
      .set({
        subscriptionStartDate,
        previousBillingDate,
        nextBillingDate,
      })
      .where(eq(subscriptionDetails.subscriptionId, testSubscriptionId));

    // Create test events that will be counted by the SQL metric
    // First, add events below the limit (should be entitled)
    const eventsBelowLimit = 3; // Less than feature value of 5
    for (let i = 0; i < eventsBelowLimit; i++) {
      const event = {
        idempotencyKey: `sql-indexed-test-${i}-${Date.now()}`,
        eventName: "test.sql.indexed.event",
        customerId: testCustomerId,
        eventValue: 1, // Each event adds 1 to the sum
        subscriptionId: testSubscriptionId,
        eventTimestamp: new Date().toISOString(),
      };

      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check entitlement - should be entitled since we're below the limit
    const firstCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "sql-indexed-feature" },
      query: { isExtCustId: "false" },
    });

    expect(firstCheckResp.status).toBe(200);
    const firstCheckData = await firstCheckResp.json();
    if ("error" in firstCheckData) {
      throw new Error(
        `Expected entitlements but got error: ${firstCheckData.error}`
      );
    }

    // Should be entitled with usage = 3
    expect(firstCheckData.entitled).toBe(true);
    expect(Array.isArray(firstCheckData.usages)).toBe(true);
    expect(firstCheckData.usages?.[0]?.usage).toBe(eventsBelowLimit);

    // Now add more events to exceed the limit
    const additionalEvents = 3; // This will push total to 6, exceeding the limit of 5
    for (let i = 0; i < additionalEvents; i++) {
      const event = {
        idempotencyKey: `sql-indexed-additional-${i}-${Date.now()}`,
        eventName: "test.sql.indexed.event",
        customerId: testCustomerId,
        eventValue: 1,
        subscriptionId: testSubscriptionId,
        eventTimestamp: new Date().toISOString(),
      };

      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check entitlement again - should not be entitled since we've exceeded the limit
    const secondCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "sql-indexed-feature" },
      query: { isExtCustId: "false" },
    });

    expect(secondCheckResp.status).toBe(200);
    const secondCheckData = await secondCheckResp.json();
    if ("error" in secondCheckData) {
      throw new Error(
        `Expected entitlements but got error: ${secondCheckData.error}`
      );
    }

    // Should not be entitled with usage = 6
    expect(secondCheckData.entitled).toBe(false);
    expect(Array.isArray(secondCheckData.usages)).toBe(true);
    expect(secondCheckData.usages?.[0]?.usage).toBe(
      eventsBelowLimit + additionalEvents
    );

    // Verify the metric value directly through the metrics API
    const metricValueResponse = await client.metrics[":id"].value.$get({
      param: { id: sqlMetric.id },
      query: {
        customerId: testCustomerId,
        timeframe: JSON.stringify({
          type: "ABSOLUTE",
          start: previousBillingDate.toISOString(),
          end: nextBillingDate.toISOString(),
        }),
      },
    });

    expect(metricValueResponse.status).toBe(200);
    const metricValue = await metricValueResponse.json();
    if ("error" in metricValue) {
      throw new Error(`API returned error: ${metricValue.error}`);
    }

    // The direct metric value should match what's shown in the entitlements
    expect(metricValue.value).toBe(eventsBelowLimit + additionalEvents);
  });

  // Test UNIQUE_COUNT metrics with eventString
  it("should correctly count unique eventString values with UNIQUE_COUNT metrics", async () => {
    // Create API key for events
    const { secretKey } = await createTestApiKeys({
      merchantId: testMerchantId,
    });
    const apiKeyClient = createApiKeyClient(secretKey.rawKeyValue);

    // 1. Create a new feature for testing UNIQUE_COUNT
    const uniqueVisitorsFeature = await createTestFeatures(testMerchantId, 1, [
      {
        slug: "unique-visitors",
        displayName: "Unique Visitors",
        description: "Maximum number of unique visitors allowed",
        featureType: "number",
        featureValue: "usage_based",
      },
    ]);

    // 2. Create a new metric for this feature
    const uniqueVisitorsMetric = await createTestMetric({
      merchantId: testMerchantId,
      name: "Unique Visitors Metric",
      aggregationType: "UNIQUE_COUNT",
      valueType: "STRING",
      eventName: `test.unique-visitors.${Date.now()}`,
    });

    // Link metric to feature
    await db.insert(featureMetrics).values({
      merchantId: testMerchantId,
      featureId: uniqueVisitorsFeature[0].id,
      featureSlug: uniqueVisitorsFeature[0].slug,
      metricId: uniqueVisitorsMetric.id,
    });

    // 3. Create a new plan specifically for this test
    const { plan, price } = await createPlanWithDefinedFeatures(
      testMerchantId,
      uniqueVisitorsFeature,
      {
        planName: "Unique Visitors Test Plan",
        planDescription: "A plan for testing the unique visitors feature",
      }
    );

    if (!price) {
      throw new Error("Price was not created for the test plan");
    }

    // 4. Create a credit definition for the feature on the new plan
    await createTestUsageCreditDefinition({
      merchantId: testMerchantId,
      planId: plan.id,
      featureId: uniqueVisitorsFeature[0].id,
      featureSlug: uniqueVisitorsFeature[0].slug,
      priceId: price.id,
      priceComponentId: price.pricingData.components.find(
        (c) => c.type === "fixed"
      )!.component_id!,
      currency: "USD", // Add missing currency
      creditAmount: 5, // 5 unique visitors limit
      name: "Unique Visitors Credits",
      description: "Credits for unique visitors",
      applicationType: "usage",
    });

    // 5. Create a new customer and subscribe them to the new plan
    const newCustomer = await createTestCustomer({
      merchantId: testMerchantId,
      email: `unique-visitor-customer-${Date.now()}@example.com`,
      name: "Unique Visitor Test Customer",
    });

    const newSubscription = await createBasicSubscription(
      testMerchantId,
      newCustomer.id,
      plan.id,
      price.id
    );

    // 6. Verify initial entitlement and credit grant
    const initialEntitlementResp = await client.entitlements[
      ":customerId"
    ].feature[":featureSlug"].$get({
      param: { customerId: newCustomer.id, featureSlug: "unique-visitors" },
      query: { isExtCustId: "false" },
    });

    const initialEntitlement = await initialEntitlementResp.json();
    if ("error" in initialEntitlement) {
      throw new Error(`API Error: ${initialEntitlement.error}`);
    }

    expect(initialEntitlement.entitled).toBe(true);
    expect(initialEntitlement.creditInfo?.creditAllowance).toBe(5);
    expect(initialEntitlement.creditInfo?.creditsRemaining).toBe(5);

    // 7. Send events with duplicate eventString values (below the limit)
    const visitorIds = [
      "visitor-1",
      "visitor-2",
      "visitor-3",
      "visitor-2", // duplicate
      "visitor-1", // duplicate
    ];
    for (let i = 0; i < visitorIds.length; i++) {
      if (!uniqueVisitorsMetric.eventName) {
        throw new Error("Test metric is missing eventName");
      }
      await apiKeyClient.events.$post({
        json: {
          idempotencyKey: `unique-visitor-${i}-${Date.now()}`,
          eventName: uniqueVisitorsMetric.eventName,
          customerId: newCustomer.id,
          eventString: visitorIds[i],
          eventTimestamp: new Date().toISOString(),
        },
      });
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 8. Check entitlement: should be entitled with 3 unique visitors
    const firstCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: newCustomer.id, featureSlug: "unique-visitors" },
      query: { isExtCustId: "false" },
    });
    const firstCheckData = await firstCheckResp.json();
    if ("error" in firstCheckData) {
      throw new Error(`API Error: ${firstCheckData.error}`);
    }
    expect(firstCheckData.entitled).toBe(true);
    expect(firstCheckData.usages?.[0]?.usage).toBe(3);
    expect(firstCheckData.creditInfo?.creditsRemaining).toBe(2);

    // 9. Add more unique visitors to exceed the limit
    const additionalVisitors = ["visitor-4", "visitor-5", "visitor-6"];
    for (let i = 0; i < additionalVisitors.length; i++) {
      if (!uniqueVisitorsMetric.eventName) {
        throw new Error("Test metric is missing eventName");
      }
      await apiKeyClient.events.$post({
        json: {
          idempotencyKey: `additional-visitor-${i}-${Date.now()}`,
          eventName: uniqueVisitorsMetric.eventName,
          customerId: newCustomer.id,
          eventString: additionalVisitors[i],
          eventTimestamp: new Date().toISOString(),
        },
      });
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 10. Check entitlement again: should NOT be entitled with 6 unique visitors
    const secondCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: newCustomer.id, featureSlug: "unique-visitors" },
      query: { isExtCustId: "false" },
    });
    const secondCheckData = await secondCheckResp.json();
    if ("error" in secondCheckData) {
      throw new Error(`API Error: ${secondCheckData.error}`);
    }
    expect(secondCheckData.entitled).toBe(false);
    expect(secondCheckData.usages?.[0]?.usage).toBe(6);
    expect(secondCheckData.creditInfo?.creditsRemaining).toBe(0);
  });

  // Test complex SQL metrics with entitlements
  it("should determine entitlements based on complex SQL metrics", async () => {
    // Create API key for events
    const { secretKey } = await createTestApiKeys({
      merchantId: testMerchantId,
    });
    const apiKeyClient = createApiKeyClient(secretKey.rawKeyValue);

    // Create a new feature for testing complex SQL metrics
    const complexSqlFeature = await createTestFeatures(testMerchantId, 1, [
      {
        slug: "sql-complex-feature",
        description: "Feature with complex SQL metric",
        featureValue: 3, // This becomes meaningless - credits define limits
      },
    ]);

    // Create a complex SQL metric that checks for specific properties
    const metricData = {
      merchantId: testMerchantId,
      name: `Complex SQL Metric ${Date.now()}`,
      description: "A complex SQL metric for testing entitlements",
      queryType: "complex" as const,
      sqlDefinition: `
        SELECT COUNT(*)
        FROM filtered_events
        WHERE properties LIKE '%"tier":"premium"%'
      `,
    };

    // Create the metric using the metrics API
    const metricResponse = await client.metrics.$post({
      json: metricData,
    });
    expect(metricResponse.status).toBe(201);
    const metricResponseData = await metricResponse.json();
    if ("error" in metricResponseData) {
      throw new Error(`Failed to create metric: ${metricResponseData.error}`);
    }
    const complexSqlMetric = metricResponseData;

    // Update the feature to include this complex SQL metric
    await client.features[":featureId"].$put({
      param: { featureId: complexSqlFeature[0].id },
      json: { metricIds: [complexSqlMetric.id] },
    });

    // Create credit definition for this feature with 3 credits limit
    await createTestUsageCreditDefinition({
      merchantId: testMerchantId,
      planId: plan.id,
      featureId: complexSqlFeature[0].id,
      featureSlug: complexSqlFeature[0].slug,
      priceId: price.id,
      priceComponentId: price.pricingData.components.find(
        (c) => c.type === "fixed"
      )!.component_id!,
      currency: "USD",
      creditAmount: 3, // 3 premium events limit
      name: `${complexSqlFeature[0].slug} credits`,
      description: `Free 3 ${complexSqlFeature[0].slug} credits`,
      applicationType: "usage",
    });

    // Associate the feature with the subscription
    await createSubscriptionWithOverrides(testSubscriptionId, [
      complexSqlFeature[0],
    ]);

    // Process initial credits for this new feature
    await processInitialCreditsForSubscription(
      testMerchantId,
      testCustomerId,
      plan.id,
      testSubscriptionId
    );

    // Setup the subscription billing period
    const now = new Date();
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const subscriptionStartDate = new Date(now.getTime() - 10 * oneDayInMs);
    const previousBillingDate = new Date(now.getTime() - 5 * oneDayInMs);
    const nextBillingDate = new Date(now.getTime() + 25 * oneDayInMs);

    await db
      .update(subscriptionDetails)
      .set({
        subscriptionStartDate,
        previousBillingDate,
        nextBillingDate,
      })
      .where(eq(subscriptionDetails.subscriptionId, testSubscriptionId));

    // Create test events with different properties
    // First batch: Add events within the limit
    const eventsWithinLimit = [
      { tier: "basic", id: "event1" }, // Shouldn't count (not premium)
      { tier: "premium", id: "event2" }, // Should count
      { tier: "premium", id: "event3" }, // Should count
      { tier: "basic", id: "event4" }, // Shouldn't count (not premium)
    ];

    for (let i = 0; i < eventsWithinLimit.length; i++) {
      const event = {
        idempotencyKey: `complex-sql-test-${i}-${Date.now()}`,
        eventName: "test.complex.sql.event",
        customerId: testCustomerId,
        eventValue: 1,
        properties: eventsWithinLimit[i],
        subscriptionId: testSubscriptionId,
        eventTimestamp: new Date().toISOString(),
      };

      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check entitlement - should be entitled since we're within the limit
    // Only 2 premium events out of 4 total events
    const firstCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "sql-complex-feature" },
      query: { isExtCustId: "false" },
    });

    expect(firstCheckResp.status).toBe(200);
    const firstCheckData = await firstCheckResp.json();
    if ("error" in firstCheckData) {
      throw new Error(
        `Expected entitlements but got error: ${firstCheckData.error}`
      );
    }

    // Should be entitled with usage = 2 (only premium tier events count)
    expect(firstCheckData.entitled).toBe(true);
    expect(Array.isArray(firstCheckData.usages)).toBe(true);
    expect(firstCheckData.usages?.[0]?.usage).toBe(2);

    // Add events to exceed the limit
    const additionalEvents = [
      { tier: "premium", id: "event5" }, // Should count
      { tier: "premium", id: "event6" }, // Should count
      { tier: "basic", id: "event7" }, // Shouldn't count (not premium)
    ];

    for (let i = 0; i < additionalEvents.length; i++) {
      const event = {
        idempotencyKey: `complex-sql-additional-${i}-${Date.now()}`,
        eventName: "test.complex.sql.event",
        customerId: testCustomerId,
        eventValue: 1,
        properties: additionalEvents[i],
        subscriptionId: testSubscriptionId,
        eventTimestamp: new Date().toISOString(),
      };

      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check entitlement again - should not be entitled since we've exceeded the limit
    const secondCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "sql-complex-feature" },
      query: { isExtCustId: "false" },
    });

    expect(secondCheckResp.status).toBe(200);
    const secondCheckData = await secondCheckResp.json();
    if ("error" in secondCheckData) {
      throw new Error(
        `Expected entitlements but got error: ${secondCheckData.error}`
      );
    }

    // Should not be entitled with usage = 4 (premium tier events)
    expect(secondCheckData.entitled).toBe(false);
    expect(Array.isArray(secondCheckData.usages)).toBe(true);
    expect(secondCheckData.usages?.[0]?.usage).toBe(4);

    // Verify the metric value directly through the metrics API
    const metricValueResponse = await client.metrics[":id"].value.$get({
      param: { id: complexSqlMetric.id },
      query: {
        customerId: testCustomerId,
        timeframe: JSON.stringify({
          type: "ABSOLUTE",
          start: previousBillingDate.toISOString(),
          end: nextBillingDate.toISOString(),
        }),
      },
    });

    expect(metricValueResponse.status).toBe(200);
    const metricValue = await metricValueResponse.json();
    if ("error" in metricValue) {
      throw new Error(`API returned error: ${metricValue.error}`);
    }

    // The direct metric value should match what's shown in the entitlements
    expect(metricValue.value).toBe(4); // 4 premium tier events
  });

  // Multiple metrics on a feature should yield entitled=null
  it("should return null entitlement when multiple metrics attached", async () => {
    const numFeat = testFeatures.find((f) => f.slug === "storage-limit");
    expect(numFeat).toBeDefined();
    // Create two metrics and attach both
    const m1 = await createTestMetric({ merchantId: testMerchantId });
    const m2 = await createTestMetric({ merchantId: testMerchantId });
    await client.features[":featureId"].$put({
      param: { featureId: numFeat!.id },
      json: { metricIds: [m1.id, m2.id] },
    });
    // No events submitted -> usages length 2 but no context -> entitled null
    const resp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: { customerId: testCustomerId, featureSlug: "storage-limit" },
      query: { isExtCustId: "false" },
    });
    expect(resp.status).toBe(200);
    const d = await resp.json();
    if ("error" in d) {
      throw new Error(`Expected entitlements but got error: ${d.error}`);
    }
    expect(d.entitled).toBeNull();
    expect(Array.isArray(d.usages)).toBe(true);
    expect(d.usages!.length).toBe(2);
  });

  // Test using external platform user ID
  it("should get entitlements using the external customer ID", async () => {
    // Create customer with externalCustomerId
    const externalCustomerId = `external-${Date.now()}`;
    const customer = await createTestCustomer({
      merchantId: testMerchantId,
      name: "External ID Test Customer",
      email: `external_id_test_${Date.now()}@example.com`,
      externalCustomerId,
    });

    // Create a subscription for this customer
    const { plan, price } = await createPlanWithDefinedFeatures(
      testMerchantId,
      testFeatures,
      {
        planName: "External ID Test Plan",
        planDescription: "A plan for testing external IDs",
      }
    );

    if (!price) {
      throw new Error("Price was not created");
    }

    // Create subscription
    await createBasicSubscription(
      testMerchantId,
      customer.id, // this is the internal customer ID
      plan.id,
      price.id
    );

    // First test with isExtCustId=true (default) - should work with external ID
    const extIdResponse = await client.entitlements[":customerId"].$get({
      param: { customerId: externalCustomerId },
      query: { isExtCustId: "true" },
    });

    expect(extIdResponse.status).toBe(200);
    const extIdData = await extIdResponse.json();

    // Should have entitlements array
    expect(extIdData).toHaveProperty("entitlements");
    if ("error" in extIdData) {
      throw new Error(
        `Expected entitlements but got error: ${extIdData.error}`
      );
    }
    expect(Array.isArray(extIdData.entitlements)).toBe(true);

    // Should contain all 4 features
    expect(extIdData.entitlements.length).toBe(4);

    // Test a specific feature endpoint with external ID
    const specificFeatureResp = await client.entitlements[
      ":customerId"
    ].feature[":featureSlug"].$get({
      param: {
        customerId: externalCustomerId,
        featureSlug: "premium-support",
      },
      query: { isExtCustId: "true" }, // explicitly use external ID
    });

    expect(specificFeatureResp.status).toBe(200);
    const featureData = await specificFeatureResp.json();

    if ("error" in featureData) {
      throw new Error(
        `Expected entitlements but got error: ${featureData.error}`
      );
    }

    // Verify the correct feature was returned
    expect(featureData.feature).toHaveProperty("slug", "premium-support");
    expect(featureData.source).toBe("plan");

    // Test batch feature check with external ID
    const batchResp = await client.entitlements[":customerId"].features.$post({
      param: { customerId: externalCustomerId },
      json: { featureSlugs: ["premium-support", "max-users"] },
      query: { isExtCustId: "true" },
    });

    expect(batchResp.status).toBe(200);
    const batchData = await batchResp.json();

    if ("error" in batchData) {
      throw new Error(
        `Expected entitlements but got error: ${batchData.error}`
      );
    }

    expect(Array.isArray(batchData.entitlements)).toBe(true);
    expect(batchData.entitlements.length).toBe(2);
  });

  // Test metrics with external customer ID
  it("should track metrics correctly for customers identified by external ID", async () => {
    // Create customer with externalCustomerId
    const externalCustomerId = `ext-metric-test-${Date.now()}`;
    const customer = await createTestCustomer({
      merchantId: testMerchantId,
      name: "External Metrics Test Customer",
      email: `ext_metrics_test_${Date.now()}@example.com`,
      externalCustomerId,
    });

    // Create a subscription for this customer
    const { plan, price } = await createPlanWithDefinedFeatures(
      testMerchantId,
      [testFeatures.find((f) => f.slug === "max-users")!], // Just use max-users feature
      {
        planName: "External Metrics Test Plan",
        planDescription: "A plan for testing external ID metrics",
      }
    );

    if (!price) {
      throw new Error("Price was not created");
    }

    // Create subscription
    const subscription = await createBasicSubscription(
      testMerchantId,
      customer.id, // Internal ID
      plan.id,
      price.id
    );

    // Set up subscription details with billing dates for metric timeframe
    const now = new Date();
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const subscriptionStartDate = new Date(now.getTime() - 30 * oneDayInMs);
    const previousBillingDate = new Date(now.getTime() - 15 * oneDayInMs);
    const nextBillingDate = new Date(now.getTime() + 15 * oneDayInMs);

    await db
      .update(subscriptionDetails)
      .set({
        subscriptionId: subscription.id,
        nextBillingDate,
        subscriptionStartDate,
        previousBillingDate,
        cyclesBilled: 1,
      })
      .where(
        and(
          eq(subscriptionDetails.subscriptionId, subscription.id),
          eq(
            subscriptionDetails.componentId,
            price.pricingData.components.find((c) => c.type === "fixed")!
              .component_id!
          )
        )
      );

    // Create API key for sending events
    const { secretKey } = await createTestApiKeys({
      merchantId: testMerchantId,
    });

    // Let's create two test features - one with positive value (entitled) and one with negative value (not entitled)
    const slugBase = `ext-test-feature-${Date.now()}`;

    // First feature - positive value that should show as entitled
    const entitledFeature = await createTestFeatures(testMerchantId, 1, [
      {
        slug: `${slugBase}-entitled`,
        description: "Custom feature for external ID test - entitled",
        featureValue: true,
      },
    ]);

    // Second feature - negative value (false) that should show as NOT entitled
    const notEntitledFeature = await createTestFeatures(testMerchantId, 1, [
      {
        slug: `${slugBase}-not-entitled`,
        description: "Custom feature for external ID test - not entitled",
        featureValue: false,
      },
    ]);

    // Add both features to the subscription
    await createSubscriptionWithOverrides(subscription.id, [
      entitledFeature[0],
      notEntitledFeature[0],
    ]);

    // 1. Check the entitled feature with internal ID
    const entitledInternalResp = await client.entitlements[
      ":customerId"
    ].feature[":featureSlug"].$get({
      param: {
        customerId: customer.id,
        featureSlug: entitledFeature[0].slug,
      },
      query: { isExtCustId: "false" },
    });

    expect(entitledInternalResp.status).toBe(200);
    const entitledInternalData = await entitledInternalResp.json();
    if ("error" in entitledInternalData) {
      throw new Error(
        `Expected entitlements but got error: ${entitledInternalData.error}`
      );
    }

    // Boolean feature with value=true should be entitled=true
    expect(entitledInternalData.entitled).toBe(true);
    expect(entitledInternalData.feature).toHaveProperty(
      "slug",
      entitledFeature[0].slug
    );
    expect(entitledInternalData.feature).toHaveProperty("value", true);

    // 2. Check the not-entitled feature with internal ID
    const notEntitledInternalResp = await client.entitlements[
      ":customerId"
    ].feature[":featureSlug"].$get({
      param: {
        customerId: customer.id,
        featureSlug: notEntitledFeature[0].slug,
      },
      query: { isExtCustId: "false" },
    });

    expect(notEntitledInternalResp.status).toBe(200);
    const notEntitledInternalData = await notEntitledInternalResp.json();
    if ("error" in notEntitledInternalData) {
      throw new Error(
        `Expected entitlements but got error: ${notEntitledInternalData.error}`
      );
    }

    // Boolean feature with value=false should still have entitled=true but value=false
    expect(notEntitledInternalData.entitled).toBe(true);
    expect(notEntitledInternalData.feature).toHaveProperty(
      "slug",
      notEntitledFeature[0].slug
    );
    expect(notEntitledInternalData.feature).toHaveProperty("value", false);

    // 3. Check the entitled feature with external ID
    const entitledExternalResp = await client.entitlements[
      ":customerId"
    ].feature[":featureSlug"].$get({
      param: {
        customerId: externalCustomerId,
        featureSlug: entitledFeature[0].slug,
      },
      query: { isExtCustId: "true" },
    });

    expect(entitledExternalResp.status).toBe(200);
    const entitledExternalData = await entitledExternalResp.json();
    if ("error" in entitledExternalData) {
      throw new Error(
        `Expected entitlements but got error: ${entitledExternalData.error}`
      );
    }

    // Should match the internal ID result
    expect(entitledExternalData.entitled).toBe(true);
    expect(entitledExternalData.feature).toHaveProperty(
      "slug",
      entitledFeature[0].slug
    );
    expect(entitledExternalData.feature).toHaveProperty("value", true);

    // 4. Check the not-entitled feature with external ID
    const notEntitledExternalResp = await client.entitlements[
      ":customerId"
    ].feature[":featureSlug"].$get({
      param: {
        customerId: externalCustomerId,
        featureSlug: notEntitledFeature[0].slug,
      },
      query: { isExtCustId: "true" },
    });

    expect(notEntitledExternalResp.status).toBe(200);
    const notEntitledExternalData = await notEntitledExternalResp.json();
    if ("error" in notEntitledExternalData) {
      throw new Error(
        `Expected entitlements but got error: ${notEntitledExternalData.error}`
      );
    }

    // Should match the internal ID result
    expect(notEntitledExternalData.entitled).toBe(true);
    expect(notEntitledExternalData.feature).toHaveProperty(
      "slug",
      notEntitledFeature[0].slug
    );
    expect(notEntitledExternalData.feature).toHaveProperty("value", false);

    // 5. Verify the internal and external results match
    expect(entitledInternalData.entitled).toBe(entitledExternalData.entitled);
    expect(entitledInternalData.feature?.value).toBe(
      entitledExternalData.feature!.value
    );

    expect(notEntitledInternalData.entitled).toBe(
      notEntitledExternalData.entitled
    );
    expect(notEntitledInternalData.feature?.value).toBe(
      notEntitledExternalData.feature!.value
    );
  });

  // Test indexed SQL metrics with WHERE clause filtering event_value
  it("should determine entitlements based on indexed SQL metric with event_value filter", async () => {
    // Create API key for events
    const { secretKey } = await createTestApiKeys({
      merchantId: testMerchantId,
    });
    const apiKeyClient = createApiKeyClient(secretKey.rawKeyValue);

    // Create a new feature for testing SQL metrics with WHERE clause
    const sqlFilteredFeature = await createTestFeatures(testMerchantId, 1, [
      {
        slug: "sql-filtered-value-feature",
        description: "Feature with SQL indexed metric filtering event_value",
        featureValue: 15, // This becomes meaningless - credits define limits
      },
    ]);

    // Create an indexed SQL metric that sums only event_value > 5
    const metricData = {
      merchantId: testMerchantId,
      name: `SQL Indexed Filtered Value Metric ${Date.now()}`,
      description: "An indexed SQL metric filtering event_value > 5",
      queryType: "indexed" as const,
      sqlDefinition:
        "SELECT SUM(event_value) FROM filtered_events WHERE event_value > 5",
    };

    const metricResponse = await client.metrics.$post({
      json: metricData,
    });
    expect(metricResponse.status).toBe(201);
    const metricResponseData = await metricResponse.json();
    if ("error" in metricResponseData) {
      throw new Error(`Failed to create metric: ${metricResponseData.error}`);
    }
    const sqlFilteredMetric = metricResponseData;

    // Update the feature to include this SQL-based metric
    await client.features[":featureId"].$put({
      param: { featureId: sqlFilteredFeature[0].id },
      json: { metricIds: [sqlFilteredMetric.id] },
    });

    // Create credit definition for this feature with 15 credits limit
    await createTestUsageCreditDefinition({
      merchantId: testMerchantId,
      planId: plan.id,
      featureId: sqlFilteredFeature[0].id,
      featureSlug: sqlFilteredFeature[0].slug,
      priceId: price.id,
      priceComponentId: price.pricingData.components.find(
        (c) => c.type === "fixed"
      )!.component_id!,
      currency: "USD",
      creditAmount: 15, // 15 credits limit
      name: `${sqlFilteredFeature[0].slug} credits`,
      description: `Free 15 ${sqlFilteredFeature[0].slug} credits`,
      applicationType: "usage",
    });

    // Associate the feature with the subscription
    await createSubscriptionWithOverrides(testSubscriptionId, [
      sqlFilteredFeature[0],
    ]);

    // Process initial credits for this new feature
    await processInitialCreditsForSubscription(
      testMerchantId,
      testCustomerId,
      plan.id,
      testSubscriptionId
    );

    // Setup the subscription billing period
    const now = new Date();
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const subscriptionStartDate = new Date(now.getTime() - 10 * oneDayInMs);
    const previousBillingDate = new Date(now.getTime() - 5 * oneDayInMs);
    const nextBillingDate = new Date(now.getTime() + 25 * oneDayInMs);

    await db
      .update(subscriptionDetails)
      .set({
        subscriptionStartDate,
        previousBillingDate,
        nextBillingDate,
      })
      .where(eq(subscriptionDetails.subscriptionId, testSubscriptionId));

    // Create test events: some with value <= 5, some > 5
    const eventValues = [3, 7, 4, 8]; // Only 7 and 8 should be counted
    const expectedSumBelowLimit = 7 + 8; // = 15 (which is the limit)

    for (let i = 0; i < eventValues.length; i++) {
      const event = {
        idempotencyKey: `sql-filtered-value-test-${i}-${Date.now()}`,
        eventName: "test.sql.filtered.value.event",
        customerId: testCustomerId,
        eventValue: eventValues[i],
        subscriptionId: testSubscriptionId,
        eventTimestamp: new Date().toISOString(),
      };

      const r = await apiKeyClient.events.$post({ json: event });
      expect(r.status).toBe(202);
    }

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check entitlement - should be entitled, usage should be sum of values > 5
    const firstCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: {
        customerId: testCustomerId,
        featureSlug: sqlFilteredFeature[0].slug,
      },
      query: { isExtCustId: "false" },
    });

    expect(firstCheckResp.status).toBe(200);
    const firstCheckData = await firstCheckResp.json();
    if ("error" in firstCheckData) {
      throw new Error(
        `Expected entitlements but got error: ${firstCheckData.error}`
      );
    }

    // Usage should be 15 (7 + 8), which matches the limit. Should be NOT entitled.
    expect(firstCheckData.entitled).toBe(false);
    expect(Array.isArray(firstCheckData.usages)).toBe(true);
    expect(firstCheckData.usages?.[0]?.usage).toBe(expectedSumBelowLimit);

    // Add another event with value > 5 to exceed the limit
    const exceedingEventValue = 6;
    const expectedSumAboveLimit = expectedSumBelowLimit + exceedingEventValue; // 15 + 6 = 21
    const event = {
      idempotencyKey: `sql-filtered-value-exceed-${Date.now()}`,
      eventName: "test.sql.filtered.value.event",
      customerId: testCustomerId,
      eventValue: exceedingEventValue,
      subscriptionId: testSubscriptionId,
      eventTimestamp: new Date().toISOString(),
    };
    const r = await apiKeyClient.events.$post({ json: event });
    expect(r.status).toBe(202);

    // Wait for the event to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check entitlement again - should NOT be entitled now
    const secondCheckResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: {
        customerId: testCustomerId,
        featureSlug: sqlFilteredFeature[0].slug,
      },
      query: { isExtCustId: "false" },
    });

    expect(secondCheckResp.status).toBe(200);
    const secondCheckData = await secondCheckResp.json();
    if ("error" in secondCheckData) {
      throw new Error(
        `Expected entitlements but got error: ${secondCheckData.error}`
      );
    }

    // Usage should be 21, exceeding the limit of 15. Should not be entitled.
    expect(secondCheckData.entitled).toBe(false);
    expect(Array.isArray(secondCheckData.usages)).toBe(true);
    expect(secondCheckData.usages?.[0]?.usage).toBe(expectedSumAboveLimit);
  });

  // Test that entitled is false when usage exactly equals the entitlement limit
  it("should return entitled = false when usage exactly equals the limit", async () => {
    // Create API key for events
    const { secretKey } = await createTestApiKeys({
      merchantId: testMerchantId,
    });
    const apiKeyClient = createApiKeyClient(secretKey.rawKeyValue);

    // Clear out any existing events data for clean test state
    const cleanupQuery = sql`
      DELETE FROM ${events};
    `;
    await db.execute(cleanupQuery);

    // Create a new feature with exact limit
    const exactLimitFeature = await createTestFeatures(testMerchantId, 1, [
      {
        slug: `exact-limit-feature-${Date.now()}`,
        description: "Feature with exact numeric limit",
        featureValue: 10, // This becomes meaningless - credits define limits
      },
    ]);

    // Create a second feature for batch testing
    const secondExactLimitFeature = await createTestFeatures(
      testMerchantId,
      1,
      [
        {
          slug: `second-exact-limit-feature-${Date.now()}`,
          description: "Second feature with exact numeric limit",
          featureValue: 5, // This becomes meaningless - credits define limits
        },
      ]
    );

    // Create two separate metrics with unique event names
    const metric1 = await createTestMetric({
      merchantId: testMerchantId,
      aggregationType: "SUM",
      valueType: "NUMERIC",
      eventName: `test.exact.limit.feature1.${Date.now()}.${Math.random().toString(36).substring(2, 15)}`,
    });

    const metric2 = await createTestMetric({
      merchantId: testMerchantId,
      aggregationType: "SUM",
      valueType: "NUMERIC",
      eventName: `test.exact.limit.feature2.${Date.now()}.${Math.random().toString(36).substring(2, 15)}`,
    });

    // Update features to include their respective metrics
    await client.features[":featureId"].$put({
      param: { featureId: exactLimitFeature[0].id },
      json: { metricIds: [metric1.id] },
    });

    await client.features[":featureId"].$put({
      param: { featureId: secondExactLimitFeature[0].id },
      json: { metricIds: [metric2.id] },
    });

    // Create credit definitions for both features
    await createTestUsageCreditDefinition({
      merchantId: testMerchantId,
      planId: plan.id,
      featureId: exactLimitFeature[0].id,
      featureSlug: exactLimitFeature[0].slug,
      priceId: price.id,
      priceComponentId: price.pricingData.components.find(
        (c) => c.type === "fixed"
      )!.component_id!,
      currency: "USD",
      creditAmount: 10, // 10 credits limit
      name: `${exactLimitFeature[0].slug} credits`,
      description: `Free 10 ${exactLimitFeature[0].slug} credits`,
      applicationType: "usage",
    });

    await createTestUsageCreditDefinition({
      merchantId: testMerchantId,
      planId: plan.id,
      featureId: secondExactLimitFeature[0].id,
      featureSlug: secondExactLimitFeature[0].slug,
      priceId: price.id,
      priceComponentId: price.pricingData.components.find(
        (c) => c.type === "fixed"
      )!.component_id!,
      currency: "USD",
      creditAmount: 5, // 5 credits limit
      name: `${secondExactLimitFeature[0].slug} credits`,
      description: `Free 5 ${secondExactLimitFeature[0].slug} credits`,
      applicationType: "usage",
    });

    // Associate the features with the subscription
    await createSubscriptionWithOverrides(testSubscriptionId, [
      exactLimitFeature[0],
      secondExactLimitFeature[0],
    ]);

    // Process initial credits for these new features
    await processInitialCreditsForSubscription(
      testMerchantId,
      testCustomerId,
      plan.id,
      testSubscriptionId
    );

    // Setup the subscription billing period
    const now = new Date();
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const subscriptionStartDate = new Date(now.getTime() - 10 * oneDayInMs);
    const previousBillingDate = new Date(now.getTime() - 5 * oneDayInMs);
    const nextBillingDate = new Date(now.getTime() + 25 * oneDayInMs);

    await db
      .update(subscriptionDetails)
      .set({
        subscriptionStartDate,
        previousBillingDate,
        nextBillingDate,
      })
      .where(eq(subscriptionDetails.subscriptionId, testSubscriptionId));

    // Send events with usage exactly equal to the limits
    if (!metric1.eventName || !metric2.eventName) {
      throw new Error("Test metrics are missing eventNames");
    }

    // First event with value 10 for first feature
    const firstEvent = {
      idempotencyKey: `exact-limit-test-1-${Date.now()}`,
      eventName: metric1.eventName,
      customerId: testCustomerId,
      eventValue: 10, // Send exactly the limit for first feature
      subscriptionId: testSubscriptionId,
      eventTimestamp: new Date().toISOString(),
    };

    // Second event with value 5 for second feature
    const secondEvent = {
      idempotencyKey: `exact-limit-test-2-${Date.now()}`,
      eventName: metric2.eventName,
      customerId: testCustomerId,
      eventValue: 5, // Send exactly the limit for second feature
      subscriptionId: testSubscriptionId,
      eventTimestamp: new Date().toISOString(),
    };

    // Send both events
    await apiKeyClient.events.$post({ json: firstEvent });
    await apiKeyClient.events.$post({ json: secondEvent });

    // Wait for events to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 1. TEST SINGLE FEATURE ENDPOINT
    // Check entitlement for the first feature - should NOT be entitled since usage = limit
    const singleFeatureResp = await client.entitlements[":customerId"].feature[
      ":featureSlug"
    ].$get({
      param: {
        customerId: testCustomerId,
        featureSlug: exactLimitFeature[0].slug,
      },
      query: { isExtCustId: "false" },
    });

    expect(singleFeatureResp.status).toBe(200);
    const singleFeatureData = await singleFeatureResp.json();
    if ("error" in singleFeatureData) {
      throw new Error(
        `Expected entitlements but got error: ${singleFeatureData.error}`
      );
    }

    // Verify entitled is false when usage exactly equals the limit for single feature endpoint
    expect(singleFeatureData.entitled).toBe(false);
    expect(Array.isArray(singleFeatureData.usages)).toBe(true);
    expect(singleFeatureData.usages?.[0]?.usage).toBe(10);

    // 2. TEST ALL ENTITLEMENTS ENDPOINT
    // Get all entitlements - both features should show not entitled
    const allEntitlementsResp = await client.entitlements[":customerId"].$get({
      param: { customerId: testCustomerId },
      query: { isExtCustId: "false" },
    });

    expect(allEntitlementsResp.status).toBe(200);
    const allEntitlementsData = await allEntitlementsResp.json();
    if ("error" in allEntitlementsData) {
      throw new Error(
        `Expected entitlements but got error: ${allEntitlementsData.error}`
      );
    }

    // Find both features in the response
    const firstFeatureEntitlement = allEntitlementsData.entitlements.find(
      (ent) => ent.feature?.slug === exactLimitFeature[0].slug
    );
    const secondFeatureEntitlement = allEntitlementsData.entitlements.find(
      (ent) => ent.feature?.slug === secondExactLimitFeature[0].slug
    );

    // Verify both features show entitled = false in the all entitlements endpoint
    expect(firstFeatureEntitlement).toBeDefined();
    expect(firstFeatureEntitlement?.entitled).toBe(false);
    expect(firstFeatureEntitlement?.usages?.[0]?.usage).toBe(10);

    expect(secondFeatureEntitlement).toBeDefined();
    expect(secondFeatureEntitlement?.entitled).toBe(false);
    expect(secondFeatureEntitlement?.usages?.[0]?.usage).toBe(5);

    // 3. TEST BATCH FEATURES ENDPOINT
    // Check batch entitlements for both features
    const batchResp = await client.entitlements[":customerId"].features.$post({
      param: { customerId: testCustomerId },
      json: {
        featureSlugs: [
          exactLimitFeature[0].slug,
          secondExactLimitFeature[0].slug,
        ],
      },
      query: { isExtCustId: "false" },
    });

    expect(batchResp.status).toBe(200);
    const batchData = await batchResp.json();
    if ("error" in batchData) {
      throw new Error(
        `Expected entitlements but got error: ${batchData.error}`
      );
    }

    // Verify entitled = false for both features in the batch response
    expect(Array.isArray(batchData.entitlements)).toBe(true);
    expect(batchData.entitlements.length).toBe(2);

    const batchFirstFeature = batchData.entitlements.find(
      (ent) => ent.feature?.slug === exactLimitFeature[0].slug
    );
    const batchSecondFeature = batchData.entitlements.find(
      (ent) => ent.feature?.slug === secondExactLimitFeature[0].slug
    );

    expect(batchFirstFeature).toBeDefined();
    expect(batchFirstFeature?.entitled).toBe(false);
    expect(batchFirstFeature?.usages?.[0]?.usage).toBe(10);

    expect(batchSecondFeature).toBeDefined();
    expect(batchSecondFeature?.entitled).toBe(false);
    expect(batchSecondFeature?.usages?.[0]?.usage).toBe(5);
  });
});
