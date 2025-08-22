import { logger } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { collectPaymentJob } from "../jobs/collectPayment";

// Response schema for check-due endpoint
const checkDueResponseSchema = z.object({
  subscriptionsDue: z.array(
    z.object({
      subscriptionId: z.string(),
      subscriptionDetailsId: z.string(),
      customerId: z.string(),
      nextBillingDate: z.string(),
    })
  ),
});

/**
 * Processes the billing cycle by checking for due subscriptions and initiating payment collection.
 * Once payments are collected, the webhook handler will generate the invoice.
 *
 * @param apiUrl The base URL of the API.
 * @param triggerApiAccessKey The secret key for authorizing API calls.
 * @param checkUptoDueDate The timestamp upto which we check for due subscriptions. Optional, defaults to current UTC time.
 * @returns An object containing the count of subscriptions checked and processed, along with the detailed billing results.
 */
export async function processBillingCycle(
  apiUrl: string,
  triggerApiAccessKey: string,
  checkUptoDueDate?: Date
) {
  // Call our API endpoint to check for due subscriptions
  const checkDueResponse = await fetch(`${apiUrl}/trigger/billing/check-due`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${triggerApiAccessKey}`,
    },
    body: JSON.stringify({
      timestamp: checkUptoDueDate?.toISOString() || new Date().toISOString(),
    }),
  });

  if (!checkDueResponse.ok) {
    const errorText = await checkDueResponse.text();
    throw new Error(
      `Failed to check due subscriptions: Status ${checkDueResponse.status}, Response: ${errorText}`
    );
  }

  const { subscriptionsDue } = checkDueResponseSchema.parse(
    await checkDueResponse.json()
  );

  logger.info(
    `Found ${subscriptionsDue.length} subscription-details due for billing`
  );

  if (subscriptionsDue.length === 0) {
    logger.info("Nothing due for billing. Exiting.");
    return {
      subscriptionsProcessed: 0,
      batchRuns: 0,
    };
  }

  try {
    // Group subscriptions by customerId + date YYYY-MM-DD
    const grouped: Record<
      string,
      {
        customerId: string;
        subDetails: Array<{
          subscriptionId: string;
          subscriptionDetailsId: string;
          nextBillingDate: string;
        }>;
      }
    > = {};

    // Add subDetails
    for (const sub of subscriptionsDue) {
      const key = `${sub.customerId}_${sub.nextBillingDate.split("T")[0]}`;
      if (!grouped[key]) {
        grouped[key] = {
          customerId: sub.customerId,
          subDetails: [],
        };
      }
      grouped[key].subDetails.push({
        subscriptionId: sub.subscriptionId,
        subscriptionDetailsId: sub.subscriptionDetailsId,
        nextBillingDate: sub.nextBillingDate,
      });
    }

    const batchItems = Object.values(grouped).map((g) => ({
      payload: {
        customerId: g.customerId,
        subDetails: g.subDetails,
      },
    }));

    console.log(
      `Created ${batchItems.length} batch items (customer-date groups)`
    );

    const batchResponse = await collectPaymentJob.batchTrigger(batchItems);

    console.log(`Successfully initiated batch payment collection`, {
      batchId: batchResponse.batchId,
      totalJobs: batchResponse.runs.length,
    });

    return {
      subscriptionsProcessed: subscriptionsDue.length,
      batchRuns: batchResponse.runs.length,
    };
  } catch (error) {
    console.error(`Failed to batch trigger payment collection jobs`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      subscriptionsProcessed: 0,
      batchRuns: 0,
    };
  }
}
