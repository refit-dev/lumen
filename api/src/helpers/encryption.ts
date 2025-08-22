import crypto from "crypto";
import { getSecretOrEnvVar } from "./secrets";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits for GCM

// Get encryption key from environment, or generate one for development
async function getEncryptionKey(): Promise<Buffer> {
  const key = await getSecretOrEnvVar({
    secretNameTemplate: "lumen/*/field-encryption-key",
    envVariableName: "FIELD_ENCRYPTION_KEY",
    throwOnDevError: true,
    throwOnStagingOrProdError: true,
  });
  if (!key) {
    throw new Error("FIELD_ENCRYPTION_KEY environment variable is required");
  }

  // If key is base64 encoded, decode it
  if (key.length === 44 && key.endsWith("=")) {
    return Buffer.from(key, "base64");
  }

  // Otherwise, hash the key to ensure it's exactly 32 bytes
  return crypto.createHash("sha256").update(key).digest();
}

export interface EncryptedField {
  data: string; // base64 encoded encrypted data
  iv: string; // base64 encoded IV
  tag: string; // base64 encoded authentication tag
}

/**
 * Encrypt a string value for database storage
 */
export async function encryptField(plaintext: string): Promise<EncryptedField> {
  try {
    const key = await getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");

    const tag = cipher.getAuthTag();

    return {
      data: encrypted,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
    };
  } catch (error) {
    throw new Error(`Encryption failed: ${(error as Error).message}`);
  }
}

/**
 * Decrypt a string value from database storage
 */
export async function decryptField(
  encryptedField: EncryptedField
): Promise<string> {
  try {
    const { data, iv: rawIv, tag: rawTag } = encryptedField;
    if (data === undefined || rawIv === undefined || rawTag === undefined) {
      throw new Error("Invalid encrypted field");
    }
    const key = await getEncryptionKey();
    const iv = Buffer.from(encryptedField.iv, "base64");
    const tag = Buffer.from(encryptedField.tag, "base64");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encryptedField.data, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${(error as Error).message}`);
  }
}

/**
 * Check if a field is encrypted (has the encrypted structure)
 */
export function isEncrypted(value: any): value is EncryptedField {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.data === "string" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string"
  );
}

/**
 * Generate a new encryption key for the FIELD_ENCRYPTION_KEY environment variable
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString("base64");
}

export const getMaskedSecretKey = async (
  encryptedField: EncryptedField
): Promise<string> => {
  const decryptedSecretKey = await decryptField(encryptedField);
  return decryptedSecretKey.slice(0, 7) + "****";
};

/**
 * Can only be used for webhook secrets, will fail for other encrypted fields
 */
export const decryptWebhookSecret = async (
  encryptedField: EncryptedField
): Promise<string> => {
  // Add other accepted webhook secret start strings here
  // Stripe: whsec_
  // Dodo: whsec_
  const ACCEPTED_WEBHOOK_SECRET_START_STRINGS = ["whsec_"];

  const decryptedWebhookSecret = await decryptField(encryptedField);
  const isValidWebhookSecret = ACCEPTED_WEBHOOK_SECRET_START_STRINGS.some(
    (startString) => decryptedWebhookSecret.startsWith(startString)
  );
  if (!isValidWebhookSecret) {
    throw new Error("Invalid webhook secret");
  }
  return decryptedWebhookSecret;
};
