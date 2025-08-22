import { schedules, logger } from "@trigger.dev/sdk/v3";
import { checkBillingDueJob } from "./checkBillingDue";
import { triggerEnv } from "../trigger-env";

// Scheduled changes job - Runs every minute
// This job processes subscription scheduled changes and triggers billing checks
export const applyScheduledChangesJob = schedules.task({
  id: "apply-scheduled-changes",
  cron: triggerEnv.CRON_PATTERN, // every minute on prod, every 30 min on staging (or run manually as needed)
  run: async (payload) => {
    const currentTimestamp = new Date(payload.timestamp);
    logger.info("Starting scheduled changes check", {
      timestamp: currentTimestamp,
    });

    // NEW: Trigger immediate trial migrations via API endpoint
    try {
      const migrationResp = await fetch(
        `${triggerEnv.API_URL}/trigger/billing/migrations/upgrade-trial-subscriptions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${triggerEnv.TRIGGER_API_ACCESS_KEY}`,
          },
        }
      );

      if (!migrationResp.ok) {
        const txt = await migrationResp.text();
        logger.warn("Trial migration endpoint returned non-OK", {
          status: migrationResp.status,
          body: txt,
        });
      } else {
        const { processed } = (await migrationResp.json()) as {
          processed: number;
        };
        logger.info("Processed trial migrations", { processed });
      }
    } catch (mErr) {
      logger.error("Failed to trigger trial migration endpoint", {
        error: mErr instanceof Error ? mErr.message : String(mErr),
      });
    }

    // Note: Scheduled changes during billing are handled after invoice creation.
    // The job continues to trigger billing checks as before.
    logger.info(
      "Scheduled changes are now processed during billing - no action needed"
    );

    logger.info("Finished processing scheduled changes");

    // Check if it's the top of the hour (minute is 0)
    if (currentTimestamp.getMinutes() === 0) {
      logger.info("Top of the hour detected, triggering checkBillingDueJob.");
      // Trigger the billing check job directly
      await checkBillingDueJob.trigger({
        timestamp: currentTimestamp.toISOString(),
      });
    }
  },
});
