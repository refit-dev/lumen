import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
} from "../../test-helpers";
import { cleanupDataFull } from "../../test-helpers/test-utils/setup";
import {
  creditDefinitions,
  planFeatures,
  plans,
  prices,
} from "@lumen/common/schema";
import { db } from "../../../src/db/client";
import { and, eq, isNull } from "drizzle-orm";

describe("Trial Plan Creation", () => {
  let merchantId: string;
  let sessionToken: string;

  beforeEach(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
  });

  afterEach(async () => {
    await cleanupDataFull();
  });

  it("should create both main plan and trial plan when trial is enabled", async () => {
    const client = createTestApiClient(sessionToken);

    const planData = {
      planName: "Pro Plan with Trial",
      planDescription: "Professional plan with 14-day free trial",
      stablePlanId: `pro-trial-${Date.now()}`,
      monthlyPrice: 2999, // $29.99
      newFeatures: [
        {
          slug: "api-calls",
          featureName: "API Calls",
          eventName: "api_call",
          isUsageBased: true,
          usagePricePerUnit: 10, // $0.10 per call
          hasCreditAllowance: true,
          creditAllowanceAmount: 1000,
          creditAllowanceRenewal: "monthly" as const,
          trialCreditAllowance: 100, // Trial gets 100 calls
        },
        {
          slug: "advanced-analytics",
          featureName: "Advanced Analytics",
          isUsageBased: false,
          trialCreditAllowance: 0, // Boolean feature doesn't need trial allowance
        },
      ],
      trial: {
        enabled: true,
        days: 14,
        creditOverrides: [
          {
            featureSlug: "api-calls",
            allowance: 100,
          },
        ],
      },
    };

    const response = await client.plans.$post({
      json: planData,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create plan: ${body.error}`);
    }

    const mainPlan = body.plans[0];
    expect(mainPlan.planName).toBe("Pro Plan with Trial");
    expect(mainPlan.isTrialPlan).toBe(false);

    // Verify trial plan was created in the database
    const trialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, mainPlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(trialPlan).toBeDefined();
    expect(trialPlan!.planName).toBe("Pro Plan with Trial - Free Trial");
    expect(trialPlan!.planDescription).toBe(
      "Professional plan with 14-day free trial (Free Trial)"
    );
    expect(trialPlan!.isTrialPlan).toBe(true);
    expect(trialPlan!.trialParentPlanId).toBe(mainPlan.id);
    expect(trialPlan!.trialDays).toBe(14);
    expect(trialPlan!.stablePlanId).not.toBe(mainPlan.stablePlanId); // Should have unique stable ID
  });

  it("should create trial-specific credit definitions with correct allowances", async () => {
    const client = createTestApiClient(sessionToken);

    const planData = {
      planName: "Plan with Multi-Feature Trial",
      planDescription:
        "Testing multiple features with different trial allowances",
      stablePlanId: `multi-trial-${Date.now()}`,
      monthlyPrice: 1999,
      newFeatures: [
        {
          slug: "api-calls",
          featureName: "API Calls",
          eventName: "api_call",
          isUsageBased: true,
          usagePricePerUnit: 5,
          hasCreditAllowance: true,
          creditAllowanceAmount: 2000,
          creditAllowanceRenewal: "monthly" as const,
        },
        {
          slug: "storage",
          featureName: "Storage GB",
          eventName: "storage_usage",
          isUsageBased: true,
          // No usage price - just usage tracking
          hasCreditAllowance: true,
          creditAllowanceAmount: 100,
          creditAllowanceRenewal: "monthly" as const,
        },
      ],
      trial: {
        enabled: true,
        days: 7,
        creditOverrides: [
          {
            featureSlug: "api-calls",
            allowance: 50, // Trial gets 50 API calls
          },
          {
            featureSlug: "storage",
            allowance: 10, // Trial gets 10 GB storage
          },
        ],
      },
    };

    const response = await client.plans.$post({
      json: planData,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create plan: ${body.error}`);
    }

    const mainPlan = body.plans[0];

    // Get the trial plan
    const trialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, mainPlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(trialPlan).toBeDefined();

    // Verify trial credit definitions
    const trialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, trialPlan!.id),
        eq(creditDefinitions.scope, "plan"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(trialCredits).toHaveLength(2);

    // Check API calls trial credit
    const apiCallsCredit = trialCredits.find(
      (c) => c.featureSlug === "api-calls"
    );
    expect(apiCallsCredit).toBeDefined();
    expect(apiCallsCredit!.name).toBe("API Calls Credits (Trial)");
    expect(apiCallsCredit!.defaultAmount).toBe(50); // Trial allowance
    expect(apiCallsCredit!.billingVisible).toBe(false); // Trial credits not billing-visible
    expect(apiCallsCredit!.expiryDays).toBe(7); // Expires after trial period
    expect(apiCallsCredit!.refillAmount).toBeNull(); // No renewal
    expect(apiCallsCredit!.refillRrule).toBeNull();
    expect(apiCallsCredit!.renewOnBilling).toBe(false);
    expect(apiCallsCredit!.priceId).toBeNull(); // No price linkage
    expect(apiCallsCredit!.priceComponentId).toBeNull();

    // Check storage trial credit
    const storageCredit = trialCredits.find((c) => c.featureSlug === "storage");
    expect(storageCredit).toBeDefined();
    expect(storageCredit!.name).toBe("Storage GB Credits (Trial)");
    expect(storageCredit!.defaultAmount).toBe(10); // Trial allowance
    expect(storageCredit!.billingVisible).toBe(false);
    expect(storageCredit!.expiryDays).toBe(7);
    expect(storageCredit!.refillAmount).toBeNull();
    expect(storageCredit!.refillRrule).toBeNull();
    expect(storageCredit!.renewOnBilling).toBe(false);
  });

  it("should create zero-cost price for trial plan", async () => {
    const client = createTestApiClient(sessionToken);

    const planData = {
      planName: "Trial Price Test Plan",
      planDescription: "Testing trial plan pricing",
      stablePlanId: `trial-price-${Date.now()}`,
      monthlyPrice: 1500,
      trial: {
        enabled: true,
        days: 10,
        creditOverrides: [], // No usage features, just testing price creation
      },
    };

    const response = await client.plans.$post({
      json: planData,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create plan: ${body.error}`);
    }

    const mainPlan = body.plans[0];

    // Get the trial plan and its price
    const trialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, mainPlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(trialPlan).toBeDefined();

    const trialPrice = await db.query.prices.findFirst({
      where: and(eq(prices.planId, trialPlan!.id), isNull(prices.deletedAt)),
    });

    expect(trialPrice).toBeDefined();
    expect(trialPrice!.currency).toBe("USD"); // Inherits from base plan
    expect(trialPrice!.pricingData.components).toHaveLength(1);

    const component = trialPrice!.pricingData.components[0];
    expect(component.type).toBe("fixed");
    expect(component.component_name).toBe("trial_zero");
    expect(component.label).toBe("Free trial (10 days)");
    expect((component as any).amount_cents).toBe(0);
    expect(component.bill_immediately).toBe(false);
  });

  it("should copy plan features from base plan to trial plan", async () => {
    const client = createTestApiClient(sessionToken);

    const planData = {
      planName: "Feature Copy Test Plan",
      planDescription: "Testing feature copying to trial plan",
      stablePlanId: `feature-copy-${Date.now()}`,
      monthlyPrice: 999,
      newFeatures: [
        {
          slug: "premium-support",
          featureName: "Premium Support",
          isUsageBased: false,
        },
        {
          slug: "analytics",
          featureName: "Analytics Dashboard",
          isUsageBased: false,
        },
        {
          slug: "api-access",
          featureName: "API Access",
          eventName: "api_usage",
          isUsageBased: true,
          hasCreditAllowance: true,
          creditAllowanceAmount: 500,
          creditAllowanceRenewal: "monthly" as const,
        },
      ],
      trial: {
        enabled: true,
        days: 14,
        creditOverrides: [
          {
            featureSlug: "api-access",
            allowance: 25,
          },
        ],
      },
    };

    const response = await client.plans.$post({
      json: planData,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create plan: ${body.error}`);
    }

    const mainPlan = body.plans[0];

    // Get both plans with their features

    const trialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, mainPlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(trialPlan).toBeDefined();

    // Get features for both plans
    const mainPlanFeatures = await db.query.planFeatures.findMany({
      where: and(
        eq(planFeatures.planId, mainPlan.id),
        isNull(planFeatures.deletedAt)
      ),
    });

    const trialPlanFeatures = await db.query.planFeatures.findMany({
      where: and(
        eq(planFeatures.planId, trialPlan!.id),
        isNull(planFeatures.deletedAt)
      ),
    });

    // Both plans should have the same features
    expect(mainPlanFeatures).toHaveLength(3);
    expect(trialPlanFeatures).toHaveLength(3);

    // Verify same feature slugs are present
    const mainFeatureSlugs = mainPlanFeatures.map((f) => f.featureSlug).sort();
    const trialFeatureSlugs = trialPlanFeatures
      .map((f) => f.featureSlug)
      .sort();
    expect(trialFeatureSlugs).toEqual(mainFeatureSlugs);

    // Verify feature values are copied correctly
    for (const mainFeature of mainPlanFeatures) {
      const correspondingTrialFeature = trialPlanFeatures.find(
        (f) => f.featureSlug === mainFeature.featureSlug
      );
      expect(correspondingTrialFeature).toBeDefined();
      expect(correspondingTrialFeature!.featureValue).toEqual(
        mainFeature.featureValue
      );
    }
  });

  it("should filter trial plans from public API by default", async () => {
    const client = createTestApiClient(sessionToken);

    // Create plan with trial
    const planData = {
      planName: "Filtered Trial Plan",
      planDescription: "This plan should be filtered from public API",
      stablePlanId: `filtered-trial-${Date.now()}`,
      monthlyPrice: 1999,
      trial: {
        enabled: true,
        days: 7,
        creditOverrides: [],
      },
    };

    const createResponse = await client.plans.$post({
      json: planData,
    });

    expect(createResponse.status).toBe(200);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Failed to create plan: ${createBody.error}`);
    }

    const mainPlan = createBody.plans[0];

    // Verify trial plan exists in database
    const trialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, mainPlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(trialPlan).toBeDefined();

    // Test default API call (should not include trials)
    const listResponse = await client.plans.$get({
      query: { includeFeatures: "false" },
    });

    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    if ("error" in listBody) {
      throw new Error(`Failed to list plans: ${listBody.error}`);
    }

    // Should only include main plan, not trial plan
    const planIds = listBody.plans.map((p: any) => p.id);
    expect(planIds).toContain(mainPlan.id);
    expect(planIds).not.toContain(trialPlan!.id);

    // Should not include any trial plans
    const hasTrialPlans = listBody.plans.some(
      (p: any) => p.isTrialPlan === true
    );
    expect(hasTrialPlans).toBe(false);
  });

  it("should include trial plans when includeTrials=true", async () => {
    const client = createTestApiClient(sessionToken);

    // Create plan with trial
    const planData = {
      planName: "Include Trial Test Plan",
      planDescription: "Testing includeTrials parameter",
      stablePlanId: `include-trial-${Date.now()}`,
      monthlyPrice: 2999,
      trial: {
        enabled: true,
        days: 14,
        creditOverrides: [],
      },
    };

    const createResponse = await client.plans.$post({
      json: planData,
    });

    expect(createResponse.status).toBe(200);
    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Failed to create plan: ${createBody.error}`);
    }

    const mainPlan = createBody.plans[0];

    // Get trial plan ID
    const trialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, mainPlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(trialPlan).toBeDefined();

    // Test API call with includeTrials=true
    const listResponse = await client.plans.$get({
      query: { includeFeatures: "false", includeTrials: "true" },
    });

    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    if ("error" in listBody) {
      throw new Error(`Failed to list plans: ${listBody.error}`);
    }

    // Should include both main plan and trial plan
    const planIds = listBody.plans.map((p: any) => p.id);
    expect(planIds).toContain(mainPlan.id);
    expect(planIds).toContain(trialPlan!.id);

    // Find the trial plan in the response
    const returnedTrialPlan = listBody.plans.find(
      (p: any) => p.id === trialPlan!.id
    );
    expect(returnedTrialPlan).toBeDefined();
    expect(returnedTrialPlan!.isTrialPlan).toBe(true);
    expect(returnedTrialPlan!.trialParentPlanId).toBe(mainPlan.id);
    expect(returnedTrialPlan!.trialDays).toBe(14);
  });

  it("should require explicit credit overrides for usage-based features", async () => {
    const client = createTestApiClient(sessionToken);

    const planData = {
      planName: "Missing Override Test Plan",
      planDescription: "Testing missing trial credit override validation",
      stablePlanId: `missing-override-${Date.now()}`,
      monthlyPrice: 1999,
      newFeatures: [
        {
          slug: "api-calls",
          featureName: "API Calls",
          eventName: "api_call",
          isUsageBased: true,
          hasCreditAllowance: true,
          creditAllowanceAmount: 1000,
          creditAllowanceRenewal: "monthly" as const,
        },
      ],
      trial: {
        enabled: true,
        days: 7,
        creditOverrides: [], // Missing required override for api-calls feature
      },
    };

    const response = await client.plans.$post({
      json: planData,
    });

    // Should fail because trial allowance was not provided for usage-based feature
    expect(response.status).toBe(500); // Internal server error due to validation in createTrialPlan
  });

  it("should validate trial configuration fields", async () => {
    const client = createTestApiClient(sessionToken);

    // Test missing trial days
    const missingDaysData = {
      planName: "Missing Days Test Plan",
      planDescription: "Testing missing trial days",
      stablePlanId: `missing-days-${Date.now()}`,
      monthlyPrice: 1999,
      trial: {
        enabled: true,
        // days: missing
        creditOverrides: [],
      },
    };

    const missingDaysResponse = await client.plans.$post({
      json: missingDaysData as any,
    });

    expect(missingDaysResponse.status).toBe(400); // Bad request due to validation

    // Test invalid trial days (too high)
    const invalidDaysData = {
      planName: "Invalid Days Test Plan",
      planDescription: "Testing invalid trial days",
      stablePlanId: `invalid-days-${Date.now()}`,
      monthlyPrice: 1999,
      trial: {
        enabled: true,
        days: 400, // Over 365 day limit
        creditOverrides: [],
      },
    };

    const invalidDaysResponse = await client.plans.$post({
      json: invalidDaysData,
    });

    expect(invalidDaysResponse.status).toBe(400); // Should be validated at API level
  });

  it("should handle enterprise plans without trials", async () => {
    const client = createTestApiClient(sessionToken);

    const enterprisePlanData = {
      planName: "Enterprise Plan",
      planDescription: "Custom enterprise plan",
      stablePlanId: `enterprise-${Date.now()}`,
      isEnterprisePlan: true,
      enterpriseButtonText: "Contact Sales",
      enterpriseRedirectUrl: "https://example.com/contact",
      showInPricingTable: true, // This is needed for isEnterprisePlan to be included
      // Trial should be ignored for enterprise plans
      trial: {
        enabled: true,
        days: 14,
        creditOverrides: [],
      },
    };

    const response = await client.plans.$post({
      json: enterprisePlanData,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create plan: ${body.error}`);
    }

    const mainPlan = body.plans[0];
    expect((mainPlan as any).isEnterprisePlan).toBe(true);

    // Verify no trial plan was created for enterprise plan
    const trialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, mainPlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(trialPlan).toBeUndefined(); // No trial plan should be created for enterprise plans
  });
});
