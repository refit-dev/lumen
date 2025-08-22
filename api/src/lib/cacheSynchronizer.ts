import { db } from "../db/client";
import { withRedisReconnect } from "./redis";
import { metrics, featureMetrics } from "@lumen/common/schema";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "../helpers/logging";
import { bootstrapMetricDefinitions } from "./metricDefinitions";
import { bootstrapFeatureMetrics } from "./featureMetrics";

// Constants for reconciliation
const LAST_SYNC_KEY = "last_metrics_cache_sync";

/**
 * Verify metric definitions in Redis match the database.
 * Returns counts of missing, extraneous, and mismatched entries.
 * Enhanced with reconnection handling.
 */
async function verifyMetricDefinitionsCache() {
  return await withRedisReconnect(async (redis) => {
    // Only get non-deleted metrics
    const dbMetrics = await db.query.metrics.findMany({
      where: isNull(metrics.deletedAt),
    });

    // Organize metrics by merchant for efficient checking
    const dbMetricsByMerchant = new Map<
      string,
      Map<string, (typeof dbMetrics)[0]>
    >();
    for (const metric of dbMetrics) {
      if (!dbMetricsByMerchant.has(metric.merchantId)) {
        dbMetricsByMerchant.set(metric.merchantId, new Map());
      }
      dbMetricsByMerchant.get(metric.merchantId)!.set(metric.id, metric);
    }

    let missing = 0;
    let extraneous = 0;
    let mismatched = 0;

    // Check each merchant's metrics
    for (const [merchantId, merchantMetrics] of dbMetricsByMerchant.entries()) {
      // Get all metric def keys for this merchant
      const metricKeys = await redis.keys(`metric_def:${merchantId}:*`);
      const redisMetricIds = new Set(
        metricKeys.map((key) => key.split(":")[2]) // Extract ID from key pattern
      );

      // Find missing metrics (in DB but not in Redis)
      for (const [metricId, metric] of merchantMetrics.entries()) {
        if (!redisMetricIds.has(metricId)) {
          missing++;
          logger.warn(
            `Missing metric definition in Redis: ${merchantId}:${metricId}`
          );
          continue;
        }

        // Check for content mismatch
        const defKey = `metric_def:${merchantId}:${metricId}`;
        const redisData = await redis.hGetAll(defKey);

        // Basic validation (could be more thorough)
        if (
          !redisData.name ||
          !redisData.aggregationType ||
          !redisData.eventName ||
          (metric.queryType === "simple" && !redisData.valueType)
        ) {
          mismatched++;
          logger.warn(
            `Mismatched metric definition in Redis: ${merchantId}:${metricId}`
          );
        }
      }

      // Find extraneous metrics (in Redis but not in DB)
      for (const redisId of redisMetricIds) {
        if (!merchantMetrics.has(redisId)) {
          extraneous++;
          logger.warn(`Extraneous metric in Redis: ${merchantId}:${redisId}`);
        }
      }
    }

    return { missing, extraneous, mismatched };
  });
}

/**
 * Verify feature-metric mappings in Redis match the database.
 * Returns counts of missing and extraneous entries.
 * Enhanced with reconnection handling.
 */
async function verifyFeatureMetricsCache() {
  return await withRedisReconnect(async (redis) => {
    // Only get non-deleted feature metrics
    const dbMappings = await db.query.featureMetrics.findMany({
      where: isNull(featureMetrics.deletedAt),
    });

    // Organize mappings by feature for efficient checking
    const dbMappingsByFeature = new Map<string, Set<string>>();
    for (const mapping of dbMappings) {
      const key = `feature_metrics:${mapping.merchantId}:${mapping.featureId}`;
      if (!dbMappingsByFeature.has(key)) {
        dbMappingsByFeature.set(key, new Set());
      }
      dbMappingsByFeature.get(key)!.add(mapping.metricId);
    }

    let missing = 0;
    let extraneous = 0;

    // Get all feature metrics keys
    const featureKeys = await redis.keys("feature_metrics:*");

    // Check all mappings in Redis against DB
    for (const key of featureKeys) {
      const redisMetrics = await redis.sMembers(key);
      const redisSet = new Set(redisMetrics);

      if (!dbMappingsByFeature.has(key)) {
        // This feature doesn't exist in DB at all
        extraneous += redisSet.size;
        logger.warn(`Extraneous feature-metrics mapping in Redis: ${key}`);
        continue;
      }

      const dbSet = dbMappingsByFeature.get(key)!;

      // Find extraneous metrics in Redis
      for (const metricId of redisSet) {
        if (!dbSet.has(metricId)) {
          extraneous++;
          logger.warn(
            `Extraneous metric in Redis feature set ${key}: ${metricId}`
          );
        }
      }

      // Find missing metrics in Redis
      for (const metricId of dbSet) {
        if (!redisSet.has(metricId)) {
          missing++;
          logger.warn(
            `Missing metric in Redis feature set ${key}: ${metricId}`
          );
        }
      }
    }

    // Find completely missing feature sets
    for (const [key, dbSet] of dbMappingsByFeature.entries()) {
      if (!featureKeys.includes(key)) {
        missing += dbSet.size;
        logger.warn(`Missing feature-metrics mapping in Redis: ${key}`);
      }
    }

    return { missing, extraneous };
  });
}

/**
 * Reconcile Redis cache with database for both metric definitions and feature metrics.
 * This fully rebuilds the cache if discrepancies are found.
 * Enhanced with reconnection handling.
 */
async function reconcileMetricsCache() {
  try {
    logger.info("Starting metrics cache reconciliation");

    const metricDefinitionsResult = await verifyMetricDefinitionsCache();
    const featureMetricsResult = await verifyFeatureMetricsCache();

    const totalDiscrepancies =
      metricDefinitionsResult.missing +
      metricDefinitionsResult.extraneous +
      metricDefinitionsResult.mismatched +
      featureMetricsResult.missing +
      featureMetricsResult.extraneous;

    if (totalDiscrepancies > 0) {
      logger.warn(
        `Found ${totalDiscrepancies} cache discrepancies, rebuilding caches`
      );

      // Rebuild both caches
      await bootstrapMetricDefinitions();
      await bootstrapFeatureMetrics();
      logger.info("Successfully rebuilt metrics caches");
    } else {
      logger.info("Metrics caches are in sync with database");
    }

    // Update last sync timestamp
    await withRedisReconnect(async (redis) => {
      await redis.set(LAST_SYNC_KEY, Date.now().toString());
    });
  } catch (error) {
    logger.error("Error during metrics cache reconciliation:", error);
    // Rethrow the error to allow upstream handlers to respond appropriately
    throw error;
  }
}

/**
 * Force an immediate reconciliation of the Redis cache with the database.
 * Enhanced with reconnection handling.
 */
export async function forceReconciliation() {
  logger.info("Forcing immediate cache reconciliation");
  await reconcileMetricsCache();
}
