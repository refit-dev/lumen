import {
  describe,
  it,
  beforeAll,
  afterAll,
  expect,
  afterEach,
  beforeEach,
  spyOn,
} from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestStripe,
  createTestCustomer,
  cleanupDataFull,
} from "../test-helpers";
import { testEnv } from "../test-env";
import { db } from "../../src/db/client";
import Stripe from "stripe";
import {
  customers,
  invoices,
  payments,
  paymentMethods,
  invoiceLineItems,
  subscriptionDetails,
} from "@lumen/common/schema";
import { eq, and, ne, sql } from "drizzle-orm";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { setTimeout as sleep } from "timers/promises";
import path from "path";
import { processBillingCycle } from "../../trigger/helpers/billing";
import {
  collectPaymentJob,
  collectPaymentPayloadSchema,
} from "../../trigger/jobs/collectPayment";
import { env } from "../../src/env";
import { z } from "zod";

type CollectPaymentJobPayload = z.infer<typeof collectPaymentPayloadSchema>;

// Define the type for batch items
type BatchItem = { payload: CollectPaymentJobPayload };

// Define the type for the mock run result
type MockRunResult = {
  id: string;
  status: "SUCCESS" | "FAILURE";
  output?: {
    success: boolean;
    paymentIntentId?: string;
    invoiceId?: string;
    paymentId?: string;
    status: string;
    message: string;
  };
  error?: string;
  payload: CollectPaymentJobPayload;
};

describe("Recurring Payment Flow", () => {
  let merchantId: string;
  let sessionToken: string;
  let apiUrl: string;
  let triggerApiAccessKey: string;
  let stripeSecretKey: string;
  let stripePublicKey: string;
  let stripeWebhookSecret: string;
  let stripeClient: Stripe;
  let webhookProcess: ChildProcess | null = null;
  const tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  const tempMerchantIdFile = "/tmp/test_merchant_id.txt";

  let collectPaymentJobTriggerSpy: ReturnType<typeof spyOn>;

  // Helper function to find the Stripe CLI
  async function findStripeCLI(): Promise<string | null> {
    try {
      const proc = await Bun.spawn(["which", "stripe"], { stdout: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const result = stdout.trim();
      if (result) return result;
    } catch (e) {
      /* ignore */
    }

    const possiblePaths = [
      "/usr/local/bin/stripe",
      "/opt/homebrew/bin/stripe",
      path.join(process.env.HOME || "", ".local/bin/stripe"),
      process.env.STRIPE_CLI_PATH, // Allow overriding via env var
    ];
    for (const p of possiblePaths) {
      if (!p) continue;
      try {
        await fs.access(p, fs.constants.X_OK);
        return p;
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  const cleanupWebhook = async () => {
    if (webhookProcess && !webhookProcess.killed) {
      console.log("Cleaning up recurring payment webhook process...");
      webhookProcess.kill("SIGINT"); // Send SIGINT for graceful shutdown
      await new Promise((resolve) => webhookProcess!.on("close", resolve));
      webhookProcess = null;
      try {
        await fs.unlink(tempWebhookSecretFile);
        await fs.unlink(tempMerchantIdFile);
      } catch (err) {
        /* ignore */
      }
    }
  };

  beforeAll(async () => {
    apiUrl = env.API_URL;
    triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY!;
    stripeSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
    stripePublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;
    stripeWebhookSecret = testEnv.TEST_STRIPE_WEBHOOK_SECRET;

    if (
      !apiUrl ||
      !triggerApiAccessKey ||
      !stripeSecretKey ||
      !stripePublicKey ||
      !stripeWebhookSecret
    ) {
      throw new Error(
        "Required environment variables not set for recurring payment tests"
      );
    }

    stripeClient = new Stripe(stripeSecretKey, {
      apiVersion: "2025-02-24.acacia",
    });

    // Setup global merchant for these tests (can be overridden in beforeEach if needed)
    const { merchant: globalMerchant, user: globalUser } =
      await createFullTestEnvironment();
    merchantId = globalMerchant.id; // Set the global merchantId

    await fs.writeFile(tempMerchantIdFile, merchantId); // Write the correct merchantId

    const authResponse = await authenticateTestUser(
      globalUser.email,
      globalUser.password
    );
    sessionToken = authResponse.cookies.sessionToken;

    await createTestStripe({
      merchantId,
      secretKey: stripeSecretKey,
      publicKey: stripePublicKey,
      webhookSecret: stripeWebhookSecret,
    });

    const stripeCLIPath = await findStripeCLI();
    if (stripeCLIPath) {
      // Get live webhook secret from `stripe listen --print-secret`
      const secretProc = Bun.spawnSync([
        stripeCLIPath,
        "listen",
        "--print-secret",
        "--api-key",
        stripeSecretKey,
      ]);
      if (secretProc.exitCode === 0) {
        const liveWebhookSecret = secretProc.stdout.toString().trim();
        await fs.writeFile(tempWebhookSecretFile, liveWebhookSecret); // Use this live secret
        console.log(
          `Saved live webhook secret to ${tempWebhookSecretFile} for merchant ${merchantId}`
        );

        webhookProcess = spawn(
          stripeCLIPath,
          [
            "listen",
            "--forward-to",
            `${apiUrl}/public/webhook/${merchantId}`, // Use the specific merchantId
            "--api-key",
            stripeSecretKey,
            "--events",
            "payment_intent.succeeded,payment_intent.payment_failed", // Listen to specific events
          ],
          { detached: true, stdio: "ignore" }
        );
        console.log(
          `Recurring payment webhook listener started with PID ${webhookProcess.pid} for merchant ${merchantId}`
        );
        await sleep(2000); // Give listener time to start
      } else {
        console.error("Failed to get live webhook secret:", secretProc.stderr);
        console.warn(
          "Stripe CLI --print-secret failed. Webhook listener may not use the correct secret."
        );
      }
    } else {
      console.warn(
        "Stripe CLI not found, live webhook tests will likely fail."
      );
    }
  });

  afterAll(async () => {
    // Clean up the webhook process
    await cleanupDataFull({ deleteTestSetupData: true });
    await cleanupWebhook();
  });

  beforeEach(async () => {
    // Spies are reset here
    collectPaymentJobTriggerSpy = spyOn(collectPaymentJob, "batchTrigger");
  });

  afterEach(async () => {
    if (collectPaymentJobTriggerSpy) collectPaymentJobTriggerSpy.mockRestore();
    await cleanupDataFull();
  });

  it("should process a recurring payment for a single fixed-price component", async () => {
    // 1. Create Plan & Price (non-immediate billing)
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        planName: "Recurring Test Plan",
      }
    );
    const testPlanId = planCreationResult.plan.id;
    const testPrice = await createTestPrice({
      planId: testPlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Monthly Recurring Fee",
            amount_cents: 2500, // $25.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // 2. Create Customer & Stripe Customer
    const customerEmail = `recurring-${Date.now()}@example.com`;
    const localCustomer = await createTestCustomer({
      merchantId,
      email: customerEmail,
      name: "Recurring Test Cust",
    });
    const testCustomerId = localCustomer.id;
    const stripeApiCustomer = await stripeClient.customers.create({
      email: customerEmail,
      name: "Recurring Test Stripe Customer",
      metadata: { lumenCustomerId: testCustomerId },
    });
    await db
      .update(customers)
      .set({ pspCustomerId: stripeApiCustomer.id })
      .where(eq(customers.id, testCustomerId));

    // 3. Create Payment Method (Stripe & Local)
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeApiCustomer.id,
    });
    const [dbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: testCustomerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeApiCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // 4. Create Subscription & link Payment Method
    const apiClient = createTestApiClient(sessionToken); // Use global sessionToken
    const subscriptionStartDate = new Date();
    subscriptionStartDate.setUTCMonth(subscriptionStartDate.getUTCMonth() - 2); // Start 2 months ago to ensure due

    const createSubResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: testCustomerId,
        planId: testPlanId,
        effectivePriceId: testPriceId,
        startTimestamp: subscriptionStartDate.toISOString(),
      },
    });
    const createSubBody = await createSubResponse.json();
    if ("error" in createSubBody)
      throw new Error(`Sub creation failed: ${createSubBody.error}`);
    if (!createSubBody.subscription)
      throw new Error("No subscription returned from creation");
    const testSubscriptionId = createSubBody.subscription.id;

    // Link payment method to subscription details
    await db
      .update(subscriptionDetails)
      .set({ paymentMethodId: dbPaymentMethod.id })
      .where(eq(subscriptionDetails.subscriptionId, testSubscriptionId));

    // 5. Set SubscriptionDetail nextBillingDate to be due
    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, testSubscriptionId),
    });
    if (!subDetail) throw new Error("Subscription detail not found");

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1); // Yesterday
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: dueDate })
      .where(eq(subscriptionDetails.id, subDetail.id));

    // 6. Mock collectPaymentJob.batchTrigger
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        const customerData = await db.query.customers.findFirst({
          where: eq(customers.id, currentCustomerId),
        });
        if (!customerData?.pspCustomerId)
          throw new Error("Stripe customer ID not found for mock payment");

        const subDetailForPayment =
          await db.query.subscriptionDetails.findFirst({
            where: eq(
              subscriptionDetails.id,
              currentSubDetails[0].subscriptionDetailsId
            ),
            with: { paymentMethod: true },
          });
        if (!subDetailForPayment?.paymentMethod?.externalPspPaymentMethodId)
          throw new Error("Stripe PM ID not found for mock payment");

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

        console.log(
          `Mock collectPaymentJob.batchTrigger calling /collect-payment for customer ${currentCustomerId}`
        );

        try {
          // Call the actual API endpoint
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

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

          if (response.ok && result.success) {
            console.log(
              `Test Stripe PaymentIntent ${result.paymentIntentId} created and confirmed.`
            );
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                } satisfies MockRunResult,
              ],
            };
          } else {
            console.error(
              `Mock API call to /collect-payment failed: Status ${response.status}, Response: ${JSON.stringify(responseData)}`
            );
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                } satisfies MockRunResult,
              ],
            };
          }
        } catch (error) {
          console.error(
            `Mock fetch error: ${error instanceof Error ? error.message : String(error)}`
          );
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              } satisfies MockRunResult,
            ],
          };
        }
      }
    );

    // 7. Call processBillingCycle
    console.log("Processing billing cycle...");
    const processBillingResult = await processBillingCycle(
      apiUrl,
      triggerApiAccessKey,
      new Date()
    );
    console.log("processBillingResult", processBillingResult);
    // 8. Wait for stripe webhook to be called
    await sleep(2500);

    // 9. Assertions
    expect(processBillingResult.subscriptionsProcessed).toBe(1);
    expect(collectPaymentJobTriggerSpy).toHaveBeenCalledTimes(1);
    const callPayload = collectPaymentJobTriggerSpy.mock
      .calls[0][0] as BatchItem[];
    expect(callPayload[0].payload.customerId).toBe(testCustomerId);
    expect(callPayload[0].payload.subDetails[0].subscriptionId).toBe(
      testSubscriptionId
    );
    expect(callPayload[0].payload.subDetails[0].subscriptionDetailsId).toBe(
      subDetail.id
    );

    // DB Assertions (Invoice, Payment, SubscriptionDetail update)
    const createdInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.customerId, testCustomerId),
        eq(invoices.subscriptionId, testSubscriptionId),
        ne(invoices.status, "deleted")
      ),
    });
    expect(createdInvoice).toBeDefined();
    expect(createdInvoice!.status).toBe("paid");
    expect(createdInvoice!.totalAmountCents).toBe(2500);

    const invoiceItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, createdInvoice!.id),
    });
    expect(invoiceItems.length).toBe(2); // 1 for the subscription, 1 for the tax
    expect(invoiceItems[0].subtotalCents).toBe(2500);

    const dbPayment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, createdInvoice!.id),
    });
    expect(dbPayment).toBeDefined();
    expect(dbPayment!.status).toBe("succeeded");
    expect(dbPayment!.amountCents).toBe(2500);
    expect(dbPayment!.paymentMethodId).toBe(dbPaymentMethod.id);
    expect(dbPayment!.externalPaymentId).toMatch(/^pi_/); // Stripe Payment Intent ID

    const updatedSubDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.id, subDetail.id),
    });
    expect(updatedSubDetail!.cyclesBilled).toBe(
      (subDetail.cyclesBilled || 0) + 1
    );
    expect(updatedSubDetail!.nextBillingDate.getTime()).toBeGreaterThan(
      dueDate.getTime()
    );
    expect(
      updatedSubDetail!.previousBillingDate!.toISOString().slice(0, 10)
    ).toBe(dueDate.toISOString().slice(0, 10));
  }, 30000);

  it("should process a recurring payment for multiple price components (fixed, per-unit, usage)", async () => {
    // 1. Create Plan with a Price having 3 components (fixed, per_unit, usage)
    const planMultipleResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        planName: "Recurring Multi-Component Plan",
      }
    );
    const multiPlanId = planMultipleResult.plan.id;

    // Create a metric for the usage component
    const { createTestMetric } = await import("../test-helpers/data/metrics");
    const metricResponse = await createTestMetric({
      merchantId,
      name: "Recurring API Calls Metric",
      description: "Metric for recurring usage billing test",
      queryType: "simple",
      aggregationType: "SUM",
      valueType: "NUMERIC",
      eventName: "recurring.api.call",
    });
    if (!metricResponse || !metricResponse.id)
      throw new Error("Failed to create metric for usage component");
    const usageMetricId = metricResponse.id;

    const multiPrice = await createTestPrice({
      planId: multiPlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Monthly Base",
            amount_cents: 1500, // $15.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=10",
            bill_immediately: false,
          },
          {
            type: "per_unit",
            label: "Seats",
            unit_label: "Seat",
            amount_cents: 500, // $5.00 per seat
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=10",
            bill_immediately: false,
          },
          {
            type: "usage",
            label: "API Calls",
            unit_label: "Call",
            metric_id: usageMetricId,
            unit_cost_cents: 2, // $0.02 per call
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=10",
            bill_immediately: false,
          },
        ],
      },
    });
    const multiPriceId = multiPrice.id;

    // 2. Create Customer, Stripe Customer, and Payment Method
    const multiCustomerEmail = `recurring-multi-${Date.now()}@example.com`;
    const multiLocalCustomer = await createTestCustomer({
      merchantId,
      email: multiCustomerEmail,
      name: "Recurring Multi Cust",
    });
    const multiTestCustomerId = multiLocalCustomer.id;
    const multiStripeApiCustomer = await stripeClient.customers.create({
      email: multiCustomerEmail,
      name: "Recurring Multi Stripe Cust",
      metadata: { lumenCustomerId: multiTestCustomerId },
    });
    await db
      .update(customers)
      .set({ pspCustomerId: multiStripeApiCustomer.id })
      .where(eq(customers.id, multiTestCustomerId));

    const multiStripePm = await stripeClient.paymentMethods.attach(
      "pm_card_visa",
      { customer: multiStripeApiCustomer.id }
    );
    const [multiDbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: multiTestCustomerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: multiStripePm.id,
        externalPspCustomerId: multiStripeApiCustomer.id,
        cardLastFour: multiStripePm.card?.last4,
        cardBrand: multiStripePm.card?.brand,
      })
      .returning();

    // 3. Create Subscription for this customer with the multi-component price
    const apiClient = createTestApiClient(sessionToken);
    const subStartDate = new Date();
    subStartDate.setUTCMonth(subStartDate.getUTCMonth() - 2); // Start 2 months ago

    const createMultiSubResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: multiTestCustomerId,
        planId: multiPlanId,
        effectivePriceId: multiPriceId,
        startTimestamp: subStartDate.toISOString(),
      },
    });
    const createMultiSubBody = await createMultiSubResponse.json();
    if ("error" in createMultiSubBody)
      throw new Error(`Multi-Sub creation failed: ${createMultiSubBody.error}`);
    if (!createMultiSubBody.subscription)
      throw new Error("No subscription returned from multi-component creation");
    const multiTestSubscriptionId = createMultiSubBody.subscription.id;

    // Link Payment Method to all subscription details
    await db
      .update(subscriptionDetails)
      .set({ paymentMethodId: multiDbPaymentMethod.id })
      .where(eq(subscriptionDetails.subscriptionId, multiTestSubscriptionId));

    // 4. Create usage data (events) for the usage-based component
    const usageAmount = 75; // 75 API calls
    const usageEventTimestamp = new Date();
    usageEventTimestamp.setUTCMonth(usageEventTimestamp.getUTCMonth() - 1); // Usage occurred last month

    const usageEventPayload = {
      eventName: "recurring.api.call",
      customerId: multiTestCustomerId,
      idempotencyKey: `recurring-usage-${Date.now()}`,
      eventTimestamp: usageEventTimestamp.toISOString(),
      eventValue: usageAmount,
    };
    const usageEventResponse = await apiClient.events.$post({
      json: usageEventPayload,
    });
    expect(usageEventResponse.status).toBe(202);
    await sleep(500); // Wait for event to be processed by potential async workers

    // 5. Set all component SubscriptionDetail nextBillingDate to be due
    const allSubDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, multiTestSubscriptionId),
    });
    expect(allSubDetails.length).toBe(3); // Ensure all 3 components details are there

    const dueBillingDate = new Date();
    dueBillingDate.setDate(dueBillingDate.getDate() - 1); // Yesterday
    for (const detail of allSubDetails) {
      await db
        .update(subscriptionDetails)
        .set({ nextBillingDate: dueBillingDate })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // Mock collectPaymentJob.batchTrigger
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        console.log(
          `Mock collectPaymentJob.batchTrigger called for ${batchItems.length} batch items.`
        );
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        const customerData = await db.query.customers.findFirst({
          where: eq(customers.id, currentCustomerId),
        });
        if (!customerData?.pspCustomerId)
          throw new Error(
            "Stripe customer ID not found for mock payment (multi-component)"
          );

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

        console.log(
          `Mock collectPaymentJob.batchTrigger calling /collect-payment for multi-component customer ${currentCustomerId}`
        );

        try {
          // Call the actual API endpoint
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

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

          if (response.ok && result.success) {
            console.log(
              `Mock Stripe PaymentIntent ${result.paymentIntentId} created and confirmed for multi-component.`
            );
            return {
              batchId: `mock-batch-multi-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-multi-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                } satisfies MockRunResult,
              ],
            };
          } else {
            console.error(
              `Mock API call to /collect-payment failed for multi-component: Status ${response.status}, Response: ${JSON.stringify(responseData)}`
            );
            return {
              batchId: `mock-batch-multi-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-multi-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                } satisfies MockRunResult,
              ],
            };
          }
        } catch (error) {
          console.error(
            `Mock fetch error for multi-component: ${error instanceof Error ? error.message : String(error)}`
          );
          return {
            batchId: `mock-batch-multi-${Date.now()}`,
            runs: [
              {
                id: `mock-run-multi-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              } satisfies MockRunResult,
            ],
          };
        }
      }
    );

    // Call processBillingCycle
    const processResult = await processBillingCycle(
      apiUrl,
      triggerApiAccessKey,
      new Date()
    );
    // Wait for webhook processing
    console.log("Waiting for webhook to process multi-component payment...");
    await sleep(5000); // Increased wait for multi-component webhook

    expect(processResult.subscriptionsProcessed).toBe(3); // Processed as one batch for the customer
    expect(processResult.batchRuns).toBe(1); // Processed as one batch for the customer

    // Assertions
    expect(collectPaymentJobTriggerSpy).toHaveBeenCalledTimes(1);
    const batchCallPayload = collectPaymentJobTriggerSpy.mock
      .calls[0][0] as BatchItem[];
    expect(batchCallPayload[0].payload.customerId).toBe(multiTestCustomerId);
    expect(batchCallPayload[0].payload.subDetails.length).toBe(3); // All 3 components should be in the call

    const detailIdsInCall = batchCallPayload[0].payload.subDetails
      .map((sd) => sd.subscriptionDetailsId)
      .sort();
    const expectedDetailIds = allSubDetails.map((d) => d.id).sort();
    expect(detailIdsInCall).toEqual(expectedDetailIds);

    // DB Assertions
    const createdInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.customerId, multiTestCustomerId),
        eq(invoices.subscriptionId, multiTestSubscriptionId),
        ne(invoices.status, "deleted")
      ),
      with: { lineItems: true },
    });
    expect(createdInvoice).toBeDefined();
    expect(createdInvoice!.status).toBe("paid");
    expect(createdInvoice!.lineItems.length).toBe(4); // 1 for the subscription, 1 for the tax, 3 for the usage

    let expectedTotalCents = 0;
    const fixedComp = multiPrice.pricingData.components.find(
      (c) => c.type === "fixed"
    )!;
    const perUnitComp = multiPrice.pricingData.components.find(
      (c) => c.type === "per_unit"
    )!;
    const usageComp = multiPrice.pricingData.components.find(
      (c) => c.type === "usage"
    )!;

    expectedTotalCents += fixedComp.amount_cents;
    expectedTotalCents += perUnitComp.amount_cents * 1; // Assuming quantity 1
    expectedTotalCents += usageComp.unit_cost_cents * usageAmount;

    expect(createdInvoice!.totalAmountCents).toBe(expectedTotalCents);

    for (const item of createdInvoice!.lineItems) {
      if (item.description === fixedComp.label)
        expect(item.subtotalCents).toBe(fixedComp.amount_cents);
      if (item.description === perUnitComp.label)
        expect(item.subtotalCents).toBe(perUnitComp.amount_cents * 1);
      if (item.description === usageComp.label)
        expect(item.subtotalCents).toBe(
          usageComp.unit_cost_cents * usageAmount
        );
    }

    const dbPayment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, createdInvoice!.id),
    });
    expect(dbPayment).toBeDefined();
    expect(dbPayment!.status).toBe("succeeded");
    expect(dbPayment!.amountCents).toBe(expectedTotalCents);
    expect(dbPayment!.externalPaymentId).toMatch(/^pi_/);

    const updatedMultiSubDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, multiTestSubscriptionId),
    });
    for (const detail of updatedMultiSubDetails) {
      const originalDetail = allSubDetails.find((d) => d.id === detail.id)!;
      expect(detail.cyclesBilled).toBe((originalDetail.cyclesBilled || 0) + 1);
      expect(detail.nextBillingDate.getTime()).toBeGreaterThan(
        dueBillingDate.getTime()
      );
      expect(detail.previousBillingDate!.toISOString().slice(0, 10)).toBe(
        dueBillingDate.toISOString().slice(0, 10)
      );
    }
  }, 30000);

  it("should correctly handle payment failure for a recurring payment", async () => {
    // 1. Create Plan & Price (non-immediate billing)
    const failPlanResult = await createTestPlanWithFeatures(merchantId, [], {
      planName: "Payment Failure Test Plan",
    });
    const failPlanId = failPlanResult.plan.id;
    const failPrice = await createTestPrice({
      planId: failPlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Monthly Fee for Failing Card",
            amount_cents: 3000, // $30.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
            bill_immediately: false,
          },
        ],
      },
    });
    const failPriceId = failPrice.id;

    // 2. Create Customer & Stripe Customer
    const failCustomerEmail = `fail-${Date.now()}@example.com`;
    const failLocalCustomer = await createTestCustomer({
      merchantId,
      email: failCustomerEmail,
      name: "Fail Test Cust",
    });
    const failTestCustomerId = failLocalCustomer.id;
    const failStripeApiCustomer = await stripeClient.customers.create({
      email: failCustomerEmail,
      name: "Fail Test Stripe Customer",
      metadata: { lumenCustomerId: failTestCustomerId },
    });
    await db
      .update(customers)
      .set({ pspCustomerId: failStripeApiCustomer.id })
      .where(eq(customers.id, failTestCustomerId));

    // 3. Create FAILING Payment Method (Stripe & Local)
    // Use pm_card_chargeCustomerFail to simulate a failed charge
    const failingStripePm = await stripeClient.paymentMethods.attach(
      "pm_card_chargeCustomerFail",
      { customer: failStripeApiCustomer.id }
    );
    const [failingDbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: failTestCustomerId,
        provider: "stripe",
        paymentType: "card",
        status: "active", // Initially active, Stripe will decline it
        externalPspPaymentMethodId: failingStripePm.id,
        externalPspCustomerId: failStripeApiCustomer.id,
        cardLastFour: failingStripePm.card?.last4, // Will be specific to the test card
        cardBrand: failingStripePm.card?.brand,
      })
      .returning();

    // 4. Create Subscription & link Failing Payment Method
    const apiClient = createTestApiClient(sessionToken);
    const subStartDateFail = new Date();
    subStartDateFail.setUTCMonth(subStartDateFail.getUTCMonth() - 2); // Due

    const createFailSubResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: failTestCustomerId,
        planId: failPlanId,
        effectivePriceId: failPriceId,
        startTimestamp: subStartDateFail.toISOString(),
      },
    });
    const createFailSubBody = await createFailSubResponse.json();
    if ("error" in createFailSubBody)
      throw new Error(`Fail-Sub creation failed: ${createFailSubBody.error}`);
    if (!createFailSubBody.subscription)
      throw new Error("No subscription returned for failing payment test");
    const failTestSubscriptionId = createFailSubBody.subscription.id;

    await db
      .update(subscriptionDetails)
      .set({ paymentMethodId: failingDbPaymentMethod.id })
      .where(eq(subscriptionDetails.subscriptionId, failTestSubscriptionId));

    // 5. Set SubscriptionDetail nextBillingDate to be due
    const failSubDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, failTestSubscriptionId),
    });
    if (!failSubDetail)
      throw new Error("Failing subscription detail not found");

    const failDueDate = new Date();
    failDueDate.setDate(failDueDate.getDate() - 1); // Yesterday
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: failDueDate })
      .where(eq(subscriptionDetails.id, failSubDetail.id));

    const initialCyclesBilled = failSubDetail.cyclesBilled || 0;

    // 6. Mock collectPaymentJob.batchTrigger to simulate Stripe failure
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        console.log(
          `Mock collectPaymentJob.batchTrigger called for FAILING payment.`
        );
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        const customerData = await db.query.customers.findFirst({
          where: eq(customers.id, currentCustomerId),
        });
        if (!customerData?.pspCustomerId)
          throw new Error("Stripe customer ID not found for failing mock");

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

        console.log(
          `Mock collectPaymentJob.batchTrigger calling /collect-payment for FAILING payment ${currentCustomerId}`
        );

        try {
          // Call the actual API endpoint - it will create invoice and payment with pending status,
          // then attempt to charge the card which will fail
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

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

          if (response.ok && result.success) {
            // This shouldn't happen with pm_card_chargeCustomerFail
            console.warn(
              `Mock Stripe PaymentIntent ${result.paymentIntentId} unexpectedly succeeded for failing card.`
            );
            return {
              batchId: `mock-batch-fail-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-fail-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                } satisfies MockRunResult,
              ],
            };
          } else {
            console.log(
              `Mock Stripe PaymentIntent creation FAILED as expected: ${result.message}`
            );
            return {
              batchId: `mock-batch-fail-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-fail-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `Payment failed: ${result.message}`,
                  output: result,
                  payload: itemPayload,
                } satisfies MockRunResult,
              ],
            };
          }
        } catch (error: any) {
          console.error(
            `Mock fetch error for failing payment: ${error.message}`
          );
          return {
            batchId: `mock-batch-fail-${Date.now()}`,
            runs: [
              {
                id: `mock-run-fail-${Date.now()}`,
                status: "FAILURE" as const,
                error: error.message,
                payload: itemPayload,
              } satisfies MockRunResult,
            ],
          };
        }
      }
    );

    // 7. Call processBillingCycle
    console.log("Processing billing cycle for expected payment failure...");
    const processBillingCycleResult = await processBillingCycle(
      apiUrl,
      triggerApiAccessKey,
      new Date()
    );

    expect(processBillingCycleResult.subscriptionsProcessed).toBe(1);
    expect(processBillingCycleResult.batchRuns).toBe(1);

    // 8. Wait a short period. No successful payment webhook should fire.
    console.log(
      "Waiting briefly (payment expected to fail, no success webhook)..."
    );
    await sleep(3000);

    // 9. Assertions
    expect(collectPaymentJobTriggerSpy).toHaveBeenCalledTimes(1);

    // Check for invoice - with the new flow, an invoice IS created with "issued" status
    const invoiceForFailedPayment = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.customerId, failTestCustomerId),
        eq(invoices.subscriptionId, failTestSubscriptionId)
      ),
    });

    // Invoice should exist but with "issued" status (not paid)
    expect(invoiceForFailedPayment).toBeDefined();
    expect(invoiceForFailedPayment!.status).toBe("issued");

    // Check for payment - should exist but with "failed" status
    const failedDbPayment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invoiceForFailedPayment!.id),
    });

    expect(failedDbPayment).toBeDefined();
    expect(failedDbPayment!.status).toBe("failed");
    expect(failedDbPayment!.errorMessage).toBeDefined();

    // With the new flow, subscription details ARE updated even when payment fails
    // (billing cycles are consumed when invoice is generated, before payment attempt)
    const updatedSubDetailAfterFailure =
      await db.query.subscriptionDetails.findFirst({
        where: eq(subscriptionDetails.id, failSubDetail.id),
      });

    // Cycles should be incremented (billing cycle was consumed)
    expect(updatedSubDetailAfterFailure!.cyclesBilled).toBe(
      initialCyclesBilled + 1
    );

    // nextBillingDate should be updated to the next period
    expect(
      updatedSubDetailAfterFailure!.nextBillingDate.getTime()
    ).toBeGreaterThan(failDueDate.getTime());

    // previousBillingDate should be set to the due date that was processed
    expect(
      updatedSubDetailAfterFailure!
        .previousBillingDate!.toISOString()
        .slice(0, 10)
    ).toBe(failDueDate.toISOString().slice(0, 10));
  }, 30000);

  it("should process a free plan ($0) without requiring payment methods", async () => {
    // 1. Create Plan & Price with $0 amount (free plan)
    const freePlanResult = await createTestPlanWithFeatures(merchantId, [], {
      planName: "Free Plan Test",
    });
    const freePlanId = freePlanResult.plan.id;
    const freePrice = await createTestPrice({
      planId: freePlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Free Monthly Access",
            amount_cents: 0, // $0.00 - This is the key for free plan
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });
    const freePriceId = freePrice.id;

    // 2. Create Customer WITHOUT Payment Method (free plans don't need payment setup)
    const freeCustomerEmail = `free-plan-${Date.now()}@example.com`;
    const freeLocalCustomer = await createTestCustomer({
      merchantId,
      email: freeCustomerEmail,
      name: "Free Plan Customer",
    });
    const freeTestCustomerId = freeLocalCustomer.id;

    // Note: We intentionally do NOT create a Stripe customer or payment method
    // since free plans shouldn't require payment setup

    // 3. Create Subscription for free plan
    const apiClient = createTestApiClient(sessionToken);
    const freeSubStartDate = new Date();
    freeSubStartDate.setUTCMonth(freeSubStartDate.getUTCMonth() - 1); // Start 1 month ago to ensure due

    const createFreeSubResponse = await apiClient.subscriptions.$post({
      json: {
        customerId: freeTestCustomerId,
        planId: freePlanId,
        effectivePriceId: freePriceId,
        startTimestamp: freeSubStartDate.toISOString(),
      },
    });
    const createFreeSubBody = await createFreeSubResponse.json();
    if ("error" in createFreeSubBody)
      throw new Error(`Free sub creation failed: ${createFreeSubBody.error}`);
    if (!createFreeSubBody.subscription)
      throw new Error("No subscription returned from free plan creation");
    const freeTestSubscriptionId = createFreeSubBody.subscription.id;

    // 4. Set SubscriptionDetail nextBillingDate to be due
    const freeSubDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, freeTestSubscriptionId),
    });
    if (!freeSubDetail) throw new Error("Free subscription detail not found");

    const freeDueDate = new Date();
    freeDueDate.setDate(freeDueDate.getDate() - 1); // Yesterday
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: freeDueDate })
      .where(eq(subscriptionDetails.id, freeSubDetail.id));

    const initialCyclesBilled = freeSubDetail.cyclesBilled || 0;

    // 5. Mock collectPaymentJob.batchTrigger for free plan
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        console.log(
          `Mock collectPaymentJob.batchTrigger calling /collect-payment for FREE PLAN customer ${currentCustomerId}`
        );

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

        try {
          // Call the actual API endpoint - should handle $0 invoice without payment method
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

          const responseData = await response.json();

          // Parse the response
          const result = z
            .object({
              success: z.boolean(),
              paymentIntentId: z.string().optional(),
              invoiceId: z.string().optional(),
              paymentId: z.string().optional(), // Should be undefined for free plans
              status: z.string(),
              message: z.string(),
            })
            .parse(responseData);

          if (response.ok && result.success) {
            console.log(
              `Free plan billing successful: ${result.message}, Status: ${result.status}`
            );
            return {
              batchId: `mock-batch-free-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-free-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                } satisfies MockRunResult,
              ],
            };
          } else {
            console.error(
              `Mock API call to /collect-payment failed for free plan: Status ${response.status}, Response: ${JSON.stringify(responseData)}`
            );
            return {
              batchId: `mock-batch-free-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-free-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                } satisfies MockRunResult,
              ],
            };
          }
        } catch (error) {
          console.error(
            `Mock fetch error for free plan: ${error instanceof Error ? error.message : String(error)}`
          );
          return {
            batchId: `mock-batch-free-${Date.now()}`,
            runs: [
              {
                id: `mock-run-free-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              } satisfies MockRunResult,
            ],
          };
        }
      }
    );

    // 6. Call processBillingCycle
    console.log("Processing billing cycle for free plan...");
    const freeBillingResult = await processBillingCycle(
      apiUrl,
      triggerApiAccessKey,
      new Date()
    );

    console.log("Free plan processBillingResult", freeBillingResult);

    // No need to wait for webhooks since no Stripe payment is involved
    await sleep(1000);

    // 7. Assertions
    expect(freeBillingResult.subscriptionsProcessed).toBe(1);
    expect(collectPaymentJobTriggerSpy).toHaveBeenCalledTimes(1);

    const freeCallPayload = collectPaymentJobTriggerSpy.mock
      .calls[0][0] as BatchItem[];
    expect(freeCallPayload[0].payload.customerId).toBe(freeTestCustomerId);
    expect(freeCallPayload[0].payload.subDetails[0].subscriptionId).toBe(
      freeTestSubscriptionId
    );
    expect(freeCallPayload[0].payload.subDetails[0].subscriptionDetailsId).toBe(
      freeSubDetail.id
    );

    // DB Assertions - Invoice should be created and marked as paid
    const createdFreeInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.customerId, freeTestCustomerId),
        eq(invoices.subscriptionId, freeTestSubscriptionId),
        ne(invoices.status, "deleted")
      ),
    });
    expect(createdFreeInvoice).toBeDefined();
    expect(createdFreeInvoice!.status).toBe("paid"); // Should be marked as paid immediately
    expect(createdFreeInvoice!.totalAmountCents).toBe(0); // $0.00

    // Invoice line items should exist
    const freeInvoiceItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, createdFreeInvoice!.id),
    });
    expect(freeInvoiceItems.length).toBe(2); // 1 for the subscription, 1 for the tax
    expect(freeInvoiceItems[0].subtotalCents).toBe(0); // $0.00
    expect(freeInvoiceItems[0].description).toBe("Free Monthly Access");

    // No payment record should exist for free plans (since no payment method required)
    const freeDbPayment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, createdFreeInvoice!.id),
    });
    expect(freeDbPayment).not.toBeDefined(); // No payment record for free plans

    // Subscription details should be updated (billing cycle progression)
    const updatedFreeSubDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.id, freeSubDetail.id),
    });
    expect(updatedFreeSubDetail!.cyclesBilled).toBe(initialCyclesBilled + 1);
    expect(updatedFreeSubDetail!.nextBillingDate.getTime()).toBeGreaterThan(
      freeDueDate.getTime()
    );
    expect(
      updatedFreeSubDetail!.previousBillingDate!.toISOString().slice(0, 10)
    ).toBe(freeDueDate.toISOString().slice(0, 10));

    // Verify no Stripe customer was created
    const customerAfterBilling = await db.query.customers.findFirst({
      where: eq(customers.id, freeTestCustomerId),
    });
    expect(customerAfterBilling!.pspCustomerId).toBeNull(); // No Stripe customer needed

    // Verify no payment methods exist for this customer
    const customerPaymentMethods = await db.query.paymentMethods.findMany({
      where: eq(paymentMethods.customerId, freeTestCustomerId),
    });
    expect(customerPaymentMethods.length).toBe(0); // No payment methods for free plan
  }, 30000);

  // TODO: Add more test cases:
  // - Payment failure and retry logic (if applicable within this scope)
  // - Subscription with multiple payment methods (if supported)
  // - Credits applied to paid plans resulting in $0 invoices (should still create payment records)
});
