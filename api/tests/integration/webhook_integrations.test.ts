import { describe, it, beforeEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  createTestSecretKey,
  createApiKeyClient,
  createTestPlan,
  createTestPrice,
} from "../test-helpers";
import { createTestPricingTable } from "../test-helpers/data/pricing-table";
import { db } from "../../src/db/client";
import { customers, subscriptions } from "@lumen/common/schema";
import { and, eq, isNull } from "drizzle-orm";
import { testEnv } from "../test-env";
import { createTestStripe } from "../test-helpers/data/stripe";

describe("Integration Webhooks", () => {
  let merchantId: string;
  let apiKey: string;
  let apiClient: ReturnType<typeof createApiKeyClient>;
  let freePlanId: string;
  let pricingTableId: string;

  beforeEach(async () => {
    // Set up a test environment
    const { merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Create API key for webhook authentication
    const secretKey = await createTestSecretKey({ merchantId });
    apiKey = secretKey.rawKeyValue;
    apiClient = createApiKeyClient(apiKey);

    // Create a free plan with pricing data
    const freePlan = await createTestPlan({
      merchantId,
      planName: "Free Plan",
      planDescription: "Free plan for webhook testing",
      stablePlanId: `free_plan_${Date.now()}`,
    });
    freePlanId = freePlan.id;

    // Create a price for the free plan (with 0 cost components)
    const freePriceData = {
      dsl_version: 1,
      components: [
        {
          component_name: "base_fee",
          type: "fixed" as const,
          label: "Free Monthly Fee",
          amount_cents: 0, // Free!
          recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
          bill_immediately: true,
        },
      ],
    };

    await createTestPrice({
      planId: freePlanId,
      merchantId,
      currency: "USD",
      pricingData: freePriceData,
      isOverridePrice: false,
    });

    // Create a pricing table and associate the free plan using the test helper
    const pricingTable = await createTestPricingTable({
      merchantId,
      name: "Default Pricing Table",
      slug: `default-pricing-table-${Date.now()}`,
      description: "Default pricing table for webhook testing",
      isActive: true,
      planIds: [freePlanId],
      planConfigs: [
        {
          planId: freePlanId,
          displayOrder: 1,
          isPopular: false,
          buttonText: "Get Started",
          buttonOutline: false,
        },
      ],
    });
    pricingTableId = pricingTable.id;

    // Set up Stripe configuration for the merchant
    await createTestStripe({
      merchantId,
      secretKey: testEnv.TEST_STRIPE_SECRET_KEY,
      publicKey: testEnv.TEST_STRIPE_PUBLIC_KEY,
      webhookSecret: "whsec_test_secret",
    });
  });

  describe("Supabase Webhook", () => {
    it("should create a free subscription for a new Supabase user", async () => {
      const supabasePayload = {
        type: "INSERT",
        table: "users",
        record: {
          id: "user_123",
          email: "test@example.com",
          raw_user_meta_data: {
            name: "John Doe",
          },
        },
      };

      const response = await apiClient.webhooks.supabase.$post({
        json: supabasePayload,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;

      if ("error" in body) {
        throw new Error(`Unexpected error: ${body.error}`);
      }

      expect(body.received).toBe(true);
      expect(body.subscription).toBeDefined();
      expect(body.subscription.id).toBeDefined();

      // Verify customer was created
      const createdCustomer = await db.query.customers.findFirst({
        where: and(
          eq(customers.merchantId, merchantId),
          eq(customers.email, "test@example.com"),
          eq(customers.externalCustomerId, "user_123"),
          isNull(customers.deletedAt)
        ),
      });

      expect(createdCustomer).toBeDefined();
      expect(createdCustomer!.name).toBe("John Doe");
      expect(createdCustomer!.email).toBe("test@example.com");
      expect(createdCustomer!.externalCustomerId).toBe("user_123");

      // Verify subscription was created
      const createdSubscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.merchantId, merchantId),
          eq(subscriptions.customerId, createdCustomer!.id),
          isNull(subscriptions.deletedAt)
        ),
      });

      expect(createdSubscription).toBeDefined();
      expect(createdSubscription!.planId).toBe(freePlanId);
    });

    it("should extract name from different metadata fields", async () => {
      const testCases = [
        {
          metadata: { full_name: "Jane Smith" },
          expectedName: "Jane Smith",
        },
        {
          metadata: { first_name: "Bob", last_name: "Johnson" },
          expectedName: "Bob Johnson",
        },
        {
          metadata: { first_name: "Alice" },
          expectedName: "Alice",
        },
      ];

      for (const testCase of testCases) {
        const supabasePayload = {
          type: "INSERT",
          table: "users",
          record: {
            id: `user_${Date.now()}_${Math.random()}`,
            email: `test_${Date.now()}@example.com`,
            raw_user_meta_data: testCase.metadata,
          },
        };

        const response = await apiClient.webhooks.supabase.$post({
          json: supabasePayload,
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as any;

        if ("error" in body) {
          throw new Error(`Unexpected error: ${body.error}`);
        }

        // Verify customer was created with correct name
        const createdCustomer = await db.query.customers.findFirst({
          where: and(
            eq(customers.merchantId, merchantId),
            eq(customers.email, supabasePayload.record.email),
            isNull(customers.deletedAt)
          ),
        });

        expect(createdCustomer).toBeDefined();
        expect(createdCustomer!.name).toBe(testCase.expectedName);
      }
    });

    it("should handle missing metadata by using email username", async () => {
      const supabasePayload = {
        type: "INSERT",
        table: "users",
        record: {
          id: "user_no_metadata",
          email: "testuser@example.com",
          // No metadata provided
        },
      };

      const response = await apiClient.webhooks.supabase.$post({
        json: supabasePayload,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;

      if ("error" in body) {
        throw new Error(`Unexpected error: ${body.error}`);
      }

      // Verify customer was created with email username as name
      const createdCustomer = await db.query.customers.findFirst({
        where: and(
          eq(customers.merchantId, merchantId),
          eq(customers.email, "testuser@example.com"),
          isNull(customers.deletedAt)
        ),
      });

      expect(createdCustomer).toBeDefined();
      expect(createdCustomer!.name).toBe("testuser");
    });

    it("should return error for invalid payload", async () => {
      const invalidPayload = {
        type: "UPDATE", // Invalid type
        table: "users",
        record: {
          id: "user_123",
          email: "test@example.com",
        },
      };

      const response = await apiClient.webhooks.supabase.$post({
        json: invalidPayload,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;

      if (!("error" in body)) {
        throw new Error("Expected error response");
      }

      expect(body.error).toContain("Supabase webhook processing failed");
    });
  });

  describe("Clerk Webhook", () => {
    it("should create a free subscription for a new Clerk user", async () => {
      const clerkPayload = {
        type: "user.created",
        data: {
          id: "user_1287ygj3",
          email_addresses: [
            {
              email_address: "clerk@example.com",
              id: "email_123",
            },
          ],
          first_name: "John",
          last_name: "Doe",
          username: null,
        },
      };

      const response = await apiClient.webhooks.clerk.$post({
        json: clerkPayload,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;

      if ("error" in body) {
        throw new Error(`Unexpected error: ${body.error}`);
      }

      expect(body.received).toBe(true);
      expect(body.subscription).toBeDefined();
      expect(body.subscription.id).toBeDefined();

      // Verify customer was created
      const createdCustomer = await db.query.customers.findFirst({
        where: and(
          eq(customers.merchantId, merchantId),
          eq(customers.email, "clerk@example.com"),
          eq(customers.externalCustomerId, "user_1287ygj3"),
          isNull(customers.deletedAt)
        ),
      });

      expect(createdCustomer).toBeDefined();
      expect(createdCustomer!.name).toBe("John Doe");
      expect(createdCustomer!.email).toBe("clerk@example.com");
      expect(createdCustomer!.externalCustomerId).toBe("user_1287ygj3");

      // Verify subscription was created
      const createdSubscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.merchantId, merchantId),
          eq(subscriptions.customerId, createdCustomer!.id),
          isNull(subscriptions.deletedAt)
        ),
      });

      expect(createdSubscription).toBeDefined();
      expect(createdSubscription!.planId).toBe(freePlanId);
    });

    it("should extract name from different combinations", async () => {
      const testCases = [
        {
          first_name: "Alice",
          last_name: "Wonder",
          username: "alice123",
          expectedName: "Alice Wonder",
        },
        {
          first_name: "Bob",
          last_name: null,
          username: "bob456",
          expectedName: "Bob",
        },
        {
          first_name: null,
          last_name: "Smith",
          username: "smith789",
          expectedName: "Smith",
        },
        {
          first_name: null,
          last_name: null,
          username: "testuser",
          expectedName: "testuser",
        },
      ];

      for (const testCase of testCases) {
        const clerkPayload = {
          type: "user.created",
          data: {
            id: `user_${Date.now()}_${Math.random()}`,
            email_addresses: [
              {
                email_address: `test_${Date.now()}@example.com`,
                id: "email_123",
              },
            ],
            first_name: testCase.first_name,
            last_name: testCase.last_name,
            username: testCase.username,
          },
        };

        const response = await apiClient.webhooks.clerk.$post({
          json: clerkPayload,
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as any;

        if ("error" in body) {
          throw new Error(`Unexpected error: ${body.error}`);
        }

        // Verify customer was created with correct name
        const createdCustomer = await db.query.customers.findFirst({
          where: and(
            eq(customers.merchantId, merchantId),
            eq(
              customers.email,
              clerkPayload.data.email_addresses[0].email_address
            ),
            isNull(customers.deletedAt)
          ),
        });

        expect(createdCustomer).toBeDefined();
        expect(createdCustomer!.name).toBe(testCase.expectedName);
      }
    });

    it("should handle missing email address", async () => {
      const clerkPayload = {
        type: "user.created",
        data: {
          id: "user_no_email",
          email_addresses: [], // No email addresses
          first_name: "Test",
          last_name: "User",
          username: "testuser",
        },
      };

      const response = await apiClient.webhooks.clerk.$post({
        json: clerkPayload,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;

      if (!("error" in body)) {
        throw new Error("Expected error response");
      }

      expect(body.error).toBe("No email address found for user");
    });

    it("should return error for invalid payload", async () => {
      const invalidPayload = {
        type: "user.updated", // Invalid type
        data: {
          id: "user_123",
          email_addresses: [
            {
              email_address: "test@example.com",
              id: "email_123",
            },
          ],
          first_name: "John",
          last_name: "Doe",
          username: null,
        },
      };

      const response = await apiClient.webhooks.clerk.$post({
        json: invalidPayload,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;

      if (!("error" in body)) {
        throw new Error("Expected error response");
      }

      expect(body.error).toContain("Clerk webhook processing failed");
    });
  });

  describe("Webhook Authentication", () => {
    it("should require API key authentication", async () => {
      // Create a client without API key
      const unauthenticatedClient = createApiKeyClient("");

      const supabasePayload = {
        type: "INSERT",
        table: "users",
        record: {
          id: "user_123",
          email: "test@example.com",
        },
      };

      const response = await unauthenticatedClient.webhooks.supabase.$post({
        json: supabasePayload,
      });

      expect(response.status).toBe(401);
    });

    it("should reject invalid API keys", async () => {
      const invalidApiClient = createApiKeyClient("invalid_key");

      const supabasePayload = {
        type: "INSERT",
        table: "users",
        record: {
          id: "user_123",
          email: "test@example.com",
        },
      };

      const response = await invalidApiClient.webhooks.supabase.$post({
        json: supabasePayload,
      });

      expect(response.status).toBe(401);
    });
  });

  describe("Duplicate User Handling", () => {
    it("should not create duplicate subscriptions for existing users", async () => {
      const userId = "duplicate_user_123";
      const email = "duplicate@example.com";

      // Create first subscription
      const supabasePayload = {
        type: "INSERT",
        table: "users",
        record: {
          id: userId,
          email: email,
          raw_user_meta_data: {
            name: "John Doe",
          },
        },
      };

      const response1 = await apiClient.webhooks.supabase.$post({
        json: supabasePayload,
      });

      expect(response1.status).toBe(200);

      // Try to create second subscription with same user ID
      const response2 = await apiClient.webhooks.supabase.$post({
        json: supabasePayload,
      });

      expect(response2.status).toBe(409);
      const body = (await response2.json()) as any;

      if (!("error" in body)) {
        throw new Error("Expected error response");
      }

      expect(body.error).toBe("Subscription already exists for this customer");
    });
  });

  describe("Error Handling", () => {
    it("should handle missing Stripe configuration", async () => {
      // Create a new merchant without Stripe configuration
      const { merchant: merchantWithoutStripe } =
        await createFullTestEnvironment();

      // Create a free plan with pricing data for this merchant
      const freePlan = await createTestPlan({
        merchantId: merchantWithoutStripe.id,
        planName: "Free Plan",
        planDescription: "Free plan for webhook testing",
        stablePlanId: `free_plan_${Date.now()}`,
      });

      // Create a price for the free plan (with 0 cost components)
      const freePriceData = {
        dsl_version: 1,
        components: [
          {
            component_name: "base_fee",
            type: "fixed" as const,
            label: "Free Monthly Fee",
            amount_cents: 0, // Free!
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      };

      await createTestPrice({
        planId: freePlan.id,
        merchantId: merchantWithoutStripe.id,
        currency: "USD",
        pricingData: freePriceData,
        isOverridePrice: false,
      });

      // Create a pricing table and associate the free plan
      await createTestPricingTable({
        merchantId: merchantWithoutStripe.id,
        name: "Default Pricing Table",
        slug: `default-pricing-table-${Date.now()}`,
        description: "Default pricing table for webhook testing",
        isActive: true,
        planIds: [freePlan.id],
        planConfigs: [
          {
            planId: freePlan.id,
            displayOrder: 1,
            isPopular: false,
            buttonText: "Get Started",
            buttonOutline: false,
          },
        ],
      });

      // Create API key for this merchant
      const secretKey = await createTestSecretKey({
        merchantId: merchantWithoutStripe.id,
      });
      const clientWithoutStripe = createApiKeyClient(secretKey.rawKeyValue);

      const supabasePayload = {
        type: "INSERT",
        table: "users",
        record: {
          id: "user_no_stripe",
          email: "nostripe@example.com",
        },
      };

      const response = await clientWithoutStripe.webhooks.supabase.$post({
        json: supabasePayload,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;

      if (!("error" in body)) {
        throw new Error("Expected error response");
      }

      expect(body.error).toContain("No payment provider configured");
    });

    it("should handle missing free plans", async () => {
      // Create a new merchant with Stripe but no free plans
      const { merchant: merchantWithoutFreePlans } =
        await createFullTestEnvironment();

      // Set up Stripe configuration
      await createTestStripe({
        merchantId: merchantWithoutFreePlans.id,
        secretKey: testEnv.TEST_STRIPE_SECRET_KEY,
        publicKey: testEnv.TEST_STRIPE_PUBLIC_KEY,
        webhookSecret: "whsec_test_secret",
      });

      // Create API key for this merchant
      const secretKey = await createTestSecretKey({
        merchantId: merchantWithoutFreePlans.id,
      });
      const clientWithoutFreePlans = createApiKeyClient(secretKey.rawKeyValue);

      const supabasePayload = {
        type: "INSERT",
        table: "users",
        record: {
          id: "user_no_free_plans",
          email: "nofree@example.com",
        },
      };

      const response = await clientWithoutFreePlans.webhooks.supabase.$post({
        json: supabasePayload,
      });

      expect(response.status).toBe(404);
      const body = (await response.json()) as any;

      if (!("error" in body)) {
        throw new Error("Expected error response");
      }

      expect(body.error).toBe(
        "No active pricing tables found for this merchant"
      );
    });
  });
});
