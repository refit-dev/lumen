import { schedules, logger } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { triggerEnv } from "../trigger-env";

// Response validation schema
const expirationResponseSchema = z.object({
  success: z.boolean(),
  expiredCount: z.number(),
  timestamp: z.string(),
  error: z.string().optional(),
});

// Helper function to call our API endpoint with enhanced error handling
async function processCreditExpirations(
  apiUrl: string,
  triggerApiAccessKey: string,
  timestamp: Date
) {
  try {
    const response = await fetch(
      `${apiUrl}/trigger/credits/process-expirations`,
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
        `Failed to process credit expirations: Status ${response.status}, Response: ${errorText}`
      );
    }

    const result = await response.json();

    // Validate response structure
    const validatedResult = expirationResponseSchema.parse(result);

    if (!validatedResult.success && validatedResult.error) {
      throw new Error(`API returned error: ${validatedResult.error}`);
    }

    return validatedResult;
  } catch (error) {
    console.error("Error calling credit expirations API:", error);
    throw error;
  }
}

// Credit expiration job - runs hourly to process expired credits across all types
export const creditExpirationJob = schedules.task({
  id: "credit-expiration",
  cron: "0 * * * *", // Run at the 0th minute of every hour
  run: async (payload) => {
    logger.info("Starting scheduled credit expiration job");

    // Use the scheduled timestamp for more accuracy
    const scheduledTime = new Date(payload.timestamp);
    logger.info(
      `Processing expirations for all credit types as of: ${scheduledTime.toISOString()}`
    );

    try {
      const result = await processCreditExpirations(
        triggerEnv.API_URL,
        triggerEnv.TRIGGER_API_ACCESS_KEY,
        scheduledTime
      );

      logger.info("Credit expiration job completed successfully", {
        expiredCount: result.expiredCount,
        timestamp: result.timestamp,
      });

      return {
        success: true,
        expiredCount: result.expiredCount,
        timestamp: result.timestamp,
        jobType: "scheduled_expiration",
        processedAt: scheduledTime.toISOString(),
      };
    } catch (error) {
      logger.error("Credit expiration job failed", {
        error: error instanceof Error ? error.message : String(error),
        timestamp: scheduledTime.toISOString(),
      });

      // Re-throw to mark job as failed in Trigger.dev
      throw error;
    }
  },
});
