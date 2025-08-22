import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
} from "../../test-helpers";
import { cleanupDataFull } from "../../test-helpers/test-utils/setup";
import {
  creditDefinitions,
  plans,
  prices,
  subscriptions,
} from "@lumen/common/schema";
import { db } from "../../../src/db/client";
import { and, eq, isNull } from "drizzle-orm";

describe("EditPlan Trial Versions (New Plan Version Creation)", () => {
  let merchantId: string;
  let sessionToken: string;
  let basePlan: any;
  let customerId: string;

  beforeEach(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create a customer for subscription testing
    const client = createTestApiClient(sessionToken);
    const customerResponse = await client.customers.$post({
      json: {
        email: `test-customer-${Date.now()}@example.com`,
        name: "Test Customer",
      },
    });
    expect(customerResponse.status).toBe(201);
    const customerBody = await customerResponse.json();
    if ("error" in customerBody) {
      throw new Error(`Failed to create customer: ${customerBody.error}`);
    }
    customerId = customerBody.customer.id;

    // Create a base plan with usage-based features for comprehensive testing
    const response = await client.plans.$post({
      json: {
        planName: "Edit Version Trial Test Plan",
        planDescription: "Plan for testing trial editing with new versions",
        stablePlanId: `edit-version-trial-${Date.now()}`,
        newFeatures: [
          {
            slug: "api-calls-version",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "storage-gb-version",
            featureName: "Storage GB",
            eventName: "storage_used",
            isUsageBased: true,
            usagePricePerUnit: 10,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support-version",
            featureName: "Premium Support",
            isUsageBased: false,
            hasCreditAllowance: false,
          },
        ],
        monthlyPrice: 2000,
        hasYearlyPrice: true,
        yearlyPrice: 18000,
        trial: {
          enabled: true,
          days: 14,
          creditOverrides: [
            { featureSlug: "api-calls-version", allowance: 500 },
            { featureSlug: "storage-gb-version", allowance: 50 },
          ],
        },
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create base plan: ${body.error}`);
    }
    basePlan = body.plans[0];

    // Query the plan's prices to get the effectivePriceId
    const planPrices = await db.query.prices.findMany({
      where: and(
        eq(prices.planId, basePlan.id),
        eq(prices.merchantId, merchantId),
        isNull(prices.deletedAt)
      ),
    });
    expect(planPrices.length).toBeGreaterThan(0);

    // Create a subscription to force new version creation
    const subscriptionResponse = await client.subscriptions.$post({
      json: {
        customerId,
        planId: basePlan.id,
        effectivePriceId: planPrices[0].id, // Use the first price (monthly)
        startTimestamp: new Date().toISOString(),
      },
    });
    expect(subscriptionResponse.status).toBe(201);
  });

  afterEach(async () => {
    await cleanupDataFull();
  });

  it("should create new trial plan version when editing plan with active subscriptions", async () => {
    const client = createTestApiClient(sessionToken);

    // Verify subscription exists (forces new version creation)
    const activeSubscriptions = await db.query.subscriptions.findMany({
      where: and(
        eq(subscriptions.planId, basePlan.id),
        eq(subscriptions.merchantId, merchantId),
        isNull(subscriptions.deletedAt),
        isNull(subscriptions.endTimestamp)
      ),
    });
    expect(activeSubscriptions.length).toBeGreaterThan(0);

    // Edit plan - this should create new version
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        planName: "Updated Version Trial Plan",
        features: [
          {
            slug: "api-calls-version",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "storage-gb-version",
            featureName: "Storage GB",
            eventName: "storage_used",
            isUsageBased: true,
            usagePricePerUnit: 10,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 2500, // Changed price to force new version
        trial: {
          enabled: true,
          days: 21, // Updated trial duration
          creditOverrides: [
            { featureSlug: "api-calls-version", allowance: 750 }, // Updated allowances
            { featureSlug: "storage-gb-version", allowance: 75 },
          ],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }
    expect(editBody.success).toBe(true);
    expect(editBody.changeAnalysis.isNewVersion).toBe(true);

    // Verify new plan version was created
    const newPlan = editBody.plan;
    expect(newPlan.id).not.toBe(basePlan.id);
    expect(newPlan.stablePlanId).toBe(basePlan.stablePlanId); // Same stable ID
    expect(newPlan.versionNumber).toBe(2); // Version incremented

    // Verify new trial plan was created for new version
    const newTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, newPlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(newTrialPlan).toBeDefined();
    expect(newTrialPlan!.trialDays).toBe(21);

    // Verify old trial plan still exists (for existing subscribers)
    const oldTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, basePlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(oldTrialPlan).toBeDefined();
    expect(oldTrialPlan!.trialDays).toBe(14); // Original configuration preserved

    // Verify both trial plans have different IDs
    expect(newTrialPlan!.id).not.toBe(oldTrialPlan!.id);

    // Verify new trial credits were created with updated allowances
    const newTrialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, newTrialPlan!.id),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });
    expect(newTrialCredits).toHaveLength(2);

    const apiCallsCredit = newTrialCredits.find(
      (c) => c.featureSlug === "api-calls-version"
    );
    const storageCredit = newTrialCredits.find(
      (c) => c.featureSlug === "storage-gb-version"
    );
    expect(apiCallsCredit!.defaultAmount).toBe(750);
    expect(storageCredit!.defaultAmount).toBe(75);
  });

  it("should handle trial removal in new version while preserving old trial", async () => {
    const client = createTestApiClient(sessionToken);

    // Edit plan to remove trial
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        planName: "No Trial Version",
        features: [
          {
            slug: "api-calls-version",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 1500,
        // trial omitted = no trial for new version
      },
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    const newPlan = editBody.plan;

    // Verify no trial plan exists for new version
    const newTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, newPlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(newTrialPlan).toBeUndefined();

    // Verify old trial plan still exists unchanged
    const oldTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, basePlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(oldTrialPlan).toBeDefined();
    expect(oldTrialPlan!.trialDays).toBe(14);
  });

  it("should require explicit trial allowances for new usage-based features", async () => {
    const client = createTestApiClient(sessionToken);

    // Try to add new usage-based feature without trial allowance
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        features: [
          {
            slug: "api-calls-version",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "new-sms-feature",
            featureName: "SMS Messages",
            eventName: "sms_sent",
            isUsageBased: true,
            usagePricePerUnit: 15,
            hasCreditAllowance: true,
            creditAllowanceAmount: 200,
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 2500,
        trial: {
          enabled: true,
          days: 14,
          creditOverrides: [
            { featureSlug: "api-calls-version", allowance: 500 },
            // Missing allowance for new-sms-feature
          ],
        },
      },
    });

    expect(editResponse.status).toBe(400);
    const editBody = await editResponse.json();
    expect("error" in editBody).toBe(true);
    if ("error" in editBody) {
      expect(editBody.error).toContain(
        "Trial allowance must be explicitly provided for feature: new-sms-feature"
      );
    }
  });

  it("should handle first-time trial addition to existing plan with active subscriptions", async () => {
    const client = createTestApiClient(sessionToken);

    // First create a plan without trial
    const noTrialResponse = await client.plans.$post({
      json: {
        planName: "No Trial Initially",
        planDescription: "Plan that starts without trial",
        stablePlanId: `no-trial-${Date.now()}`,
        newFeatures: [
          {
            slug: "basic-feature",
            featureName: "Basic Feature",
            eventName: "basic_event",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 1000,
        // No trial initially
      },
    });

    expect(noTrialResponse.status).toBe(200);
    const noTrialBody = await noTrialResponse.json();
    if ("error" in noTrialBody) {
      throw new Error(`Failed to create no-trial plan: ${noTrialBody.error}`);
    }
    const noTrialPlan = noTrialBody.plans[0];

    // Query the plan's prices to get the effectivePriceId
    const noTrialPlanPrices = await db.query.prices.findMany({
      where: and(
        eq(prices.planId, noTrialPlan.id),
        eq(prices.merchantId, merchantId),
        isNull(prices.deletedAt)
      ),
    });
    expect(noTrialPlanPrices.length).toBeGreaterThan(0);

    // Delete old subscriptions for this customer if it exists
    await db
      .update(subscriptions)
      .set({ deletedAt: new Date() })
      .where(eq(subscriptions.customerId, customerId));

    // Create subscription to force versioning
    const subscriptionResponse = await client.subscriptions.$post({
      json: {
        customerId,
        planId: noTrialPlan.id,
        effectivePriceId: noTrialPlanPrices[0].id, // Use the first price (monthly)
        startTimestamp: new Date().toISOString(),
      },
    });
    expect(subscriptionResponse.status).toBe(201);

    // Now edit to add trial - should create new version
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: noTrialPlan.id },
      json: {
        planName: "Now With Trial",
        features: [
          {
            slug: "basic-feature",
            featureName: "Basic Feature",
            eventName: "basic_event",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 1200, // Changed to force versioning
        trial: {
          enabled: true,
          days: 7,
          creditOverrides: [{ featureSlug: "basic-feature", allowance: 50 }],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    const newPlan = editBody.plan;
    expect(newPlan.versionNumber).toBe(2);

    // Verify new trial plan was created for new version
    const newTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, newPlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(newTrialPlan).toBeDefined();
    expect(newTrialPlan!.trialDays).toBe(7);

    // Verify no trial plan exists for old version
    const oldTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, noTrialPlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(oldTrialPlan).toBeUndefined();
  });

  it("should handle trial config changes without feature changes", async () => {
    const client = createTestApiClient(sessionToken);

    // Edit only trial configuration, no feature changes
    // UI would send the full feature list even when only changing trial config
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        planName: "Same Features, Updated Trial",
        features: [
          // Include all existing features (unchanged)
          {
            slug: "api-calls-version",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "storage-gb-version",
            featureName: "Storage GB",
            eventName: "storage_used",
            isUsageBased: true,
            usagePricePerUnit: 10,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support-version",
            featureName: "Premium Support",
            isUsageBased: false,
            hasCreditAllowance: false,
          },
        ],
        monthlyPrice: 2100, // Small price change to force versioning
        trial: {
          enabled: true,
          days: 30, // Changed from 14 to 30
          creditOverrides: [
            { featureSlug: "api-calls-version", allowance: 1000 }, // Changed from 500 to 1000
            { featureSlug: "storage-gb-version", allowance: 100 }, // Changed from 50 to 100
          ],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    const newPlan = editBody.plan;
    expect(newPlan.versionNumber).toBe(2);

    // Verify new trial plan with updated config
    const newTrialPlan = await db.query.plans.findMany({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, newPlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(newTrialPlan.length).toBe(1);
    expect(newTrialPlan[0].trialDays).toBe(30);

    // Verify updated trial credits
    const newTrialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, newTrialPlan[0].id),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });
    expect(newTrialCredits).toHaveLength(2);

    const apiCallsCredit = newTrialCredits.find(
      (c) => c.featureSlug === "api-calls-version"
    );
    const storageCredit = newTrialCredits.find(
      (c) => c.featureSlug === "storage-gb-version"
    );
    expect(apiCallsCredit!.defaultAmount).toBe(1000);
    expect(storageCredit!.defaultAmount).toBe(100);
  });

  it("should handle removing usage-based features from trial plan", async () => {
    const client = createTestApiClient(sessionToken);

    // Edit to remove storage feature, keep only api-calls
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        planName: "Reduced Features Trial Plan",
        features: [
          {
            slug: "api-calls-version",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support-version",
            featureName: "Premium Support",
            isUsageBased: false,
            hasCreditAllowance: false,
          },
        ],
        monthlyPrice: 1800, // Reduced price
        trial: {
          enabled: true,
          days: 14,
          creditOverrides: [
            { featureSlug: "api-calls-version", allowance: 500 },
            // storage-gb-version removed - no allowance needed
          ],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    const newPlan = editBody.plan;

    // Verify new trial plan was created
    const newTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, newPlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(newTrialPlan).toBeDefined();

    // Verify only api-calls credit exists (storage removed)
    const newTrialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, newTrialPlan!.id),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });
    expect(newTrialCredits).toHaveLength(1);
    expect(newTrialCredits[0].featureSlug).toBe("api-calls-version");
    expect(newTrialCredits[0].defaultAmount).toBe(500);
  });

  it("should handle explicit trial disabled with features present", async () => {
    const client = createTestApiClient(sessionToken);

    // Explicitly disable trial
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        planName: "Explicitly No Trial",
        features: [
          {
            slug: "api-calls-version",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 1500,
        trial: {
          enabled: false, // Explicitly disabled
        },
      },
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    const newPlan = editBody.plan;

    // Verify no trial plan exists for new version
    const newTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, newPlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(newTrialPlan).toBeUndefined();

    // Verify old trial plan still exists
    const oldTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, basePlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(oldTrialPlan).toBeDefined();
  });
});
