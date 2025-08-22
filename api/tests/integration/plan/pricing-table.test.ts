import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { createTestApiClient } from "../../test-helpers";
import { FeatureValue } from "../../test-helpers/data/feature";

// NOTE: Pricing table updates are automatically handled when creating new plan versions

describe("Pricing table reference updates", () => {
  let merchantId: string;
  let sessionToken: string;

  beforeEach(async () => {
    const { createFullTestEnvironment, authenticateTestUser } = await import(
      "../../test-helpers"
    );
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResp = await authenticateTestUser(user.email, user.password);
    sessionToken = authResp.cookies.sessionToken;
  });

  afterEach(async () => {
    const { cleanupDataFull } = await import(
      "../../test-helpers/test-utils/setup"
    );
    await cleanupDataFull();
  });

  it("should update pricing table to point at the new plan version when editPlan creates one", async () => {
    const {
      createTestPlanWithFeatures,
      createTestPrice,
      createTestCustomer,
      createBasicSubscription,
    } = await import("../../test-helpers");
    const { createTestPricingTable } = await import(
      "../../test-helpers/data/pricing-table"
    );
    const { editPlan } = await import("../../../src/helpers/plans");
    const { db } = await import("../../../src/db/client");
    const { pricingTablePlans } = await import("@lumen/common/schema");
    const { and, eq, isNull } = await import("drizzle-orm");

    // 1. Create a simple plan with one feature so we can attach it to a pricing table
    const planRes = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "pt-feature",
          displayName: "Pricing Table Feature",
          description: "Feature for pricing table test",
          featureValue: true as FeatureValue,
        },
      ],
      {
        stablePlanId: `pt-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Pricing Table Test Plan",
        planDescription: "Plan used to test pricing table reference updates",
      }
    );

    const originalPlan = planRes.plan;

    // 2. Attach a price so we can subscribe a customer
    const priceRes = await createTestPrice({
      planId: originalPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly",
            type: "fixed",
            label: "$10 per month",
            amount_cents: 1000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    // 3. Create a pricing table that includes this plan
    const pricingTable = await createTestPricingTable({
      merchantId,
      name: "PT Update Table",
      slug: `pt-update-${Date.now()}`,
      planIds: [originalPlan.id],
    });

    // 4. Add a subscriber to force new version creation
    const cust = await createTestCustomer({
      merchantId,
      email: "pt-update@example.com",
      name: "PT Update Customer",
    });

    await createBasicSubscription(
      merchantId,
      cust.id,
      originalPlan.id,
      priceRes.id
    );

    // 5. Call editPlan with a price change so a new version is required
    const editRes = await editPlan(originalPlan.id, merchantId, {
      monthlyPrice: 2000, // price change triggers new version
    });

    expect(editRes).toHaveProperty("success", true);
    if ("success" in editRes) {
      // Ensure a new version was created
      expect(editRes.changeAnalysis.isNewVersion).toBe(true);

      const newPlanId = editRes.plan.id;
      expect(newPlanId).not.toBe(originalPlan.id);

      // 6. Verify the pricing table now references the new plan version
      const associations = await db.query.pricingTablePlans.findMany({
        where: and(
          eq(pricingTablePlans.pricingTableId, pricingTable.id),
          isNull(pricingTablePlans.deletedAt)
        ),
      });

      expect(associations).toHaveLength(1);
      expect(associations[0].planId).toBe(newPlanId);
    }
  });

  it("should update pricing table to point to previous version when a plan version is deleted", async () => {
    const {
      createTestPlanWithFeatures,
      createTestPrice,
      createTestCustomer,
      createBasicSubscription,
    } = await import("../../test-helpers");
    const { createTestPricingTable } = await import(
      "../../test-helpers/data/pricing-table"
    );
    const { editPlan } = await import("../../../src/helpers/plans");
    const { db } = await import("../../../src/db/client");
    const { plans, pricingTablePlans } = await import("@lumen/common/schema");
    const { and, eq, isNull } = await import("drizzle-orm");
    const apiClient = createTestApiClient(sessionToken);

    // 1. Create a plan (version 1)
    const planRes = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "delete-test-feature",
          displayName: "Delete Test Feature",
          description: "Feature for deletion test",
          featureValue: true as FeatureValue,
        },
      ],
      {
        stablePlanId: `delete-test-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Delete Test Plan v1",
        planDescription: "Version 1 for deletion test",
      }
    );

    const v1Plan = planRes.plan;

    // 2. Attach price and subscriber to version 1
    const v1Price = await createTestPrice({
      planId: v1Plan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly",
            type: "fixed",
            label: "$15 per month",
            amount_cents: 1500,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    const customer = await createTestCustomer({
      merchantId,
      email: "delete-test@example.com",
      name: "Delete Test Customer",
    });

    await createBasicSubscription(
      merchantId,
      customer.id,
      v1Plan.id,
      v1Price.id
    );

    // 3. Create version 2 (which will trigger new version due to subscriber)
    const v2Result = await editPlan(v1Plan.id, merchantId, {
      planName: "Delete Test Plan v2",
      monthlyPrice: 2000, // price change triggers new version
    });

    expect(v2Result).toHaveProperty("success", true);
    if (!("success" in v2Result)) return;

    const v2Plan = v2Result.plan;
    expect(v2Plan.versionNumber).toBe(2);

    // 4. Create a pricing table that includes version 2 (latest)
    const pricingTable = await createTestPricingTable({
      merchantId,
      name: "Delete Test Table",
      slug: `delete-test-${Date.now()}`,
      planIds: [v2Plan.id],
    });

    // 5. Verify pricing table points to v2
    let associations = await db.query.pricingTablePlans.findMany({
      where: and(
        eq(pricingTablePlans.pricingTableId, pricingTable.id),
        isNull(pricingTablePlans.deletedAt)
      ),
    });
    expect(associations).toHaveLength(1);
    expect(associations[0].planId).toBe(v2Plan.id);

    // 6. Delete version 2 (should update pricing table to point to version 1)
    const deleteResponse = await apiClient.plans[":id"].$delete({
      param: { id: v2Plan.id },
    });
    expect(deleteResponse.status).toBe(200);

    // 7. Verify pricing table now points to version 1
    associations = await db.query.pricingTablePlans.findMany({
      where: and(
        eq(pricingTablePlans.pricingTableId, pricingTable.id),
        isNull(pricingTablePlans.deletedAt)
      ),
    });
    expect(associations).toHaveLength(1);
    expect(associations[0].planId).toBe(v1Plan.id);

    // 8. Delete version 1 (should remove from pricing table entirely)
    const deleteV1Response = await apiClient.plans[":id"].$delete({
      param: { id: v1Plan.id },
    });
    expect(deleteV1Response.status).toBe(200);

    // 9. Verify pricing table entry is now deleted
    associations = await db.query.pricingTablePlans.findMany({
      where: and(
        eq(pricingTablePlans.pricingTableId, pricingTable.id),
        isNull(pricingTablePlans.deletedAt)
      ),
    });
    expect(associations).toHaveLength(0);
  });
});
