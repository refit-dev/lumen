import { db } from "../db/client";
import { apiKeys, merchants } from "@lumen/common/schema";
import { eq, and, isNull, asc } from "drizzle-orm";
import bcrypt from "bcrypt";
import { apiKeysPermissionsSchema } from "@lumen/common/schema";
import { customAlphabet } from "nanoid";

/**
 * Key formats:
 * - Secret: sk_{environment}_{random}
 * - Publishable: pk_{environment}_{random} (e.g., pk_test_x7y8z9...)
 */

/**
 * Generate a secure random string for API keys
 */
export const generateRandomKeyString = (length = 24): string => {
  // we've removed some chars that look similar (l, 1, I, O, 0)
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  // Using nanoid for generating URL-safe strings
  const nanoid = customAlphabet(alphabet, length);
  return nanoid();
};

/**
 * Hash a secret key for secure storage
 * Only secret keys should be hashed, publishable keys can be stored plaintext
 */
export const hashSecretKey = async (secretKey: string): Promise<string> => {
  return await bcrypt.hash(secretKey, 12);
};

/**
 * Extract key type, environment and prefix from a key string
 */
export const extractKeyMetadata = (
  keyValue: string
): {
  type: "secret" | "publishable";
  environment: "live" | "test";
  prefix: string;
} => {
  const parts = keyValue.split("_");

  if (parts.length < 3) {
    throw new Error("Invalid key format");
  }

  const typePrefix = parts[0];
  const environment = parts[1];

  // Validate key format
  if (typePrefix !== "sk" && typePrefix !== "pk") {
    throw new Error("Invalid key format");
  }

  if (environment !== "live" && environment !== "test") {
    throw new Error("Invalid environment");
  }

  // Create an 8-character prefix for display
  const prefix = `${typePrefix}_${environment}_${parts[2].substring(0, 4)}`;

  return {
    type: typePrefix === "sk" ? "secret" : "publishable",
    environment: environment as "live" | "test",
    prefix,
  };
};

export const verifyApiKey = async (apiKey: string) => {
  const { prefix } = extractKeyMetadata(apiKey);

  const candidates = await db.query.apiKeys.findMany({
    where: and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)),
  });

  for (const candidate of candidates) {
    const isMatch = await bcrypt.compare(apiKey, candidate.keyValue);
    if (isMatch) {
      if (candidate.expiresAt && candidate.expiresAt < new Date()) return null;
      await updateApiKeyLastUsed(candidate.id);
      return candidate;
    }
  }

  return null;
};

/**
 * Generate a new secret key
 */
export const generateSecretKey = (
  environment: "live" | "test" = "live"
): string => {
  return `sk_${environment}_${generateRandomKeyString()}`;
};

/**
 * Generate a new publishable key
 */
export const generatePublishableKey = (
  environment: "live" | "test" = "live"
): string => {
  return `pk_${environment}_${generateRandomKeyString()}`;
};

/**
 * Create a new API key in the database
 */
export const createApiKey = async ({
  merchantId,
  name,
  keyType,
  environment = "live",
  permissions = keyType === "secret" ? ["admin"] : ["public"],
}: {
  merchantId: string;
  name: string;
  keyType: "secret" | "publishable";
  environment?: "live" | "test";
  permissions?: (typeof apiKeysPermissionsSchema)[number][];
}) => {
  try {
    if (keyType === "secret" && !permissions.includes("admin")) {
      throw new Error(
        "Invalid permissions: Secret keys must include the 'admin' permission."
      );
    }

    // Generate key value based on type
    const keyValue =
      keyType === "secret"
        ? generateSecretKey(environment)
        : generatePublishableKey(environment);

    // For secret keys, we'll store a hash of the key value
    const storedKeyValue =
      keyType === "secret" ? await hashSecretKey(keyValue) : keyValue;

    // Extract the prefix for display
    const { prefix } = extractKeyMetadata(keyValue);

    // If it's a publishable key, first check if there's an existing one
    // and mark it as revoked
    if (keyType === "publishable") {
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.merchantId, merchantId),
            eq(apiKeys.keyType, "publishable"),
            eq(apiKeys.environment, environment),
            isNull(apiKeys.revokedAt)
          )
        );
    }

    // Create the new API key
    const [newApiKey] = await db
      .insert(apiKeys)
      .values({
        merchantId,
        name,
        keyType,
        environment,
        permissions,
        keyValue: storedKeyValue,
        prefix,
      })
      .returning();

    return {
      ...newApiKey,
      keyValue: keyValue,
    };
  } catch (error) {
    console.error("Error creating API key:", error);
    throw error;
  }
};

/**
 * Get an API key by its prefix (for display)
 */
export const getApiKeyByPrefix = async (prefix: string) => {
  try {
    const keys = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.prefix, prefix),
    });

    return keys ?? null;
  } catch (error) {
    console.error("Error getting API key:", error);
    throw error;
  }
};

/**
 * Get an API key by its value
 */
export const getApiKeyByValue = async (keyValue: string) => {
  try {
    // Extract metadata from the key
    const { type } = extractKeyMetadata(keyValue);

    // For secret keys, we need to hash before lookup
    const lookupValue =
      type === "secret" ? await hashSecretKey(keyValue) : keyValue;

    const keys = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.keyValue, lookupValue), isNull(apiKeys.revokedAt)),
    });

    return keys ?? null;
  } catch (error) {
    console.error("Error getting API key:", error);
    throw error;
  }
};

/**
 * List all API keys for a merchant
 */
export const listApiKeys = async (merchantId: string) => {
  try {
    const keys = await db.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.merchantId, merchantId),
        eq(apiKeys.keyType, "secret")
      ),
      orderBy: [asc(apiKeys.createdAt)],
    });

    return keys;
  } catch (error) {
    console.error("Error listing API keys:", error);
    throw error;
  }
};

/**
 * Revoke an API key
 */
export const revokeApiKey = async (id: string, merchantId: string) => {
  try {
    const [revokedKey] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.merchantId, merchantId)))
      .returning();

    return revokedKey;
  } catch (error) {
    console.error("Error revoking API key:", error);
    throw error;
  }
};

/**
 * Update the lastUsedAt timestamp for an API key
 */
export const updateApiKeyLastUsed = async (id: string) => {
  try {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, id));
  } catch (error) {
    console.error("Error updating API key last used:", error);
    // Don't throw here, just log the error
  }
};

/**
 * Check if an API key has the required permission
 */
export const hasPermission = (
  key: typeof apiKeys.$inferSelect,
  requiredPermission: (typeof apiKeysPermissionsSchema)[number]
): boolean => {
  // Admin permission grants access to everything
  if (key.permissions.includes("admin")) {
    return true;
  }

  // Check if the key has the specific permission
  return key.permissions.includes(requiredPermission);
};

export const INVALID_API_KEY_ERROR = "Invalid API key";
