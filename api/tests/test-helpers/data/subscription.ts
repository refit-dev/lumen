import { db } from "../../../src/db/client";
import { subscriptions } from "@lumen/common/schema";
import { planFeatures, subscriptionFeatures } from "@lumen/common/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { FeatureSelect } from "../types";
import {
  associateFeaturesWithSubscription,
  createSubscription as createSubscriptionCore,
  SubscriptionFeatureEntryInput,
} from "../../../src/helpers/billing"; // Import the core helper
import type {
  DatabaseType,
  TransactionType,
  FeatureValue,
  Feature, // Import the actual Feature type
} from "../../../src/helpers/index";
import { getPlanFeatures as getPlanFeaturesCore } from "../../../src/helpers/index"; // Import core helper

/**
 * Retrieves features associated with a plan
 */
export async function getPlanFeatures(
  planId: string
): Promise<FeatureSelect[]> {
  // Get features from the plan_features junction table
  const planFeatureEntries = await db.query.planFeatures.findMany({
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
      featureValue: entry.featureValue,
    })) as FeatureSelect[];
}

/**
 * Creates a basic subscription for testing purposes
 * Uses the core createSubscription helper function
 */
export async function createBasicSubscription(
  merchantId: string,
  customerId: string,
  planId: string,
  priceId: string,
  startTimestamp?: Date // Allow optional start timestamp
) {
  // Call the core helper function, mapping priceId to effectivePriceId
  const { subscription } = await createSubscriptionCore({
    merchantId,
    customerId,
    planId,
    effectivePriceId: priceId, // Map to the expected parameter name
    startTimestamp: startTimestamp ?? new Date(),
  });

  return subscription;
}

/**
 * Creates a new version of an existing subscription
 * This is used when we need to update a subscription (append-only pattern)
 */
export async function createSubscriptionNewVersion(
  subscriptionId: string,
  customerId: string,
  merchantId: string,
  planId: string,
  priceId: string,
  overrideFeatures: Feature[] = [],
  dbInstance: DatabaseType | TransactionType = db // Add dbInstance parameter
) {
  // Get the existing subscription
  const existingSubscription = await dbInstance.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscriptionId),
  });

  if (!existingSubscription) {
    throw new Error("Subscription not found");
  }

  // Create a new version of the subscription
  const [newSubscription] = await dbInstance // Use dbInstance
    .insert(subscriptions)
    .values({
      merchantId,
      customerId,
      planId,
      stableSubscriptionId: existingSubscription.stableSubscriptionId,
      versionNumber: Number(existingSubscription.versionNumber) + 1,
      effectivePriceId: priceId,
      startTimestamp: existingSubscription.startTimestamp,
      endTimestamp: existingSubscription.endTimestamp,
    })
    .returning();

  // Get the features associated with the plan using the core helper
  const planFeaturesList = await getPlanFeaturesCore(planId, dbInstance); // Use core helper
  const featuresWithSource: SubscriptionFeatureEntryInput[] =
    planFeaturesList.map((pf) => ({
      id: pf.id,
      slug: pf.slug,
      featureValue: pf.featureValue as FeatureValue,
      source: "plan",
    }));

  // Associate the plan features with the subscription using the core helper
  if (planFeaturesList.length > 0) {
    await associateFeaturesWithSubscription(
      newSubscription.id,
      customerId,
      merchantId,
      featuresWithSource,
      dbInstance
    );
  }

  // Add any override features using the core helper
  if (overrideFeatures.length > 0) {
    const featuresWithSource: SubscriptionFeatureEntryInput[] =
      overrideFeatures.map((f) => ({
        id: f.id,
        slug: f.slug,
        featureValue: f.featureValue as FeatureValue,
        source: "override",
      }));
    await associateFeaturesWithSubscription(
      newSubscription.id,
      customerId,
      merchantId,
      featuresWithSource,
      dbInstance
    );
  }

  return newSubscription;
}

/**
 * Creates a new version of an existing subscription with feature overrides
 */
export async function createSubscriptionWithOverrides(
  subscriptionId: string,
  overrideFeatures: Feature[],
  dbInstance: DatabaseType | TransactionType = db // Pass dbInstance
) {
  // Get the existing subscription
  const existingSubscription = await dbInstance.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscriptionId),
  });

  if (!existingSubscription) {
    throw new Error("Subscription not found");
  }

  // Create a new version with the same plan and price, but with overrides
  return createSubscriptionNewVersion(
    subscriptionId,
    existingSubscription.customerId,
    existingSubscription.merchantId,
    existingSubscription.planId,
    existingSubscription.effectivePriceId,
    overrideFeatures,
    dbInstance // Pass dbInstance
  );
}

/**
 * Adds specific feature overrides to an existing subscription
 * Creates a new version of the subscription with the additional overrides
 */
export async function addSubscriptionFeatureOverrides(
  subscriptionId: string,
  overrideFeatures: Feature[],
  dbInstance: DatabaseType | TransactionType = db // Pass dbInstance
) {
  if (overrideFeatures.length === 0) return null;

  // Get the existing subscription and its features
  const existingSubscription = await dbInstance.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscriptionId),
  });

  if (!existingSubscription) {
    throw new Error("Subscription not found");
  }

  // Get existing override features
  const existingOverridesResult =
    await dbInstance.query.subscriptionFeatures.findMany({
      where: and(
        eq(subscriptionFeatures.subscriptionId, subscriptionId),
        eq(subscriptionFeatures.source, "override"),
        isNull(subscriptionFeatures.deletedAt)
      ),
      with: {
        feature: true,
      },
    });

  // Combine existing overrides with new ones, ensuring proper feature structure
  const combinedOverrides: Feature[] = [
    ...existingOverridesResult
      .filter((override) => override.feature)
      .map((override) => ({
        ...override.feature!,
        featureValue: override.featureValue ?? override.feature!.featureValue,
      })),
    ...overrideFeatures,
  ];

  // Create new version with combined overrides
  return createSubscriptionNewVersion(
    subscriptionId,
    existingSubscription.customerId,
    existingSubscription.merchantId,
    existingSubscription.planId,
    existingSubscription.effectivePriceId,
    combinedOverrides,
    dbInstance // Pass dbInstance
  );
}

/**
 * Removes specific feature overrides from an existing subscription
 * Creates a new version of the subscription without the specified overrides
 */
export async function removeSubscriptionFeatureOverrides(
  subscriptionId: string,
  featureIdsToRemove: string[],
  dbInstance: DatabaseType | TransactionType = db // Pass dbInstance
) {
  if (featureIdsToRemove.length === 0) return null;

  // Get the existing subscription
  const existingSubscription = await dbInstance.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscriptionId),
  });

  if (!existingSubscription) {
    throw new Error("Subscription not found");
  }

  // Get existing override features
  const existingOverridesResult =
    await dbInstance.query.subscriptionFeatures.findMany({
      where: and(
        eq(subscriptionFeatures.subscriptionId, subscriptionId),
        eq(subscriptionFeatures.source, "override"),
        isNull(subscriptionFeatures.deletedAt)
      ),
      with: {
        feature: true,
      },
    });

  // Filter out the features that should be removed, ensuring proper feature structure
  const remainingOverrides: Feature[] = existingOverridesResult
    .filter(
      (override) =>
        override.feature && !featureIdsToRemove.includes(override.featureId)
    )
    .map((override) => ({
      ...override.feature!,
      featureValue: override.featureValue ?? override.feature!.featureValue,
    }));

  // Create new version with remaining overrides
  return createSubscriptionNewVersion(
    subscriptionId,
    existingSubscription.customerId,
    existingSubscription.merchantId,
    existingSubscription.planId,
    existingSubscription.effectivePriceId,
    remainingOverrides,
    dbInstance // Pass dbInstance
  );
}
