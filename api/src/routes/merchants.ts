import { Hono } from "hono";
import { db } from "../db/client";
import {
  merchants,
  merchantsInsertSchema,
  merchantTaxConfig,
  plans,
} from "@lumen/common/schema";
import { ID_PREFIXES, createPrefixValidator } from "@lumen/common";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, isNull } from "drizzle-orm";
import { createApiKey } from "../helpers/api_keys";
import Stripe from "stripe";
import { getPaymentProvider } from "../helpers/paymentprovider";

const merchantsInsertSchemaAPIKey = merchantsInsertSchema.omit({
  id: true,
});

const merchantsUpdateSchema = merchantsInsertSchema
  .omit({
    id: true,
    userId: true,
    organizationId: true,
  })
  .partial();

const merchantDataRequestSchema = z.object({
  stripeSecretKey: z.string().min(1, "Stripe secret key is required"),
});

type MerchantDataResponse = {
  legalName: string;
  displayName: string;
  websiteUrl: string;
  defaultCurrency: string;
};

// Create the merchants router
const merchantsRouter = new Hono()
  .get("/current", async (c) => {
    try {
      const merchantId = c.get("merchant")?.id;

      if (!merchantId) {
        return c.json(
          { error: "No merchant associated with this account" },
          404
        );
      }

      const merchant = await db.query.merchants.findFirst({
        where: and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)),
      });

      if (!merchant) {
        return c.json({ error: "Merchant not found" }, 404);
      }

      return c.json(merchant, 200);
    } catch (error) {
      console.error("Error fetching current merchant:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .get("/checkonboarding", async (c) => {
    try {
      const merchantId = c.get("merchant")?.id;

      if (!merchantId) {
        return c.json(
          { error: "No merchant associated with this account" },
          404
        );
      }

      // Check if any plans exist
      const plansExist = await db.query.plans.findFirst({
        where: and(eq(plans.merchantId, merchantId), isNull(plans.deletedAt)),
      });

      const paymentProvider = await getPaymentProvider(merchantId);

      // Dodo includes tax calculation as Merchant of Record
      let hasTax: boolean = paymentProvider.name === "dodo" || false;

      if (!hasTax) {
        // Check if tax configuration exists
        const taxConfig = await db.query.merchantTaxConfig.findFirst({
          where: eq(merchantTaxConfig.merchantId, merchantId),
        });

        // Tax is considered configured if merchant has either:
        // 1. Enabled automatic tax calculation, OR
        // 2. Set up a manual default tax rate
        hasTax = !!(
          taxConfig &&
          (taxConfig.autoTaxCalculation ||
            (taxConfig.defaultTaxRate !== null &&
              taxConfig.defaultTaxRate !== undefined))
        );
      }

      return c.json(
        {
          hasPlans: !!plansExist,
          hasPaymentProvider: paymentProvider.isPaymentProviderReady,
          hasTax,
        },
        200
      );
    } catch (error) {
      console.error("Error checking onboarding status:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .post(
    "/onboarding-create-merchant",
    zValidator("json", merchantsInsertSchemaAPIKey),
    async (c) => {
      try {
        // Merchant cannot be created via API keys
        if (c.get("apiKey")) {
          return c.json(
            { error: "Merchant creation is not allowed via API keys" },
            403
          );
        }

        // If logged in with session, check if merchant already exists
        const merchantIdFromSession = c.get("merchant")?.id;
        if (merchantIdFromSession) {
          return c.json(
            { error: "Merchant already exists" },
            { status: 400 } // BAD REQUEST
          );
        }
        // Get validated data
        const data = c.req.valid("json");

        // Create merchant
        const [merchant] = await db.insert(merchants).values(data).returning();

        // Create a publishable API key for the merchant
        try {
          await createApiKey({
            merchantId: merchant.id,
            name: "Publishable Key",
            keyType: "publishable",
            environment: "live",
          });
        } catch (apiKeyError) {
          console.error("Error creating default publishable key:", apiKeyError);
          // Continue with the response as the merchant was created successfully
        }

        // Return with specific status code for RPC type inference
        return c.json(merchant, 201);
      } catch (error) {
        console.error("Error creating merchant:", error);

        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map((err) => ({
            code: err.code,
            message: err.message,
            path: err.path.map((p) => String(p)),
          }));
          return c.json({ error: formattedErrors }, 400);
        }

        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  .get("/payment-provider", async (c) => {
    const merchantId = c.get("merchant")!.id;

    if (!merchantId) {
      return c.json({ error: "No merchant associated with this account" }, 404);
    }

    const { isPaymentProviderReady, name } =
      await getPaymentProvider(merchantId);

    if (isPaymentProviderReady) {
      return c.json({
        provider: name,
      });
    }
    return c.json(
      {
        provider: null,
      },
      200
    );
  })
  .get(
    "/:id",
    zValidator(
      "param",
      z.object({
        id: createPrefixValidator(
          ID_PREFIXES.merchant,
          "Invalid merchant ID format"
        )(z.string()),
      })
    ),
    async (c) => {
      try {
        const merchantId = c.get("merchant")!.id;
        const { id: merchantIdInQuery } = c.req.valid("param");
        const merchant = await db.query.merchants.findFirst({
          where: and(
            eq(merchants.id, merchantIdInQuery),
            eq(merchants.id, merchantId), // only show the merchant if the user is the same as the merchant's user
            isNull(merchants.deletedAt)
          ),
        });

        if (!merchant) {
          return c.json({ error: "Merchant not found" }, 404);
        }
        return c.json(merchant, 200);
      } catch (error) {
        console.error("Error fetching merchant:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  .post("/current", zValidator("json", merchantsUpdateSchema), async (c) => {
    try {
      const merchantId = c.get("merchant")?.id;

      if (!merchantId) {
        return c.json(
          { error: "No merchant associated with this account" },
          404
        );
      }

      const data = c.req.valid("json");

      // Update the merchant
      const [updatedMerchant] = await db
        .update(merchants)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
        .returning();

      if (!updatedMerchant) {
        return c.json({ error: "Merchant not found" }, 404);
      }

      return c.json(updatedMerchant, 200);
    } catch (error) {
      console.error("Error updating merchant:", error);

      if (error instanceof z.ZodError) {
        const formattedErrors = error.errors.map((err) => ({
          code: err.code,
          message: err.message,
          path: err.path.map((p) => String(p)),
        }));
        return c.json({ error: formattedErrors }, 400);
      }

      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .post(
    "/merchant-data",
    // This endpoint gets called during onboarding only if Stripe API keys are provided
    // It pulls merchant data from Stripe to pre-fill some fields in the UI
    zValidator("json", merchantDataRequestSchema),
    async (c) => {
      const { stripeSecretKey } = c.req.valid("json");

      try {
        const stripeClient = new Stripe(stripeSecretKey, {
          apiVersion: "2025-02-24.acacia",
        });

        const account = await stripeClient.accounts.retrieve();

        const merchantData: MerchantDataResponse = {
          legalName: account.business_profile?.name || "",
          displayName: account.business_profile?.name || "",
          websiteUrl: account.business_profile?.url || "",
          defaultCurrency: account.default_currency?.toUpperCase() || "",
        };

        return c.json<MerchantDataResponse>(merchantData);
      } catch (error) {
        console.error("Error fetching Stripe merchant data:", error);

        let errorMessage = "Failed to fetch merchant data";

        if (error instanceof Stripe.errors.StripeAuthenticationError) {
          errorMessage =
            "Authentication with Stripe failed. Please check your API key.";
        } else if (error instanceof Stripe.errors.StripeError) {
          errorMessage =
            error.message ||
            "An error occurred while communicating with Stripe.";
        }

        return c.json({ error: errorMessage }, 500);
      }
    }
  );

export default merchantsRouter;
