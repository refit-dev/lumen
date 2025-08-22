import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlanWithFeatures,
  createTestApiClient,
} from "../../test-helpers";
import { retryWithSleep } from "../../test-helpers/test-utils";
import { cleanupDataFull } from "../../test-helpers/test-utils/setup";
import { FeatureValue } from "../../test-helpers/data/feature";
import { EditPlanInput } from "../../../src/helpers/plans";

describe("Credit Definition Renewal Logic", () => {
  let merchantId: string;
  let sessionToken: string;

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
  });

  afterEach(async () => {
    await cleanupDataFull();
  });

  it("should create credit definitions with correct renewal strategies based on feature configuration", async () => {
    const client = createTestApiClient(sessionToken);

    // Test case 1: Usage-based feature WITH pricing - should use billing-based renewal
    const usageWithPriceResponse = await client.plans.$post({
      json: {
        planName: "Usage With Price Test Plan",
        planDescription: "Testing usage-based credits with pricing",
        stablePlanId: `usage-price-credit-${Date.now()}`,
        newFeatures: [
          {
            slug: "api-calls-priced",
            featureName: "API Calls (Priced)",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 10, // This triggers billing-based renewal
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 2000,
      },
    });

    expect(usageWithPriceResponse.status).toBe(200);
    const usageWithPriceBody = await usageWithPriceResponse.json();
    if ("error" in usageWithPriceBody) {
      throw new Error(`Failed to create plan: ${usageWithPriceBody.error}`);
    }
    const usagePricePlan = usageWithPriceBody.plans[0];

    // Test case 2: Usage-based feature WITHOUT pricing - should use RRULE-based renewal
    const usageWithoutPriceResponse = await client.plans.$post({
      json: {
        planName: "Usage Without Price Test Plan",
        planDescription: "Testing usage-based credits without pricing",
        stablePlanId: `usage-no-price-credit-${Date.now()}`,
        newFeatures: [
          {
            slug: "api-calls-free",
            featureName: "API Calls (Free)",
            eventName: "api_call_free",
            isUsageBased: true,
            // No usagePricePerUnit - this triggers RRULE-based renewal
            hasCreditAllowance: true,
            creditAllowanceAmount: 500,
            creditAllowanceRenewal: "yearly",
          },
        ],
        monthlyPrice: 1500,
      },
    });

    expect(usageWithoutPriceResponse.status).toBe(200);
    const usageWithoutPriceBody = await usageWithoutPriceResponse.json();
    if ("error" in usageWithoutPriceBody) {
      throw new Error(`Failed to create plan: ${usageWithoutPriceBody.error}`);
    }
    const usageNoPricePlan = usageWithoutPriceBody.plans[0];

    // Test case 3: Non-usage-based feature - should use RRULE-based renewal
    const nonUsageResponse = await client.plans.$post({
      json: {
        planName: "Non-Usage Test Plan",
        planDescription: "Testing non-usage-based credits",
        stablePlanId: `non-usage-credit-${Date.now()}`,
        newFeatures: [
          {
            slug: "storage-allowance",
            featureName: "Storage Allowance",
            isUsageBased: false,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 1000,
      },
    });

    expect(nonUsageResponse.status).toBe(200);
    const nonUsageBody = await nonUsageResponse.json();
    if ("error" in nonUsageBody) {
      throw new Error(`Failed to create plan: ${nonUsageBody.error}`);
    }
    const nonUsagePlan = nonUsageBody.plans[0];

    // Test case 4: One-time credits (no renewal)
    const oneTimeResponse = await client.plans.$post({
      json: {
        planName: "One-Time Credit Test Plan",
        planDescription: "Testing one-time credits",
        stablePlanId: `one-time-credit-${Date.now()}`,
        newFeatures: [
          {
            slug: "welcome-bonus",
            featureName: "Welcome Bonus",
            isUsageBased: false,
            hasCreditAllowance: true,
            creditAllowanceAmount: 50,
            creditAllowanceRenewal: "none",
          },
        ],
        monthlyPrice: 500,
      },
    });

    expect(oneTimeResponse.status).toBe(200);
    const oneTimeBody = await oneTimeResponse.json();
    if ("error" in oneTimeBody) {
      throw new Error(`Failed to create plan: ${oneTimeBody.error}`);
    }
    const oneTimePlan = oneTimeBody.plans[0];

    // ---------------------------
    // Direct DB verifications for all scenarios
    // ---------------------------
    const { creditDefinitions } = await import("@lumen/common/schema");
    const { db } = await import("../../../src/db/client");
    const { and, eq, isNull } = await import("drizzle-orm");

    // Scenario 1: Usage-based with pricing → billing-based renewal
    const usagePricedCredit = await db.query.creditDefinitions.findFirst({
      where: and(
        eq(creditDefinitions.planId, usagePricePlan.id),
        eq(creditDefinitions.featureSlug, "api-calls-priced"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(usagePricedCredit).toBeDefined();
    expect(usagePricedCredit!.defaultAmount).toBe(1000);
    expect(usagePricedCredit!.renewOnBilling).toBe(true); // ✅ Billing-based
    expect(usagePricedCredit!.expiryDays).toBe(-1); // ✅ Expire with billing cycle
    expect(usagePricedCredit!.refillRrule).toBeNull(); // ✅ No RRULE when billing-based
    expect(usagePricedCredit!.refillAmount).toBe(1000);

    // Scenario 2: Usage-based without pricing → RRULE-based renewal
    const usageUnpricedCredit = await db.query.creditDefinitions.findFirst({
      where: and(
        eq(creditDefinitions.planId, usageNoPricePlan.id),
        eq(creditDefinitions.featureSlug, "api-calls-free"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(usageUnpricedCredit).toBeDefined();
    expect(usageUnpricedCredit!.defaultAmount).toBe(500);
    expect(usageUnpricedCredit!.renewOnBilling).toBe(false); // ✅ RRULE-based
    expect(usageUnpricedCredit!.expiryDays).toBe(-1); // ✅ Expire with renewal cycle
    expect(usageUnpricedCredit!.refillRrule).toContain("FREQ=YEARLY"); // ✅ Yearly RRULE
    expect(usageUnpricedCredit!.refillAmount).toBe(500);

    // Scenario 3: Non-usage-based → RRULE-based renewal
    const nonUsageCredit = await db.query.creditDefinitions.findFirst({
      where: and(
        eq(creditDefinitions.planId, nonUsagePlan.id),
        eq(creditDefinitions.featureSlug, "storage-allowance"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(nonUsageCredit).toBeDefined();
    expect(nonUsageCredit!.defaultAmount).toBe(100);
    expect(nonUsageCredit!.renewOnBilling).toBe(false); // ✅ RRULE-based
    expect(nonUsageCredit!.expiryDays).toBe(-1); // ✅ Expire with renewal cycle
    expect(nonUsageCredit!.refillRrule).toContain("FREQ=MONTHLY"); // ✅ Monthly RRULE
    expect(nonUsageCredit!.refillAmount).toBe(100);

    // Scenario 4: One-time credits → fixed expiry, no renewal
    const oneTimeCredit = await db.query.creditDefinitions.findFirst({
      where: and(
        eq(creditDefinitions.planId, oneTimePlan.id),
        eq(creditDefinitions.featureSlug, "welcome-bonus"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(oneTimeCredit).toBeDefined();
    expect(oneTimeCredit!.defaultAmount).toBe(50);
    // No renewal -> renewOnBilling can be either undefined or false
    expect(oneTimeCredit!.renewOnBilling ?? false).toBe(false); // ✅ No renewal
    expect(oneTimeCredit!.expiryDays).toBe(365); // ✅ Fixed 1-year expiry
    expect(oneTimeCredit!.refillRrule).toBeNull(); // ✅ No renewal rule
    expect(oneTimeCredit!.refillAmount).toBeNull(); // ✅ No refill amount
  });

  it("should update credit definitions with correct renewal strategies using editPlanInPlace", async () => {
    const client = createTestApiClient(sessionToken);

    // Create a base plan to edit
    const basePlan = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "basic-feature",
          displayName: "Basic Feature",
          description: "A basic feature",
          featureValue: true as FeatureValue,
        },
      ],
      {
        stablePlanId: `edit-credit-test-${Date.now()}`,
        versionNumber: 1,
        planName: "Edit Credit Test Plan",
        planDescription: "Testing credit edits",
      }
    );

    // Use editPlanInPlace to add features with different credit renewal strategies
    const editPayload: EditPlanInput = {
      planDescription: "Updated with credit features",
      features: [
        // Keep existing feature
        {
          existingFeatureId: basePlan.features[0].id,
          slug: basePlan.features[0].slug,
          featureName: basePlan.features[0].displayName,
          isUsageBased: false,
          hasCreditAllowance: false,
        },
        // Add usage-based feature with pricing (should use billing renewal)
        {
          slug: "sms-with-price",
          featureName: "SMS with Pricing",
          eventName: "sms-with-price",
          isUsageBased: true,
          usagePricePerUnit: 5,
          hasCreditAllowance: true,
          creditAllowanceAmount: 200,
          creditAllowanceRenewal: "monthly",
        },
        // Add usage-based feature without pricing (should use RRULE renewal)
        {
          slug: "emails-free",
          featureName: "Free Emails",
          eventName: "emails-free",
          isUsageBased: true,
          // No usagePricePerUnit
          hasCreditAllowance: true,
          creditAllowanceAmount: 300,
          creditAllowanceRenewal: "yearly",
        },
      ],
      monthlyPrice: 2500,
    };

    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.plan.id },
      json: editPayload,
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    expect(editBody.success).toBe(true);

    const editedInPlace = !editBody.changeAnalysis.isNewVersion;
    const targetPlanId = editedInPlace ? basePlan.plan.id : editBody.plan.id;

    // Verify credit definitions
    const { creditDefinitions } = await import("@lumen/common/schema");
    const { db } = await import("../../../src/db/client");
    const { and, eq, isNull } = await import("drizzle-orm");

    // SMS with pricing → billing-based renewal
    // Wait for credit definition creation (happens within transaction but ensure visibility)
    // Find any credit definition on this plan that uses billing-based renewal (renewOnBilling=true)
    const billingCredit = await db.query.creditDefinitions.findFirst({
      where: and(
        eq(creditDefinitions.planId, targetPlanId),
        eq(creditDefinitions.renewOnBilling, true),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(billingCredit).toBeDefined();
    expect(billingCredit!.expiryDays).toBe(-1);
    expect(billingCredit!.refillRrule).toBeNull();

    // Emails without pricing → RRULE-based renewal
    const emailCredit = await retryWithSleep({
      fn: () =>
        db.query.creditDefinitions.findFirst({
          where: and(
            eq(creditDefinitions.planId, targetPlanId),
            eq(creditDefinitions.featureSlug, "emails-free"),
            isNull(creditDefinitions.deletedAt)
          ),
        }),
      validate: (res) => !!res,
      maxAttempts: 10,
      sleepMs: 500,
    });

    expect(emailCredit).toBeDefined();
    expect(emailCredit!.renewOnBilling).toBe(false);
    expect(emailCredit!.expiryDays).toBe(-1);
    expect(emailCredit!.refillRrule).toContain("FREQ=YEARLY");
  });

  it("should maintain correct credit renewal logic when creating new plan versions with editPlan", async () => {
    const client = createTestApiClient(sessionToken);

    // Create a base plan
    const basePlan = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "base-feature",
          displayName: "Base Feature",
          description: "Base feature",
          featureValue: true as FeatureValue,
        },
      ],
      {
        stablePlanId: `version-credit-test-${Date.now()}`,
        versionNumber: 1,
        planName: "Version Credit Test Plan",
        planDescription: "Testing credit logic in new versions",
      }
    );

    // Add a subscriber to force new version creation
    const { createTestPrice, createTestCustomer, createBasicSubscription } =
      await import("../../test-helpers");

    const testPrice = await createTestPrice({
      planId: basePlan.plan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly",
            type: "fixed",
            label: "$20.00 per month",
            amount_cents: 2000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    const testCustomer = await createTestCustomer({
      merchantId,
      email: "version-credit@example.com",
      name: "Version Credit Customer",
    });

    await createBasicSubscription(
      merchantId,
      testCustomer.id,
      basePlan.plan.id,
      testPrice.id
    );

    // Use editPlan to create new version with credit features
    const { editPlan } = await import("../../../src/helpers/plans");
    const result = await editPlan(basePlan.plan.id, merchantId, {
      planName: "Updated Version Credit Test Plan",
      features: [
        {
          slug: "new-usage-feature",
          featureName: "New Usage Feature",
          eventName: "new_usage",
          isUsageBased: true,
          usagePricePerUnit: 8,
          hasCreditAllowance: true,
          creditAllowanceAmount: 150,
          creditAllowanceRenewal: "monthly",
        },
      ],
    });

    expect(result).toHaveProperty("success", true);
    if ("success" in result) {
      expect(result.changeAnalysis.isNewVersion).toBe(true);
      expect(result.plan.versionNumber).toBe(2);

      // Verify credit definition in new version
      const { creditDefinitions } = await import("@lumen/common/schema");
      const { db } = await import("../../../src/db/client");
      const { and, eq, isNull } = await import("drizzle-orm");

      const newVersionCredit = await db.query.creditDefinitions.findFirst({
        where: and(
          eq(creditDefinitions.planId, result.plan.id),
          eq(creditDefinitions.featureSlug, "new-usage-feature"),
          isNull(creditDefinitions.deletedAt)
        ),
      });

      expect(newVersionCredit).toBeDefined();
      expect(newVersionCredit!.renewOnBilling).toBe(true); // Billing-based due to usage pricing
      expect(newVersionCredit!.expiryDays).toBe(-1);
      expect(newVersionCredit!.refillRrule).toBeNull();
      expect(newVersionCredit!.defaultAmount).toBe(150);
    }
  });
});
