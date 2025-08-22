/**
 * Price helper functions for tests
 */
import { db } from "../../../src/db/client";
import { prices } from "@lumen/common/schema";
import { eq } from "drizzle-orm";
import { PriceUpdate } from "../types";
import { createPrice } from "../../../src/helpers/billing";
import { Price } from "../../../src/helpers";
import { PriceDSLSchemaCreate } from "@lumen/common/validators";
/**
 * Creates a test price in the database
 */
export async function createTestPrice(data: {
  id?: string;
  merchantId: string;
  planId: string;
  currency: string;
  pricingData: PriceDSLSchemaCreate;
  isOverridePrice?: boolean;
}) {
  if (!data.merchantId) throw new Error("merchantId is required");
  if (!data.planId) throw new Error("planId is required");
  if (!data.currency) throw new Error("currency is required");
  if (!data.pricingData) throw new Error("pricingData is required");

  return createPrice({
    id: data.id,
    planId: data.planId,
    merchantId: data.merchantId,
    currency: data.currency,
    pricingData: data.pricingData,
    isOverridePrice: data.isOverridePrice ?? false,
  });
}

/**
 * Creates multiple prices for a plan with different intervals/currencies
 */
export async function createMultiplePrices(
  planId: string,
  merchantId: string,
  count: number = 2
) {
  const priceConfigs: Array<{
    currency: string;
    pricingData: PriceDSLSchemaCreate;
  }> = [
    {
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "test-usd-monthly",
            type: "fixed" as const,
            label: "Monthly Fee (USD)",
            amount_cents: 2999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    },
    {
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "test-usd-yearly",
            type: "fixed" as const,
            label: "Annual Fee (USD)",
            amount_cents: 29990,
            recurrence_rule:
              "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
            bill_immediately: true,
          },
        ],
      },
    },
    {
      currency: "EUR",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "test-eur-monthly",
            type: "fixed" as const,
            label: "Monthly Fee (EUR)",
            amount_cents: 2499,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    },
    {
      currency: "EUR",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "test-eur-yearly",
            type: "fixed" as const,
            label: "Annual Fee (EUR)",
            amount_cents: 24990,
            recurrence_rule:
              "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
            bill_immediately: true,
          },
        ],
      },
    },
  ];

  const createdPrices: Price[] = [];

  for (let i = 0; i < Math.min(count, priceConfigs.length); i++) {
    const price = await createTestPrice({
      planId,
      merchantId,
      ...priceConfigs[i],
    });
    createdPrices.push(price);
  }

  return createdPrices;
}

/**
 * Clones a price with optional overrides
 */
export async function cloneTestPrice(
  originalPriceId: string,
  overrides: PriceUpdate = {}
) {
  // Get the original price
  const [originalPrice] = await db
    .select()
    .from(prices)
    .where(eq(prices.id, originalPriceId));

  if (!originalPrice) {
    throw new Error(`Original price not found: ${originalPriceId}`);
  }

  // Create a new price based on the original with overrides
  // Strip component_id from existing data since createTestPrice generates new ones
  const clonedPricingData = {
    ...originalPrice.pricingData,
    components: originalPrice.pricingData.components.map(
      ({ component_id, ...component }) => component
    ),
  };

  return createTestPrice({
    planId: originalPrice.planId,
    merchantId: originalPrice.merchantId,
    currency: originalPrice.currency,
    pricingData: clonedPricingData,
    isOverridePrice: originalPrice.isOverridePrice,
    ...overrides,
  });
}
