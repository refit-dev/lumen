import { schedules, logger } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { triggerEnv } from "../trigger-env";

// Response validation schema
const renewalResponseSchema = z.object({
  success: z.boolean(),
  renewalCount: z.number(),
  errorCount: z.number().optional(),
  timestamp: z.string(),
  error: z.string().optional(),
});

// Helper function to call our API endpoint with proper error handling
async function processGrantRenewals(
  apiUrl: string,
  triggerApiAccessKey: string,
  timestamp: Date
) {
  try {
    const response = await fetch(
      `${apiUrl}/trigger/credits/process-grant-renewals`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({
          timestamp: timestamp.toISOString(),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to process grant renewals: Status ${response.status}, Response: ${errorText}`
      );
    }

    const result = await response.json();

    // Validate response structure
    const validatedResult = renewalResponseSchema.parse(result);

    if (!validatedResult.success && validatedResult.error) {
      throw new Error(`API returned error: ${validatedResult.error}`);
    }

    return validatedResult;
  } catch (error) {
    console.error("Error calling grant renewals API:", error);
    throw error;
  }
}

// Credit renewal job - runs hourly to process grant-centric renewals
export const creditRenewalJob = schedules.task({
  id: "credit-renewal",
  cron: "30 * * * *", // Run at the 30th minute of every hour
  run: async (payload) => {
    logger.info("Starting grant-centric credit renewal job");

    // Use the scheduled timestamp for more accuracy
    const scheduledTime = new Date(payload.timestamp);
    logger.info(
      `Processing grant-based renewals as of: ${scheduledTime.toISOString()}`
    );

    try {
      const result = await processGrantRenewals(
        triggerEnv.API_URL,
        triggerEnv.TRIGGER_API_ACCESS_KEY,
        scheduledTime
      );

      logger.info("Grant-centric credit renewal job completed successfully", {
        renewalCount: result.renewalCount,
        errorCount: result.errorCount || 0,
        timestamp: result.timestamp,
      });

      return {
        success: true,
        renewalCount: result.renewalCount,
        errorCount: result.errorCount || 0,
        timestamp: result.timestamp,
        jobType: "grant_renewal",
        processedAt: scheduledTime.toISOString(),
      };
    } catch (error) {
      logger.error("Grant-centric credit renewal job failed", {
        error: error instanceof Error ? error.message : String(error),
        timestamp: scheduledTime.toISOString(),
      });

      // Re-throw to mark job as failed in Trigger.dev
      throw error;
    }
  },
});
