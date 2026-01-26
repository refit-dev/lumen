import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { dodo as dodoDbSchema } from "@lumen/common/schema";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import {
  encryptField,
  EncryptedField,
  getMaskedSecretKey,
} from "../helpers/encryption";
import { ContentfulStatusCode } from "hono/utils/http-status";
import DodoPayments from "dodopayments";
import { env } from "../env";
import { requireOrgRole } from "../middleware/auth";

const validateDodoKey = async (
  secretKey: string
): Promise<
  [
    (
      | {
          message: string;
          success: boolean;
          environment: "test" | "live";
        }
      | {
          error: string;
        }
    ),
    ContentfulStatusCode,
  ]
> => {
  try {
    // Try both test and live environments to see which one works
    const tryEndpoint = async (environment: "test" | "live") => {
      const baseUrl =
        environment === "test"
          ? "https://test.dodopayments.com"
          : "https://live.dodopayments.com";
      const response = await fetch(`${baseUrl}/payments`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      });

      return { response, environment };
    };

    // Try test environment first
    try {
      const testResult = await tryEndpoint("test");
      if (testResult.response.ok) {
        return [
          {
            message: "Dodo API key is valid (test environment)",
            success: true,
            environment: "test",
          },
          200 as ContentfulStatusCode,
        ];
      }
    } catch (testError) {
      console.log("Test environment failed, trying live:", testError);
    }

    // Try live environment if test environment failed
    try {
      const liveResult = await tryEndpoint("live");
      if (liveResult.response.ok) {
        return [
          {
            message: "Dodo API key is valid (live environment)",
            success: true,
            environment: "live",
          },
          200 as ContentfulStatusCode,
        ];
      }

      // Handle error responses from live environment
      if (liveResult.response.status === 401) {
        return [
          { error: "Invalid Dodo API key - authentication failed" },
          400 as ContentfulStatusCode,
        ];
      }
      if (liveResult.response.status === 403) {
        return [
          { error: "Dodo API key does not have required permissions" },
          400 as ContentfulStatusCode,
        ];
      }
    } catch (liveError) {
      console.log("Live environment failed:", liveError);
    }

    throw new Error("Both test and live environments failed");
  } catch (error) {
    console.error("Dodo key validation failed:", error);

    // Check if it's a network error or API error
    if (error instanceof Error) {
      if (error.message.includes("fetch")) {
        return [
          {
            error:
              "Unable to connect to Dodo Payments API. Please check your internet connection.",
          },
          500 as ContentfulStatusCode,
        ];
      }

      return [
        {
          error: `Failed to validate Dodo API key: ${error.message}`,
        },
        400 as ContentfulStatusCode,
      ];
    }

    return [
      {
        error: "Failed to validate Dodo API key",
      },
      500 as ContentfulStatusCode,
    ];
  }
};

export const dodoRouter = new Hono()
  .get("/config", async (c) => {
    const merchantId = c.get("merchant")!.id;

    try {
      const dodoConfig = await db.query.dodo.findFirst({
        where: and(
          eq(dodoDbSchema.merchantId, merchantId),
          isNull(dodoDbSchema.deletedAt)
        ),
      });

      if (!dodoConfig) {
        return c.json({ error: "Dodo configuration not found" }, 404);
      }

      let maskedSecretKey: string | null = null;
      if (dodoConfig.secretKey) {
        try {
          maskedSecretKey = await getMaskedSecretKey(
            dodoConfig.secretKey as EncryptedField
          );
        } catch (error) {
          console.error("Failed to decrypt secret key:", error);
          return c.json({ error: "Failed to decrypt secret key" }, 500);
        }
      }

      return c.json({
        id: dodoConfig.id,
        secretKey: maskedSecretKey,
        hasWebhook: !!dodoConfig.webhookSecret,
        environment: dodoConfig.environment,
        createdAt: dodoConfig.createdAt,
      } as const);
    } catch (error) {
      console.error("Error fetching Dodo configuration:", error);
      return c.json({ error: "Failed to fetch Dodo configuration" }, 500);
    }
  })
  .post(
    "/validate-key",
    requireOrgRole("owner"),
    zValidator(
      "json",
      z.object({
        secretKey: z.string().min(1, "Secret key is required"),
      })
    ),
    async (c) => {
      const { secretKey } = c.req.valid("json");

      return c.json(...(await validateDodoKey(secretKey)));
    }
  )
  .post(
    "/config",
    requireOrgRole("owner"),
    zValidator(
      "json",
      z.object({
        secretKey: z.string().min(1, "Secret key is required"),
        webhookSecret: z
          .string()
          .min(1, "Webhook secret is required")
          .optional(),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const data = c.req.valid("json");

      const [validationResult, validationStatusCode] = await validateDodoKey(
        data.secretKey
      );

      if (validationStatusCode !== 200 || "error" in validationResult) {
        return c.json(validationResult, validationStatusCode);
      }

      try {
        // Check if Dodo configuration already exists
        const existingConfig = await db.query.dodo.findFirst({
          where: and(
            eq(dodoDbSchema.merchantId, merchantId),
            isNull(dodoDbSchema.deletedAt)
          ),
        });

        // Encrypt sensitive data before storing
        const encryptedSecretKey = await encryptField(data.secretKey);
        let encryptedWebhookSecret: EncryptedField | null = null;
        if (data.webhookSecret) {
          encryptedWebhookSecret = await encryptField(data.webhookSecret);
        }

        // If webhook secret not provided and not already set, automatically create webhook in Dodo
        if (!existingConfig?.webhookSecret && !encryptedWebhookSecret) {
          try {
            const client = new DodoPayments({
              bearerToken: data.secretKey,
              environment:
                validationResult.environment === "live"
                  ? "live_mode"
                  : "test_mode",
            });

            if (env.NODE_ENV === "development") {
              encryptedWebhookSecret = await encryptField("whsec_placeholder");
            } else {
              // Don't create webhook in development
              const baseUrl = env.API_URL.endsWith("/v1")
                ? env.API_URL
                : `${env.API_URL}/v1`;
              const webhookUrl = `${baseUrl}/public/webhook-dodo/${merchantId}`;
              const webhook = await client.webhooks.create({ url: webhookUrl });
              const { secret } = await client.webhooks.retrieveSecret(
                webhook.id
              );
              encryptedWebhookSecret = await encryptField(secret);
            }
          } catch (autoWebhookError) {
            console.error(
              "Failed to auto-create Dodo webhook:",
              autoWebhookError instanceof Error
                ? autoWebhookError.message
                : autoWebhookError
            );
            // Continue without failing the whole request; user can set webhook later if needed
          }
        }

        if (existingConfig) {
          // Update existing configuration
          const [updated] = await db
            .update(dodoDbSchema)
            .set({
              secretKey: encryptedSecretKey,
              webhookSecret: encryptedWebhookSecret,
              environment: validationResult.environment,
            })
            .where(eq(dodoDbSchema.id, existingConfig.id))
            .returning();

          return c.json({
            message: "Dodo configuration updated successfully",
            id: updated.id,
          });
        } else {
          // Create new configuration
          const [created] = await db
            .insert(dodoDbSchema)
            .values({
              merchantId,
              secretKey: encryptedSecretKey,
              webhookSecret: encryptedWebhookSecret,
              environment: validationResult.environment,
            })
            .returning();

          return c.json({
            message: "Dodo configuration created successfully",
            id: created.id,
          });
        }
      } catch (error) {
        const errorMessage = `Failed to update Dodo configuration: ${
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
