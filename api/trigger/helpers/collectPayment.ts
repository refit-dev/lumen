import { z } from "zod";

// Schema for the payment collection payload
export const collectPaymentPayloadSchema = z.object({
  customerId: z.string(),
  subDetails: z
    .array(
      z.object({
        subscriptionId: z.string(),
        subscriptionDetailsId: z.string(),
        nextBillingDate: z.string(),
      })
    )
    .default([]),
});

export type CollectPaymentPayload = z.infer<typeof collectPaymentPayloadSchema>;

export type CollectPaymentResult = {
  success: boolean;
  paymentIntentId?: string;
  invoiceId?: string;
  paymentId?: string;
  status: string;
  message: string;
};

/**
 * Shared payment collection logic that can be used by both Trigger.dev jobs and local code
 */
export async function collectPayment(
  payload: CollectPaymentPayload,
  options: {
    apiUrl: string;
    triggerApiAccessKey: string;
    logger?: {
      info: (message: string, meta?: any) => void;
      warn: (message: string, meta?: any) => void;
      error: (message: string, meta?: any) => void;
    };
  }
): Promise<CollectPaymentResult> {
  const { customerId, subDetails } = payload;
  const { apiUrl, triggerApiAccessKey, logger } = options;

  const subscriptionIds = subDetails.map((detail) => detail.subscriptionId);

  logger?.info(
    `Attempting payment collection for customer ${customerId} with ${subDetails.length} subscription components`,
    {
      subscriptionIds: subscriptionIds.join(", "),
      billingDate: subDetails[0]?.nextBillingDate
        ? subDetails[0].nextBillingDate.split("T")[0]
        : new Date().toISOString().split("T")[0],
    }
  );

  // Create idempotency key based on customer ID and billing date
  const idempotencyKey = `payment-customer-${customerId}-date-${subDetails[0]?.nextBillingDate?.split("T")[0] || new Date().toISOString().split("T")[0]}`;

  try {
    // Call the API endpoint to collect payment
    const response = await fetch(`${apiUrl}/trigger/billing/collect-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${triggerApiAccessKey}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        customerId,
        subDetails,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to collect payment: Status ${response.status}, Response: ${errorText}`
      );
    }

    const responseData = await response.json();

    // Parse the response
    const result = z
      .object({
        success: z.boolean(),
        paymentIntentId: z.string().optional(),
        invoiceId: z.string().optional(),
        paymentId: z.string().optional(),
        status: z.string(),
        message: z.string(),
      })
      .parse(responseData);

    if (result.success) {
      if (result.status === "subscription_deleted") {
        logger?.info(
          `Customer missing; deleted subscription(s) for customer ${customerId}`,
          {
            subscriptionIds: subscriptionIds.join(", "),
            status: result.status,
            message: result.message,
          }
        );
      } else if (result.status === "no_op") {
        logger?.info(
          `No-op for customer ${customerId} (nothing to bill / cleaned up)`,
          {
            subscriptionIds: subscriptionIds.join(", "),
            status: result.status,
            message: result.message,
          }
        );
      } else {
        logger?.info(
          `Successfully initiated payment collection for customer ${customerId}`,
          {
            subscriptionIds: subscriptionIds.join(", "),
            paymentIntentId: result.paymentIntentId,
            invoiceId: result.invoiceId,
            paymentId: result.paymentId,
            status: result.status,
          }
        );
      }
    } else {
      logger?.warn(
        `Payment collection initiated but may require action for customer ${customerId}`,
        {
          subscriptionIds: subscriptionIds.join(", "),
          status: result.status,
          message: result.message,
        }
      );
    }

    return result;
  } catch (error) {
    logger?.error(`Error collecting payment for customer ${customerId}`, {
      error: error instanceof Error ? error.message : String(error),
      subscriptionIds: subscriptionIds.join(", "),
    });

    throw error; // Re-throw to mark the job as failed
  }
}
