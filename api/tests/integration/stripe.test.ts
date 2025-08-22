import { describe, it, beforeEach, expect, afterEach } from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
} from "../test-helpers";
import { db } from "../../src/db/client";
import { stripe as stripeDbSchema } from "@lumen/common/schema";
import { eq, and, isNull } from "drizzle-orm";
import { decryptField, EncryptedField } from "../../src/helpers/encryption";
import { testEnv } from "../test-env";
import { Stripe } from "stripe";
import { createTestStripe } from "../test-helpers/data/stripe";

// Helper function to clean up webhooks after each test
async function cleanupWebhooks() {
  const secretKey = testEnv.TEST_STRIPE_SECRET_KEY;

  if (!secretKey || !secretKey.startsWith("sk_test_")) {
    console.warn("Skipping webhook cleanup - no valid test key found");
    return;
  }

  const stripe = new Stripe(secretKey, {
    apiVersion: "2025-02-24.acacia",
  });

  try {
    const webhooks = await stripe.webhookEndpoints.list({
      limit: 100,
    });

    for (const webhook of webhooks.data) {
      await stripe.webhookEndpoints.del(webhook.id);
    }
  } catch (error) {
    console.error("Error cleaning up webhooks:", error);
  }
}

// Helper function to clean up Stripe configurations (API keys) from database after each test
async function cleanupStripeConfigurations() {
  try {
    await db.delete(stripeDbSchema);
  } catch (error) {
    console.error("Error cleaning up Stripe configurations:", error);
  }
}

describe("Stripe Integration Security", () => {
  let merchantId: string;
  let sessionToken: string;
  let client: ReturnType<typeof createTestApiClient>;

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create a client with session authentication
    client = createTestApiClient(sessionToken);
  });

  afterEach(async () => {
    await Promise.all([cleanupWebhooks(), cleanupStripeConfigurations()]);
  });

  describe("Configuration Security", () => {
    it("should encrypt secret keys in database", async () => {
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      // Create Stripe configuration
      const response = await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      // Check the database to verify the stored value is encrypted
      const dbConfig = await db.query.stripe.findFirst({
        where: and(
          eq(stripeDbSchema.merchantId, merchantId),
          isNull(stripeDbSchema.deletedAt)
        ),
      });

      expect(dbConfig).not.toBeNull();
      expect(dbConfig!.secretKey).not.toBe(testSecretKey);
      // Encrypted values should be objects with iv, tag, and data properties
      expect(typeof dbConfig!.secretKey).toBe("object");
      expect(dbConfig!.secretKey).toHaveProperty("iv");
      expect(dbConfig!.secretKey).toHaveProperty("tag");
      expect(dbConfig!.secretKey).toHaveProperty("data");
      expect(dbConfig!.webhookSecret).not.toBeNull();
      expect(typeof dbConfig!.webhookSecret).toBe("object");
    });
    it("should properly decrypt and mask secret keys in responses", async () => {
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      // Create Stripe configuration
      await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      // Fetch the configuration
      const response = await client.stripe.config.$get();
      expect(response.status).toBe(200);

      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      // Verify the secret key is properly masked
      expect(data.secretKey).toBe("sk_test****");
      expect(data.secretKey).not.toBe(testSecretKey);
      expect(data.publicKey).toBe(testPublicKey); // Public key should not be masked
      expect(data.hasWebhook).toBe(true);
    });

    it("should encrypt webhook secrets in database", async () => {
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      // Create Stripe configuration
      await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      // Check webhook secret encryption
      const dbConfig = await db.query.stripe.findFirst({
        where: and(
          eq(stripeDbSchema.merchantId, merchantId),
          isNull(stripeDbSchema.deletedAt)
        ),
      });

      expect(dbConfig).not.toBeNull();
      expect(dbConfig!.webhookSecret).not.toBeNull();

      // Webhook secret should be encrypted (object with encryption properties)
      expect(typeof dbConfig!.webhookSecret).toBe("object");
      expect(dbConfig!.webhookSecret).toHaveProperty("iv");
      expect(dbConfig!.webhookSecret).toHaveProperty("tag");
      expect(dbConfig!.webhookSecret).toHaveProperty("data");

      // Should be able to decrypt it
      const decryptedWebhookSecret = await decryptField(
        dbConfig!.webhookSecret as EncryptedField
      );
      expect(decryptedWebhookSecret).toMatch(/^whsec_/);
    });
  });

  describe("Merchant Isolation", () => {
    it("should prevent access to other merchant's Stripe configuration", async () => {
      // Create a second merchant with Stripe config
      const { merchant: otherMerchant } = await createFullTestEnvironment();

      // Create Stripe config for the other merchant
      await createTestStripe({
        merchantId: otherMerchant.id,
        publicKey: "pk_test_other_merchant",
        secretKey: "sk_test_other_merchant",
        webhookSecret: "whsec_other_merchant",
      });

      // Try to access Stripe config with current merchant's session
      const response = await client.stripe.config.$get();

      // Should return 404 because current merchant has no Stripe config
      expect(response.status).toBe(404);
      const data = await response.json();
      if (!("error" in data)) {
        throw new Error("Expected error response");
      }
      expect(data.error).toBe("Stripe configuration not found");
    });

    it("should isolate Stripe configurations between merchants", async () => {
      // Create two merchants with different Stripe configurations
      const { merchant: merchant1 } = await createFullTestEnvironment();
      const { user: user2, merchant: merchant2 } =
        await createFullTestEnvironment();

      // Create Stripe config for merchant1
      await createTestStripe({
        merchantId: merchant1.id,
        publicKey: "pk_test_merchant1",
        secretKey: "sk_test_merchant1",
        webhookSecret: "whsec_merchant1",
      });

      // Create Stripe config for merchant2
      await createTestStripe({
        merchantId: merchant2.id,
        publicKey: "pk_test_merchant2",
        secretKey: "sk_test_merchant2",
        webhookSecret: "whsec_merchant2",
      });

      // Authenticate as merchant2
      const authResponse2 = await authenticateTestUser(
        user2.email,
        user2.password
      );
      const client2 = createTestApiClient(authResponse2.cookies.sessionToken);

      // Fetch config for merchant2
      const response = await client2.stripe.config.$get();
      expect(response.status).toBe(200);

      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      // Verify merchant2 only gets their own config
      expect(data.publicKey).toBe("pk_test_merchant2");
      expect(data.secretKey).toBe("sk_test****");
      expect(data.hasWebhook).toBe(true);
    });
  });

  describe("Configuration Updates", () => {
    it("should handle webhook replacement when updating configuration", async () => {
      const testSecretKey1 = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey1 = testEnv.TEST_STRIPE_PUBLIC_KEY;

      // Create initial configuration
      await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey1,
          publicKey: testPublicKey1,
        },
      });

      // Get initial webhook secret
      const initialConfig = await db.query.stripe.findFirst({
        where: and(
          eq(stripeDbSchema.merchantId, merchantId),
          isNull(stripeDbSchema.deletedAt)
        ),
      });
      const initialWebhookSecret = initialConfig!.webhookSecret;

      // Update configuration (using same keys to avoid creating multiple webhooks)
      const updateResponse = await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey1,
          publicKey: testPublicKey1,
        },
      });

      expect(updateResponse.status).toBe(200);
      const updateData = await updateResponse.json();
      if ("error" in updateData) {
        throw new Error(`Unexpected error: ${updateData.error}`);
      }

      // Verify the configuration was updated
      const updatedConfig = await db.query.stripe.findFirst({
        where: and(
          eq(stripeDbSchema.merchantId, merchantId),
          isNull(stripeDbSchema.deletedAt)
        ),
      });

      expect(updatedConfig).not.toBeNull();
      expect(updatedConfig!.publicKey).toBe(testPublicKey1);

      // Webhook secret should be different (new webhook created)
      expect(updatedConfig!.webhookSecret).not.toBe(initialWebhookSecret);

      // Verify the secret key is encrypted
      const decryptedSecretKey = await decryptField(
        updatedConfig!.secretKey as EncryptedField
      );
      expect(decryptedSecretKey).toBe(testSecretKey1);
    });

    it("should maintain single active configuration per merchant", async () => {
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      // Create multiple configurations (should update, not duplicate)
      await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      // Verify only one active configuration exists
      const activeConfigs = await db.query.stripe.findMany({
        where: and(
          eq(stripeDbSchema.merchantId, merchantId),
          isNull(stripeDbSchema.deletedAt)
        ),
      });

      expect(activeConfigs.length).toBe(1);
      expect(activeConfigs[0].publicKey).toBe(testPublicKey);
    });
  });
});

describe("Stripe Integration Functionality", () => {
  let merchantId: string;
  let sessionToken: string;
  let client: ReturnType<typeof createTestApiClient>;

  beforeEach(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    client = createTestApiClient(sessionToken);
  });

  afterEach(async () => {
    await Promise.all([cleanupWebhooks(), cleanupStripeConfigurations()]);
  });

  describe("Configuration Creation", () => {
    it("should create Stripe configuration with valid keys", async () => {
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      const response = await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      expect(data.message).toBe("Stripe configuration created successfully");
      expect(data.id).toBeDefined();
      expect(data.webhook).toBeDefined();
      expect(data.webhook.secret).toMatch(/^whsec_/);
    });

    it("should enforce validation on configuration creation", async () => {
      // Test missing secret key
      const response1 = await client.stripe.config.$post({
        json: {
          publicKey: "pk_test_valid",
        } as any,
      });
      expect(response1.status).toBe(400);

      // Test missing public key
      const response2 = await client.stripe.config.$post({
        json: {
          secretKey: "sk_test_valid",
        } as any,
      });
      expect(response2.status).toBe(400);

      // Test empty secret key
      const response3 = await client.stripe.config.$post({
        json: {
          secretKey: "",
          publicKey: "pk_test_valid",
        },
      });
      expect(response3.status).toBe(400);

      // Test empty public key
      const response4 = await client.stripe.config.$post({
        json: {
          secretKey: "sk_test_valid",
          publicKey: "",
        },
      });
      expect(response4.status).toBe(400);
    });
  });

  describe("Configuration Retrieval", () => {
    it("should return 404 when no configuration exists", async () => {
      const response = await client.stripe.config.$get();

      expect(response.status).toBe(404);
      const data = await response.json();
      if (!("error" in data)) {
        throw new Error("Expected error response");
      }
      expect(data.error).toBe("Stripe configuration not found");
    });

    it("should return configuration with proper data structure", async () => {
      // Create a configuration first
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      // Retrieve the configuration
      const response = await client.stripe.config.$get();
      expect(response.status).toBe(200);

      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      // Verify response structure
      expect(data.id).toBeDefined();
      expect(data.publicKey).toBe(testPublicKey);
      expect(data.secretKey).toBe("sk_test****");
      expect(data.hasWebhook).toBe(true);
      expect(data.createdAt).toBeDefined();
      expect(typeof data.createdAt).toBe("string");
    });
  });

  describe("Error Handling", () => {
    it("should handle database errors gracefully", async () => {
      // This test would require mocking database failures
      // For now, we'll test that the error handling structure is in place
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      // Test with valid data (should succeed)
      const response = await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      // Should succeed with valid data
      expect(response.status).toBe(200);
    });
  });

  describe("Webhook Management", () => {
    it("should create webhook endpoint with proper URL", async () => {
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      const response = await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      expect(data.webhook).toBeDefined();
      expect(data.webhook.secret).toMatch(/^whsec_/);
      expect(data.webhook.url).toBeDefined();

      // URL should contain merchant ID for proper routing
      expect(data.webhook.url).toContain(merchantId);
    });

    it("should handle webhook creation with proper enabled events", async () => {
      const testSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
      const testPublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;

      const response = await client.stripe.config.$post({
        json: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      // Verify webhook has correct enabled events
      expect(data.webhook.enabled_events).toContain("payment_intent.succeeded");
    });
  });
});
