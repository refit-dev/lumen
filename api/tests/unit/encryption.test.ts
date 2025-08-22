import { describe, it, expect, beforeAll } from "bun:test";
import {
  encryptField,
  decryptField,
  isEncrypted,
  generateEncryptionKey,
} from "../../src/helpers/encryption";

describe("Field Encryption", () => {
  // Set up test encryption key
  beforeAll(() => {
    process.env.FIELD_ENCRYPTION_KEY = generateEncryptionKey();
  });

  describe("encryptField", () => {
    it("should encrypt a string and return encrypted field structure", async () => {
      const plaintext = "sk_test_123456789";
      const encrypted = await encryptField(plaintext);

      expect(encrypted).toHaveProperty("data");
      expect(encrypted).toHaveProperty("iv");
      expect(encrypted).toHaveProperty("tag");

      expect(typeof encrypted.data).toBe("string");
      expect(typeof encrypted.iv).toBe("string");
      expect(typeof encrypted.tag).toBe("string");

      // Encrypted data should be different from plaintext
      expect(encrypted.data).not.toBe(plaintext);
    });

    it("should generate different encrypted values for same input", async () => {
      const plaintext = "sk_test_123456789";
      const encrypted1 = await encryptField(plaintext);
      const encrypted2 = await encryptField(plaintext);

      // Should be different due to random IV
      expect(encrypted1.data).not.toBe(encrypted2.data);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.tag).not.toBe(encrypted2.tag);
    });
  });

  describe("decryptField", () => {
    it("should decrypt an encrypted field back to original plaintext", async () => {
      const plaintext = "sk_test_123456789";
      const encrypted = await encryptField(plaintext);
      const decrypted = await decryptField(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should throw error for invalid encrypted field", () => {
      const invalidField = {
        data: "invalid",
        iv: "invalid",
        tag: "invalid",
      };

      expect(() => decryptField(invalidField)).toThrow("Decryption failed");
    });

    it("should throw error for tampered data", async () => {
      const plaintext = "sk_test_123456789";
      const encrypted = await encryptField(plaintext);

      // Tamper with the data
      const tampered = {
        ...encrypted,
        data: encrypted.data.substring(0, encrypted.data.length - 1) + "X",
      };

      expect(() => decryptField(tampered)).toThrow("Decryption failed");
    });
  });

  describe("isEncrypted", () => {
    it("should identify encrypted fields correctly", async () => {
      const encrypted = await encryptField("test");
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it("should return false for non-encrypted values", () => {
      expect(isEncrypted("plaintext")).toBe(false);
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
      expect(isEncrypted({})).toBe(false);
      expect(isEncrypted({ data: "test" })).toBe(false); // missing iv and tag
    });
  });

  describe("decryptField", () => {
    it("should decrypt encrypted fields", async () => {
      const plaintext = "sk_test_123456789";
      const encrypted = await encryptField(plaintext);
      const decrypted = await decryptField(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should throw error for invalid format", () => {
      const invalid = { invalid: "format" };

      expect(() => decryptField(invalid as any)).toThrow(
        "Decryption failed: Invalid encrypted field"
      );
    });
  });

  describe("generateEncryptionKey", () => {
    it("should generate a base64 encoded key", () => {
      const key = generateEncryptionKey();

      expect(typeof key).toBe("string");
      expect(key.length).toBe(44); // Base64 encoded 32 bytes
      expect(key.endsWith("=")).toBe(true);

      // Should be valid base64
      const decoded = Buffer.from(key, "base64");
      expect(decoded.length).toBe(32);
    });

    it("should generate different keys each time", () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();

      expect(key1).not.toBe(key2);
    });
  });

  describe("End-to-end encryption/decryption", () => {
    it("should handle typical Stripe secret key", async () => {
      const stripeSecretKey =
        "sk_test_51234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

      const encrypted = await encryptField(stripeSecretKey);
      const decrypted = await decryptField(encrypted);

      expect(decrypted).toBe(stripeSecretKey);
    });

    it("should handle webhook secrets", async () => {
      const webhookSecret =
        "whsec_1234567890abcdef1234567890abcdef1234567890abcdef";

      const encrypted = await encryptField(webhookSecret);
      const decrypted = await decryptField(encrypted);

      expect(decrypted).toBe(webhookSecret);
    });

    it("should handle empty strings", async () => {
      const empty = "";

      const encrypted = await encryptField(empty);
      const decrypted = await decryptField(encrypted);

      expect(decrypted).toBe(empty);
    });
  });
});
