import { task, logger } from "@trigger.dev/sdk/v3";
import { processBillingCycle } from "../helpers/billing";
import { triggerEnv } from "../trigger-env";

// Billing check job - Triggered by applyScheduledChangesJob
// This job is triggered every hour by the applyScheduledChangesJob
// We can manually trigger this job from the Trigger.dev UI for testing purposes if needed
export const checkBillingDueJob = task({
  id: "check-billing-due",
  // Define the payload schema if needed, using zod for example
  // payload: z.object({ timestamp: z.string().datetime() }),
  run: async (payload: { timestamp: string }) => {
    logger.info("Starting triggered billing check", {
      timestamp: payload.timestamp,
    });

    // Call the core logic
    await processBillingCycle(
      triggerEnv.API_URL,
      triggerEnv.TRIGGER_API_ACCESS_KEY,
      new Date(payload.timestamp) // Pass Date object
    );
  },
});
