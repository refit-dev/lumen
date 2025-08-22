import { prices } from "../db/schema/price";
import { planFeatures, features } from "../db/schema/feature";
import { InferSelectModel } from "drizzle-orm";

// Infer types from the schema
type Price = InferSelectModel<typeof prices>;
type PlanFeature = InferSelectModel<typeof planFeatures>;
type Feature = InferSelectModel<typeof features>;

// Extended plan type with relations
export interface PlanWithRelations {
  id: string;
  planName: string;
  planDescription: string | null;
  prices: Price[];
  planFeatures: (PlanFeature & { feature: Feature })[];
}

/**
 * Transforms a plan with pricing and feature data into a standardized format for display
 */
export function transformPlanToPricingTablePlan(
  planData: PlanWithRelations,
  options?: {
    buttonText?: string;
    buttonOutline?: boolean;
    isPopular?: boolean;
    popularText?: string;
  }
) {
  const latestPrice = planData.prices[0];

  // Get price amount from pricing data
  let priceAmount = 0;
  let priceInterval = "month";

  if (
    latestPrice &&
    latestPrice.pricingData &&
    latestPrice.pricingData.components &&
    latestPrice.pricingData.components.length > 0
  ) {
    const mainComponent = latestPrice.pricingData.components[0];

    // Check component type and extract amount and interval
    if ("amount_cents" in mainComponent) {
      priceAmount = mainComponent.amount_cents;
    }

    // Handle different components having different recurrence fields
    if (
      "recurrence" in mainComponent &&
      typeof mainComponent.recurrence === "string"
    ) {
      priceInterval = mainComponent.recurrence;
    } else if (
      "billing_cycle" in mainComponent &&
      typeof mainComponent.billing_cycle === "string"
    ) {
      priceInterval = mainComponent.billing_cycle;
    }
  }

  let minSeats: number | undefined;
  if (
    latestPrice?.pricingData?.components &&
    latestPrice.pricingData.components.length > 0
  ) {
    for (const comp of latestPrice.pricingData.components) {
      if (comp.type === "per_unit" && (comp as any).num_seats != null) {
        const ns = (comp as any).num_seats;
        if (typeof ns === "number" && ns > 0) {
          minSeats = ns;
          break;
        }
      }
    }
  }

  return {
    title: planData.planName,
    description: planData.planDescription || "",
    price: priceAmount / 100, // Convert cents to dollars/euros
    currency: latestPrice ? latestPrice.currency.toLowerCase() : "usd",
    interval: priceInterval.toLowerCase(),
    features: planData.planFeatures.map(
      (pf: PlanFeature & { feature: Feature }) => ({
        text: pf.feature.displayName,
      })
    ),
    buttonText: options?.buttonText || "Get Started",
    buttonOutline: options?.buttonOutline || false,
    isPopular: options?.isPopular || false,
    popularText: options?.popularText || "Popular",
    planId: planData.id,
    priceId: latestPrice ? latestPrice.id : undefined,
    minSeats: minSeats,
  };
}

/**
 * Transforms an array of plans into standardized format
 */
export function transformPlansToPricingTablePlans(
  plans: PlanWithRelations[],
  options?: {
    buttonText?: string;
    buttonOutline?: boolean;
    isPopular?: boolean;
    popularText?: string;
  }
) {
  return plans.map((plan) => transformPlanToPricingTablePlan(plan, options));
}
