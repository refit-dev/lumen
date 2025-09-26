import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  features,
  merchants,
  metrics,
  planFeatures,
  prices,
  plans,
  subscriptions,
  pricingTablePlans,
  planEnrollmentRules,
  featureMetrics,
  creditDefinitions,
  creditDefinitionsInsertSchema,
} from "@lumen/common/schema";
import { formatCurrency } from "@lumen/common/utils";
import { db } from "../db/client";
import { createPrice, generateComponentId } from "./billing";
import { createCreditDefinition } from "./credits";
import {
  DatabaseType,
  TransactionType,
  Plan,
  Price,
  Feature,
  getPlanFeatures,
  PlanWithFeatures,
  attachFeaturesToPlan,
  transformPlansWithFeatures,
  PlanWithPlanFeature,
} from ".";
import { z } from "zod";
import { ID_PREFIXES, createPrefixedId } from "@lumen/common";

/**
 * Counts active subscriptions for a plan (all versions of the plan)
 */
export async function getActiveSubscriptionCountForPlan(
  stablePlanId: string,
  merchantId: string,
  dbInstance: DatabaseType = db
): Promise<number> {
  const allPlanVersions = await dbInstance.query.plans.findMany({
    where: and(
      eq(plans.stablePlanId, stablePlanId),
      eq(plans.merchantId, merchantId),
      isNull(plans.deletedAt)
    ),
  });

  if (allPlanVersions.length === 0) return 0;

  const planIds = allPlanVersions.map((p) => p.id);

  const activeSubscriptions = await dbInstance.query.subscriptions.findMany({
    where: and(
      inArray(subscriptions.planId, planIds),
      eq(subscriptions.merchantId, merchantId),
      isNull(subscriptions.deletedAt),
      isNull(subscriptions.endTimestamp),
      inArray(subscriptions.status, ["active", "trialing", "past_due"])
    ),
  });

  return activeSubscriptions.length;
}

/**
 * Checks if a plan change requires specific migration strategy
 */
export function analyzePlanChange(
  oldPlan: Plan & { features: Feature[]; prices: Price[] },
  newPlan: Plan & { features: Feature[]; prices: Price[] }
): {
  hasFeatureChanges: boolean;
  hasPriceChanges: boolean;
  hasNumericFeatureChanges: boolean;
  canUseImmediate: boolean;
} {
  // Check for price changes
  const oldPriceAmount =
    oldPlan.prices[0]?.pricingData?.components?.reduce(
      (total: number, comp: any) => total + (comp.amount_cents || 0),
      0
    ) || 0;
  const newPriceAmount =
    newPlan.prices[0]?.pricingData?.components?.reduce(
      (total: number, comp: any) => total + (comp.amount_cents || 0),
      0
    ) || 0;

  const hasPriceChanges = oldPriceAmount !== newPriceAmount;

  // Check for feature changes
  const oldFeatureSlugs = new Set(oldPlan.features.map((f) => f.slug));
  const newFeatureSlugs = new Set(newPlan.features.map((f) => f.slug));
  const hasFeatureChanges =
    oldFeatureSlugs.size !== newFeatureSlugs.size ||
    ![...oldFeatureSlugs].every((slug) => newFeatureSlugs.has(slug));

  // Check for numeric feature changes (usage/credit related)
  const hasNumericFeatureChanges = newPlan.features.some(
    (feature) => typeof feature.featureValue === "number"
  );

  const canUseImmediate = !hasPriceChanges;

  return {
    hasFeatureChanges,
    hasPriceChanges,
    hasNumericFeatureChanges,
    canUseImmediate,
  };
}

/**
 * Types and interfaces for plan editing
 */
export interface EditPlanFeature {
  featureName: string;
  slug: string;
  eventName?: string;
  isUsageBased: boolean;
  usagePricePerUnit?: number;
  hasCreditAllowance?: boolean;
  creditAllowanceAmount?: number;
  creditAllowanceRenewal?: "monthly" | "yearly" | "none";
  existingFeatureId?: string;
}

export interface EditPlanInput {
  planName?: string;
  planDescription?: string;
  features?: EditPlanFeature[];
  currency?: string;
  monthlyPrice?: number;
  yearlyPrice?: number;
  hasYearlyPrice?: boolean;
  // Seat-based pricing
  isSeatBased?: boolean;
  minSeats?: number;
  billImmediately?: boolean;
  isEnterprisePlan?: boolean;
  enterpriseButtonText?: string;
  enterpriseRedirectUrl?: string;
  showInPricingTable?: boolean;
  // Trial configuration
  trial?:
    | {
        enabled: true;
        days: number;
        creditOverrides?: Array<{
          featureSlug: string;
          allowance: number;
        }>;
      }
    | {
        enabled: false;
      };
}

// Helper type for enabled trial configuration
type EnabledTrialConfig = {
  enabled: true;
  days: number;
  creditOverrides?: Array<{
    featureSlug: string;
    allowance: number;
  }>;
};

export interface EditPlanResult {
  success: true;
  plan: PlanWithFeatures; // Plan with clean features array (not raw relations)
  changeAnalysis: {
    hasFeatureChanges: boolean;
    hasPriceChanges: boolean;
    hasNumericFeatureChanges: boolean;
    canUseImmediate: boolean;
    isNewVersion: boolean;
  };
  migrationInfo: {
    activeSubscriptionCount: number;
    requiresMigration: boolean;
    affectedSubscriptions: number;
  };
  resourceActions: {
    featuresReused: string[];
    featuresCreated: string[];
    featuresModified: string[];
    pricesReused: string[];
    pricesCreated: string[];
    metricsCreated: string[];
    creditsCreated: string[];
  };
}

/**
 * Compares two features to determine if they are functionally identical
 */
function areFeaturesIdentical(
  existing: Feature,
  input: EditPlanFeature
): boolean {
  // Basic slug & display name match is required
  if (existing.slug !== input.slug) return false;
  if (existing.displayName !== input.featureName) return false;

  // Usage-based features must have the special "usage_based" marker
  if (input.isUsageBased) {
    return (
      existing.featureType === "number" &&
      existing.featureValue === "usage_based"
    );
  }

  // Non-usage features can be either boolean or numeric. We treat them as
  // identical as long as the stored value is NOT the special usage sentinel.
  if (existing.featureType === "boolean") {
    return typeof existing.featureValue === "boolean";
  }
  if (existing.featureType === "number") {
    return typeof existing.featureValue === "number";
  }

  return false;
}

/**
 * Compares two price components to determine if they are functionally identical
 */
function arePriceComponentsIdentical(
  existing: any,
  monthlyPrice?: number,
  yearlyPrice?: number,
  hasYearlyPrice?: boolean
): boolean {
  if (!existing?.pricingData?.components) return false;

  const existingComponents = existing.pricingData.components;
  const monthlyComponent = existingComponents.find(
    (c: any) => c.component_name === "monthly"
  );
  const yearlyComponent = existingComponents.find(
    (c: any) => c.component_name === "annual"
  );

  // Check monthly price
  if (monthlyPrice !== undefined) {
    if (
      !monthlyComponent ||
      (monthlyComponent as any).amount_cents !== monthlyPrice
    ) {
      return false;
    }
  } else if (monthlyComponent) {
    return false;
  }

  // Check yearly price
  if (hasYearlyPrice && yearlyPrice !== undefined) {
    if (
      !yearlyComponent ||
      (yearlyComponent as any).amount_cents !== yearlyPrice * 12
    ) {
      return false;
    }
  } else if (yearlyComponent) {
    return false;
  }

  return true;
}

// NEW: Detect price changes across all price records
function detectPriceChanges(
  existingPrices: Price[],
  params: {
    monthlyPrice?: number;
    yearlyPrice?: number;
    hasYearlyPrice?: boolean;
  }
): boolean {
  const { monthlyPrice, yearlyPrice, hasYearlyPrice } = params;

  const findComponent = (names: string | string[]) => {
    const arr = Array.isArray(names) ? names : [names];
    for (const p of existingPrices) {
      for (const name of arr) {
        const comp = p.pricingData?.components?.find(
          (c: any) => c.component_name === name
        );
        if (comp) return comp;
      }
    }
    return undefined;
  };

  // Support both fixed and seat-based component naming conventions
  const monthlyComp = findComponent(["monthly", "per_unit_monthly"]);
  const annualComp = findComponent(["annual", "per_unit_yearly"]);

  // Monthly evaluation
  if (monthlyPrice !== undefined) {
    if (!monthlyComp || (monthlyComp as any).amount_cents !== monthlyPrice)
      return true;
  }

  // Yearly evaluation
  if (hasYearlyPrice) {
    if (!annualComp) return true;
    if (
      yearlyPrice !== undefined &&
      (annualComp as any).amount_cents !== yearlyPrice * 12
    )
      return true;
  } else if (annualComp) {
    return true; // yearly component exists but merchant removed it
  }

  return false;
}

/**
 * Loads the complete current state of a plan with all associated data
 */
async function loadPlanCurrentState(
  planId: string,
  merchantId: string,
  dbInstance: DatabaseType | TransactionType
) {
  const planWithData = await dbInstance.query.plans.findFirst({
    where: and(
      eq(plans.id, planId),
      eq(plans.merchantId, merchantId),
      isNull(plans.deletedAt)
    ),
    with: {
      planFeatures: {
        where: isNull(planFeatures.deletedAt),
        with: {
          feature: true,
        },
      },
      prices: {
        where: isNull(prices.deletedAt),
        orderBy: (prices, { desc }) => [desc(prices.createdAt)],
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

  if (!planWithData) {
    throw new Error("Plan not found");
  }

  // Get credit definitions for this plan
  const { creditDefinitions } = await import("@lumen/common/schema");
  const planCreditDefinitions =
    await dbInstance.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.merchantId, merchantId),
        eq(creditDefinitions.scope, "plan"),
        eq(creditDefinitions.planId, planId),
        isNull(creditDefinitions.deletedAt)
      ),
      with: {
        feature: true,
      },
    });

  return {
    plan: planWithData,
    features: planWithData.planFeatures
      .map((pf) => pf.feature)
      .filter((f) => f !== null),
    prices: planWithData.prices,
    creditDefinitions: planCreditDefinitions,
    pricingTablePlans: planWithData.pricingTablePlans,
  };
}

/**
 * Creates a shadow trial plan for a given paid plan
 */
export async function createTrialPlan(
  basePlan: typeof plans.$inferSelect,
  trialConfig: EnabledTrialConfig,
  tx: TransactionType
): Promise<typeof plans.$inferSelect> {
  console.log("[createTrialPlan] Creating trial plan", {
    basePlanId: basePlan.id,
    basePlanName: basePlan.planName,
    trialDays: trialConfig.days,
  });

  // Create the shadow trial plan with modified name and trial-specific fields
  const trialName = `${basePlan.planName} - Free Trial`;
  const [trialPlan] = await tx
    .insert(plans)
    .values({
      merchantId: basePlan.merchantId,
      // Generate a unique stable ID for the trial plan (not the same as base plan)
      // The stablePlanId will be auto-generated by the $defaultFn
      versionNumber: 1, // Trial plans start at version 1
      planName: trialName,
      planDescription: basePlan.planDescription
        ? `${basePlan.planDescription} (Free Trial)`
        : `Free trial version of ${basePlan.planName}`,
      commitMessage: `Trial plan created for ${basePlan.planName}`,
      isTrialPlan: true,
      trialParentPlanId: basePlan.id,
      trialDays: trialConfig.days,
    })
    .returning();

  console.log("[createTrialPlan] Trial plan created", {
    trialPlanId: trialPlan.id,
  });

  // Clone planFeatures relationships from the base plan
  const basePlanFeatures = await tx.query.planFeatures.findMany({
    where: and(
      eq(planFeatures.planId, basePlan.id),
      isNull(planFeatures.deletedAt)
    ),
    with: {
      feature: true,
    },
  });

  if (basePlanFeatures.length > 0) {
    await tx.insert(planFeatures).values(
      basePlanFeatures.map((pf) => ({
        planId: trialPlan.id,
        featureId: pf.featureId,
        featureValue: pf.featureValue,
        featureSlug: pf.featureSlug,
      }))
    );
    console.log("[createTrialPlan] Cloned plan features", {
      count: basePlanFeatures.length,
    });
  }

  // Create credit definitions with trial allowances for usage-based features
  const baseCreditDefinitions = await tx.query.creditDefinitions.findMany({
    where: and(
      eq(creditDefinitions.planId, basePlan.id),
      eq(creditDefinitions.scope, "plan"),
      eq(creditDefinitions.applicationType, "usage"),
      isNull(creditDefinitions.deletedAt)
    ),
  });
  console.log("[createTrialPlan] Found base credit definitions", {
    count: baseCreditDefinitions.length,
  });

  // Build override map for quick lookup
  const overrideMap = new Map(
    (trialConfig.creditOverrides || []).map((override) => [
      override.featureSlug,
      override.allowance,
    ])
  );

  // Group credit definitions by feature slug (since monthly/yearly plans have duplicate credit defs)
  const creditDefsByFeature = new Map<
    string,
    (typeof baseCreditDefinitions)[0]
  >();
  for (const creditDef of baseCreditDefinitions) {
    if (!creditDef.featureSlug) continue;

    // Only keep one credit definition per feature (since they have the same defaultAmount, just different price linkage)
    if (!creditDefsByFeature.has(creditDef.featureSlug)) {
      creditDefsByFeature.set(creditDef.featureSlug, creditDef);
    }
  }

  console.log("[createTrialPlan] Processing credit definitions", {
    totalCreditDefs: creditDefsByFeature.size,
    overrides: trialConfig.creditOverrides?.length || 0,
  });

  for (const [featureSlug, baseCreditDef] of creditDefsByFeature) {
    // Trial allowance MUST be explicitly provided - no defaults
    const trialAllowance = overrideMap.get(featureSlug);

    if (trialAllowance === undefined) {
      throw new Error(
        `Trial allowance must be explicitly provided for feature: ${featureSlug}`
      );
    }

    // Create trial-specific credit definition
    const trialCreditDef: Omit<
      z.infer<typeof creditDefinitionsInsertSchema>,
      "id" | "createdAt" | "updatedAt" | "deletedAt"
    > = {
      merchantId: baseCreditDef.merchantId,
      scope: "plan",
      applicationType: "usage",
      planId: trialPlan.id,
      featureId: baseCreditDef.featureId,
      featureSlug: baseCreditDef.featureSlug,
      name: `${baseCreditDef.name} (Trial)`,
      description: `Trial version: ${baseCreditDef.description}`,
      defaultAmount: trialAllowance,
      billingVisible: false, // Trial credits are not billing-visible
      priority: baseCreditDef.priority,
      // Trial credits don't renew - one-time allowance
      expiryDays: trialConfig.days,
      // No renewal configuration for trial credits
      refillAmount: null,
      refillRrule: null,
      renewOnBilling: false,
      // No price linkage since trial plans have no prices
      priceId: null,
      priceComponentId: null,
    };

    await createCreditDefinition(trialCreditDef, tx);
    console.log("[createTrialPlan] Created trial credit definition", {
      featureSlug,
      trialAllowance,
    });
  }

  // After cloning features and creating credit definitions, add this:
  // Create a zero-cost price so subscriptions on the trial plan have a valid price
  const basePlanFirstPrice = await tx.query.prices.findFirst({
    where: and(eq(prices.planId, basePlan.id), isNull(prices.deletedAt)),
  });

  if (!basePlanFirstPrice) {
    throw new Error(
      "Base plan must have at least one price to derive currency"
    );
  }

  // Build minimal fixed-component pricing data
  const trialPriceComponentId = createPrefixedId(ID_PREFIXES.fixedComponent);
  const trialPricingData = {
    components: [
      {
        type: "fixed",
        component_id: trialPriceComponentId,
        component_name: "trial_zero",
        label: `Free trial (${trialConfig.days} days)`,
        amount_cents: 0,
        recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
        bill_immediately: false,
      },
    ],
    dsl_version: 1,
  };

  await tx.insert(prices).values({
    planId: trialPlan.id,
    merchantId: basePlan.merchantId,
    currency: basePlanFirstPrice.currency,
    pricingData: trialPricingData as any,
  });

  console.log("[createTrialPlan] Trial plan setup complete", {
    trialPlanId: trialPlan.id,
    basePlanId: basePlan.id,
  });

  return trialPlan;
}

/**
 * Updates an existing trial plan with new configuration
 */
async function updateTrialPlan(
  trialPlan: typeof plans.$inferSelect,
  basePlan: typeof plans.$inferSelect,
  trialConfig: EnabledTrialConfig,
  tx: TransactionType
): Promise<typeof plans.$inferSelect> {
  // Update trial plan basic info
  const [updatedTrialPlan] = await tx
    .update(plans)
    .set({
      trialDays: trialConfig.days,
      planName: `${basePlan.planName} - Free Trial`,
      planDescription: basePlan.planDescription
        ? `${basePlan.planDescription} (Free Trial)`
        : `Free trial version of ${basePlan.planName}`,
    })
    .where(eq(plans.id, trialPlan.id))
    .returning();

  // Update trial credit definitions
  if (trialConfig.creditOverrides && trialConfig.creditOverrides.length > 0) {
    const overrideMap = new Map(
      trialConfig.creditOverrides.map((override) => [
        override.featureSlug,
        override.allowance,
      ])
    );

    // Get existing trial credit definitions
    const existingTrialCredits = await tx.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, trialPlan.id),
        eq(creditDefinitions.scope, "plan"),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    // Update existing credit definitions with new allowances
    for (const creditDef of existingTrialCredits) {
      if (!creditDef.featureSlug) continue;

      const newAllowance = overrideMap.get(creditDef.featureSlug);
      if (
        newAllowance !== undefined &&
        newAllowance !== creditDef.defaultAmount
      ) {
        await tx
          .update(creditDefinitions)
          .set({
            defaultAmount: newAllowance,
            expiryDays: trialConfig.days, // Update expiry to match trial duration
          })
          .where(eq(creditDefinitions.id, creditDef.id));
      }
    }
  }

  return updatedTrialPlan;
}

/**
 * Deletes a trial plan and all associated credit definitions
 */
async function deleteTrialPlan(
  trialPlanId: string,
  tx: TransactionType
): Promise<void> {
  // Soft delete all trial credit definitions
  await tx
    .update(creditDefinitions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(creditDefinitions.planId, trialPlanId),
        isNull(creditDefinitions.deletedAt)
      )
    );

  // Soft delete the trial plan
  await tx
    .update(plans)
    .set({ deletedAt: new Date() })
    .where(eq(plans.id, trialPlanId));
}

/**
 * Comprehensively handles trial plan operations during plan editing,
 * coordinating with feature changes and credit definitions
 */
async function handleTrialPlanForEdit(
  basePlan: typeof plans.$inferSelect,
  merchantId: string,
  input: EditPlanInput,
  featuresAfterEdit: {
    featureId: string;
    slug: string;
    isUsageBased: boolean;
  }[],
  tx: TransactionType
): Promise<void> {
  console.log("[handleTrialPlanForEdit] Starting trial plan coordination");

  // 1. Check current trial plan state
  const existingTrialPlan = await tx.query.plans.findFirst({
    where: and(
      eq(plans.trialParentPlanId, basePlan.id),
      eq(plans.isTrialPlan, true),
      isNull(plans.deletedAt)
    ),
  });

  const existingTrialCredits = existingTrialPlan
    ? await tx.query.creditDefinitions.findMany({
        where: and(
          eq(creditDefinitions.planId, existingTrialPlan.id),
          eq(creditDefinitions.scope, "plan"),
          eq(creditDefinitions.applicationType, "usage"),
          isNull(creditDefinitions.deletedAt)
        ),
      })
    : [];

  const wantsTrialPlan = input.trial?.enabled === true;

  // 2. Handle the three main scenarios
  if (wantsTrialPlan && input.trial) {
    if (existingTrialPlan) {
      // SCENARIO: Update existing trial
      await updateExistingTrial(
        existingTrialPlan,
        basePlan,
        merchantId,
        input.trial as EnabledTrialConfig,
        featuresAfterEdit,
        existingTrialCredits,
        tx
      );
    } else {
      // SCENARIO: Enable trial for first time
      await enableTrialForFirstTime(
        basePlan,
        merchantId,
        input.trial as EnabledTrialConfig,
        featuresAfterEdit,
        tx
      );
    }
  } else if (!wantsTrialPlan && existingTrialPlan) {
    // SCENARIO: Disable existing trial
    await disableExistingTrial(existingTrialPlan.id, tx);
  }

  console.log("[handleTrialPlanForEdit] Trial plan coordination complete");
}

/**
 * Enables trial for the first time - creates trial plan and trial credits for ALL usage-based features
 */
async function enableTrialForFirstTime(
  basePlan: typeof plans.$inferSelect,
  merchantId: string,
  trialConfig: EnabledTrialConfig,
  featuresAfterEdit: {
    featureId: string;
    slug: string;
    isUsageBased: boolean;
  }[],
  tx: TransactionType
): Promise<void> {
  console.log("[enableTrialForFirstTime] Creating trial plan and credits");

  // Get all base credit definitions for usage-based features to determine trial allowances
  const baseCreditDefinitions = await tx.query.creditDefinitions.findMany({
    where: and(
      eq(creditDefinitions.planId, basePlan.id),
      eq(creditDefinitions.scope, "plan"),
      eq(creditDefinitions.applicationType, "usage"),
      isNull(creditDefinitions.deletedAt)
    ),
  });

  // Build override map from input
  const overrideMap = new Map(
    (trialConfig.creditOverrides || []).map(
      (o: { featureSlug: string; allowance: number }) => [
        o.featureSlug,
        o.allowance,
      ]
    )
  );

  // For features that don't have explicit trial overrides, we need to require them
  const usageBasedFeatures = featuresAfterEdit.filter((f) => f.isUsageBased);
  const missingOverrides = usageBasedFeatures.filter(
    (f) =>
      !overrideMap.has(f.slug) &&
      baseCreditDefinitions.some((cd) => cd.featureSlug === f.slug)
  );

  if (missingOverrides.length > 0) {
    throw new Error(
      `Trial credit allowances must be provided for all usage-based features: ${missingOverrides.map((f) => f.slug).join(", ")}`
    );
  }

  // Create trial plan with comprehensive credit overrides
  await createTrialPlan(basePlan, trialConfig, tx);
  console.log(
    "[enableTrialForFirstTime] Trial plan created with credits for all usage features"
  );
}

/**
 * Updates existing trial - handles changes to duration, credit allowances, and feature sync
 */
async function updateExistingTrial(
  existingTrialPlan: typeof plans.$inferSelect,
  basePlan: typeof plans.$inferSelect,
  merchantId: string,
  trialConfig: EnabledTrialConfig,
  featuresAfterEdit: {
    featureId: string;
    slug: string;
    isUsageBased: boolean;
  }[],
  existingTrialCredits: (typeof creditDefinitions.$inferSelect)[],
  tx: TransactionType
): Promise<void> {
  console.log("[updateExistingTrial] Updating trial plan and syncing credits");

  // 1. Update trial plan basic info
  await tx
    .update(plans)
    .set({
      trialDays: trialConfig.days,
      planName: `${basePlan.planName} - Free Trial`,
      planDescription: basePlan.planDescription
        ? `${basePlan.planDescription} (Free Trial)`
        : `Free trial version of ${basePlan.planName}`,
    })
    .where(eq(plans.id, existingTrialPlan.id));

  // 2. Sync trial credits with current feature set
  await syncTrialCreditsWithFeatures(
    existingTrialPlan.id,
    merchantId,
    trialConfig,
    featuresAfterEdit,
    existingTrialCredits,
    tx
  );

  console.log("[updateExistingTrial] Trial plan updated and credits synced");
}

/**
 * Syncs trial credit definitions with the current feature set
 */
async function syncTrialCreditsWithFeatures(
  trialPlanId: string,
  merchantId: string,
  trialConfig: EnabledTrialConfig,
  featuresAfterEdit: {
    featureId: string;
    slug: string;
    isUsageBased: boolean;
  }[],
  existingTrialCredits: (typeof creditDefinitions.$inferSelect)[],
  tx: TransactionType
): Promise<void> {
  const overrideMap = new Map(
    (trialConfig.creditOverrides || []).map(
      (o: { featureSlug: string; allowance: number }) => [
        o.featureSlug,
        o.allowance,
      ]
    )
  );

  const usageBasedFeatures = featuresAfterEdit.filter((f) => f.isUsageBased);
  const existingCreditMap = new Map(
    existingTrialCredits.map((c) => [c.featureSlug!, c])
  );

  // 3a. Remove trial credits for features that no longer exist or are no longer usage-based
  for (const existingCredit of existingTrialCredits) {
    if (!existingCredit.featureSlug) continue;

    const featureStillExists = usageBasedFeatures.some(
      (f) => f.slug === existingCredit.featureSlug
    );
    if (!featureStillExists) {
      await tx
        .update(creditDefinitions)
        .set({ deletedAt: new Date() })
        .where(eq(creditDefinitions.id, existingCredit.id));
      console.log(
        "[syncTrialCreditsWithFeatures] Removed trial credit for deleted feature",
        {
          featureSlug: existingCredit.featureSlug,
        }
      );
    }
  }

  // 3b. Add or update trial credits for current usage-based features
  for (const feature of usageBasedFeatures) {
    const trialAllowance = overrideMap.get(feature.slug);
    if (trialAllowance === undefined) {
      throw new Error(
        `Trial allowance must be explicitly provided for usage-based feature: ${feature.slug}`
      );
    }

    // TypeScript type narrowing - trialAllowance is now guaranteed to be a number
    const allowanceAmount: number = trialAllowance;

    const existingCredit = existingCreditMap.get(feature.slug);

    if (existingCredit) {
      // Update existing trial credit
      if (existingCredit.defaultAmount !== allowanceAmount) {
        await tx
          .update(creditDefinitions)
          .set({
            defaultAmount: allowanceAmount,
            expiryDays: trialConfig.days,
          })
          .where(eq(creditDefinitions.id, existingCredit.id));
        console.log("[syncTrialCreditsWithFeatures] Updated trial credit", {
          featureSlug: feature.slug,
          newAllowance: allowanceAmount,
        });
      }
    } else {
      // Create new trial credit for newly added usage-based feature
      const trialCreditDef = {
        merchantId,
        scope: "plan" as const,
        applicationType: "usage" as const,
        planId: trialPlanId,
        featureId: feature.featureId,
        featureSlug: feature.slug,
        name: `${feature.slug} Credits (Trial)`,
        description: `Trial credits for ${feature.slug}`,
        defaultAmount: allowanceAmount,
        billingVisible: false,
        priority: 100,
        expiryDays: trialConfig.days,
        refillAmount: null,
        refillRrule: null,
        renewOnBilling: false,
        priceId: null,
        priceComponentId: null,
      };

      await createCreditDefinition(trialCreditDef, tx);
      console.log(
        "[syncTrialCreditsWithFeatures] Created trial credit for new feature",
        {
          featureSlug: feature.slug,
          allowance: allowanceAmount,
        }
      );
    }
  }
}

/**
 * Disables existing trial - soft deletes trial plan and all trial credits
 */
async function disableExistingTrial(
  trialPlanId: string,
  tx: TransactionType
): Promise<void> {
  console.log("[disableExistingTrial] Removing trial plan and all credits");
  await deleteTrialPlan(trialPlanId, tx);
  console.log("[disableExistingTrial] Trial plan disabled");
}

/**
 * Intelligently edits a plan by detecting changes and reusing resources when possible
 */
export async function editPlan(
  planId: string,
  merchantId: string,
  input: EditPlanInput,
  dbInstance: DatabaseType = db
): Promise<EditPlanResult | { error: string }> {
  try {
    console.log("[editPlan] Start editing plan", { planId, merchantId });
    // ------------------------------------------------------------
    // 0. Early checks – fetch current plan record to determine
    //    stablePlanId and active subscription count. If there are
    //    *no* active subscriptions we simply delegate to
    //    editPlanInPlace() which already contains the incremental
    //    editing logic.
    // ------------------------------------------------------------
    const currentPlanRecord = await dbInstance.query.plans.findFirst({
      where: and(
        eq(plans.id, planId),
        eq(plans.merchantId, merchantId),
        isNull(plans.deletedAt)
      ),
    });

    if (!currentPlanRecord) {
      console.log("[editPlan] Plan not found");
      return { error: "Plan not found" };
    }

    const activeSubscriptionCount = await getActiveSubscriptionCountForPlan(
      currentPlanRecord.stablePlanId,
      merchantId,
      dbInstance
    );
    console.log("[editPlan] Active subscription count", {
      activeSubscriptionCount,
    });

    // Helper function to determine if changes are metadata-only (safe for in-place editing)
    const isMetadataOnlyEdit = (input: EditPlanInput): boolean => {
      const metadataFields = [
        "planName",
        "planDescription",
        "enterpriseButtonText",
        "enterpriseRedirectUrl",
        "showInPricingTable",
      ];
      const providedFields = Object.keys(input).filter(
        (key) => input[key as keyof EditPlanInput] !== undefined
      );

      // Quick check – if anything outside the metadata fields is provided we know it's not metadata-only.
      const nonMetaProvided = providedFields.some(
        (field) => !metadataFields.includes(field)
      );
      if (nonMetaProvided) return false;

      return true;
    };

    // NEW: detect "feature rename-only" edits (all slugs remain the same and only displayName changes)
    const isFeatureRenameOnlyEdit = async (input: EditPlanInput) => {
      if (!input.features || input.features.length === 0) return false;

      // Load current features for the plan
      const currentFeatures = await getPlanFeatures(planId, dbInstance);
      const currentFeatureMap = new Map(
        currentFeatures.map((f) => [f.slug, f])
      );

      // Fast checks – ensure no feature removals or additions
      const inputSlugs = input.features.map((f) => f.slug);
      const currentSlugs = currentFeatures.map((f) => f.slug);

      // If any new slug is introduced OR any existing slug is missing we are not rename-only
      const slugSetEqual =
        inputSlugs.length === currentSlugs.length &&
        inputSlugs.every((s) => currentSlugs.includes(s));
      if (!slugSetEqual) return false;

      // Check every feature for rename-only criteria
      for (const inputFeat of input.features) {
        const existing = currentFeatureMap.get(inputFeat.slug);
        if (!existing) return false; // defensive

        // Structural flags must stay identical
        const wasUsage =
          existing.featureType === "number" &&
          existing.featureValue === "usage_based";
        if (inputFeat.isUsageBased !== wasUsage) return false;

        if (
          inputFeat.usagePricePerUnit !== undefined ||
          inputFeat.hasCreditAllowance ||
          inputFeat.creditAllowanceAmount !== undefined ||
          inputFeat.creditAllowanceRenewal !== undefined ||
          inputFeat.eventName !== undefined
        ) {
          // Any of these indicates structural change
          return false;
        }

        // Only difference allowed is the display/name
        if (existing.displayName === inputFeat.featureName) {
          // no change at all – fine
          continue;
        }
      }
      return true;
    };

    // Decide routing strategy
    const isMetadataOnly = isMetadataOnlyEdit(input);
    const isRenameOnly = await isFeatureRenameOnlyEdit(input);

    const shouldEditInPlace =
      activeSubscriptionCount === 0 || isMetadataOnly || isRenameOnly;

    if (shouldEditInPlace) {
      console.log(
        "[editPlan] Delegating to editPlanInPlace (reason: " +
          (activeSubscriptionCount === 0
            ? "no active subscriptions"
            : isMetadataOnly
              ? "metadata-only change"
              : "feature rename-only change") +
          ")"
      );
      return await editPlanInPlace(planId, merchantId, input, dbInstance);
    }

    // ------------------------------------------------------------
    // 1. Plans with *active* subscriptions and structural changes MUST create a new version.
    //    From this point on we know that `activeSubscriptionCount > 0` AND we have non-metadata changes.
    // ------------------------------------------------------------
    const result = await dbInstance.transaction(async (tx) => {
      console.log("[editPlan] Transaction started for new plan version");
      // ----------------------------------------------------------
      // 1.1 Load the complete current state that we need for diffing
      // ----------------------------------------------------------
      const currentState = await loadPlanCurrentState(planId, merchantId, tx);
      const {
        plan: currentPlan,
        features: currentFeatures,
        prices: currentPrices,
      } = currentState;

      // ----------------------------------------------------------
      // 1.2 Detect basic metadata changes (name / description)
      // ----------------------------------------------------------
      const hasNameChange =
        input.planName && input.planName !== currentPlan.planName;
      const hasDescriptionChange =
        input.planDescription !== undefined &&
        input.planDescription !== currentPlan.planDescription;
      if (hasNameChange || hasDescriptionChange) {
        console.log("[editPlan] Metadata changes detected", {
          hasNameChange,
          hasDescriptionChange,
        });
      }

      // ----------------------------------------------------------
      // 1.3 Detect feature-level changes using the same logic as
      //     editPlanInPlace – but *never* modify existing features
      //     in this branch. When a feature differs we will create
      //     a brand-new feature record and attach it to the new plan
      //     version, leaving the old one untouched.
      // ----------------------------------------------------------
      let hasFeatureChanges = false;
      let hasNumericFeatureChanges = false;
      const featuresReused: string[] = [];
      const featuresCreated: string[] = [];
      const featuresModified: string[] = [];

      // Maps featureSlug -> metricId (only for usage-based features)
      const usageFeatureMetricMap = new Map<
        string,
        { metricId: string; usagePrice: number; featureName: string }
      >();

      if (input.features) {
        const inputFeatureMap = new Map(input.features.map((f) => [f.slug, f]));
        const currentFeatureMap = new Map(
          currentFeatures.map((f) => [f.slug, f])
        );

        // Removed features (not present in input) – considered a change
        const removedUsageFeatureSlugs: string[] = [];
        for (const currentFeature of currentFeatures) {
          if (!inputFeatureMap.has(currentFeature.slug)) {
            hasFeatureChanges = true;

            // Track usage-based features so we can later remove their price
            // components ("usage_<slug>") from all price records.
            if (
              currentFeature.featureType === "number" &&
              currentFeature.featureValue === "usage_based"
            ) {
              removedUsageFeatureSlugs.push(currentFeature.slug);
            }
          }
        }

        // Added / modified features
        for (const inputFeature of input.features) {
          const currentFeature = currentFeatureMap.get(inputFeature.slug);
          const isIdentical =
            currentFeature &&
            areFeaturesIdentical(currentFeature, inputFeature);

          if (isIdentical) {
            // Perfect match – we can reuse this feature as-is
            featuresReused.push(currentFeature!.id);

            // Gather metric mapping for usage-based features
            if (inputFeature.isUsageBased && inputFeature.usagePricePerUnit) {
              const existingMetric = await tx.query.featureMetrics.findFirst({
                where: and(
                  eq(featureMetrics.featureId, currentFeature!.id),
                  eq(featureMetrics.merchantId, merchantId)
                ),
              });
              if (existingMetric) {
                usageFeatureMetricMap.set(inputFeature.slug, {
                  metricId: existingMetric.metricId,
                  usagePrice: inputFeature.usagePricePerUnit || 0,
                  featureName: inputFeature.featureName,
                });
              }
            }
          } else {
            // New or modified feature – will require creation
            hasFeatureChanges = true;
            if (currentFeature) {
              featuresModified.push(inputFeature.slug);
            } else {
              featuresCreated.push(inputFeature.slug);
            }
            if (inputFeature.isUsageBased) {
              hasNumericFeatureChanges = true;
            }
          }
        }
        if (hasFeatureChanges) {
          console.log("[editPlan] Feature changes detected", {
            featuresCreated,
            featuresModified,
          });
        }
      }

      // ----------------------------------------------------------
      // 1.4 Detect price changes (fixed monthly / annual amounts)
      //     We reuse the existing helper to keep behaviour consistent.
      // ----------------------------------------------------------
      const hasPriceChanges = detectPriceChanges(currentPrices, {
        monthlyPrice: input.monthlyPrice,
        yearlyPrice: input.yearlyPrice,
        hasYearlyPrice: input.hasYearlyPrice,
      });
      if (hasPriceChanges) {
        console.log("[editPlan] Price changes detected");
      }

      // ----------------------------------------------------------
      // 1.5 Create the new *plan version* (always, because we have
      //     active subscribers). Version number is incremented.
      // ----------------------------------------------------------
      const [newPlan] = await tx
        .insert(plans)
        .values({
          planName: input.planName || currentPlan.planName,
          planDescription: input.planDescription || currentPlan.planDescription,
          merchantId,
          stablePlanId: currentPlan.stablePlanId,
          versionNumber: currentPlan.versionNumber + 1,
          commitMessage: `Plan edited: ${input.planName || currentPlan.planName}, version ${currentPlan.versionNumber + 1}`,
        })
        .returning();
      console.log("[editPlan] New plan version created", {
        newPlanId: newPlan.id,
      });

      // ----------------------------------------------------------
      // 1.6 Build/Reuse feature records and attach them to the new plan
      // ----------------------------------------------------------
      const featureIdsToAttach: string[] = [...featuresReused];
      const metricsCreated: string[] = [];
      const creditsCreated: string[] = [];

      // Helper to create credit definitions later once prices exist and we
      // have component IDs.
      const pendingPriceLinkedCreditDefs: {
        featureSlug: string;
        creditDefBase: any;
      }[] = [];

      if (input.features) {
        for (const inputFeature of input.features) {
          let featureId = "";
          let metricId: string | undefined;

          // Try to find the feature on the *current plan* first
          const currentFeature = currentFeatures.find(
            (f) => f.slug === inputFeature.slug
          );

          let identical =
            currentFeature &&
            areFeaturesIdentical(currentFeature, inputFeature);

          if (!identical) {
            // The feature is either not on the current plan or does not match
            // structurally. Before deciding to create a *brand-new* feature we
            // attempt to locate an existing feature (belonging to the same
            // merchant) with the same slug. If such a feature exists **and** it
            // is structurally identical we can safely reuse it.

            const existingFeature = await tx.query.features.findFirst({
              where: and(
                eq(features.merchantId, merchantId),
                eq(features.slug, inputFeature.slug),
                isNull(features.deletedAt)
              ),
            });

            if (existingFeature) {
              featureId = existingFeature.id;
              identical = true;

              // Keep track so we can skip duplicate creation and attach later
              featuresReused.push(existingFeature.id);

              // For usage-based features gather metric information so that we
              // can generate usage price components below.
              if (inputFeature.isUsageBased && inputFeature.usagePricePerUnit) {
                const existingMetric = await tx.query.featureMetrics.findFirst({
                  where: and(
                    eq(featureMetrics.featureId, existingFeature.id),
                    eq(featureMetrics.merchantId, merchantId)
                  ),
                });
                if (existingMetric) {
                  usageFeatureMetricMap.set(inputFeature.slug, {
                    metricId: existingMetric.metricId,
                    usagePrice: inputFeature.usagePricePerUnit || 0,
                    featureName: inputFeature.featureName,
                  });
                }
              }
            }
          }

          if (identical) {
            // Either came from current plan or was found globally and reused
            // above.
            if (!featureId) {
              featureId = currentFeature
                ? currentFeature.id
                : (() => {
                    throw new Error("Invariant: identical feature but no id");
                  })();
            }
          } else {
            // Either new feature or modified – create a fresh record
            if (inputFeature.isUsageBased && inputFeature.eventName) {
              const [newMetric] = await tx
                .insert(metrics)
                .values({
                  merchantId,
                  name: `${inputFeature.featureName} Usage Metric`,
                  description: `Tracks usage for ${inputFeature.featureName}`,
                  queryType: "simple",
                  aggregationType: "SUM",
                  eventName: inputFeature.eventName,
                  valueType: "NUMERIC",
                })
                .returning();
              metricId = newMetric.id;
              metricsCreated.push(newMetric.id);
              console.log("[editPlan] Metric created", { metricId });
            }

            const [newFeature] = await tx
              .insert(features)
              .values({
                merchantId,
                slug: inputFeature.slug,
                displayName: inputFeature.featureName,
                description: inputFeature.isUsageBased
                  ? `${inputFeature.featureName} usage tracking`
                  : `${inputFeature.featureName} feature access`,
                featureType: inputFeature.isUsageBased ? "number" : "boolean",
                featureValue: inputFeature.isUsageBased ? "usage_based" : true,
                isOverrideFeature: false,
              })
              .returning();
            featureId = newFeature.id;
            console.log("[editPlan] Feature created", { featureId });

            if (metricId) {
              await tx.insert(featureMetrics).values({
                merchantId,
                featureId: newFeature.id,
                featureSlug: newFeature.slug,
                metricId,
              });
              console.log("[editPlan] Feature-metric link created", {
                featureId,
                metricId,
              });
            }
          }

          featureIdsToAttach.push(featureId);

          // Build usageFeatureMetricMap for price component generation
          if (
            inputFeature.isUsageBased &&
            inputFeature.usagePricePerUnit !== undefined &&
            inputFeature.usagePricePerUnit > 0
          ) {
            // Retrieve metric id if not already determined
            if (!metricId) {
              const fm = await tx.query.featureMetrics.findFirst({
                where: and(
                  eq(featureMetrics.featureId, featureId),
                  eq(featureMetrics.merchantId, merchantId)
                ),
              });
              metricId = fm?.metricId;
            }
            if (metricId) {
              usageFeatureMetricMap.set(inputFeature.slug, {
                metricId,
                usagePrice: inputFeature.usagePricePerUnit!,
                featureName: inputFeature.featureName,
              });
            }
          }

          // ----------------------------------------------
          // Credit allowance logic – mirrors editPlanInPlace
          // ----------------------------------------------
          if (
            inputFeature.hasCreditAllowance &&
            inputFeature.creditAllowanceAmount &&
            inputFeature.creditAllowanceAmount > 0
          ) {
            const creditName = `${inputFeature.featureName} Credits`;
            const creditDescription = `Usage credits for ${inputFeature.featureName}`;

            // Set up renewal configuration based on feature credit renewal setting
            let renewalConfig: {
              refillAmount?: number;
              refillRrule?: string;
              expiryDays?: number;
              renewOnBilling?: boolean;
            } = {};

            // Determine the desired renewal behaviour. If the edit payload omits
            // `creditAllowanceRenewal` we fall back to **monthly** for
            // usage-based credits (historical default) and "none" for the rest.
            const inferredRenewal: "monthly" | "yearly" | "none" =
              inputFeature.creditAllowanceRenewal !== undefined
                ? inputFeature.creditAllowanceRenewal
                : inputFeature.isUsageBased &&
                    inputFeature.usagePricePerUnit !== undefined &&
                    inputFeature.usagePricePerUnit > 0
                  ? "monthly"
                  : "none";

            if (inferredRenewal === "monthly") {
              // Check if there will be usage-based pricing for this feature
              const hasUsageBasedPricing =
                inputFeature.isUsageBased &&
                inputFeature.usagePricePerUnit !== undefined &&
                inputFeature.usagePricePerUnit > 0;

              if (hasUsageBasedPricing) {
                // Usage-based pricing exists, use billing-based renewal
                renewalConfig = {
                  refillAmount: inputFeature.creditAllowanceAmount,
                  expiryDays: -1, // ✅ Expire with billing cycle
                  renewOnBilling: true, // ✅ Renew with customer's billing cycle
                };
              } else {
                // No usage-based pricing, use RRULE-based renewal
                renewalConfig = {
                  refillAmount: inputFeature.creditAllowanceAmount,
                  refillRrule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
                  expiryDays: -1, // ✅ Expire with renewal cycle
                  renewOnBilling: false, // ✅ Use RRULE-based renewal
                };
              }
            } else if (inferredRenewal === "yearly") {
              // Check if there will be usage-based pricing for this feature
              const hasUsageBasedPricing =
                inputFeature.isUsageBased &&
                inputFeature.usagePricePerUnit !== undefined &&
                inputFeature.usagePricePerUnit > 0;

              if (hasUsageBasedPricing) {
                // Usage-based pricing exists, use billing-based renewal
                renewalConfig = {
                  refillAmount: inputFeature.creditAllowanceAmount,
                  expiryDays: -1, // ✅ Expire with billing cycle
                  renewOnBilling: true, // ✅ Renew with customer's billing cycle
                };
              } else {
                // No usage-based pricing, use RRULE-based renewal
                renewalConfig = {
                  refillAmount: inputFeature.creditAllowanceAmount,
                  refillRrule: "RRULE:FREQ=YEARLY;INTERVAL=1",
                  expiryDays: -1, // ✅ Expire with renewal cycle
                  renewOnBilling: false, // ✅ Use RRULE-based renewal
                };
              }
            } else {
              // "none" - one-time credit with no renewal
              renewalConfig = {
                expiryDays: 365, // Default 1 year expiry for non-renewable credits
                // Note: renewOnBilling omitted for one-time credits (no renewal)
              };
            }

            const creditDefBase = {
              merchantId,
              scope: "plan" as const,
              applicationType: "usage" as const,
              planId: newPlan.id,
              featureId,
              featureSlug: inputFeature.slug,
              name: creditName,
              description: creditDescription,
              defaultAmount: inputFeature.creditAllowanceAmount,
              billingVisible:
                inputFeature.isUsageBased &&
                inputFeature.usagePricePerUnit !== undefined &&
                inputFeature.usagePricePerUnit > 0,
              priority: 100,
              ...renewalConfig,
            };

            if (
              inputFeature.isUsageBased &&
              inputFeature.usagePricePerUnit !== undefined &&
              inputFeature.usagePricePerUnit > 0
            ) {
              // We need price/component linkage – defer until prices exist
              pendingPriceLinkedCreditDefs.push({
                featureSlug: inputFeature.slug,
                creditDefBase,
              });
              console.log(
                "[editPlan] Deferred credit definition for usage-based feature",
                { featureSlug: inputFeature.slug }
              );
            } else {
              const cd = await createCreditDefinition(creditDefBase, tx);
              creditsCreated.push(cd.id);
              console.log("[editPlan] Credit definition created", {
                creditDefId: cd.id,
              });
            }
          }
        }
      }

      // Attach all featureIds collected
      if (featureIdsToAttach.length > 0) {
        // Ensure we don't attempt to attach the same feature multiple times
        const uniqueFeatureIds = [...new Set(featureIdsToAttach)];

        await attachFeaturesToPlan(newPlan.id, uniqueFeatureIds, tx);
        console.log("[editPlan] Features attached to new plan", {
          featureIdsToAttach: uniqueFeatureIds,
        });
      }

      // ----------------------------------------------------------
      // 1.7 Build price records for the new plan version
      // ----------------------------------------------------------
      const pricesCreated: string[] = [];
      const priceAccumulator: (typeof prices.$inferSelect)[] = [];

      if (!input.isEnterprisePlan) {
        const merchant = await tx.query.merchants.findFirst({
          where: eq(merchants.id, merchantId),
        });
        const defaultCurrency =
          input.currency || merchant?.defaultCurrency || "USD";
        const planName = input.planName || currentPlan.planName;

        // Build helper to generate usage components array
        const buildUsageComponents = () => {
          const comps: any[] = [];
          for (const [slug, info] of usageFeatureMetricMap) {
            comps.push({
              type: "usage",
              component_name: `usage_${slug}`,
              label: `${planName} - ${info.featureName} usage`,
              unit_label: "unit",
              metric_id: info.metricId,
              unit_cost_cents: info.usagePrice,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: false,
            });
          }
          return comps;
        };

        // Monthly price record (if merchant provided a monthly price *or* we have usage components)
        const monthlyAmount =
          input.monthlyPrice !== undefined
            ? input.monthlyPrice
            : (() => {
                // attempt to reuse existing monthly component amount (fixed or per-seat)
                for (const p of currentPrices) {
                  const comp = p.pricingData?.components?.find((c: any) => {
                    if (input.isSeatBased === true) {
                      return (
                        c.component_name === "per_unit_monthly" &&
                        c.type === "per_unit"
                      );
                    }
                    return c.component_name === "monthly" && c.type === "fixed";
                  });
                  if (comp) return (comp as any).amount_cents as number;
                }
                return undefined;
              })();

        const usageComponents = buildUsageComponents();

        if (monthlyAmount !== undefined || usageComponents.length > 0) {
          const monthlyComponents: any[] = [];

          if (monthlyAmount !== undefined) {
            if (input.isSeatBased === true) {
              // ----- seat-based per seat monthly component -----
              // Attempt to reuse existing seat metric from the current plan
              let seatMetricId: string | undefined;
              for (const p of currentPrices) {
                const comp = p.pricingData?.components?.find(
                  (c: any) =>
                    c.component_name === "per_unit_monthly" &&
                    c.type === "per_unit"
                );
                if (comp) {
                  seatMetricId = (comp as any).metric_id;
                  break;
                }
              }

              // If no metric found, create a new one (same SQL definition as in createPlan)
              if (!seatMetricId) {
                const metricName = `Active seat count for ${input.planName || currentPlan.planName}`;
                const metricDescription = `Counts active users for seat-based billing for ${input.planName || currentPlan.planName}`;

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
                seatMetricId = newMetric.id;
                metricsCreated.push(newMetric.id);
              }

              monthlyComponents.push({
                type: "per_unit",
                component_name: "per_unit_monthly",
                label: `${planName} - ${formatCurrency(monthlyAmount, defaultCurrency)} per month per seat`,
                unit_label: "seat",
                metric_id: seatMetricId,
                amount_cents: monthlyAmount,
                ...(input.minSeats &&
                  input.minSeats > 0 && {
                    num_seats: input.minSeats,
                  }),
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
                bill_immediately:
                  input.billImmediately !== undefined
                    ? input.billImmediately
                    : !!(input.minSeats && input.minSeats > 1),
              });
            } else {
              // ----- fixed monthly component -----
              monthlyComponents.push({
                type: "fixed",
                component_name: "monthly",
                label: `${planName} - ${formatCurrency(monthlyAmount, defaultCurrency)} per month`,
                amount_cents: monthlyAmount,
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
                bill_immediately: true,
              });
            }
          }

          monthlyComponents.push(...usageComponents);

          const newMonthlyPrice = await createPrice({
            planId: newPlan.id,
            merchantId,
            currency: defaultCurrency,
            pricingData: { dsl_version: 1, components: monthlyComponents },
            isOverridePrice: false,
            tx,
          });
          pricesCreated.push(newMonthlyPrice.id);
          priceAccumulator.push(newMonthlyPrice);
          console.log("[editPlan] Monthly price created", {
            priceId: newMonthlyPrice.id,
          });
        }

        // Annual price record (only if requested with hasYearlyPrice)
        if (input.hasYearlyPrice) {
          const annualAmount =
            input.yearlyPrice !== undefined
              ? input.yearlyPrice
              : (() => {
                  for (const p of currentPrices) {
                    const comp = p.pricingData?.components?.find((c: any) => {
                      if (input.isSeatBased === true) {
                        return (
                          c.component_name === "per_unit_yearly" &&
                          c.type === "per_unit"
                        );
                      }
                      return (
                        c.component_name === "annual" && c.type === "fixed"
                      );
                    });
                    if (comp) return (comp as any).amount_cents / 12;
                  }
                  return undefined;
                })();

          if (annualAmount !== undefined || usageComponents.length > 0) {
            const annualComponents: any[] = [];

            if (annualAmount !== undefined) {
              if (input.isSeatBased === true) {
                // --- per seat yearly component ---
                // Reuse metric if available
                let seatMetricId: string | undefined;
                for (const p of currentPrices) {
                  const comp = p.pricingData?.components?.find(
                    (c: any) =>
                      c.component_name === "per_unit_yearly" &&
                      c.type === "per_unit"
                  );
                  if (comp) {
                    seatMetricId = (comp as any).metric_id;
                    break;
                  }
                }

                if (!seatMetricId) {
                  const metricName = `Active seat count for ${input.planName || currentPlan.planName}`;
                  const metricDescription = `Counts active users for seat-based billing for ${input.planName || currentPlan.planName}`;

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
                  seatMetricId = newMetric.id;
                  metricsCreated.push(newMetric.id);
                }

                annualComponents.push({
                  type: "per_unit",
                  component_name: "per_unit_yearly",
                  label: `${planName} - ${formatCurrency(annualAmount * 12, defaultCurrency)} per seat per year`,
                  unit_label: "seat",
                  metric_id: seatMetricId,
                  amount_cents: annualAmount * 12,
                  ...(input.minSeats &&
                    input.minSeats > 0 && {
                      num_seats: input.minSeats,
                    }),
                  recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1",
                  bill_immediately:
                    input.billImmediately !== undefined
                      ? input.billImmediately
                      : !!(input.minSeats && input.minSeats > 1),
                });
              } else {
                // fixed annual component
                annualComponents.push({
                  type: "fixed",
                  component_name: "annual",
                  label: `${planName} - ${formatCurrency(annualAmount, defaultCurrency)} × 12 billed yearly`,
                  amount_cents: annualAmount * 12,
                  recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1",
                  bill_immediately: true,
                });
              }
            }

            annualComponents.push(...usageComponents);

            const newAnnualPrice = await createPrice({
              planId: newPlan.id,
              merchantId,
              currency: defaultCurrency,
              pricingData: { dsl_version: 1, components: annualComponents },
              isOverridePrice: false,
              tx,
            });
            pricesCreated.push(newAnnualPrice.id);
            priceAccumulator.push(newAnnualPrice);
            console.log("[editPlan] Annual price created", {
              priceId: newAnnualPrice.id,
            });
          }
        }
      }

      // ----------------------------------------------------------
      // 1.8 Create any deferred credit definitions now that we have
      //     price/component IDs available for linkage.
      // ----------------------------------------------------------
      if (pendingPriceLinkedCreditDefs.length > 0) {
        console.log("[editPlan] Creating deferred credit definitions", {
          pendingPriceLinkedCreditDefs,
          priceAccumulator,
        });
        for (const pending of pendingPriceLinkedCreditDefs) {
          for (const priceRec of priceAccumulator) {
            const matchingComponent = priceRec.pricingData.components.find(
              (c: any) =>
                c.type === "usage" &&
                c.component_name === `usage_${pending.featureSlug}`
            );
            if (!matchingComponent) {
              console.log("[editPlan] No matching component found", {
                priceRec,
                pending,
              });
              continue;
            }
            const cd = await createCreditDefinition(
              {
                ...pending.creditDefBase,
                priceId: priceRec.id,
                priceComponentId: matchingComponent.component_id,
              },
              tx
            );
            creditsCreated.push(cd.id);
            console.log("[editPlan] Deferred credit definition created", {
              creditDefId: cd.id,
            });
          }
        }
      }

      // ----------------------------------------------------------
      // 1.9 Update pricing table references to point to the new plan version
      //     This ensures that pricing tables always show the latest plan version
      // ----------------------------------------------------------
      console.log("[editPlan] Updating pricing table references");
      await tx
        .update(pricingTablePlans)
        .set({
          planId: newPlan.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pricingTablePlans.planId, planId), // old plan ID
            eq(pricingTablePlans.merchantId, merchantId),
            isNull(pricingTablePlans.deletedAt)
          )
        );

      // ----------------------------------------------------------
      // 1.9b Update enrollment rules to point to the new plan version
      //     Ensures auto-enrollment rules track the latest internal plan ID
      // ----------------------------------------------------------
      console.log("[editPlan] Updating enrollment rule references");
      await tx
        .update(planEnrollmentRules)
        .set({
          planId: newPlan.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(planEnrollmentRules.planId, planId), // old plan ID
            eq(planEnrollmentRules.merchantId, merchantId),
            isNull(planEnrollmentRules.deletedAt)
          )
        );

      // ----------------------------------------------------------
      // 1.10 Build change analysis & final response
      // ----------------------------------------------------------
      const changeAnalysis = {
        hasFeatureChanges,
        hasPriceChanges,
        hasNumericFeatureChanges,
        canUseImmediate: !hasPriceChanges,
        isNewVersion: true,
      };

      // We only created *new* version, existing subscribers are on the old
      // version for now. Migration modal will handle the rest.
      const finalPlanState = await loadPlanCurrentState(
        newPlan.id,
        merchantId,
        tx
      );

      // Handle trial plan for the new plan version - simple approach
      if (input.trial?.enabled === true && input.trial) {
        await createTrialPlan(newPlan, input.trial, tx);
        console.log("[editPlan] Trial plan created for new version", {
          newPlanId: newPlan.id,
        });
      }

      // Transform to consistent PlanWithFeatures format (matching editPlanInPlace)
      const transformedPlan = transformPlansWithFeatures([
        finalPlanState.plan as PlanWithPlanFeature,
      ])[0];
      console.log("[editPlan] Edit complete", { newPlanId: newPlan.id });

      return {
        success: true as const,
        plan: transformedPlan,
        changeAnalysis,
        migrationInfo: {
          activeSubscriptionCount,
          requiresMigration: true,
          affectedSubscriptions: activeSubscriptionCount,
        },
        resourceActions: {
          featuresReused,
          featuresCreated,
          featuresModified,
          pricesReused: [],
          pricesCreated,
          metricsCreated,
          creditsCreated,
        },
      };
    });

    return result;
  } catch (error) {
    console.error("[editPlan] Error:", error);
    return {
      error: error instanceof Error ? error.message : "Failed to edit plan",
    };
  }
}

// NEW: Edit a plan in-place when there are no active subscriptions
export async function editPlanInPlace(
  planId: string,
  merchantId: string,
  input: EditPlanInput,
  dbInstance: DatabaseType = db
): Promise<EditPlanResult | { error: string }> {
  try {
    console.log("[editPlanInPlace] Start editing plan", { planId, merchantId });
    const result = await dbInstance.transaction(async (tx) => {
      // 1. Load current plan state
      const currentState = await loadPlanCurrentState(planId, merchantId, tx);
      const {
        plan: currentPlan,
        features: currentFeatures,
        prices: currentPrices,
      } = currentState;

      // 2. Detect basic changes
      const hasNameChange =
        input.planName && input.planName !== currentPlan.planName;
      const hasDescriptionChange =
        input.planDescription !== undefined &&
        input.planDescription !== currentPlan.planDescription;

      // Get the plan name to use for component labels (updated name if provided, otherwise current name)
      const planName = input.planName || currentPlan.planName;

      // Feature change detection (reuse logic from editPlan)
      let hasFeatureChanges = false;
      let hasNumericFeatureChanges = false;
      const featuresReused: string[] = [];
      const featuresCreated: string[] = [];
      const featuresModified: string[] = [];
      const metricsCreated: string[] = [];
      const creditsCreated: string[] = [];
      // Holds slugs of usage-based features that were removed so that we can
      // strip their usage components from all price records later.
      const removedUsageFeatureSlugs: string[] = [];
      // Holds credit definitions that must be created after price components are available
      const pendingPriceLinkedCreditDefs: {
        featureSlug: string;
        creditDefBase: any;
      }[] = [];

      if (input.features) {
        const inputFeatureMap = new Map(input.features.map((f) => [f.slug, f]));
        const currentFeatureMap = new Map(
          currentFeatures.map((f) => [f.slug, f])
        );

        // Removed
        for (const currentFeature of currentFeatures) {
          if (!inputFeatureMap.has(currentFeature.slug)) {
            hasFeatureChanges = true;

            // Track usage-based features so we can later remove their price
            // components ("usage_<slug>") from all price records.
            if (
              currentFeature.featureType === "number" &&
              currentFeature.featureValue === "usage_based"
            ) {
              removedUsageFeatureSlugs.push(currentFeature.slug);
            }
          }
        }

        // Added / Modified
        for (const inputFeature of input.features) {
          const currentFeature = currentFeatureMap.get(inputFeature.slug);

          if (!currentFeature) {
            hasFeatureChanges = true;
            featuresCreated.push(inputFeature.slug);
            if (inputFeature.isUsageBased) hasNumericFeatureChanges = true;
          } else if (!areFeaturesIdentical(currentFeature, inputFeature)) {
            hasFeatureChanges = true;
            featuresModified.push(inputFeature.slug);
            if (inputFeature.isUsageBased) hasNumericFeatureChanges = true;
          } else {
            featuresReused.push(currentFeature.id);
          }
        }
        if (hasFeatureChanges) {
          console.log("[editPlanInPlace] Feature changes detected", {
            featuresCreated,
            featuresModified,
          });
        }
      }

      // Price change detection
      const hasPriceChanges = detectPriceChanges(currentPrices, {
        monthlyPrice: input.monthlyPrice,
        yearlyPrice: input.yearlyPrice,
        hasYearlyPrice: input.hasYearlyPrice,
      });
      if (hasPriceChanges) {
        console.log("[editPlanInPlace] Price changes detected");
      }

      // 3. Update plan metadata if needed
      if (hasNameChange || hasDescriptionChange) {
        console.log("[editPlanInPlace] Updating plan metadata");
        await tx
          .update(plans)
          .set({
            ...(hasNameChange && { planName: input.planName }),
            ...(hasDescriptionChange && {
              planDescription: input.planDescription,
            }),
          })
          .where(eq(plans.id, planId));
      }

      // 4. Handle feature updates
      // Track newly created metrics for usage components
      const newFeatureMetrics = new Map<string, string>(); // featureSlug -> metricId

      if (input.features) {
        // Build fast-lookup maps
        const currentPlanFeatureMap = new Map(
          currentState.plan.planFeatures.map((pf) => [pf.feature.slug, pf])
        );
        // Map featureSlug -> array of credit definitions (a feature can have one credit per price component)
        const currentCreditDefMap = new Map<
          string,
          (typeof creditDefinitions.$inferSelect)[]
        >([]);
        for (const cd of currentState.creditDefinitions) {
          const slug = cd.featureSlug as string; // featureSlug is required for grouping
          const list = currentCreditDefMap.get(slug) || [];
          list.push(cd as any);
          currentCreditDefMap.set(slug, list);
        }

        const featureIdsToAttach: string[] = [];

        // Helper – compare credit allowances against *all* existing credit definitions for the feature
        const areCreditDefsIdentical = (
          existingCds: any[],
          inputFeat: EditPlanFeature
        ) => {
          if (!inputFeat.hasCreditAllowance || !inputFeat.creditAllowanceAmount)
            return existingCds.length === 0; // neither side has allowance

          if (existingCds.length === 0) return false;

          // Determine the intended renewal behaviour from the incoming edit. When the
          // UI omits `creditAllowanceRenewal` we assume **monthly** renewal for
          // usage-based credits (this mirrors the default behaviour in earlier
          // versions of the API).
          const inferredRenewal: "monthly" | "yearly" | "none" =
            inputFeat.creditAllowanceRenewal !== undefined
              ? inputFeat.creditAllowanceRenewal
              : inputFeat.isUsageBased &&
                  inputFeat.usagePricePerUnit !== undefined &&
                  inputFeat.usagePricePerUnit > 0
                ? "monthly"
                : "none";

          return existingCds.every((cd) => {
            const sameAmt =
              cd.defaultAmount === inputFeat.creditAllowanceAmount;

            // Derive the renewal strategy stored in the existing credit definition.
            const renewalFromCd = cd.refillRrule?.includes("MONTHLY")
              ? "monthly"
              : cd.refillRrule?.includes("YEARLY")
                ? "yearly"
                : cd.renewOnBilling // billing-based renewal -> treat as monthly by default
                  ? "monthly"
                  : "none";

            return sameAmt && renewalFromCd === inferredRenewal;
          });
        };

        // 4a. Handle removals
        for (const [slug, pf] of currentPlanFeatureMap) {
          if (!input.features.some((f) => f.slug === slug)) {
            // unlink
            await tx
              .update(planFeatures)
              .set({ deletedAt: new Date() })
              .where(
                and(
                  eq(planFeatures.planId, planId),
                  eq(planFeatures.featureId, pf.featureId),
                  isNull(planFeatures.deletedAt)
                )
              );

            // soft delete *all* credit defs linked to this feature
            const cds = currentCreditDefMap.get(slug) || [];
            for (const cd of cds) {
              await tx
                .update(creditDefinitions)
                .set({ deletedAt: new Date() })
                .where(eq(creditDefinitions.id, cd.id));
            }
            console.log("[editPlanInPlace] Feature removed", { slug });
          }
        }

        // 4b. Handle additions / modifications
        for (const inputFeature of input.features) {
          let featureId: string = "";
          let metricId: string | undefined;

          const existingPlanFeature = currentPlanFeatureMap.get(
            inputFeature.slug
          );

          // Find existing feature either by provided ID or by slug
          let existingFeature: any = null;
          if (inputFeature.existingFeatureId) {
            existingFeature = await tx.query.features.findFirst({
              where: and(
                eq(features.id, inputFeature.existingFeatureId),
                eq(features.merchantId, merchantId),
                isNull(features.deletedAt)
              ),
            });
            featureId = inputFeature.existingFeatureId;
          } else {
            existingFeature = await tx.query.features.findFirst({
              where: and(
                eq(features.merchantId, merchantId),
                eq(features.slug, inputFeature.slug),
                isNull(features.deletedAt)
              ),
            });
            if (existingFeature) {
              featureId = existingFeature.id;
            }
          }
          if (existingFeature) {
            // Check if existing feature needs updating
            if (!areFeaturesIdentical(existingFeature, inputFeature)) {
              // Update the feature
              await tx
                .update(features)
                .set({
                  displayName: inputFeature.featureName,
                  description: inputFeature.isUsageBased
                    ? `${inputFeature.featureName} usage tracking`
                    : `${inputFeature.featureName} feature access`,
                  featureType: inputFeature.isUsageBased ? "number" : "boolean",
                  featureValue: inputFeature.isUsageBased
                    ? "usage_based"
                    : true,
                })
                .where(eq(features.id, existingFeature.id));

              // Handle metric changes when feature type changes or eventName changes
              const wasUsageBased =
                existingFeature.featureType === "number" &&
                existingFeature.featureValue === "usage_based";
              if (inputFeature.isUsageBased && inputFeature.eventName) {
                // Check if we need to create or update metric
                const existingFeatureMetric =
                  await tx.query.featureMetrics.findFirst({
                    where: and(
                      eq(featureMetrics.featureId, existingFeature.id),
                      eq(featureMetrics.merchantId, merchantId)
                    ),
                  });
                if (!existingFeatureMetric) {
                  // Create new metric and link
                  const [newMetric] = await tx
                    .insert(metrics)
                    .values({
                      merchantId,
                      name: `${inputFeature.featureName} Usage Metric`,
                      description: `Tracks usage for ${inputFeature.featureName}`,
                      queryType: "simple",
                      aggregationType: "SUM",
                      eventName: inputFeature.eventName,
                      valueType: "NUMERIC",
                    })
                    .returning();
                  metricId = newMetric.id;
                  metricsCreated.push(newMetric.id);
                  await tx.insert(featureMetrics).values({
                    merchantId,
                    featureId: existingFeature.id,
                    featureSlug: existingFeature.slug,
                    metricId,
                  });
                } else {
                  // Update existing metric if eventName changed
                  const existingMetric = await tx.query.metrics.findFirst({
                    where: eq(metrics.id, existingFeatureMetric.metricId),
                  });
                  if (
                    existingMetric &&
                    existingMetric.eventName !== inputFeature.eventName
                  ) {
                    await tx
                      .update(metrics)
                      .set({
                        eventName: inputFeature.eventName,
                        name: `${inputFeature.featureName} Usage Metric`,
                        description: `Tracks usage for ${inputFeature.featureName}`,
                      })
                      .where(eq(metrics.id, existingFeatureMetric.metricId));
                  }
                  metricId = existingFeatureMetric.metricId;
                }
              } else if (wasUsageBased && !inputFeature.isUsageBased) {
                // Feature changed from usage-based to non-usage-based
                // Soft delete the feature metric link (but keep the metric itself)
                await tx
                  .update(featureMetrics)
                  .set({ deletedAt: new Date() })
                  .where(
                    and(
                      eq(featureMetrics.featureId, existingFeature.id),
                      eq(featureMetrics.merchantId, merchantId)
                    )
                  );
              }
              console.log("[editPlanInPlace] Feature updated", {
                slug: inputFeature.slug,
              });
            }
          } else {
            // Create new feature since none exists
            // Metric creation for usage based
            if (inputFeature.isUsageBased && inputFeature.eventName) {
              const [newMetric] = await tx
                .insert(metrics)
                .values({
                  merchantId,
                  name: `${inputFeature.featureName} Usage Metric`,
                  description: `Tracks usage for ${inputFeature.featureName}`,
                  queryType: "simple",
                  aggregationType: "SUM",
                  eventName: inputFeature.eventName,
                  valueType: "NUMERIC",
                })
                .returning();
              metricId = newMetric.id;
              metricsCreated.push(newMetric.id);
            }
            const [newFeature] = await tx
              .insert(features)
              .values({
                merchantId,
                slug: inputFeature.slug,
                displayName: inputFeature.featureName,
                description: inputFeature.isUsageBased
                  ? `${inputFeature.featureName} usage tracking`
                  : `${inputFeature.featureName} feature access`,
                featureType: inputFeature.isUsageBased ? "number" : "boolean",
                featureValue: inputFeature.isUsageBased ? "usage_based" : true,
                isOverrideFeature: false,
              })
              .returning();
            featureId = newFeature.id;
            if (metricId) {
              await tx.insert(featureMetrics).values({
                merchantId,
                featureId: newFeature.id,
                featureSlug: newFeature.slug,
                metricId,
              });
              // Store for usage component creation
              newFeatureMetrics.set(inputFeature.slug, metricId);
            }
            console.log("[editPlanInPlace] Feature created", {
              slug: inputFeature.slug,
            });
          }

          // At this point decide if we need to create / attach linkage

          if (existingPlanFeature) {
            // already linked – ensure still attached
            featureIdsToAttach.push(existingPlanFeature.featureId);
          } else {
            featureIdsToAttach.push(featureId);
          }

          // Credit allowance handling
          if (
            inputFeature.hasCreditAllowance &&
            inputFeature.creditAllowanceAmount &&
            inputFeature.creditAllowanceAmount > 0
          ) {
            const creditName = `${inputFeature.featureName} Credits`;
            const creditDescription = `Usage credits for ${inputFeature.featureName}`;

            // Set up renewal configuration based on feature credit renewal setting
            let renewalConfig: {
              refillAmount?: number;
              refillRrule?: string;
              expiryDays?: number;
              renewOnBilling?: boolean;
            } = {};

            // Determine the desired renewal behaviour. If the edit payload omits
            // `creditAllowanceRenewal` we fall back to **monthly** for
            // usage-based credits (historical default) and "none" for the rest.
            const inferredRenewal: "monthly" | "yearly" | "none" =
              inputFeature.creditAllowanceRenewal !== undefined
                ? inputFeature.creditAllowanceRenewal
                : inputFeature.isUsageBased &&
                    inputFeature.usagePricePerUnit !== undefined &&
                    inputFeature.usagePricePerUnit > 0
                  ? "monthly"
                  : "none";

            if (inferredRenewal === "monthly") {
              // Check if there will be usage-based pricing for this feature
              const hasUsageBasedPricing =
                inputFeature.isUsageBased &&
                inputFeature.usagePricePerUnit !== undefined &&
                inputFeature.usagePricePerUnit > 0;

              if (hasUsageBasedPricing) {
                // Usage-based pricing exists, use billing-based renewal
                renewalConfig = {
                  refillAmount: inputFeature.creditAllowanceAmount,
                  expiryDays: -1, // ✅ Expire with billing cycle
                  renewOnBilling: true, // ✅ Renew with customer's billing cycle
                };
              } else {
                // No usage-based pricing, use RRULE-based renewal
                renewalConfig = {
                  refillAmount: inputFeature.creditAllowanceAmount,
                  refillRrule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
                  expiryDays: -1, // ✅ Expire with renewal cycle
                  renewOnBilling: false, // ✅ Use RRULE-based renewal
                };
              }
            } else if (inferredRenewal === "yearly") {
              // Check if there will be usage-based pricing for this feature
              const hasUsageBasedPricing =
                inputFeature.isUsageBased &&
                inputFeature.usagePricePerUnit !== undefined &&
                inputFeature.usagePricePerUnit > 0;

              if (hasUsageBasedPricing) {
                // Usage-based pricing exists, use billing-based renewal
                renewalConfig = {
                  refillAmount: inputFeature.creditAllowanceAmount,
                  expiryDays: -1, // ✅ Expire with billing cycle
                  renewOnBilling: true, // ✅ Renew with customer's billing cycle
                };
              } else {
                // No usage-based pricing, use RRULE-based renewal
                renewalConfig = {
                  refillAmount: inputFeature.creditAllowanceAmount,
                  refillRrule: "RRULE:FREQ=YEARLY;INTERVAL=1",
                  expiryDays: -1, // ✅ Expire with renewal cycle
                  renewOnBilling: false, // ✅ Use RRULE-based renewal
                };
              }
            } else {
              // "none" - one-time credit with no renewal
              renewalConfig = {
                expiryDays: 365, // Default 1 year expiry for non-renewable credits
                // Note: renewOnBilling omitted for one-time credits (no renewal)
              };
            }
            const creditDefBase = {
              merchantId,
              scope: "plan" as const,
              applicationType: "usage" as const,
              planId,
              featureId,
              featureSlug: inputFeature.slug,
              name: creditName,
              description: creditDescription,
              defaultAmount: inputFeature.creditAllowanceAmount,
              billingVisible:
                inputFeature.isUsageBased &&
                inputFeature.usagePricePerUnit !== undefined &&
                inputFeature.usagePricePerUnit > 0,
              priority: 100,
              ...renewalConfig,
            };
            if (
              inputFeature.isUsageBased &&
              inputFeature.usagePricePerUnit !== undefined &&
              inputFeature.usagePricePerUnit > 0
            ) {
              const existingCds =
                currentCreditDefMap.get(inputFeature.slug) || [];
              if (!areCreditDefsIdentical(existingCds, inputFeature)) {
                for (const cd of existingCds) {
                  await tx
                    .update(creditDefinitions)
                    .set({ deletedAt: new Date() })
                    .where(eq(creditDefinitions.id, cd.id));
                }
                pendingPriceLinkedCreditDefs.push({
                  featureSlug: inputFeature.slug,
                  creditDefBase,
                });
                console.log(
                  "[editPlanInPlace] Credit deferral for usage-based credit",
                  { slug: inputFeature.slug }
                );
              }
            } else {
              // Non-usage based credit or no price per unit - create/update immediately
              const existingCds =
                currentCreditDefMap.get(inputFeature.slug) || [];
              if (!areCreditDefsIdentical(existingCds, inputFeature)) {
                if (existingCds.length > 0) {
                  for (const cd of existingCds) {
                    await tx
                      .update(creditDefinitions)
                      .set({
                        defaultAmount: inputFeature.creditAllowanceAmount,
                        refillAmount: renewalConfig.refillAmount,
                        refillRrule: renewalConfig.refillRrule,
                      })
                      .where(eq(creditDefinitions.id, cd.id));
                  }
                } else {
                  const cd = await createCreditDefinition(creditDefBase, tx);
                  creditsCreated.push(cd.id);
                  console.log("[editPlanInPlace] Credit created", {
                    slug: inputFeature.slug,
                  });
                }
              }
            }
          }
        }

        // Re-attach newly added features
        if (featureIdsToAttach.length > 0) {
          for (const fid of featureIdsToAttach) {
            // ensure not already attached & alive
            const already = await tx.query.planFeatures.findFirst({
              where: and(
                eq(planFeatures.planId, planId),
                eq(planFeatures.featureId, fid),
                isNull(planFeatures.deletedAt)
              ),
            });
            if (!already) {
              await attachFeaturesToPlan(planId, [fid], tx);
              console.log("[editPlanInPlace] Feature attached", {
                featureId: fid,
              });
            }
          }
        }
      }

      // 5. Handle price updates (incremental – no blanket deletions)
      const priceAccumulator: (typeof prices.$inferSelect)[] = [];
      const pricesCreated: string[] = [];

      // We need to touch price records either when fixed amounts changed *or*
      // when new usage-based features with unit pricing were added/updated.
      const hasNewOrUpdatedUsageComponents = (input.features ?? []).some(
        (f) =>
          f.isUsageBased &&
          f.usagePricePerUnit !== undefined &&
          f.usagePricePerUnit > 0
      );

      // NEW: if any usage-based features were removed we must still touch the
      // price records to strip their usage components.
      const hasRemovedUsageComponents = removedUsageFeatureSlugs.length > 0;

      if (
        (hasPriceChanges ||
          hasNewOrUpdatedUsageComponents ||
          hasRemovedUsageComponents) &&
        !input.isEnterprisePlan
      ) {
        console.log("[editPlanInPlace] Updating prices");
        const merchant = await tx.query.merchants.findFirst({
          where: eq(merchants.id, merchantId),
        });
        const defaultCurrency =
          input.currency || merchant?.defaultCurrency || "USD";

        // Determine if the incoming edit uses seat-based pricing
        const seatBasedInput = input.isSeatBased === true;

        // Helper to create / update usage components for a given feature
        const ensureUsageComponent = async (
          comps: any[],
          feature: EditPlanFeature,
          needsComponentId: boolean = false
        ): Promise<boolean> => {
          if (
            !feature.isUsageBased ||
            feature.usagePricePerUnit === undefined ||
            feature.usagePricePerUnit <= 0
          ) {
            return false;
          }

          const existing = comps.find(
            (c: any) => c.component_name === `usage_${feature.slug}`
          );

          // First check if we have a newly created metric for this feature
          let metricId = newFeatureMetrics.get(feature.slug);

          if (!metricId) {
            // Fall back to database lookup for existing features
            const featureMetric = await tx.query.featureMetrics.findFirst({
              where: and(
                eq(featureMetrics.featureSlug, feature.slug),
                eq(featureMetrics.merchantId, merchantId)
              ),
            });
            metricId = featureMetric?.metricId;
          }

          if (!metricId) return false;

          if (existing) {
            let changed = false;

            // If the existing component does not yet have a component_id (legacy data),
            // generate one so that downstream linkages (e.g. credit definitions) work.
            if (!existing.component_id && needsComponentId) {
              existing.component_id = generateComponentId("usage");
              changed = true;
            }

            // Keep the unit cost up-to-date with the latest feature configuration
            if (existing.unit_cost_cents !== feature.usagePricePerUnit) {
              existing.unit_cost_cents = feature.usagePricePerUnit;
              changed = true;
            }

            if (changed) return true; // component mutated
            return false; // nothing changed
          }

          // brand-new usage component – ensure it carries a freshly generated component_id
          const newComp: any = {
            type: "usage",
            component_name: `usage_${feature.slug}`,
            label: `${planName} - ${feature.featureName} usage`,
            unit_label: "unit",
            metric_id: metricId,
            unit_cost_cents: feature.usagePricePerUnit,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: false,
          };
          if (needsComponentId) {
            newComp.component_id = generateComponentId("usage");
          }
          comps.push(newComp as any);
          return true;
        };

        // iterate current price records
        for (const priceRec of currentPrices) {
          if (priceRec.deletedAt) continue;
          const components = [...(priceRec.pricingData?.components || [])];
          let modified = false;

          // monthly component – update only in price records that already contain it
          const monthlyComp = components.find(
            (c: any) => c.component_name === "monthly" && c.type === "fixed"
          );
          if (input.monthlyPrice !== undefined && monthlyComp) {
            if ((monthlyComp as any).amount_cents !== input.monthlyPrice) {
              (monthlyComp as any).amount_cents = input.monthlyPrice;
              (monthlyComp as any).label =
                `${planName} - ${formatCurrency(input.monthlyPrice, defaultCurrency)} per month`;
              modified = true;
            }
          }

          // yearly component – update only in price records that already contain it
          const annualComp = components.find(
            (c: any) => c.component_name === "annual" && c.type === "fixed"
          );
          if (
            input.hasYearlyPrice &&
            input.yearlyPrice !== undefined &&
            annualComp
          ) {
            const desired = input.yearlyPrice * 12;
            if ((annualComp as any).amount_cents !== desired) {
              (annualComp as any).amount_cents = desired;
              (annualComp as any).label =
                `${planName} - ${formatCurrency(input.yearlyPrice, defaultCurrency)} × 12 billed yearly`;
              modified = true;
            }
          } else if (!input.hasYearlyPrice && annualComp) {
            // Remove yearly component if merchant removed yearly pricing
            components.splice(components.indexOf(annualComp), 1);
            modified = true;
          }

          /* Seat-based per-unit component updates */
          if (seatBasedInput) {
            // Monthly per seat component
            const seatMonthlyComp = components.find(
              (c: any) =>
                c.component_name === "per_unit_monthly" && c.type === "per_unit"
            );
            if (input.monthlyPrice !== undefined && seatMonthlyComp) {
              if (
                (seatMonthlyComp as any).amount_cents !== input.monthlyPrice
              ) {
                (seatMonthlyComp as any).amount_cents = input.monthlyPrice;
                (seatMonthlyComp as any).label =
                  `${planName} - ${formatCurrency(input.monthlyPrice, defaultCurrency)} per month per seat`;
                modified = true;
              }
              // minSeats
              if (input.minSeats !== undefined) {
                if (input.minSeats > 0) {
                  if ((seatMonthlyComp as any).num_seats !== input.minSeats) {
                    (seatMonthlyComp as any).num_seats = input.minSeats;
                    modified = true;
                  }
                } else if ((seatMonthlyComp as any).num_seats !== undefined) {
                  delete (seatMonthlyComp as any).num_seats;
                  modified = true;
                }
              }
              if (
                input.billImmediately !== undefined &&
                (seatMonthlyComp as any).bill_immediately !==
                  input.billImmediately
              ) {
                (seatMonthlyComp as any).bill_immediately =
                  input.billImmediately;
                modified = true;
              }
            }

            // Yearly per seat component
            const seatAnnualComp = components.find(
              (c: any) =>
                c.component_name === "per_unit_yearly" && c.type === "per_unit"
            );
            if (
              input.hasYearlyPrice &&
              input.yearlyPrice !== undefined &&
              seatAnnualComp
            ) {
              const desired = input.yearlyPrice * 12;
              if ((seatAnnualComp as any).amount_cents !== desired) {
                (seatAnnualComp as any).amount_cents = desired;
                (seatAnnualComp as any).label =
                  `${planName} - ${formatCurrency(input.yearlyPrice, defaultCurrency)} per seat per year`;
                modified = true;
              }
              if (input.minSeats !== undefined) {
                if (input.minSeats > 0) {
                  if ((seatAnnualComp as any).num_seats !== input.minSeats) {
                    (seatAnnualComp as any).num_seats = input.minSeats;
                    modified = true;
                  }
                } else if ((seatAnnualComp as any).num_seats !== undefined) {
                  delete (seatAnnualComp as any).num_seats;
                  modified = true;
                }
              }
              if (
                input.billImmediately !== undefined &&
                (seatAnnualComp as any).bill_immediately !==
                  input.billImmediately
              ) {
                (seatAnnualComp as any).bill_immediately =
                  input.billImmediately;
                modified = true;
              }
            } else if (!input.hasYearlyPrice && seatAnnualComp) {
              // Remove per-unit yearly component if turned off
              components.splice(components.indexOf(seatAnnualComp), 1);
              modified = true;
            }
          }

          // Remove usage components that correspond to features the merchant
          // deleted from this plan.
          for (const slug of removedUsageFeatureSlugs) {
            console.log("[editPlanInPlace] Removing usage component", {
              slug,
              components,
            });

            const idx = components.findIndex(
              (c: any) =>
                c.type === "usage" && c.component_name === `usage_${slug}`
            );
            console.log("[editPlanInPlace] Usage component index", {
              idx,
            });
            if (idx !== -1) {
              components.splice(idx, 1);
              modified = true;
            }
          }

          // usage components adjustments based on features array
          if (input.features) {
            for (const f of input.features) {
              const changed = await ensureUsageComponent(components, f, true);
              if (changed) modified = true;
            }
          }
          if (modified) {
            await tx
              .update(prices)
              .set({ pricingData: { ...priceRec.pricingData, components } })
              .where(eq(prices.id, priceRec.id));
            // push updated record
            priceAccumulator.push({
              ...priceRec,
              pricingData: { ...priceRec.pricingData, components },
            });
            console.log("[editPlanInPlace] Price updated", {
              priceId: priceRec.id,
            });
          }
        }

        // Handle creation of missing monthly or yearly price records
        const createMissingFixedPrice = async (
          kind: "monthly" | "annual",
          amountCents: number
        ) => {
          // If we already have a price record that contains the required fixed component we can skip.
          const exists = currentPrices.some((p) =>
            p.pricingData.components?.some((c: any) => {
              if (seatBasedInput) {
                const targetName =
                  kind === "monthly" ? "per_unit_monthly" : "per_unit_yearly";
                return c.component_name === targetName && c.type === "per_unit";
              }
              return c.component_name === kind && c.type === "fixed";
            })
          );
          if (exists) return;

          // Build the mandatory base component first.
          const baseComp: any = (() => {
            if (seatBasedInput) {
              if (kind === "monthly") {
                return {
                  type: "per_unit",
                  component_name: "per_unit_monthly",
                  label: `${planName} - ${formatCurrency(amountCents, defaultCurrency)} per month per seat`,
                  unit_label: "seat",
                  amount_cents: amountCents,
                  ...(input.minSeats &&
                    input.minSeats > 0 && {
                      num_seats: input.minSeats,
                    }),
                  recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
                  bill_immediately:
                    input.billImmediately !== undefined
                      ? input.billImmediately
                      : true,
                };
              } else {
                return {
                  type: "per_unit",
                  component_name: "per_unit_yearly",
                  label: `${planName} - ${formatCurrency(amountCents * 12, defaultCurrency)} per seat per year`,
                  unit_label: "seat",
                  amount_cents: amountCents * 12,
                  ...(input.minSeats &&
                    input.minSeats > 0 && {
                      num_seats: input.minSeats,
                    }),
                  recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1",
                  bill_immediately:
                    input.billImmediately !== undefined
                      ? input.billImmediately
                      : true,
                };
              }
            }
            // Fixed-price fallback (non-seat-based)
            return kind === "monthly"
              ? {
                  type: "fixed",
                  component_name: "monthly",
                  label: `${planName} - ${formatCurrency(amountCents, defaultCurrency)} per month`,
                  amount_cents: amountCents,
                  recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
                  bill_immediately: true,
                }
              : {
                  type: "fixed",
                  component_name: "annual",
                  label: `${planName} - ${formatCurrency(amountCents, defaultCurrency)} × 12 billed yearly`,
                  amount_cents: amountCents * 12,
                  recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1",
                  bill_immediately: true,
                };
          })();

          // Start with the fixed component and append any required usage components so
          // that newly created prices already include them. This ensures that deferred
          // credit definitions can find the matching usage component immediately after
          // the price is created.
          const components: any[] = [baseComp];

          if (input.features) {
            for (const f of input.features) {
              await ensureUsageComponent(components, f);
            }
          }

          const newPrice = await createPrice({
            planId,
            merchantId,
            currency: defaultCurrency,
            pricingData: {
              dsl_version: 1,
              components,
            },
            isOverridePrice: false,
            tx,
          });

          pricesCreated.push(newPrice.id);
          priceAccumulator.push(newPrice);
          console.log("[editPlanInPlace] Price created", {
            kind,
            priceId: newPrice.id,
          });
        };
        if (input.monthlyPrice !== undefined) {
          await createMissingFixedPrice("monthly", input.monthlyPrice);
        }
        if (input.hasYearlyPrice && input.yearlyPrice !== undefined) {
          await createMissingFixedPrice("annual", input.yearlyPrice);
        }
      }

      // Deferred credit definitions that rely on price linkage
      const pricesForLinkage =
        priceAccumulator.length > 0 ? priceAccumulator : currentPrices;

      for (const pending of pendingPriceLinkedCreditDefs) {
        for (const priceRec of pricesForLinkage) {
          console.log("[editPlanInPlace] Processing price", {
            priceId: priceRec.id,
            featureSlug: pending.featureSlug,
          });
          if (priceRec.deletedAt) {
            console.log("[editPlanInPlace] Price with deletedAt, skipping", {
              priceId: priceRec.id,
            });
            continue;
          }
          const matchingComponent = priceRec.pricingData.components.find(
            (c: any) =>
              c.type === "usage" &&
              c.component_name === `usage_${pending.featureSlug}`
          );
          if (!matchingComponent) {
            console.log("[editPlanInPlace] No matching component, skipping", {
              priceId: priceRec.id,
              featureSlug: pending.featureSlug,
            });
            continue;
          }
          const cd = await createCreditDefinition(
            {
              ...pending.creditDefBase,
              priceId: priceRec.id,
              priceComponentId: matchingComponent.component_id,
            },
            tx
          );
          creditsCreated.push(cd.id);
          console.log("[editPlanInPlace] Deferred credit created", {
            featureSlug: pending.featureSlug,
            priceId: priceRec.id,
          });
        }
      }

      // 6. Handle trial plan operations - coordinate with final feature set
      // Collect final feature state after all processing
      const finalFeatureState = await tx.query.planFeatures.findMany({
        where: and(
          eq(planFeatures.planId, planId),
          isNull(planFeatures.deletedAt)
        ),
        with: {
          feature: true,
        },
      });

      const featuresAfterEdit = finalFeatureState.map((pf) => ({
        featureId: pf.featureId,
        slug: pf.featureSlug!,
        isUsageBased: pf.feature.featureType === "number",
      }));

      await handleTrialPlanForEdit(
        currentPlan,
        merchantId,
        input,
        featuresAfterEdit,
        tx
      );

      // Reload plan final state
      const finalPlan = await loadPlanCurrentState(planId, merchantId, tx);
      const transformedPlan = transformPlansWithFeatures([finalPlan.plan])[0];
      const changeAnalysis = {
        hasFeatureChanges,
        hasPriceChanges,
        hasNumericFeatureChanges,
        canUseImmediate: true,
        isNewVersion: false,
      };
      console.log("[editPlanInPlace] Edit complete", { planId });
      // TODO: We're returning some placeholder data here - we should fix it
      return {
        success: true as const,
        plan: transformedPlan,
        plans: [transformedPlan],
        changeAnalysis,
        migrationInfo: {
          activeSubscriptionCount: 0,
          requiresMigration: false,
          affectedSubscriptions: 0,
        },
        resourceActions: {
          featuresReused,
          featuresCreated,
          featuresModified,
          pricesReused: [],
          pricesCreated,
          metricsCreated,
          creditsCreated,
        },
      };
    });
    return result;
  } catch (error) {
    console.error("[editPlanInPlace] Error:", error);
    return {
      error:
        error instanceof Error ? error.message : "Failed to edit plan in place",
    };
  }
}
