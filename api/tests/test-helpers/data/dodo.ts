import { createId } from "@lumen/common";
import { db } from "../../../src/db/client";
import { dodo } from "@lumen/common/schema";
import { encryptField } from "../../../src/helpers/encryption";

/**
 * Create a test Dodo account for testing.
 *
 * @param options Creation options
 * @returns The created Dodo account
 */
export async function createTestDodo({
  merchantId,
  secretKey = `dodo_mock_api_key_${createId()}`,
  webhookSecret = `dodo_mock_webhook_secret_${createId()}`,
}: {
  merchantId: string;
  secretKey?: string;
  webhookSecret?: string;
}) {
  const [created] = await db
    .insert(dodo)
    .values({
      merchantId,
      environment: "test",
      secretKey: await encryptField(secretKey),
      webhookSecret: webhookSecret
        ? await encryptField(webhookSecret)
        : undefined,
    })
    .returning();

  return created;
}
