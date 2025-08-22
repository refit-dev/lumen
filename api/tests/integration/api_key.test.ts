import { describe, it, beforeEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createApiKeyClient,
  createTestSecretKey,
  createTestPublishableKey,
} from "../test-helpers";
import { db } from "../../src/db/client";
import { apiKeys } from "@lumen/common/schema";
import { eq, isNull, and } from "drizzle-orm";
import { createPrefixedId, ID_PREFIXES } from "@lumen/common";

describe("API Keys Management", () => {
  let merchantId: string;
  let sessionToken: string;
  let apiClient: ReturnType<typeof createTestApiClient>;

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create a client with session authentication
    apiClient = createTestApiClient(sessionToken);
  });

  describe("Creating API Keys", () => {
    it("should create a secret API key using session auth", async () => {
      const response = await apiClient["api-keys"].$post({
        json: {
          name: "Test Secret Key",
          keyType: "secret",
        },
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(data.data.name).toBe("Test Secret Key");
      expect(data.data.keyType).toBe("secret");
      expect(data.data.environment).toBe("live");
      expect(data.data.keyValue).toBeDefined();
      expect(data.data.keyValue!.startsWith("sk_live_")).toBe(true);
      expect(data.data.keyValue!.length).toBe(32); // 8 + 24 (sk_live_<24 letter key>)
      expect(data.data.permissions).toEqual(["admin"]);
    });

    it("should create a publishable API key using session auth", async () => {
      const response = await apiClient["api-keys"].$post({
        json: {
          name: "Test Publishable Key",
          keyType: "publishable",
        },
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(data.data.name).toBe("Test Publishable Key");
      expect(data.data.keyType).toBe("publishable");
      expect(data.data.environment).toBe("live");
      expect(data.data.keyValue).toBeDefined();
      expect(data.data.keyValue!.startsWith("pk_live_")).toBe(true);
      expect(data.data.keyValue!.length).toBe(32); // 8 + 24 (pk_live_<24 letter key>)
      expect(data.data.permissions).toEqual(["public"]);
    });

    it("should enforce validation on API key creation", async () => {
      // Test missing name
      const response1 = await apiClient["api-keys"].$post({
        // @ts-expect-error - we are testing the validation
        json: { keyType: "secret" },
      });
      expect(response1.status).toBe(400);

      // Test invalid key type
      const response2 = await apiClient["api-keys"].$post({
        json: {
          name: "Invalid Key",
          // @ts-expect-error - we are testing the validation
          keyType: "invalid_type",
        },
      });
      expect(response2.status).toBe(400);

      // Test invalid environment
      const response3 = await apiClient["api-keys"].$post({
        json: {
          name: "Invalid Environment",
          keyType: "secret",
          // @ts-expect-error - we are testing the validation
          environment: "invalid_env",
        },
      });
      expect(response3.status).toBe(400);
    });

    it("should assign default permissions based on key type", async () => {
      // Create a secret key (should get admin permission by default)
      const secretKeyResponse = await apiClient["api-keys"].$post({
        json: {
          name: "Default Secret Key",
          keyType: "secret",
        },
      });
      const secretKeyData = await secretKeyResponse.json();
      if ("error" in secretKeyData) {
        throw new Error(`Unexpected error: ${secretKeyData.error}`);
      }
      expect(secretKeyData.data.permissions).toEqual(["admin"]);

      // Create a publishable key (should get public permission by default)
      const publishableKeyResponse = await apiClient["api-keys"].$post({
        json: {
          name: "Default Publishable Key",
          keyType: "publishable",
        },
      });
      const publishableKeyData = await publishableKeyResponse.json();
      if ("error" in publishableKeyData) {
        throw new Error(`Unexpected error: ${publishableKeyData.error}`);
      }
      expect(publishableKeyData.data.permissions).toEqual(["public"]);
    });

    it("should fail when creating a secret key without admin permission", async () => {
      const response = await apiClient["api-keys"].$post({
        json: {
          name: "Custom Permissions Key",
          keyType: "secret",
          permissions: ["public"],
        },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      if (!("error" in data)) {
        throw new Error(`Unexpected response: Expected error in response`);
      }
      expect(data.error).toBe("Bad Request");
    });
  });

  describe("Listing API Keys", () => {
    beforeEach(async () => {
      // Create some test API keys
      await createTestSecretKey({
        merchantId,
        name: "Test Secret Key 1",
      });
      await createTestSecretKey({
        merchantId,
        name: "Test Secret Key 2",
      });
      await createTestPublishableKey({
        merchantId,
        name: "Test Publishable Key",
      });
    });

    it("should list all Secret API keys for the merchant", async () => {
      const response = await apiClient["api-keys"].$get();

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThanOrEqual(2);

      // Verify the keys are properly formatted
      const keys = data.data;
      for (const key of keys) {
        expect(key.id).toBeDefined();
        expect(key.name).toBeDefined();
        expect(key.keyType).toBeDefined();
        expect(key.environment).toBeDefined();
        expect(key.prefix).toBeDefined();
        expect(key.createdAt).toBeDefined();
        // Full key value should never be exposed
        expect(key.keyValue).toBeDefined();
        expect(key.keyValue).toMatch(/^[sp]k_(test|live)_[a-zA-Z0-9]+$/);
      }
    });

    it("should not expose full secret key values", async () => {
      const response = await apiClient["api-keys"].$get();
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      const keys = data.data;

      // For each key, verify the actual key value is not exposed
      // Instead, it should only show the prefix
      for (const key of keys) {
        const prefixMatch = key.keyValue.match(
          /^[sp]k_(test|live)_[a-zA-Z0-9]{4}$/
        );
        expect(prefixMatch).not.toBeNull();
      }
    });
  });

  describe("Revoking API Keys", () => {
    let testKeyId: string;

    beforeEach(async () => {
      // Create a test API key
      const key = await createTestSecretKey({
        merchantId,
        name: "Key to Revoke",
      });
      testKeyId = key.id;
    });

    it("should revoke an API key", async () => {
      const response = await apiClient["api-keys"][":id"].$delete({
        param: { id: testKeyId },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(testKeyId);
      expect(data.data.revokedAt).toBeDefined();

      // Verify the key is revoked in the database
      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, testKeyId),
      });

      expect(key).not.toBeNull();
      expect(key!.revokedAt).not.toBeNull();
    });

    it("should return 404 for non-existent key", async () => {
      const nonExistentId = createPrefixedId(ID_PREFIXES.apiKey);
      const response = await apiClient["api-keys"][":id"].$delete({
        param: { id: nonExistentId },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      if ("success" in data) {
        throw new Error("Expected unsuccessful response for 404");
      }
      expect(data.error).toBe("API key not found");
    });

    it("should not allow revoking keys from another merchant", async () => {
      // Create a new test environment with a different merchant
      const { merchant: otherMerchant } = await createFullTestEnvironment();

      // Create a key for the other merchant
      const otherKey = await createTestSecretKey({
        merchantId: otherMerchant.id,
        name: "Other Merchant Key",
      });

      // Try to revoke the other merchant's key
      const response = await apiClient["api-keys"][":id"].$delete({
        param: { id: otherKey.id },
      });

      expect(response.status).toBe(404);

      // Verify the key was not revoked
      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, otherKey.id),
      });

      expect(key).not.toBeNull();
      expect(key!.revokedAt).toBeNull();
    });
  });
});

describe("API Key Authentication", () => {
  let merchantId: string;
  let secretKey: string;
  let publishableKey: string;

  beforeEach(async () => {
    // Set up a test environment
    const { merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Create test API keys
    const secretKeyObj = await createTestSecretKey({ merchantId });
    secretKey = secretKeyObj.rawKeyValue;

    const publishableKeyObj = await createTestPublishableKey({ merchantId });
    publishableKey = publishableKeyObj.rawKeyValue;
  });

  it("should authenticate with a secret key", async () => {
    const apiClient = createApiKeyClient(secretKey);

    // Try to access a protected route
    const response = await apiClient.merchants[":id"].$get({
      param: { id: merchantId },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    if ("error" in data) {
      throw new Error(`Unexpected error: ${data.error}`);
    }
    expect(data.id).toBe(merchantId);
  });

  it("should reject a publishable key on protected routes", async () => {
    const apiClient = createApiKeyClient(publishableKey);

    // Try to access a protected route with a publishable key
    const response = await apiClient.merchants[":id"].$get({
      param: { id: merchantId },
    });

    // @ts-expect-error - we are testing the validation
    expect(response.status).toBe(403);
    const data = await response.json();
    if (!("error" in data)) {
      throw new Error(`Unexpected error: Success response received`);
    }
  });

  it("should reject an invalid API key", async () => {
    const apiClient = createApiKeyClient("invalid_key");

    // Try to access a protected route with an invalid key
    const response = await apiClient.merchants[":id"].$get({
      param: { id: merchantId },
    });

    // @ts-expect-error - we are testing the validation
    expect(response.status).toBe(401);
    const data = await response.json();
    if (!("error" in data)) {
      throw new Error(`Unexpected error: Success response received`);
    }
    expect(data.error).toBe(
      "Invalid API key. Hint: a valid API key starts with sk_live_ or sk_test_"
    );
  });

  it("should reject a revoked API key", async () => {
    // Create a key to revoke
    const keyToRevoke = await createTestSecretKey({
      merchantId,
      name: "Key To Revoke",
    });
    const keyToRevokeValue = keyToRevoke.rawKeyValue;

    // Revoke the key
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyToRevoke.id));

    // Try to use the revoked key
    const apiClient = createApiKeyClient(keyToRevokeValue);
    const response = await apiClient.merchants[":id"].$get({
      param: { id: merchantId },
    });

    // @ts-expect-error - we are testing the validation
    expect(response.status).toBe(401);
    const data = await response.json();
    if (!("error" in data)) {
      throw new Error(`Unexpected error: Success response received`);
    }
    expect(data.error).toBe("Unauthorized");
  });

  it("should update lastUsedAt timestamp on key usage", async () => {
    const keyObj = await createTestSecretKey({
      merchantId,
      name: "Usage Tracking Key",
    });
    const keyValue = keyObj.rawKeyValue;

    // Record the current timestamp
    const initialTimestamp = keyObj.lastUsedAt;
    expect(initialTimestamp).toBeNull();

    // Wait to ensure we can detect a timestamp change
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Use the key
    const apiClient = createApiKeyClient(keyValue);
    const response = await apiClient.merchants[":id"].$get({
      param: { id: merchantId },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    if ("error" in data) {
      throw new Error(`Unexpected error: ${data.error}`);
    }
    // Check that lastUsedAt was updated
    const updatedKey = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, keyObj.id),
    });

    expect(updatedKey).not.toBeNull();
    expect(updatedKey!.lastUsedAt).not.toBeNull();
  });
});
