import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  spyOn,
  beforeAll,
  afterAll,
} from "bun:test";
import { addMonths } from "date-fns";
import { processBillingCycle } from "../../trigger/helpers/billing";
import { db } from "../../src/db/client";
import Stripe from "stripe";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { sleep } from "../test-helpers/sleep";
import path from "path";
import {
  invoices,
  invoiceLineItems,
  subscriptionDetails,
  subscriptions,
  subscriptionFeatures,
  customers,
  plans,
  planFeatures,
  stripe as stripeSchema,
  paymentMethods,
  payments,
  events,
  user,
  featureMetrics,
  features,
  prices,
  metrics,
  organization,
  pricingTables,
  pricingTablePlans,
  subscriptionsScheduledChanges,
  subscriptionPriceOverrides,
  creditDefinitions,
  creditGrants,
  creditUsageTransactions,
} from "@lumen/common/schema";

import { eq, and, sql, isNull, ne } from "drizzle-orm";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestCustomer,
  createTestApiClient,
  createTestApiKeys,
  clearEventData,
  cleanupDataFull,
} from "../test-helpers";
import { FeatureValue } from "../test-helpers/data/feature";
import dotenv from "dotenv";
import { calculateNextBillingDate } from "../../src/helpers/billing-dates";
import { Price } from "../../src/helpers";

import { collectPaymentJob } from "../../trigger/jobs/collectPayment"; // Added for new job
import { collectPaymentPayloadSchema } from "../../trigger/helpers/collectPayment";
import { createOrMergeIntoInvoice } from "../../src/helpers/billing";
import { z } from "zod";
import { env } from "../../src/env";
import { testEnv } from "../test-env";
import {
  createPaymentProvider,
  PaymentProviderAdapter,
} from "../test-helpers/paymentProvider";

// Define the type for batch items based on the job payload schema
type BatchItem = { payload: z.infer<typeof collectPaymentPayloadSchema> };

// Define the type for the mock run result
type MockRunResult = {
  id: string;
  status: "SUCCESS" | "FAILURE";
  output?: {
    success: boolean;
    paymentIntentId?: string;
    status: string;
    message: string;
  };
  error?: string;
  payload: z.infer<typeof collectPaymentPayloadSchema>;
};

dotenv.config();

// Clean up test data between tests (based on credit-billing.test.ts pattern)
const cleanupTestData = async () => {
  try {
    // First batch: Clean up usage and transaction records
    await db.execute(sql`
      DELETE FROM ${creditUsageTransactions};
      DELETE FROM ${payments};
      DELETE FROM ${invoiceLineItems};
      DELETE FROM ${invoices};
      DELETE FROM ${subscriptionFeatures};
      DELETE FROM ${subscriptionDetails};
      DELETE FROM ${events};
    `);

    // Second batch: Clean up subscription-related records that reference prices
    await db.execute(sql`
      DELETE FROM ${subscriptionsScheduledChanges};
      DELETE FROM ${subscriptions};
      DELETE FROM ${subscriptionPriceOverrides};
      DELETE FROM ${paymentMethods};
    `);

    // Third batch: Clean up credit records that reference prices
    await db.execute(sql`
      DELETE FROM ${creditGrants};
      DELETE FROM ${creditDefinitions};
    `);

    // Fourth batch: Clean up prices and dependent records
    await db.execute(sql`
      DELETE FROM ${prices};
      DELETE FROM ${planFeatures};
      DELETE FROM ${features};
      DELETE FROM ${featureMetrics};
      DELETE FROM ${metrics};
      DELETE FROM ${pricingTablePlans};
      DELETE FROM ${pricingTables};
      DELETE FROM ${plans};
      DELETE FROM ${customers};
    `);
  } catch (error) {
    console.error("Error during test cleanup:", error);
    throw error;
  }
};

describe("Billing Integration Tests", () => {
  let merchantId: string;
  let customerId: string;
  let planId: string;
  let priceId: string;
  let price: Price;
  let subscriptionId: string;
  let subscriptionDetailsId: string;
  let testStartTime: Date;
  let sessionToken: string;
  let apiUrl: string;
  let triggerApiAccessKey: string;
  let subscriptionStartDate: Date;
  let rruleMonthlyOnTheFirstString: string;
  let customerTimezone: string;
  let batchTriggerSpy: ReturnType<typeof spyOn>;
  let stripeClient: Stripe;
  let stripeSecretKey: string;
  let stripePublicKey: string;
  let stripeWebhookSecret: string;
  let webhookProcess: ChildProcess | null = null;
  let tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  let tempMerchantIdFile = "/tmp/test_merchant_id.txt";
  let publishableApiKey: string;
  let paymentProvider: PaymentProviderAdapter;


  beforeAll(async () => {
    // Get Stripe test keys
    stripeSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
    stripePublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;
    stripeWebhookSecret = testEnv.TEST_STRIPE_WEBHOOK_SECRET;

    // Initialize Stripe client
    stripeClient = new Stripe(stripeSecretKey, {
      apiVersion: "2025-02-24.acacia",
    });
  });

  afterAll(async () => {
    // Final cleanup of the webhook process if needed
    await paymentProvider?.cleanup();
    // Clean up database records
    await cleanupDataFull();
  });

  beforeEach(async () => {
    // Clean up test data from previous tests
    await clearEventData();
    await cleanupTestData();

    testStartTime = new Date();

    // Set up environment variables for testing
    apiUrl = env.API_URL;
    if (!env.TRIGGER_API_ACCESS_KEY) {
      throw new Error("TRIGGER_API_ACCESS_KEY must be set in test env");
    }

    triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY;

    if (!apiUrl || !triggerApiAccessKey) {
      throw new Error(
        "Required environment variables API_URL or TRIGGER_API_ACCESS_KEY not set"
      );
    }

    paymentProvider = await createPaymentProvider();

    // 1. Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Save merchant ID to temp file for webhook
    await fs.writeFile(tempMerchantIdFile, merchantId);

    // Create Stripe integration for the merchant
    await paymentProvider.registerIntegration(merchantId);

    // Generate publishable API key for payment-init flow
    const apiKeys = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    publishableApiKey = apiKeys.publishableKey.keyValue;

    // 2. Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // 3. Create a test customer
    customerTimezone = "America/Los_Angeles";
    const customer = await createTestCustomer({
      merchantId,
      email: `billing-test-customer-${Date.now()}@example.com`,
      name: "Billing Test Customer",
      timezone: customerTimezone,
    });
    customerId = customer.id;

    // 4. Create Plan with features
    const testFeatures = [
      {
        slug: `max-users-billing-${Date.now()}`,
        displayName: "Maximum Users",
        description: "Maximum number of users allowed",
        featureValue: 10 as FeatureValue,
      },
      {
        slug: `storage-billing-${Date.now()}`,
        displayName: "Storage (GB)",
        description: "Storage capacity in gigabytes",
        featureValue: 100 as FeatureValue,
      },
    ];

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      testFeatures,
      {
        stablePlanId: `billing-test-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Monthly Billing Plan",
        planDescription: "Plan for testing billing functionality",
      }
    );

    planId = planCreationResult.plan.id;

    // 5. Create Price with Monthly Recurrence starting 1st of month
    rruleMonthlyOnTheFirstString = "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1";
    price = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Monthly Base Fee",
            amount_cents: 5000, // $50.00
            recurrence_rule: rruleMonthlyOnTheFirstString, // Monthly on the 1st
            bill_immediately: false,
          },
        ],
      },
    });
    priceId = price.id;

    // 6. Create Subscription via API
    const apiClient = createTestApiClient(sessionToken);

    // Set start date to 15th of the last month so that the first billing date is the 1st of the current month
    subscriptionStartDate = new Date();
    subscriptionStartDate.setUTCMonth(
      subscriptionStartDate.getUTCMonth() - 1, // previous month
      1 // day 1
    );
    subscriptionStartDate.setUTCDate(subscriptionStartDate.getUTCDate() + 14); // 1 + 14 = 15th

    // Create subscription
    // Subscription billing date is 1st of the current month
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId,
        planId,
        effectivePriceId: priceId,
        startTimestamp: subscriptionStartDate.toISOString(),
      },
    });

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    if (
      !createBody.subscription ||
      typeof createBody.subscription.id !== "string"
    ) {
      throw new Error("Invalid subscription response");
    }
    subscriptionId = createBody.subscription.id;

    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });

    if (!details) {
      throw new Error("Subscription details not found");
    }
    subscriptionDetailsId = details.id;

    // Start webhook listener in a separate process
    await paymentProvider.startWebhookForwarder(merchantId);

    // --- Mock Setup ---
    batchTriggerSpy = spyOn(collectPaymentJob, "batchTrigger");
    batchTriggerSpy.mockImplementation(async (batchItems: BatchItem[]) => {
      const runResults: MockRunResult[] = [];

      console.log(
        `Mock batchTrigger (collectPaymentJob) executing for ${batchItems.length} items (Multi-Component)...`
      );

      const collectPaymentResponseSchema = z.object({
        success: z.boolean(),
        paymentIntentId: z.string().optional(),
        status: z.string(),
        message: z.string(),
      });

      for (const item of batchItems) {
        const payload = item.payload;
        const firstSubDetailBillingDate =
          payload.subDetails[0]?.nextBillingDate;
        const idempotencyKey = `payment-customer-${payload.customerId}-date-${firstSubDetailBillingDate?.split("T")[0]}`;

        console.log(
          `   Mock processing item for customer: ${payload.customerId} with ${payload.subDetails.length} subscription details (Multi-Component) for billing date ${firstSubDetailBillingDate}`
        );
        try {
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify(payload),
            }
          );

          const responseData = await response.json();
          const parsedResult = collectPaymentResponseSchema.parse(responseData);

          if (response.ok && parsedResult.success) {
            runResults.push({
              id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-multi`,
              status: "SUCCESS",
              output: parsedResult,
              payload: payload,
            });
            console.log(
              `      Mock API call to /collect-payment successful for customer: ${payload.customerId} (Multi-Component), PaymentIntentID: ${parsedResult.paymentIntentId}`
            );
          } else {
            console.error(
              `      Mock API call to /collect-payment failed for customer ${payload.customerId} (Multi-Component): Status ${response.status}, Response: ${JSON.stringify(responseData)}`
            );
            runResults.push({
              id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-multi`,
              status: "FAILURE",
              error: `API Error: ${response.status}, Message: ${parsedResult.message}`,
              payload: payload,
            });
          }
        } catch (error) {
          console.error(
            `      Mock fetch error for customer ${payload.customerId} (Multi-Component): ${error instanceof Error ? error.message : String(error)}`
          );
          runResults.push({
            id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-multi`,
            status: "FAILURE",
            error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
            payload: payload,
          });
        }
      }

      console.log(
        `   Mock batchTrigger (collectPaymentJob) finished processing (Multi-Component). Successful runs: ${runResults.filter((r) => r.status === "SUCCESS").length}`
      );

      return {
        batchId: `mock-batch-${Date.now()}-multi`,
        runs: runResults,
      };
    });
  });

  afterEach(async () => {
    // Restore mocks
    if (batchTriggerSpy) {
      batchTriggerSpy.mockRestore();
    }

    // Clean up the webhook process
    await paymentProvider?.cleanup();
  });

  afterAll(async () => {
    // Final cleanup of the webhook process if needed
    await paymentProvider?.cleanup();
    // Clean up database records
    await cleanupDataFull();
  });

  it("should process a due subscription, generate an invoice via mock, and update billing dates", async () => {
    // Get the initial billing date before processing
    const initialDetails = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.id, subscriptionDetailsId),
    });
    if (!initialDetails)
      throw new Error("Initial subscription details not found");
    const initialBillingDate = initialDetails.nextBillingDate;

    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `test-customer-${customerId}@example.com`,
      name: "Test Stripe Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Create a payment method in Stripe and attach to the customer
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    // Create a payment method record in our database
    const [dbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // Link payment method to subscription details
    await db
      .update(subscriptionDetails)
      .set({ paymentMethodId: dbPaymentMethod.id })
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    // Execute the billing cycle processing function
    // This will now call our mocked batchTrigger which calls the real collect-payment endpoint
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);

    // Wait for the webhook to process the payment
    await sleep(2500);

    // Assert the function reported triggering the job (based on mock response)
    expect(result.subscriptionsProcessed).toBe(1);
    expect(result.batchRuns).toBe(1); // Our mock simulates 1 batch run with 1 item

    // Verify the mock was called
    expect(batchTriggerSpy).toHaveBeenCalledTimes(1);
    expect(batchTriggerSpy.mock.calls[0][0].length).toBe(1); // Called with one batch item
    expect(batchTriggerSpy.mock.calls[0][0][0].payload.customerId).toBe(
      customerId
    );
    expect(
      batchTriggerSpy.mock.calls[0][0][0].payload.subDetails[0].subscriptionId
    ).toBe(subscriptionId);

    // Verify Invoice Creation IN THE DATABASE (since the mock made the API call)
    const createdInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          eq(invoices.subscriptionId, subscriptionId)
        )
      );

    expect(createdInvoices.length).toBe(1);

    // Sort by creation date to get the latest (migration) invoice
    const sortedInvoices = createdInvoices.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const invoice = sortedInvoices[0]; // Latest invoice (after migration)
    expect(invoice.status).toBe("paid");

    // Verify Invoice Line Items IN THE DATABASE
    const createdLineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id))
      .orderBy(invoiceLineItems.subtotalCents);

    expect(createdLineItems.length).toBe(2); // Monthly fee + tax line item

    // Filter for non-tax line items to test business logic
    const nonTaxLineItems = createdLineItems.filter(
      (item) => item.type !== "tax"
    );
    const taxLineItems = createdLineItems.filter((item) => item.type === "tax");

    expect(nonTaxLineItems.length).toBe(1);
    expect(taxLineItems.length).toBe(1);

    // Check that the componentId follows the expected pattern for auto-generated fixed component IDs
    expect(nonTaxLineItems[0].componentId).toMatch(/^price_comp_fix_/);
    expect(nonTaxLineItems[0].description).toContain("Monthly Base Fee");
    expect(nonTaxLineItems[0].subtotalCents).toBe(5000);

    // Verify tax line item is zero (no tax configuration)
    expect(taxLineItems[0].subtotalCents).toBe(0);
    expect(taxLineItems[0].description).toContain("0%");

    // Verify Subscription Details Update IN THE DATABASE
    const updatedDetails = await db
      .select()
      .from(subscriptionDetails)
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    expect(updatedDetails.length).toBe(1);
    const details = updatedDetails[0];
    expect(details.cyclesBilled).toBe(1);

    // Calculate the EXPECTED next billing date based on the *initial* billing date
    // Extract the first component from price.pricingData to pass it to calculateNextBillingDate
    const firstComponent = price.pricingData.components[0];
    const expectedNextBillingDate = calculateNextBillingDate(
      firstComponent,
      initialBillingDate,
      subscriptionStartDate,
      customerTimezone
    );

    expect(expectedNextBillingDate).toBeDefined();

    // Compare the ACTUAL updated date with the EXPECTED next billing date
    expect(details.nextBillingDate.toISOString().slice(0, 16)).toBe(
      expectedNextBillingDate.toISOString().slice(0, 16)
    );
  }, 30000);

  it("should prefer subscription_details payment method over most-recent when charging", async () => {
    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `prefer-subdetail-${customerId}@example.com`,
      name: "Prefer SubDetail PM Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Attach two Stripe payment methods
    const stripePmA = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });
    const stripePmB = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    // Insert both payment methods into our DB
    const [dbPmA] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePmA.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePmA.card?.last4,
        cardBrand: stripePmA.card?.brand,
        lastUsedAt: new Date(Date.now() - 60_000),
      })
      .returning();

    const [dbPmB] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePmB.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePmB.card?.last4,
        cardBrand: stripePmB.card?.brand,
        lastUsedAt: new Date(), // more recent
      })
      .returning();

    // Link preferred PM (A) to subscription details, even though B is more recent
    await db
      .update(subscriptionDetails)
      .set({
        paymentMethodId: dbPmA.id,
        nextBillingDate: new Date(Date.now() - 60_000),
      })
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    // Run billing
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);
    expect(result.subscriptionsProcessed).toBe(1);

    // Wait for webhook to settle
    await sleep(2500);

    // Fetch the latest invoice for this subscription
    const invs = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          eq(invoices.subscriptionId, subscriptionId),
          ne(invoices.status, "deleted")
        )
      );
    expect(invs.length).toBeGreaterThan(0);
    const latest = invs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    // Verify the payment used the subscription_details PM (A)
    const pmts = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, latest.id));
    expect(pmts.length).toBe(1);
    expect(pmts[0].paymentMethodId).toBe(dbPmA.id);
  }, 30000);

  it("should stamp attempted_payment_method_ids on payment metadata", async () => {
    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `attempted-meta-${customerId}@example.com`,
      name: "Attempted Meta Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Attach a Stripe payment method and save in DB
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    const [dbPm] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // Link PM to subscription details and make due now
    await db
      .update(subscriptionDetails)
      .set({
        paymentMethodId: dbPm.id,
        nextBillingDate: new Date(Date.now() - 60_000),
      })
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    // Run billing
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);
    expect(result.subscriptionsProcessed).toBe(1);

    // Wait for webhook
    await sleep(2500);

    // Fetch latest invoice and payment
    const invs = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          eq(invoices.subscriptionId, subscriptionId),
          ne(invoices.status, "deleted")
        )
      );
    expect(invs.length).toBeGreaterThan(0);
    const latest = invs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    const pmts = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, latest.id));
    expect(pmts.length).toBe(1);

    const meta = (pmts[0].metadata || {}) as any;
    // We expect attempted list to exist and include the chosen PM id
    const attempted = (meta.attempted_payment_method_ids || []) as string[];
    expect(Array.isArray(attempted)).toBe(true);
    expect(attempted).toContain(dbPm.id);
  }, 30000);

  it("should not process a subscription that is not due yet", async () => {
    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `test-customer-not-due-${customerId}@example.com`,
      name: "Test Not Due Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Create a payment method in Stripe and attach to the customer
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    // Create a payment method record in our database
    const [dbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // Link payment method to subscription details
    await db
      .update(subscriptionDetails)
      .set({ paymentMethodId: dbPaymentMethod.id })
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    // Update the subscription's next billing date to be in the future
    const futureBillingDate = addMonths(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: futureBillingDate })
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    // Execute the billing cycle processing function
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);

    // Assert the function reported processing zero subscriptions
    expect(result.subscriptionsProcessed).toBe(0);
    expect(result.batchRuns).toBe(0);

    // Verify the mock was NOT called
    expect(batchTriggerSpy).toHaveBeenCalledTimes(0);

    // Verify No Invoice Was Created
    const createdInvoices = await db
      .select({ id: invoices.id }) // Select only id for efficiency
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          eq(invoices.subscriptionId, subscriptionId)
        )
      );
    expect(createdInvoices.length).toBe(0);

    // Verify Subscription Details Unchanged
    const currentDetails = await db
      .select()
      .from(subscriptionDetails)
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    expect(currentDetails.length).toBe(1);
    expect(currentDetails[0].cyclesBilled).toBe(0); // Should remain 0
    expect(currentDetails[0].nextBillingDate.toISOString().slice(0, 16)).toBe(
      futureBillingDate.toISOString().slice(0, 16)
    ); // Should remain the future date
  });

  it("should correctly calculate next billing date from Feb 15, 2025 to March 1, 2025 (pre-DST)", async () => {
    // Create a subscription starting on Feb 15, 2025
    const feb15_2025 = new Date("2025-02-15T12:00:00Z");

    const apiClient = createTestApiClient(sessionToken);

    // Delete old subscription if it exists
    await db
      .update(subscriptions)
      .set({ deletedAt: new Date() })
      .where(eq(subscriptions.customerId, customerId));

    // Create a new subscription with specific start date
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId,
        planId,
        effectivePriceId: priceId,
        startTimestamp: feb15_2025.toISOString(),
      },
    });

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    expect(createResponse.status).toBe(201);
    expect(createBody.subscription).toBeDefined();
    const subscription = createBody.subscription!;

    // Get the subscription details
    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    expect(details).toBeDefined();

    // The next billing date should be March 1, 2025
    // DST begins on March 9, 2025 in America/Los_Angeles
    const expectedNextBillingDate = new Date("2025-03-01T08:00:00.000Z"); // 00:00 Los Angeles time is 08:00 UTC

    // Compare just the date parts to avoid potential timezone issues in testing
    expect(details?.nextBillingDate.toISOString().split("T")[0]).toBe(
      expectedNextBillingDate.toISOString().split("T")[0]
    );

    // Clean up this specific subscription
    await db
      .delete(subscriptionDetails)
      .where(eq(subscriptionDetails.subscriptionId, subscription.id));

    await db
      .delete(subscriptionFeatures)
      .where(eq(subscriptionFeatures.subscriptionId, subscription.id));

    await db.delete(subscriptions).where(eq(subscriptions.id, subscription.id));
  });

  it("should correctly calculate next billing date from Mar 15, 2025 to April 1, 2025 (post-DST)", async () => {
    // Create a subscription starting on Mar 15, 2025 (after DST change on March 9)
    const mar15_2025 = new Date("2025-03-15T03:00:00Z"); // UTC -> Los Angeles 14 Mar, 20:00

    const apiClient = createTestApiClient(sessionToken);

    // Delete old subscription if it exists
    await db
      .update(subscriptions)
      .set({ deletedAt: new Date() })
      .where(eq(subscriptions.customerId, customerId));

    // Create a new subscription with specific start date
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId,
        planId,
        effectivePriceId: priceId,
        startTimestamp: mar15_2025.toISOString(),
      },
    });

    const createBody = await createResponse.json();
    expect(createResponse.status).toBe(201);
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    expect(createBody.subscription).toBeDefined();
    const subscription = createBody.subscription!;

    // Get the subscription details
    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    expect(details).toBeDefined();

    // The next billing date should be April 1, 2025, 20:00 Los Angeles time
    // That comes to 2 Apr 2025, 03:00 UTC
    // DST is in effect in America/Los_Angeles
    const expectedNextBillingDate = new Date("2025-04-02T03:00:00.000Z");

    // Compare dates (ignoring milliseconds for potential minor discrepancies)
    expect(details!.nextBillingDate.toISOString().slice(0, 16)).toBe(
      // compare until the minute
      expectedNextBillingDate.toISOString().slice(0, 16)
    );
  });

  it("should handle timezone differences when billing date falls during DST transition", async () => {
    // Delete old subscription if it exists
    await db
      .update(subscriptions)
      .set({ deletedAt: new Date() })
      .where(eq(subscriptions.customerId, customerId));

    // Create a special price with billing on the 10th (day after DST change in March 2025)
    const specialPrice = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Monthly Fee (10th)",
            amount_cents: 5000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=10;INTERVAL=1", // Monthly on the 10th
            bill_immediately: false,
          },
        ],
      },
    });

    // Create a subscription starting on Feb 15, 2025
    const feb15_2025 = new Date("2025-02-15T12:00:00Z"); // -> 15 Feb 2025, 04:00 Los Angeles time

    const apiClient = createTestApiClient(sessionToken);

    // Create a new subscription with specific start date and special price
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId,
        planId,
        effectivePriceId: specialPrice.id,
        startTimestamp: feb15_2025.toISOString(),
      },
    });

    const createBody = await createResponse.json();
    expect(createResponse.status).toBe(201);
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }
    const subscription = createBody.subscription!;

    // Get the subscription details
    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    expect(details).toBeDefined();

    // The next billing date should be March 10, 2025 which is after DST change on March 9
    // It should be 10 Mar 2025, 04:00 Los Angeles time (with DST adjustment)
    // That comes to 10 Mar 2025, 11:00 UTC
    const expectedNextBillingDate = new Date("2025-03-10T11:00:00.000Z");

    // Compare dates (ignoring milliseconds for potential minor discrepancies)
    expect(details!.nextBillingDate.toISOString().slice(0, 16)).toBe(
      // compare until the minute
      expectedNextBillingDate.toISOString().slice(0, 16)
    );
  });

  it("should consolidate existing draft invoice with regular billing cycle charges", async () => {
    // Get the initial billing date before processing
    const initialDetails = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.id, subscriptionDetailsId),
    });
    if (!initialDetails)
      throw new Error("Initial subscription details not found");

    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `draft-consolidation-${customerId}@example.com`,
      name: "Draft Consolidation Test Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Create a payment method in Stripe and attach to the customer
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    // Create a payment method record in our database
    const [dbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // Link payment method to subscription details
    await db
      .update(subscriptionDetails)
      .set({ paymentMethodId: dbPaymentMethod.id })
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    // Manually create a draft invoice with some line items (simulating previous overage)
    console.log("Creating draft invoice with overage charges...");
    const draftInvoiceResult = await createOrMergeIntoInvoice({
      merchantId,
      customerId,
      subscriptionId,
      lineItems: [
        {
          type: "usage",
          description: "Previous seat overage charge",
          quantity: 50,
          unitAmountCents: 100,
          subtotalCents: 5000, // $50.00 in overage charges
          componentId: "manual-overage-component",
          priceId: priceId,
          billingPeriodStart: new Date(testStartTime.getTime() - 86400000 * 15), // 15 days ago
          billingPeriodEnd: new Date(testStartTime.getTime() - 86400000 * 5), // 5 days ago
        },
      ],
      currency: "USD",
      description: "Draft overage charges",
      status: "draft", // Key: this is draft
    });

    expect(draftInvoiceResult.success).toBe(true);
    expect(draftInvoiceResult.invoice).toBeDefined();
    const draftInvoice = draftInvoiceResult.invoice!;

    console.log(
      `Draft invoice created: ${draftInvoice.id} with status: ${draftInvoice.status}`
    );

    // Verify the draft invoice was created correctly
    expect(draftInvoice.status).toBe("draft");
    expect(draftInvoice.totalAmountCents).toBe(5000); // Just the overage charges

    // Get initial line items for the draft invoice
    const initialDraftLineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(
        and(
          eq(invoiceLineItems.invoiceId, draftInvoice.id),
          ne(invoiceLineItems.type, "tax")
        )
      );

    expect(initialDraftLineItems.length).toBe(1);
    expect(initialDraftLineItems[0].subtotalCents).toBe(5000);
    expect(initialDraftLineItems[0].description).toContain(
      "Previous seat overage charge"
    );

    // Execute the billing cycle processing function
    // This should consolidate the draft invoice with regular subscription charges
    console.log("Running billing cycle to consolidate draft invoice...");
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);

    // Wait for the webhook to process the payment
    await sleep(2500);

    // Assert the function reported processing
    expect(result.subscriptionsProcessed).toBe(1);
    expect(result.batchRuns).toBe(1);

    // Verify the mock was called
    expect(batchTriggerSpy).toHaveBeenCalledTimes(1);

    // Verify Invoice Consolidation - should now have exactly one PAID invoice
    const finalInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          eq(invoices.subscriptionId, subscriptionId),
          ne(invoices.status, "deleted")
        )
      );

    expect(finalInvoices.length).toBe(1); // Only one final invoice should exist
    const consolidatedInvoice = finalInvoices[0];

    // The consolidated invoice should be paid
    expect(consolidatedInvoice.status).toBe("paid");

    // Verify Consolidated Line Items - should contain both draft + subscription charges
    const consolidatedLineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, consolidatedInvoice.id))
      .orderBy(invoiceLineItems.subtotalCents);

    // Should have:
    // 1. Original draft overage line item ($50.00)
    // 2. Regular subscription monthly fee ($50.00)
    // 3. Tax line item (0% = $0.00)
    expect(consolidatedLineItems.length).toBe(3);

    // Filter for non-tax line items to test business logic
    const nonTaxLineItems = consolidatedLineItems.filter(
      (item) => item.type !== "tax"
    );
    const taxLineItems = consolidatedLineItems.filter(
      (item) => item.type === "tax"
    );

    expect(nonTaxLineItems.length).toBe(2);
    expect(taxLineItems.length).toBe(1);

    // Find the overage line item (should still exist)
    const overageLineItem = nonTaxLineItems.find((item) =>
      item.description?.includes("Previous seat overage charge")
    );
    expect(overageLineItem).toBeDefined();
    expect(overageLineItem!.subtotalCents).toBe(5000);
    expect(overageLineItem!.componentId).toBe("manual-overage-component");

    // Find the subscription line item
    const subscriptionLineItem = nonTaxLineItems.find((item) =>
      item.description?.includes("Monthly Base Fee")
    );
    expect(subscriptionLineItem).toBeDefined();
    expect(subscriptionLineItem!.subtotalCents).toBe(5000); // $50.00 monthly fee

    // Verify tax line item is zero (no tax configuration)
    expect(taxLineItems[0].subtotalCents).toBe(0);
    expect(taxLineItems[0].description).toContain("0%");

    // Verify total amount is the sum of all charges
    const expectedTotal = 5000 + 5000; // overage + monthly fee
    expect(consolidatedInvoice.totalAmountCents).toBe(expectedTotal);

    // Verify Payment was created for the consolidated amount
    const paymentsForInvoice = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, consolidatedInvoice.id));

    expect(paymentsForInvoice.length).toBe(1);
    expect(paymentsForInvoice[0].amountCents).toBe(expectedTotal);
    expect(paymentsForInvoice[0].status).toBe("succeeded");

    // Verify Subscription Details Update
    const updatedDetails = await db
      .select()
      .from(subscriptionDetails)
      .where(eq(subscriptionDetails.id, subscriptionDetailsId));

    expect(updatedDetails.length).toBe(1);
    const details = updatedDetails[0];
    expect(details.cyclesBilled).toBe(1);

    // The next billing date should be updated
    expect(details.nextBillingDate.getTime()).toBeGreaterThan(
      initialDetails.nextBillingDate.getTime()
    );

    console.log("Draft invoice consolidation test completed successfully");
  }, 30000);
});

describe("Multiple Price Components Billing", () => {
  let merchantId: string;
  let customerId: string;
  let planId: string;
  let multiComponentPrice: Price;
  let subscription: any;
  let subscriptionDetailsRecords: (typeof subscriptionDetails.$inferSelect)[];
  let testStartTime: Date;
  let sessionToken: string;
  let apiUrl: string;
  let triggerApiAccessKey: string;
  let customerTimezone: string;
  let batchTriggerSpy: ReturnType<typeof spyOn>;
  let stripeClient: Stripe;
  let stripeSecretKey: string;
  let stripePublicKey: string;
  let stripeWebhookSecret: string;
  let tempMerchantIdFile = "/tmp/test_merchant_id.txt";
  let tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  let webhookProcess: ChildProcess | null = null;
  let paymentProvider: PaymentProviderAdapter;

  beforeEach(async () => {
    // Clean up test data from previous tests
    await clearEventData();
    await cleanupTestData();

    paymentProvider = await createPaymentProvider();

    testStartTime = new Date();

    // 1. Set up environment variables for testing
    apiUrl = env.API_URL;
    if (!env.TRIGGER_API_ACCESS_KEY) {
      throw new Error("TRIGGER_API_ACCESS_KEY must be set in test env");
    }
    triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY;

    // Set up Stripe test keys
    stripeSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
    stripePublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;
    stripeWebhookSecret = testEnv.TEST_STRIPE_WEBHOOK_SECRET;

    // Initialize Stripe client
    stripeClient = new Stripe(stripeSecretKey, {
      apiVersion: "2025-02-24.acacia",
    });

    // 2. Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Save merchant ID to temp file for webhook
    await fs.writeFile(tempMerchantIdFile, merchantId);

    // Create Stripe integration for the merchant
    await paymentProvider.registerIntegration(merchantId);

    // Start webhook listener in a separate process
    await paymentProvider.startWebhookForwarder(merchantId);

    // 3. Authenticate
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // 4. Create a test customer
    customerTimezone = "America/Los_Angeles";
    const customer = await createTestCustomer({
      merchantId,
      email: `multi-comp-billing-test-${Date.now()}@example.com`,
      name: "Multi-Component Billing Test Customer",
      timezone: customerTimezone,
    });
    customerId = customer.id;

    // 5. Create Plan with features
    const testFeatures = [
      {
        slug: `api-calls-multi-billing-${Date.now()}`,
        displayName: "API Calls",
        description: "Number of API calls allowed",
        featureValue: 10000 as FeatureValue,
      },
      {
        slug: `storage-multi-billing-${Date.now()}`,
        displayName: "Storage (GB)",
        description: "Storage capacity in gigabytes",
        featureValue: 100 as FeatureValue,
      },
    ];

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      testFeatures,
      {
        stablePlanId: `multi-price-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Multi-Price Billing Plan",
        planDescription: "Plan for testing multiple price component billing",
      }
    );

    planId = planCreationResult.plan.id;

    // 6. First create a metric for our usage-based component using the helper
    const { createTestMetric } = await import("../test-helpers/data/metrics");
    const metricResponse = await createTestMetric({
      merchantId,
      name: "API Calls Test Metric",
      description: "API calls for billing test",
      queryType: "simple",
      aggregationType: "SUM",
      valueType: "NUMERIC",
      eventName: "api.call",
    });

    if (!metricResponse || !metricResponse.id) {
      throw new Error("Failed to create test metric");
    }
    const metricId = metricResponse.id;

    // 7. Create Price with multiple components and different billing cycles
    multiComponentPrice = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base-subscription",
            type: "fixed",
            label: "Monthly Base Subscription",
            amount_cents: 4999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: false,
          },
          {
            component_name: "api-usage",
            type: "usage",
            label: "API Usage",
            unit_label: "API Call",
            metric_id: metricId, // Use the actual created metric ID
            unit_cost_cents: 1,
            recurrence_rule: "RRULE:FREQ=WEEKLY;BYDAY=MO", // Weekly on Mondays
            bill_immediately: false,
          },
          {
            component_name: "storage-fee",
            type: "per_unit",
            label: "Storage Fee",
            unit_label: "GB",
            amount_cents: 999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15", // Monthly on the 15th
            bill_immediately: false,
          },
        ],
      },
    });

    // 7. Create a subscription that started a month ago
    const subscriptionStartDate = new Date();
    subscriptionStartDate.setUTCMonth(
      subscriptionStartDate.getUTCMonth() - 1, // previous month
      1 // day 1
    );

    const apiClient = createTestApiClient(sessionToken);
    const createResponse = await apiClient.subscriptions.$post({
      json: {
        customerId,
        planId,
        effectivePriceId: multiComponentPrice.id,
        startTimestamp: subscriptionStartDate.toISOString(),
      },
    });

    const createBody = await createResponse.json();
    if ("error" in createBody) {
      throw new Error(`Unexpected error: ${createBody.error}`);
    }

    subscription = createBody.subscription;

    // 8. Get subscription details for each component
    subscriptionDetailsRecords = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    if (
      !subscriptionDetailsRecords ||
      subscriptionDetailsRecords.length === 0
    ) {
      throw new Error("No subscription details found for subscription");
    }

    // 9. Mock the batchTrigger for payment collection
    batchTriggerSpy = spyOn(collectPaymentJob, "batchTrigger");
    batchTriggerSpy.mockImplementation(async (batchItems: BatchItem[]) => {
      const runResults: MockRunResult[] = [];

      console.log(
        `Mock batchTrigger (collectPaymentJob) executing for ${batchItems.length} items (Multi-Component)...`
      );

      const collectPaymentResponseSchema = z.object({
        success: z.boolean(),
        paymentIntentId: z.string().optional(),
        status: z.string(),
        message: z.string(),
      });

      for (const item of batchItems) {
        const payload = item.payload;
        const firstSubDetailBillingDate =
          payload.subDetails[0]?.nextBillingDate;
        const idempotencyKey = `payment-customer-${payload.customerId}-date-${firstSubDetailBillingDate?.split("T")[0]}`;

        console.log(
          `   Mock processing item for customer: ${payload.customerId} with ${payload.subDetails.length} subscription details (Multi-Component) for billing date ${firstSubDetailBillingDate}`
        );
        try {
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify(payload),
            }
          );

          const responseData = await response.json();
          const parsedResult = collectPaymentResponseSchema.parse(responseData);

          if (response.ok && parsedResult.success) {
            runResults.push({
              id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-multi`,
              status: "SUCCESS",
              output: parsedResult,
              payload: payload,
            });
            console.log(
              `      Mock API call to /collect-payment successful for customer: ${payload.customerId} (Multi-Component), PaymentIntentID: ${parsedResult.paymentIntentId}`
            );
          } else {
            console.error(
              `      Mock API call to /collect-payment failed for customer ${payload.customerId} (Multi-Component): Status ${response.status}, Response: ${JSON.stringify(responseData)}`
            );
            runResults.push({
              id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-multi`,
              status: "FAILURE",
              error: `API Error: ${response.status}, Message: ${parsedResult.message}`,
              payload: payload,
            });
          }
        } catch (error) {
          console.error(
            `      Mock fetch error for customer ${payload.customerId} (Multi-Component): ${error instanceof Error ? error.message : String(error)}`
          );
          runResults.push({
            id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-multi`,
            status: "FAILURE",
            error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
            payload: payload,
          });
        }
      }

      console.log(
        `   Mock batchTrigger (collectPaymentJob) finished processing (Multi-Component). Successful runs: ${runResults.filter((r) => r.status === "SUCCESS").length}`
      );

      return {
        batchId: `mock-batch-${Date.now()}-multi`,
        runs: runResults,
      };
    });
  });

  afterEach(async () => {
    // Restore mocks
    if (batchTriggerSpy) {
      batchTriggerSpy.mockRestore();
    }

    // Clean up the webhook process
    await paymentProvider?.cleanup();

    await clearEventData();
  });

  afterAll(async () => {
    // Final cleanup of the webhook process if needed
    await paymentProvider?.cleanup();
    // Clean up database records
    await cleanupDataFull();
  });

  it("should process multiple price components with different billing cycles and generate invoices", async () => {
    expect(subscriptionDetailsRecords.length).toBe(3);

    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `multi-comp-cust-${customerId}@example.com`,
      name: "Multi Component Test Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Create a payment method in Stripe and attach to the customer
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    // Create a payment method record in our database
    const [dbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // Link payment method to ALL subscription details for this multi-component test
    for (const detail of subscriptionDetailsRecords) {
      await db
        .update(subscriptionDetails)
        .set({ paymentMethodId: dbPaymentMethod.id })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // Find components of each type for validation
    const fixedComponent = multiComponentPrice.pricingData.components.find(
      (c) => c.type === "fixed"
    );
    const perUnitComponent = multiComponentPrice.pricingData.components.find(
      (c) => c.type === "per_unit"
    );
    const usageComponent = multiComponentPrice.pricingData.components.find(
      (c) => c.type === "usage"
    );

    expect(fixedComponent).toBeDefined();
    expect(perUnitComponent).toBeDefined();
    expect(usageComponent).toBeDefined();

    // Find the corresponding subscription details records
    const fixedDetail = subscriptionDetailsRecords.find(
      (detail) => detail.componentId && detail.componentId.includes("_fix_")
    );
    const perUnitDetail = subscriptionDetailsRecords.find(
      (detail) => detail.componentId && detail.componentId.includes("_unit_")
    );
    const usageDetail = subscriptionDetailsRecords.find((detail) =>
      detail.componentId?.includes("_usage_")
    );

    expect(fixedDetail).toBeDefined();
    expect(perUnitDetail).toBeDefined();
    expect(usageDetail).toBeDefined();

    // Set our specific component billing dates to be due now
    // This is useful for testing metric events (we send events for the usage-based component one day ago)
    for (const detail of subscriptionDetailsRecords) {
      await db
        .update(subscriptionDetails)
        .set({
          nextBillingDate: new Date(testStartTime.getTime() - 10 * 60000),
        }) // 10 minutes ago
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // Add usage events for this subscription
    const usageAmount = 150; // 150 API calls
    const eventTimestamp = new Date(testStartTime.getTime() - 86400000); // 1 day ago

    // Create event for usage data
    const apiClient = createTestApiClient(sessionToken);
    const eventPayload = {
      eventName: "api.call",
      customerId,
      idempotencyKey: `idempotency-${Date.now()}`,
      eventTimestamp: eventTimestamp.toISOString(),
      eventValue: usageAmount,
    };

    const eventResponse = await apiClient.events.$post({ json: eventPayload });
    if (eventResponse.status !== 202) {
      throw new Error(`Failed to create event: ${await eventResponse.text()}`);
    }
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);

    // Wait for webhook to process the payment
    console.log("Waiting for webhook to process multi-component payment...");
    await sleep(3000, { alsoSleepInStripeMock: true });
    // Now we should be processing our components as a consolidated batch
    expect(result.subscriptionsProcessed).toBe(3); // Three components processed
    expect(result.batchRuns).toBe(1); // Processed as one batch for the customer

    // Verify the mock was called with one batch item containing all components
    expect(batchTriggerSpy).toHaveBeenCalledTimes(1);
    expect(batchTriggerSpy.mock.calls[0][0].length).toBe(1); // One batch item for all components

    // Verify the batch item contains all our subscription details
    const batchItem = batchTriggerSpy.mock.calls[0][0][0];
    expect(batchItem.payload.customerId).toBe(customerId);
    expect(batchItem.payload.subDetails.length).toBe(3); // All three components

    // Verify all subscription details IDs were included in the subDetails array
    const batchSubscriptionDetailsIds = batchItem.payload.subDetails.map(
      (detail) => detail.subscriptionDetailsId
    );
    expect(batchSubscriptionDetailsIds).toContain(fixedDetail!.id);
    expect(batchSubscriptionDetailsIds).toContain(perUnitDetail!.id);
    expect(batchSubscriptionDetailsIds).toContain(usageDetail!.id);

    // Verify Invoice Creation
    const createdInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId)
        )
      );

    // Expect exactly 1 consolidated invoice with line items for all components
    expect(createdInvoices.length).toBe(1);

    // Verify invoice properties of the consolidated invoice
    const invoice = createdInvoices[0];

    // Verify invoice status
    expect(invoice.status).toBe("paid");

    // Verify invoice dates
    expect(invoice.issueDate).toBeDefined();
    expect(invoice.issueDate instanceof Date).toBe(true);

    // Verify customer and merchant references
    expect(invoice.customerId).toBe(customerId);
    expect(invoice.merchantId).toBe(merchantId);

    // The subscription ID should be from one of our components
    // We don't need to check the exact subscription ID since it could be any of them
    // in the consolidated invoice flow

    // Verify currency
    expect(invoice.currency).toBe("USD");

    // Track which component types we've verified
    const verifiedComponentTypes = new Set();

    // Get all line items for the consolidated invoice
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    // Should have 4 line items: 3 components + 1 tax line item
    expect(lineItems.length).toBe(4);

    // Filter for non-tax line items to test business logic
    const nonTaxLineItems = lineItems.filter((item) => item.type !== "tax");
    const taxLineItems = lineItems.filter((item) => item.type === "tax");

    expect(nonTaxLineItems.length).toBe(3); // 3 components
    expect(taxLineItems.length).toBe(1); // 1 tax line item

    // Verify each non-tax line item corresponds to one of our components
    for (const lineItem of nonTaxLineItems) {
      const componentId = lineItem.componentId;
      expect(componentId).toBeDefined();

      // Validate fixed component
      if (componentId!.includes("_fix_")) {
        verifiedComponentTypes.add("fixed");
        expect(lineItem.subtotalCents).toBe(fixedComponent!.amount_cents);
        expect(lineItem.description).toContain(fixedComponent!.label);
      }
      // Validate per-unit component
      else if (componentId!.includes("_unit_")) {
        verifiedComponentTypes.add("per_unit");
        expect(lineItem.unitAmountCents).toBe(perUnitComponent!.amount_cents);
        const expectedQuantity = 1; // Default is 1 for now: TODO: Fix when support for quantity is added
        expect(lineItem.quantity).toBe(expectedQuantity);
        expect(lineItem.subtotalCents).toBe(
          perUnitComponent!.amount_cents * expectedQuantity
        );
        expect(lineItem.description).toContain(perUnitComponent!.label);
      }
      // Validate usage-based component
      else if (componentId!.includes("_usage_")) {
        verifiedComponentTypes.add("usage");
        // Verify the unit cost matches the component configuration
        expect(lineItem.unitAmountCents).toBe(usageComponent!.unit_cost_cents);
        // Verify the quantity matches our event value
        expect(lineItem.quantity).toBe(150);
        // Verify the subtotal is correctly calculated (unit cost * quantity)
        expect(lineItem.subtotalCents).toBe(
          usageComponent!.unit_cost_cents * 150
        );
        expect(lineItem.description).toContain(usageComponent!.label);
      }
    }

    // Verify the total amount on the invoice is the sum of all line items
    const invoiceTotalAmount = lineItems.reduce(
      (sum, item) => sum + item.subtotalCents,
      0
    );
    expect(invoice.totalAmountCents).toBe(invoiceTotalAmount);

    // Ensure we verified all three component types
    expect(verifiedComponentTypes.size).toBe(3);
    expect(verifiedComponentTypes.has("fixed")).toBe(true);
    expect(verifiedComponentTypes.has("per_unit")).toBe(true);
    expect(verifiedComponentTypes.has("usage")).toBe(true);

    // Verify the total amount on the invoice is the sum of all line items
    const secondInvoiceTotalCheck = lineItems.reduce(
      (sum, item) => sum + item.subtotalCents,
      0
    );
    expect(invoice.totalAmountCents).toBe(secondInvoiceTotalCheck);

    // Verify all subscription details were updated with new billing dates
    const updatedDetails = await db
      .select()
      .from(subscriptionDetails)
      .where(eq(subscriptionDetails.subscriptionId, subscription.id));

    expect(updatedDetails.length).toBe(3);

    for (const detail of updatedDetails) {
      // Each detail should have cyclesBilled = 1 now
      const originalDetail = subscriptionDetailsRecords.find(
        (d) => d.id === detail.id
      );
      expect(originalDetail).toBeDefined();

      // The cycles billed should have been incremented exactly once
      const originalCyclesBilled = originalDetail!.cyclesBilled || 0;
      expect(detail.cyclesBilled).toBe(originalCyclesBilled + 1);

      // The next billing date should be after the test start time
      expect(detail.nextBillingDate.getTime()).toBeGreaterThan(
        testStartTime.getTime()
      );

      // The next billing date should be after the original next billing date
      expect(detail.nextBillingDate.getTime()).toBeGreaterThan(
        originalDetail!.nextBillingDate.getTime()
      );

      // Calculate expected next billing date using helper
      const component = multiComponentPrice.pricingData.components.find(
        (c) => c.component_id === detail.componentId
      );
      expect(component).toBeDefined();
      const expectedNextBillingDate = calculateNextBillingDate(
        component!,
        new Date(testStartTime.getTime() - 10 * 60000), // 10 minutes ago, same what we set in sub details next billing date
        originalDetail!.subscriptionStartDate,
        customerTimezone
      );
      // Compare the dates (up to the minute) for equality
      expect(detail.nextBillingDate.toISOString().slice(0, 16)).toBe(
        expectedNextBillingDate.toISOString().slice(0, 16)
      );
    }
  }, 10000);

  it("should only process due components and not process components with future billing dates", async () => {
    expect(subscriptionDetailsRecords.length).toBe(3); // Verify we have all three components

    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `due-comp-cust-${customerId}@example.com`,
      name: "Due Component Test Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Create a payment method in Stripe and attach to the customer
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    // Create a payment method record in our database
    const [dbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // Link payment method to ALL subscription details for this test
    for (const detail of subscriptionDetailsRecords) {
      await db
        .update(subscriptionDetails)
        .set({ paymentMethodId: dbPaymentMethod.id })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // First, make ALL subscription details in the future
    await db.update(subscriptionDetails).set({
      nextBillingDate: new Date(testStartTime.getTime() + 86400000 * 30),
    }); // 30 days in future

    // Then make only one component due now (the first one)
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: new Date(testStartTime.getTime() - 60000) }) // 1 minute ago
      .where(eq(subscriptionDetails.id, subscriptionDetailsRecords[0].id));

    // Set the other components to future dates
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: new Date(testStartTime.getTime() + 86400000) }) // 1 day in future
      .where(eq(subscriptionDetails.id, subscriptionDetailsRecords[1].id));

    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: new Date(testStartTime.getTime() + 86400000 * 7),
      }) // 7 days in future
      .where(eq(subscriptionDetails.id, subscriptionDetailsRecords[2].id));

    // Execute the billing cycle processing function
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);
    console.log("result", result);

    // Wait for webhook to process any payments
    console.log("Waiting for webhook processing (only due components)...");
    await sleep(3000);
    // We should be processing exactly 1 component (the one we set as due)
    expect(result.subscriptionsProcessed).toBe(1);
    expect(result.batchRuns).toBe(1); // Processed as one batch for the customer

    // Verify the mock was called with exactly one batch item for our customer
    expect(batchTriggerSpy).toHaveBeenCalledTimes(1);
    expect(batchTriggerSpy.mock.calls[0][0].length).toBe(1);

    // Verify the batch item contains the customer ID and subscription detail
    const batchItem = batchTriggerSpy.mock.calls[0][0][0];
    expect(batchItem.payload.customerId).toBe(customerId);
    expect(batchItem.payload.subDetails.length).toBe(1);
    expect(batchItem.payload.subDetails[0].subscriptionDetailsId).toBe(
      subscriptionDetailsRecords[0].id
    );
    expect(batchItem.payload.subDetails[0].subscriptionId).toBe(
      subscription.id
    );

    // Verify exactly one invoice was created for our customer
    const createdInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId)
        )
      );

    expect(createdInvoices.length).toBe(1);

    // Verify only the first component was updated
    const updatedDetails = await db
      .select()
      .from(subscriptionDetails)
      .where(eq(subscriptionDetails.id, subscriptionDetailsRecords[0].id));

    expect(updatedDetails[0].cyclesBilled).toBe(1);

    // The other components should remain with cyclesBilled = 0
    const otherDetails = await db
      .select()
      .from(subscriptionDetails)
      .where(
        and(
          eq(subscriptionDetails.subscriptionId, subscription.id),
          sql`${subscriptionDetails.id} != ${subscriptionDetailsRecords[0].id}`
        )
      );

    expect(otherDetails.length).toBe(2);
    for (const detail of otherDetails) {
      expect(detail.cyclesBilled).toBe(0);
    }
  }, 30000);

  it("should process a component with actual usage data", async () => {
    expect(subscriptionDetailsRecords.length).toBe(3); // Verify we have three components

    // Find the usage-based component in our price definition
    const usageComponent = multiComponentPrice.pricingData.components.find(
      (comp) => comp.type === "usage"
    );
    expect(usageComponent).toBeDefined();
    expect(usageComponent?.metric_id).toBeDefined();

    // Find the subscription details record for our usage component
    const usageDetailRecord = subscriptionDetailsRecords.find((detail) =>
      detail.componentId?.includes("_usage_")
    );
    expect(usageDetailRecord).toBeDefined();

    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `usage-comp-cust-${customerId}@example.com`,
      name: "Usage Component Test Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Create a payment method in Stripe and attach to the customer
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    // Create a payment method record in our database
    const [dbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // Link payment method to ALL subscription details for this test
    for (const detail of subscriptionDetailsRecords) {
      await db
        .update(subscriptionDetails)
        .set({ paymentMethodId: dbPaymentMethod.id })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // First, make ALL subscription details in the future
    await db.update(subscriptionDetails).set({
      nextBillingDate: new Date(testStartTime.getTime() + 86400000 * 30),
    }); // 30 days in future

    // Then set ONLY the usage component to be due
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: new Date(testStartTime.getTime() - 60000) }) // 1 minute ago
      .where(eq(subscriptionDetails.id, usageDetailRecord!.id));

    // Add usage events for this subscription
    const usageAmount = 150; // 150 API calls
    const eventTimestamp = new Date(testStartTime.getTime() - 86400000); // 1 day ago

    // Create event for usage data
    const apiClient = createTestApiClient(sessionToken);
    const eventPayload = {
      eventName: "api.call",
      customerId,
      idempotencyKey: `idempotency-${Date.now()}`,
      eventTimestamp: eventTimestamp.toISOString(),
      eventValue: usageAmount,
    };

    const eventResponse = await apiClient.events.$post({ json: eventPayload });
    if (eventResponse.status !== 202) {
      throw new Error(`Failed to create event: ${await eventResponse.text()}`);
    }

    // Wait for event processing to complete
    await sleep(500, { alsoSleepInStripeMock: true });

    // Execute the billing cycle
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);

    // Wait for webhook to process the payment
    console.log("Waiting for webhook to process usage component payment...");
    await sleep(3000);

    // Should only process the usage component
    expect(result.subscriptionsProcessed).toBe(1);
    expect(result.batchRuns).toBe(1);

    // Verify the invoice was created
    const createdInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId)
        )
      );

    expect(createdInvoices.length).toBe(1);

    // Get the line items for the invoice
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, createdInvoices[0].id));

    expect(lineItems.length).toBe(2); // Usage component + tax line item

    // Filter for non-tax line items to test business logic
    const nonTaxLineItems = lineItems.filter((item) => item.type !== "tax");
    const taxLineItems = lineItems.filter((item) => item.type === "tax");

    expect(nonTaxLineItems.length).toBe(1);
    expect(taxLineItems.length).toBe(1);

    // Get information about the component from the line item
    const lineItem = nonTaxLineItems[0];

    // We should have processed the usage component
    expect(lineItem.componentId!.includes("_usage_")).toBe(true);
    expect(lineItem.description).toContain(usageComponent!.label);

    // Verify invoice properties
    expect(createdInvoices[0].status).toBe("paid");
    expect(createdInvoices[0].issueDate).toBeDefined();
    expect(createdInvoices[0].issueDate instanceof Date).toBe(true);
    expect(createdInvoices[0].customerId).toBe(customerId);
    expect(createdInvoices[0].merchantId).toBe(merchantId);
    expect(createdInvoices[0].subscriptionId).toBe(subscription.id);
    expect(createdInvoices[0].currency).toBe("USD");

    // Verify usage-specific fields
    expect(lineItem.unitAmountCents).toBe(usageComponent!.unit_cost_cents);
    expect(lineItem.quantity).toBe(150);

    // Verify that usage data was correctly pulled from the events we created
    const expectedSubtotal = usageComponent!.unit_cost_cents * 150;
    expect(lineItem.subtotalCents).toBe(expectedSubtotal);

    // The invoice total should match the line item subtotal
    expect(createdInvoices[0].totalAmountCents).toBe(expectedSubtotal);

    // Verify the subscription details were updated correctly
    const updatedDetails = await db
      .select()
      .from(subscriptionDetails)
      .where(eq(subscriptionDetails.id, usageDetailRecord!.id));

    expect(updatedDetails.length).toBe(1);

    // The component should have been billed exactly once
    expect(updatedDetails[0].cyclesBilled).toBe(1);

    // The next billing date should be in the future
    expect(updatedDetails[0].nextBillingDate.getTime()).toBeGreaterThan(
      testStartTime.getTime()
    );

    // Calculate expected next billing date using helper
    const detail = updatedDetails[0];
    expect(detail.previousBillingDate).toBeDefined();
    const component = multiComponentPrice.pricingData.components.find(
      (c) => c.component_id === detail.componentId
    );
    expect(component).toBeDefined();
    const expectedNextBillingDate = calculateNextBillingDate(
      component!,
      detail.previousBillingDate!,
      detail.subscriptionStartDate,
      customerTimezone
    );
    // Compare the dates (up to the minute) for equality
    expect(detail.nextBillingDate.toISOString().slice(0, 16)).toBe(
      expectedNextBillingDate.toISOString().slice(0, 16)
    );

    // Verify other components were not billed
    const otherDetails = await db
      .select()
      .from(subscriptionDetails)
      .where(
        and(
          eq(subscriptionDetails.subscriptionId, subscription.id),
          sql`${subscriptionDetails.id} != ${usageDetailRecord!.id}`
        )
      );

    expect(otherDetails.length).toBe(2);
    for (const detail of otherDetails) {
      expect(detail.cyclesBilled).toBe(0);
    }
  }, 30000);

  it("should handle true RRULE-based billing cycle isolation", async () => {
    // Create a Stripe customer for PSP integration
    const stripeCustomer = await stripeClient.customers.create({
      email: `multi-comp-cust-${customerId}@example.com`,
      name: "Multi Component Test Customer",
      metadata: { lumenCustomerId: customerId },
    });

    // Update our customer record with the pspCustomerId
    await db
      .update(customers)
      .set({ pspCustomerId: stripeCustomer.id })
      .where(eq(customers.id, customerId));

    // Create a payment method in Stripe and attach to the customer
    const stripePm = await stripeClient.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });

    // Create a payment method record in our database
    const [dbPaymentMethod] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId: customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePm.id,
        externalPspCustomerId: stripeCustomer.id,
        cardLastFour: stripePm.card?.last4,
        cardBrand: stripePm.card?.brand,
      })
      .returning();

    // Link payment method to ALL subscription details for this multi-component test
    for (const detail of subscriptionDetailsRecords) {
      await db
        .update(subscriptionDetails)
        .set({ paymentMethodId: dbPaymentMethod.id })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    expect(subscriptionDetailsRecords.length).toBe(3); // Verify we have three components

    // Find our components
    const fixedMonthlyComponent =
      multiComponentPrice.pricingData.components.find(
        (comp) =>
          comp.type === "fixed" && comp.recurrence_rule.includes("MONTHLY")
      );
    const usageWeeklyComponent =
      multiComponentPrice.pricingData.components.find(
        (comp) =>
          comp.type === "usage" && comp.recurrence_rule.includes("WEEKLY")
      );

    expect(fixedMonthlyComponent).toBeDefined();
    expect(usageWeeklyComponent).toBeDefined();

    // Find corresponding subscription details
    const fixedDetail = subscriptionDetailsRecords.find(
      (detail) => detail.componentId && detail.componentId.includes("_fix_")
    );
    const usageDetail = subscriptionDetailsRecords.find((detail) =>
      detail.componentId?.includes("_usage_")
    );

    expect(fixedDetail).toBeDefined();
    expect(usageDetail).toBeDefined();

    // Reset all next billing dates to far future
    await db.update(subscriptionDetails).set({
      nextBillingDate: new Date(testStartTime.getTime() + 86400000 * 30),
    });

    // ----- SCENARIO 1: Only weekly component is due -----

    // Set only weekly component to be due
    const weeklyDueDate = new Date(testStartTime.getTime() - 60000); // 1 minute ago
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: weeklyDueDate })
      .where(eq(subscriptionDetails.id, usageDetail!.id));

    // Create some usage data for this subscription
    const apiClient = createTestApiClient(sessionToken);
    const eventPayload = {
      eventName: "api.call",
      customerId,
      idempotencyKey: `idempotency-weekly-${Date.now()}`,
      eventTimestamp: new Date(
        testStartTime.getTime() - 86400000
      ).toISOString(),
      eventValue: 100,
    };

    const eventResponse = await apiClient.events.$post({ json: eventPayload });
    if (eventResponse.status !== 202) {
      throw new Error(`Failed to create event: ${await eventResponse.text()}`);
    }

    // Process billing cycle
    const weeklyResult = await processBillingCycle(apiUrl, triggerApiAccessKey);

    await sleep(2000);

    // Should only process the weekly component
    expect(weeklyResult.subscriptionsProcessed).toBe(1);
    expect(weeklyResult.batchRuns).toBe(1);

    // Verify one invoice was created
    const weeklyInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          eq(invoices.subscriptionId, subscription.id)
        )
      );

    expect(weeklyInvoices.length).toBe(1);

    // Verify the line item is for the weekly component
    const weeklyLineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, weeklyInvoices[0].id));

    expect(weeklyLineItems.length).toBe(2); // Weekly component + tax line item

    // Filter for non-tax line items to test business logic
    const nonTaxLineItems = weeklyLineItems.filter(
      (item) => item.type !== "tax"
    );
    const taxLineItems = weeklyLineItems.filter((item) => item.type === "tax");

    expect(nonTaxLineItems.length).toBe(1);
    expect(taxLineItems.length).toBe(1);
    expect(nonTaxLineItems[0].componentId!.includes("_usage_")).toBe(true);

    // Verify only weekly component was updated
    const updatedDetailsAfterWeekly = await db
      .select()
      .from(subscriptionDetails)
      .where(eq(subscriptionDetails.subscriptionId, subscription.id));

    for (const detail of updatedDetailsAfterWeekly) {
      if (detail.id === usageDetail!.id) {
        expect(detail.cyclesBilled).toBe(1); // Should be billed
        expect(detail.nextBillingDate.getTime()).toBeGreaterThan(
          weeklyDueDate.getTime()
        );
      } else {
        expect(detail.cyclesBilled).toBe(0); // Should not be billed
      }
    }

    // ----- SCENARIO 2: Only monthly component is due -----
    // Clean up previous invoices
    await db
      .delete(invoiceLineItems)
      .where(
        eq(
          invoiceLineItems.invoiceId,
          sql`ANY(SELECT id FROM ${invoices} WHERE subscription_id = ${subscription.id})`
        )
      );

    await db
      .delete(payments)
      .where(eq(payments.invoiceId, weeklyInvoices[0].id));

    await db
      .delete(invoices)
      .where(eq(invoices.subscriptionId, subscription.id));

    // Reset all next billing dates to far future
    await db.update(subscriptionDetails).set({
      nextBillingDate: new Date(testStartTime.getTime() + 86400000 * 30),
    });

    // Set only monthly component to be due
    const monthlyDueDate = new Date(testStartTime.getTime() - 60000); // 1 minute ago
    await db
      .update(subscriptionDetails)
      .set({ nextBillingDate: monthlyDueDate })
      .where(eq(subscriptionDetails.id, fixedDetail!.id));

    // Process billing cycle
    const monthlyResult = await processBillingCycle(
      apiUrl,
      triggerApiAccessKey
    );

    await sleep(1500);

    // Should only process the monthly component
    expect(monthlyResult.subscriptionsProcessed).toBe(1);
    expect(monthlyResult.batchRuns).toBe(1);

    // Verify one invoice was created for the monthly component
    const monthlyInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          eq(invoices.subscriptionId, subscription.id)
        )
      );

    expect(monthlyInvoices.length).toBe(1);

    // Verify the line item is for the monthly component
    const monthlyLineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, monthlyInvoices[0].id));

    expect(monthlyLineItems.length).toBe(2); // Monthly component + tax line item

    // Filter for non-tax line items to test business logic
    const nonTaxMonthlyItems = monthlyLineItems.filter(
      (item) => item.type !== "tax"
    );
    const taxMonthlyItems = monthlyLineItems.filter(
      (item) => item.type === "tax"
    );

    expect(nonTaxMonthlyItems.length).toBe(1);
    expect(taxMonthlyItems.length).toBe(1);
    expect(nonTaxMonthlyItems[0].componentId!.includes("_fix_")).toBe(true);

    // Verify only monthly component was updated
    const updatedDetailsAfterMonthly = await db
      .select()
      .from(subscriptionDetails)
      .where(eq(subscriptionDetails.subscriptionId, subscription.id));

    for (const detail of updatedDetailsAfterMonthly) {
      if (detail.id === fixedDetail!.id) {
        expect(detail.cyclesBilled).toBe(1); // Should be billed
        expect(detail.nextBillingDate.getTime()).toBeGreaterThan(
          monthlyDueDate.getTime()
        );
      } else if (detail.id === usageDetail!.id) {
        // This was previously billed in scenario 1
        expect(detail.cyclesBilled).toBe(1);
      } else {
        expect(detail.cyclesBilled).toBe(0); // Should not be billed
      }
    }
  }, 30000);
});

describe("Plan Migration with Billing Integration", () => {
  let merchantId: string;
  let customerId: string;
  let initialPlanId: string;
  // Using `any` so we don't fail TS check when API serialises dates as strings
  let initialPrice: any;
  let subscriptionId: string;
  let testStartTime: Date;
  let sessionToken: string;
  let apiUrl: string;
  let triggerApiAccessKey: string;
  let customerTimezone: string;
  let batchTriggerSpy: ReturnType<typeof spyOn>;
  let stripeClient: Stripe;
  let stripeSecretKey: string;
  let stripePublicKey: string;
  let stripeWebhookSecret: string;
  let publishableApiKey: string;
  let customerEmail: string;
  let tempMerchantIdFile = "/tmp/test_merchant_id.txt";
  let tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  let paymentProvider: PaymentProviderAdapter;

  beforeEach(async () => {
    // Clean up test data from previous tests
    await clearEventData();
    await cleanupTestData();

    paymentProvider = await createPaymentProvider();

    testStartTime = new Date();

    // Set up environment variables for testing
    apiUrl = env.API_URL;
    if (!env.TRIGGER_API_ACCESS_KEY) {
      throw new Error("TRIGGER_API_ACCESS_KEY must be set in test env");
    }
    triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY;

    // Set up Stripe test keys
    stripeSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
    stripePublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;
    stripeWebhookSecret = testEnv.TEST_STRIPE_WEBHOOK_SECRET;

    // Initialize Stripe client
    stripeClient = new Stripe(stripeSecretKey, {
      apiVersion: "2025-02-24.acacia",
    });

    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Save merchant ID to temp file for webhook
    await fs.writeFile(tempMerchantIdFile, merchantId);

    // Create Stripe integration for the merchant
    await paymentProvider.registerIntegration(merchantId);

    // Generate publishable API key for payment-init flow
    const apiKeys = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    publishableApiKey = apiKeys.publishableKey.keyValue;

    // Start webhook listener
    await paymentProvider.startWebhookForwarder(merchantId);

    // Authenticate
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create test customer
    customerTimezone = "America/Los_Angeles";
    const customer = await createTestCustomer({
      merchantId,
      email: `migration-test-${Date.now()}@example.com`,
      name: "Migration Test Customer",
      timezone: customerTimezone,
    });
    customerId = customer.id;

    // Mock the batchTrigger for payment collection
    batchTriggerSpy = spyOn(collectPaymentJob, "batchTrigger");
    batchTriggerSpy.mockImplementation(async (batchItems: BatchItem[]) => {
      const runResults: MockRunResult[] = [];

      console.log(
        `Mock batchTrigger (collectPaymentJob) executing for ${batchItems.length} items (Migration)...`
      );

      const collectPaymentResponseSchema = z.object({
        success: z.boolean(),
        paymentIntentId: z.string().optional(),
        status: z.string(),
        message: z.string(),
      });

      for (const item of batchItems) {
        const payload = item.payload;
        const firstSubDetailBillingDate =
          payload.subDetails[0]?.nextBillingDate;
        const idempotencyKey = `payment-customer-${payload.customerId}-date-${firstSubDetailBillingDate?.split("T")[0]}`;

        console.log(
          `   Mock processing migration item for customer: ${payload.customerId} with ${payload.subDetails.length} subscription details`
        );
        try {
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify(payload),
            }
          );

          const responseData = await response.json();
          const parsedResult = collectPaymentResponseSchema.parse(responseData);

          if (response.ok && parsedResult.success) {
            runResults.push({
              id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-migration`,
              status: "SUCCESS",
              output: parsedResult,
              payload: payload,
            });
            console.log(
              `      Mock API call successful for customer: ${payload.customerId} (Migration), PaymentIntentID: ${parsedResult.paymentIntentId}`
            );
          } else {
            console.error(
              `      Mock API call failed for customer ${payload.customerId} (Migration): Status ${response.status}`
            );
            runResults.push({
              id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-migration`,
              status: "FAILURE",
              error: `API Error: ${response.status}, Message: ${parsedResult.message}`,
              payload: payload,
            });
          }
        } catch (error) {
          console.error(
            `      Mock fetch error for customer ${payload.customerId} (Migration): ${error instanceof Error ? error.message : String(error)}`
          );
          runResults.push({
            id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-migration`,
            status: "FAILURE",
            error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
            payload: payload,
          });
        }
      }

      console.log(
        `   Mock batchTrigger (collectPaymentJob) finished processing (Migration). Successful runs: ${runResults.filter((r) => r.status === "SUCCESS").length}`
      );

      return {
        batchId: `mock-batch-${Date.now()}-migration`,
        runs: runResults,
      };
    });
  });

  afterEach(async () => {
    // Restore mocks
    if (batchTriggerSpy) {
      batchTriggerSpy.mockRestore();
    }

    // Clean up the webhook process
    await paymentProvider?.cleanup();

    await clearEventData();
  });

  afterAll(async () => {
    // Final cleanup of the webhook process if needed
    await paymentProvider?.cleanup();
    // Clean up database records
    await cleanupDataFull();
  });

  it("should handle complete plan migration flow with billing cycle validation", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // ===== STEP 1: Create initial plan with monthly price, usage feature with pricing and credits =====
    console.log("Step 1: Creating initial plan with features and credits...");

    // Create plan with features and pricing
    const initialPlanResponse = await apiClient.plans.$post({
      json: {
        planName: "Migration Test Plan v1",
        planDescription: "Initial plan for testing migration flow",
        newFeatures: [
          {
            slug: "api-calls-migration",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 10, // $0.10 per call initially
            hasCreditAllowance: true,
            creditAllowanceAmount: 100, // 100 free calls initially
            creditAllowanceRenewal: "monthly",
          },
        ],
        monthlyPrice: 5000, // $50.00 initially
      },
    });

    expect(initialPlanResponse.status).toBe(200);
    const initialPlanBody = await initialPlanResponse.json();
    if ("error" in initialPlanBody) {
      throw new Error(`Failed to create plan: ${initialPlanBody.error}`);
    }
    const initialPlan = initialPlanBody.plans[0];
    initialPlanId = initialPlan.id;

    // Get the price that was created
    const pricesResponse = await apiClient.prices.$get({
      query: { planId: initialPlanId },
    });
    const pricesBody = await pricesResponse.json();
    if ("error" in pricesBody) {
      throw new Error(`Failed to get prices: ${pricesBody.error}`);
    }
    initialPrice = pricesBody.prices[0] as any; // Cast to handle API response date serialization

    console.log(`Initial plan created: ${initialPlanId}`);

    // ===== STEP 2: Subscribe customer via public payment-init (production flow) =====
    console.log("Step 2: Subscribing customer via payment-init flow...");

    const baseApiClient = createTestApiClient();

    // Re-use the customer created in the test setup so payment-init links correctly
    customerEmail = `migration-test-${Date.now()}@example.com`;
    const userId = `user-migration-${Date.now()}`;

    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: initialPrice.id,
        planId: initialPlanId,
        userId,
        customerEmail,
        customerName: "Migration Test Customer",
        businessName: "Migration Test GmbH",
      },
    });

    expect(paymentInitResponse.status).toBe(200);
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    if (!("intentId" in paymentInitData)) {
      throw new Error(
        "Expected Stripe payment intent but got direct subscription response"
      );
    }

    await stripeClient.paymentIntents.confirm(paymentInitData.intentId, {
      payment_method: "pm_card_visa",
    });

    // Wait for webhook to create the customer & subscription records
    await sleep(3000);

    const dbCustomer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    if (!dbCustomer) throw new Error("Customer not created by payment-init");
    customerId = dbCustomer.id;

    const dbSubscription = await db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.customerId, customerId),
        eq(subscriptions.planId, initialPlanId)
      ),
    });
    if (!dbSubscription)
      throw new Error("Subscription not created by payment-init");
    subscriptionId = dbSubscription.id;

    console.log(`Subscription created via payment-init: ${subscriptionId}`);

    // ===== STEP 3: Send usage events =====
    console.log("Step 3: Sending usage events...");

    const usageAmount = 150; // 150 API calls (50 over initial limit of 100)

    // Send events in the middle of what will be our billing period
    // We'll set up billing period to be [30 days ago, now] so events fall within it
    const eventTimestamp = new Date(testStartTime.getTime() - 15 * 86400000); // 15 days ago

    const eventResponse = await apiClient.events.$post({
      json: {
        eventName: "api_call",
        customerId,
        idempotencyKey: `migration-event-${Date.now()}`,
        eventTimestamp: eventTimestamp.toISOString(),
        eventValue: usageAmount,
      },
    });

    expect(eventResponse.status).toBe(202);
    console.log(
      `Sent ${usageAmount} API call events at ${eventTimestamp.toISOString()}`
    );

    // Wait for event processing
    await sleep(1000);

    // ===== STEP 4: Edit plan to change pricing and credits =====
    console.log("Step 4: Editing plan to change pricing and credits...");

    const { editPlan } = await import("../../src/helpers/plans");
    const editResult = await editPlan(initialPlanId, merchantId, {
      planName: "Migration Test Plan v2",
      planDescription: "Updated plan after migration",
      features: [
        {
          slug: "api-calls-migration",
          featureName: "API Calls",
          eventName: "api_call",
          isUsageBased: true,
          usagePricePerUnit: 15, // Changed from $0.10 to $0.15 per call
          hasCreditAllowance: true,
          creditAllowanceAmount: 200, // Changed from 100 to 200 free calls
          creditAllowanceRenewal: "monthly",
        },
      ],
      monthlyPrice: 7500, // Changed from $50.00 to $75.00
    });

    expect(editResult).toHaveProperty("success", true);
    if (!("success" in editResult)) {
      throw new Error("Edit plan failed");
    }

    const newPlan = editResult.plan as any;
    const newPlanId = newPlan.id;

    expect(editResult.changeAnalysis.isNewVersion).toBe(true);
    expect(editResult.migrationInfo.requiresMigration).toBe(true);
    expect(newPlan.versionNumber).toBe(2);

    console.log(`New plan version created: ${newPlanId}`);
    console.log(
      `Migration required: ${editResult.migrationInfo.requiresMigration}`
    );

    // Schedule migration via API so it runs at next billing cycle
    console.log("Scheduling migration via /plans/:stablePlanId/migrate ...");

    // Get price IDs for mapping
    const originalPriceId = initialPrice.id;
    const targetPlanPrices = await db.query.prices.findMany({
      where: eq(prices.planId, newPlanId),
    });
    const newPriceId = targetPlanPrices[0].id;

    const migrateResp = await apiClient.plans[":stablePlanId"]["migrate"].$post(
      {
        param: { stablePlanId: initialPlan.stablePlanId },
        json: {
          strategy: "next_billing_cycle",
          fromVersion: 1,
          toVersion: 2,
          priceMapping: {
            [originalPriceId]: newPriceId,
          },
        },
      }
    );

    expect(migrateResp.status).toBe(200);
    console.log("Migration scheduled successfully");

    // ===== STEP 5: Run billing cycle =====
    console.log("Step 5: Running billing cycle...");

    // Set up proper billing period that includes our events
    const billingPeriodStart = new Date(
      testStartTime.getTime() - 30 * 86400000
    ); // 30 days ago
    const billingPeriodEnd = new Date(testStartTime.getTime() - 60000); // 1 minute ago (due for billing)
    const subscriptionStartDate = new Date(
      testStartTime.getTime() - 60 * 86400000
    ); // 60 days ago

    console.log("Setting up billing period:", {
      subscriptionStartDate: subscriptionStartDate.toISOString(),
      billingPeriodStart: billingPeriodStart.toISOString(),
      billingPeriodEnd: billingPeriodEnd.toISOString(),
      eventTimestamp: new Date(
        testStartTime.getTime() - 15 * 86400000
      ).toISOString(),
    });

    // Update subscription start date
    await db
      .update(subscriptions)
      .set({
        startTimestamp: subscriptionStartDate,
      })
      .where(eq(subscriptions.id, subscriptionId));

    // Get current subscription details to set up proper billing period
    const currentSubDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    expect(currentSubDetails.length).toBeGreaterThan(0);

    // Set up billing period: [30 days ago, 1 minute ago] so events at 15 days ago fall within it
    for (const detail of currentSubDetails) {
      await db
        .update(subscriptionDetails)
        .set({
          subscriptionStartDate: subscriptionStartDate,
          previousBillingDate: billingPeriodStart, // Start of current billing period
          nextBillingDate: billingPeriodEnd, // End of period (due for billing)
        })
        .where(eq(subscriptionDetails.id, detail.id));

      console.log(`Set up billing period for detail ${detail.id}:`, {
        subscriptionStartDate: subscriptionStartDate.toISOString(),
        previousBillingDate: billingPeriodStart.toISOString(),
        nextBillingDate: billingPeriodEnd.toISOString(),
      });
    }

    // Run billing cycle
    const billingResult = await processBillingCycle(
      apiUrl,
      triggerApiAccessKey
    );

    await sleep(3000);
    console.log("Billing cycle processed. Results: ", billingResult);

    expect(billingResult.subscriptionsProcessed).toBeGreaterThan(0);

    // ===== STEP 6: Validate all results =====
    console.log("Step 6: Validating results...");

    // 6a. Validate invoice creation and line items
    const createdInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          eq(invoices.subscriptionId, subscriptionId)
        )
      );

    expect(createdInvoices.length).toBe(2); // Initial payment + migration billing cycle

    // Sort by creation date to get the latest (migration) invoice
    const sortedInvoices = createdInvoices.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const invoice = sortedInvoices[0]; // Latest invoice (after migration)
    expect(invoice.status).toBe("paid");

    // Get line items
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    expect(lineItems.length).toBe(4); // Monthly fee + usage charges + credit grant + tax line item

    // Validate monthly fee line item (should use NEW pricing)
    const monthlyLineItem = lineItems.find((item) => item.type === "fixed");
    expect(monthlyLineItem).toBeDefined();
    expect(monthlyLineItem!.subtotalCents).toBe(7500); // $75.00 (new price)

    // Validate usage line item (should use NEW credit allowance and pricing)
    const usageLineItem = lineItems.find((item) => item.type === "usage");
    expect(usageLineItem).toBeDefined();

    // The usage line item was processed with the old price of 10c per call (since bill_immediately == false)
    // Total usage cost is 150 * 10c = $15.00 but we're still using the old credit allowance of 100
    expect(usageLineItem!.subtotalCents).toBe(1500); // 150 usage * 10c = $15.00

    // So we're using 100 credits and getting a $10.00 credit grant
    const creditGrantLineItem = lineItems.find(
      (item) => item.type === "credit"
    );
    expect(creditGrantLineItem).toBeDefined();
    expect(creditGrantLineItem!.subtotalCents).toBe(-1000); // 100 credits * 10c = $10.00

    // Validate invoice total equals monthly fee (since usage is covered by credits)
    expect(invoice.totalAmountCents).toBe(7500 + 1500 - 1000); // Should equal monthly fee + usage cost - credit grant

    // 6b. Validate credit definitions
    const { creditDefinitions } = await import("@lumen/common/schema");

    // Check for new credit definitions on the new plan
    const newCreditDefs = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, newPlanId),
        eq(creditDefinitions.featureSlug, "api-calls-migration"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(newCreditDefs.length).toBe(1);
    const newCreditDef = newCreditDefs[0];
    expect(newCreditDef.defaultAmount).toBe(200); // New credit amount
    expect(newCreditDef.renewOnBilling).toBe(true); // Should be billing-based

    // Check that old credit definitions exist but may be marked for non-renewal
    const oldCreditDefs = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, initialPlanId),
        eq(creditDefinitions.featureSlug, "api-calls-migration"),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(oldCreditDefs.length).toBe(1);
    const oldCreditDef = oldCreditDefs[0];
    expect(oldCreditDef.defaultAmount).toBe(100); // Original credit amount

    // 6c. Validate credit grants
    const { creditGrants } = await import("@lumen/common/schema");

    const creditGrantsForSubscription = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.planId, newPlanId),
        isNull(creditGrants.deletedAt)
      ),
    });

    expect(creditGrantsForSubscription.length).toBe(1);

    // Find the grant for our migrated subscription
    const migrationGrant = creditGrantsForSubscription.find(
      (grant) => grant.creditDefinitionId === newCreditDef.id
    );
    expect(migrationGrant).toBeDefined();
    expect(migrationGrant!.initialAmount).toBe(200); // New credit amount

    // 6d. Validate subscription is now on new plan
    const updatedSubscription = await db.query.subscriptions.findFirst({
      where: eq(
        subscriptions.stableSubscriptionId,
        dbSubscription.stableSubscriptionId // this is the OLD subs object
      ),
      orderBy: (subscriptions, { desc }) => [desc(subscriptions.versionNumber)],
    });

    expect(updatedSubscription).toBeDefined();
    expect(updatedSubscription!.planId).toBe(newPlanId);

    // 6e. Validate subscription details still exist and are properly linked
    const updatedSubDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });

    expect(updatedSubDetails.length).toBe(2); // fixed + usage

    // Verify the subscription details have been updated after billing
    const billedDetails = updatedSubDetails.filter(
      (detail) => detail.cyclesBilled > 0
    );
    expect(billedDetails.length).toBe(2); // fixed + usage
  }, 60000); // Long timeout for complex integration test

  it("should handle feature migration with immediate strategy when no price changes are detected", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // ===== STEP 1: Create initial plan with features =====
    console.log("Step 1: Creating initial plan with features...");

    const featureSlug = `api-calls-feature-${Date.now()}`;
    const initialPlanResponse = await apiClient.plans.$post({
      json: {
        planName: "Feature Migration Plan v1",
        planDescription: "Initial plan before feature migration",
        newFeatures: [
          {
            slug: featureSlug,
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 10, // $0.10 per call
            hasCreditAllowance: true,
            creditAllowanceAmount: 100,
            creditAllowanceRenewal: "monthly",
          },
          {
            slug: "premium-support",
            featureName: "Premium Support",
            isUsageBased: false,
          },
        ],
        monthlyPrice: 5000, // $50.00
      },
    });

    expect(initialPlanResponse.status).toBe(200);
    const initialPlanBody = await initialPlanResponse.json();
    if ("error" in initialPlanBody) {
      throw new Error(`Failed to create plan: ${initialPlanBody.error}`);
    }
    const initialPlan = initialPlanBody.plans[0];
    const initialPlanId = initialPlan.id;

    // Get the price that was created
    const pricesResponse = await apiClient.prices.$get({
      query: { planId: initialPlanId },
    });
    const pricesBody = await pricesResponse.json();
    if ("error" in pricesBody) {
      throw new Error(`Failed to get prices: ${pricesBody.error}`);
    }
    const initialPrice = pricesBody.prices[0];

    console.log(`Initial plan created: ${initialPlanId}`);

    // ===== STEP 2: Create subscription =====
    console.log("Step 2: Creating subscription...");

    const createSubResp = await apiClient.subscriptions.$post({
      json: {
        customerId,
        planId: initialPlanId,
        effectivePriceId: initialPrice.id,
        startTimestamp: new Date().toISOString(),
      },
    });

    expect(createSubResp.status).toBe(201);
    const createSubBody = await createSubResp.json();
    if ("error" in createSubBody) {
      throw new Error(`Failed to create subscription: ${createSubBody.error}`);
    }
    if (!createSubBody.subscription) {
      throw new Error("Subscription data missing in response");
    }

    const subscriptionId = createSubBody.subscription.id;
    const stableSubscriptionId =
      createSubBody.subscription.stableSubscriptionId;

    console.log(`Subscription created: ${subscriptionId}`);

    // ===== STEP 3: Edit plan (feature changes only, no price changes) =====
    console.log("Step 3: Editing plan with feature changes only...");

    const { editPlan } = await import("../../src/helpers/plans");
    const editResult = await editPlan(initialPlanId, merchantId, {
      planName: "Feature Migration Plan v2",
      planDescription: "Updated features for immediate migration",
      features: [
        {
          slug: featureSlug,
          featureName: "API Calls",
          eventName: "api_call",
          isUsageBased: true,
          usagePricePerUnit: 10, // unchanged unit price
          hasCreditAllowance: true,
          creditAllowanceAmount: 150, // UPDATED credit allowance
          creditAllowanceRenewal: "monthly",
        },
        {
          slug: "premium-support",
          featureName: "Premium Support",
          isUsageBased: false,
        },
        {
          slug: "advanced-analytics", // NEW feature
          featureName: "Advanced Analytics",
          isUsageBased: false,
        },
      ],
      monthlyPrice: 5000, // unchanged fixed price
    });

    expect(editResult).toHaveProperty("success", true);
    if (!("success" in editResult)) {
      throw new Error("Edit plan failed");
    }

    const newPlan = editResult.plan as any;
    const newPlanId = newPlan.id;

    expect(editResult.changeAnalysis.isNewVersion).toBe(true);
    expect(editResult.changeAnalysis.hasFeatureChanges).toBe(true);
    expect(editResult.changeAnalysis.hasPriceChanges).toBe(false); // No price changes
    expect(editResult.changeAnalysis.canUseImmediate).toBe(true); // Should allow immediate migration
    expect(editResult.migrationInfo.requiresMigration).toBe(true);
    expect(newPlan.versionNumber).toBe(2);

    console.log(`New plan version created: ${newPlanId}`);
    console.log(
      `Migration analysis - canUseImmediate: ${editResult.changeAnalysis.canUseImmediate}`
    );

    // ===== STEP 4: Migrate with immediate strategy =====
    console.log("Step 4: Migrating with immediate strategy...");

    // Get price IDs for mapping
    const originalPriceId = initialPrice.id;
    const targetPlanPrices = await db.query.prices.findMany({
      where: eq(prices.planId, newPlanId),
    });
    const newPriceId = targetPlanPrices[0].id;

    const migrateResp = await apiClient.plans[":stablePlanId"]["migrate"].$post(
      {
        param: { stablePlanId: initialPlan.stablePlanId },
        json: {
          strategy: "immediate",
          fromVersion: 1,
          toVersion: 2,
          priceMapping: {
            [originalPriceId]: newPriceId,
          },
        },
      }
    );

    expect(migrateResp.status).toBe(200);
    const migrateBody = await migrateResp.json();
    if ("error" in migrateBody) {
      throw new Error(`Migration failed: ${migrateBody.error}`);
    }
    expect(migrateBody.success).toBe(true);
    expect(migrateBody.migratedCount).toBe(1);

    console.log("Migration completed successfully");

    // ===== STEP 5: Validate subscription update =====
    console.log("Step 5: Validating subscription update...");

    const updatedSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.stableSubscriptionId, stableSubscriptionId),
      orderBy: (subscriptions, { desc }) => [desc(subscriptions.versionNumber)],
    });

    expect(updatedSub).toBeDefined();
    expect(updatedSub!.versionNumber).toBe(2);
    expect(updatedSub!.planId).toBe(newPlanId);
    expect(updatedSub!.effectivePriceId).toBe(newPriceId);

    // ===== STEP 6: Validate updated features and credit definitions =====
    console.log("Step 6: Validating updated features and credits...");

    // Check subscription features
    const updatedSubFeatures = await db.query.subscriptionFeatures.findMany({
      where: and(
        eq(subscriptionFeatures.subscriptionId, updatedSub!.id),
        isNull(subscriptionFeatures.deletedAt)
      ),
      with: {
        feature: true,
      },
    });

    // Should have 3 features now (original 2 + new advanced-analytics)
    expect(updatedSubFeatures.length).toBe(3);

    const featureSlugs = updatedSubFeatures
      .map((sf) => sf.feature?.slug)
      .filter(Boolean);
    expect(featureSlugs).toContain(featureSlug);
    expect(featureSlugs).toContain("premium-support");
    expect(featureSlugs).toContain("advanced-analytics");

    // Check updated credit definitions
    const { creditDefinitions } = await import("@lumen/common/schema");
    const updatedCreditDefs = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, newPlanId),
        eq(creditDefinitions.featureSlug, featureSlug),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    expect(updatedCreditDefs.length).toBe(1);
    expect(updatedCreditDefs[0].defaultAmount).toBe(150); // Updated from 100 to 150

    // Check that new credit grants were created for the updated subscription
    const { creditGrants } = await import("@lumen/common/schema");
    const newCreditGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.planId, newPlanId),
        isNull(creditGrants.deletedAt)
      ),
    });

    expect(newCreditGrants.length).toBe(1);
    expect(newCreditGrants[0].initialAmount).toBe(150); // New credit amount

    console.log("Feature migration test completed successfully");
  }, 30000);
});

describe("Plan Deletion Prevention with Scheduled Migrations", () => {
  let merchantId: string;
  let customerId: string;
  let initialPlanId: string;
  let newPlanId: string;
  let sessionToken: string;

  beforeEach(async () => {
    // Clean up test data from previous tests
    await clearEventData();
    await cleanupTestData();

    // Set up test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create test customer
    const customer = await createTestCustomer({
      merchantId,
      email: `deletion-test-${Date.now()}@example.com`,
      name: "Deletion Test Customer",
      timezone: "America/Los_Angeles",
    });
    customerId = customer.id;
  });

  it("should cancel incoming migrations when plan version is deleted", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // ===== STEP 1: Create initial plan (v1) =====
    console.log("Step 1: Creating initial plan v1...");

    const initialPlanResponse = await apiClient.plans.$post({
      json: {
        planName: "Deletion Test Plan v1",
        planDescription: "Initial plan version",
        monthlyPrice: 5000, // $50.00
      },
    });

    expect(initialPlanResponse.status).toBe(200);
    const initialPlanBody = await initialPlanResponse.json();
    if ("error" in initialPlanBody) {
      throw new Error(`Failed to create plan: ${initialPlanBody.error}`);
    }
    const initialPlan = initialPlanBody.plans[0];
    initialPlanId = initialPlan.id;
    const stablePlanId = initialPlan.stablePlanId;

    // Get the price for v1
    const v1PricesResponse = await apiClient.prices.$get({
      query: { planId: initialPlanId },
    });
    const v1PricesBody = await v1PricesResponse.json();
    if ("error" in v1PricesBody) {
      throw new Error(`Failed to get v1 prices: ${v1PricesBody.error}`);
    }
    const v1Price = v1PricesBody.prices[0];

    console.log(`Initial plan v1 created: ${initialPlanId}`);

    // ===== STEP 2: Create subscription on v1 =====
    console.log("Step 2: Creating subscription on v1...");

    const createSubResp = await apiClient.subscriptions.$post({
      json: {
        customerId,
        planId: initialPlanId,
        effectivePriceId: v1Price.id,
        startTimestamp: new Date().toISOString(),
      },
    });

    expect(createSubResp.status).toBe(201);
    const createSubBody = await createSubResp.json();
    if ("error" in createSubBody) {
      throw new Error(`Failed to create subscription: ${createSubBody.error}`);
    }
    const subscriptionId = createSubBody.subscription!.id;

    console.log(`Subscription created on v1: ${subscriptionId}`);

    // ===== STEP 3: Edit plan to create v2 =====
    console.log("Step 3: Creating plan v2...");

    // Use the public API to edit the plan so we mirror the real-world flow
    const editResp = await apiClient.plans[":id"]["edit"].$post({
      param: { id: initialPlanId },
      json: {
        planName: "Deletion Test Plan v2",
        planDescription: "Updated plan version",
        monthlyPrice: 7500, // Changed price to $75.00
      },
    });

    expect(editResp.status).toBe(200);
    const editBody = await editResp.json();
    if ("error" in editBody) {
      throw new Error(`Edit plan failed: ${editBody.error}`);
    }

    // The edit endpoint returns the same structure as the helper result
    const newPlan = editBody.plan as any;
    if (!newPlan) {
      throw new Error("Edited plan data missing in response");
    }

    newPlanId = newPlan.id;

    // Basic sanity checks on the edit response
    expect(editBody).toHaveProperty("success", true);
    expect(editBody.changeAnalysis.isNewVersion).toBe(true);
    expect(newPlan.versionNumber).toBe(2);

    console.log(`Plan v2 created: ${newPlanId}`);

    // ===== STEP 4: Schedule migration from v1 to v2 =====
    console.log("Step 4: Scheduling migration from v1 to v2...");

    // Get price for v2
    const v2PricesResponse = await apiClient.prices.$get({
      query: { planId: newPlanId },
    });
    const v2PricesBody = await v2PricesResponse.json();
    if ("error" in v2PricesBody) {
      throw new Error(`Failed to get v2 prices: ${v2PricesBody.error}`);
    }
    const v2Price = v2PricesBody.prices[0];

    // Schedule migration to v2
    const migrateResp = await apiClient.plans[":stablePlanId"]["migrate"].$post(
      {
        param: { stablePlanId },
        json: {
          strategy: "next_billing_cycle",
          fromVersion: 1,
          toVersion: 2,
          priceMapping: {
            [v1Price.id]: v2Price.id,
          },
        },
      }
    );

    expect(migrateResp.status).toBe(200);
    const migrateBody = await migrateResp.json();
    if ("error" in migrateBody) {
      throw new Error(`Migration failed: ${migrateBody.error}`);
    }
    expect(migrateBody.success).toBe(true);
    expect(migrateBody.scheduledCount).toBe(1);

    console.log("Migration scheduled successfully from v1 to v2");

    // ===== STEP 5: Verify scheduled migration exists =====
    console.log("Step 5: Verifying scheduled migration exists...");

    const { subscriptionsScheduledChanges } = await import(
      "@lumen/common/schema"
    );
    const scheduledChanges =
      await db.query.subscriptionsScheduledChanges.findMany({
        where: and(
          eq(subscriptionsScheduledChanges.newPlanId, newPlanId),
          isNull(subscriptionsScheduledChanges.processedAt)
        ),
      });

    expect(scheduledChanges.length).toBe(1);
    expect(scheduledChanges[0].subscriptionId).toBe(subscriptionId);
    expect(scheduledChanges[0].newPlanId).toBe(newPlanId);

    console.log(
      `Scheduled migration found targeting v2: ${scheduledChanges[0].id}`
    );

    // ===== STEP 6: Delete v2 (should succeed, migrations will be cancelled) =====
    console.log("Step 6: Deleting v2 (migrations should cancel)...");

    const deleteResponse = await apiClient.plans[":id"].$delete({
      param: { id: newPlanId },
    });

    expect(deleteResponse.status).toBe(200);
    const deleteBody = await deleteResponse.json();
    if ("error" in deleteBody) {
      throw new Error(`Unexpected deletion failure: ${deleteBody.error}`);
    }

    expect(deleteBody.success).toBe(true);

    console.log("Deletion succeeded; verifying cancellations...");

    // ===== STEP 7: Verify migrations are cancelled =====
    const cancelledChanges =
      await db.query.subscriptionsScheduledChanges.findMany({
        where: eq(subscriptionsScheduledChanges.newPlanId, newPlanId),
      });

    expect(cancelledChanges.length).toBe(1);
    expect(cancelledChanges[0].processedAt).not.toBeNull();

    // ===== STEP 8: Verify v2 is marked deleted =====
    const planDeleted = await db.query.plans.findFirst({
      where: eq(plans.id, newPlanId),
    });

    expect(planDeleted).toBeDefined();
    expect(planDeleted!.deletedAt).not.toBeNull();

    console.log("Plan v2 correctly deleted; migrations cancelled");
  }, 30000);

  it("should allow deletion when no incoming migrations exist", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a simple plan
    const planResponse = await apiClient.plans.$post({
      json: {
        planName: "Simple Deletion Test Plan",
        planDescription: "Plan with no migrations",
        monthlyPrice: 5000,
      },
    });

    expect(planResponse.status).toBe(200);
    const planBody = await planResponse.json();
    if ("error" in planBody) {
      throw new Error(`Failed to create plan: ${planBody.error}`);
    }
    const planId = planBody.plans[0].id;

    // Attempt deletion (should succeed)
    const deleteResponse = await apiClient.plans[":id"].$delete({
      param: { id: planId },
    });

    expect(deleteResponse.status).toBe(200);
    const deleteBody = await deleteResponse.json();
    if ("error" in deleteBody) {
      throw new Error(`Unexpected deletion failure: ${deleteBody.error}`);
    }

    expect(deleteBody.success).toBe(true);

    // Verify plan is deleted
    const planAfterDeletion = await db.query.plans.findFirst({
      where: eq(plans.id, planId),
    });

    expect(planAfterDeletion!.deletedAt).not.toBeNull();
  }, 15000);
});
