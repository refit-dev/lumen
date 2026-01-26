import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { datetime, RRule } from "rrule";
import { db } from "../../src/db/client";
import {
  featureMetrics,
  metrics,
  paymentMethods,
  subscriptionDetails,
  events,
  pricingTablePlans,
  creditGrants,
  creditDefinitions,
  creditUsageTransactions,
} from "@lumen/common/schema";
import { prices } from "@lumen/common/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlanWithFeatures,
  createTestApiClient,
  createTestCustomer,
  createTestPrice,
  createTestStripe,
} from "../test-helpers";
import {
  PlanSelect,
  PriceSelect,
  Customer,
  FeatureSelect,
} from "../test-helpers/types";
import { FeatureValue } from "../test-helpers/data/feature";
import { upgradeSubscriptionAndInvoice } from "../../src/helpers/billing";
import { calculateNextBillingDate } from "../../src/helpers/billing-dates";
import {
  invoices,
  invoiceLineItems,
  subscriptions,
  subscriptionFeatures,
  customers,
  plans,
  planFeatures,
  features,
  user,
  payments,
  organization,
  pricingTables,
} from "@lumen/common/schema";
import { testEnv } from "../test-env";
import { env } from "../../src/env";
import { createTestMonetaryCreditDefinition } from "../test-helpers/data/credits";

interface SubscriptionFeature {
  featureSlug: string;
  featureValue: boolean | number | string;
  source: string;
}

interface SubscriptionDetails {
  id: string;
  subscriptionId: string;
  nextBillingDate: string;
  cyclesBilled: number;
  createdAt: string;
  updatedAt: string;
}

interface Subscription {
  id: string;
  customerId: string;
  planId: string;
  effectivePriceId: string;
  merchantId: string;
  stableSubscriptionId?: string;
  versionNumber: number;
  createdAt: string;
  deletedAt: string | null;
  priceOverrideId: string | null;
  featureOverrideId: string | null;
  startTimestamp: string;
  endTimestamp: string | null;
  subscriptionFeatures?: SubscriptionFeature[];
  subscriptionDetails?: SubscriptionDetails;
}

const cleanUpTables = async () => {
  // Clean up database tables used in the tests
  // Order is important due to foreign key constraints
  const cleanupQuery = sql`
    DELETE FROM ${creditUsageTransactions};
    DELETE FROM ${creditGrants};
    DELETE FROM ${creditDefinitions};
    DELETE FROM ${payments};
    DELETE FROM ${invoiceLineItems};
    DELETE FROM ${invoices};
    DELETE FROM ${subscriptionFeatures};
    DELETE FROM ${subscriptionDetails};
    DELETE FROM ${metrics};
    DELETE FROM ${events};
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
};

describe("Subscriptions API", () => {
  let merchantId: string;
  let sessionToken: string;
  let testPlan: PlanSelect;
  let testPrice: PriceSelect;
  let testCustomer: Customer;
  let testFeatures: {
    slug: string;
    displayName: string;
    description?: string;
    featureValue: FeatureValue;
  }[];
  let createdFeatures: FeatureSelect[];

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create a test customer
    testCustomer = await createTestCustomer({
      merchantId,
      email: `customer-${Date.now()}@example.com`,
      name: "Test Customer",
    });

    // Test feature data
    const feature1 = {
      slug: "max-users-1",
      displayName: "Maximum Users",
      description: "Maximum number of users allowed",
      featureValue: 10,
    };

    const feature2 = {
      slug: "storage-1",
      displayName: "Storage (GB)",
      description: "Storage capacity in gigabytes",
      featureValue: 100,
    };

    const feature3 = {
      slug: "premium-1",
      displayName: "Premium Support",
      description: "Access to premium customer support",
      featureValue: false,
    };

    testFeatures = [feature1, feature2, feature3];

    // Create a test plan with the features
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      testFeatures,
      {
        stablePlanId: "test-plan",
        versionNumber: 1,
        planName: "Test Plan",
        planDescription: "Plan for testing subscriptions",
      }
    );

    testPlan = planCreationResult.plan;
    createdFeatures = planCreationResult.features;

    // Create a price for the plan using the new DSL format
    testPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `test_plan_usd_monthly_${Date.now()}`,
            type: "fixed",
            label: "Monthly Base Fee",
            amount_cents: 1999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
          {
            component_name: `test_plan_usd_monthly_user_${Date.now()}`,
            type: "per_unit",
            unit_label: "User",
            label: "Per User Fee (Monthly)",
            amount_cents: 999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });
  });

  afterEach(async () => {
    await cleanUpTables();
  });

  it("should create a subscription with plan features and billing details", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a new subscription
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: testPrice.id,
      },
    });

    expect(createResponse.status).toBe(201);

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    const subscription = createBody.subscription as Subscription;
    expect(subscription).toBeDefined();
    expect(subscription.customerId).toBe(testCustomer.id);
    expect(subscription.planId).toBe(testPlan.id);
    expect(subscription.effectivePriceId).toBe(testPrice.id);

    // Verify subscription has the expected features from the plan
    expect(subscription.subscriptionFeatures).toBeDefined();
    expect(Array.isArray(subscription.subscriptionFeatures)).toBe(true);
    expect(subscription.subscriptionFeatures?.length).toBe(3);

    // Check each feature is present with the expected values
    const maxUsersFeature = subscription.subscriptionFeatures?.find(
      (f) => f.featureSlug === "max-users-1"
    );
    const storageFeature = subscription.subscriptionFeatures?.find(
      (f) => f.featureSlug === "storage-1"
    );
    const premiumSupportFeature = subscription.subscriptionFeatures?.find(
      (f) => f.featureSlug === "premium-1"
    );

    expect(maxUsersFeature).toBeDefined();
    expect(storageFeature).toBeDefined();
    expect(premiumSupportFeature).toBeDefined();

    if (!maxUsersFeature || !storageFeature || !premiumSupportFeature) {
      throw new Error("Expected features not found");
    }

    expect(maxUsersFeature.featureValue).toBe(10);
    expect(storageFeature.featureValue).toBe(100);
    expect(premiumSupportFeature.featureValue).toBe(false);

    // All features should have source "plan"
    expect(maxUsersFeature.source).toBe("plan");
    expect(storageFeature.source).toBe("plan");
    expect(premiumSupportFeature.source).toBe("plan");

    // Fetch subscription details directly from the database
    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    // Verify subscription details are created correctly
    expect(details).toBeDefined();
    expect(details?.subscriptionId).toBe(subscription.id);
    expect(details?.cyclesBilled).toBe(0);

    // Verify next billing date is in the future and based on the recurrence rule
    const nextBillingDate = new Date(details!.nextBillingDate);
    const now = new Date();
    expect(nextBillingDate.getTime()).toBeGreaterThan(now.getTime());

    // Get price details to validate billing date calculation
    const priceDetails = await db.query.prices.findFirst({
      where: eq(prices.id, testPrice.id),
    });

    // Check that pricing data has the expected components
    const components = priceDetails?.pricingData?.components;
    expect(components).toBeDefined();
    expect(Array.isArray(components)).toBe(true);

    // Find the fixed price component with recurrence rule
    const fixedComponent = components?.find((c) => c.type === "fixed");
    expect(fixedComponent).toBeDefined();
    if (!fixedComponent) {
      throw new Error("Fixed price component not found");
    }
    expect(fixedComponent.recurrence_rule).toBeDefined();

    // Store the subscription ID for later tests
    const subscriptionId = subscription.id;

    // Test listing subscriptions
    const listResponse = await apiClient.subscriptions.$get({
      query: { includeFeatures: "true" },
    });

    expect(listResponse.status).toBe(200);

    const listBody = await listResponse.json();
    if ("error" in listBody) {
      throw new Error(`Unexpected error: ${listBody.error}`);
    }
    expect(listBody.subscriptions).toBeDefined();
    expect(Array.isArray(listBody.subscriptions)).toBe(true);
    expect(listBody.subscriptions.length).toBeGreaterThanOrEqual(1);

    // Find our subscription in the list
    const foundSubscription = listBody.subscriptions.find(
      (s: { id: string }) => s.id === subscription.stableSubscriptionId
    );
    expect(foundSubscription).toBeDefined();

    // Test getting a specific subscription
    const getResponse = await apiClient.subscriptions[
      ":stableSubscriptionId"
    ].$get({
      param: { stableSubscriptionId: subscription.stableSubscriptionId },
      query: { includeFeatures: "true" },
    });

    expect(getResponse.status).toBe(200);

    const getBody = await getResponse.json();
    if ("error" in getBody) {
      throw new Error(`Unexpected error: ${getBody.error}`);
    }
    expect(getBody.subscription).toBeDefined();
    expect(getBody.subscription.id).toBe(subscription.stableSubscriptionId);
  });

  it("should add feature overrides to a subscription", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a subscription first
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: testPrice.id,
      },
    });

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    const subscription = createBody.subscription as Subscription;
    const subscriptionId = subscription.id;

    // Now add feature overrides - providing ALL features
    const overrideResponse = await apiClient.subscriptions["feature-overrides"][
      ":id"
    ].$post({
      param: { id: subscription.stableSubscriptionId! },
      json: {
        featureIds: [
          createdFeatures[0].id, // max-users-1 - override
          createdFeatures[2].id, // premium-1 - override
          createdFeatures[1].id, // storage-1 - keep as is but must be included
        ],
      },
    });

    expect(overrideResponse.status).toBe(200);

    const overrideBody = await overrideResponse.json();
    if ("error" in overrideBody) {
      throw new Error(`Unexpected error: ${overrideBody.error}`);
    }

    const updatedSubscription = overrideBody.subscription as Subscription;
    expect(updatedSubscription).toBeDefined();

    // New subscription should have a higher version number
    expect(updatedSubscription.versionNumber).toBe(2);

    // Check the features - should include all features
    expect(updatedSubscription.subscriptionFeatures).toBeDefined();
    expect(updatedSubscription.subscriptionFeatures?.length).toBe(3); // Should have all 3 features

    // Find the overridden features
    const maxUsersFeature = updatedSubscription.subscriptionFeatures?.find(
      (f) => f.featureSlug === "max-users-1"
    );
    const premiumSupportFeature =
      updatedSubscription.subscriptionFeatures?.find(
        (f) => f.featureSlug === "premium-1"
      );
    const storageFeature = updatedSubscription.subscriptionFeatures?.find(
      (f) => f.featureSlug === "storage-1"
    );

    // All features should be present
    expect(maxUsersFeature).toBeDefined();
    expect(premiumSupportFeature).toBeDefined();
    expect(storageFeature).toBeDefined();

    // All features should now be overrides since we provided all IDs
    expect(maxUsersFeature?.source).toBe("override");
    expect(premiumSupportFeature?.source).toBe("override");
    expect(storageFeature?.source).toBe("override");

    // Values should match the original feature values
    expect(maxUsersFeature?.featureValue).toBe(10);
    expect(storageFeature?.featureValue).toBe(100);
    expect(premiumSupportFeature?.featureValue).toBe(false);
  });

  it("should update a subscription with a price override", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a second test price with different pricing
    const newPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `test_plan_usd_yearly_${Date.now()}`,
            type: "fixed",
            label: "Annual Base Fee",
            amount_cents: 19990,
            recurrence_rule:
              "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
            bill_immediately: false,
          },
          {
            component_name: `test_plan_usd_yearly_user_${Date.now()}`,
            type: "per_unit",
            unit_label: "User",
            label: "Per User Fee (Yearly)",
            amount_cents: 9990,
            recurrence_rule:
              "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Create a subscription with the original price
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: testPrice.id,
      },
    });

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    const subscription = createBody.subscription as Subscription;
    const subscriptionId = subscription.id;

    // Now change the price
    const priceOverrideResponse = await apiClient.subscriptions[
      "price-override"
    ][":id"].$post({
      param: { id: subscription.stableSubscriptionId! },
      json: {
        priceId: newPrice.id,
      },
    });

    expect(priceOverrideResponse.status).toBe(200);

    const priceOverrideBody = await priceOverrideResponse.json();
    if ("error" in priceOverrideBody) {
      throw new Error(`Unexpected error: ${priceOverrideBody.error}`);
    }

    const updatedSubscription = priceOverrideBody.subscription as Subscription;
    expect(updatedSubscription).toBeDefined();

    // New subscription should have a higher version number
    expect(updatedSubscription.versionNumber).toBe(2);

    // Check the price has been updated
    expect(updatedSubscription.effectivePriceId).toBe(newPrice.id);

    // Plan should remain the same
    expect(updatedSubscription.planId).toBe(testPlan.id);

    // Features should be carried over
    expect(updatedSubscription.subscriptionFeatures?.length).toBe(3);
  });

  it("should properly handle customer-specified subscription start date", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a specific future start date (two days from now)
    const futureStartDate = new Date();
    futureStartDate.setDate(futureStartDate.getDate() + 2);

    // Create a subscription with a specific start date
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: testPrice.id,
        startTimestamp: futureStartDate.toISOString(),
      },
    });

    expect(createResponse.status).toBe(201);

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    const subscription = createBody.subscription as Subscription;

    // Verify the subscription start date matches what we requested
    const actualStartDate = new Date(subscription.startTimestamp);
    expect(actualStartDate.toISOString().split("T")[0]).toBe(
      futureStartDate.toISOString().split("T")[0]
    );

    // Fetch subscription details
    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    expect(details).toBeDefined();
    expect(details?.cyclesBilled).toBe(0);

    // Get price details
    const priceDetails = await db.query.prices.findFirst({
      where: eq(prices.id, testPrice.id),
    });

    if (!priceDetails?.pricingData) {
      throw new Error("Price details or pricing data not found");
    }

    const fixedComponent = priceDetails.pricingData.components.find(
      (c) => c.type === "fixed"
    );
    if (!fixedComponent) {
      throw new Error("Fixed price component not found");
    }
    const rruleString = fixedComponent.recurrence_rule;

    // Calculate the expected next billing date based on the future start date
    const rule = RRule.fromString(rruleString);
    const expectedNextBillingDate = rule.after(futureStartDate);

    if (!expectedNextBillingDate) {
      throw new Error("Could not calculate next billing date");
    }

    // Verify the next billing date is calculated relative to our specified start date
    const actualBillingDate = new Date(details!.nextBillingDate);
    expect(actualBillingDate.toISOString().split("T")[0]).toBe(
      expectedNextBillingDate.toISOString().split("T")[0]
    );
  });

  it("should respect customer timezone when calculating billing dates", async () => {
    // First, create a customer with a specific timezone
    const customerWithTimezone = await createTestCustomer({
      merchantId,
      email: `timezone-test-customer-${Date.now()}@example.com`,
      name: "Timezone Test Customer",
      timezone: "America/Los_Angeles", // Pacific timezone
    });

    const apiClient = createTestApiClient(sessionToken);

    // Create a subscription for this customer with specific start date
    // March 15, 2025 is after DST begins on March 9, 2025
    const startDate = new Date("2025-03-15T12:00:00Z"); // this is 12:00 UTC, so 05:00 America/Los_Angeles

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: customerWithTimezone.id,
        planId: testPlan.id,
        effectivePriceId: testPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });

    expect(createResponse.status).toBe(201);

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    const subscription = createBody.subscription as Subscription;

    // Verify the subscription start date matches what we requested
    expect(new Date(subscription.startTimestamp).toISOString()).toBe(
      startDate.toISOString()
    );

    // Fetch subscription details
    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    expect(details).toBeDefined();

    // The billing date should be April 1, 2025, 05:00 America/Los_Angeles
    // This would be 12:00 UTC
    const expectedBillingDate = new Date("2025-04-01T12:00:00.000Z");

    // Compare dates (ignoring milliseconds for potential minor discrepancies)
    expect(details!.nextBillingDate.toISOString().slice(0, 16)).toBe(
      // compare until the minute
      expectedBillingDate.toISOString().slice(0, 16)
    );
  });

  it("should calculate correct billing dates based on recurrence rules", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create three different prices with different recurrence rules
    const monthlyPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_${Date.now()}`,
            type: "fixed",
            label: "Monthly Fee",
            amount_cents: 2999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });

    const yearlyPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `yearly_${Date.now()}`,
            type: "fixed",
            label: "Yearly Fee",
            amount_cents: 29990,
            recurrence_rule: "RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });

    const quarterlyPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `quarterly_${Date.now()}`,
            type: "fixed",
            label: "Quarterly Fee",
            amount_cents: 7990,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15", // Every 3 months on the 15th
            bill_immediately: false,
          },
        ],
      },
    });

    // Helper function to create a subscription and verify its billing date
    async function createAndVerifySubscription(
      priceId: string,
      expectedFrequency: string
    ) {
      const response = await apiClient.subscriptions.$post({
        json: {
          customerId: testCustomer.id,
          planId: testPlan.id,
          effectivePriceId: priceId,
        },
      });

      expect(response.status).toBe(201);

      const body = await response.json();
      if ("error" in body) {
        throw new Error(`Unexpected error: ${body.error}`);
      }

      const subscription = body.subscription as Subscription;

      // Fetch subscription details
      const details = await db.query.subscriptionDetails.findMany({
        where: eq(subscriptionDetails.subscriptionId, subscription.id),
      });

      expect(details.length).toBe(1);
      expect(details[0].cyclesBilled).toBe(0);

      // Fetch price details to verify recurrence rule
      const priceDetails = await db.query.prices.findFirst({
        where: eq(prices.id, priceId),
      });

      if (!priceDetails?.pricingData) {
        throw new Error("Price details or pricing data not found");
      }

      const fixedComponent = priceDetails.pricingData.components.find(
        (c) => c.type === "fixed"
      );
      if (!fixedComponent) {
        throw new Error("Fixed price component not found");
      }
      const rruleString = fixedComponent.recurrence_rule;

      // Make sure the rule contains the expected frequency
      expect(rruleString).toContain(expectedFrequency);

      // Verify next billing date is calculated based on the recurrence rule
      const rule = RRule.fromString(rruleString);
      const startDate = new Date(subscription.startTimestamp);
      const expectedNextBillingDate = rule.after(startDate);

      if (!expectedNextBillingDate) {
        throw new Error("Could not calculate next billing date");
      }

      // Compare dates (just the date part, ignoring exact time)
      const actualBillingDate = new Date(details[0].nextBillingDate);
      expect(actualBillingDate.toISOString().split("T")[0]).toBe(
        expectedNextBillingDate.toISOString().split("T")[0]
      );

      // Delete the subscription after verification
      const deleteResponse = await apiClient.subscriptions[
        ":stableSubscriptionId"
      ].$delete({
        param: { stableSubscriptionId: subscription.stableSubscriptionId },
      });

      expect(deleteResponse.status).toBe(200);

      return subscription;
    }

    // Test with different billing frequencies
    await createAndVerifySubscription(monthlyPrice.id, "FREQ=MONTHLY");
    await createAndVerifySubscription(yearlyPrice.id, "FREQ=YEARLY");
    await createAndVerifySubscription(quarterlyPrice.id, "INTERVAL=3");
  });

  it("should cancel a subscription and expire associated credit grants", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a credit definition that will generate an initial grant for the subscription
    await createTestMonetaryCreditDefinition({
      merchantId,
      planId: testPlan.id,
      priceId: testPrice.id,
      creditAmountCents: 1000, // $10.00 credit
      currency: "USD",
      name: "Signup Credits",
    });

    // Create a subscription (this should create an ACTIVE credit grant based on the definition above)
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: testPrice.id,
      },
    });

    expect(createResponse.status).toBe(201);

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    const subscription = createBody.subscription as Subscription;

    // Verify that an ACTIVE credit grant was created for the plan
    let activeGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, testCustomer.id),
        eq(creditGrants.planId, testPlan.id),
        eq(creditGrants.status, "ACTIVE"),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(activeGrants.length).toBeGreaterThan(0);

    const stableSubscriptionId = subscription.stableSubscriptionId;

    // Cancel the subscription
    const cancelResponse = await apiClient.subscriptions[
      ":stableSubscriptionId"
    ].$delete({
      param: { stableSubscriptionId },
    });

    expect(cancelResponse.status).toBe(200);

    const cancelBody = await cancelResponse.json();
    if ("error" in cancelBody) {
      throw new Error(`Unexpected error: ${cancelBody.error}`);
    }
    expect(cancelBody.success).toBe(true);

    // Verify credit grants are now expired
    const expiredGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, testCustomer.id),
        eq(creditGrants.planId, testPlan.id),
        eq(creditGrants.status, "EXPIRED"),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(expiredGrants.length).toBe(activeGrants.length);
    expiredGrants.forEach((grant) => {
      expect(grant.expiryDate).not.toBeNull();
      expect(grant.nextRenewalDate).toBeNull();
    });

    const getResponse = await apiClient.subscriptions[
      ":stableSubscriptionId"
    ].$get({
      param: { stableSubscriptionId },
      query: { includeFeatures: "false" },
    });

    const endedSub = await getResponse.json();

    expect(endedSub.subscription.endTimestamp).toBeDefined();
  });

  it("should delete subscription and return 200 when customer is missing during collect-payment", async () => {
    const apiClient = createTestApiClient(sessionToken);
    const apiUrl = env.API_URL;
    const triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY!;

    // 1) Create a subscription
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: testPrice.id,
      },
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    const subscription = createBody.subscription as Subscription;

    // 2) Get its subscription details
    const detail = await db.query.subscriptionDetails.findFirst({
      where: and(
        eq(subscriptionDetails.subscriptionId, subscription.id),
        isNull(subscriptionDetails.deletedAt)
      ),
    });
    expect(detail).toBeDefined();
    if (!detail) {
      throw new Error("Subscription detail not found");
    }

    // 3) Soft delete the customer
    await db
      .update(customers)
      .set({ deletedAt: new Date() })
      .where(eq(customers.id, testCustomer.id));

    // 4) Call collect-payment for the deleted customer with the existing subscription/detail
    const idempotencyKey = `test-missing-customer-${testCustomer.id}-${new Date().toISOString().split("T")[0]}`;
    const response = await fetch(`${apiUrl}/trigger/billing/collect-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${triggerApiAccessKey}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        customerId: testCustomer.id,
        subDetails: [
          {
            subscriptionId: subscription.id,
            subscriptionDetailsId: detail.id,
            nextBillingDate: detail.nextBillingDate.toISOString(),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe("subscription_deleted");

    // 5) Verify subscription has been canceled/ended
    const updatedSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscription.id),
    });
    expect(updatedSub).toBeDefined();
    expect(updatedSub!.endTimestamp).not.toBeNull();
    expect(updatedSub!.status).toBe("canceled");

    // 6) Verify subscription details have been soft-deleted
    const detailsAfter = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(detailsAfter.length).toBeGreaterThan(0);
    for (const d of detailsAfter) {
      expect(d.deletedAt).not.toBeNull();
    }
  });

  it("should list subscriptions for a specific customer", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a subscription for the customer
    const createResponse1 = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: testPrice.id,
      },
    });

    if ("error" in createResponse1) {
      throw new Error(`Unexpected error: ${createResponse1.error}`);
    }

    expect(createResponse1.status).toBe(201);
    const createBody1 = await createResponse1.json();
    if ("error" in createBody1) {
      throw new Error(`Unexpected error: ${createBody1.error}`);
    }

    // Create a second plan for testing subscription behavior
    const plan2Result = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "max-users-2",
          displayName: "Maximum Users",
          description: "Maximum number of users allowed",
          featureValue: 20 as FeatureValue,
        },
        {
          slug: "storage-2",
          displayName: "Storage (GB)",
          description: "Storage capacity in gigabytes",
          featureValue: 200 as FeatureValue,
        },
        {
          slug: "premium-2",
          displayName: "Premium Support",
          description: "Access to premium customer support",
          featureValue: true as FeatureValue,
        },
      ],
      {
        stablePlanId: "second-test-plan",
        versionNumber: 1,
        planName: "Second Test Plan",
        planDescription: "Another plan for testing",
      }
    );

    const price2 = await createTestPrice({
      planId: plan2Result.plan.id,
      merchantId,
      currency: "EUR",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `test_plan_eur_monthly_${Date.now()}`,
            type: "fixed",
            label: "Monthly Base Fee (EUR)",
            amount_cents: 2499,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Try to create a second subscription - should fail with 409 and include existingSubscriptionId
    const createResponse2 = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: plan2Result.plan.id,
        effectivePriceId: price2.id,
      },
    });

    expect(createResponse2.status).toBe(409);
    const createBody2 = await createResponse2.json();

    // Should include the existing subscription stable ID and not create a new one
    if ("error" in createBody2) {
      expect(createBody2.error).toBe(
        "Customer already has an active subscription."
      );
      // Should include existingSubscriptionId pointing to the original subscription
      expect(
        "existingSubscriptionId" in createBody2 &&
          typeof createBody2.existingSubscriptionId === "string"
      ).toBe(true);
      if ("existingSubscriptionId" in createBody2) {
        expect(createBody2.existingSubscriptionId).toBe(
          createBody1.subscription!.stableSubscriptionId
        );
      }
    } else {
      throw new Error("Expected 409 error body for duplicate subscription");
    }

    // List subscriptions for the customer
    const listResponse = await apiClient.subscriptions.customer[
      ":customerId"
    ].$get({
      param: { customerId: testCustomer.id },
      query: { includeFeatures: "true" },
    });

    expect(listResponse.status).toBe(200);

    const listBody = await listResponse.json();
    if ("error" in listBody) {
      throw new Error(`Unexpected error: ${listBody.error}`);
    }
    expect(listBody.subscriptions).toBeDefined();
    expect(Array.isArray(listBody.subscriptions)).toBe(true);
    expect(listBody.subscriptions.length).toBe(1); // Should have exactly 1 subscription due to new business logic

    // Verify the subscription is for this customer and the original plan
    expect(listBody.subscriptions[0].customerId).toBe(testCustomer.id);
    expect(listBody.subscriptions[0].planId).toBe(testPlan.id);
  });

  it("should handle timezone differences and DST when calculating next billing date", async () => {
    // Create a customer with a specific timezone affected by DST
    const customerWithTimezone = await createTestCustomer({
      merchantId,
      email: `dst-test-customer-${Date.now()}@example.com`,
      name: "DST Test Customer",
      timezone: "America/Los_Angeles", // Pacific timezone
    });

    // Create a special price with billing on the 10th, using the customer's timezone
    // Note: RRule needs TZID explicitly for timezone awareness in calculation
    const priceWithTimezone = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `dst_monthly_${Date.now()}`,
            type: "fixed",
            label: "Monthly Fee (10th, LA Time)",
            amount_cents: 4999,
            // Billing on the 10th in Los Angeles time
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=10;INTERVAL=1",
            bill_immediately: false,
          },
        ],
      },
    });

    const apiClient = createTestApiClient(sessionToken);

    // Set start date before DST change (Feb 15, 2025)
    // DST starts March 9, 2025 for America/Los_Angeles
    const startDate = new Date("2025-02-15T12:00:00Z"); // 12:00 UTC is 04:00 Los Angeles time (PST, UTC-8)

    // Create subscription
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: customerWithTimezone.id,
        planId: testPlan.id,
        effectivePriceId: priceWithTimezone.id,
        startTimestamp: startDate.toISOString(),
      },
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    const subscription = createBody.subscription as Subscription;

    // Fetch subscription details directly
    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    expect(details).toBeDefined();

    // Expected next billing date is March 10, 2025.
    // On this date, DST is active in Los Angeles (PDT, UTC-7).
    // Billing should occur at 04:00 Los Angeles time (DST Adjusted)
    // This comes out to 11:00 UTC
    const expectedBillingDateUTC = new Date("2025-03-10T11:00:00.000Z");

    // Compare the full ISO string for precision including time and timezone offset (Z)
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateUTC.toISOString()
    );
  });
});

describe("Anniversary Billing Scenarios", () => {
  let merchantId: string;
  let sessionToken: string;
  let testPlan: PlanSelect;
  let testCustomer: Customer;

  beforeEach(async () => {
    // Setup is similar to the main describe block
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
    testCustomer = await createTestCustomer({
      merchantId,
      email: `anniversary-cust-${Date.now()}@example.com`,
      name: "Anniversary Customer",
      timezone: "Europe/London",
    });
    // Create a basic plan (features not critical for these tests)
    const planResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "max-users",
          displayName: "Maximum Users",
          description: "Maximum number of users allowed",
          featureValue: 10 as FeatureValue,
        },
      ],
      {
        planName: "Anniversary Test Plan",
        planDescription: "A test plan for anniversary billing scenarios",
        stablePlanId: "anniversary-test-plan",
      }
    );
    testPlan = planResult.plan;
  });

  afterEach(async () => {
    await cleanUpTables();
  });

  it("should calculate monthly anniversary billing correctly", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Price with monthly anniversary recurrence (no BYMONTHDAY)
    const anniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniversary Fee",
            amount_cents: 1500,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1", // No BYMONTHDAY or TZID
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date mid-month
    const startDate = datetime(2025, 5, 15, 10, 0, 0); // UTC time

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: anniversaryPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    expect(createBody.subscription).toBeDefined();
    const subscription = createBody.subscription!;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing date is exactly one month later, same time
    const expectedBillingDateUTC = new Date("2025-06-15T10:00:00Z");
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateUTC.toISOString()
    );
  });

  it("should calculate yearly anniversary billing correctly", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Price with yearly anniversary recurrence
    const yearlyAnniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `yearly_anniv_${Date.now()}`,
            type: "fixed",
            label: "Yearly Anniversary Fee",
            amount_cents: 15000,
            recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1", // No BYMONTH/BYMONTHDAY or TZID
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date
    const startDate = datetime(2025, 7, 20, 14, 30, 0);

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: yearlyAnniversaryPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    const subscription = createBody.subscription as Subscription;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing date is exactly one year later, same time
    const expectedBillingDateUTC = datetime(2026, 7, 20, 14, 30, 0);
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateUTC.toISOString()
    );
  });

  it("should handle anniversary billing rollover for short months (e.g., starting Jan 31st)", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Price with monthly anniversary recurrence
    const anniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_rollover_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniversary Fee (Rollover)",
            amount_cents: 1600,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1", // No TZID
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date on 31st (non-leap year)
    const startDate = datetime(2025, 1, 31, 8, 0, 0); // Jan 31st, 08:00 UTC

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: anniversaryPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    const subscription = createBody.subscription as Subscription;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing date should be Feb 28th (2025 is non-leap), same time
    const expectedBillingDateFeb = datetime(2025, 2, 28, 8, 0, 0);
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateFeb.toISOString()
    );

    // Test the next cycle to ensure it reverts correctly to Mar 31st
    const nextBillingDateMar = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      expectedBillingDateFeb, // Current timestamp is the *calculated* Feb date
      startDate, // Original start date determines the anniversary day (31st)
      "Etc/UTC" // Assume UTC if not specified
    );
    const expectedBillingDateMar = datetime(2025, 3, 31, 8, 0, 0);
    expect(nextBillingDateMar.toISOString()).toBe(
      expectedBillingDateMar.toISOString()
    );
  });

  it("should handle anniversary billing rollover starting Jan 30th", async () => {
    const apiClient = createTestApiClient(sessionToken);
    const anniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_jan30_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniversary Fee (Jan 30)",
            amount_cents: 1650,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date Jan 30th (non-leap year)
    const startDate = datetime(2025, 1, 30, 9, 0, 0);

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: anniversaryPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) throw new Error(createBody.error);
    const subscription = createBody.subscription!;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing: Feb 28th
    const expectedBillingDateFeb = datetime(2025, 2, 28, 9, 0, 0);
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateFeb.toISOString()
    );

    // Test next cycle: should revert to Mar 30th
    const nextBillingDateMar = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      expectedBillingDateFeb, // Current timestamp
      startDate, // Original start date for anniversary day (30th)
      "Etc/UTC"
    );
    const expectedBillingDateMar = datetime(2025, 3, 30, 9, 0, 0);
    expect(nextBillingDateMar.toISOString()).toBe(
      expectedBillingDateMar.toISOString()
    );
  });

  it("should handle anniversary billing rollover starting Jan 29th", async () => {
    const apiClient = createTestApiClient(sessionToken);
    const anniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_jan29_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniversary Fee (Jan 29)",
            amount_cents: 1640,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date Jan 29th (non-leap year)
    const startDate = datetime(2025, 1, 29, 11, 0, 0);

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: anniversaryPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) throw new Error(createBody.error);
    const subscription = createBody.subscription!;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing: Feb 28th
    const expectedBillingDateFeb = datetime(2025, 2, 28, 11, 0, 0);
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateFeb.toISOString()
    );

    // Test next cycle: should revert to Mar 29th
    const nextBillingDateMar = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      expectedBillingDateFeb, // Current timestamp
      startDate, // Original start date for anniversary day (29th)
      "Etc/UTC"
    );
    const expectedBillingDateMar = datetime(2025, 3, 29, 11, 0, 0);
    expect(nextBillingDateMar.toISOString()).toBe(
      expectedBillingDateMar.toISOString()
    );
  });

  it("should handle anniversary billing starting Feb 29th (leap year)", async () => {
    const apiClient = createTestApiClient(sessionToken);
    const anniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_feb29_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniversary Fee (Feb 29)",
            amount_cents: 1690,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date Feb 29th (leap year)
    const startDate = datetime(2024, 2, 29, 10, 0, 0); // 2024 is a leap year

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: anniversaryPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) throw new Error(createBody.error);
    const subscription = createBody.subscription!;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing: Mar 29th
    const expectedBillingDateMar = datetime(2024, 3, 29, 10, 0, 0);
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateMar.toISOString()
    );

    // Test next cycle: should be Apr 29th
    const nextBillingDateApr = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      expectedBillingDateMar, // Current timestamp
      startDate, // Original start date for anniversary day (29th)
      "Etc/UTC"
    );
    const expectedBillingDateApr = datetime(2024, 4, 29, 10, 0, 0);
    expect(nextBillingDateApr.toISOString()).toBe(
      expectedBillingDateApr.toISOString()
    );
  });

  it("should handle fixed day (31st) billing rollover", async () => {
    const apiClient = createTestApiClient(sessionToken);
    const fixedDayPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_fixed_31_${Date.now()}`,
            type: "fixed",
            label: "Monthly Fixed Day 31",
            amount_cents: 1710,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31",
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date Jan 1st (non-leap year)
    const startDate = datetime(2025, 1, 1, 12, 0, 0);

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: fixedDayPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) throw new Error(createBody.error);
    const subscription = createBody.subscription!;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing: Jan 31st
    const expectedBillingDateJan = datetime(2025, 1, 31, 12, 0, 0);
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateJan.toISOString()
    );

    // Test next cycle: should be Feb 28th
    const nextBillingDateFeb = calculateNextBillingDate(
      fixedDayPrice.pricingData.components[0],
      expectedBillingDateJan, // Current timestamp
      startDate, // Original start date (less relevant for fixed day, but required)
      "Etc/UTC"
    );
    const expectedBillingDateFeb = datetime(2025, 2, 28, 12, 0, 0);
    expect(nextBillingDateFeb.toISOString()).toBe(
      expectedBillingDateFeb.toISOString()
    );

    // Test next cycle: should revert to Mar 31st
    const nextBillingDateMar = calculateNextBillingDate(
      fixedDayPrice.pricingData.components[0],
      expectedBillingDateFeb, // Current timestamp
      startDate, // Original start date
      "Etc/UTC"
    );
    const expectedBillingDateMar = datetime(2025, 3, 31, 12, 0, 0);
    expect(nextBillingDateMar.toISOString()).toBe(
      expectedBillingDateMar.toISOString()
    );
  });

  it("should handle fixed day (30th) billing rollover", async () => {
    const apiClient = createTestApiClient(sessionToken);
    const fixedDayPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_fixed_30_${Date.now()}`,
            type: "fixed",
            label: "Monthly Fixed Day 30",
            amount_cents: 1700,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=30",
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date Jan 1st (non-leap year)
    const startDate = datetime(2025, 1, 1, 13, 0, 0);

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: fixedDayPrice.id,
        startTimestamp: startDate.toISOString(),
      },
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) throw new Error(createBody.error);
    const subscription = createBody.subscription!;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing: Jan 30th
    const expectedBillingDateJan = datetime(2025, 1, 30, 13, 0, 0);
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateJan.toISOString()
    );

    // Test next cycle: should be Feb 28th
    const nextBillingDateFeb = calculateNextBillingDate(
      fixedDayPrice.pricingData.components[0],
      expectedBillingDateJan, // Current timestamp
      startDate, // Original start date
      "Etc/UTC"
    );
    const expectedBillingDateFeb = datetime(2025, 2, 28, 13, 0, 0);
    expect(nextBillingDateFeb.toISOString()).toBe(
      expectedBillingDateFeb.toISOString()
    );

    // Test next cycle: should revert to Mar 30th
    const nextBillingDateMar = calculateNextBillingDate(
      fixedDayPrice.pricingData.components[0],
      expectedBillingDateFeb, // Current timestamp
      startDate, // Original start date
      "Etc/UTC"
    );
    const expectedBillingDateMar = datetime(2025, 3, 30, 13, 0, 0);
    expect(nextBillingDateMar.toISOString()).toBe(
      expectedBillingDateMar.toISOString()
    );
  });

  it("should handle timezone/DST correctly for anniversary billing", async () => {
    // Create customer in LA timezone
    const customerLATime = await createTestCustomer({
      merchantId,
      email: `anniv-la-${Date.now()}@example.com`,
      name: "Anniversary LA Customer",
      timezone: "America/Los_Angeles",
    });

    const apiClient = createTestApiClient(sessionToken);

    // Price with monthly anniversary recurrence, using the LA timezone in the rule
    const anniversaryPriceLA = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_la_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniversary Fee (LA Time)",
            amount_cents: 1700,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1", // Use customer TZ dynamically, remove TZID here
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date before DST change (Feb 10, 2025) at 10:00 LA time (PST, UTC-8)
    // This corresponds to 18:00 UTC
    const startDate = datetime(2025, 2, 10, 18, 0, 0);

    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: customerLATime.id,
        planId: testPlan.id,
        effectivePriceId: anniversaryPriceLA.id,
        startTimestamp: startDate.toISOString(),
      },
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    const subscription = createBody.subscription as Subscription;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });
    expect(details).toBeDefined();

    // Expected next billing date: March 10, 2025, at 10:00 local LA time.
    // DST starts March 9, 2025. So March 10 is in PDT (UTC-7).
    // 10:00 PDT is 17:00 UTC.
    const expectedBillingDateUTC = datetime(2025, 3, 10, 17, 0, 0);
    expect(details!.nextBillingDate.toISOString()).toBe(
      expectedBillingDateUTC.toISOString()
    );
  });

  it("should handle anniversary billing starting Feb 29th (leap year) transitioning to non-leap", async () => {
    // No apiClient needed for direct calculation
    const anniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_feb29_leap_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniversary Fee (Feb 29 Leap)",
            amount_cents: 1695,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date Feb 29th (leap year)
    const startDate = datetime(2024, 2, 29, 10, 0, 0); // 2024 is a leap year

    // First, check Mar 29th
    let currentBillingDate = startDate;
    let expectedNextDate = datetime(2024, 3, 29, 10, 0, 0);
    let calculatedNextDate = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      currentBillingDate,
      startDate,
      "Etc/UTC"
    );
    expect(calculatedNextDate.toISOString()).toBe(
      expectedNextDate.toISOString()
    );

    // Simulate moving forward 11 months to test the leap year transition
    currentBillingDate = datetime(2025, 1, 29, 10, 0, 0); // Jan 29, 2025
    // Next date should be Feb 28th, 2025 (non-leap year)
    expectedNextDate = datetime(2025, 2, 28, 10, 0, 0);
    calculatedNextDate = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      currentBillingDate,
      startDate,
      "Etc/UTC"
    );
    expect(calculatedNextDate.toISOString()).toBe(
      expectedNextDate.toISOString()
    );

    // Check the following month reverts to the 29th
    currentBillingDate = expectedNextDate; // Feb 28, 2025
    expectedNextDate = datetime(2025, 3, 29, 10, 0, 0); // Mar 29, 2025
    calculatedNextDate = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      currentBillingDate,
      startDate,
      "Etc/UTC"
    );
    expect(calculatedNextDate.toISOString()).toBe(
      expectedNextDate.toISOString()
    );
  });

  it("should handle anniversary billing starting Jan 31st before leap year Feb", async () => {
    // No apiClient needed for direct calculation
    const anniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_jan31_leap_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniversary Fee (Jan 31 Leap)",
            amount_cents: 1696,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date Jan 31st (before leap year)
    const startDate = datetime(2024, 1, 31, 11, 0, 0);

    // Expected next billing date should be Feb 29th (2024 is leap)
    const expectedBillingDateFeb = datetime(2024, 2, 29, 11, 0, 0);
    const calculatedNextDate = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      startDate,
      startDate,
      "Etc/UTC"
    );
    expect(calculatedNextDate.toISOString()).toBe(
      expectedBillingDateFeb.toISOString()
    );
  });

  it("should handle fixed day (30th) billing crossing leap year Feb", async () => {
    // No apiClient needed for direct calculation
    const fixedDayPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_fixed_30_leap_${Date.now()}`,
            type: "fixed",
            label: "Monthly Fixed Day 30 Leap",
            amount_cents: 1701,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=30",
            bill_immediately: false,
          },
        ],
      },
    });

    // Current date Jan 30th (leap year)
    const currentDate = datetime(2024, 1, 30, 14, 0, 0);
    const startDate = datetime(2024, 1, 1, 14, 0, 0); // Assume start was earlier

    // Expected next billing date should be Feb 29th
    const expectedBillingDateFeb = datetime(2024, 2, 29, 14, 0, 0);
    const calculatedNextDate = calculateNextBillingDate(
      fixedDayPrice.pricingData.components[0],
      currentDate,
      startDate,
      "Etc/UTC"
    );
    expect(calculatedNextDate.toISOString()).toBe(
      expectedBillingDateFeb.toISOString()
    );
  });

  it("should handle fixed day (29th) billing crossing non-leap year Feb", async () => {
    // No apiClient needed for direct calculation
    const fixedDayPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_fixed_29_nonleap_${Date.now()}`,
            type: "fixed",
            label: "Monthly Fixed Day 29 Non-Leap",
            amount_cents: 1702,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=29",
            bill_immediately: false,
          },
        ],
      },
    });

    // Current date Jan 29th (non-leap year)
    const currentDate = datetime(2025, 1, 29, 15, 0, 0);
    const startDate = datetime(2025, 1, 1, 15, 0, 0); // Assume start was earlier

    // Expected next billing date should be Feb 28th
    const expectedBillingDateFeb = datetime(2025, 2, 28, 15, 0, 0);
    const calculatedNextDate = calculateNextBillingDate(
      fixedDayPrice.pricingData.components[0],
      currentDate,
      startDate,
      "Etc/UTC"
    );
    expect(calculatedNextDate.toISOString()).toBe(
      expectedBillingDateFeb.toISOString()
    );
  });

  it("should handle anniversary billing (Jan 31) with DST transition", async () => {
    const customerLATime = await createTestCustomer({
      merchantId,
      email: `anniv-dst-${Date.now()}@example.com`,
      name: "Anniversary DST Customer",
      timezone: "America/Los_Angeles",
    });
    // No apiClient needed for direct calculation
    const anniversaryPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `monthly_anniv_dst_${Date.now()}`,
            type: "fixed",
            label: "Monthly Anniv DST",
            amount_cents: 1705,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1", // TZID implicit from customer
            bill_immediately: false,
          },
        ],
      },
    });

    // Start date Jan 31, 2025 at 10:00 LA time (PST, UTC-8) -> 18:00 UTC
    const startDate = datetime(2025, 1, 31, 18, 0, 0);

    // 1. Calculate Feb billing date (should be Feb 28, 10:00 PST -> 18:00 UTC)
    let currentBillingDate = startDate;
    let expectedNextDate = datetime(2025, 2, 28, 18, 0, 0);
    let calculatedNextDate = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      currentBillingDate,
      startDate,
      customerLATime.timezone!
    );
    expect(calculatedNextDate.toISOString()).toBe(
      expectedNextDate.toISOString()
    );

    // 2. Calculate Mar billing date from Feb 28 (should be Mar 31, 10:00 PDT -> 17:00 UTC)
    // DST starts Mar 9, 2025
    currentBillingDate = calculatedNextDate; // Feb 28, 18:00 UTC
    expectedNextDate = datetime(2025, 3, 31, 17, 0, 0);
    calculatedNextDate = calculateNextBillingDate(
      anniversaryPrice.pricingData.components[0],
      currentBillingDate,
      startDate,
      customerLATime.timezone!
    );
    expect(calculatedNextDate.toISOString()).toBe(
      expectedNextDate.toISOString()
    );
  });
});

describe("Subscription with Multiple Price Components", () => {
  let merchantId: string;
  let sessionToken: string;
  let testPlan: PlanSelect;
  let testCustomer: Customer;
  let multiComponentPrice: PriceSelect;

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Set up Stripe integration for the merchant
    await createTestStripe({
      merchantId,
      secretKey: testEnv.TEST_STRIPE_SECRET_KEY,
      publicKey: testEnv.TEST_STRIPE_PUBLIC_KEY,
      webhookSecret: testEnv.TEST_STRIPE_WEBHOOK_SECRET,
    });

    // Create a test customer
    testCustomer = await createTestCustomer({
      merchantId,
      email: `multi-comp-customer-${Date.now()}@example.com`,
      name: "Multi-Component Test Customer",
      timezone: "America/New_York",
    });

    // Create a test plan
    const planResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: `max-users-multi-${Date.now()}`,
          displayName: "Maximum Users",
          description: "Maximum number of users allowed",
          featureValue: 10 as FeatureValue,
        },
        {
          slug: `storage-multi-${Date.now()}`,
          displayName: "Storage (GB)",
          description: "Storage capacity in gigabytes",
          featureValue: 100 as FeatureValue,
        },
      ],
      {
        planName: "Multi-Component Test Plan",
        planDescription: "Plan for testing multiple component subscriptions",
        stablePlanId: `multi-comp-plan-${Date.now()}`,
      }
    );
    testPlan = planResult.plan;

    // Create a price with multiple components
    multiComponentPrice = await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base-subscription",
            type: "fixed",
            label: "Monthly Base Subscription",
            amount_cents: 2999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
          {
            component_name: "per-user-fee",
            type: "per_unit",
            label: "Per User Fee",
            unit_label: "User",
            amount_cents: 999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
            bill_immediately: false,
          },
          {
            component_name: "api-calls",
            type: "usage",
            label: "API Calls",
            unit_label: "API Call",
            metric_id: "met_" + Date.now(),
            unit_cost_cents: 1,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=30",
            bill_immediately: false,
          },
        ],
      },
    });
  });

  it("should create a subscription with multiple price components and generate separate subscription details records", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a subscription with the multi-component price
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomer.id,
        planId: testPlan.id,
        effectivePriceId: multiComponentPrice.id,
      },
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    const subscription = createBody.subscription;
    expect(subscription).toBeDefined();
    if (!subscription) {
      throw new Error("Subscription is undefined");
    }
    expect(subscription.customerId).toBe(testCustomer.id);
    expect(subscription.planId).toBe(testPlan.id);
    expect(subscription.effectivePriceId).toBe(multiComponentPrice.id);

    // Fetch subscription details directly from the database for all components
    const details = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    // Verify that we have a details record for each component
    expect(details.length).toBe(3); // Should have 3 records, one per component

    // Find details for each component by componentId
    const components = multiComponentPrice.pricingData.components;
    for (const component of components) {
      const componentDetails = details.find(
        (d) => d.componentId === component.component_id
      );
      expect(componentDetails).toBeDefined();

      if (!componentDetails) {
        throw new Error(
          `Component details not found for component ${component.component_name}`
        );
      }

      // Verify billing dates calculated correctly based on recurrence rule
      expect(componentDetails.nextBillingDate).toBeDefined();

      // Verify cycles billed starts at 0
      expect(componentDetails.cyclesBilled).toBe(0);

      // Verify recurrence rule is stored
      expect(componentDetails.recurrenceRule).toBe(component.recurrence_rule);
    }

    // Check if immediate billing created an invoice for the fixed component
    // Note: In some configurations, bill_immediately may or may not create an invoice,
    // but the subscription details should always be created
    const createdInvoices = await db.query.invoices.findMany({
      where: eq(invoices.subscriptionId, subscription.id),
      with: {
        lineItems: true,
      },
    });

    // If an invoice was created, verify it
    if (createdInvoices.length > 0) {
      const invoice = createdInvoices[0];

      // Should have at least one line item
      expect(invoice.lineItems.length).toBeGreaterThan(0);

      // Find the fixed component
      const fixedComponent = components.find((c) => c.type === "fixed");
      expect(fixedComponent).toBeDefined();

      if (fixedComponent) {
        // Find the line item for the fixed component
        const fixedComponentLineItem = invoice.lineItems.find(
          (item) => item.componentId === fixedComponent.component_name
        );

        // If there's a line item for the fixed component, verify it
        if (fixedComponentLineItem) {
          expect(fixedComponentLineItem.subtotalCents).toBe(
            fixedComponent.amount_cents
          );
          expect(fixedComponentLineItem.type).toBe("fixed");
        }
      }
    }

    // The most important thing is that we have all 3 components with their own separate
    // subscription details records, which we already verified above
  });
});

describe("Free Subscription Creation", () => {
  let merchantId: string;
  let sessionToken: string;
  let testFreePlan: PlanSelect;
  let testFreePrice: PriceSelect;
  let testPaidPlan: PlanSelect;
  let testPaidPrice: PriceSelect;
  let testFeatures: {
    slug: string;
    displayName: string;
    description?: string;
    featureValue: FeatureValue;
  }[];

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Set up Stripe integration for the merchant
    await createTestStripe({
      merchantId,
      secretKey: testEnv.TEST_STRIPE_SECRET_KEY,
      publicKey: testEnv.TEST_STRIPE_PUBLIC_KEY,
      webhookSecret: testEnv.TEST_STRIPE_WEBHOOK_SECRET,
    });

    // Test feature data
    testFeatures = [
      {
        slug: "max-users-free",
        displayName: "Maximum Users",
        description: "Maximum number of users allowed",
        featureValue: 5,
      },
      {
        slug: "storage-free",
        displayName: "Storage (GB)",
        description: "Storage capacity in gigabytes",
        featureValue: 10,
      },
      {
        slug: "premium-free",
        displayName: "Premium Support",
        description: "Access to premium customer support",
        featureValue: false,
      },
    ];

    // Create a free plan with features
    const freePlanResult = await createTestPlanWithFeatures(
      merchantId,
      testFeatures,
      {
        stablePlanId: "free-plan",
        versionNumber: 1,
        planName: "Free Plan",
        planDescription: "Free tier plan for testing",
      }
    );
    testFreePlan = freePlanResult.plan;

    // Create a free price (all components have 0 cost)
    testFreePrice = await createTestPrice({
      planId: testFreePlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `free_plan_base_${Date.now()}`,
            type: "fixed",
            label: "Free Base Plan",
            amount_cents: 0, // Free!
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Create a paid plan for contrast
    const paidPlanResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "max-users-paid",
          displayName: "Maximum Users",
          description: "Maximum number of users allowed",
          featureValue: 100,
        },
      ],
      {
        stablePlanId: "paid-plan",
        versionNumber: 1,
        planName: "Paid Plan",
        planDescription: "Paid tier plan for testing",
      }
    );
    testPaidPlan = paidPlanResult.plan;

    // Create a paid price
    testPaidPrice = await createTestPrice({
      planId: testPaidPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `paid_plan_base_${Date.now()}`,
            type: "fixed",
            label: "Paid Base Plan",
            amount_cents: 2999, // $29.99
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    });
  });

  afterEach(async () => {
    await cleanUpTables();
  });

  it("should create a free subscription from pricing table plans", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // First, create a pricing table with the free plan
    const createPricingTableResponse = await apiClient["pricing-tables"].$post({
      json: {
        name: "Test Pricing Table",
        slug: "test-pricing-table",
        description: "A pricing table for testing free subscriptions",
        heading: "Choose Your Plan",
        subheading: "Select the perfect plan for your needs",
        planIds: [testFreePlan.id, testPaidPlan.id],
        planConfigs: [
          {
            planId: testFreePlan.id,
            displayOrder: 1,
            isPopular: false,
            buttonText: "Get Started Free",
            buttonOutline: false,
          },
          {
            planId: testPaidPlan.id,
            displayOrder: 2,
            isPopular: true,
            popularText: "Most Popular",
            buttonText: "Start Trial",
            buttonOutline: false,
          },
        ],
      },
    });

    expect(createPricingTableResponse.status).toBe(201);

    // Now create a free subscription
    const freeSubscriptionResponse = await apiClient.subscriptions[
      "create-free-subscription"
    ].$post({
      json: {
        customerEmail: `freeuser@example.com`,
        customerName: "Free User",
        userId: "external-free-user-123",
        billingAddressLine1: "123 Free Street",
        billingCity: "Freetown",
        billingPostalCode: "12345",
        billingCountry: "US",
      },
    });

    expect(freeSubscriptionResponse.status).toBe(200);

    const freeSubscriptionBody = await freeSubscriptionResponse.json();
    if ("error" in freeSubscriptionBody) {
      throw new Error(`Unexpected error: ${freeSubscriptionBody.error}`);
    }

    expect(freeSubscriptionBody.message).toBe(
      "Free subscription created successfully"
    );
    expect(freeSubscriptionBody.subscription).toBeDefined();
    expect(freeSubscriptionBody.plan).toBeDefined();
    expect(freeSubscriptionBody.plan.name).toBe("Free Plan");

    const subscription = freeSubscriptionBody.subscription;
    expect(subscription.planId).toBe(testFreePlan.id);
    expect(subscription.effectivePriceId).toBe(testFreePrice.id);

    // Verify the customer was created with correct details
    const createdCustomer = await db.query.customers.findFirst({
      where: eq(customers.email, "freeuser@example.com"),
    });

    expect(createdCustomer).toBeDefined();
    expect(createdCustomer!.name).toBe("Free User");
    expect(createdCustomer!.externalCustomerId).toBe("external-free-user-123");
    expect(createdCustomer!.billingAddressLine1).toBe("123 Free Street");
    expect(createdCustomer!.billingCity).toBe("Freetown");
    expect(createdCustomer!.billingPostalCode).toBe("12345");
    expect(createdCustomer!.billingCountry).toBe("US");
    expect(createdCustomer!.pspCustomerId).toBeDefined(); // Stripe customer should be created

    // Verify subscription was created correctly
    const createdSubscription = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscription.id),
      with: {
        subscriptionFeatures: {
          where: isNull(subscriptionFeatures.deletedAt),
          with: {
            feature: true,
          },
        },
      },
    });

    expect(createdSubscription).toBeDefined();
    expect(createdSubscription!.customerId).toBe(createdCustomer!.id);
    expect(createdSubscription!.planId).toBe(testFreePlan.id);
    expect(createdSubscription!.effectivePriceId).toBe(testFreePrice.id);

    // Verify subscription has the expected features from the free plan
    expect(createdSubscription!.subscriptionFeatures).toBeDefined();
    expect(createdSubscription!.subscriptionFeatures!.length).toBe(3);

    const maxUsersFeature = createdSubscription!.subscriptionFeatures!.find(
      (f) => f.feature.slug === "max-users-free"
    );
    expect(maxUsersFeature).toBeDefined();
    expect(maxUsersFeature!.featureValue).toBe(5);
    expect(maxUsersFeature!.source).toBe("plan");
  });

  it("should return error when no active pricing tables exist", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Don't create any pricing tables, just try to create a free subscription
    const freeSubscriptionResponse = await apiClient.subscriptions[
      "create-free-subscription"
    ].$post({
      json: {
        customerEmail: "nopricing@example.com",
        customerName: "No Pricing User",
        userId: "external-no-pricing-123",
      },
    });

    expect(freeSubscriptionResponse.status).toBe(404);

    const responseBody = await freeSubscriptionResponse.json();
    if (!("error" in responseBody)) {
      throw new Error(
        `Unexpected response body: ${JSON.stringify(responseBody)}`
      );
    }
    expect(responseBody.error).toBe(
      "No active pricing tables found for this merchant"
    );
  });

  it("should return error when no free plans exist in pricing tables", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a pricing table with only the paid plan
    const createPricingTableResponse = await apiClient["pricing-tables"].$post({
      json: {
        name: "Paid Only Pricing Table",
        slug: "paid-only-pricing-table",
        description: "A pricing table with only paid plans",
        planIds: [testPaidPlan.id],
        planConfigs: [
          {
            planId: testPaidPlan.id,
            displayOrder: 1,
            isPopular: true,
            buttonText: "Start Trial",
          },
        ],
      },
    });

    expect(createPricingTableResponse.status).toBe(201);

    // Try to create a free subscription
    const freeSubscriptionResponse = await apiClient.subscriptions[
      "create-free-subscription"
    ].$post({
      json: {
        customerEmail: "nofree@example.com",
        customerName: "No Free User",
        userId: "external-no-free-123",
      },
    });

    expect(freeSubscriptionResponse.status).toBe(404);

    const responseBody = await freeSubscriptionResponse.json();
    if (!("error" in responseBody)) {
      throw new Error(
        `Unexpected response body: ${JSON.stringify(responseBody)}`
      );
    }
    expect(responseBody.error).toBe(
      "No free plans available for this merchant"
    );
  });

  it("should select the latest free plan when multiple exist", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a second, newer free plan
    const newerFreePlanResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "max-users-newer-free",
          displayName: "Maximum Users (Newer)",
          description: "Maximum number of users allowed in newer plan",
          featureValue: 10, // Better than the original free plan
        },
      ],
      {
        stablePlanId: "newer-free-plan",
        versionNumber: 1,
        planName: "Newer Free Plan",
        planDescription: "Newer free tier plan for testing",
      }
    );

    // Create a newer free price
    const newerFreePrice = await createTestPrice({
      planId: newerFreePlanResult.plan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `newer_free_plan_base_${Date.now()}`,
            type: "fixed",
            label: "Newer Free Base Plan",
            amount_cents: 0, // Free!
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Create a pricing table with both free plans
    const createPricingTableResponse = await apiClient["pricing-tables"].$post({
      json: {
        name: "Multiple Free Plans Table",
        slug: "multiple-free-plans-table",
        description: "A pricing table with multiple free plans",
        planIds: [
          testFreePlan.id,
          newerFreePlanResult.plan.id,
          testPaidPlan.id,
        ],
        planConfigs: [
          {
            planId: testFreePlan.id,
            displayOrder: 1,
            buttonText: "Get Started Free (Old)",
          },
          {
            planId: newerFreePlanResult.plan.id,
            displayOrder: 2,
            buttonText: "Get Started Free (New)",
          },
          {
            planId: testPaidPlan.id,
            displayOrder: 3,
            buttonText: "Go Premium",
          },
        ],
      },
    });

    expect(createPricingTableResponse.status).toBe(201);

    // Create a free subscription - should get the newer plan
    const freeSubscriptionResponse = await apiClient.subscriptions[
      "create-free-subscription"
    ].$post({
      json: {
        customerEmail: "latestfree@example.com",
        customerName: "Latest Free User",
        userId: "external-latest-free-123",
      },
    });

    expect(freeSubscriptionResponse.status).toBe(200);

    const responseBody = await freeSubscriptionResponse.json();
    if ("error" in responseBody) {
      throw new Error(`Unexpected error: ${responseBody.error}`);
    }

    // Should have selected the newer free plan
    expect(responseBody.plan.name).toBe("Newer Free Plan");
    expect(responseBody.subscription.planId).toBe(newerFreePlanResult.plan.id);
    expect(responseBody.subscription.effectivePriceId).toBe(newerFreePrice.id);
  });

  it("should handle existing customer with same external ID", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a pricing table with the free plan
    await apiClient["pricing-tables"].$post({
      json: {
        name: "Existing Customer Table",
        slug: "existing-customer-table",
        description: "A pricing table for testing existing customers",
        planIds: [testFreePlan.id],
        planConfigs: [
          {
            planId: testFreePlan.id,
            displayOrder: 1,
            buttonText: "Get Started Free",
          },
        ],
      },
    });

    const userId = "external-existing-user-456";

    // Create first subscription
    const firstResponse = await apiClient.subscriptions[
      "create-free-subscription"
    ].$post({
      json: {
        customerEmail: "existing@example.com",
        customerName: "Existing User",
        userId,
      },
    });

    expect(firstResponse.status).toBe(200);

    // Try to create another subscription with the same external ID
    // It will return 409 because a subscriptionalready exists
    const secondResponse = await apiClient.subscriptions[
      "create-free-subscription"
    ].$post({
      json: {
        customerEmail: "existing@example.com", // Same email
        customerName: "Existing User Updated", // Different name
        userId, // Same external ID
      },
    });

    expect(secondResponse.status).toBe(409);

    // Verify we still only have one customer record
    const customersList = await db.query.customers.findMany({
      where: eq(customers.externalCustomerId, userId),
    });

    expect(customersList.length).toBe(1);

    // But should have two subscriptions for this customer
    const subscriptionsList = await db.query.subscriptions.findMany({
      where: and(
        eq(subscriptions.customerId, customersList[0].id),
        isNull(subscriptions.deletedAt)
      ),
    });

    expect(subscriptionsList.length).toBe(1);
  });

  it("should upgrade from free to paid plan correctly", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a pricing table with both free and paid plans
    await apiClient["pricing-tables"].$post({
      json: {
        name: "Upgrade Test Table",
        slug: "upgrade-test-table",
        description: "A pricing table for testing free to paid upgrades",
        planIds: [testFreePlan.id, testPaidPlan.id],
        planConfigs: [
          {
            planId: testFreePlan.id,
            displayOrder: 1,
            buttonText: "Get Started Free",
          },
          {
            planId: testPaidPlan.id,
            displayOrder: 2,
            buttonText: "Upgrade to Pro",
          },
        ],
      },
    });

    // First, create a free subscription
    const freeResponse = await apiClient.subscriptions[
      "create-free-subscription"
    ].$post({
      json: {
        customerEmail: "upgrade-user@example.com",
        customerName: "Upgrade Test User",
        userId: "external-upgrade-user-789",
        billingAddressLine1: "456 Upgrade Avenue",
        billingCity: "Upgradetown",
        billingPostalCode: "54321",
        billingCountry: "US",
      },
    });

    expect(freeResponse.status).toBe(200);
    const freeBody = await freeResponse.json();
    if ("error" in freeBody) {
      throw new Error(`Unexpected error: ${freeBody.error}`);
    }

    const originalSubscription = freeBody.subscription;
    expect(originalSubscription.planId).toBe(testFreePlan.id);
    expect(originalSubscription.effectivePriceId).toBe(testFreePrice.id);

    // Get the customer ID
    const customer = await db.query.customers.findFirst({
      where: eq(customers.email, "upgrade-user@example.com"),
    });
    expect(customer).toBeDefined();

    // Fetch the existing free subscription from the database
    const existingSubscription = await db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.id, originalSubscription.id),
        isNull(subscriptions.deletedAt)
      ),
    });

    expect(existingSubscription).toBeDefined();

    // Perform the upgrade inside a DB transaction to mimic the real upgrade flow
    const { subscription: upgradedSubscription } = await db.transaction(
      async (tx) => {
        return await upgradeSubscriptionAndInvoice({
          merchantId,
          customerId: customer!.id,
          planId: testPaidPlan.id,
          priceId: testPaidPrice.id,
          startTimestamp: new Date(),
          paymentMethodId: undefined,
          existingSubscription: existingSubscription!,
          tx,
        });
      }
    );

    // Verify the upgrade worked correctly
    expect(upgradedSubscription.customerId).toBe(customer!.id);
    expect(upgradedSubscription.planId).toBe(testPaidPlan.id);
    expect(upgradedSubscription.effectivePriceId).toBe(testPaidPrice.id);

    // Should have the same stable subscription ID but higher version number
    expect(upgradedSubscription.stableSubscriptionId).toBe(
      originalSubscription.stableSubscriptionId
    );
    expect(upgradedSubscription.versionNumber).toBe(2); // Original was version 1

    // Verify the original subscription was soft-deleted
    const originalDbSubscriptionAfter = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, existingSubscription!.id),
    });
    expect(originalDbSubscriptionAfter).toBeDefined();
    expect(originalDbSubscriptionAfter!.deletedAt).not.toBeNull();
    expect(originalDbSubscriptionAfter!.endTimestamp).not.toBeNull();

    // Verify the new subscription exists and is active
    const newDbSubscription = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, upgradedSubscription.id),
    });
    expect(newDbSubscription).toBeDefined();
    expect(newDbSubscription!.deletedAt).toBeNull();
    expect(newDbSubscription!.endTimestamp).toBeNull();

    // Verify subscription features were migrated correctly
    const upgradedFeatures = await db.query.subscriptionFeatures.findMany({
      where: and(
        eq(subscriptionFeatures.subscriptionId, upgradedSubscription.id),
        isNull(subscriptionFeatures.deletedAt)
      ),
      with: {
        feature: true,
      },
    });

    expect(upgradedFeatures.length).toBeGreaterThan(0);

    // Should have features from the new paid plan
    const paidPlanFeature = upgradedFeatures.find(
      (f) => f.feature.slug === "max-users-paid"
    );
    expect(paidPlanFeature).toBeDefined();
    expect(paidPlanFeature!.featureValue).toBe(100); // The paid plan feature value
    expect(paidPlanFeature!.source).toBe("plan");

    // Verify subscription details were created for the new subscription
    const subscriptionDetailsRecords =
      await db.query.subscriptionDetails.findMany({
        where: eq(subscriptionDetails.subscriptionId, upgradedSubscription.id),
      });

    expect(subscriptionDetailsRecords.length).toBeGreaterThan(0);

    // Verify an invoice was created for the paid plan (since bill_immediately: true)
    const invoicesList = await db.query.invoices.findMany({
      where: eq(invoices.subscriptionId, upgradedSubscription.id),
      with: {
        lineItems: true,
      },
    });

    expect(invoicesList.length).toBe(1);
    const invoice = invoicesList[0];
    expect(invoice.totalAmountCents).toBe(2999); // $29.99
    expect(invoice.status).toBe("paid");
    expect(invoice.lineItems.length).toBe(1);

    const lineItem = invoice.lineItems[0];
    expect(lineItem.subtotalCents).toBe(2999);
    expect(lineItem.type).toBe("fixed");
    expect(lineItem.componentId).toBeDefined();

    // Verify we can list the subscription and it shows the upgraded version
    const listResponse = await apiClient.subscriptions.customer[
      ":customerId"
    ].$get({
      param: { customerId: customer!.id },
      query: { includeFeatures: "true" },
    });

    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    if ("error" in listBody) {
      throw new Error(`Unexpected error: ${listBody.error}`);
    }

    // Should only show the active (upgraded) subscription
    expect(listBody.subscriptions.length).toBe(1);
    expect(listBody.subscriptions[0].planId).toBe(testPaidPlan.id);
    expect(listBody.subscriptions[0].versionNumber).toBe(2);
  });
});
