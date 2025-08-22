import { task, logger } from "@trigger.dev/sdk/v3";
import { triggerEnv } from "../trigger-env";

export interface BackfillPayload {
  batchSize?: number;
  cutoffSeconds?: number;
  merchantId?: string;
}

// Trigger.dev task that calls the internal API endpoint responsible for backfilling events.
export const backfillQuestDbEventsJob = task({
  id: "backfill-questdb-events",
  run: async (payload: BackfillPayload = {}) => {
    const requestBody = {
      batchSize: payload.batchSize ?? 500,
      cutoffSeconds: payload.cutoffSeconds ?? 60,
      merchantId: payload.merchantId,
    };

    logger.info("Calling /trigger/events-backfill endpoint", requestBody);

    const response = await fetch(
      `${triggerEnv.API_URL}/trigger/events-backfill`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerEnv.TRIGGER_API_ACCESS_KEY}`,
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Backfill API request failed: ${response.status} - ${text}`
      );
    }

    const result = await response.json();
    logger.info("Backfill API completed", {
      result,
    });
    return result;
  },
});
