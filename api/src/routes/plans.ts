import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import {
  plans,
  plansInsertSchema,
  plansUpdateSchema,
  subscriptionsScheduledChanges,
} from "@lumen/common/schema";
import { eq, and, isNull, inArray, asc, desc, lt } from "drizzle-orm";
import { planFeatures } from "@lumen/common/schema";
import { prices } from "@lumen/common/schema";
import { features } from "@lumen/common/schema";
import { metrics } from "@lumen/common/schema";
import { merchants } from "@lumen/common/schema";
import { featureMetrics } from "@lumen/common/schema";
import { pricingTables, pricingTablePlans } from "@lumen/common/schema";
import { creditDefinitions } from "@lumen/common/schema";
import { subscriptions } from "@lumen/common/schema";
import {
  clonePricesToPlan,
  validatePriceIds,
  validateFeatureIds,
  attachFeaturesToPlan,
  DatabaseType,
} from "../helpers";
import { migrateSubscription } from "../helpers/billing";
import {
  editPlan,
  editPlanInPlace,
  getActiveSubscriptionCountForPlan,
  analyzePlanChange,
  createTrialPlan,
} from "../helpers/plans";
import { createPrice } from "../helpers/billing";
import { createCreditDefinition } from "../helpers/credits";
import { PriceDSLSchemaCreate } from "@lumen/common/validators";
import { creditDefinitionsInsertSchema } from "@lumen/common/schema";
import { formatCurrency } from "@lumen/common/utils";
import { tasks } from "@trigger.dev/sdk/v3";
import {
  getPaymentProvider,
  createDodoClient,
} from "../helpers/paymentprovider";

// Type definitions for API responses
type ErrorResponse = {
  error: string;
};

type Feature = typeof features.$inferSelect;
type Plan = typeof plans.$inferSelect;

// Define the shape of the plan with features from the database query
interface PlanWithPlanFeature extends Plan {
  planFeatures: {
    feature: Feature;
  }[];
  pricingTablePlans?: {
    id: string;
    isEnterprisePlan: boolean | null;
    enterpriseRedirectUrl: string | null;
    buttonText: string;
  }[];
}

interface PlanWithFeatures extends Plan {
  features: Feature[];
  isVisibleInPricingTable: boolean;
  isEnterprisePlan: boolean;
  enterpriseRedirectUrl: string | null;
  buttonText: string;
}

interface PlansResponse {
  plans: Plan[] | PlanWithFeatures[];
}

// Updated transformation function to include pricing table visibility
function transformPlansWithFeaturesAndVisibility(
  plans: PlanWithPlanFeature[]
): PlanWithFeatures[] {
  return plans.map((plan) => {
    const { planFeatures, pricingTablePlans, ...planWithoutFeatures } = plan;
    const firstPricingTablePlan = pricingTablePlans?.[0];
    return {
      ...planWithoutFeatures,
      features: planFeatures?.map(({ feature }) => feature) || [],
      isVisibleInPricingTable: Boolean(
        pricingTablePlans && pricingTablePlans.length > 0
      ),
      isEnterprisePlan: firstPricingTablePlan?.isEnterprisePlan || false,
      enterpriseRedirectUrl:
        firstPricingTablePlan?.enterpriseRedirectUrl || null,
      buttonText: firstPricingTablePlan?.buttonText || "Get Started",
    };
  });
}

// Helper functions for plan retrieval
async function getPlansByStableId(
  stableId: string,
  merchantId: string,
  includeFeatures: boolean
): Promise<PlansResponse | ErrorResponse> {
  const plansList: (Plan | PlanWithPlanFeature)[] =
    await db.query.plans.findMany({
      where: and(
        eq(plans.stablePlanId, stableId),
        eq(plans.merchantId, merchantId),
        isNull(plans.deletedAt),
        eq(plans.isTrialPlan, false)
      ),
      orderBy: asc(plans.versionNumber),
      with: {
        ...(includeFeatures && {
          planFeatures: {
            where: isNull(planFeatures.deletedAt),
            with: {
              feature: true,
            },
          },
        }),
        pricingTablePlans: {
          where: isNull(pricingTablePlans.deletedAt),
          columns: {
            id: true,
            isEnterprisePlan: true,
            enterpriseRedirectUrl: true,
            buttonText: true,
          },
        },
      },
    });

  if (!plansList || plansList.length === 0) {
    return { error: "Plan not found or access denied" };
  }

  if (includeFeatures) {
    return {
      plans: transformPlansWithFeaturesAndVisibility(
        plansList as PlanWithPlanFeature[]
      ),
    };
  }

  // For plans without features, still add isVisibleInPricingTable
  const plansWithVisibility = (plansList as PlanWithPlanFeature[]).map(
    (plan) => {
      const firstPricingTablePlan = plan.pricingTablePlans?.[0];
      return {
        ...plan,
        isVisibleInPricingTable: Boolean(
          plan.pricingTablePlans && plan.pricingTablePlans.length > 0
        ),
        isEnterprisePlan: firstPricingTablePlan?.isEnterprisePlan || false,
        enterpriseRedirectUrl:
          firstPricingTablePlan?.enterpriseRedirectUrl || null,
        buttonText: firstPricingTablePlan?.buttonText || "Get Started",
      };
    }
  );

  return { plans: plansWithVisibility };
}

async function getPlanById(
  id: string,
  merchantId: string,
  includeFeatures: boolean
): Promise<PlansResponse | ErrorResponse> {
  const plan: Plan | PlanWithPlanFeature | undefined =
    await db.query.plans.findFirst({
      where: and(
        eq(plans.id, id),
        eq(plans.merchantId, merchantId),
        isNull(plans.deletedAt),
        eq(plans.isTrialPlan, false)
      ),
      with: {
        ...(includeFeatures && {
          planFeatures: {
            where: isNull(planFeatures.deletedAt),
            with: {
              feature: true,
            },
          },
        }),
        pricingTablePlans: {
          where: isNull(pricingTablePlans.deletedAt),
          columns: {
            id: true,
            isEnterprisePlan: true,
            enterpriseRedirectUrl: true,
            buttonText: true,
          },
        },
      },
    });

  if (!plan) {
    return { error: "Plan not found or access denied" };
  }

  if (includeFeatures) {
    return {
      plans: transformPlansWithFeaturesAndVisibility([
        plan as PlanWithPlanFeature,
      ]),
    };
  }

  // For plan without features, still add isVisibleInPricingTable
  const firstPricingTablePlan = (plan as PlanWithPlanFeature)
    .pricingTablePlans?.[0];
  const planWithVisibility = {
    ...plan,
    isVisibleInPricingTable: Boolean(
      (plan as PlanWithPlanFeature).pricingTablePlans &&
        (plan as PlanWithPlanFeature).pricingTablePlans!.length > 0
    ),
    isEnterprisePlan: firstPricingTablePlan?.isEnterprisePlan || false,
    enterpriseRedirectUrl: firstPricingTablePlan?.enterpriseRedirectUrl || null,
    buttonText: firstPricingTablePlan?.buttonText || "Get Started",
  };

  return { plans: [planWithVisibility] };
}

// Create a modified schema for API validation
// We will manually decide how to insert stablePlanId and versionNumber
const planApiSchema = plansInsertSchema
  .omit({
    stablePlanId: true,
    versionNumber: true,
    merchantId: true,
  })
  .extend({
    stablePlanId: z.string().optional(),
    versionNumber: z.number().optional(),
    featureIds: z.array(z.string()).optional(),
    // New fields for comprehensive plan creation
    newFeatures: z
      .array(
        z.object({
          featureName: z.string(),
          slug: z.string(),
          eventName: z.string().optional(),
          isUsageBased: z.boolean(),
          usagePricePerUnit: z.number().optional(),
          hasCreditAllowance: z.boolean().optional(),
          creditAllowanceAmount: z.number().optional(),
          creditAllowanceRenewal: z
            .enum(["monthly", "yearly", "none"])
            .optional(),
          // Field for identifying existing features
          existingFeatureId: z.string().optional(),
        })
      )
      .optional(),
    currency: z.string().optional(),
    monthlyPrice: z.number().optional(),
    yearlyPrice: z.number().optional(),
    hasYearlyPrice: z.boolean().optional(),
    // Seat-based pricing toggle
    isSeatBased: z.boolean().optional(),
    // Minimum seats for seat-based pricing
    minSeats: z.number().int().min(0).optional(),
    // Billing timing
    billImmediately: z.boolean().optional(),
    showInPricingTable: z.boolean().optional(),
    // Enterprise plan fields
    isEnterprisePlan: z.boolean().optional(),
    enterpriseButtonText: z.string().optional(),
    enterpriseRedirectUrl: z.string().optional(),
    // Free trial configuration
    trial: z
      .union([
        // Trial enabled - requires days and optional creditOverrides
        z.object({
          enabled: z.literal(true),
          days: z.number().int().min(1).max(365),
          creditOverrides: z
            .array(
              z.object({
                featureSlug: z.string(),
                allowance: z.number().int().min(0),
              })
            )
            .optional(),
        }),
        // Trial disabled - only enabled field needed
        z.object({
          enabled: z.literal(false),
        }),
      ])
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.isSeatBased && data.billImmediately) {
      if (data.minSeats == null || data.minSeats < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Seat-based plans billed at the start of the cycle must specify a minimum number of seats (>= 1).",
          path: ["minSeats"],
        });
      }
    }
  });

// First, let's update the schema to include price and feature IDs
const planUpdateSchema = plansUpdateSchema
  .omit({
    // don't let user change these fields
    stablePlanId: true,
    versionNumber: true,
    merchantId: true,
    id: true,
    createdAt: true,
    deletedAt: true,
  })
  .extend({
    // needs to provide at least one of these
    priceIds: z.array(z.string()).optional(),
    featureIds: z.array(z.string()).optional(),
  });

// Helper function to get all plans for a merchant
async function getAllPlans(
  merchantId: string,
  includeFeatures: boolean,
  includePrices: boolean = false,
  includeTrials: boolean = false
): Promise<PlansResponse> {
  const whereConditions = [
    eq(plans.merchantId, merchantId),
    isNull(plans.deletedAt),
  ];

  // Only filter out trial plans if includeTrials is false
  if (!includeTrials) {
    whereConditions.push(eq(plans.isTrialPlan, false));
  }

  const allPlans = await db.query.plans.findMany({
    where: and(...whereConditions),
    with: {
      ...(includeFeatures && {
        planFeatures: {
          where: isNull(planFeatures.deletedAt),
          with: {
            feature: true,
          },
        },
      }),
      ...(includePrices && {
        prices: {
          where: isNull(prices.deletedAt),
          orderBy: desc(prices.createdAt),
        },
      }),
      pricingTablePlans: {
        where: isNull(pricingTablePlans.deletedAt),
        columns: {
          id: true,
          isEnterprisePlan: true,
          enterpriseRedirectUrl: true,
          buttonText: true,
        },
      },
    },
  });

  if (includeFeatures && allPlans.length > 0) {
    return {
      plans: transformPlansWithFeaturesAndVisibility(
        allPlans as PlanWithPlanFeature[]
      ),
    };
  }

  // For plans without features, still add isVisibleInPricingTable
  const plansWithVisibility = (allPlans as PlanWithPlanFeature[]).map(
    (plan) => {
      const firstPricingTablePlan = plan.pricingTablePlans?.[0];
      return {
        ...plan,
        isVisibleInPricingTable: Boolean(
          plan.pricingTablePlans && plan.pricingTablePlans.length > 0
        ),
        isEnterprisePlan: firstPricingTablePlan?.isEnterprisePlan || false,
        enterpriseRedirectUrl:
          firstPricingTablePlan?.enterpriseRedirectUrl || null,
        buttonText: firstPricingTablePlan?.buttonText || "Get Started",
      };
    }
  );

  return { plans: plansWithVisibility };
}

/**
 * Helper function to extract the lowest fixed price component from a plan's pricing data
 * Used for pricing table ordering - free plans and usage-only plans return 0 to appear first
 */
function getLowestFixedPrice(pricingData: any): number {
  if (!pricingData || !pricingData.components) {
    return Number.MAX_SAFE_INTEGER;
  }

  const fixedComponents = pricingData.components.filter(
    (component: any) =>
      component.type === "fixed" || component.type === "per_unit"
  );

  if (fixedComponents.length === 0) {
    // If there are no fixed/per_unit components but there are usage components,
    // this is a usage-only plan which should be considered "free" (0 base price)
    const hasUsageComponents = pricingData.components.some(
      (component: any) => component.type === "usage"
    );
    return hasUsageComponents ? 0 : Number.MAX_SAFE_INTEGER;
  }

  return Math.min(...fixedComponents.map((c: any) => c.amount_cents || 0));
}

/**
 * Handles pricing table creation/update when a plan is created with showInPricingTable flag
 */
async function handlePricingTableForPlan(
  planId: string,
  merchantId: string,
  dbInstance: DatabaseType,
  isEnterprisePlan: boolean = false,
  enterpriseButtonText?: string,
  enterpriseRedirectUrl?: string
): Promise<void> {
  // Check if merchant has any existing pricing tables
  const existingPricingTable = await dbInstance.query.pricingTables.findFirst({
    where: and(
      eq(pricingTables.merchantId, merchantId),
      isNull(pricingTables.deletedAt)
    ),
    with: {
      pricingTablePlans: {
        where: isNull(pricingTablePlans.deletedAt),
        with: {
          plan: {
            with: {
              prices: {
                where: isNull(prices.deletedAt),
                orderBy: desc(prices.createdAt),
                // Fetch ALL price records for accurate migration mapping (remove limit)
              },
            },
          },
        },
      },
    },
  });

  let pricingTableId: string;

  if (!existingPricingTable) {
    // Create a new pricing table
    const [newPricingTable] = await dbInstance
      .insert(pricingTables)
      .values({
        merchantId,
        name: "Default Pricing Table",
        slug: `pricing-table-${Date.now()}`,
        description: "Automatically generated pricing table",
        heading: "Choose Your Plan",
        subheading: "Select the perfect plan for your needs",
        isActive: true,
      })
      .returning();

    pricingTableId = newPricingTable.id;
  } else {
    pricingTableId = existingPricingTable.id;
  }

  // Get the new plan with its pricing information
  const newPlan = await dbInstance.query.plans.findFirst({
    where: eq(plans.id, planId),
    with: {
      prices: {
        where: isNull(prices.deletedAt),
        orderBy: desc(prices.createdAt),
        limit: 1,
      },
    },
  });

  if (!newPlan) {
    throw new Error("Plan not found");
  }

  // Get current plans in the pricing table to determine correct display order
  const currentPlansInTable = existingPricingTable?.pricingTablePlans || [];

  // Build array of all plans with their prices for ordering
  const allPlansWithPrices = [
    ...currentPlansInTable.map((ptp) => ({
      planId: ptp.plan.id,
      price: getLowestFixedPrice(ptp.plan.prices[0]?.pricingData),
      currentDisplayOrder: ptp.displayOrder,
    })),
    {
      planId: newPlan.id,
      price: isEnterprisePlan
        ? Number.MAX_SAFE_INTEGER
        : getLowestFixedPrice(newPlan.prices[0]?.pricingData),
      currentDisplayOrder: null,
    },
  ];

  // Sort by price (lowest to highest) - Enterprise plans will be at the end
  allPlansWithPrices.sort((a, b) => a.price - b.price);

  // Find the correct display order for the new plan
  const newPlanIndex = allPlansWithPrices.findIndex(
    (p) => p.planId === newPlan.id
  );
  const newDisplayOrder = newPlanIndex + 1;

  // Check if the plan is already in the pricing table
  const existingAssociation =
    await dbInstance.query.pricingTablePlans.findFirst({
      where: and(
        eq(pricingTablePlans.pricingTableId, pricingTableId),
        eq(pricingTablePlans.planId, planId),
        eq(pricingTablePlans.merchantId, merchantId),
        isNull(pricingTablePlans.deletedAt)
      ),
    });

  if (!existingAssociation) {
    // Update display orders for existing plans if necessary
    for (let i = 0; i < allPlansWithPrices.length; i++) {
      const planData = allPlansWithPrices[i];
      if (
        planData.planId !== newPlan.id &&
        planData.currentDisplayOrder !== null
      ) {
        const newOrder = i + 1;
        if (newOrder !== planData.currentDisplayOrder) {
          await dbInstance
            .update(pricingTablePlans)
            .set({ displayOrder: newOrder })
            .where(
              and(
                eq(pricingTablePlans.pricingTableId, pricingTableId),
                eq(pricingTablePlans.planId, planData.planId),
                eq(pricingTablePlans.merchantId, merchantId)
              )
            );
        }
      }
    }

    // Add the new plan to the pricing table
    await dbInstance.insert(pricingTablePlans).values({
      pricingTableId,
      planId,
      merchantId,
      displayOrder: newDisplayOrder,
      isPopular: false,
      popularText: "Popular",
      buttonText: isEnterprisePlan
        ? enterpriseButtonText || "Contact Sales"
        : "Get Started",
      buttonOutline: false,
      isEnterprisePlan,
      enterpriseRedirectUrl: isEnterprisePlan ? enterpriseRedirectUrl : null,
    });
  }
}

/**
 * Creates a new plan with optional features, metrics, and prices in a single transaction
 */
async function createPlan(
  merchantId: string,
  data: z.infer<typeof planApiSchema>,
  dbInstance: DatabaseType = db
): Promise<PlansResponse | ErrorResponse> {
  const {
    featureIds,
    newFeatures,
    currency,
    monthlyPrice,
    yearlyPrice,
    hasYearlyPrice,
    isSeatBased,
    minSeats,
    billImmediately,
    isEnterprisePlan,
    enterpriseButtonText,
    enterpriseRedirectUrl,
    ...planData
  } = data;

  console.log("createPlan called with data", data);

  // Get merchant's default currency
  const merchant = await dbInstance.query.merchants.findFirst({
    where: eq(merchants.id, merchantId),
  });

  const defaultCurrency = currency || merchant?.defaultCurrency || "USD";

  // Verify existing feature IDs if provided
  if (featureIds?.length) {
    const validFeatures = await validateFeatureIds(
      merchantId,
      featureIds,
      dbInstance
    );
    if (!validFeatures) {
      return {
        error:
          "One or more feature IDs are invalid or do not belong to this merchant",
      };
    }
  }

  // Create everything in a single transaction
  const result = await dbInstance.transaction(async (tx) => {
    // Generate stable ID and set version
    const versionNumber = planData.versionNumber || 1;
    const commitMessage =
      planData.commitMessage ||
      `Plan created: ${planData.planName}, version ${versionNumber}`;

    // Step 1: Create the plan first
    const [newPlan] = await tx
      .insert(plans)
      .values({
        ...planData,
        merchantId,
        versionNumber,
        commitMessage,
      })
      .returning();

    // Hold features that need credit definitions linked to price components
    const pendingPriceLinkedCreditDefs: {
      featureSlug: string;
      featureId: string;
      creditDefBase: Omit<
        z.infer<typeof creditDefinitionsInsertSchema>,
        "priceId" | "priceComponentId"
      > & {
        merchantId: string;
      };
    }[] = [];

    const featureIdsToAttach: string[] = [...(featureIds || [])];

    if (newFeatures?.length) {
      for (const feature of newFeatures) {
        let featureId: string;
        let metricId: string | undefined;

        // Check if this is an existing feature (indicated by existingFeatureId or if slug already exists)
        if (feature.existingFeatureId) {
          // This is an existing feature being configured
          featureId = feature.existingFeatureId;
        } else {
          // Check if a feature with this slug already exists
          const existingFeature = await tx.query.features.findFirst({
            where: and(
              eq(features.merchantId, merchantId),
              eq(features.slug, feature.slug),
              isNull(features.deletedAt)
            ),
          });

          if (existingFeature) {
            // Reuse existing feature
            featureId = existingFeature.id;
          } else {
            // Create metric for usage-based features
            if (feature.isUsageBased && feature.eventName) {
              const [newMetric] = await tx
                .insert(metrics)
                .values({
                  merchantId,
                  name: `${feature.featureName} Usage Metric`,
                  description: `Tracks usage for ${feature.featureName}`,
                  queryType: "simple",
                  aggregationType: "SUM",
                  eventName: feature.eventName,
                  valueType: "NUMERIC",
                })
                .returning();
              metricId = newMetric.id;
            }

            // Create new feature
            const [newFeature] = await tx
              .insert(features)
              .values({
                merchantId,
                slug: feature.slug,
                displayName: feature.featureName,
                description: feature.isUsageBased
                  ? `${feature.featureName} usage tracking`
                  : `${feature.featureName} feature access`,
                featureType: feature.isUsageBased ? "number" : "boolean",
                featureValue: feature.isUsageBased ? "usage_based" : true,
                isOverrideFeature: false,
              })
              .returning();

            featureId = newFeature.id;

            // Link metric to feature if metric was created
            if (metricId) {
              await tx.insert(featureMetrics).values({
                merchantId,
                featureId: newFeature.id,
                featureSlug: newFeature.slug,
                metricId,
              });
            }
          }
        }

        featureIdsToAttach.push(featureId);

        // Create credit allowance for this feature if specified
        if (
          feature.hasCreditAllowance &&
          feature.creditAllowanceAmount &&
          feature.creditAllowanceAmount > 0
        ) {
          const creditName = `${feature.featureName} Credits`;
          const creditDescription = `Usage credits for ${feature.featureName}`;

          // Set up renewal configuration based on feature credit renewal setting
          let renewalConfig: {
            refillAmount?: number;
            refillRrule?: string;
            expiryDays?: number;
            renewOnBilling?: boolean;
          } = {};

          if (feature.creditAllowanceRenewal === "monthly") {
            // Check if there will be usage-based pricing for this feature
            const hasUsageBasedPricing =
              feature.isUsageBased &&
              feature.usagePricePerUnit !== undefined &&
              feature.usagePricePerUnit > 0;

            if (hasUsageBasedPricing) {
              // Usage-based pricing exists, use billing-based renewal
              renewalConfig = {
                refillAmount: feature.creditAllowanceAmount,
                expiryDays: -1, // ✅ Expire with billing cycle
                renewOnBilling: true, // ✅ Renew with customer's billing cycle
              };
            } else {
              // No usage-based pricing, use RRULE-based renewal
              renewalConfig = {
                refillAmount: feature.creditAllowanceAmount,
                refillRrule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
                expiryDays: -1, // ✅ Expire with renewal cycle
                renewOnBilling: false, // ✅ Use RRULE-based renewal
              };
            }
          } else if (feature.creditAllowanceRenewal === "yearly") {
            // Check if there will be usage-based pricing for this feature
            const hasUsageBasedPricing =
              feature.isUsageBased &&
              feature.usagePricePerUnit !== undefined &&
              feature.usagePricePerUnit > 0;

            if (hasUsageBasedPricing) {
              // Usage-based pricing exists, use billing-based renewal
              renewalConfig = {
                refillAmount: feature.creditAllowanceAmount,
                expiryDays: -1, // ✅ Expire with billing cycle
                renewOnBilling: true, // ✅ Renew with customer's billing cycle
              };
            } else {
              // No usage-based pricing, use RRULE-based renewal
              renewalConfig = {
                refillAmount: feature.creditAllowanceAmount,
                refillRrule: "RRULE:FREQ=YEARLY;INTERVAL=1",
                expiryDays: -1, // ✅ Expire with renewal cycle
                renewOnBilling: false, // ✅ Use RRULE-based renewal
              };
            }
          } else {
            // "none" - one-time credit with no renewal
            renewalConfig = {
              expiryDays: 365, // Default 1 year expiry for non-renewable credits
            };
          }

          // Determine if this credit will be linked to pricing
          const willBePriceLinked =
            feature.isUsageBased &&
            feature.usagePricePerUnit !== undefined &&
            feature.usagePricePerUnit > 0;

          const creditDefBase = {
            merchantId,
            scope: "plan" as const,
            applicationType: "usage" as const,
            planId: newPlan.id,
            featureId: featureId,
            featureSlug: feature.slug,
            name: creditName,
            description: creditDescription,
            defaultAmount: feature.creditAllowanceAmount,
            billingVisible: willBePriceLinked, // true if linked to pricing, false if just a feature counter
            priority: 100,
            ...renewalConfig,
          };

          // If the feature has a usage price, we need to link credit definition to price/component after price creation
          if (willBePriceLinked) {
            pendingPriceLinkedCreditDefs.push({
              featureSlug: feature.slug,
              featureId,
              creditDefBase,
            });
          } else {
            // No price linkage required – create immediately
            await createCreditDefinition(creditDefBase, tx);
          }
        }
      }
    }

    // Step 3: Attach all features to the plan
    if (featureIdsToAttach.length > 0) {
      await attachFeaturesToPlan(newPlan.id, featureIdsToAttach, tx);
    }

    // Step 4: Create prices (skip for enterprise plans)
    if (!isEnterprisePlan) {
      const usageComponents: PriceDSLSchemaCreate["components"] = [];

      // Keep track of created prices for linking credit definitions later
      const createdPrices: (typeof prices.$inferSelect)[] = [];

      // Add usage-based and per-unit pricing components for features
      if (newFeatures?.length) {
        for (const feature of newFeatures) {
          // Handle usage-based pricing components
          if (
            feature.isUsageBased &&
            feature.usagePricePerUnit !== undefined &&
            feature.usagePricePerUnit > 0 &&
            feature.eventName
          ) {
            // Find the corresponding feature and its metric
            let targetFeatureId: string;

            if (feature.existingFeatureId) {
              targetFeatureId = feature.existingFeatureId;
            } else {
              // Find by slug
              const existingFeature = await tx.query.features.findFirst({
                where: and(
                  eq(features.merchantId, merchantId),
                  eq(features.slug, feature.slug),
                  isNull(features.deletedAt)
                ),
              });
              targetFeatureId = existingFeature?.id || "";
            }

            if (targetFeatureId) {
              const featureWithMetric = await tx.query.featureMetrics.findFirst(
                {
                  where: and(
                    eq(featureMetrics.featureId, targetFeatureId),
                    eq(featureMetrics.merchantId, merchantId)
                  ),
                }
              );

              if (featureWithMetric?.metricId) {
                const usageComponent = {
                  type: "usage" as const,
                  component_name: `usage_${feature.slug}`,
                  label: `${planData.planName} - ${feature.featureName} usage`,
                  unit_label: "unit",
                  metric_id: featureWithMetric.metricId,
                  unit_cost_cents: feature.usagePricePerUnit,
                  recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
                  bill_immediately: false,
                };
                usageComponents.push(usageComponent);
              }
            }
          }
        }
      }

      // Determine if we need to create a monthly price record
      // We create a price record in these scenarios:
      // 1. User explicitly set monthlyPrice (including $0 for free plans)
      // 2. No monthlyPrice AND no usage components = truly free plan that needs a $0 fixed component
      //    (otherwise subscription flow won't work as it needs at least one price record)
      const needsMonthlyPrice =
        // Explicit monthly price (including $0)
        monthlyPrice !== undefined ||
        // No monthly price but no usage components (free plan needs $0 fixed component)
        (monthlyPrice === undefined && usageComponents.length === 0);

      if (needsMonthlyPrice) {
        // Default to $0 if no monthly price specified
        const actualMonthlyPrice = monthlyPrice ?? 0;
        let monthlyComponent;

        if (isSeatBased) {
          // Create a complex metric for seat counting
          const metricName = `Active seat count for ${planData.planName}`;
          const metricDescription = `Counts active users for seat-based billing for ${planData.planName}`;

          const seatCountSql = `
            WITH user_events_before_period AS (
              SELECT
                event_string as user_id,
                event_name,
                event_timestamp,
                row_number() OVER (
                  PARTITION BY event_string
                  ORDER BY event_timestamp DESC
                ) as rn
              FROM events
              WHERE merchant_id = $1
                AND customer_id = $2
                AND json_extract(properties, '$.subscription_id')::varchar = $3
                AND event_name IN ('seat_added', 'seat_removed')
                AND event_timestamp < $4
            ),
            users_active_at_period_start AS (
              SELECT user_id
              FROM user_events_before_period
              WHERE rn = 1 AND event_name = 'seat_added'
            ),
            users_added_during_period AS (
              SELECT DISTINCT event_string as user_id
              FROM events
              WHERE merchant_id = $1
                AND customer_id = $2
                AND json_extract(properties, '$.subscription_id')::varchar = $3
                AND event_name = 'seat_added'
                AND event_timestamp >= $4
                AND event_timestamp <= $5
            )
            SELECT COUNT(DISTINCT user_id) as value
            FROM (
              SELECT user_id FROM users_active_at_period_start
              UNION
              SELECT user_id FROM users_added_during_period
            ) combined_users
          `.trim();

          const [newMetric] = await tx
            .insert(metrics)
            .values({
              merchantId,
              name: metricName,
              description: metricDescription,
              queryType: "complex",
              sqlDefinition: seatCountSql,
            })
            .returning();

          monthlyComponent = {
            type: "per_unit" as const,
            component_name: "per_unit_monthly",
            label: `${planData.planName} - ${formatCurrency(actualMonthlyPrice, defaultCurrency)} per month per seat`,
            unit_label: "seat",
            metric_id: newMetric.id,
            amount_cents: actualMonthlyPrice,
            ...(minSeats && minSeats > 0 && { num_seats: minSeats }),
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately:
              billImmediately !== undefined
                ? billImmediately
                : !!(minSeats && minSeats > 1),
          };
        } else {
          monthlyComponent = {
            type: "fixed" as const,
            component_name: "monthly",
            label:
              actualMonthlyPrice === 0
                ? `${planData.planName} - Free`
                : `${planData.planName} - ${formatCurrency(actualMonthlyPrice, defaultCurrency)} per month`,
            amount_cents: actualMonthlyPrice,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately:
              billImmediately !== undefined ? billImmediately : true,
          };
        }

        const newMonthlyPrice = await createPrice({
          planId: newPlan.id,
          merchantId,
          currency: defaultCurrency,
          pricingData: {
            dsl_version: 1,
            components: [monthlyComponent, ...usageComponents],
          },
          isOverridePrice: false,
          tx,
        });
        createdPrices.push(newMonthlyPrice);
      } else if (usageComponents.length > 0) {
        // Usage-only plan: create price record with only usage components
        // This handles the case where monthlyPrice is undefined but we have usage-based features
        // The plan has no fixed cost but users pay for usage beyond credit allowances
        const newUsageOnlyPrice = await createPrice({
          planId: newPlan.id,
          merchantId,
          currency: defaultCurrency,
          pricingData: {
            dsl_version: 1,
            components: usageComponents,
          },
          isOverridePrice: false,
          tx,
        });
        createdPrices.push(newUsageOnlyPrice);
      }

      // Create yearly pricing for both fixed and seat-based plans
      if (hasYearlyPrice && yearlyPrice !== undefined && yearlyPrice > 0) {
        let yearlyComponent;

        if (isSeatBased) {
          // Create yearly per_unit component for seat-based pricing
          // Reuse the same metric as the monthly component
          const yearlyMetric = await tx.query.metrics.findFirst({
            where: and(
              eq(metrics.merchantId, merchantId),
              eq(metrics.name, `Active seat count for ${planData.planName}`)
            ),
          });

          if (yearlyMetric) {
            yearlyComponent = {
              type: "per_unit" as const,
              component_name: "per_unit_yearly",
              label: `${planData.planName} - ${formatCurrency(yearlyPrice * 12, defaultCurrency)} per seat per year`,
              unit_label: "seat",
              metric_id: yearlyMetric.id,
              amount_cents: yearlyPrice * 12,
              ...(minSeats && minSeats > 0 && { num_seats: minSeats }),
              recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1",
              bill_immediately:
                billImmediately !== undefined
                  ? billImmediately
                  : !!(minSeats && minSeats > 1),
            };
          }
        } else {
          // Create fixed component for regular pricing
          yearlyComponent = {
            type: "fixed" as const,
            component_name: "annual",
            label: `${planData.planName} - ${formatCurrency(yearlyPrice, defaultCurrency)} × 12 billed yearly`,
            amount_cents: yearlyPrice * 12,
            recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1",
            bill_immediately:
              billImmediately !== undefined ? billImmediately : true,
          };
        }

        if (yearlyComponent) {
          const newYearlyPrice = await createPrice({
            planId: newPlan.id,
            merchantId,
            currency: defaultCurrency,
            pricingData: {
              dsl_version: 1,
              components: [yearlyComponent, ...usageComponents],
            },
            isOverridePrice: false,
            tx,
          });
          createdPrices.push(newYearlyPrice);
        }
      }

      // After prices are created, create any pending credit definitions that need price linkage
      if (pendingPriceLinkedCreditDefs.length > 0 && createdPrices.length > 0) {
        for (const pending of pendingPriceLinkedCreditDefs) {
          for (const priceRecord of createdPrices) {
            // Find the corresponding usage component for this feature
            const matchingComponent = priceRecord.pricingData.components.find(
              (c: any) =>
                c.type === "usage" &&
                c.component_name === `usage_${pending.featureSlug}`
            );

            if (!matchingComponent) continue;

            await createCreditDefinition(
              {
                ...pending.creditDefBase,
                priceId: priceRecord.id,
                priceComponentId: matchingComponent.component_id,
              },
              tx
            );
          }
        }
      }
    }

    // Handle pricing table creation if requested (do this before querying the plan)
    if (data.showInPricingTable) {
      await handlePricingTableForPlan(
        newPlan.id,
        merchantId,
        tx,
        isEnterprisePlan,
        enterpriseButtonText,
        enterpriseRedirectUrl
      );
    }

    // Step 5: Return plan with all associations
    const planWithFeatures = await tx.query.plans.findFirst({
      where: eq(plans.id, newPlan.id),
      with: {
        planFeatures: {
          with: {
            feature: true,
          },
        },
        prices: {
          where: isNull(prices.deletedAt),
        },
        pricingTablePlans: {
          where: isNull(pricingTablePlans.deletedAt),
          columns: {
            id: true,
            isEnterprisePlan: true,
            enterpriseRedirectUrl: true,
            buttonText: true,
          },
        },
      },
    });

    if (!planWithFeatures) {
      throw new Error("Failed to create plan");
    }

    // Create trial plan if trial is enabled (but not for enterprise plans)
    if (data.trial?.enabled && !isEnterprisePlan) {
      console.log("Creating trial plan for", newPlan.planName);
      await createTrialPlan(
        newPlan,
        {
          enabled: true,
          days: data.trial.days,
          creditOverrides: data.trial.creditOverrides,
        },
        tx
      );
    }

    const transformedPlan = transformPlansWithFeaturesAndVisibility([
      planWithFeatures as PlanWithPlanFeature,
    ])[0];

    const paymentProvider = await getPaymentProvider(merchantId);

    if (paymentProvider.name === "dodo") {
      const client = await createDodoClient(paymentProvider);

      const dodoProduct = await client.products.create({
        name: transformedPlan.planName,
        description: transformedPlan.planDescription,
        price: {
          currency: defaultCurrency === "INR" ? "INR" : "USD", // only USD and INR are supported
          discount: 0,
          price: 100,
          payment_frequency_count: 10,
          payment_frequency_interval: "Year",
          subscription_period_count: 10,
          subscription_period_interval: "Year",
          purchasing_power_parity: true,
          type: "recurring_price",
        },
        tax_category: "digital_products",
      });
      await tx
        .update(plans)
        .set({ pspPlanId: dodoProduct.product_id })
        .where(eq(plans.id, transformedPlan.id));
    }

    return transformedPlan;
  });

  return { plans: [result] };
}

export const plansRoute = new Hono()
  // Get all plans for merchant
  .get(
    "/",
    zValidator(
      "query",
      z
        .object({
          includeFeatures: z.string().optional(),
          includePrices: z.string().optional(),
          includeTrials: z.string().optional(),
        })
        .optional()
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const includeFeatures = c.req.valid("query")?.includeFeatures === "true";
      const includePrices = c.req.valid("query")?.includePrices === "true";
      const includeTrials = c.req.valid("query")?.includeTrials === "true";
      const result = await getAllPlans(
        merchantId,
        includeFeatures,
        includePrices,
        includeTrials
      );

      return c.json(result);
    }
  )
  // Get a specific plan by id or stableId
  .get(
    "/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator(
      "query",
      z
        .object({
          includeFeatures: z.string().optional(),
          isStableId: z.string().optional(),
        })
        .optional()
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const planId = c.req.valid("param").id;
      if (!planId) {
        return c.json({ error: "No plan ID found in URL" }, 400);
      }

      const includeFeatures = c.req.valid("query")?.includeFeatures === "true";
      const isStableId = c.req.valid("query")?.isStableId === "true";

      const result = isStableId
        ? await getPlansByStableId(planId, merchantId, includeFeatures)
        : await getPlanById(planId, merchantId, includeFeatures);

      if ("error" in result) {
        return c.json(result, 404);
      }

      return c.json(result);
    }
  )
  // Raw plan creation method
  // stablePlanId and versionNumber are optional but if provided, we'll use them directly
  // otherwise we'll generate a new stablePlanId and versionNumber
  .post("/", zValidator("json", planApiSchema), async (c) => {
    const merchantId = c.get("merchant")!.id;

    try {
      const result = await createPlan(merchantId, c.req.valid("json"));
      return c.json(result);
    } catch (error) {
      console.error("Error creating plan:", error);
      return c.json({ error: "Failed to create plan" }, 500);
    }
  })
  // given a plan id and plan data, create a new version of the plan (i.e. update the plan)
  // OR create a new version of a plan given the stablePlanId by setting the isStableId query param
  .post(
    "/:id",
    zValidator("query", z.object({ isStableId: z.string().optional() })),
    zValidator("json", planUpdateSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const planId = c.req.param("id");
      const isStableId = c.req.valid("query").isStableId === "true";
      if (!planId) {
        return c.json({ error: "No plan ID found in URL" }, 400);
      }

      // get the old plan based on URL id
      const data = c.req.valid("json");
      const { priceIds, featureIds, ...planData } = data;

      // if neither priceIds or featureIds are provided, we update the other plan data in-place
      // since it's just a cosmetic change to the plan
      if (!priceIds && !featureIds) {
        // update the plan data in-place
        const result = await db
          .update(plans)
          .set(planData)
          .where(eq(plans.id, planId))
          .returning();
        return c.json({ plans: result });
      }

      // Get the existing plan with its current prices and features
      const existingPlans = await db.query.plans.findMany({
        where: and(
          isStableId ? eq(plans.stablePlanId, planId) : eq(plans.id, planId),
          eq(plans.merchantId, merchantId)
        ),
        with: {
          prices: {
            where: isNull(prices.deletedAt),
          },
          planFeatures: {
            where: isNull(planFeatures.deletedAt),
          },
        },
      });

      if (!existingPlans || existingPlans.length === 0) {
        return c.json({ error: "Plan not found or access denied" }, 404);
      }

      const latestPlan = existingPlans[existingPlans.length - 1];
      const stablePlanId = latestPlan.stablePlanId;
      const newVersionNumber = latestPlan.versionNumber + 1;
      const commitMessage =
        data.commitMessage ||
        `Plan updated: ${latestPlan.planName}, version ${newVersionNumber}`;

      try {
        // Verify that all provided price IDs belong to this merchant
        if (
          priceIds?.length &&
          !(await validatePriceIds(merchantId, priceIds))
        ) {
          return c.json(
            {
              error:
                "One or more price IDs are invalid or do not belong to this merchant",
            },
            400
          );
        }

        // Verify that all provided feature IDs belong to this merchant
        if (featureIds?.length) {
          const validFeatures = await db.query.features.findMany({
            where: and(
              eq(features.merchantId, merchantId),
              isNull(features.deletedAt),
              inArray(features.id, featureIds)
            ),
          });

          if (validFeatures.length !== featureIds.length) {
            return c.json(
              {
                error:
                  "One or more feature IDs are invalid or do not belong to this merchant",
              },
              400
            );
          }
        }

        // Create new version with updated associations in a transaction
        const result = await db.transaction(async (tx) => {
          // Create the new plan version
          const [newPlan] = await tx
            .insert(plans)
            .values({
              planName: planData.planName || latestPlan.planName,
              planDescription:
                planData.planDescription || latestPlan.planDescription,
              merchantId,
              stablePlanId,
              versionNumber: newVersionNumber,
              commitMessage,
            })
            .returning();

          // Handle prices - either use provided ones or clone existing ones
          const sourcePriceIds = priceIds || latestPlan.prices.map((p) => p.id);
          if (sourcePriceIds.length > 0) {
            if (priceIds) {
              // If specific prices provided, associate them directly
              await tx
                .update(prices)
                .set({ planId: newPlan.id })
                .where(inArray(prices.id, priceIds));
            } else {
              // Clone existing prices to new plan
              await clonePricesToPlan(
                tx as unknown as typeof db, // TYPE: they support the same methods
                sourcePriceIds,
                newPlan.id,
                merchantId
              );
            }
          }

          // Handle features
          let featuresToAssociate;
          if (featureIds) {
            // If specific feature IDs provided, fetch their current values from DB
            const existingFeatures = await tx.query.planFeatures.findMany({
              where: and(
                eq(planFeatures.planId, latestPlan.id),
                inArray(planFeatures.featureId, featureIds)
              ),
            });

            featuresToAssociate = featureIds.map((featureId) => {
              // Find existing feature values if they exist
              const existingFeature = existingFeatures.find(
                (f) => f.featureId === featureId
              );
              return {
                featureId,
                featureValue: existingFeature?.featureValue ?? true,
                featureSlug: existingFeature?.featureSlug ?? "",
              };
            });
          } else {
            // Use existing features from the latest plan
            featuresToAssociate = latestPlan.planFeatures.map((f) => ({
              featureId: f.featureId,
              featureValue: f.featureValue,
              featureSlug: f.featureSlug,
            }));
          }

          if (featuresToAssociate.length > 0) {
            await tx.insert(planFeatures).values(
              featuresToAssociate.map((f) => ({
                planId: newPlan.id,
                featureId: f.featureId,
                featureValue: f.featureValue,
                featureSlug: f.featureSlug,
              }))
            );
          }

          // Return the new plan with its associations
          const planWithFeatures = await tx.query.plans.findFirst({
            where: eq(plans.id, newPlan.id),
            with: {
              planFeatures: {
                with: {
                  feature: true,
                },
              },
              pricingTablePlans: {
                where: isNull(pricingTablePlans.deletedAt),
                columns: {
                  id: true,
                  isEnterprisePlan: true,
                  enterpriseRedirectUrl: true,
                  buttonText: true,
                },
              },
            },
          });

          if (!planWithFeatures) {
            throw new Error("Failed to create plan");
          }

          return transformPlansWithFeaturesAndVisibility([
            planWithFeatures as PlanWithPlanFeature,
          ])[0];
        });

        return c.json({ plans: [result] });
      } catch (error) {
        console.error("Error updating plan:", error);
        return c.json(
          {
            error:
              "Failed to update plan. Please ensure all IDs are valid and try again.",
          },
          500
        );
      }
    }
  )
  // Intelligent plan editing endpoint
  .post(
    "/:id/edit",
    zValidator("param", z.object({ id: z.string() })),
    zValidator(
      "json",
      z.object({
        planName: z.string().optional(),
        planDescription: z.string().optional(),
        features: z
          .array(
            z.object({
              featureName: z.string(),
              slug: z.string(),
              eventName: z.string().optional(),
              isUsageBased: z.boolean(),
              usagePricePerUnit: z.number().optional(),
              hasCreditAllowance: z.boolean().optional(),
              creditAllowanceAmount: z.number().optional(),
              creditAllowanceRenewal: z
                .enum(["monthly", "yearly", "none"])
                .optional(),
              existingFeatureId: z.string().optional(),
            })
          )
          .optional(),
        currency: z.string().optional(),
        monthlyPrice: z.number().optional(),
        yearlyPrice: z.number().optional(),
        hasYearlyPrice: z.boolean().optional(),
        isEnterprisePlan: z.boolean().optional(),
        enterpriseButtonText: z.string().optional(),
        enterpriseRedirectUrl: z.string().optional(),
        showInPricingTable: z.boolean().optional(),
        // Seat-based pricing fields
        isSeatBased: z.boolean().optional(),
        minSeats: z.number().optional(),
        billImmediately: z.boolean().optional(),
        // Trial configuration
        trial: z
          .union([
            // Trial enabled - requires days and optional creditOverrides
            z.object({
              enabled: z.literal(true),
              days: z.number().int().min(1).max(365),
              creditOverrides: z
                .array(
                  z.object({
                    featureSlug: z.string(),
                    allowance: z.number().int().min(0),
                  })
                )
                .optional(),
            }),
            // Trial disabled - only enabled field needed
            z.object({
              enabled: z.literal(false),
            }),
          ])
          .optional(),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const planId = c.req.valid("param").id;
      const editInput = c.req.valid("json");

      if (!planId) {
        return c.json({ error: "No plan ID found in URL" }, 400);
      }

      try {
        // Check active subscription count for this plan (all versions)
        const planRecord = await db.query.plans.findFirst({
          where: and(
            eq(plans.id, planId),
            eq(plans.merchantId, merchantId),
            isNull(plans.deletedAt)
          ),
        });

        if (!planRecord) {
          return c.json<{ error: string }>(
            { error: "Plan not found or access denied" },
            404
          );
        }

        const activeSubCount = await getActiveSubscriptionCountForPlan(
          planRecord.stablePlanId,
          merchantId
        );

        // Helper function to determine if changes are metadata-only (safe for in-place editing)
        const isMetadataOnlyEdit = async (
          input: typeof editInput
        ): Promise<boolean> => {
          // Load current plan data to compare against
          const currentPlan = await db.query.plans.findFirst({
            where: and(
              eq(plans.id, planId),
              eq(plans.merchantId, merchantId),
              isNull(plans.deletedAt)
            ),
            with: {
              prices: {
                where: isNull(prices.deletedAt),
                orderBy: desc(prices.createdAt),
              },
              pricingTablePlans: {
                where: isNull(pricingTablePlans.deletedAt),
                limit: 1,
              },
            },
          });

          if (!currentPlan) return false;

          // Check if plan name or description actually changed
          const hasNameChange =
            input.planName !== undefined &&
            input.planName !== currentPlan.planName;
          const hasDescriptionChange =
            input.planDescription !== undefined &&
            input.planDescription !== currentPlan.planDescription;

          // Check enterprise fields from pricing table plans
          const currentPricingTablePlan = currentPlan.pricingTablePlans?.[0];
          const hasEnterpriseButtonChange =
            input.enterpriseButtonText !== undefined &&
            input.enterpriseButtonText !==
              (currentPricingTablePlan?.buttonText ?? "Contact Sales");
          const hasEnterpriseUrlChange =
            input.enterpriseRedirectUrl !== undefined &&
            input.enterpriseRedirectUrl !==
              (currentPricingTablePlan?.enterpriseRedirectUrl ?? "");

          // Check for pricing changes
          let hasPriceChanges = false;
          if (
            input.monthlyPrice !== undefined ||
            input.yearlyPrice !== undefined ||
            input.hasYearlyPrice !== undefined
          ) {
            // Enhanced component finder that supports both traditional fixed-price and seat-based per_unit components.
            const findComponent = (name: "monthly" | "annual") => {
              for (const p of currentPlan.prices) {
                const comp = p.pricingData?.components?.find((c: any) => {
                  // 1) Exact component_name match (legacy fixed pricing)
                  if (c.component_name === name) return true;

                  // 2) Seat-based per_unit components rely on recurrence_rule rather than name
                  if (name === "monthly") {
                    return (
                      c.recurrence_rule?.includes("FREQ=MONTHLY") &&
                      (c.type === "fixed" || c.type === "per_unit")
                    );
                  }

                  if (name === "annual") {
                    return (
                      c.recurrence_rule?.includes("FREQ=YEARLY") &&
                      (c.type === "fixed" || c.type === "per_unit")
                    );
                  }

                  return false;
                });
                if (comp) return comp;
              }
              return undefined;
            };

            const monthlyComp = findComponent("monthly");
            const annualComp = findComponent("annual");

            // Monthly evaluation
            if (input.monthlyPrice !== undefined) {
              if (
                !monthlyComp ||
                (monthlyComp as any).amount_cents !== input.monthlyPrice
              ) {
                hasPriceChanges = true;
              }
            }

            // Yearly evaluation
            if (input.hasYearlyPrice === true) {
              if (!annualComp) {
                hasPriceChanges = true;
              } else if (
                input.yearlyPrice !== undefined &&
                (annualComp as any).amount_cents !== input.yearlyPrice * 12
              ) {
                hasPriceChanges = true;
              }
            } else if (input.hasYearlyPrice === false && annualComp) {
              hasPriceChanges = true; // yearly component exists but merchant removed it
            }
          }

          // Check for feature changes using deep comparison
          let hasFeatureChanges = false;
          if (input.features && input.features.length > 0) {
            // Load current features
            const currentFeatures = await db.query.planFeatures.findMany({
              where: and(
                eq(planFeatures.planId, planId),
                isNull(planFeatures.deletedAt)
              ),
              with: {
                feature: true,
              },
            });

            const currentFeatureMap = new Map(
              currentFeatures.map((pf) => [pf.feature.slug, pf.feature])
            );

            // Check for additions, removals, or modifications
            const inputSlugs = input.features.map((f) => f.slug);
            const currentSlugs = currentFeatures.map((pf) => pf.feature.slug);

            // Different number of features = change
            if (inputSlugs.length !== currentSlugs.length) {
              hasFeatureChanges = true;
            } else {
              // Check if any slug is different or any feature properties changed
              for (const inputFeature of input.features) {
                const existing = currentFeatureMap.get(inputFeature.slug);
                if (!existing) {
                  hasFeatureChanges = true;
                  break;
                }

                // Use deep structural comparison (but names can change for metadata-only)
                const structurallyEqual = await areStructurallyEqual(
                  existing,
                  inputFeature
                );
                if (!structurallyEqual) {
                  hasFeatureChanges = true;
                  break;
                }
              }
            }
          }

          // It's metadata-only if there are actual metadata changes but no price/feature changes
          const hasMetadataChanges =
            hasNameChange ||
            hasDescriptionChange ||
            hasEnterpriseButtonChange ||
            hasEnterpriseUrlChange;
          return hasMetadataChanges && !hasPriceChanges && !hasFeatureChanges;
        };

        // Helper to get all related data for a feature
        const getFeatureHelpers = async (slug: string, featureId: string) => {
          // Get metric data
          const metric = await db.query.featureMetrics.findFirst({
            where: and(
              eq(featureMetrics.featureId, featureId),
              eq(featureMetrics.merchantId, merchantId)
            ),
            with: {
              metric: true,
            },
          });

          // Get usage pricing from current prices (passed from parent scope)
          let unitCostCents: number | undefined;
          const planWithPrices = await db.query.plans.findFirst({
            where: eq(plans.id, planId),
            with: {
              prices: {
                where: isNull(prices.deletedAt),
                orderBy: desc(prices.createdAt),
              },
            },
          });

          if (planWithPrices?.prices) {
            for (const price of planWithPrices.prices) {
              const component = price.pricingData?.components?.find(
                (c: any) =>
                  c.component_name === `usage_${slug}` && c.type === "usage"
              );
              if (component) {
                unitCostCents = (component as any).unit_cost_cents;
                break;
              }
            }
          }

          // Get credit definition
          const creditDef = await db.query.creditDefinitions.findFirst({
            where: and(
              eq(creditDefinitions.featureId, featureId),
              eq(creditDefinitions.merchantId, merchantId),
              eq(creditDefinitions.scope, "plan"),
              eq(creditDefinitions.planId, planId),
              isNull(creditDefinitions.deletedAt)
            ),
          });

          // Determine renewal rule for credit definitions
          let renewalRule: "none" | "monthly" | "yearly" = "none";

          if (creditDef) {
            if (creditDef.refillRrule) {
              // Explicit RRULE on the credit definition
              if (creditDef.refillRrule.includes("YEARLY")) {
                renewalRule = "yearly";
              } else if (creditDef.refillRrule.includes("MONTHLY")) {
                renewalRule = "monthly";
              }
            } else if (creditDef.renewOnBilling && creditDef.priceComponentId) {
              // Billing-cycle renewal – look up the linked price component to infer period
              if (planWithPrices?.prices) {
                outer: for (const priceRec of planWithPrices.prices) {
                  const comp = priceRec.pricingData?.components?.find(
                    (c: any) => c.component_id === creditDef.priceComponentId
                  );
                  if (comp && typeof comp.recurrence_rule === "string") {
                    if (comp.recurrence_rule.includes("YEARLY")) {
                      renewalRule = "yearly";
                    } else if (comp.recurrence_rule.includes("MONTHLY")) {
                      renewalRule = "monthly";
                    }
                    break outer;
                  }
                }
              }
            }
          }

          return {
            metricEventName: metric?.metric?.eventName,
            unitCostCents,
            creditDef,
            defaultAmount: creditDef?.defaultAmount || 0,
            renewalRule,
          };
        };

        // Helper to check if features are structurally identical
        const areStructurallyEqual = async (existing: any, incoming: any) => {
          // Check if usage-based flag matches
          const wasUsage =
            existing.featureType === "number" &&
            existing.featureValue === "usage_based";
          if (Boolean(incoming.isUsageBased) !== wasUsage) return false;

          // Get all the current data for this feature
          const helpers = await getFeatureHelpers(existing.slug, existing.id);

          // Compare event name (only relevant for usage-based)
          if (incoming.eventName !== undefined) {
            const expectedEventName = wasUsage
              ? helpers.metricEventName || ""
              : "";
            if (incoming.eventName !== expectedEventName) return false;
          }

          // Compare usage price per unit
          if (incoming.usagePricePerUnit !== undefined) {
            const expectedPrice = helpers.unitCostCents || 0;
            if (incoming.usagePricePerUnit !== expectedPrice) return false;
          }

          // Compare credit allowance flag
          const hadAllowance = helpers.creditDef !== undefined;
          if (incoming.hasCreditAllowance !== undefined) {
            if (Boolean(incoming.hasCreditAllowance) !== hadAllowance)
              return false;
          }

          // Compare credit allowance amount
          if (incoming.creditAllowanceAmount !== undefined) {
            if (incoming.creditAllowanceAmount !== helpers.defaultAmount)
              return false;
          }

          // Compare credit renewal rule
          if (incoming.creditAllowanceRenewal !== undefined) {
            if (incoming.creditAllowanceRenewal !== helpers.renewalRule)
              return false;
          }

          return true; // No structural differences found
        };

        // Helper function to detect feature rename-only edits
        const isFeatureRenameOnlyEdit = async (
          input: typeof editInput
        ): Promise<boolean> => {
          if (!input.features || input.features.length === 0) return false;

          // Load current features for the plan
          const currentFeatures = await db.query.planFeatures.findMany({
            where: and(
              eq(planFeatures.planId, planId),
              isNull(planFeatures.deletedAt)
            ),
            with: {
              feature: true,
            },
          });

          const currentFeatureMap = new Map(
            currentFeatures.map((pf) => [pf.feature.slug, pf.feature])
          );

          // Fast checks – ensure no feature removals or additions
          const inputSlugs = input.features.map((f) => f.slug);
          const currentSlugs = currentFeatures.map((pf) => pf.feature.slug);

          // If any new slug is introduced OR any existing slug is missing we are not rename-only
          const slugSetEqual =
            inputSlugs.length === currentSlugs.length &&
            inputSlugs.every((s) => currentSlugs.includes(s));
          if (!slugSetEqual) return false;

          // Check every feature for structural equality
          let hasDisplayNameChanges = false;
          for (const inputFeat of input.features) {
            const existing = currentFeatureMap.get(inputFeat.slug);
            if (!existing) return false; // defensive

            // Check if structurally identical
            const structurallyEqual = await areStructurallyEqual(
              existing,
              inputFeat
            );
            if (!structurallyEqual) return false;

            // Check if display name changed
            if (existing.displayName !== inputFeat.featureName) {
              hasDisplayNameChanges = true;
            }
          }

          // It's rename-only if we have display name changes but no structural changes
          return hasDisplayNameChanges;
        };

        // Decide strategy based on change type and subscription count
        const isMetadataOnly = await isMetadataOnlyEdit(editInput);
        const isRenameOnly = await isFeatureRenameOnlyEdit(editInput);
        const shouldEditInPlace =
          activeSubCount === 0 || isMetadataOnly || isRenameOnly;

        console.log(
          "activeSubCount",
          activeSubCount,
          "isMetadataOnly",
          isMetadataOnly,
          "isRenameOnly",
          isRenameOnly,
          "shouldEditInPlace",
          shouldEditInPlace
        );

        const result = shouldEditInPlace
          ? await editPlanInPlace(planId, merchantId, editInput)
          : await editPlan(planId, merchantId, editInput);

        if ("error" in result) {
          return c.json({ error: result.error }, 400);
        }

        return c.json(result);
      } catch (error) {
        console.error("Error editing plan:", error);
        return c.json(
          {
            error: "Failed to edit plan",
          },
          500
        );
      }
    }
  )
  // Delete a plan (soft delete)
  .delete("/:id", async (c) => {
    const merchantId = c.get("merchant")!.id;
    const planId = c.req.param("id");
    if (!planId) {
      return c.json({ error: "No plan ID found in URL" }, 400);
    }

    const existingPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.id, planId),
        eq(plans.merchantId, merchantId),
        isNull(plans.deletedAt)
      ),
    });

    if (!existingPlan) {
      return c.json({ error: "Plan not found or access denied" }, 404);
    }

    // Note: We allow deletion even if there are incoming scheduled migrations.
    // These migrations will be cancelled automatically inside the transaction below.

    try {
      const currentTimestamp = new Date();

      // Use a transaction to ensure plan, features, and pricing table associations are deleted atomically
      await db.transaction(async (tx) => {
        // Soft delete the plan
        await tx
          .update(plans)
          .set({ deletedAt: currentTimestamp })
          .where(eq(plans.id, planId));

        // Soft delete all associated plan features
        await tx
          .update(planFeatures)
          .set({ deletedAt: currentTimestamp })
          .where(
            and(eq(planFeatures.planId, planId), isNull(planFeatures.deletedAt))
          );

        // Update pricing table plans to point to previous version, or remove if none exists
        const pricingTableAssociations =
          await tx.query.pricingTablePlans.findMany({
            where: and(
              eq(pricingTablePlans.planId, planId),
              isNull(pricingTablePlans.deletedAt)
            ),
          });

        if (pricingTableAssociations.length > 0) {
          // Find the previous version of this plan (same stablePlanId, highest version < current)
          const previousPlanVersion = await tx.query.plans.findFirst({
            where: and(
              eq(plans.stablePlanId, existingPlan.stablePlanId),
              eq(plans.merchantId, merchantId),
              lt(plans.versionNumber, existingPlan.versionNumber),
              isNull(plans.deletedAt)
            ),
            orderBy: desc(plans.versionNumber),
          });

          if (previousPlanVersion) {
            // Update pricing table entries to point to the previous version
            await tx
              .update(pricingTablePlans)
              .set({
                planId: previousPlanVersion.id,
                updatedAt: currentTimestamp,
              })
              .where(
                and(
                  eq(pricingTablePlans.planId, planId),
                  isNull(pricingTablePlans.deletedAt)
                )
              );
          } else {
            // No previous version exists, remove from pricing tables entirely
            await tx
              .update(pricingTablePlans)
              .set({ deletedAt: currentTimestamp })
              .where(
                and(
                  eq(pricingTablePlans.planId, planId),
                  isNull(pricingTablePlans.deletedAt)
                )
              );
          }
        }

        // Handle scheduled migrations that reference this deleted plan
        const scheduledChanges =
          await tx.query.subscriptionsScheduledChanges.findMany({
            where: and(
              eq(subscriptionsScheduledChanges.newPlanId, planId),
              isNull(subscriptionsScheduledChanges.processedAt) // Only unprocessed changes
            ),
          });

        if (scheduledChanges.length > 0) {
          // Cancel all incoming migrations by marking them processed.
          await tx
            .update(subscriptionsScheduledChanges)
            .set({ processedAt: currentTimestamp })
            .where(
              and(
                eq(subscriptionsScheduledChanges.newPlanId, planId),
                isNull(subscriptionsScheduledChanges.processedAt)
              )
            );
        }
      });
      return c.json({
        success: true,
        message:
          "Plan and associated features and pricing table associations deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting plan:", error);
      return c.json({ error: "Failed to delete plan" }, 500);
    }
  })
  // Toggle plan visibility in pricing table
  .post(
    "/:id/toggle-pricing-table-visibility",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("json", z.object({ isVisible: z.boolean() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const planId = c.req.valid("param").id;
      const { isVisible } = c.req.valid("json");

      if (!planId) {
        return c.json({ error: "No plan ID found in URL" }, 400);
      }

      // Verify the plan exists and belongs to this merchant
      const existingPlan = await db.query.plans.findFirst({
        where: and(
          eq(plans.id, planId),
          eq(plans.merchantId, merchantId),
          isNull(plans.deletedAt)
        ),
      });

      if (!existingPlan) {
        return c.json({ error: "Plan not found or access denied" }, 404);
      }

      try {
        if (isVisible) {
          // Add to first pricing table
          const existingPricingTables = await db.query.pricingTables.findMany({
            where: and(
              eq(pricingTables.merchantId, merchantId),
              isNull(pricingTables.deletedAt)
            ),
            with: {
              pricingTablePlans: {
                where: isNull(pricingTablePlans.deletedAt),
              },
            },
          });

          let pricingTableId: string;

          if (!existingPricingTables || existingPricingTables.length === 0) {
            // Create a new pricing table
            const [newPricingTable] = await db
              .insert(pricingTables)
              .values({
                merchantId,
                name: "Default Pricing Table",
                slug: `pricing-table-${Date.now()}`,
                description: "Automatically generated pricing table",
                heading: "Choose Your Plan",
                subheading: "Select the perfect plan for your needs",
                isActive: true,
              })
              .returning();

            pricingTableId = newPricingTable.id;
          } else {
            // Use first existing pricing table
            pricingTableId = existingPricingTables[0].id;
          }

          // Check if plan is already in the pricing table
          const existingAssociation =
            await db.query.pricingTablePlans.findFirst({
              where: and(
                eq(pricingTablePlans.pricingTableId, pricingTableId),
                eq(pricingTablePlans.planId, planId),
                eq(pricingTablePlans.merchantId, merchantId),
                isNull(pricingTablePlans.deletedAt)
              ),
            });

          if (!existingAssociation) {
            // Get current plan count for display order
            const currentPlansCount =
              existingPricingTables.length > 0
                ? existingPricingTables[0].pricingTablePlans.length
                : 0;

            // Get credit allowances for this plan if any exist
            const creditDefinitionsForPlan =
              await db.query.creditDefinitions.findMany({
                where: and(
                  eq(creditDefinitions.merchantId, merchantId),
                  eq(creditDefinitions.scope, "plan"),
                  eq(creditDefinitions.planId, planId),
                  eq(creditDefinitions.applicationType, "usage"),
                  isNull(creditDefinitions.deletedAt)
                ),
                with: {
                  feature: true,
                },
              });

            // Add the plan to the pricing table
            await db.insert(pricingTablePlans).values({
              pricingTableId,
              planId,
              merchantId,
              displayOrder: currentPlansCount + 1,
              isPopular: false,
              popularText: "Popular",
              buttonText: "Get Started",
              buttonOutline: false,
            });
          }
        } else {
          // Remove from pricing table
          const pricingTablesWithPlans = await db.query.pricingTables.findMany({
            where: and(
              eq(pricingTables.merchantId, merchantId),
              isNull(pricingTables.deletedAt)
            ),
            with: {
              pricingTablePlans: {
                where: and(
                  isNull(pricingTablePlans.deletedAt),
                  eq(pricingTablePlans.planId, planId)
                ),
              },
            },
          });

          // Find and remove the plan association
          for (const table of pricingTablesWithPlans) {
            for (const planAssociation of table.pricingTablePlans) {
              await db
                .delete(pricingTablePlans)
                .where(eq(pricingTablePlans.id, planAssociation.id));
            }
          }
        }

        // Return updated plan data
        const updatedPlan = await getPlanById(planId, merchantId, true);

        if ("error" in updatedPlan) {
          return c.json(updatedPlan, 404);
        }

        return c.json({
          success: true,
          message: isVisible
            ? "Plan added to pricing table successfully"
            : "Plan removed from pricing table successfully",
          plan: updatedPlan.plans[0],
        });
      } catch (error) {
        console.error("Error toggling pricing table visibility:", error);
        return c.json(
          {
            error: isVisible
              ? "Failed to add plan to pricing table"
              : "Failed to remove plan from pricing table",
          },
          500
        );
      }
    }
  )
  // Migrate subscribers from a specific plan version to another specific version
  .post(
    "/:stablePlanId/migrate",
    zValidator("param", z.object({ stablePlanId: z.string() })),
    zValidator(
      "json",
      z.object({
        strategy: z.enum(["immediate", "next_billing_cycle"]),
        fromVersion: z.number().int().positive(),
        toVersion: z.number().int().positive(),
        priceMapping: z.record(z.string(), z.string()),
      })
    ),
    async (c) => {
      // Standardized response types
      type ErrorResponse = { error: string };
      type SuccessResponse = {
        success: true;
        message: string;
        migratedCount?: number;
        scheduledCount?: number;
        totalSubscriptions?: number;
        jobQueued?: boolean;
        errors?: string[];
      };

      const merchantId = c.get("merchant")!.id;
      const { stablePlanId } = c.req.valid("param");
      const { strategy, fromVersion, toVersion, priceMapping } =
        c.req.valid("json");

      try {
        // Validate that fromVersion and toVersion are different
        if (fromVersion >= toVersion) {
          return c.json<ErrorResponse>(
            {
              error: "fromVersion must be less than toVersion",
            },
            400
          );
        }

        // 1. Get the specific source and target plan versions
        const allPlanVersions = await db.query.plans.findMany({
          where: and(
            eq(plans.stablePlanId, stablePlanId),
            eq(plans.merchantId, merchantId),
            isNull(plans.deletedAt)
          ),
          with: {
            prices: {
              where: isNull(prices.deletedAt),
              orderBy: desc(prices.createdAt),
            },
            planFeatures: {
              where: isNull(planFeatures.deletedAt),
              with: {
                feature: true,
              },
            },
          },
        });

        if (allPlanVersions.length === 0) {
          return c.json<ErrorResponse>({ error: "Plan not found" }, 404);
        }

        // Find the specific source and target versions
        const sourcePlan = allPlanVersions.find(
          (p) => p.versionNumber === fromVersion
        );
        const targetPlan = allPlanVersions.find(
          (p) => p.versionNumber === toVersion
        );

        if (!sourcePlan) {
          return c.json<ErrorResponse>(
            {
              error: `Source plan version ${fromVersion} not found`,
            },
            404
          );
        }

        if (!targetPlan) {
          return c.json<ErrorResponse>(
            {
              error: `Target plan version ${toVersion} not found`,
            },
            404
          );
        }

        // 2. Get all active subscriptions on the source plan version
        const subscriptionsToMigrate = await db.query.subscriptions.findMany({
          where: and(
            eq(subscriptions.planId, sourcePlan.id),
            eq(subscriptions.merchantId, merchantId),
            isNull(subscriptions.deletedAt),
            isNull(subscriptions.endTimestamp)
          ),
        });

        if (subscriptionsToMigrate.length === 0) {
          return c.json<SuccessResponse>({
            success: true,
            message: `No active subscriptions found on plan version ${fromVersion}`,
          });
        }

        // 3. Validate strategy against plan changes
        if (targetPlan.prices.length === 0) {
          return c.json<ErrorResponse>(
            {
              error: `Target plan version ${toVersion} has no pricing configured`,
            },
            400
          );
        }

        // Create maps for quick price lookup
        const sourcePriceMap = new Map(sourcePlan.prices.map((p) => [p.id, p]));
        const targetPriceMap = new Map(targetPlan.prices.map((p) => [p.id, p]));

        // Validate price mapping
        const invalidSourcePrices: string[] = [];
        const invalidTargetPrices: string[] = [];

        for (const [sourcePriceId, targetPriceId] of Object.entries(
          priceMapping
        )) {
          // Check if source price exists in source plan
          if (!sourcePriceMap.has(sourcePriceId)) {
            invalidSourcePrices.push(sourcePriceId);
          }

          // Check if target price exists in target plan
          if (!targetPriceMap.has(targetPriceId)) {
            invalidTargetPrices.push(targetPriceId);
          }
        }

        if (invalidSourcePrices.length > 0) {
          return c.json<ErrorResponse>(
            {
              error: `Source price IDs not found in version ${fromVersion}: ${invalidSourcePrices.join(", ")}`,
            },
            400
          );
        }

        if (invalidTargetPrices.length > 0) {
          return c.json<ErrorResponse>(
            {
              error: `Target price IDs not found in version ${toVersion}: ${invalidTargetPrices.join(", ")}`,
            },
            400
          );
        }

        // Validate that all source plan prices have a mapping
        const unmappedSourcePrices: string[] = [];
        for (const sourcePrice of sourcePlan.prices) {
          if (!priceMapping[sourcePrice.id]) {
            unmappedSourcePrices.push(sourcePrice.id);
          }
        }

        if (unmappedSourcePrices.length > 0) {
          return c.json<ErrorResponse>(
            {
              error: `Missing price mappings for source price IDs: ${unmappedSourcePrices.join(", ")}. All source prices must be mapped.`,
            },
            400
          );
        }

        // Check if immediate migration is allowed for price changes
        if (strategy === "immediate") {
          // For immediate migration, we need to ensure no price changes exist
          // Compare each mapped price pair
          let hasPriceChanges = false;
          const priceChanges: string[] = [];

          for (const [sourcePriceId, targetPriceId] of Object.entries(
            priceMapping
          )) {
            const sourcePrice = sourcePriceMap.get(sourcePriceId)!;
            const targetPrice = targetPriceMap.get(targetPriceId)!;

            // Compare total amounts for this price pair
            const sourceAmount =
              sourcePrice.pricingData?.components?.reduce(
                (total: number, comp: any) => total + (comp.amount_cents || 0),
                0
              ) || 0;
            const targetAmount =
              targetPrice.pricingData?.components?.reduce(
                (total: number, comp: any) => total + (comp.amount_cents || 0),
                0
              ) || 0;

            if (sourceAmount !== targetAmount) {
              hasPriceChanges = true;
              priceChanges.push(
                `${sourcePriceId}: $${sourceAmount / 100} → $${targetAmount / 100}`
              );
            }
          }

          if (hasPriceChanges) {
            return c.json<ErrorResponse>(
              {
                error:
                  `Immediate migration not allowed when price changes are detected: ${priceChanges.join(", ")}.` +
                  `Use 'next_billing_cycle' strategy instead.`,
              },
              400
            );
          }
        }

        // Helper function to get target price for a subscription
        const getTargetPriceForSubscription = (
          subscription: typeof subscriptions.$inferSelect
        ) => {
          // Look up the mapped target price using the subscription's current price ID
          const targetPriceId = priceMapping[subscription.effectivePriceId];

          if (!targetPriceId) {
            throw new Error(
              `No price mapping found for current price ${subscription.effectivePriceId} of subscription ${subscription.stableSubscriptionId}`
            );
          }

          // Get the target price from our map
          const targetPrice = targetPriceMap.get(targetPriceId);
          if (!targetPrice) {
            throw new Error(
              `Target price ${targetPriceId} not found in target plan version ${toVersion}`
            );
          }

          return targetPrice;
        };

        // 4. Handle migration based on strategy
        if (strategy === "immediate") {
          // For small cohorts, process immediately
          if (subscriptionsToMigrate.length <= 10) {
            let migratedCount = 0;
            const errors: string[] = [];

            for (const subscription of subscriptionsToMigrate) {
              try {
                const targetPrice =
                  await getTargetPriceForSubscription(subscription);

                await migrateSubscription({
                  oldSubscription: subscription,
                  targetPlan: targetPlan,
                  targetPrice: targetPrice,
                  merchantId,
                });
                migratedCount++;
              } catch (error) {
                console.error(
                  `Error migrating subscription ${subscription.id}:`,
                  error
                );
                errors.push(
                  `Failed to migrate subscription ${subscription.stableSubscriptionId}: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }

            return c.json<SuccessResponse>({
              success: true,
              message: `Successfully migrated ${migratedCount} of ${subscriptionsToMigrate.length} subscriptions from version ${fromVersion} to version ${toVersion}`,
              migratedCount,
              errors: errors.length > 0 ? errors : undefined,
            });
          } else {
            // For larger cohorts, process via Trigger.dev batch job
            try {
              // Prepare payloads with resolved target price IDs
              const payloads = [];
              const errors: string[] = [];

              for (const sub of subscriptionsToMigrate) {
                try {
                  const targetPrice = getTargetPriceForSubscription(sub);
                  payloads.push({
                    payload: {
                      subscriptionId: sub.id,
                      targetPlanId: targetPlan.id,
                      targetPriceId: targetPrice.id,
                      strategy,
                      merchantId,
                    },
                  });
                } catch (error) {
                  errors.push(
                    `Failed to resolve price for subscription ${sub.stableSubscriptionId}: ${error instanceof Error ? error.message : String(error)}`
                  );
                }
              }

              if (errors.length > 0) {
                return c.json<ErrorResponse>(
                  {
                    error: `Failed to prepare migration jobs: ${errors.join(", ")}`,
                  },
                  400
                );
              }

              // Trigger runs in chunks of 500 to respect Trigger.dev limits
              const BATCH_LIMIT = 500;
              for (let i = 0; i < payloads.length; i += BATCH_LIMIT) {
                const slice = payloads.slice(i, i + BATCH_LIMIT);
                await tasks.batchTrigger("subscription-plan-migration", slice);
              }

              return c.json<SuccessResponse>({
                success: true,
                message: `Queued migration for ${payloads.length} subscriptions using Trigger.dev`,
                totalSubscriptions: payloads.length,
                jobQueued: true,
              });
            } catch (error) {
              console.error(
                "Failed to queue subscription migration jobs:",
                error
              );
              return c.json<ErrorResponse>(
                {
                  error: "Failed to queue subscription migration jobs",
                },
                500
              );
            }
          }
        } else {
          // next_billing_cycle strategy
          // Create scheduled changes for each subscription with proper price mapping
          const scheduledChanges = [];
          const errors: string[] = [];

          for (const subscription of subscriptionsToMigrate) {
            try {
              const targetPrice =
                await getTargetPriceForSubscription(subscription);

              scheduledChanges.push({
                subscriptionId: subscription.id,
                effectiveOnNextBilling: true,
                // Don't set effectiveDate - we check effectiveOnNextBilling during billing
                newPlanId: targetPlan.id,
                newPriceId: targetPrice.id,
                newVersionNumber: targetPlan.versionNumber.toString(),
              });
            } catch (error) {
              errors.push(
                `Failed to map price for subscription ${subscription.stableSubscriptionId}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }

          if (errors.length > 0) {
            return c.json<ErrorResponse>(
              {
                error: `Failed to create scheduled changes: ${errors.join(", ")}`,
              },
              400
            );
          }

          await db
            .insert(subscriptionsScheduledChanges)
            .values(scheduledChanges);

          return c.json<SuccessResponse>({
            success: true,
            message: `Scheduled migration for ${scheduledChanges.length} subscriptions from version ${fromVersion} to version ${toVersion} at next billing cycle`,
            scheduledCount: scheduledChanges.length,
          });
        }
      } catch (error) {
        console.error("Error during plan migration:", error);
        return c.json<ErrorResponse>(
          {
            error: "Failed to process plan migration",
          },
          500
        );
      }
    }
  )
  // New: compare two plan versions and return change analysis
  .get(
    "/:stablePlanId/compare",
    zValidator("param", z.object({ stablePlanId: z.string() })),
    zValidator(
      "query",
      z.object({
        fromVersion: z.string(),
        toVersion: z.string(),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { stablePlanId } = c.req.valid("param");
      const { fromVersion, toVersion } = c.req.valid("query");

      const fromVer = Number(fromVersion);
      const toVer = Number(toVersion);
      if (
        Number.isNaN(fromVer) ||
        Number.isNaN(toVer) ||
        fromVer <= 0 ||
        toVer <= 0
      ) {
        return c.json(
          { error: "fromVersion and toVersion must be positive integers" },
          400
        );
      }
      if (fromVer >= toVer) {
        return c.json(
          { error: "fromVersion must be less than toVersion" },
          400
        );
      }
      // Load the two plan versions with features & prices
      const versions = await db.query.plans.findMany({
        where: and(
          eq(plans.stablePlanId, stablePlanId),
          eq(plans.merchantId, merchantId),
          inArray(plans.versionNumber, [fromVer, toVer]),
          isNull(plans.deletedAt)
        ),
        with: {
          planFeatures: {
            where: isNull(planFeatures.deletedAt),
            with: { feature: true },
          },
          prices: {
            where: isNull(prices.deletedAt),
          },
        },
      });

      const oldPlan = versions.find((p) => p.versionNumber === fromVer);
      const newPlan = versions.find((p) => p.versionNumber === toVer);

      if (!oldPlan || !newPlan) {
        return c.json({ error: "One or both plan versions not found" }, 404);
      }

      // Build plain objects expected by analyzePlanChange
      const oldPlanObj = {
        ...oldPlan,
        features: oldPlan.planFeatures.map((pf) => pf.feature),
        prices: oldPlan.prices,
      } as any;
      const newPlanObj = {
        ...newPlan,
        features: newPlan.planFeatures.map((pf) => pf.feature),
        prices: newPlan.prices,
      } as any;

      // ------------------------------------------------------------
      // Detect credit allowance changes (numeric feature changes)
      // ------------------------------------------------------------
      const [oldCredits, newCredits] = await Promise.all([
        db.query.creditDefinitions.findMany({
          where: and(
            eq(creditDefinitions.planId, oldPlan.id),
            isNull(creditDefinitions.deletedAt)
          ),
        }),
        db.query.creditDefinitions.findMany({
          where: and(
            eq(creditDefinitions.planId, newPlan.id),
            isNull(creditDefinitions.deletedAt)
          ),
        }),
      ]);

      const buildCreditMap = (
        list: (typeof creditDefinitions.$inferSelect)[]
      ): Map<string, { amount: number; refill: string | null }> => {
        const m = new Map<string, { amount: number; refill: string | null }>();
        list.forEach((cd) => {
          const key = (cd.featureSlug ?? cd.featureId) as string;
          m.set(key, { amount: cd.defaultAmount, refill: cd.refillRrule });
        });
        return m;
      };

      const oldCreditMap = buildCreditMap(oldCredits);
      const newCreditMap = buildCreditMap(newCredits);

      let creditDifferencesDetected = false;
      // Compare union of keys
      const allKeys = new Set<string>([
        ...Array.from(oldCreditMap.keys()),
        ...Array.from(newCreditMap.keys()),
      ]);
      for (const k of allKeys) {
        const oldVal = oldCreditMap.get(k);
        const newVal = newCreditMap.get(k);
        if (!oldVal || !newVal) {
          creditDifferencesDetected = true;
          break;
        }
        if (
          oldVal.amount !== newVal.amount ||
          oldVal.refill !== newVal.refill
        ) {
          creditDifferencesDetected = true;
          break;
        }
      }

      const analysis = analyzePlanChange(oldPlanObj, newPlanObj);

      // If credit allowance changes exist, mark numeric feature changes true
      if (creditDifferencesDetected) {
        analysis.hasNumericFeatureChanges = true;
      }

      // Determine recommended strategy similar to UI logic
      let recommendedStrategy:
        | "immediate"
        | "next_billing_cycle"
        | "edit_in_place";
      if (analysis.hasPriceChanges) {
        recommendedStrategy = "next_billing_cycle";
      } else if (
        analysis.hasFeatureChanges ||
        analysis.hasNumericFeatureChanges
      ) {
        recommendedStrategy = "immediate";
      } else {
        recommendedStrategy = "edit_in_place";
      }

      return c.json({
        migrationAnalysis: {
          ...analysis,
          recommendedStrategy,
        },
      });
    }
  )
  // Get scheduled migrations for a plan version
  .get(
    "/:planId/scheduled-migrations",
    zValidator("param", z.object({ planId: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { planId } = c.req.valid("param");

      try {
        // Get subscriptions on this specific plan version
        const planSubscriptions = await db.query.subscriptions.findMany({
          where: and(
            eq(subscriptions.planId, planId),
            eq(subscriptions.merchantId, merchantId),
            isNull(subscriptions.deletedAt),
            isNull(subscriptions.endTimestamp)
          ),
        });

        if (planSubscriptions.length === 0) {
          return c.json({ scheduledMigrations: [] });
        }

        const subscriptionIds = planSubscriptions.map((sub) => sub.id);

        // Get scheduled migrations for these subscriptions
        const scheduledChanges =
          await db.query.subscriptionsScheduledChanges.findMany({
            where: and(
              inArray(
                subscriptionsScheduledChanges.subscriptionId,
                subscriptionIds
              ),
              isNull(subscriptionsScheduledChanges.processedAt) // Only unprocessed changes
            ),
            with: {
              subscription: {
                with: {
                  customer: true,
                },
              },
              newPlan: true,
            },
          });

        return c.json({ scheduledMigrations: scheduledChanges });
      } catch (error) {
        console.error("Error fetching scheduled migrations:", error);
        return c.json({ error: "Failed to fetch scheduled migrations" }, 500);
      }
    }
  )
  // Get incoming scheduled migrations for a plan version (subscriptions migrating TO this plan)
  .get(
    "/:planId/incoming-migrations",
    zValidator("param", z.object({ planId: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { planId } = c.req.valid("param");

      try {
        // Get scheduled migrations targeting this specific plan version
        const incomingMigrations =
          await db.query.subscriptionsScheduledChanges.findMany({
            where: and(
              eq(subscriptionsScheduledChanges.newPlanId, planId),
              isNull(subscriptionsScheduledChanges.processedAt) // Only unprocessed changes
            ),
            with: {
              subscription: {
                with: {
                  customer: true,
                  plan: true, // Include the source plan info
                },
              },
              newPlan: true,
            },
          });

        // Filter out any results where subscription is null or doesn't belong to this merchant
        const validIncomingMigrations = incomingMigrations.filter(
          (migration) =>
            migration.subscription !== null &&
            migration.subscription.merchantId === merchantId
        );

        return c.json({ incomingMigrations: validIncomingMigrations });
      } catch (error) {
        console.error("Error fetching incoming migrations:", error);
        return c.json({ error: "Failed to fetch incoming migrations" }, 500);
      }
    }
  );
