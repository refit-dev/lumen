import { task, logger } from "@trigger.dev/sdk/v3";
import { triggerEnv } from "../trigger-env";

export interface SubscriptionMigrationPayload {
  subscriptionId: string;
  targetPlanId: string;
  targetPriceId: string;
  merchantId: string;
  strategy: "immediate" | "next_billing_cycle";
}

// Migrate a single subscription. Concurrency limit 1 ensures migrations run sequentially.
export const subscriptionPlanMigrationJob = task({
  id: "subscription-plan-migration",
  queue: {
    name: "plan-migrations",
    concurrencyLimit: 1,
  },
  run: async (payload: SubscriptionMigrationPayload) => {
    const {
      subscriptionId,
      targetPlanId,
      targetPriceId,
      merchantId,
      strategy,
    } = payload;

    logger.info("Migrating subscription", {
      subscriptionId,
      targetPlanId,
      targetPriceId,
      merchantId,
      strategy,
    });

    try {
      const response = await fetch(
        `${triggerEnv.API_URL}/internal/migrations/migrate-subscription`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${triggerEnv.TRIGGER_API_ACCESS_KEY}`,
          },
          body: JSON.stringify({
            subscriptionId,
            targetPlanId,
            targetPriceId,
            strategy,
            merchantId,
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Migration API error: ${response.statusText} - ${text}`
        );
      }

      const result = (await response.json()) as { newSubscriptionId?: string };

      logger.info("Subscription migrated successfully", {
        subscriptionId,
        newSubscriptionId: result.newSubscriptionId,
      });

      return {
        success: true,
        oldSubscriptionId: subscriptionId,
        newSubscriptionId: result.newSubscriptionId,
      };
    } catch (error) {
      logger.error("Failed to migrate subscription", {
        subscriptionId,
        error,
      });
      throw error;
    }
  },
});
