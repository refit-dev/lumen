import { db } from "../../../src/db/client";
import { apiKeys, apiKeysPermissionsSchema } from "@lumen/common/schema";
import { hashSecretKey } from "../../../src/helpers/api_keys";
import { createId } from "@lumen/common";
import { generateRandomKeyString } from "../../../src/helpers/api_keys";

/**
 * Options for creating test API keys
 */
export interface ApiKeyCreateOptions {
  merchantId: string;
  name?: string;
  keyType?: "secret" | "publishable";
  environment?: "test" | "live";
  permissions?: (typeof apiKeysPermissionsSchema)[number][];
  // You can provide a custom key value (for testing specific formats)
  customKeyValue?: string;
}

/**
 * Create a test secret API key
 */
export async function createTestSecretKey({
  merchantId,
  name = "Test Secret Key",
  environment = "live",
  permissions = ["admin"],
  customKeyValue,
}: ApiKeyCreateOptions) {
  const randomNanoid = generateRandomKeyString(24);
  const keyValue = customKeyValue || `sk_${environment}_${randomNanoid}`;
  const hashedKey = await hashSecretKey(keyValue);
  const prefix = `sk_${environment}_${randomNanoid.substring(0, 4)}`;

  const [created] = await db
    .insert(apiKeys)
    .values({
      merchantId,
      name,
      keyType: "secret",
      environment,
      permissions,
      keyValue: hashedKey,
      prefix,
    })
    .returning();

  // Return both the database record and the actual key value
  return {
    ...created,
    rawKeyValue: keyValue, // Important: This field is for testing only
  };
}

/**
 * Create a test publishable API key
 */
export async function createTestPublishableKey({
  merchantId,
  name = "Test Publishable Key",
  environment = "live",
  permissions = ["public"],
  customKeyValue,
}: ApiKeyCreateOptions) {
  const keyValue = customKeyValue || `pk_${environment}_${createId()}`;
  const prefix = `pk_${environment}_${keyValue.split("_")[2].substring(0, 4)}`;

  const [created] = await db
    .insert(apiKeys)
    .values({
      merchantId,
      name,
      keyType: "publishable",
      environment,
      permissions,
      keyValue, // Publishable keys aren't hashed
      prefix,
    })
    .returning();

  // Return both the database record and the actual key value
  return {
    ...created,
    rawKeyValue: keyValue, // For publishable keys, this is the same as keyValue
  };
}

/**
 * Create both a secret and publishable key for a merchant
 */
export async function createTestApiKeys({
  merchantId,
  environment = "live",
  customSecretKey,
  customPublishableKey,
}: {
  merchantId: string;
  environment?: "test" | "live";
  customSecretKey?: string;
  customPublishableKey?: string;
}) {
  const secretKey = await createTestSecretKey({
    merchantId,
    environment,
    name: `${environment} Secret Key`,
    customKeyValue: customSecretKey,
  });

  const publishableKey = await createTestPublishableKey({
    merchantId,
    environment,
    name: `${environment} Publishable Key`,
    customKeyValue: customPublishableKey,
  });

  return {
    secretKey,
    publishableKey,
  };
}

/**
 * Create an API client that uses API key authentication
 */
export function createApiKeyAuthClient(apiKey: string) {
  return {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
}
