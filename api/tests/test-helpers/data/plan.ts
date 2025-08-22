/**
 * Plan helper functions for tests
 */
import { db } from "../../../src/db/client";
import { plans, FeatureType } from "@lumen/common/schema";
import { planFeatures } from "@lumen/common/schema";
import {
  PriceSelect,
  PlanInsert,
  PlanUpdate,
  PriceUpdate,
  FeatureSelect,
  PlanSelect,
} from "../types";
import { createTestPrice } from "./price";
import {
  createTestFeature,
  associateFeaturesWithPlan,
  FeatureValue,
} from "./feature";
import {
  getPaymentProvider,
  createDodoClient,
} from "../../../src/helpers/paymentprovider";

/**
 * Feature definition for creating test features
 */
interface FeatureDefinition {
  slug: string;
  displayName: string;
  featureValue: FeatureValue;
  featureType?: FeatureType;
  description?: string;
}

/**
 * Creates a test plan in the database
 */
export async function createTestPlan({
  merchantId,
  planName = "Test Plan",
  planDescription = "Test Plan Description",
  stablePlanId = `plan_${Date.now()}`,
  versionNumber = 1,
  commitMessage = `Test plan: ${planName}`,
}: PlanUpdate & { merchantId: string; id?: string }) {
  let pspPlanId: string | undefined;
  const paymentProvider = await getPaymentProvider(merchantId);
  if (paymentProvider.name === "dodo") {
    const client = await createDodoClient(paymentProvider);
    const product = await client.products.create({
      name: planName,
      description: planDescription,
      price: {
        currency: "USD",
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
    pspPlanId = product.product_id;
  }
  const planData: PlanInsert = {
    merchantId,
    planName,
    planDescription,
    stablePlanId,
    versionNumber,
    commitMessage,
    pspPlanId,
  };

  const [plan] = await db.insert(plans).values(planData).returning();
  return plan;
}

/**
 * Creates a test plan with associated price
 */
export async function createTestPlanWithPrice(
  merchantId: string,
  planOptions: PlanUpdate = {},
  priceOptions: PriceUpdate = {},
  priceId?: string
) {
  // Create plan
  const plan = await createTestPlan({
    merchantId,
    ...planOptions,
  });

  const priceData = {
    dsl_version: 1,
    components: [
      {
        component_name: "base_fee",
        type: "fixed" as const,
        label: "Monthly Subscription Fee",
        amount_cents: 2999,
        recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
        bill_immediately: true,
      },
    ],
  };

  // Create price for the plan
  const price = await createTestPrice({
    id: priceId,
    planId: plan.id,
    merchantId,
    currency: "USD",
    pricingData: priceData,
    isOverridePrice: false,
    ...priceOptions,
  });

  return { plan, price };
}

/**
 * Create features for a plan
 * @param merchantId The merchant ID
 * @param featureDefinitions Features to create
 * @returns An array of created feature objects
 */
export async function createFeaturesForPlan(
  merchantId: string,
  featureDefinitions: FeatureDefinition[]
): Promise<FeatureSelect[]> {
  const createdFeatures: FeatureSelect[] = [];

  for (const feature of featureDefinitions) {
    // Create the feature in the registry
    const createdFeature = await createTestFeature({
      merchantId,
      slug: feature.slug,
      displayName: feature.displayName,
      description:
        feature.description || `Description for ${feature.displayName}`,
      featureValue: feature.featureValue,
      featureType: feature.featureType,
    });

    createdFeatures.push(createdFeature);
  }

  return createdFeatures;
}

/**
 * Creates a plan with features and associates them in the junction table
 */
export async function createTestPlanWithFeatures(
  merchantId: string,
  featureDefinitions: FeatureDefinition[],
  planOptions: Omit<PlanUpdate, "merchantId" | "features"> = {}
) {
  // First create the features in the registry
  const createdFeatures = await createFeaturesForPlan(
    merchantId,
    featureDefinitions
  );

  // Create the plan (without features as they're now in a separate table)
  const plan = await createTestPlan({
    merchantId,
    ...planOptions,
  });

  // Associate features ONLY if features were created
  let planFeatureRelations: (typeof planFeatures.$inferSelect)[] = [];
  if (createdFeatures.length > 0) {
    planFeatureRelations = await associateFeaturesWithPlan(
      plan.id,
      createdFeatures
    );
  }

  return { plan, features: createdFeatures, planFeatureRelations };
}

/**
 * Creates multiple versions of a plan for a merchant
 */
export async function createTestPlanVersionsWithFeatures(
  merchantId: string,
  planOptions: Omit<PlanUpdate, "merchantId"> = {},
  numVersions = 3
) {
  const stablePlanId = planOptions.stablePlanId || `plan_${Date.now()}`;
  const plans: PlanSelect[] = [];

  for (let version = 1; version <= numVersions; version++) {
    // Define features for each version with increasing capabilities
    let features;

    if (version === 1) {
      features = [
        {
          slug: "basic-feature",
          displayName: "Basic Feature",
          featureValue: true,
        },
        { slug: "user-limit", displayName: "User Limit", featureValue: 5 },
        {
          slug: "advanced-feature",
          displayName: "Advanced Feature",
          featureValue: false,
        },
        {
          slug: "pro-feature",
          displayName: "Pro Feature",
          featureValue: false,
        },
      ];
    } else if (version === 2) {
      features = [
        {
          slug: "basic-feature",
          displayName: "Basic Feature",
          featureValue: true,
        },
        { slug: "user-limit", displayName: "User Limit", featureValue: 10 },
        {
          slug: "advanced-feature",
          displayName: "Advanced Feature",
          featureValue: true,
        },
        {
          slug: "pro-feature",
          displayName: "Pro Feature",
          featureValue: false,
        },
      ];
    } else {
      features = [
        {
          slug: "basic-feature",
          displayName: "Basic Feature",
          featureValue: true,
        },
        { slug: "user-limit", displayName: "User Limit", featureValue: 20 },
        {
          slug: "advanced-feature",
          displayName: "Advanced Feature",
          featureValue: true,
        },
        { slug: "pro-feature", displayName: "Pro Feature", featureValue: true },
      ];
    }

    // Create plan with features
    const result = await createTestPlanWithFeatures(merchantId, features, {
      ...planOptions,
      stablePlanId,
      versionNumber: version,
      commitMessage: `Test Plan: v${version} - Added new features`,
    });

    plans.push(result.plan);
  }

  return plans;
}

/**
 * Creates multiple versions of a plan where the pricing is changing
 */
export async function createTestPlanVersionsWithPrices(
  merchantId: string,
  planOptions: PlanUpdate = {},
  priceOptions: Omit<PriceUpdate, "pricingData"> = {},
  numVersions = 3
) {
  const stablePlanId = planOptions.stablePlanId || `plan_${Date.now()}`;
  const plansWithPrices: Array<{ plan: PlanSelect; price: PriceSelect }> = [];

  for (let version = 1; version <= numVersions; version++) {
    const pricingData = {
      dsl_version: 1,
      components: [
        {
          component_name: `base_fee_v${version}`,
          type: "fixed" as const,
          label: `${version === 1 ? "Basic" : version === 2 ? "Standard" : "Premium"} Monthly Fee`,
          amount_cents: version === 1 ? 2999 : version === 2 ? 4999 : 9999,
          recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
          bill_immediately: true,
        },
      ],
    };

    const result = await createTestPlanWithPrice(
      merchantId,
      {
        ...planOptions,
        stablePlanId,
        versionNumber: version,
        commitMessage: `v${version} - Updated features and pricing`,
      },
      {
        ...priceOptions,
        pricingData,
      }
    );
    plansWithPrices.push(result);
  }

  return plansWithPrices;
}

/**
 * Creates a plan using features from the features table
 * First insert a row in the features table and then use that
 * row data to call this function with `features` as the row
 */
export async function createPlanWithDefinedFeatures(
  merchantId: string,
  features: FeatureSelect[],
  planOptions: Omit<PlanUpdate, "merchantId"> = {},
  priceOptions: Omit<PriceUpdate, "planId" | "merchantId"> = {}
) {
  // Create the plan (without features field)
  const plan = await createTestPlan({
    merchantId,
    ...planOptions,
  });

  // Associate features with the plan using the junction table
  await associateFeaturesWithPlan(plan.id, features);

  // Default price options with DSL format if not provided
  const defaultPriceOptions = {
    currency: "USD",
    pricingData: {
      dsl_version: 1,
      components: [
        {
          component_name: "base_fee",
          type: "fixed" as const,
          label: "Monthly Subscription Fee",
          amount_cents: 2999,
          recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
          bill_immediately: true,
        },
      ],
    },
  };

  const price = await createTestPrice({
    planId: plan.id,
    merchantId,
    ...defaultPriceOptions,
    ...priceOptions,
  });

  return { plan, price };
}

/**
 * Creates multiple different plans for a merchant
 */
export async function createMultiplePlans(
  merchantId: string,
  count: number = 3
) {
  const plans: PlanSelect[] = [];

  for (let i = 0; i < count; i++) {
    const suffix = i + 1;

    // Define features for this plan using array format
    const features = [
      {
        slug: "basic-feature",
        displayName: "Basic Feature",
        featureValue: true,
      },
      {
        slug: "user-limit",
        displayName: "User Limit",
        featureValue: 5 + i * 5,
      },
      { slug: "tier", displayName: "Tier", featureValue: i + 1 },
      {
        slug: "support-level",
        displayName: "Support Level",
        featureValue: ["basic", "standard", "premium"][i % 3],
      },
      {
        slug: "storage-gb",
        displayName: "Storage GB",
        featureValue: 50 * (i + 1),
      },
    ];

    // Create plan with features using the junction table approach
    const result = await createTestPlanWithFeatures(merchantId, features, {
      planName: `Test Plan ${suffix}`,
      planDescription: `Description for Test Plan ${suffix}`,
      stablePlanId: `plan_tier_${suffix}_${Date.now()}`,
    });

    plans.push(result.plan);
  }

  return plans;
}
