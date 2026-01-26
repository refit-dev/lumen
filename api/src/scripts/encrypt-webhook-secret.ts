#!/usr/bin/env bun
/**
 * Script to encrypt a webhook secret locally and output SQL to update the database
 * Uses secure password input to avoid storing secrets in terminal history
 *
 * Usage:
 *   cd api && bun run src/scripts/encrypt-webhook-secret.ts
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

// Secure password input function with paste support
async function secureInput(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  // Disable echo
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let input = "";
  let maskLength = 0; // Track how many asterisks we've printed

  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();

      // Handle Ctrl+C
      if (str === "\u0003") {
        process.stdout.write("\n");
        process.exit(0);
      }

      // Handle Ctrl+D (EOF)
      if (str === "\u0004") {
        process.stdout.write("\n");
        reject(new Error("Input cancelled"));
        return;
      }

      // Handle Enter (both \r and \n)
      if (str === "\r" || str === "\n" || str === "\r\n") {
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdout.write("\n");
        resolve(input);
        return;
      }

      // Handle Backspace/Delete
      if (str === "\u007f" || str === "\b" || str === "\u001b[3~") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          maskLength--;
          // Clear one asterisk
          process.stdout.write("\b \b");
        }
        // Don't allow backspace beyond the input (prevents deleting prompt)
        return;
      }

      // Handle paste or regular input
      // Filter to only printable ASCII characters
      const printable = str.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

      if (printable.length > 0) {
        input += printable;
        // Print asterisks for each character added
        const newMaskLength = input.length;
        const asterisksToAdd = newMaskLength - maskLength;
        process.stdout.write("*".repeat(asterisksToAdd));
        maskLength = newMaskLength;
      }
    };

    process.stdin.on("data", onData);
  });
}

// Encrypt function (EXACT copy from encryption.ts)
function encryptField(plaintext: string, key: Buffer): {
  data: string;
  iv: string;
  tag: string;
} {
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
}

// Decrypt function (EXACT copy from encryption.ts) for verification
function decryptField(encryptedField: { data: string; iv: string; tag: string }, key: Buffer): string {
  const { data, iv: rawIv, tag: rawTag } = encryptedField;
  if (data === undefined || rawIv === undefined || rawTag === undefined) {
    throw new Error("Invalid encrypted field");
  }

  const iv = Buffer.from(encryptedField.iv, "base64");
  const tag = Buffer.from(encryptedField.tag, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedField.data, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

// Process encryption key (same logic as in encryption.ts)
function processEncryptionKey(key: string): Buffer {
  // If key is base64 encoded (44 chars ending with =), decode it
  if (key.length === 44 && key.endsWith("=")) {
    return Buffer.from(key, "base64");
  }

  // Otherwise, hash it to ensure it's exactly 32 bytes
  return crypto.createHash("sha256").update(key).digest();
}

async function main() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Webhook Secret Encryption Tool");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("This tool encrypts webhook secrets for secure database storage.");
  console.log("Input is masked and not stored in terminal history.\n");
  console.log("Supports both typing and pasting values. Press Ctrl+C to cancel.\n");

  let encryptionKey: string;
  let webhookSecret: string;

  try {
    // Get encryption key securely
    encryptionKey = await secureInput("Enter FIELD_ENCRYPTION_KEY: ");
    if (!encryptionKey || encryptionKey.trim().length === 0) {
      console.error("\n❌ Error: Encryption key cannot be empty");
      process.exit(1);
    }

    // Get webhook secret securely
    webhookSecret = await secureInput("Enter webhook secret (whsec_...): ");
    if (!webhookSecret || webhookSecret.trim().length === 0) {
      console.error("\n❌ Error: Webhook secret cannot be empty");
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ Error: ${(error as Error).message}`);
    process.exit(1);
  }

  // Validate webhook secret format
  if (!webhookSecret.startsWith("whsec_")) {
    console.log(`\n⚠️  Warning: Webhook secret should typically start with 'whsec_'`);
    console.log(`   Your input starts with: ${webhookSecret.substring(0, 10)}...`);

    process.stdout.write("\nContinue anyway? (y/n): ");
    const continueAnswer = await new Promise<string>((resolve) => {
      process.stdin.once("data", (chunk) => {
        resolve(chunk.toString().trim().toLowerCase());
      });
    });

    if (continueAnswer !== "y" && continueAnswer !== "yes") {
      console.log("\nOperation cancelled.");
      process.exit(0);
    }
  }

  // Process the encryption key
  let keyBuffer: Buffer;
  try {
    keyBuffer = processEncryptionKey(encryptionKey);
  } catch (error) {
    console.error(`\n❌ Error: Invalid encryption key format`);
    console.error(`   ${(error as Error).message}`);
    process.exit(1);
  }

  // Encrypt the webhook secret
  console.log(`\n[1/2] Encrypting webhook secret...`);
  let encryptedSecret: { data: string; iv: string; tag: string };
  try {
    encryptedSecret = encryptField(webhookSecret, keyBuffer);
    console.log(`      ✅ Encryption successful`);
  } catch (error) {
    console.error(`\n❌ Error: Encryption failed`);
    console.error(`   ${(error as Error).message}`);
    process.exit(1);
  }

  // VERIFY: Test decryption to ensure it matches the original
  console.log(`\n[2/2] Verifying encryption integrity...`);
  try {
    const decryptedSecret = decryptField(encryptedSecret, keyBuffer);

    if (decryptedSecret === webhookSecret) {
      console.log(`      ✅ Verification passed - decryption successful`);
    } else {
      console.error(`\n❌ CRITICAL ERROR: Verification failed!`);
      console.error(`   The decrypted value does not match the original input.`);
      console.error(`   This indicates a problem with the encryption process.`);
      console.error(`\n   DO NOT USE THIS ENCRYPTED VALUE IN PRODUCTION!`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ CRITICAL ERROR: Decryption verification failed`);
    console.error(`   ${(error as Error).message}`);
    console.error(`\n   DO NOT USE THIS ENCRYPTED VALUE IN PRODUCTION!`);
    process.exit(1);
  }

  // Output results
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Encrypted Webhook Secret (JSON)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(JSON.stringify(encryptedSecret, null, 2));
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  SQL Update Statements`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const jsonString = JSON.stringify(encryptedSecret).replace(/'/g, "''");

  console.log(`For Stripe webhooks:\n`);
  console.log(`UPDATE stripe`);
  console.log(`SET webhook_secret = '${jsonString}'::jsonb`);
  console.log(`WHERE merchant_id = 'YOUR_MERCHANT_ID';\n`);

  console.log(`\nFor Dodo webhooks:\n`);
  console.log(`UPDATE dodo`);
  console.log(`SET webhook_secret = '${jsonString}'::jsonb`);
  console.log(`WHERE merchant_id = 'YOUR_MERCHANT_ID';\n`);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`⚠️  IMPORTANT: Replace 'YOUR_MERCHANT_ID' with the actual merchant ID`);
  console.log(`✅ The encrypted value has been verified and is ready for production use\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error.message);
    process.exit(1);
  });
