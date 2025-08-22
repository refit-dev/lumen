import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  beforeAll,
} from "bun:test";
import { db } from "../../src/db/client";
import {
  creditDefinitions,
  creditGrants,
  creditUsageTransactions,
  invoices,
  invoiceLineItems,
  subscriptions,
  subscriptionDetails,
  customers,
  features,
  plans,
  prices,
  events,
  stripe as stripeSchema,
  organization,
  user,
  planFeatures,
  featureMetrics,
  metrics,
  subscriptionFeatures,
  paymentMethods,
  payments,
  pricingTables,
  pricingTablePlans,
  subscriptionPriceOverrides,
  subscriptionsScheduledChanges,
} from "@lumen/common/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestCustomer,
  createTestApiClient,
  createBasicSubscription,
} from "../test-helpers";
import { FeatureValue } from "../test-helpers/data/feature";
import { hc } from "hono/client";
import { AppType } from "../../src/routes";
import { createCreditDefinition } from "../../src/helpers/credits";
import { getFeatureEntitlement } from "../../src/routes/entitlements";

const cleanupDataFull = async () => {
  // Execute cleanup in multiple batches to handle foreign key constraints properly
  try {
    // First batch: Clean up usage and transaction records
    await db.execute(sql`
      DELETE FROM ${creditUsageTransactions};
      DELETE FROM ${payments};
      DELETE FROM ${invoiceLineItems};
      DELETE FROM ${invoices};
      DELETE FROM ${subscriptionFeatures};
      DELETE FROM ${subscriptionDetails};
      DELETE FROM ${events};
    `);

    // Second batch: Clean up subscription-related records that reference prices
    await db.execute(sql`
      DELETE FROM ${subscriptionsScheduledChanges};
      DELETE FROM ${subscriptions};
      DELETE FROM ${subscriptionPriceOverrides};
      DELETE FROM ${paymentMethods};
    `);

    // Third batch: Clean up credit records that reference prices
    await db.execute(sql`
      DELETE FROM ${creditGrants};
      DELETE FROM ${creditDefinitions};
    `);

    // Fourth batch: Clean up prices and dependent records
    await db.execute(sql`
      DELETE FROM ${prices};
      DELETE FROM ${planFeatures};
      DELETE FROM ${features};
      DELETE FROM ${featureMetrics};
      DELETE FROM ${metrics};
      DELETE FROM ${pricingTablePlans};
      DELETE FROM ${pricingTables};
      DELETE FROM ${plans};
    `);

    // Final batch: Clean up core records
    await db.execute(sql`
      DELETE FROM ${stripeSchema};
      DELETE FROM ${customers};
      DELETE FROM ${user};
      DELETE FROM ${organization};
    `);
  } catch (error) {
    console.error("Error during cleanup:", error);
    throw error;
  }
};

describe("Credit System", () => {
  let merchantId: string;
  let customerId: string;
  let planId: string;
  let priceId: string;
  let featureId: string;
  let featureSlug: string;
  let sessionToken: string;
  let apiClient: ReturnType<typeof hc<AppType>>;

  beforeAll(async () => {
    // Clean up any existing test data
    await cleanupDataFull();
  });

  beforeEach(async () => {
    // 1. Set up test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // 2. Authenticate to get session token
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
    apiClient = createTestApiClient(sessionToken);

    // 3. Create test customer
    const customer = await createTestCustomer({
      merchantId,
      email: `credit-test-customer-${Date.now()}@example.com`,
      name: "Credit Test Customer",
    });
    customerId = customer.id;

    // 4. Create plan with features for testing
    const testFeatures = [
      {
        slug: `api-calls-${Date.now()}`,
        displayName: "API Calls",
        description: "Number of API calls allowed",
        featureValue: 1000 as FeatureValue,
      },
      {
        slug: `storage-${Date.now()}`,
        displayName: "Storage GB",
        description: "Storage capacity in GB",
        featureValue: 50 as FeatureValue,
      },
    ];

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      testFeatures,
      {
        stablePlanId: `credit-test-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Credit Test Plan",
        planDescription: "Plan for testing credit functionality",
      }
    );

    planId = planCreationResult.plan.id;
    featureId = planCreationResult.features[0].id;
    featureSlug = planCreationResult.features[0].slug;

    // 5. Create price for the plan
    const price = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base_fee",
            type: "fixed",
            label: "Monthly Base Fee",
            amount_cents: 2000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: false,
          },
          {
            component_name: "api_usage",
            type: "per_unit",
            label: "API Usage Fee",
            unit_label: "Call",
            amount_cents: 100,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: false,
          },
        ],
      },
    });
    priceId = price.id;
  });

  afterEach(async () => {
    // Clean up test data
    await cleanupDataFull();
  });

  describe("Credit Definition Management", () => {
    describe("POST /credits/definitions", () => {
      it("should create a usage credit definition", async () => {
        const response = await apiClient.credits.definitions.$post({
          json: {
            scope: "plan",
            planId,
            applicationType: "usage",
            priceId,
            priceComponentId: "api_usage",
            featureId,
            featureSlug,
            name: "Free API Calls",
            description: "Monthly free API calls for plan subscribers",
            defaultAmount: 500,
            expiryDays: 30,
            renewOnBilling: true,
            billingVisible: false,
            priority: 50,
          },
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }

        expect(data.definition).toBeDefined();
        expect(data.definition.applicationType).toBe("usage");
        expect(data.definition.featureId).toBe(featureId);
        expect(data.definition.defaultAmount).toBe(500);
        expect(data.definition.billingVisible).toBe(false);
      });

      it("should create a monetary credit definition", async () => {
        const response = await apiClient.credits.definitions.$post({
          json: {
            scope: "plan",
            planId,
            applicationType: "monetary",
            priceId,
            currency: "USD",
            name: "Plan Discount",
            description: "$10 off any component in the plan",
            defaultAmount: 1000, // $10.00 in cents
            billingVisible: true,
            billingDescription: "Plan Discount Applied",
            priority: 200,
          },
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }

        expect(data.definition.applicationType).toBe("monetary");
        expect(data.definition.priceId).toBe(priceId);
        expect(data.definition.currency).toBe("USD");
        expect(data.definition.priceComponentId).toBeNull();
      });

      it("should validate usage credit requirements", async () => {
        const response = await apiClient.credits.definitions.$post({
          json: {
            scope: "plan",
            planId,
            applicationType: "usage",
            // Missing featureId and featureSlug
            name: "Invalid Usage Credit",
            defaultAmount: 500,
          },
        });

        // @ts-expect-error - 400 error from zod is expected but TS doesn't know that
        expect(response.status).toBe(400);
      });

      describe("GET /credits/definitions", () => {
        it("should list all credit definitions for merchant", async () => {
          // Create multiple credit definitions
          await apiClient.credits.definitions.$post({
            json: {
              scope: "plan",
              planId,
              applicationType: "usage",
              priceId,
              priceComponentId: "api_usage",
              featureId,
              featureSlug,
              name: "Usage Credits",
              defaultAmount: 500,
              billingVisible: false,
            },
          });

          // Get all definitions
          const listResponse = await apiClient.credits.definitions.$get({
            query: {},
          });

          expect(listResponse.status).toBe(200);
          const listData = await listResponse.json();
          if ("error" in listData) {
            throw new Error(listData.error);
          }

          expect(listData.definitions).toHaveLength(1);
          expect(listData.definitions[0].applicationType).toBe("usage");
          expect(listData.definitions[0].name).toBe("Usage Credits");
        });

        it("should filter definitions by application type", async () => {
          // Create multiple credit definitions of different types
          await apiClient.credits.definitions.$post({
            json: {
              scope: "plan",
              planId,
              applicationType: "usage",
              priceId,
              priceComponentId: "api_usage",
              featureId,
              featureSlug,
              name: "Usage Credits",
              defaultAmount: 500,
              billingVisible: false,
            },
          });

          await apiClient.credits.definitions.$post({
            json: {
              scope: "plan",
              planId,
              applicationType: "monetary",
              priceId,
              currency: "USD",
              name: "Monetary Credits",
              defaultAmount: 1000,
              billingVisible: true,
            },
          });

          // Filter by usage type
          const usageResponse = await apiClient.credits.definitions.$get({
            query: { applicationType: "usage" },
          });

          expect(usageResponse.status).toBe(200);
          const usageData = await usageResponse.json();
          if ("error" in usageData) {
            throw new Error(usageData.error);
          }

          expect(usageData.definitions).toHaveLength(1);
          expect(usageData.definitions[0].applicationType).toBe("usage");

          // Filter by component type
          const componentResponse = await apiClient.credits.definitions.$get({
            query: { applicationType: "monetary" },
          });

          expect(componentResponse.status).toBe(200);
          const componentData = await componentResponse.json();
          if ("error" in componentData) {
            throw new Error(componentData.error);
          }

          expect(componentData.definitions).toHaveLength(1);
          expect(componentData.definitions[0].applicationType).toBe("monetary");

          // Get all definitions should return both
          const allResponse = await apiClient.credits.definitions.$get({
            query: {},
          });

          expect(allResponse.status).toBe(200);
          const allData = await allResponse.json();
          if ("error" in allData) {
            throw new Error(allData.error);
          }

          expect(allData.definitions).toHaveLength(2);
        });
      });

      describe("PATCH /credits/definitions/:id", () => {
        it("should update a credit definition", async () => {
          // Create a credit definition
          const createResponse = await apiClient.credits.definitions.$post({
            json: {
              scope: "plan",
              planId,
              applicationType: "usage",
              priceId,
              priceComponentId: "api_usage",
              featureId,
              featureSlug,
              name: "Original Name",
              description: "Original description",
              defaultAmount: 500,
              expiryDays: 30,
              billingVisible: false,
              priority: 100,
            },
          });

          expect(createResponse.status).toBe(201);
          const createData = await createResponse.json();
          if ("error" in createData) {
            throw new Error(createData.error);
          }

          const definitionId = createData.definition.id;

          // Update the definition
          const updateResponse = await apiClient.credits.definitions[
            ":id"
          ].update.$post({
            param: { id: definitionId },
            json: {
              name: "Updated Name",
              description: "Updated description",
              defaultAmount: 750,
              expiryDays: 45,
              priority: 150,
              isActive: false,
            },
          });

          expect(updateResponse.status).toBe(200);
          const updateData = await updateResponse.json();
          if ("error" in updateData) {
            throw new Error(updateData.error);
          }

          expect(updateData.definition.name).toBe("Updated Name");
          expect(updateData.definition.description).toBe("Updated description");
          expect(updateData.definition.defaultAmount).toBe(750);
          expect(updateData.definition.expiryDays).toBe(45);
          expect(updateData.definition.priority).toBe(150);
          expect(updateData.definition.isActive).toBe(false);

          // Core fields should remain unchanged
          expect(updateData.definition.applicationType).toBe("usage");
          expect(updateData.definition.scope).toBe("plan");
          expect(updateData.definition.planId).toBe(planId);
          expect(updateData.definition.featureId).toBe(featureId);
        });

        it("should not allow updating core fields", async () => {
          // Create a credit definition
          const createResponse = await apiClient.credits.definitions.$post({
            json: {
              scope: "plan",
              planId,
              applicationType: "usage",
              priceId,
              priceComponentId: "api_usage",
              featureId,
              featureSlug,
              name: "Test Definition",
              defaultAmount: 500,
              billingVisible: false,
            },
          });

          expect(createResponse.status).toBe(201);
          const createData = await createResponse.json();
          if ("error" in createData) {
            throw new Error(createData.error);
          }

          const definitionId = createData.definition.id;
          const originalData = createData.definition;

          // Try to update core fields (should be ignored or fail)
          const updateResponse = await apiClient.credits.definitions[
            ":id"
          ].update.$post({
            param: { id: definitionId },
            json: {
              name: "Updated Name", // This should work
              description: "Updated description", // This should work
              // These core fields should not be updatable through the update endpoint
              applicationType: "monetary" as any,
              scope: "merchant" as any,
              planId: "different_plan_id",
              featureId: "different_feature_id",
            },
          });

          expect(updateResponse.status).toBe(200);
          const updateData = await updateResponse.json();
          if ("error" in updateData) {
            throw new Error(updateData.error);
          }

          // Verify that updatable fields were changed
          expect(updateData.definition.name).toBe("Updated Name");
          expect(updateData.definition.description).toBe("Updated description");

          // Verify that core fields were NOT changed
          expect(updateData.definition.applicationType).toBe(
            originalData.applicationType
          );
          expect(updateData.definition.scope).toBe(originalData.scope);
          expect(updateData.definition.planId).toBe(originalData.planId);
          expect(updateData.definition.featureId).toBe(originalData.featureId);
        });
      });

      describe("DELETE /credits/definitions/:id", () => {
        it("should soft delete a credit definition", async () => {
          // Create a credit definition
          const createResponse = await apiClient.credits.definitions.$post({
            json: {
              scope: "plan",
              planId,
              applicationType: "usage",
              priceId,
              priceComponentId: "api_usage",
              featureId,
              featureSlug,
              name: "Test Definition",
              description: "To be deleted",
              defaultAmount: 500,
              billingVisible: false,
            },
          });

          expect(createResponse.status).toBe(201);
          const createData = await createResponse.json();
          if ("error" in createData) {
            throw new Error(createData.error);
          }

          const definitionId = createData.definition.id;

          // Delete the definition
          const deleteResponse = await apiClient.credits.definitions[
            ":id"
          ].delete.$post({
            param: { id: definitionId },
          });

          expect(deleteResponse.status).toBe(200);
          const deleteData = await deleteResponse.json();
          if ("error" in deleteData) {
            throw new Error(deleteData.error);
          }

          expect(deleteData.definition.deletedAt).toBeDefined();
          expect(deleteData.definition.isActive).toBe(false);

          // Verify it no longer appears in list
          const listResponse = await apiClient.credits.definitions.$get({
            query: {},
          });
          expect(listResponse.status).toBe(200);
          const listData = await listResponse.json();
          if ("error" in listData) {
            throw new Error(listData.error);
          }

          expect(
            listData.definitions.find((d: any) => d.id === definitionId)
          ).toBeUndefined();
        });
      });
    });

    describe("Credit Grant Management", () => {
      let usageCreditDefinitionId: string;
      let monetaryCreditDefinitionId: string;

      beforeEach(async () => {
        // Create credit definitions for testing grants
        const usageDefinition = await createCreditDefinition({
          merchantId,
          scope: "plan",
          planId,
          applicationType: "usage",
          priceId,
          priceComponentId: "api_usage", // Required for usage credits
          featureId,
          featureSlug,
          name: "Test Usage Credits",
          defaultAmount: 500,
          expiryDays: 30,
          billingVisible: false,
        });
        usageCreditDefinitionId = usageDefinition.id;

        const monetaryDefinition = await createCreditDefinition({
          merchantId,
          scope: "plan",
          planId,
          applicationType: "monetary",
          priceId,
          priceComponentId: "base_fee", // Component-specific monetary credit
          currency: "USD",
          name: "Test Monetary Credits",
          defaultAmount: 1000,
          billingVisible: true,
        });
        monetaryCreditDefinitionId = monetaryDefinition.id;
      });

      describe("POST /credits/grants", () => {
        it("should create a usage credit grant and update balance", async () => {
          const response = await apiClient.credits.grants.$post({
            json: {
              customerId,
              creditDefinitionId: usageCreditDefinitionId,
              source: "manual",
              notes: "Test grant for usage credits",
            },
          });

          const data = await response.json();
          if (response.status !== 201) {
            console.error("Response data:", JSON.stringify(data, null, 2));
            throw new Error(
              `Expected 201, got ${response.status}: ${JSON.stringify(data)}`
            );
          }
          if ("error" in data) {
            throw new Error(data.error);
          }

          expect(data.grant).toBeDefined();
          expect(data.grant.customerId).toBe(customerId);
          expect(data.grant.applicationType).toBe("usage");
          expect(data.grant.initialAmount).toBe(500);
          expect(data.grant.remainingAmount).toBe(500);
          expect(data.grant.status).toBe("ACTIVE");
        });

        it("should handle multiple usage credit grants for same feature", async () => {
          // Create first grant
          await apiClient.credits.grants.$post({
            json: {
              customerId,
              creditDefinitionId: usageCreditDefinitionId,
              source: "manual",
            },
          });

          // Create second grant
          await apiClient.credits.grants.$post({
            json: {
              customerId,
              creditDefinitionId: usageCreditDefinitionId,
              initialAmount: 300, // Override default amount
              source: "promotion",
            },
          });

          // Verify both grants exist for the customer
          const listResponse = await apiClient.credits.customers[
            ":customerId"
          ].grants.$get({
            param: { customerId },
            query: { applicationType: "usage" },
          });

          expect(listResponse.status).toBe(200);
          const listData = await listResponse.json();
          if ("error" in listData) {
            throw new Error(listData.error);
          }

          expect(listData.grants).toHaveLength(2);

          // Verify amounts - one default (500), one override (300)
          const amounts = listData.grants
            .map((g: any) => g.initialAmount)
            .sort();
          expect(amounts).toEqual([300, 500]);
        });
      });

      describe("GET /customers/:customerId/grants", () => {
        it("should list all grants for a customer", async () => {
          // Create grants of different types
          const usageGrant = await apiClient.credits.grants.$post({
            json: {
              customerId,
              creditDefinitionId: usageCreditDefinitionId,
              source: "manual",
              notes: "Usage grant",
            },
          });

          const monetaryGrant = await apiClient.credits.grants.$post({
            json: {
              customerId,
              creditDefinitionId: monetaryCreditDefinitionId,
              source: "promotion",
              notes: "Monetary grant",
              initialAmount: 750, // Override default
            },
          });

          expect(usageGrant.status).toBe(201);
          expect(monetaryGrant.status).toBe(201);

          // List all grants for customer
          const listResponse = await apiClient.credits.customers[
            ":customerId"
          ].grants.$get({
            param: { customerId },
            query: {},
          });

          if (listResponse.status !== 200) {
            const errorData = await listResponse.json();
            console.error(
              "List grants error:",
              JSON.stringify(errorData, null, 2)
            );
            throw new Error(
              `Expected 200, got ${listResponse.status}: ${JSON.stringify(errorData)}`
            );
          }

          const listData = await listResponse.json();
          if ("error" in listData) {
            throw new Error(String(listData.error));
          }

          expect(listData.grants).toHaveLength(2);

          const usageGrantData = listData.grants.find(
            (g: any) => g.applicationType === "usage"
          );
          const monetaryGrantData = listData.grants.find(
            (g: any) => g.applicationType === "monetary"
          );

          if (!usageGrantData || !monetaryGrantData) {
            throw new Error("Usage grant or monetary grant not found");
          }

          expect(usageGrantData.initialAmount).toBe(500); // Default amount
          expect(usageGrantData.notes).toBe("Usage grant");

          expect(monetaryGrantData).toBeDefined();
          expect(monetaryGrantData.initialAmount).toBe(750); // Overridden amount
          expect(monetaryGrantData.notes).toBe("Monetary grant");
        });

        it("should filter grants by application type", async () => {
          // Create grants of different types
          await apiClient.credits.grants.$post({
            json: {
              customerId,
              creditDefinitionId: usageCreditDefinitionId,
              source: "manual",
              notes: "Usage grant",
            },
          });

          await apiClient.credits.grants.$post({
            json: {
              customerId,
              creditDefinitionId: monetaryCreditDefinitionId,
              source: "promotion",
              notes: "Monetary grant",
            },
          });

          // Filter by usage type
          const usageResponse = await apiClient.credits.customers[
            ":customerId"
          ].grants.$get({
            param: { customerId },
            query: { applicationType: "usage" },
          });

          expect(usageResponse.status).toBe(200);
          const usageData = await usageResponse.json();
          if ("error" in usageData) {
            throw new Error(usageData.error);
          }

          expect(usageData.grants).toHaveLength(1);
          expect(usageData.grants[0].applicationType).toBe("usage");
          expect(usageData.grants[0].notes).toBe("Usage grant");

          // Filter by monetary type
          const monetaryResponse = await apiClient.credits.customers[
            ":customerId"
          ].grants.$get({
            param: { customerId },
            query: { applicationType: "monetary" },
          });

          expect(monetaryResponse.status).toBe(200);
          const monetaryData = await monetaryResponse.json();
          if ("error" in monetaryData) {
            throw new Error(monetaryData.error);
          }

          expect(monetaryData.grants).toHaveLength(1);
          expect(monetaryData.grants[0].applicationType).toBe("monetary");
          expect(monetaryData.grants[0].notes).toBe("Monetary grant");

          // Get all grants should return both
          const allResponse = await apiClient.credits.customers[
            ":customerId"
          ].grants.$get({
            param: { customerId },
            query: {},
          });

          expect(allResponse.status).toBe(200);
          const allData = await allResponse.json();
          if ("error" in allData) {
            throw new Error(allData.error);
          }

          expect(allData.grants).toHaveLength(2);
        });
      });

      describe("POST /credits/grants/:grantId/revoke", () => {
        it("should revoke a usage credit grant and update entitlements", async () => {
          // Create a subscription for the customer to enable entitlement checks
          const subscription = await createBasicSubscription(
            merchantId,
            customerId,
            planId,
            priceId
          );

          // grant should have been created internally by the subscription creation
          const grant = await db.query.creditGrants.findFirst({
            where: and(
              eq(creditGrants.customerId, customerId),
              eq(creditGrants.creditDefinitionId, usageCreditDefinitionId)
            ),
          });

          if (!grant) {
            throw new Error("Grant not found");
          }

          const grantId = grant.id;

          // Verify entitlement includes credit information after grant creation
          let entitlement = await getFeatureEntitlement(
            merchantId,
            customerId,
            featureSlug
          );
          expect(entitlement.creditInfo?.creditAllowance).toBe(500);

          // Revoke the grant
          const revokeResponse = await apiClient.credits.grants[
            ":id"
          ].revoke.$post({
            param: { id: grantId },
            json: {
              notes: "Test revocation",
            },
          });

          expect(revokeResponse.status).toBe(200);
          const revokeData = await revokeResponse.json();
          if ("error" in revokeData) {
            throw new Error(revokeData.error);
          }

          expect(revokeData.grant.status).toBe("REVOKED");
          expect(revokeData.grant.remainingAmount).toBe(0);
          expect(revokeData.grant.notes).toContain("Test revocation");

          // Verify entitlement is updated after revocation
          entitlement = await getFeatureEntitlement(
            merchantId,
            customerId,
            featureSlug
          );
          expect(entitlement.creditInfo?.creditAllowance).toBe(0);
        });

        it("should revoke a monetary credit grant", async () => {
          // Create a monetary credit grant
          const grantResponse = await apiClient.credits.grants.$post({
            json: {
              customerId,
              creditDefinitionId: monetaryCreditDefinitionId,
              source: "manual",
              notes: "Monetary grant to be revoked",
            },
          });

          expect(grantResponse.status).toBe(201);
          const grantData = await grantResponse.json();
          if ("error" in grantData) {
            throw new Error(grantData.error);
          }

          const grantId = grantData.grant.id;

          // Verify grant is active
          expect(grantData.grant.status).toBe("ACTIVE");
          expect(grantData.grant.remainingAmount).toBe(1000); // Default from definition

          // Revoke the grant
          const revokeResponse = await apiClient.credits.grants[
            ":id"
          ].revoke.$post({
            param: { id: grantId },
            json: {
              notes: "Monetary credit revocation test",
            },
          });

          expect(revokeResponse.status).toBe(200);
          const revokeData = await revokeResponse.json();
          if ("error" in revokeData) {
            throw new Error(revokeData.error);
          }

          expect(revokeData.grant.status).toBe("REVOKED");
          expect(revokeData.grant.remainingAmount).toBe(0);
          expect(revokeData.grant.notes).toContain(
            "Monetary credit revocation test"
          );

          // Verify the grant appears as revoked in customer grants list
          const listResponse = await apiClient.credits.customers[
            ":customerId"
          ].grants.$get({
            param: { customerId },
            query: { status: "REVOKED" },
          });

          expect(listResponse.status).toBe(200);
          const listData = await listResponse.json();
          if ("error" in listData) {
            throw new Error(listData.error);
          }

          expect(listData.grants).toHaveLength(1);
          expect(listData.grants[0].id).toBe(grantId);
          expect(listData.grants[0].status).toBe("REVOKED");
        });
      });
    });

    describe("Grant Renewal Scheduling", () => {
      let monthlyRenewalDefinitionId: string;
      let billingRenewalDefinitionId: string;
      let noRefillAmountDefinitionId: string;

      beforeEach(async () => {
        // Create a credit definition with scheduled renewal (monthly)
        const monthlyDefinition = await createCreditDefinition({
          merchantId,
          scope: "plan",
          planId,
          applicationType: "usage",
          priceId,
          priceComponentId: "api_usage",
          featureId,
          featureSlug,
          name: "Monthly Usage Credits",
          defaultAmount: 1000,
          refillAmount: 500, // Key: has refill amount
          refillRrule: "FREQ=MONTHLY;INTERVAL=1", // Key: has RRULE
          renewOnBilling: false, // Key: not billing-based
          expiryDays: 30,
          billingVisible: false,
        });
        monthlyRenewalDefinitionId = monthlyDefinition.id;

        // Create a credit definition with billing-based renewal
        const billingDefinition = await createCreditDefinition({
          merchantId,
          scope: "plan",
          planId,
          applicationType: "usage",
          priceId,
          priceComponentId: "api_usage",
          featureId,
          featureSlug,
          name: "Billing Usage Credits",
          defaultAmount: 1000,
          refillAmount: 750,
          refillRrule: "FREQ=MONTHLY;INTERVAL=1", // Has RRULE but...
          renewOnBilling: true, // Key: billing-based (should NOT set renewal scheduling)
          expiryDays: 30,
          billingVisible: false,
        });
        billingRenewalDefinitionId = billingDefinition.id;

        // Create a credit definition without refill amount
        const noRefillDefinition = await createCreditDefinition({
          merchantId,
          scope: "plan",
          planId,
          applicationType: "usage",
          priceId,
          priceComponentId: "api_usage",
          featureId,
          featureSlug,
          name: "One-time Usage Credits",
          defaultAmount: 2000,
          // refillAmount: null, // Key: no refill amount
          refillRrule: "FREQ=MONTHLY;INTERVAL=1", // Has RRULE but no refill amount
          renewOnBilling: false,
          expiryDays: 30,
          billingVisible: false,
        });
        noRefillAmountDefinitionId = noRefillDefinition.id;
      });

      it("should create grant with renewal scheduling when definition has refillRrule and refillAmount", async () => {
        const response = await apiClient.credits.grants.$post({
          json: {
            customerId,
            creditDefinitionId: monthlyRenewalDefinitionId,
            source: "subscription",
            notes: "Initial grant with renewal scheduling",
          },
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }

        const grant = data.grant;
        expect(grant.nextRenewalDate).toBeDefined();
        expect(grant.nextRenewalDate).not.toBeNull();
        expect(grant.renewalRrule).toBe("FREQ=MONTHLY;INTERVAL=1");
        expect(grant.lastRenewalDate).toBeNull();

        // Verify the next renewal date is in the future (approximately 1 month from now)
        const nextRenewal = new Date(grant.nextRenewalDate!);
        const now = new Date();
        const oneMonthFromNow = new Date();
        oneMonthFromNow.setMonth(oneMonthFromNow.getMonth() + 1);

        expect(nextRenewal.getTime()).toBeGreaterThan(now.getTime());
        // Should be approximately 1 month in the future (within 2 days tolerance)
        const timeDiff = Math.abs(
          nextRenewal.getTime() - oneMonthFromNow.getTime()
        );
        expect(timeDiff).toBeLessThan(2 * 24 * 60 * 60 * 1000); // 2 days in milliseconds
      });

      it("should NOT create renewal scheduling for billing-based renewals", async () => {
        const response = await apiClient.credits.grants.$post({
          json: {
            customerId,
            creditDefinitionId: billingRenewalDefinitionId,
            source: "subscription",
            notes: "Billing-based grant (no scheduling)",
          },
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }

        const grant = data.grant;
        // Should NOT have renewal scheduling because renewOnBilling=true
        expect(grant.nextRenewalDate).toBeNull();
        expect(grant.renewalRrule).toBeNull();
        expect(grant.lastRenewalDate).toBeNull();
      });

      it("should NOT create renewal scheduling when definition has no refillAmount", async () => {
        const response = await apiClient.credits.grants.$post({
          json: {
            customerId,
            creditDefinitionId: noRefillAmountDefinitionId,
            source: "subscription",
            notes: "No refill amount (no scheduling)",
          },
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }

        const grant = data.grant;
        // Should NOT have renewal scheduling because no refillAmount
        expect(grant.nextRenewalDate).toBeNull();
        expect(grant.renewalRrule).toBeNull();
        expect(grant.lastRenewalDate).toBeNull();
      });

      it("should create renewal grant (refill) without its own renewal scheduling", async () => {
        // First create the initial grant
        const initialResponse = await apiClient.credits.grants.$post({
          json: {
            customerId,
            creditDefinitionId: monthlyRenewalDefinitionId,
            source: "subscription", // Initial grant
            notes: "Initial grant",
          },
        });

        expect(initialResponse.status).toBe(201);
        const initialData = await initialResponse.json();
        if ("error" in initialData) {
          throw new Error(initialData.error);
        }

        // Verify initial grant has renewal scheduling
        expect(initialData.grant.nextRenewalDate).toBeDefined();
        expect(initialData.grant.renewalRrule).toBe("FREQ=MONTHLY;INTERVAL=1");

        // Now create a renewal grant (simulating what the renewal job would do)
        const renewalResponse = await apiClient.credits.grants.$post({
          json: {
            customerId,
            creditDefinitionId: monthlyRenewalDefinitionId,
            source: "refill", // Renewal grant
            notes: "Renewal grant",
            initialAmount: 500, // Use refillAmount
          },
        });

        expect(renewalResponse.status).toBe(201);
        const renewalData = await renewalResponse.json();
        if ("error" in renewalData) {
          throw new Error(renewalData.error);
        }

        // Verify renewal grant ALSO has renewal scheduling (baton passing)
        expect(renewalData.grant.nextRenewalDate).toBeDefined();
        expect(renewalData.grant.renewalRrule).toBe("FREQ=MONTHLY;INTERVAL=1");
        expect(renewalData.grant.lastRenewalDate).toBeNull();
        expect(renewalData.grant.initialAmount).toBe(500);
      });

      it("should handle quarterly renewal scheduling correctly", async () => {
        // Create a quarterly renewal definition
        const quarterlyDefinition = await createCreditDefinition({
          merchantId,
          scope: "plan",
          planId,
          applicationType: "usage",
          priceId,
          priceComponentId: "api_usage",
          featureId,
          featureSlug,
          name: "Quarterly Usage Credits",
          defaultAmount: 3000,
          refillAmount: 1500,
          refillRrule: "FREQ=MONTHLY;INTERVAL=3", // Every 3 months
          renewOnBilling: false,
          expiryDays: 120,
          billingVisible: false,
        });

        const response = await apiClient.credits.grants.$post({
          json: {
            customerId,
            creditDefinitionId: quarterlyDefinition.id,
            source: "subscription",
            notes: "Quarterly grant",
          },
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }

        const grant = data.grant;
        expect(grant.nextRenewalDate).toBeDefined();
        expect(grant.renewalRrule).toBe("FREQ=MONTHLY;INTERVAL=3");

        // Verify the next renewal date is approximately 3 months from now
        const nextRenewal = new Date(grant.nextRenewalDate!);
        const now = new Date();
        const threeMonthsFromNow = new Date();
        threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);

        expect(nextRenewal.getTime()).toBeGreaterThan(now.getTime());
        // Should be approximately 3 months in the future (within 3 days tolerance)
        const timeDiff = Math.abs(
          nextRenewal.getTime() - threeMonthsFromNow.getTime()
        );
        expect(timeDiff).toBeLessThan(3 * 24 * 60 * 60 * 1000); // 3 days in milliseconds
      });
    });
  });
});
