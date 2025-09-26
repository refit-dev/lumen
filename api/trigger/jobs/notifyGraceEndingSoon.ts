import { schedules, logger } from "@trigger.dev/sdk/v3";
import { triggerEnv } from "../trigger-env";

export const notifyGraceEndingSoonJob = schedules.task({
  id: "notify-dunning-grace-ending-soon",
  // Run hourly to catch the T-24h window
  cron: "0 * * * *",
  run: async (payload) => {
    const currentTimestamp = new Date(
      (payload as any)?.timestamp ?? new Date()
    );
    logger.info("Starting grace-ending-soon notification job", {
      timestamp: currentTimestamp,
    });

    try {
      const resp = await fetch(
        `${triggerEnv.API_URL}/trigger/billing/dunning/notify-grace-ending-soon`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${triggerEnv.TRIGGER_API_ACCESS_KEY}`,
          },
          body: JSON.stringify({ timestamp: currentTimestamp.toISOString() }),
        }
      );

      if (!resp.ok) {
        const txt = await resp.text();
        logger.error("Notify grace-ending-soon endpoint returned non-OK", {
          status: resp.status,
          body: txt,
        });
      } else {
        const { notified, windowStart, windowEnd } = (await resp.json()) as {
          notified: number;
          windowStart: string;
          windowEnd: string;
        };
        logger.info("Completed grace-ending-soon notifications", {
          notified,
          windowStart,
          windowEnd,
        });
      }
    } catch (err) {
      logger.error("Failed to trigger grace-ending-soon notifications", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
