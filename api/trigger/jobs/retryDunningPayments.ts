import { schedules, logger } from "@trigger.dev/sdk/v3";
import { triggerEnv } from "../trigger-env";

/**
 * Dunning Payment Retry Job
 *
 * This job runs daily to retry payments for subscriptions in dunning (past_due status).
 * It finds subscriptions that are past_due but still within their grace period
 * and attempts to collect payment on their unpaid invoices.
 *
 * The job calls an API endpoint that:
 * 1. Queries for subscriptions with status='past_due' and gracePeriodEndsAt > now()
 * 2. For each subscription, finds the latest unpaid invoice
 * 3. Attempts payment using existing payment method
 * 4. Logs retry attempts in the payment_retries table
 *
 * Frequency: Daily at 10 AM UTC (can be adjusted)
 * This gives a reasonable retry cadence without being too aggressive
 */
export const retryDunningPaymentsJob = schedules.task({
  id: "retry-dunning-payments",
  // Run daily at 10 AM UTC - adjust cron pattern as needed
  cron: "0 10 * * *",
  run: async (payload) => {
    const currentTimestamp = new Date(payload.timestamp);
    logger.info("Starting dunning payment retry process", {
      timestamp: currentTimestamp,
    });

    try {
      const retryResp = await fetch(
        `${triggerEnv.API_URL}/trigger/billing/dunning/retry-payments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${triggerEnv.TRIGGER_API_ACCESS_KEY}`,
          },
          body: JSON.stringify({
            timestamp: currentTimestamp.toISOString(),
          }),
        }
      );

      if (!retryResp.ok) {
        const txt = await retryResp.text();
        logger.error("Dunning payment retry endpoint returned non-OK", {
          status: retryResp.status,
          body: txt,
        });
      } else {
        const { attempted, succeeded, failed } = (await retryResp.json()) as {
          attempted: number;
          succeeded: number;
          failed: number;
        };

        logger.info("Completed dunning payment retries", {
          attempted,
          succeeded,
          failed,
          successRate:
            attempted > 0
              ? `${Math.round((succeeded / attempted) * 100)}%`
              : "N/A",
        });
      }
    } catch (retryErr) {
      logger.error("Failed to trigger dunning payment retry endpoint", {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    logger.info("Finished dunning payment retry process");
  },
});
