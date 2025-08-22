import { db } from "../db/client";
import { getRedisClient, withRedisReconnect } from "./redis";
import { metrics } from "@lumen/common/schema";
import { isNull } from "drizzle-orm";
import { logger } from "../helpers/logging";

/**
 * Populate Redis hashes for all metric definitions.
 * Enhanced with reconnection capabilities for Redis.
 */
export async function bootstrapMetricDefinitions() {
  try {
    logger.debug("Starting metric definitions bootstrap");

    await withRedisReconnect(async (redis) => {
      // Before repopulating, clear any existing metric definitions
      const existingDefs = await redis.keys("metric_def:*");
      if (existingDefs.length) {
        await redis.del(existingDefs);
      }

      // Fetch all active metric definitions
      const allMetrics = await db.query.metrics.findMany({
        where: isNull(metrics.deletedAt),
      });

      logger.debug(
        `Bootstrapping ${allMetrics.length} metric definitions to Redis`
      );

      // Populate hashes
      await Promise.all(
        allMetrics.map(async (metric) => {
          const {
            merchantId,
            id,
            name,
            description,
            queryType,
            aggregationType,
            eventName,
            valueType,
            sqlDefinition,
          } = metric;

          const defKey = `metric_def:${merchantId}:${id}`;

          // Create a hash object with non-null values only
          const hashData: Record<string, string> = {
            name: name,
            description: description || "",
            queryType: queryType,
          };

          // Add fields based on metric type
          if (queryType === "simple") {
            if (aggregationType) hashData.aggregationType = aggregationType;
            if (eventName) hashData.eventName = eventName;
            if (valueType) hashData.valueType = valueType;
          } else if (queryType === "indexed" || queryType === "complex") {
            if (sqlDefinition) hashData.sqlDefinition = sqlDefinition;
          }

          // Remove old hash and set new one
          await redis.del(defKey);
          await redis.hSet(defKey, hashData);
        })
      );

      logger.debug("Metric definitions bootstrap completed successfully");
    });
  } catch (error) {
    logger.error("Error bootstrapping metric definitions:", error);
    throw error;
  }
}
