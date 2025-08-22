import { schedules, logger } from "@trigger.dev/sdk/v3";
import { triggerEnv } from "../trigger-env";
import { z } from "zod";

const ReconcileMetricsCacheResponseSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});

/**
 * Job to periodically reconcile the Redis cache with the Postgres database.
 * This ensures that metric definitions and feature metrics mappings
 * stay in sync between the cache and the database.
 *
 * Runs every 15 minutes to detect and fix any inconsistencies between
 * the Redis cache and the PostgreSQL database.
 */
export const reconcileMetricsCacheJob = schedules.task({
  id: "reconcile-metrics-cache",
  cron: "*/15 * * * *", // Every 15 minutes

  run: async (payload) => {
    const currentTimestamp = new Date(payload.timestamp);
    logger.info("Starting metrics cache reconciliation via API endpoint", {
      timestamp: currentTimestamp,
    });

    try {
      // Call the API endpoint with proper authentication
      const apiUrl = `${triggerEnv.API_URL}/trigger/billing/reconcile-metrics-cache`;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerEnv.TRIGGER_API_ACCESS_KEY}`,
        },
        body: JSON.stringify({
          timestamp: currentTimestamp.toISOString(),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to reconcile cache via API: ${response.status} ${errorText}`
        );
      }

      const result = ReconcileMetricsCacheResponseSchema.parse(
        await response.json()
      );
      logger.info(
        "Successfully completed metrics cache reconciliation via API",
        { result }
      );

      return {
        status: "success",
        message: "Successfully reconciled metrics cache via API endpoint",
        timestamp: currentTimestamp.toISOString(),
        apiResponse: result,
      };
    } catch (error) {
      logger.error("Error during metrics cache reconciliation", { error });
      // Rethrow to trigger Trigger.dev's retry mechanism
      throw error;
    }
  },
});
