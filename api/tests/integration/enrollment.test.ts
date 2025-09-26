import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { db } from "../../src/db/client";
import {
  planEnrollmentRules,
  pricingTables,
  pricingTablePlans,
  internalKeyValues,
} from "@lumen/common/schema";
import { eq, and, isNull } from "drizzle-orm";
import {
  createFullTestEnvironment,
  createTestPlan,
  createTestPrice,
  cleanupDataFull,
} from "../test-helpers";
import { YC_ENROLLMENT_PLACEHOLDER_DOMAIN } from "@lumen/common/utils";
import { createEnrollmentSubscriptionForUser } from "../../src/helpers/create-enrollment-subscription";

describe("Enrollment Rules Tests", () => {
  let testEnv: Awaited<ReturnType<typeof createFullTestEnvironment>>;

  beforeAll(async () => {
    testEnv = await createFullTestEnvironment();
  });

  afterAll(async () => {
    await cleanupDataFull();
  });

  describe("Email and Domain Enrollment Rules", () => {
    let freePlan: Awaited<ReturnType<typeof createTestPlan>>;
    let pricingTable: any;

    afterEach(async () => {
      // Clean up pricing table and plans created in this test
      if (pricingTable) {
        await db
          .delete(pricingTablePlans)
          .where(eq(pricingTablePlans.pricingTableId, pricingTable.id));
        await db
          .delete(pricingTables)
          .where(eq(pricingTables.id, pricingTable.id));
      }
    });

    beforeEach(async () => {
      // Create a free plan for enrollment rules
      freePlan = await createTestPlan({
        merchantId: testEnv.merchant.id,
        planName: "Enrollment Free Plan",
      });

      const freePriceData = {
        dsl_version: 1,
        components: [
          {
            component_name: "free_base",
            type: "fixed" as const,
            label: "Free Plan",
            amount_cents: 0,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      };

      await createTestPrice({
        planId: freePlan.id,
        merchantId: testEnv.merchant.id,
        currency: "USD",
        pricingData: freePriceData,
        isOverridePrice: false,
      });

      // Create a pricing table and associate the plan
      const [table] = await db
        .insert(pricingTables)
        .values({
          merchantId: testEnv.merchant.id,
          slug: `test-pricing-table-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          name: "Test Pricing Table",
          isActive: true,
        })
        .returning();

      pricingTable = table;

      await db.insert(pricingTablePlans).values({
        merchantId: testEnv.merchant.id,
        pricingTableId: table.id,
        planId: freePlan.id,
        displayOrder: 1,
      });
    });

    it("should match email-based enrollment rule", async () => {
      // Create email-based enrollment rule
      await db.insert(planEnrollmentRules).values({
        merchantId: testEnv.merchant.id,
        planId: freePlan.id,
        matcherType: "email",
        matcherValue: "specific@example.com",
        isActive: true,
      });

      const enrollmentData = {
        customerEmail: "specific@example.com",
        customerName: "Specific User",
        userId: "ext_user_specific",
      };

      const [result, statusCode] = await createEnrollmentSubscriptionForUser({
        ...enrollmentData,
        merchantId: testEnv.merchant.id,
      });

      expect(statusCode).toBe(200);
      expect(result).toMatchObject({
        message: "Enrollment subscription created successfully",
        plan: expect.objectContaining({
          id: freePlan.id,
        }),
      });
    });

    it("should match domain-based enrollment rule", async () => {
      // Create domain-based enrollment rule
      await db.insert(planEnrollmentRules).values({
        merchantId: testEnv.merchant.id,
        planId: freePlan.id,
        matcherType: "domain",
        matcherValue: "company.com",
        isActive: true,
      });

      const enrollmentData = {
        customerEmail: "user@company.com",
        customerName: "Company User",
        userId: "ext_user_company",
      };

      const [result, statusCode] = await createEnrollmentSubscriptionForUser({
        ...enrollmentData,
        merchantId: testEnv.merchant.id,
      });

      expect(statusCode).toBe(200);
      expect(result).toMatchObject({
        message: "Enrollment subscription created successfully",
        plan: expect.objectContaining({
          id: freePlan.id,
        }),
      });
    });

    it("should handle case-insensitive matching", async () => {
      // Create enrollment rule with mixed case
      await db.insert(planEnrollmentRules).values({
        merchantId: testEnv.merchant.id,
        planId: freePlan.id,
        matcherType: "domain",
        matcherValue: "CaseSensitive.COM",
        isActive: true,
      });

      const enrollmentData = {
        customerEmail: "user@casesensitive.com",
        customerName: "Case Test User",
        userId: "ext_user_case",
      };

      const [result, statusCode] = await createEnrollmentSubscriptionForUser({
        ...enrollmentData,
        merchantId: testEnv.merchant.id,
      });

      expect(statusCode).toBe(200);
      expect(result).toMatchObject({
        message: "Enrollment subscription created successfully",
        plan: expect.objectContaining({
          id: freePlan.id,
        }),
      });
    });

    it("should handle YC companies placeholder domain", async () => {
      // Set up YC companies in internal key values
      const ycCompanies = [
        "startup1.com",
        "startup2.com",
        "ycombinator-company.io",
      ];
      await db
        .insert(internalKeyValues)
        .values({
          key: YC_ENROLLMENT_PLACEHOLDER_DOMAIN,
          value: ycCompanies,
        })
        .onConflictDoUpdate({
          target: internalKeyValues.key,
          set: {
            value: ycCompanies,
            updatedAt: new Date(),
          },
        });

      // Create YC enrollment rule
      await db.insert(planEnrollmentRules).values({
        merchantId: testEnv.merchant.id,
        planId: freePlan.id,
        matcherType: "domain",
        matcherValue: YC_ENROLLMENT_PLACEHOLDER_DOMAIN,
        isActive: true,
      });

      const enrollmentData = {
        customerEmail: "founder@startup1.com",
        customerName: "YC Founder",
        userId: "ext_user_yc",
      };

      const [result, statusCode] = await createEnrollmentSubscriptionForUser({
        ...enrollmentData,
        merchantId: testEnv.merchant.id,
      });

      expect(statusCode).toBe(200);
      expect(result).toMatchObject({
        message: "Enrollment subscription created successfully",
        plan: expect.objectContaining({
          id: freePlan.id,
        }),
      });
    });

    it("should not match inactive enrollment rules", async () => {
      // Create inactive enrollment rule
      await db.insert(planEnrollmentRules).values({
        merchantId: testEnv.merchant.id,
        planId: freePlan.id,
        matcherType: "email",
        matcherValue: "inactive@example.com",
        isActive: false,
      });

      const enrollmentData = {
        customerEmail: "inactive@example.com",
        customerName: "Inactive User",
        userId: "ext_user_inactive",
      };

      const [result, statusCode] = await createEnrollmentSubscriptionForUser({
        ...enrollmentData,
        merchantId: testEnv.merchant.id,
      });

      // Should fallback to free subscription logic
      expect(statusCode).toBe(200);
      expect(result).toMatchObject({
        message: "Free subscription created successfully",
      });
    });

    it("should not match soft-deleted enrollment rules", async () => {
      // Create and soft-delete enrollment rule
      const [rule] = await db
        .insert(planEnrollmentRules)
        .values({
          merchantId: testEnv.merchant.id,
          planId: freePlan.id,
          matcherType: "email",
          matcherValue: "deleted@example.com",
          isActive: true,
        })
        .returning();

      // Soft delete the rule
      await db
        .update(planEnrollmentRules)
        .set({ deletedAt: new Date() })
        .where(eq(planEnrollmentRules.id, rule.id));

      const enrollmentData = {
        customerEmail: "deleted@example.com",
        customerName: "Deleted Rule User",
        userId: "ext_user_deleted",
      };

      const [result, statusCode] = await createEnrollmentSubscriptionForUser({
        ...enrollmentData,
        merchantId: testEnv.merchant.id,
      });

      // Should fallback to free subscription logic
      expect(statusCode).toBe(200);
      expect(result).toMatchObject({
        message: "Free subscription created successfully",
      });
    });
  });
});
