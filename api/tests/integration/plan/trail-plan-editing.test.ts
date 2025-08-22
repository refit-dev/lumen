import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
} from "../../test-helpers";
import { retryWithSleep } from "../../test-helpers/test-utils";
import { cleanupDataFull } from "../../test-helpers/test-utils/setup";
import { creditDefinitions, plans } from "@lumen/common/schema";
import { db } from "../../../src/db/client";
import { and, eq, isNull } from "drizzle-orm";

describe("Trial Plan Editing", () => {
  let merchantId: string;
  let sessionToken: string;
  let basePlan: any;

  beforeEach(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create a base plan with usage-based features for comprehensive testing
    const client = createTestApiClient(sessionToken);
    const response = await client.plans.$post({
      json: {
        planName: "Edit Trial Test Plan",
        planDescription: "Plan for testing trial editing functionality",
        stablePlanId: `edit-trial-${Date.now()}`,
        newFeatures: [
          {
            slug: "api-calls-edit",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5, // 5 cents per API call
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000, // 1000 free API calls per month
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "storage-gb-edit",
            featureName: "Storage GB",
            eventName: "storage_used",
            isUsageBased: true,
            usagePricePerUnit: 10, // 10 cents per GB
            hasCreditAllowance: true,
            creditAllowanceAmount: 100, // 100 GB free storage per month
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support",
            featureName: "Premium Support",
            isUsageBased: false,
            hasCreditAllowance: false,
          },
        ],
        monthlyPrice: 2000, // $20.00
        hasYearlyPrice: true,
        yearlyPrice: 18000, // $180.00 (10% discount)
        trial: {
          enabled: true,
          days: 14,
          creditOverrides: [
            { featureSlug: "api-calls-edit", allowance: 500 }, // Trial gets 500 API calls
            { featureSlug: "storage-gb-edit", allowance: 50 }, // Trial gets 50 GB
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
  });

  afterEach(async () => {
    await cleanupDataFull();
  });

  it("should handle comprehensive trial plan editing scenarios in one test", async () => {
    const client = createTestApiClient(sessionToken);

    // Verify initial trial plan was created correctly
    const initialTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, basePlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(initialTrialPlan).toBeDefined();
    expect(initialTrialPlan!.trialDays).toBe(14);

    // Verify initial trial credits were created
    const initialTrialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, initialTrialPlan!.id),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });
    expect(initialTrialCredits).toHaveLength(2);

    // SCENARIO 1: Update existing trial configuration (change days and credit allowances)
    console.log("[TEST] SCENARIO 1: Update existing trial configuration");
    let editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        planDescription: "Updated plan with modified trial",
        features: [
          {
            slug: "api-calls-edit",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "storage-gb-edit",
            featureName: "Storage GB",
            eventName: "storage_used",
            isUsageBased: true,
            usagePricePerUnit: 10,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support",
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
          days: 21, // Changed from 14 to 21 days
          creditOverrides: [
            { featureSlug: "api-calls-edit", allowance: 750 }, // Changed from 500 to 750
            { featureSlug: "storage-gb-edit", allowance: 75 }, // Changed from 50 to 75
          ],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    let editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }
    expect(editBody.success).toBe(true);

    // Verify trial plan was updated (not recreated)
    const updatedTrialPlans = await db.query.plans.findMany({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, basePlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(updatedTrialPlans).toBeDefined();
    expect(updatedTrialPlans).toHaveLength(1);
    expect(updatedTrialPlans[0].id).toBe(initialTrialPlan!.id); // Same trial plan, updated in place
    expect(updatedTrialPlans[0].trialDays).toBe(21);

    // Verify trial credits were updated
    const updatedTrialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, initialTrialPlan!.id),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(updatedTrialCredits).toHaveLength(2);

    const apiCallsCredit = updatedTrialCredits.find(
      (c) => c.featureSlug === "api-calls-edit"
    );
    const storageCredit = updatedTrialCredits.find(
      (c) => c.featureSlug === "storage-gb-edit"
    );
    expect(apiCallsCredit!.defaultAmount).toBe(750);
    expect(apiCallsCredit!.expiryDays).toBe(21);
    expect(storageCredit!.defaultAmount).toBe(75);
    expect(storageCredit!.expiryDays).toBe(21);

    // SCENARIO 2: Add new usage-based feature while trial exists
    console.log("[TEST] SCENARIO 2: Add new usage-based feature");
    editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        features: [
          // Keep existing features
          {
            slug: "api-calls-edit",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "storage-gb-edit",
            featureName: "Storage GB",
            eventName: "storage_used",
            isUsageBased: true,
            usagePricePerUnit: 10,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support",
            featureName: "Premium Support",
            isUsageBased: false,
            hasCreditAllowance: false,
          },
          // Add new usage-based feature
          {
            slug: "sms-messages",
            featureName: "SMS Messages",
            eventName: "sms_sent",
            isUsageBased: true,
            usagePricePerUnit: 15, // 15 cents per SMS
            hasCreditAllowance: true,
            creditAllowanceAmount: 200, // 200 free SMS per month
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 2500, // Increased price for new feature
        trial: {
          enabled: true,
          days: 21,
          creditOverrides: [
            { featureSlug: "api-calls-edit", allowance: 750 },
            { featureSlug: "storage-gb-edit", allowance: 75 },
            { featureSlug: "sms-messages", allowance: 100 }, // Must provide trial allowance for new feature
          ],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    // Verify new trial credit was created for SMS feature
    const newTrialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, initialTrialPlan!.id),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(newTrialCredits).toHaveLength(3); // api-calls, storage, sms

    const smsCredit = newTrialCredits.find(
      (c) => c.featureSlug === "sms-messages"
    );
    expect(smsCredit).toBeDefined();
    expect(smsCredit!.defaultAmount).toBe(100);
    expect(smsCredit!.expiryDays).toBe(21);

    // SCENARIO 3: Remove usage-based feature while trial exists
    console.log("[TEST] SCENARIO 3: Remove usage-based feature");
    editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        features: [
          // Keep api-calls and premium-support, remove storage-gb-edit and sms-messages
          {
            slug: "api-calls-edit",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support",
            featureName: "Premium Support",
            isUsageBased: false,
            hasCreditAllowance: false,
          },
        ],
        monthlyPrice: 1500, // Reduced price after removing features
        trial: {
          enabled: true,
          days: 21,
          creditOverrides: [
            { featureSlug: "api-calls-edit", allowance: 750 },
            // storage-gb-edit and sms-messages removed
          ],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    // Verify trial credits for removed features were deleted
    const remainingTrialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, initialTrialPlan!.id),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(remainingTrialCredits).toHaveLength(1);
    expect(remainingTrialCredits[0].featureSlug).toBe("api-calls-edit");

    // SCENARIO 4: Disable trial completely
    console.log("[TEST] SCENARIO 4: Disable trial completely");
    editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        planDescription: "Plan with trial disabled",
        features: [
          {
            slug: "api-calls-edit",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support",
            featureName: "Premium Support",
            isUsageBased: false,
            hasCreditAllowance: false,
          },
        ],
        monthlyPrice: 1500,
        // trial field omitted = trial disabled
      },
    });

    expect(editResponse.status).toBe(200);
    editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    // Verify trial plan was soft deleted
    const deletedTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, basePlan.id)
      ),
    });

    expect(deletedTrialPlan).toBeDefined();
    expect(deletedTrialPlan!.deletedAt).not.toBeNull();

    // Verify all trial credits were soft deleted
    const deletedTrialCredits = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, initialTrialPlan!.id),
        eq(creditDefinitions.applicationType, "usage")
      ),
    });
    expect(deletedTrialCredits.every((c) => c.deletedAt !== null)).toBe(true);

    // SCENARIO 5: Re-enable trial (after it was disabled)
    console.log("[TEST] SCENARIO 5: Re-enable trial after disabling");
    editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        planDescription: "Plan with trial re-enabled",
        features: [
          {
            slug: "api-calls-edit",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support",
            featureName: "Premium Support",
            isUsageBased: false,
            hasCreditAllowance: false,
          },
        ],
        monthlyPrice: 1500,
        trial: {
          enabled: true,
          days: 7, // New trial duration
          creditOverrides: [
            { featureSlug: "api-calls-edit", allowance: 250 }, // New trial allowance
          ],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    // Verify new trial plan was created (old one was deleted)
    const newTrialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, basePlan.id),
        isNull(plans.deletedAt)
      ),
    });

    expect(newTrialPlan).toBeDefined();
    expect(newTrialPlan!.id).not.toBe(initialTrialPlan!.id); // New trial plan created
    expect(newTrialPlan!.trialDays).toBe(7);

    // Verify new trial credits were created
    const newTrialCreditsAgain = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, newTrialPlan!.id),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(newTrialCreditsAgain).toHaveLength(1);
    expect(newTrialCreditsAgain[0].featureSlug).toBe("api-calls-edit");
    expect(newTrialCreditsAgain[0].defaultAmount).toBe(250);
    expect(newTrialCreditsAgain[0].expiryDays).toBe(7);
  });

  it("should require explicit trial allowances for all usage-based features", async () => {
    const client = createTestApiClient(sessionToken);

    // Try to edit with a new usage-based feature but missing trial allowance
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        features: [
          {
            slug: "api-calls-edit",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 5,
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "new-usage-feature",
            featureName: "New Usage Feature",
            eventName: "new_event",
            isUsageBased: true,
            usagePricePerUnit: 20,
            hasCreditAllowance: true,
            creditAllowanceAmount: 500,
            creditAllowanceRenewal: "monthly",
          },
        ],
        trial: {
          enabled: true,
          days: 14,
          creditOverrides: [
            { featureSlug: "api-calls-edit", allowance: 500 },
            // Missing allowance for "new-usage-feature" - should cause error
          ],
        },
      },
    });

    expect(editResponse.status).toBe(400);
    const editBody = await editResponse.json();
    expect("error" in editBody).toBe(true);
    if ("error" in editBody) {
      expect(editBody.error).toContain(
        "Trial allowance must be explicitly provided for usage-based feature: new-usage-feature"
      );
    }
  });

  it("should handle feature type changes affecting trial credits", async () => {
    const client = createTestApiClient(sessionToken);

    // Change a usage-based feature to non-usage-based (should remove trial credit)
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: basePlan.id },
      json: {
        features: [
          {
            slug: "api-calls-edit",
            featureName: "API Calls",
            isUsageBased: false, // Changed from usage-based to non-usage-based
            hasCreditAllowance: false,
          },
          {
            slug: "storage-gb-edit",
            featureName: "Storage GB",
            eventName: "storage_used",
            isUsageBased: true,
            usagePricePerUnit: 10,
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
        ],
        trial: {
          enabled: true,
          days: 14,
          creditOverrides: [
            // No allowance for api-calls-edit since it's no longer usage-based
            { featureSlug: "storage-gb-edit", allowance: 50 },
          ],
        },
      },
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    // Verify trial credit for api-calls-edit was removed
    const remainingCredits = await retryWithSleep({
      fn: () =>
        db.query.creditDefinitions.findMany({
          where: and(
            eq(creditDefinitions.planId, basePlan.id), // Look in main plan first to get trial plan ID
            eq(creditDefinitions.applicationType, "usage"),
            isNull(creditDefinitions.deletedAt)
          ),
        }),
      validate: () => true, // Just get current state
    });

    // Get the trial plan to check its credits
    const trialPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.merchantId, merchantId),
        eq(plans.isTrialPlan, true),
        eq(plans.trialParentPlanId, basePlan.id),
        isNull(plans.deletedAt)
      ),
    });
    expect(trialPlan).toBeDefined();

    const trialCredits = await retryWithSleep({
      fn: () =>
        db.query.creditDefinitions.findMany({
          where: and(
            eq(creditDefinitions.planId, trialPlan!.id),
            eq(creditDefinitions.applicationType, "usage"),
            isNull(creditDefinitions.deletedAt)
          ),
        }),
      validate: (credits: (typeof creditDefinitions.$inferSelect)[]) =>
        credits.length === 1 && credits[0].featureSlug === "storage-gb-edit",
    });

    expect(trialCredits).toHaveLength(1);
    expect(trialCredits[0].featureSlug).toBe("storage-gb-edit");
    // api-calls-edit credit should be gone since it's no longer usage-based
  });
});
