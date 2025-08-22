import { db } from "../db/client";
import { featureMetrics, metrics } from "@lumen/common/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { withRedisReconnect } from "../lib/redis";
import { logger } from "../helpers/logging";

/**
 * Associate a feature with a set of metrics.
 * Upserts the mappings in Postgres and syncs Redis cache.
 * Enhanced with reconnection handling.
 */
export async function addFeatureMetrics(
  merchantId: string,
  featureId: string,
  featureSlug: string,
  metricIds: string[]
) {
  try {
    // Upsert mappings in Postgres
    if (metricIds.length > 0) {
      await db
        .insert(featureMetrics)
        .values(
          metricIds.map((metricId) => ({
            merchantId,
            featureId,
            featureSlug,
            metricId,
          }))
        )
        .onConflictDoNothing({
          target: [
            featureMetrics.merchantId,
            featureMetrics.featureId,
            featureMetrics.metricId,
          ],
        });
    }

    // Sync Redis cache with reconnection support
    await withRedisReconnect(async (redis) => {
      const key = `feature_metrics:${merchantId}:${featureId}`;
      const slugKey = `feature_slug:${merchantId}:${featureId}`;
      await redis.del(key);
      await redis.set(slugKey, featureSlug);
      if (metricIds.length > 0) {
        await redis.sAdd(key, metricIds);
      }
    });
  } catch (error) {
    logger.error(
      `Error adding feature metrics for feature ${featureId}:`,
      error
    );
    throw error;
  }
}

/**
 * Remove all metric associations for a given feature.
 * Soft deletes from Postgres and clears Redis cache.
 * Enhanced with reconnection handling.
 */
export async function removeFeatureMetrics(
  merchantId: string,
  featureId: string
) {
  try {
    await db
      .update(featureMetrics)
      .set({
        deletedAt: new Date(),
      })
      .where(
        and(
          eq(featureMetrics.merchantId, merchantId),
          eq(featureMetrics.featureId, featureId),
          isNull(featureMetrics.deletedAt)
        )
      );

    await withRedisReconnect(async (redis) => {
      const key = `feature_metrics:${merchantId}:${featureId}`;
      const slugKey = `feature_slug:${merchantId}:${featureId}`;
      await redis.del(key);
      await redis.del(slugKey);
    });
  } catch (error) {
    logger.error(
      `Error removing feature metrics for feature ${featureId}:`,
      error
    );
    throw error;
  }
}

/**
 * Metric definition interface that matches the Redis hash format
 */
export interface MetricDefinition {
  id: string;
  name: string;
  description: string;
  queryType: string;
  eventName?: string;
  aggregationType?: string;
  valueType?: string;
  sqlDefinition?: string;
  [key: string]: any; // Allow for additional properties
}

/**
 * Retrieve metric IDs and full definitions associated with a feature.
 * Attempts Redis cache first, then falls back to Postgres.
 * Enhanced with reconnection handling.
 * @returns Array of metric definitions with IDs and full details
 */
export async function getMetricsForFeature(
  merchantId: string,
  featureId: string
): Promise<MetricDefinition[]> {
  return await withRedisReconnect(async (redis) => {
    try {
      const key = `feature_metrics:${merchantId}:${featureId}`;

      // Get metric IDs from Redis set
      const metricIds = await redis.sMembers(key);

      if (metricIds.length > 0) {
        // Fetch all metric definitions in parallel
        const definitionPromises = metricIds.map((id) =>
          redis.hGetAll(`metric_def:${merchantId}:${id}`).then((def) => {
            // If Redis has the definition
            if (def && Object.keys(def).length > 0) {
              return {
                id,
                ...def,
              };
            }
            // Otherwise return null to indicate we need to fetch from DB
            return null;
          })
        );

        const definitions = await Promise.all(definitionPromises);

        // Check if all definitions were found in Redis
        const missingDefinitionIds = definitions
          .map((def, index) => (def === null ? metricIds[index] : null))
          .filter((id) => id !== null) as string[];

        // If all definitions were found in Redis, return them
        if (missingDefinitionIds.length === 0) {
          return definitions as MetricDefinition[];
        }

        // Otherwise, fetch missing definitions from DB
        const dbMetrics = await db.query.metrics.findMany({
          where: and(
            inArray(metrics.id, missingDefinitionIds),
            eq(metrics.merchantId, merchantId),
            isNull(metrics.deletedAt)
          ),
        });

        // Convert DB metrics to our format and cache them in Redis
        for (const metric of dbMetrics) {
          const redisHash = {
            name: metric.name,
            description: metric.description || "",
            queryType: metric.queryType,
            eventName: metric.eventName || "",
            aggregationType: metric.aggregationType || "",
            valueType: metric.valueType || "",
            sqlDefinition: metric.sqlDefinition || "",
          };

          // Cache for future use
          await redis.hSet(`metric_def:${merchantId}:${metric.id}`, redisHash);

          // Replace null placeholder with actual definition
          const index = definitions.findIndex(
            (def) => def === null && missingDefinitionIds.includes(metric.id)
          );
          if (index >= 0) {
            definitions[index] = {
              id: metric.id,
              ...redisHash,
            };
          }
        }

        // Return combined results, filtering out any still-null entries
        return definitions.filter((def) => def !== null) as MetricDefinition[];
      }

      // No IDs in Redis, fallback to Postgres for IDs
      const rows = await db.query.featureMetrics.findMany({
        where: and(
          eq(featureMetrics.merchantId, merchantId),
          eq(featureMetrics.featureId, featureId),
          isNull(featureMetrics.deletedAt)
        ),
      });

      const ids = rows.map((r) => r.metricId);

      if (ids.length === 0) {
        return []; // No metrics associated
      }

      // Cache the IDs in Redis for future lookups
      await redis.sAdd(key, ids);

      // Fetch definitions from Postgres
      const metricsData = await db.query.metrics.findMany({
        where: and(
          inArray(metrics.id, ids),
          eq(metrics.merchantId, merchantId),
          isNull(metrics.deletedAt)
        ),
      });

      // Cache all definitions in Redis and return the result
      const definitions = await Promise.all(
        metricsData.map(async (metric) => {
          const redisHash = {
            name: metric.name,
            description: metric.description || "",
            queryType: metric.queryType,
            eventName: metric.eventName || "",
            aggregationType: metric.aggregationType || "",
            valueType: metric.valueType || "",
            sqlDefinition: metric.sqlDefinition || "",
          };

          // Cache for future use
          await redis.hSet(`metric_def:${merchantId}:${metric.id}`, redisHash);

          return {
            id: metric.id,
            ...redisHash,
          };
        })
      );

      return definitions;
    } catch (error) {
      logger.error(`Error getting metrics for feature ${featureId}:`, error);

      // Fall back to database if Redis fails completely
      try {
        // Get metric IDs
        const rows = await db.query.featureMetrics.findMany({
          where: and(
            eq(featureMetrics.merchantId, merchantId),
            eq(featureMetrics.featureId, featureId),
            isNull(featureMetrics.deletedAt)
          ),
        });

        const ids = rows.map((r) => r.metricId);

        if (ids.length === 0) {
          return []; // No metrics associated
        }

        // Get definitions for those IDs
        const metricsData = await db.query.metrics.findMany({
          where: and(
            inArray(metrics.id, ids),
            eq(metrics.merchantId, merchantId),
            isNull(metrics.deletedAt)
          ),
        });

        // Return without caching in Redis since Redis is failing
        return metricsData.map((metric) => ({
          id: metric.id,
          name: metric.name,
          description: metric.description || "",
          queryType: metric.queryType,
          eventName: metric.eventName || "",
          aggregationType: metric.aggregationType || "",
          valueType: metric.valueType || "",
          sqlDefinition: metric.sqlDefinition || "",
        }));
      } catch (dbError) {
        logger.error(
          `Database fallback also failed for feature ${featureId}:`,
          dbError
        );
        return []; // Return empty array if everything fails
      }
    }
  });
}

/**
 * Populate Redis sets for all feature->metric mappings from the database.
 * Enhanced with reconnection handling.
 */
export async function bootstrapFeatureMetrics() {
  try {
    logger.debug("Starting feature metrics bootstrap");

    const mappings = await db.query.featureMetrics.findMany({
      where: isNull(featureMetrics.deletedAt),
    });
    logger.debug(
      `Bootstrapping ${mappings.length} feature-metric mappings to Redis`
    );

    await withRedisReconnect(async (redis) => {
      // First, delete all existing feature metrics keys
      const existingKeys = await redis.keys("feature_metrics:*");
      const existingSlugKeys = await redis.keys("feature_slug:*");
      if (existingKeys.length > 0) {
        await redis.del(existingKeys);
      }
      if (existingSlugKeys.length > 0) {
        await redis.del(existingSlugKeys);
      }

      // Group mappings by feature
      const groups = new Map<string, string[]>();
      const slugs = new Map<string, string>();
      for (const { merchantId, featureId, metricId, featureSlug } of mappings) {
        const key = `feature_metrics:${merchantId}:${featureId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(metricId);
        slugs.set(`feature_slug:${merchantId}:${featureId}`, featureSlug);
      }

      // Add them back to Redis
      await Promise.all([
        ...Array.from(groups.entries()).map(async ([key, ids]) => {
          await redis.del(key);
          if (ids.length) await redis.sAdd(key, ids);
        }),
        ...Array.from(slugs.entries()).map(async ([key, slug]) => {
          await redis.set(key, slug);
        }),
      ]);
    });

    logger.debug("Feature metrics bootstrap completed successfully");
  } catch (error) {
    logger.error("Error bootstrapping feature metrics:", error);
    throw error;
  }
}

/**
 * Get feature information for a given metric (reverse lookup)
 * Returns featureId and featureSlug for the metric
 */
export async function getFeatureForMetric(
  merchantId: string,
  metricId: string
): Promise<{ featureId: string; featureSlug: string } | null> {
  try {
    const mapping = await db.query.featureMetrics.findFirst({
      where: and(
        eq(featureMetrics.merchantId, merchantId),
        eq(featureMetrics.metricId, metricId),
        isNull(featureMetrics.deletedAt)
      ),
    });

    if (!mapping) {
      return null;
    }

    return {
      featureId: mapping.featureId,
      featureSlug: mapping.featureSlug,
    };
  } catch (error) {
    logger.error(`Error getting feature for metric ${metricId}:`, error);
    return null;
  }
}
