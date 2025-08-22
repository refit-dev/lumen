import { and, eq, isNull } from "drizzle-orm";
import {
  features,
  planFeatures,
  subscriptionFeatures,
  featureMetrics,
} from "@lumen/common/schema";
import { db } from "../db/client";

type DatabaseType = typeof db;

/**
 * Soft deletes a feature and its references in junction tables
 * @param featureId - ID of the feature to delete
 * @param merchantId - ID of the merchant who owns the feature
 * @param db - Database instance or transaction
 * @returns true if deletion was successful
 */
export async function deleteFeatureAndReferences(
  featureId: string,
  merchantId: string,
  db: DatabaseType // NOT a transaction
): Promise<boolean> {
  const currentTimestamp = new Date();

  try {
    await db.transaction(async (tx) => {
      // Soft delete the feature
      await tx
        .update(features)
        .set({
          deletedAt: currentTimestamp,
        })
        .where(
          and(
            eq(features.id, featureId),
            eq(features.merchantId, merchantId),
            isNull(features.deletedAt)
          )
        );

      // Soft delete references in planFeatures
      await tx
        .update(planFeatures)
        .set({
          deletedAt: currentTimestamp,
        })
        .where(
          and(
            eq(planFeatures.featureId, featureId),
            isNull(planFeatures.deletedAt)
          )
        );

      // Soft delete references in subscriptionFeatures
      await tx
        .update(subscriptionFeatures)
        .set({
          deletedAt: currentTimestamp,
        })
        .where(
          and(
            eq(subscriptionFeatures.featureId, featureId),
            isNull(subscriptionFeatures.deletedAt)
          )
        );

      // Soft delete references in featureMetrics
      await tx
        .update(featureMetrics)
        .set({
          deletedAt: currentTimestamp,
        })
        .where(
          and(
            eq(featureMetrics.featureId, featureId),
            isNull(featureMetrics.deletedAt)
          )
        );
    });

    return true;
  } catch (error) {
    console.error("Error deleting feature and references:", error);
    return false;
  }
}
