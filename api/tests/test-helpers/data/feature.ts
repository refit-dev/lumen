/**
 * Feature helper functions for tests
 */
import { db } from "../../../src/db/client";
import {
  features,
  featuresSelectSchema,
  FeatureType,
  planFeatures,
  subscriptionFeatures,
} from "@lumen/common/schema";
import { FeatureInsert, FeatureUpdate, FeatureSelect } from "../types";
import { z } from "zod";

export type FeatureValue = string | number | boolean;

/**
 * Helper to detect feature type based on value
 */
function detectFeatureType(value: FeatureValue): FeatureType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  throw new Error(`Unsupported feature value type: ${typeof value}`);
}

/**
 * Creates a test feature in the database
 */
export async function createTestFeature({
  merchantId,
  slug = `feature-${Date.now()}`,
  displayName = "Test Feature",
  description = "Test Feature Description",
  featureValue = true,
  featureType,
  isOverrideFeature = false,
}: FeatureUpdate & { merchantId: string; featureType?: FeatureType }) {
  const resolvedFeatureType =
    featureType || detectFeatureType(featureValue as FeatureValue);

  const featureData: FeatureInsert = {
    merchantId,
    slug,
    displayName,
    description,
    featureType: resolvedFeatureType, // Explicitly set feature type
    featureValue,
    isOverrideFeature,
  };

  const [feature] = await db
    .insert(features)
    .values({
      ...featureData,
      featureValue: featureData.featureValue as FeatureValue, // Jsonb typing workaround
    })
    .returning();
  return feature;
}

/**
 * Creates multiple test features for a merchant
 */
export async function createTestFeatures(
  merchantId: string,
  count: number = 3,
  featureDetails?: Partial<FeatureUpdate>[]
) {
  const createdFeatures: (typeof features.$inferSelect)[] = [];
  // If feature details are provided, use them
  if (featureDetails && featureDetails.length > 0) {
    if (featureDetails.length !== count) {
      throw new Error(
        "Number of feature details provided is not equal to the count"
      );
    }
    for (const details of featureDetails) {
      const feature = await createTestFeature({
        merchantId,
        ...details,
      });

      createdFeatures.push(feature);
    }
    return createdFeatures;
  }

  // Otherwise use the default generation logic
  const featureTypes = ["boolean", "number", "string"];

  for (let i = 0; i < count; i++) {
    const featureType = featureTypes[i % featureTypes.length];
    const suffix = i + 1;

    // Generate appropriate default feature value based on type
    let featureValue: FeatureValue;
    switch (featureType) {
      case "boolean":
        featureValue = i % 2 === 0; // alternate true/false
        break;
      case "number":
        featureValue = 10 * (i + 1); // 10, 20, 30, etc.
        break;
      case "string":
        featureValue = ["basic", "standard", "premium"][i % 3]; // cycle through tiers
        break;
      default:
        throw new Error(`Unsupported feature type: ${featureType}`);
    }

    const feature = await createTestFeature({
      merchantId,
      slug: `feature-${featureType}-${suffix}`,
      displayName: `Test ${featureType} Feature ${suffix}`,
      description: `A test ${featureType} feature`,
      featureValue,
    });

    createdFeatures.push(feature);
  }

  return createdFeatures;
}

/**
 * Creates a set of standard features for plans
 */
export async function createStandardPlanFeatures(merchantId: string) {
  const features = [
    await createTestFeature({
      merchantId,
      slug: "max-users",
      displayName: "Maximum Users",
      description: "Maximum number of users allowed",
      featureValue: 10,
    }),
    await createTestFeature({
      merchantId,
      slug: "storage-gb",
      displayName: "Storage (GB)",
      description: "Storage limit in gigabytes",
      featureValue: 100,
    }),
    await createTestFeature({
      merchantId,
      slug: "premium-support",
      displayName: "Premium Support",
      description: "Access to premium support",
      featureValue: true,
    }),
    await createTestFeature({
      merchantId,
      slug: "api-access",
      displayName: "API Access",
      description: "Access to API endpoints",
      featureValue: true,
    }),
  ];

  return features;
}

/**
 * Associates features with a plan using the junction table
 */
export async function associateFeaturesWithPlan(
  planId: string,
  featuresArray: FeatureSelect[]
) {
  // If no features are provided, there's nothing to associate.
  if (!featuresArray || featuresArray.length === 0) {
    return [];
  }

  const planFeatureEntries = featuresArray.map((feature) => ({
    planId,
    featureId: feature.id,
    featureSlug: feature.slug,
    featureValue: feature.featureValue as FeatureValue,
  }));

  const createdEntries = await db
    .insert(planFeatures)
    .values(planFeatureEntries)
    .returning();

  return createdEntries;
}

/**
 * Associates features with a subscription using the junction table
 */
export async function associateFeaturesWithSubscription(
  subscriptionId: string,
  customerId: string,
  merchantId: string,
  featuresArray: FeatureSelect[],
  source: "plan" | "override" = "plan"
) {
  const subscriptionFeatureEntries = featuresArray.map((feature) => ({
    subscriptionId,
    customerId,
    merchantId,
    featureId: feature.id,
    featureSlug: feature.slug,
    featureValue: feature.featureValue as FeatureValue,
    source,
  }));

  const createdEntries = await db
    .insert(subscriptionFeatures)
    .values(subscriptionFeatureEntries)
    .returning();

  return createdEntries;
}
