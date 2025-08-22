import { task, logger } from "@trigger.dev/sdk/v3";
import { triggerEnv } from "../trigger-env";
import {
  collectPayment,
  type CollectPaymentPayload,
} from "../helpers/collectPayment";

/**
 * Trigger job to collect payment for subscriptions that are due.
 * This job will:
 * 1. Get the customer's payment method
 * 2. Create an invoice with status "issued"
 * 3. Create a Stripe payment intent
 * 4. Attempt to charge the payment method off-session
 * 5. Return the result
 *
 * The actual invoice status will be updated to "paid" by the webhook
 * when Stripe confirms the payment was successful.
 */
export const collectPaymentJob = task({
  id: "collect-payment",
  run: async (payload: CollectPaymentPayload) => {
    return await collectPayment(payload, {
      apiUrl: triggerEnv.API_URL,
      triggerApiAccessKey: triggerEnv.TRIGGER_API_ACCESS_KEY,
      logger: {
        info: (message: string, meta?: any) => logger.info(message, meta),
        warn: (message: string, meta?: any) => logger.warn(message, meta),
        error: (message: string, meta?: any) => logger.error(message, meta),
      },
    });
  },
});
