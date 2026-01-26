import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { stripe as stripeDbSchema } from "@lumen/common/schema";
import Stripe from "stripe";
import { z } from "zod";
import { env } from "../env";
import { eq, and, isNull } from "drizzle-orm";
import {
  encryptField,
  getMaskedSecretKey,
  EncryptedField,
  decryptWebhookSecret,
} from "../helpers/encryption";
import { requireOrgRole } from "../middleware/auth";

const WEBHOOK_BASE_URL = `${env.API_URL}/public/webhook`;

export const stripeRouter = new Hono()
  .get("/config", async (c) => {
    const merchantId = c.get("merchant")!.id;

    try {
      const stripeConfig = await db.query.stripe.findFirst({
        where: and(
          eq(stripeDbSchema.merchantId, merchantId),
          isNull(stripeDbSchema.deletedAt)
        ),
      });

      if (!stripeConfig) {
        return c.json({ error: "Stripe configuration not found" }, 404);
      }

      let maskedSecretKey: string | null = null;
      if (stripeConfig.secretKey) {
        try {
          maskedSecretKey = await getMaskedSecretKey(
            stripeConfig.secretKey as EncryptedField
          );
        } catch (error) {
          console.error("Failed to decrypt secret key:", error);
          return c.json({ error: "Failed to decrypt secret key" }, 500);
        }
      }

      return c.json({
        id: stripeConfig.id,
        publicKey: stripeConfig.publicKey,
        secretKey: maskedSecretKey,
        hasWebhook: !!stripeConfig.webhookSecret,
        createdAt: stripeConfig.createdAt,
      });
    } catch (error) {
      console.error("Error fetching Stripe configuration:", error);
      return c.json({ error: "Failed to fetch Stripe configuration" }, 500);
    }
  })
  .post(
    "/validate-keys",
    requireOrgRole("owner"),
    zValidator(
      "json",
      z.object({
        secretKey: z.string().min(1, "Secret key is required"),
        publicKey: z.string().min(1, "Public key is required"),
      })
    ),
    async (c) => {
      const data = c.req.valid("json");

      try {
        // Validate the secret key format
        if (!data.secretKey.startsWith("sk_")) {
          return c.json(
            { error: "Invalid secret key format. Must start with 'sk_'" },
            400
          );
        }

        // Validate the public key format
        if (!data.publicKey.startsWith("pk_")) {
          return c.json(
            { error: "Invalid public key format. Must start with 'pk_'" },
            400
          );
        }

        // Test the secret key by creating a Stripe client and making a simple API call
        const stripeClient = new Stripe(data.secretKey, {
          apiVersion: "2025-02-24.acacia",
        });

        // Try to retrieve account information to validate the key
        await stripeClient.accounts.retrieve();

        return c.json({
          message: "Stripe keys are valid",
          success: true,
        });
      } catch (error) {
        console.error("Stripe key validation failed:", error);

        // Check if it's a Stripe API error
        if (error instanceof Stripe.errors.StripeError) {
          return c.json(
            {
              error: `Invalid Stripe API key: ${error.message}`,
            },
            400
          );
        }

        return c.json(
          {
            error: "Failed to validate Stripe keys",
          },
          500
        );
      }
    }
  )
  .post(
    "/config",
    requireOrgRole("owner"),
    zValidator(
      "json",
      z.object({
        secretKey: z.string().min(1, "Secret key is required"),
        publicKey: z.string().min(1, "Public key is required"),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const data = c.req.valid("json");

      try {
        const stripeClient = new Stripe(data.secretKey, {
          apiVersion: "2025-02-24.acacia",
        });

        // Check if Stripe configuration already exists
        const existingConfig = await db.query.stripe.findFirst({
          where: and(
            eq(stripeDbSchema.merchantId, merchantId),
            isNull(stripeDbSchema.deletedAt)
          ),
        });

        let webhookEndpoint;

        // If existing config has a webhook, delete it first
        if (existingConfig?.webhookSecret) {
          try {
            // Decrypt the existing webhook secret to get the plain text value
            const decryptedWebhookSecret = await decryptWebhookSecret(
              existingConfig.webhookSecret as EncryptedField
            );

            // Get the webhook endpoint ID from Stripe to delete it
            const webhooks = await stripeClient.webhookEndpoints.list();
            const existingWebhook = webhooks.data.find(
              (webhook) => webhook.secret === decryptedWebhookSecret
            );

            if (existingWebhook) {
              await stripeClient.webhookEndpoints.del(existingWebhook.id);
            }
          } catch (error) {
            console.warn("Failed to delete existing webhook endpoint:", error);
            // Continue with creating new webhook even if deletion fails
          }
        }

        // Create new webhook endpoint
        webhookEndpoint = await stripeClient.webhookEndpoints.create({
          enabled_events: [
            "payment_intent.succeeded",
            "payment_intent.payment_failed",
            "setup_intent.succeeded",
            "setup_intent.setup_failed",
            "checkout.session.completed",
          ],
          url: !WEBHOOK_BASE_URL.includes("localhost")
            ? `${WEBHOOK_BASE_URL}/${merchantId}`
            : // We need a placeholder for development because stripe errors if you pass localhost
              `https://api.getlumen.dev/v1/public/webhook-test/${merchantId}`,
        });

        if (!webhookEndpoint.secret) {
          return c.json({ error: "Failed to create webhook endpoint" }, 500);
        }

        // Encrypt sensitive data before storing
        const encryptedSecretKey = await encryptField(data.secretKey);
        const encryptedWebhookSecret = await encryptField(
          webhookEndpoint.secret
        );

        if (existingConfig) {
          // Update existing configuration
          const [updated] = await db
            .update(stripeDbSchema)
            .set({
              publicKey: data.publicKey,
              secretKey: encryptedSecretKey,
              webhookSecret: encryptedWebhookSecret,
            })
            .where(eq(stripeDbSchema.id, existingConfig.id))
            .returning();

          return c.json({
            message: "Stripe configuration updated successfully",
            id: updated.id,
            webhook: webhookEndpoint,
          });
        } else {
          // Create new configuration
          const [created] = await db
            .insert(stripeDbSchema)
            .values({
              merchantId,
              publicKey: data.publicKey,
              secretKey: encryptedSecretKey,
              webhookSecret: encryptedWebhookSecret,
            })
            .returning();

          return c.json({
            message: "Stripe configuration created successfully",
            id: created.id,
            webhook: webhookEndpoint,
          });
        }
      } catch (error) {
        const errorMessage = `Failed to update Stripe configuration: ${
          (error as { raw: { message: string } })?.raw?.message
        }`;
        console.error(errorMessage);
        return c.json(
          {
            error: errorMessage,
          },
          500
        );
      }
    }
  );
