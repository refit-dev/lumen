import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { plans } from "@lumen/common/schema";
import { prices } from "@lumen/common/schema";
import { eq, and, isNull } from "drizzle-orm";
import { clonePricesToPlan } from "../helpers";
import {
  priceDSLSchemaZod,
  PriceDSLSchemaType,
} from "@lumen/common/validators";
import { createPrice } from "../helpers/billing";
import { createPrefixValidator } from "@lumen/common";
import { ID_PREFIXES } from "@lumen/common";

// Define the shape of our API request bodies
interface PriceApiInsert {
  planId: string;
  currency: string;
  pricingData: PriceDSLSchemaType;
  isOverridePrice?: boolean;
}

type PriceApiUpdate = Partial<PriceApiInsert>;

const pricesApiUpdateSchema = z.object({
  planId: createPrefixValidator(ID_PREFIXES.plan)(z.string()).optional(),
  currency: z.string().optional(),
  pricingData: priceDSLSchemaZod.optional(),
  isOverridePrice: z.boolean().optional(),
});

const pricesApiInsertSchema = z.object({
  planId: createPrefixValidator(ID_PREFIXES.plan)(z.string()),
  currency: z.string().optional(),
  pricingData: priceDSLSchemaZod,
  isOverridePrice: z.boolean().optional(),
});

export const pricesRoute = new Hono()
  // Get all prices or get prices for a plan using a query param
  // it's called like this: /prices?planId=123
  .get(
    "/",
    zValidator(
      "query",
      z.object({ planId: createPrefixValidator(ID_PREFIXES.plan)(z.string()) })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const planId = c.req.query("planId");

      // Error for planId present in query but empty. This is likely a bug so we should warn the user
      if (planId === "") {
        return c.json(
          {
            error:
              "Empty planId provided. Provide a planId or remove the query parameter",
          },
          400
        );
      }

      if (!planId) {
        // Get ALL prices for this merchant
        const allPrices = await db.query.prices.findMany({
          where: and(
            eq(prices.merchantId, merchantId),
            isNull(prices.deletedAt)
          ),
        });

        return c.json({ prices: allPrices });
      }

      // First check if the plan belongs to this merchant
      const plan = await db.query.plans.findFirst({
        where: and(
          eq(plans.id, planId),
          eq(plans.merchantId, merchantId),
          isNull(plans.deletedAt)
        ),
      });

      if (!plan) {
        return c.json(
          {
            error:
              "Plan not found. If you have multiple accounts, are you using the right API key?",
          },
          404
        );
      }

      // Get all prices for this plan
      const allPrices = await db.query.prices.findMany({
        where: and(eq(prices.planId, planId), isNull(prices.deletedAt)),
      });

      return c.json({ prices: allPrices });
    }
  )
  .get(
    "/:priceId",
    zValidator(
      "param",
      z.object({
        priceId: createPrefixValidator(ID_PREFIXES.price)(z.string()),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const priceId = c.req.param("priceId");
      console.log("priceId", priceId, "merchantId", merchantId);

      // Get the price
      const price = await db.query.prices.findFirst({
        where: and(eq(prices.id, priceId), isNull(prices.deletedAt)),
      });

      if (!price) {
        return c.json({ error: "Price not found or access denied" }, 404);
      }

      // Get the associated plan to check merchant ownership
      const plan = await db.query.plans.findFirst({
        where: eq(plans.id, price.planId),
      });

      if (!plan || plan.merchantId !== merchantId) {
        return c.json({ error: "Unauthorized access to price" }, 403);
      }

      return c.json({ price });
    }
  )
  .post("/", zValidator("json", pricesApiInsertSchema), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const defaultCurrency = c.get("merchant")!.defaultCurrency;
    const data = c.req.valid("json");

    try {
      const price = await createPrice({
        planId: data.planId,
        merchantId,
        currency: data.currency || defaultCurrency!,
        pricingData: data.pricingData,
        isOverridePrice: data.isOverridePrice || false,
      });

      return c.json({ price });
    } catch (error) {
      console.error("Error creating price:", error);
      if (error instanceof Error) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: "Failed to create price" }, 500);
    }
  })
  .delete(
    "/:priceId",
    zValidator("param", z.object({ priceId: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const priceId = c.req.param("priceId");

      // Get the price
      const existingPrice = await db.query.prices.findFirst({
        where: and(
          eq(prices.id, priceId),
          eq(prices.merchantId, merchantId),
          isNull(prices.deletedAt)
        ),
      });

      if (!existingPrice) {
        return c.json({ error: "Price not found or access denied" }, 404);
      }

      // Soft delete the price
      await db
        .update(prices)
        .set({ deletedAt: new Date() })
        .where(eq(prices.id, priceId));

      return c.json({ success: true });
    }
  )
  // Clone an existing price (useful for creating similar prices)
  // To do this, you need to provide any modifications you want to make to the clone
  // in the JSON body
  // You can provide a new planId to clone to a different plan or leave blank to clone to the same plan
  .post(
    "/clone/:priceId",
    zValidator("param", z.object({ priceId: z.string() })),
    zValidator("json", pricesApiUpdateSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const priceId = c.req.param("priceId");
      const data = c.req.valid("json") as PriceApiUpdate;

      // Get the price to clone
      const sourcePrice = await db.query.prices.findFirst({
        where: and(
          eq(prices.id, priceId),
          isNull(prices.deletedAt),
          eq(prices.merchantId, merchantId)
        ),
      });

      if (!sourcePrice) {
        return c.json(
          { error: "Source price not found or access denied" },
          404
        );
      }

      // If target plan is different from source plan, verify it exists and belongs to this merchant
      if (data.planId && data.planId !== sourcePrice.planId) {
        const targetPlan = await db.query.plans.findFirst({
          where: and(
            eq(plans.id, data.planId),
            eq(plans.merchantId, merchantId),
            isNull(plans.deletedAt)
          ),
        });

        if (!targetPlan) {
          return c.json(
            { error: "Target plan not found or access denied" },
            404
          );
        }
      }

      // Note: Validation is handled by Zod schema in the route validator

      try {
        // Use the helper to clone the price
        const [clonedPrice] = await clonePricesToPlan(
          db,
          [priceId],
          data.planId || sourcePrice.planId,
          merchantId
        );

        // Apply any overrides from the request data
        if (Object.keys(data).length > 0) {
          const [updatedPrice] = await db
            .update(prices)
            .set({
              ...data,
              merchantId,
            })
            .where(eq(prices.id, clonedPrice.id))
            .returning();

          return c.json({ price: updatedPrice });
        }

        return c.json({ price: clonedPrice });
      } catch (error) {
        console.error("Error cloning price:", error);
        return c.json({ error: "Failed to clone price" }, 500);
      }
    }
  );
