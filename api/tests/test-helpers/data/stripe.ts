import { createId } from "@lumen/common";
import { db } from "../../../src/db/client";
import { stripe } from "@lumen/common/schema";
import { encryptField } from "../../../src/helpers/encryption";

interface StripeCreateOptions {
  merchantId: string;
  publicKey?: string;
  secretKey?: string;
  webhookSecret?: string;
}

/**
 * Create a test Stripe account for testing.
 *
 * @param options Creation options
 * @returns The created Stripe account
 */
export async function createTestStripe({
  merchantId,
  publicKey = `pk_test_${createId()}`,
  secretKey = `sk_test_${createId()}`,
  webhookSecret,
}: StripeCreateOptions) {
  const [created] = await db
    .insert(stripe)
    .values({
      merchantId,
      publicKey,
      secretKey: await encryptField(secretKey),
      webhookSecret: webhookSecret
        ? await encryptField(webhookSecret)
        : undefined,
    })
    .returning();

  return created;
}

/**
 * Alias for createTestStripe with simpler signature
 *
 * @param merchantId The merchant ID to associate with the Stripe account
 * @returns The created Stripe account
 */
export async function createTestStripeAccount(merchantId: string) {
  return createTestStripe({ merchantId });
}
