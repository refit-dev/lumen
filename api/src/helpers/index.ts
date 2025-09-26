import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  customers,
  features,
  merchants,
  planFeatures,
  subscriptionDetails,
  prices,
  plans,
  invoices,
  invoiceLineItems,
  payments,
  paymentMethods,
} from "@lumen/common/schema";
import { db } from "../db/client";

export * from "./api_keys";
export * from "./isProdOrStaging";

export type Price = typeof prices.$inferSelect;
export type DatabaseType = typeof db;
export type TransactionType = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];
export type Feature = typeof features.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
// Define the shape of the plan with features from the database query
export interface PlanWithPlanFeature extends Plan {
  planFeatures: {
    feature: Feature;
  }[];
}

export interface PlanWithFeatures extends Plan {
  features: Feature[];
}

export type FeatureValue = "string" | "number" | "boolean";
/**
 * Transforms plans with planFeatures into a cleaner format with features array
 * @param plans - Array of plans with planFeatures
 * @returns Array of plans with features array
 */
export function transformPlansWithFeatures(plans: PlanWithPlanFeature[]) {
  return plans.map((plan) => {
    const { planFeatures, ...planWithoutFeatures } = plan;
    return {
      ...planWithoutFeatures,
      features: planFeatures.map(({ feature }) => feature),
    };
  });
}

/**
 * Clones a list of prices and associates them with a new plan
 * @param tx - Database transaction or connection
 * @param priceIds - IDs of prices to clone
 * @param newPlanId - ID of the plan to associate cloned prices with
 * @param merchantId - ID of the merchant who owns the prices
 * @returns Array of cloned price IDs
 */
export async function clonePricesToPlan(
  tx: DatabaseType, // could be a transaction too
  priceIds: string[],
  newPlanId: string,
  merchantId: string
) {
  // Get the original prices
  const originalPrices = await tx.query.prices.findMany({
    where: and(
      inArray(prices.id, priceIds),
      eq(prices.merchantId, merchantId),
      isNull(prices.deletedAt)
    ),
  });

  if (originalPrices.length === 0) return [];

  // Clone each price
  const clonedPrices = await tx
    .insert(prices)
    .values(
      originalPrices.map((price: Price) => ({
        planId: newPlanId,
        merchantId: price.merchantId,
        currency: price.currency,
        pricingData: price.pricingData,
        isOverridePrice: price.isOverridePrice,
        clonedFromPriceId: price.id,
      }))
    )
    .returning();

  return clonedPrices;
}

/**
 * Validates that all provided price IDs belong to a merchant
 * @param merchantId - ID of the merchant
 * @param priceIds - Array of price IDs to validate
 * @returns true if all prices are valid, false otherwise
 */
export async function validatePriceIds(merchantId: string, priceIds: string[]) {
  const validPrices = await db.query.prices.findMany({
    where: and(
      eq(prices.merchantId, merchantId),
      isNull(prices.deletedAt),
      inArray(prices.id, priceIds)
    ),
  });

  return validPrices.length === priceIds.length;
}

/**
 * Validates that all provided feature IDs belong to the specified merchant
 * @returns true if all features are valid, false otherwise
 */
export async function validateFeatureIds(
  merchantId: string,
  featureIds: string[],
  db: DatabaseType
): Promise<boolean> {
  const validFeatures = await db.query.features.findMany({
    where: and(
      eq(features.merchantId, merchantId),
      isNull(features.deletedAt),
      inArray(features.id, featureIds)
    ),
  });

  return validFeatures.length === featureIds.length;
}

/**
 * Attaches features to a plan, preserving feature values and slugs
 * @returns The attached features
 */
export async function attachFeaturesToPlan(
  planId: string,
  featureIds: string[],
  db: DatabaseType | TransactionType
) {
  // Get existing features to preserve their values
  const existingFeatures = await db.query.features.findMany({
    where: inArray(features.id, featureIds),
  });

  // Create feature associations, casting JSON values to the allowed union type
  return await db.insert(planFeatures).values(
    featureIds.map((featureId) => {
      const feature = existingFeatures.find((f: Feature) => f.id === featureId);
      // Preserve the original featureValue (JSONB) but ensure it matches boolean|number|string
      const rawValue = feature?.featureValue ?? true;
      const featureValue = rawValue as boolean | number | string;
      return {
        planId,
        featureId,
        featureValue,
        featureSlug: feature?.slug ?? "",
      };
    })
  );
}

/**
 * Converts a type with Date fields to one with string fields
 * This is useful when comparing API responses to DB types
 * This is needed because the DB timestamp is a Date type and
 * the API response is a string because it's serialized as JSON
 */
type DateToString<T> = {
  [P in keyof T]: T[P] extends Date | null | undefined
    ? T[P] extends Date
      ? string
      : T[P] extends null
        ? string | null
        : string | undefined
    : T[P];
};

/**
 * Helper type for API responses where dates are serialized to strings
 */
export type APIResponse<T> = DateToString<T>;

// Common types that need date conversion
export type APIPlan = APIResponse<Plan>;
export type APIFeature = APIResponse<Feature>;
export interface APIPlanWithFeatures extends APIPlan {
  features: APIFeature[];
}
export type APIPrice = APIResponse<Price>;
export type APIInvoice = APIResponse<Invoice>;
export type APIInvoiceLineItem = APIResponse<InvoiceLineItem>;
export type APIInvoiceWithLineItems = APIResponse<
  Invoice & { lineItems: APIInvoiceLineItem[] }
>;

// Payment related API types
export type APIPayment = APIResponse<typeof payments.$inferSelect>;
export type APIMerchant = APIResponse<typeof merchants.$inferSelect>;
export type APICustomer = APIResponse<typeof customers.$inferSelect>;
export type APIPaymentMethod = APIResponse<typeof paymentMethods.$inferSelect>;
export type APISubscriptionWithPaymentMethod = APIResponse<
  typeof subscriptionDetails.$inferSelect
> & {
  paymentMethod: APIPaymentMethod;
};

// Type for API invoice with relations
export type APIInvoiceWithRelations = APIInvoice & {
  merchant: APIMerchant;
  customer: APICustomer;
  subscription: APISubscriptionWithPaymentMethod;
};
/**
 * Retrieves features associated with a plan
 */
export async function getPlanFeatures(
  planId: string,
  dbInstance: DatabaseType | TransactionType = db // Accept optional tx
): Promise<Feature[]> {
  // Return Feature[] directly
  // Get features from the plan_features junction table
  const planFeatureEntries = await dbInstance.query.planFeatures.findMany({
    where: and(eq(planFeatures.planId, planId), isNull(planFeatures.deletedAt)),
    with: {
      feature: true,
    },
  });

  // Extract and return features
  return planFeatureEntries
    .filter((entry) => entry.feature) // Filter out any entries with missing features
    .map((entry) => ({
      ...entry.feature,
      // Use the value from the junction table, fallback to feature default
      featureValue: entry.featureValue ?? entry.feature.featureValue,
    })) as Feature[]; // Assert as Feature[]
}
