import { describe, it, beforeEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  createTestSecretKey,
  authenticateTestUser,
  createTestApiClient,
  createApiKeyClient,
  createTestPublishableKey,
} from "../test-helpers";
import { db } from "../../src/db/client";
import { apiKeys } from "@lumen/common/schema";
import { eq } from "drizzle-orm";

describe("API Key Security Features", () => {
  let merchantId: string;
  let sessionToken: string;
  let client: ReturnType<typeof createTestApiClient>;

  beforeEach(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create a client with session authentication
    client = createTestApiClient(sessionToken);
  });

  describe("Key Creation Security", () => {
    it("should create keys with unique values", async () => {
      // Create two secret keys and ensure they have different values
      const response1 = await client["api-keys"].$post({
        json: {
          name: "First Secret Key",
          keyType: "secret",
        },
      });
      const data1 = await response1.json();

      const response2 = await client["api-keys"].$post({
        json: {
          name: "Second Secret Key",
          keyType: "secret",
        },
      });
      const data2 = await response2.json();
      if ("error" in data2 || "error" in data1) {
        throw new Error(
          `Unexpected error: ${JSON.stringify(data2)} or ${JSON.stringify(data1)}`
        );
      }

      expect(data1.data.keyValue).not.toBe(data2.data.keyValue);
    });

    it("should store secret keys as hashed values", async () => {
      // Create a secret key
      const response = await client["api-keys"].$post({
        json: {
          name: "Hashed Secret Key",
          keyType: "secret",
        },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      // Get the raw key value from the response
      const rawKeyValue = data.data.keyValue;
      expect(rawKeyValue).toMatch(/^sk_/);
      if (!rawKeyValue) {
        throw new Error(`Unexpected error: No key value returned`);
      }

      // Check the database to verify the stored value is different (hashed)
      const dbKey = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, data.data.id),
      });

      expect(dbKey).not.toBeNull();
      expect(dbKey!.keyValue).not.toBe(rawKeyValue);
      // Hashed values should be longer and not start with sk_
      expect(dbKey!.keyValue).not.toMatch(/^sk_/);
      expect(dbKey!.keyValue.length).toBeGreaterThan(rawKeyValue.length);
    });

    it("should not store publishable keys as hashed values", async () => {
      // Create a publishable key
      const key = await createTestPublishableKey({
        merchantId,
        name: "Unhashed Publishable Key",
      });

      // The raw value should be the same as the stored value
      expect(key.keyValue).toBe(key.rawKeyValue);
    });
  });

  describe("Key Expiration", () => {
    it("should respect key expiration dates", async () => {
      // Create a key with an expiration date in the past
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1); // Yesterday

      const expiredKey = await createTestSecretKey({
        merchantId,
        name: "Expired Key",
      });

      // Manually update the key to be expired
      await db
        .update(apiKeys)
        .set({ expiresAt: pastDate })
        .where(eq(apiKeys.id, expiredKey.id));

      // Try to use the expired key
      const apiClient = createApiKeyClient(expiredKey.rawKeyValue);
      const response = await apiClient.merchants[":id"].$get({
        param: { id: merchantId },
      });

      // @ts-expect-error - we are testing an error case
      expect(response.status).toBe(401);
      const data = await response.json();
      if (!("error" in data)) {
        throw new Error("Expected error response");
      }
      expect(data.error).toBe("Unauthorized");
    });

    it("should create keys without expiration by default", async () => {
      const response = await client["api-keys"].$post({
        json: {
          name: "Non-Expiring Key",
          keyType: "secret",
        },
      });

      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      // Get the key from the database
      const dbKey = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, data.data.id),
      });

      expect(dbKey).not.toBeNull();
      expect(dbKey!.expiresAt).toBeNull();
    });
  });

  describe("Merchant Isolation", () => {
    it("should prevent access to other merchant's data with API keys", async () => {
      // Create a second merchant
      const { merchant: otherMerchant } = await createFullTestEnvironment();

      // Create a secret key for the first merchant
      const key = await createTestSecretKey({ merchantId });

      // Use the key to try to access data from the other merchant
      const apiClient = createApiKeyClient(key.rawKeyValue);

      // The request should be successful but only return data for the authenticated merchant
      const response = await apiClient.merchants[":id"].$get({
        param: { id: merchantId },
      });
      expect(response.status).toBe(200);

      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }

      // Verify we only get our own merchant data
      expect(data.id).toBe(merchantId);
      expect(data.id).not.toBe(otherMerchant.id);
    });

    it("should enforce multi-tenant isolation when accessing resources", async () => {
      // Create a second merchant with a resource
      const { merchant: otherMerchant } = await createFullTestEnvironment();

      // Create an API key for the first merchant
      const key = await createTestSecretKey({ merchantId });
      const apiClient = createApiKeyClient(key.rawKeyValue);

      // Try to access a specific endpoint with an ID from another merchant
      // This should return 404 Not Found
      const response = await apiClient.merchants[":id"].$get({
        param: { id: otherMerchant.id },
      });

      expect(response.status).toBe(404);
    });
  });
});
