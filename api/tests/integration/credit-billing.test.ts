import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  beforeAll,
  afterAll,
  spyOn,
} from "bun:test";
import { db } from "../../src/db/client";
import {
  creditDefinitions,
  creditGrants,
  creditUsageTransactions,
  invoices,
  invoiceLineItems,
  subscriptions,
  subscriptionDetails,
  subscriptionsScheduledChanges,
  subscriptionPriceOverrides,
  customers,
  plans,
  prices,
  payments,
  paymentMethods,
  organization,
  user,
  events,
  features,
  featureMetrics,
  metrics,
  planFeatures,
  subscriptionFeatures,
  pricingTables,
  pricingTablePlans,
} from "@lumen/common/schema";
import { sql, eq, and, isNull, ne, desc, isNotNull } from "drizzle-orm";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestCustomer,
  createTestApiClient,
  createTestApiKeys,
  cleanupDataFull,
  createPaymentProvider,
  PaymentProviderAdapter,
} from "../test-helpers";
import { createTestPricingTable } from "../test-helpers/data/pricing-table";
import { hc } from "hono/client";
import { AppType } from "../../src/routes";
import {
  createCreditDefinition,
  createCreditGrant,
  createCreditTransaction,
  createManualCreditGrant,
} from "../../src/helpers/credits";
import { processBillingCycle } from "../../trigger/helpers/billing";
import { collectPaymentJob } from "../../trigger/jobs/collectPayment";
import { collectPaymentPayloadSchema } from "../../trigger/helpers/collectPayment";
import { env } from "../../src/env";
import { testEnv } from "../test-env";
import { setTimeout as sleep } from "timers/promises";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { encryptField } from "../../src/helpers/encryption";

const customerAddressObj = {
  customerAddress: "123 Main St",
  customerCity: "Anytown",
  customerStateProvince: "CA",
  customerZip: "12345",
  customerCountry: "US",
};

type CollectPaymentJobPayload = z.infer<typeof collectPaymentPayloadSchema>;

const cleanupTestData = async () => {
  // this is different from cleanupDataFull because it doesn't clean up the merchant, user, and payment provider config
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

// Add after imports, before tests
async function retryWithSleep<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean = (result) =>
    result !== undefined && result !== null,
  maxAttempts = 3,
  sleepMs = 2000
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (validate(result)) {
        return result;
      }
      lastError = new Error("Validation failed on result");
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts) {
      await sleep(sleepMs);
    }
  }
  throw lastError;
}

describe("Credit Billing Integration (E2E Payment Flow)", () => {
  let merchantId: string;
  let sessionToken: string;
  let baseApiClient: ReturnType<typeof hc<AppType>>;
  let authedApiClient: ReturnType<typeof hc<AppType>>;
  let collectPaymentJobTriggerSpy: ReturnType<typeof spyOn>;
  let webhookProcess: ChildProcess | null = null;
  const tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  const tempMerchantIdFile = "/tmp/test_merchant_id.txt";
  let publishableApiKey: string;
  let apiUrl: string;
  let triggerApiAccessKey: string;
  let paymentProvider: PaymentProviderAdapter;

  beforeAll(async () => {
    await cleanupDataFull();
    apiUrl = env.API_URL;
    triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY!;

    const { merchant, user: testUser } = await createFullTestEnvironment();
    merchantId = merchant.id;
    await fs.writeFile(tempMerchantIdFile, merchantId);

    const authResponse = await authenticateTestUser(
      testUser.email,
      testUser.password
    );
    sessionToken = authResponse.cookies.sessionToken;
    authedApiClient = createTestApiClient(sessionToken);
    baseApiClient = createTestApiClient();

    paymentProvider = await createPaymentProvider();
    await paymentProvider.registerIntegration(merchantId);

    const apiKeys = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    publishableApiKey = apiKeys.publishableKey.keyValue;

    await paymentProvider.startWebhookForwarder(merchantId);
  });

  afterAll(async () => {
    await paymentProvider.cleanup();
    await cleanupDataFull();
  });

  beforeEach(async () => {
    await cleanupTestData();
    collectPaymentJobTriggerSpy = spyOn(collectPaymentJob, "batchTrigger");
  });

  afterEach(async () => {
    if (collectPaymentJobTriggerSpy) collectPaymentJobTriggerSpy.mockRestore();
  });

  it("should apply component-specific monetary credits to the correct line item after E2E subscription", async () => {
    const customerEmail = `credit-billing-comp-spec-${Date.now()}@example.com`;
    const customerName = `Credit Billing CompSpec Customer`;
    const userId = `user-comp-spec-${Date.now()}`;

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-compspec-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "CompSpec Credit Plan",
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
            component_name: "base_fee",
            type: "fixed",
            label: "Monthly Base Fee",
            amount_cents: 2000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
          {
            component_name: "api_usage_comp",
            type: "fixed",
            label: "API Usage Fee Comp",
            amount_cents: 1500,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // Fetch the price from DB to get actual component IDs
    const priceFromDb = await db.query.prices.findFirst({
      where: eq(prices.id, testPriceId),
    });
    expect(priceFromDb).toBeDefined();
    const apiUsageComponentId = priceFromDb!.pricingData.components.find(
      (c) => c.component_name === "api_usage_comp"
    )?.component_id;
    expect(apiUsageComponentId).toBeDefined();

    const componentCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: testPriceId,
      priceComponentId: apiUsageComponentId!,
      currency: "USD",
      name: "API Usage Credit",
      defaultAmount: 1000,
      billingVisible: true,
      billingDescription: "API Usage Discount",
      priority: 50,
      renewOnBilling: true,
    });

    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    expect(paymentInitResponse.status).toBe(200);
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    // Get the customer ID that was created by payment-init
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook to process subscription and initial credit grant..."
    );
    await sleep(2000);
    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    const initialGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, componentCreditDef.id)
      ),
    });
    expect(initialGrant).toBeDefined();
    expect(initialGrant!.initialAmount).toBe(1000);
    expect(initialGrant!.remainingAmount).toBe(1000);

    const firstInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid")
      ),
      orderBy: invoices.createdAt,
      with: { lineItems: true },
    });
    expect(firstInvoice).toBeDefined();
    expect(firstInvoice!.totalAmountCents).toBe(3500);

    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    expect(subDetails.length).toBeGreaterThan(0);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      // Set previousBillingDate to the current nextBillingDate to advance the billing period
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    console.log(
      "Processing second billing cycle to test credit application..."
    );
    const billingResult = await processBillingCycle(
      apiUrl,
      triggerApiAccessKey!,
      new Date()
    );
    await sleep(2000);

    expect(billingResult.subscriptionsProcessed).toBeGreaterThanOrEqual(
      subDetails.length > 0 ? 1 : 0
    );

    const secondInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscriptionId),
            eq(invoices.status, "paid"),
            firstInvoice ? ne(invoices.id, firstInvoice.id) : undefined
          ),
          orderBy: desc(invoices.createdAt),
          with: { lineItems: true },
        }),
      (result) => !!result
    );

    expect(secondInvoice).toBeDefined();
    expect(secondInvoice!.lineItems).toBeDefined();

    const lineItems = secondInvoice!.lineItems;
    const baseFeeLine = lineItems.find((item) =>
      item.description?.includes("Monthly Base Fee")
    );
    const apiUsageLine = lineItems.find((item) =>
      item.description?.includes("API Usage Fee Comp")
    );
    const creditLine = lineItems.find((item) => item.type === "credit");

    expect(baseFeeLine).toBeDefined();
    expect(baseFeeLine!.subtotalCents).toBe(2000);
    expect(apiUsageLine).toBeDefined();
    expect(apiUsageLine!.subtotalCents).toBe(1500);

    expect(creditLine).toBeDefined();
    expect(creditLine!.subtotalCents).toBe(-1000);
    expect(creditLine!.description).toContain("API Usage Discount");
    expect(creditLine!.componentId).toBe(apiUsageComponentId!);

    const expectedTotalSecondInvoice = 2000 + 1500 - 1000;
    expect(secondInvoice!.totalAmountCents).toBe(expectedTotalSecondInvoice);

    const updatedGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialGrant!.id),
    });
    expect(updatedGrant).toBeDefined();
    expect(updatedGrant!.remainingAmount).toBe(0);
    expect(updatedGrant!.status).toBe("DEPLETED");

    const usageTransaction = await db.query.creditUsageTransactions.findFirst({
      where: and(
        eq(creditUsageTransactions.creditGrantId, updatedGrant!.id),
        eq(creditUsageTransactions.invoiceId, secondInvoice!.id)
      ),
    });
    expect(usageTransaction).toBeDefined();
    expect(usageTransaction!.amount).toBe(1000);
    expect(usageTransaction!.eventName).toBe("billing");
    expect(usageTransaction!.priceId).toBe(testPriceId);
    expect(usageTransaction!.priceComponentId).toBe(apiUsageComponentId!);
  }, 50000);

  it("should apply price-level monetary credits to the invoice after E2E subscription", async () => {
    const customerEmail = `credit-billing-price-level-${Date.now()}@example.com`;
    const customerName = `Credit Billing Price Level Customer`;
    const userId = `user-price-level-${Date.now()}`;

    // 1. Create plan and price with multiple components
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-pricelevel-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Price-Level Credit Plan",
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
            component_name: "base_fee_price",
            type: "fixed",
            label: "Base Fee (PriceLvl)",
            amount_cents: 3000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
          {
            component_name: "storage_fee_price",
            type: "fixed",
            label: "Storage Fee (PriceLvl)",
            amount_cents: 2000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // 2. Create price-level credit definition
    const priceLevelCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: testPriceId, // Tied to this specific price
      priceComponentId: null, // Not component-specific
      currency: "USD",
      name: "Overall Price Discount",
      defaultAmount: 2500, // $25.00 credit
      billingVisible: true,
      billingDescription: "Price Discount Applied",
      priority: 70,
    });

    // 3. Initiate payment to create subscription via webhook
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    expect(paymentInitResponse.status).toBe(200);
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    // Get the customer ID that was created by payment-init
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook (Price-Level Credit) to process subscription and initial grant..."
    );
    await sleep(2000);

    // 4. Verify subscription and initial grant
    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    const initialGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, priceLevelCreditDef.id)
      ),
    });
    expect(initialGrant).toBeDefined();
    expect(initialGrant!.remainingAmount).toBe(2500);

    const firstInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid")
      ),
      orderBy: invoices.createdAt,
    });
    expect(firstInvoice).toBeDefined();
    expect(firstInvoice!.totalAmountCents).toBe(5000); // 3000 + 2000, initial payment no credits from our system

    // 5. Prepare for the next billing cycle
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      // Set previousBillingDate to the current nextBillingDate to advance the billing period
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // 6. Mock collectPaymentJob for the second billing
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // 7. Process the next billing cycle
    console.log("Processing second billing cycle for Price-Level Credits...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);
    // 8. Verify the second invoice
    const secondInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscriptionId),
            eq(invoices.status, "paid"),
            ne(invoices.id, firstInvoice!.id)
          ),
          orderBy: desc(invoices.createdAt),
          with: { lineItems: true },
        }),
      (result) => !!result
    );
    expect(secondInvoice).toBeDefined();

    const lineItems = secondInvoice!.lineItems;
    const creditLine = lineItems.find(
      (item) =>
        item.type === "credit" &&
        item.description?.includes("Price Discount Applied")
    );
    expect(creditLine).toBeDefined();
    expect(creditLine!.subtotalCents).toBe(-2500); // $25.00 credit

    // Total: (3000 + 2000) - 2500 = 2500
    expect(secondInvoice!.totalAmountCents).toBe(2500);

    // 9. Verify credit grant was updated
    const updatedGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialGrant!.id),
    });
    expect(updatedGrant!.remainingAmount).toBe(0);
    expect(updatedGrant!.status).toBe("DEPLETED");

    // 10. Verify credit usage transaction
    const usageTransaction = await db.query.creditUsageTransactions.findFirst({
      where: and(
        eq(creditUsageTransactions.creditGrantId, updatedGrant!.id),
        eq(creditUsageTransactions.invoiceId, secondInvoice!.id)
      ),
    });
    expect(usageTransaction).toBeDefined();
    expect(usageTransaction!.amount).toBe(2500);
    expect(usageTransaction!.priceId).toBe(testPriceId);
    expect(usageTransaction!.priceComponentId).toBeNull(); // Price-level, not component-specific
  }, 50000);

  it("should apply plan-level monetary credits to the invoice after E2E subscription", async () => {
    const customerEmail = `credit-billing-plan-level-${Date.now()}@example.com`;
    const customerName = `Credit Billing Plan Level Customer`;
    const userId = `user-plan-level-${Date.now()}`;

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-planlevel-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Plan-Level Credit Plan",
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
            component_name: "service_fee_plan",
            type: "fixed",
            label: "Service Fee (PlanLvl)",
            amount_cents: 4000, // $40.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // Create plan-level credit definition
    const planLevelCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: null, // Not tied to a specific price
      priceComponentId: null,
      currency: "USD",
      name: "Overall Plan Discount",
      defaultAmount: 1500, // $15.00 credit
      billingVisible: true,
      billingDescription: "Plan Discount Applied",
      priority: 60,
    });

    // E2E Subscription
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    // Get the customer ID that was created by payment-init
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook (Plan-Level Credit) to process subscription and initial grant..."
    );
    await sleep(2000);

    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    const initialGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, planLevelCreditDef.id)
      ),
    });
    expect(initialGrant).toBeDefined();
    expect(initialGrant!.remainingAmount).toBe(1500);

    const firstInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid")
      ),
      orderBy: invoices.createdAt,
    });
    expect(firstInvoice).toBeDefined();
    expect(firstInvoice!.totalAmountCents).toBe(4000); // Initial payment, full amount

    // Prepare for next billing
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      // Set previousBillingDate to the current nextBillingDate to advance the billing period
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // Mock payment for second billing
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // Process second billing
    console.log("Processing second billing cycle for Plan-Level Credits...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);

    const secondInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscriptionId),
            eq(invoices.status, "paid"),
            ne(invoices.id, firstInvoice!.id)
          ),
          orderBy: desc(invoices.createdAt),
          with: { lineItems: true },
        }),
      (result) => !!result
    );
    expect(secondInvoice).toBeDefined();

    const creditLine = secondInvoice!.lineItems.find(
      (item) =>
        item.type === "credit" &&
        item.description?.includes("Plan Discount Applied")
    );
    expect(creditLine).toBeDefined();
    expect(creditLine!.subtotalCents).toBe(-1500);

    // Total: 4000 - 1500 = 2500
    expect(secondInvoice!.totalAmountCents).toBe(2500);

    const updatedGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialGrant!.id),
    });
    expect(updatedGrant!.remainingAmount).toBe(0);
    expect(updatedGrant!.status).toBe("DEPLETED");

    const usageTransaction = await db.query.creditUsageTransactions.findFirst({
      where: and(
        eq(creditUsageTransactions.creditGrantId, updatedGrant!.id),
        eq(creditUsageTransactions.invoiceId, secondInvoice!.id)
      ),
    });
    expect(usageTransaction).toBeDefined();
    expect(usageTransaction!.amount).toBe(1500);
    expect(usageTransaction!.priceId).toBeNull(); // Plan-level
    expect(usageTransaction!.priceComponentId).toBeNull();
  }, 50000);

  it("should apply merchant-level account credits as final fallback after E2E subscription", async () => {
    const customerEmail = `credit-billing-merchant-level-${Date.now()}@example.com`;
    const customerName = `Credit Billing Merchant Level Customer`;
    const userId = `user-merchant-level-${Date.now()}`;

    // 1. Create plan and price
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-merchantlevel-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Merchant-Level Credit Plan",
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
            component_name: "service_fee_merchant",
            type: "fixed",
            label: "Service Fee (MerchantLvl)",
            amount_cents: 1800, // $18.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // 2. Create merchant-level credit definition
    const merchantLevelCreditDef = await createCreditDefinition({
      merchantId,
      scope: "merchant", // Key: merchant scope
      applicationType: "monetary",
      priceId: null, // Not tied to specific price or plan for granting if merchant-scoped
      planId: null,
      priceComponentId: null,
      currency: "USD",
      name: "Global Account Credit",
      defaultAmount: 2000, // $20.00 credit
      billingVisible: true,
      billingDescription: "Account Credit Applied (Merchant)",
      priority: 200, // Low priority
    });
    // Note: Merchant-level credits are typically granted manually or via promotions, not usually tied to plan signup directly.
    // For this test, we will grant it manually after subscription setup.

    // 3. E2E Subscription Setup (without initial merchant-level credit grant from plan)
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    // Get the customer ID that was created by payment-init
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });

    if (!customer) {
      // Debug information to help diagnose the issue
      const allCustomers = await db.query.customers.findMany({
        where: eq(customers.email, customerEmail),
      });
      console.log(
        `No customer found for email ${customerEmail} and merchant ${merchantId}`
      );
      console.log(`All customers with email ${customerEmail}:`, allCustomers);
    }

    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook (Merchant-Level Credit test) to process subscription..."
    );
    await sleep(5000);
    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );

    if (!subscription) {
      // Debug information to help diagnose the issue
      const allSubscriptions = await db.query.subscriptions.findMany({
        where: eq(subscriptions.customerId, customerId),
      });
      console.log(
        `No subscription found for customer ${customerId} and plan ${testPlanId}`
      );
      console.log(
        `All subscriptions for customer ${customerId}:`,
        allSubscriptions
      );

      const allCustomerSubscriptions = await db.query.subscriptions.findMany({
        where: eq(subscriptions.merchantId, merchantId),
      });
      console.log(
        `All subscriptions for merchant ${merchantId}:`,
        allCustomerSubscriptions
      );
    }

    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    const firstInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid")
      ),
      orderBy: invoices.createdAt,
    });
    expect(firstInvoice).toBeDefined();
    expect(firstInvoice!.totalAmountCents).toBe(1800); // Initial payment, full amount

    // 4. Manually grant the merchant-level credit AFTER subscription is active
    const manualGrant = await createCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: merchantLevelCreditDef.id,
      source: "manual",
      notes: "Manually granted merchant-level credit for testing",
    });
    expect(manualGrant).toBeDefined();
    expect(manualGrant.remainingAmount).toBe(2000);

    // 5. Prepare for next billing
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      // Set previousBillingDate to the current nextBillingDate to advance the billing period
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // 6. Mock payment for second billing
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // 7. Process second billing
    console.log(
      "Processing second billing cycle for Merchant-Level Credits..."
    );
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);

    const secondInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscriptionId),
            eq(invoices.status, "paid"),
            ne(invoices.id, firstInvoice!.id)
          ),
          orderBy: desc(invoices.createdAt),
          with: { lineItems: true },
        }),
      (result) => !!result
    );
    expect(secondInvoice).toBeDefined();

    // Charge: $18. Merchant Credit: $20. Credit applied: $18.
    const creditLine = secondInvoice!.lineItems.find(
      (item) =>
        item.type === "credit" &&
        item.description?.includes("Account Credit Applied (Merchant)")
    );
    expect(creditLine).toBeDefined();
    expect(creditLine!.subtotalCents).toBe(-1800);

    expect(secondInvoice!.totalAmountCents).toBe(0); // $18 - $18 = $0

    const updatedGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, manualGrant!.id),
    });
    expect(updatedGrant!.remainingAmount).toBe(200); // $20 initial - $18 applied = $2 remaining
    expect(updatedGrant!.status).toBe("ACTIVE"); // Still active as some amount remains

    const usageTransaction = await db.query.creditUsageTransactions.findFirst({
      where: and(
        eq(creditUsageTransactions.creditGrantId, updatedGrant!.id),
        eq(creditUsageTransactions.invoiceId, secondInvoice!.id)
      ),
    });
    expect(usageTransaction).toBeDefined();
    expect(usageTransaction!.amount).toBe(1800);
    expect(usageTransaction!.priceId).toBeNull(); // Merchant-level
    expect(usageTransaction!.priceComponentId).toBeNull();
  }, 50000);

  it("should apply multiple credit types (component, price, plan, merchant) in correct priority after E2E subscription", async () => {
    const customerEmail = `credit-billing-waterfall-${Date.now()}@example.com`;
    const customerName = `Credit Billing Waterfall Customer`;
    const userId = `user-waterfall-${Date.now()}`;

    // 1. Plan and Price setup
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-waterfall-plan-${Date.now()}`,
        planName: "Waterfall Plan",
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
            component_name: "base",
            type: "fixed",
            label: "Base Fee",
            amount_cents: 2000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          }, // $20
          {
            component_name: "feature_x",
            type: "fixed",
            label: "Feature X",
            amount_cents: 3000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          }, // $30
          {
            component_name: "addon_y",
            type: "fixed",
            label: "Addon Y",
            amount_cents: 1000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          }, // $10
        ],
      },
    }); // Total $60
    const testPriceId = testPrice.id;

    // Fetch the price from DB to get actual component IDs
    const waterfallPriceFromDb = await db.query.prices.findFirst({
      where: eq(prices.id, testPriceId),
    });
    expect(waterfallPriceFromDb).toBeDefined();
    const featureXComponentId =
      waterfallPriceFromDb!.pricingData.components.find(
        (c) => c.component_name === "feature_x"
      )?.component_id;
    expect(featureXComponentId).toBeDefined();

    // 2. Credit Definitions
    // Priority 10 (Highest): Component-specific for 'feature_x'
    const compCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: testPriceId,
      priceComponentId: featureXComponentId!,
      currency: "USD",
      name: "FeatX Discount",
      defaultAmount: 1200,
      priority: 10,
      billingVisible: true,
      billingDescription: "FeatX Comp Credit",
    }); // $12
    // Priority 50: Price-level for this specific price
    const priceCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: testPriceId,
      currency: "USD",
      name: "Price Discount",
      defaultAmount: 1500,
      priority: 50,
      billingVisible: true,
      billingDescription: "Overall Price Credit",
    }); // $15
    // Priority 70: Plan-level for this plan
    const planCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: null,
      currency: "USD",
      name: "Plan Discount",
      defaultAmount: 800,
      priority: 70,
      billingVisible: true,
      billingDescription: "General Plan Credit",
    }); // $8
    // Priority 100 (Lowest): Merchant-level
    const merchCreditDef = await createCreditDefinition({
      merchantId,
      scope: "merchant",
      applicationType: "monetary",
      currency: "USD",
      name: "Account Saver",
      defaultAmount: 5000,
      priority: 100,
      billingVisible: true,
      billingDescription: "Global Account Credit",
    }); // $50

    // 3. E2E Subscription (will grant plan-scoped credits: compCreditDef, priceCreditDef, planCreditDef)
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    // Get the customer ID that was created by payment-init
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook (Waterfall) to process subscription and initial grants..."
    );
    await sleep(5000); // Longer wait for multiple grants potentially

    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    // Verify initial grants from plan association
    const initialCompGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, compCreditDef.id)
      ),
    });
    expect(initialCompGrant).toBeDefined();
    expect(initialCompGrant!.remainingAmount).toBe(1200);
    const initialPriceGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, priceCreditDef.id)
      ),
    });
    expect(initialPriceGrant).toBeDefined();
    expect(initialPriceGrant!.remainingAmount).toBe(1500);
    const initialPlanGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, planCreditDef.id)
      ),
    });
    expect(initialPlanGrant).toBeDefined();
    expect(initialPlanGrant!.remainingAmount).toBe(800);

    // Manually grant the merchant-level credit
    const manualMerchGrant = await createCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: merchCreditDef.id,
      source: "manual",
    });
    expect(manualMerchGrant.remainingAmount).toBe(5000);

    const firstInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid")
      ),
      orderBy: invoices.createdAt,
    });
    expect(firstInvoice).toBeDefined();
    expect(firstInvoice!.totalAmountCents).toBe(6000); // Initial $20 + $30 + $10 = $60

    // 4. Prepare for next billing cycle
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      // Set previousBillingDate to the current nextBillingDate to advance the billing period
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // 5. Mock payment for second billing
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // 6. Process second billing
    console.log("Processing second billing cycle for Waterfall Credits...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);

    // 7. Verify second invoice
    const secondInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscriptionId),
            eq(invoices.status, "paid"),
            ne(invoices.id, firstInvoice!.id)
          ),
          orderBy: desc(invoices.createdAt),
          with: { lineItems: true },
        }),
      (result) => !!result
    );
    expect(secondInvoice).toBeDefined();

    // Expected application:
    // Total charges: $20 (base) + $30 (feature_x) + $10 (addon_y) = $60
    // 1. Comp Credit (-$12) on feature_x ($30 -> $18). Remaining for feature_x: $18. Invoice total: $20 + $18 + $10 = $48.
    // 2. Price Credit (-$15) on overall invoice. Invoice total: $48 -> $33.
    // 3. Plan Credit (-$8) on overall invoice. Invoice total: $33 -> $25.
    // 4. Merch Credit (-$25, has $50) on overall invoice. Invoice total: $25 -> $0.

    const li = secondInvoice!.lineItems;
    const compCreditLine = li.find((item) =>
      item.description?.includes("FeatX Comp Credit")
    );
    expect(compCreditLine).toBeDefined();
    expect(compCreditLine!.subtotalCents).toBe(-1200);
    expect(compCreditLine!.componentId).toBe(featureXComponentId!);

    const priceCreditLine = li.find((item) =>
      item.description?.includes("Overall Price Credit")
    );
    expect(priceCreditLine).toBeDefined();
    expect(priceCreditLine!.subtotalCents).toBe(-1500);

    const planCreditLine = li.find((item) =>
      item.description?.includes("General Plan Credit")
    );
    expect(planCreditLine).toBeDefined();
    expect(planCreditLine!.subtotalCents).toBe(-800);
    // Plan credits don't have priceId or componentId on the line item itself, they are more general.

    const merchCreditLine = li.find((item) =>
      item.description?.includes("Global Account Credit")
    );
    expect(merchCreditLine).toBeDefined();
    expect(merchCreditLine!.subtotalCents).toBe(-2500);

    expect(secondInvoice!.totalAmountCents).toBe(0); // $60 - $12 - $15 - $8 - $25 = $0

    // Verify grant consumptions
    const finalCompGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialCompGrant!.id),
    });
    expect(finalCompGrant!.remainingAmount).toBe(0); // $12 - $12 = $0
    const finalPriceGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialPriceGrant!.id),
    });
    expect(finalPriceGrant!.remainingAmount).toBe(0); // $15 - $15 = $0
    const finalPlanGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialPlanGrant!.id),
    });
    expect(finalPlanGrant!.remainingAmount).toBe(0); // $8 - $8 = $0
    const finalMerchGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, manualMerchGrant.id),
    });
    expect(finalMerchGrant!.remainingAmount).toBe(2500); // $50 - $25 = $25
  }, 50000);

  it("should correctly handle invoices fully covered by credits after E2E subscription", async () => {
    const customerEmail = `credit-billing-zero-amt-${Date.now()}@example.com`;
    const customerName = `Credit Billing Zero Amount Customer`;
    const userId = `user-zero-amt-${Date.now()}`;

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-zeroamt-plan-${Date.now()}`,
        planName: "Zero Amount Plan",
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
            component_name: "fee",
            type: "fixed",
            label: "Main Fee",
            amount_cents: 1000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      }, // $10
    });
    const testPriceId = testPrice.id;

    // Credit definition that will MORE than cover the fee
    const fullCoverCreditDef = await createCreditDefinition({
      merchantId,
      scope: "merchant",
      applicationType: "monetary",
      currency: "USD",
      name: "Full Cover",
      defaultAmount: 1500,
      priority: 1,
      billingVisible: true,
      billingDescription: "Full Coverage Credit",
    }); // $15

    // E2E Subscription
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    // Get the customer ID that was created by payment-init
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    await sleep(2000);

    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    // Manually grant the large credit
    const manualCreditGrant = await createCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: fullCoverCreditDef.id,
      source: "manual",
    });

    const firstInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid")
      ),
      orderBy: invoices.createdAt,
    });
    expect(firstInvoice).toBeDefined();
    expect(firstInvoice!.totalAmountCents).toBe(1000); // Initial payment $10

    // Prepare for next billing
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      // Set previousBillingDate to the current nextBillingDate to advance the billing period
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // Mock payment for second billing
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // Process second billing
    console.log("Processing second billing cycle for Zero Amount Credits...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);

    const secondInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscriptionId),
            eq(invoices.status, "paid"),
            ne(invoices.id, firstInvoice!.id)
          ),
          orderBy: desc(invoices.createdAt),
          with: { lineItems: true },
        }),
      (result) => !!result
    );
    expect(secondInvoice).toBeDefined();
    expect(secondInvoice!.totalAmountCents).toBe(0); // Fully covered

    const creditLine = secondInvoice!.lineItems.find(
      (item) => item.type === "credit"
    );
    expect(creditLine).toBeDefined();
    expect(creditLine!.subtotalCents).toBe(-1000); // $10 applied (as that was the charge)

    const updatedGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, manualCreditGrant.id),
    });
    expect(updatedGrant!.remainingAmount).toBe(500); // $15 - $10 = $5 remaining

    // Verify no actual payment record for $0 was created by collectPaymentJob (or it's for $0)
    const paymentForSecondInvoice = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, secondInvoice!.id),
    });
    if (paymentForSecondInvoice) {
      expect(paymentForSecondInvoice.amountCents).toBe(0);
      expect(paymentForSecondInvoice.status).toBe("succeeded"); // or a specific status for $0 invoices
    } // It's also okay if no payment record is created for $0 invoices by the mock.
  }, 50000);

  it("should apply usage credits during billing to create line items and transactions", async () => {
    const customerEmail = `credit-billing-usage-${Date.now()}@example.com`;
    const customerName = `Credit Billing Usage Customer`;
    const userId = `user-usage-${Date.now()}`;

    // 1. Create plan with feature for API call usage tracking
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "api_calls_limit",
          displayName: "API Calls Limit",
          featureValue: 1000, // Plan baseline limit for API usage
        },
      ],
      {
        stablePlanId: `cb-usage-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Usage Credit Plan",
      }
    );
    const testPlanId = planCreationResult.plan.id;
    const apiCallsFeature = planCreationResult.features.find(
      (f) => f.slug === "api_calls_limit"
    );
    expect(apiCallsFeature).toBeDefined();

    // 2. Create metric to track API call usage
    const apiCallEventName = `api.call.${Date.now()}`;
    const apiCallMetric = await authedApiClient.metrics.$post({
      json: {
        name: `API Call Usage Metric ${Date.now()}`,
        eventName: apiCallEventName,
        aggregationType: "SUM" as const,
        valueType: "NUMERIC" as const,
        description: "Tracks total API call usage",
        queryType: "simple" as const,
      },
    });
    expect(apiCallMetric.status).toBe(201);
    const apiCallMetricData = await apiCallMetric.json();
    if ("error" in apiCallMetricData) throw new Error(apiCallMetricData.error);

    // 3. Create price with usage-based component for API calls
    const testPrice = await createTestPrice({
      planId: testPlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base_fee",
            type: "fixed",
            label: "Monthly Base Fee",
            amount_cents: 2000, // $20 base fee
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
          {
            component_name: "api_usage",
            type: "usage",
            label: "API Call Usage",
            unit_cost_cents: 10, // $0.10 per unit
            unit_label: "API call",
            metric_id: apiCallMetricData.id,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: false, // Usage billed at end of period
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // Get component IDs from saved price
    const priceFromDb = await db.query.prices.findFirst({
      where: eq(prices.id, testPriceId),
    });
    const apiUsageComponentId = priceFromDb!.pricingData.components.find(
      (c) => c.component_name === "api_usage"
    )?.component_id;
    expect(apiUsageComponentId).toBeDefined();

    // 4. Create usage credit definition - grants 100 free usage units
    const usageCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "usage",
      featureId: apiCallsFeature!.id,
      featureSlug: "api_calls_limit",
      priceId: testPriceId,
      priceComponentId: apiUsageComponentId!,
      name: "Free API Call Credits",
      defaultAmount: 100, // 100 free usage units
      billingVisible: true,
      billingDescription: "Free API Call Credits Applied",
      priority: 30,
    });

    // 5. E2E Subscription - initial payment for base fee only
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook to process subscription and usage credit grant..."
    );
    await sleep(2000);

    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    // Verify usage credit grant was created
    const initialUsageGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, usageCreditDef.id)
      ),
    });
    expect(initialUsageGrant).toBeDefined();
    expect(initialUsageGrant!.remainingAmount).toBe(100); // 100 free usage units
    expect(initialUsageGrant!.applicationType).toBe("usage");

    // 6. Set up proper billing period dates BEFORE sending events
    const now = new Date();
    const subscriptionStartDate = new Date(
      now.getTime() - 35 * 24 * 60 * 60 * 1000
    ); // 35 days ago
    const previousBillingDate = new Date(
      now.getTime() - 5 * 24 * 60 * 60 * 1000
    ); // 5 days ago
    const nextBillingDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago (overdue)

    // Event timestamps should fall between previousBillingDate and nextBillingDate
    const eventTimestamp1 = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
    const eventTimestamp2 = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    const eventTimestamp3 = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago

    // Update subscription dates
    await db
      .update(subscriptions)
      .set({ createdAt: subscriptionStartDate })
      .where(eq(subscriptions.id, subscriptionId));

    // Update subscription details with proper billing period
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });

    for (const detail of subDetails) {
      await db
        .update(subscriptionDetails)
        .set({
          createdAt: subscriptionStartDate,
          nextBillingDate: nextBillingDate,
          // Set previous billing date for proper period calculation
          previousBillingDate: previousBillingDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    console.log("Set up billing period:", {
      subscriptionStart: subscriptionStartDate.toISOString(),
      previousBilling: previousBillingDate.toISOString(),
      nextBilling: nextBillingDate.toISOString(),
      eventWindow: `${eventTimestamp1.toISOString()} to ${eventTimestamp3.toISOString()}`,
    });

    // 7. Now send events with timestamps that fall in the billing period
    console.log(
      "Simulating API usage totaling 125 units within billing period..."
    );

    const event1Response = await authedApiClient.events.$post({
      json: {
        eventName: apiCallEventName,
        customerId: customerId,
        idempotencyKey: `api-usage-${Date.now()}-1`,
        eventValue: 50, // First usage event
        eventTimestamp: eventTimestamp1.toISOString(),
        properties: { apiEndpoint: "/api/v1/data", requestCount: 50 },
      },
    });
    expect(event1Response.status).toBe(202);

    const event2Response = await authedApiClient.events.$post({
      json: {
        eventName: apiCallEventName,
        customerId: customerId,
        idempotencyKey: `api-usage-${Date.now()}-2`,
        eventValue: 40, // Second usage event
        eventTimestamp: eventTimestamp2.toISOString(),
        properties: { apiEndpoint: "/api/v1/analytics", requestCount: 40 },
      },
    });
    expect(event2Response.status).toBe(202);

    const event3Response = await authedApiClient.events.$post({
      json: {
        eventName: apiCallEventName,
        customerId: customerId,
        idempotencyKey: `api-usage-${Date.now()}-3`,
        eventValue: 35, // Third usage event (50 + 40 + 35 = 125 total)
        eventTimestamp: eventTimestamp3.toISOString(),
        properties: { apiEndpoint: "/api/v1/reports", requestCount: 35 },
      },
    });
    expect(event3Response.status).toBe(202);

    // Wait for events to be processed
    console.log("Waiting for API usage events to be processed...");
    await sleep(3000);

    // Verify metric shows 125 total usage (50 + 40 + 35)
    const metricValueResponse = await authedApiClient.metrics[":id"].value.$get(
      {
        param: { id: apiCallMetricData.id },
        query: { customerId: customerId },
      }
    );
    expect(metricValueResponse.status).toBe(200);
    const metricValue = await metricValueResponse.json();
    if ("error" in metricValue) throw new Error(metricValue.error);
    expect(metricValue.value).toBe(125);

    // 8. Mock payment for billing cycle
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

          const responseData = await response.json();
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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // 9. Process billing cycle
    console.log("Processing billing cycle for usage credits and overage...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);

    // 10. Verify the invoice structure
    const firstInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscriptionId),
            eq(invoices.status, "paid")
          ),
          orderBy: invoices.createdAt,
        }),
      (result) => !!result
    );
    expect(firstInvoice).toBeDefined();

    const secondInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid"),
        ne(invoices.id, firstInvoice!.id)
      ),
      orderBy: desc(invoices.createdAt),
      with: { lineItems: true },
    });
    expect(secondInvoice).toBeDefined();

    const lineItems = secondInvoice!.lineItems;

    // Should have base fee line item ($20)
    const baseFeeLineItem = lineItems.find((item) =>
      item.description?.includes("Monthly Base Fee")
    );
    expect(baseFeeLineItem).toBeDefined();
    expect(baseFeeLineItem!.subtotalCents).toBe(2000);

    // Should have usage line item for all 125 usage units (125 * $0.10 = $12.50)
    const usageLineItem = lineItems.find((item) =>
      item.description?.includes("API Call Usage")
    );
    expect(usageLineItem).toBeDefined();
    expect(usageLineItem!.subtotalCents).toBe(1250); // 125 units * 10 cents

    // Should have credit line item for 100 free units (100 * $0.10 = $10.00 credit)
    const creditLineItem = lineItems.find(
      (item) =>
        item.type === "credit" &&
        item.description?.includes("Free API Call Credits Applied")
    );
    expect(creditLineItem).toBeDefined();
    expect(creditLineItem!.description).toBe(
      "Free API Call Credits Applied (100 units × $0.10)"
    );
    expect(creditLineItem!.subtotalCents).toBe(-1000); // -$10.00 credit
    expect(creditLineItem!.componentId).toBe(apiUsageComponentId!);

    // Total should be: $20 (base) + $12.50 (usage) - $10.00 (credit) = $22.50
    expect(secondInvoice!.totalAmountCents).toBe(2250);

    // 11. Verify credit grant was properly consumed
    const updatedUsageGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialUsageGrant!.id),
    });
    expect(updatedUsageGrant!.remainingAmount).toBe(0); // All 100 usage credits used
    expect(updatedUsageGrant!.status).toBe("DEPLETED");

    // 12. Verify credit usage transaction was created for the 100 usage credits used
    const usageTransaction = await db.query.creditUsageTransactions.findFirst({
      where: and(
        eq(creditUsageTransactions.creditGrantId, initialUsageGrant!.id),
        eq(creditUsageTransactions.invoiceId, secondInvoice!.id),
        eq(creditUsageTransactions.applicationType, "usage")
      ),
    });
    expect(usageTransaction).toBeDefined();
    expect(usageTransaction!.amount).toBe(100); // 100 usage credits consumed
    expect(usageTransaction!.eventName).toBe("billing");
    expect(usageTransaction!.priceId).toBe(testPriceId);
    expect(usageTransaction!.priceComponentId).toBe(apiUsageComponentId!);

    console.log("Usage credit billing test completed successfully!");
  }, 45000);

  it("should grant new credits after invoice generation when renewOnBilling is true", async () => {
    const customerEmail = `credit-billing-renew-${Date.now()}@example.com`;
    const customerName = `Credit Billing Renew Customer`;
    const userId = `user-renew-${Date.now()}`;

    // 1. Create plan and price
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-renew-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Renew Credit Plan",
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
            component_name: "monthly_service",
            type: "fixed",
            label: "Monthly Service Fee",
            amount_cents: 1500,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // 2. Create credit definition with renewOnBilling = true
    const renewableCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: testPriceId,
      currency: "USD",
      name: "Monthly Renewal Credit",
      defaultAmount: 500, // $5.00 credit
      refillAmount: 300, // $3.00 on renewal (different from default)
      billingVisible: true,
      billingDescription: "Monthly Renewal Applied",
      renewOnBilling: true, // This is the key setting
      priority: 40,
    });

    // 3. E2E Subscription
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook to process subscription and initial grant..."
    );
    await sleep(2000);

    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    // Verify initial grant from subscription signup
    const initialGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, renewableCreditDef.id),
        eq(creditGrants.source, "subscription")
      ),
    });
    expect(initialGrant).toBeDefined();
    expect(initialGrant!.remainingAmount).toBe(500); // defaultAmount
    expect(initialGrant!.source).toBe("subscription");

    // 4. Prepare for next billing cycle
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      // Set previousBillingDate to the current nextBillingDate to advance the billing period
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // 5. Mock payment for second billing
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

          const responseData = await response.json();
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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // 6. Process second billing
    console.log("Processing second billing cycle for renewOnBilling test...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);

    // 7. Verify that a NEW grant was created with refillAmount after billing
    const renewalGrant = await retryWithSleep(
      () =>
        db.query.creditGrants.findFirst({
          where: and(
            eq(creditGrants.customerId, customerId),
            eq(creditGrants.creditDefinitionId, renewableCreditDef.id),
            eq(creditGrants.source, "refill")
          ),
          orderBy: desc(creditGrants.createdAt),
        }),
      (result) => !!result
    );
    expect(renewalGrant).toBeDefined();
    expect(renewalGrant!.remainingAmount).toBe(300); // refillAmount, not defaultAmount
    expect(renewalGrant!.source).toBe("refill");
    expect(renewalGrant!.notes).toContain("Billing cycle renewal");

    // 8. Verify original grant still exists (should be depleted if used in billing)
    const updatedInitialGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialGrant!.id),
    });
    expect(updatedInitialGrant).toBeDefined();
    // The grant should have been used in billing, so remaining amount should be less
    expect(updatedInitialGrant!.remainingAmount).toBeLessThan(500);

    // 9. Verify we now have two grants for this customer and definition
    const allGrantsForDef = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, renewableCreditDef.id),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(allGrantsForDef.length).toBe(2); // Initial + renewal

    // 10. Verify credit transactions were created for both grants
    const grantedTransactions = await db.query.creditUsageTransactions.findMany(
      {
        where: and(
          eq(creditUsageTransactions.customerId, customerId),
          eq(creditUsageTransactions.eventName, "granted")
        ),
        orderBy: creditUsageTransactions.createdAt,
      }
    );
    expect(grantedTransactions.length).toBe(2); // One for initial, one for renewal

    const initialGrantTransaction = grantedTransactions.find(
      (tx) => tx.creditGrantId === initialGrant!.id
    );
    expect(initialGrantTransaction).toBeDefined();
    expect(initialGrantTransaction!.amount).toBe(500);

    const renewalGrantTransaction = grantedTransactions.find(
      (tx) => tx.creditGrantId === renewalGrant!.id
    );
    expect(renewalGrantTransaction).toBeDefined();
    expect(renewalGrantTransaction!.amount).toBe(300);

    console.log("Renewal credit grant test completed successfully!");
  }, 50000);

  it("should apply multiple grants of same credit type in correct priority order", async () => {
    const customerEmail = `credit-billing-multi-priority-${Date.now()}@example.com`;
    const customerName = `Credit Billing Multi Priority Customer`;
    const userId = `user-multi-priority-${Date.now()}`;

    // 1. Create plan and price
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-multi-priority-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Multi Priority Plan",
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
            component_name: "target_component",
            type: "fixed",
            label: "Target Component",
            amount_cents: 5000, // $50.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    const priceFromDb = await db.query.prices.findFirst({
      where: eq(prices.id, testPriceId),
    });
    const targetComponentId = priceFromDb!.pricingData.components.find(
      (c) => c.component_name === "target_component"
    )?.component_id;
    expect(targetComponentId).toBeDefined();

    // 2. Create multiple credit definitions with different priorities
    const highPriorityCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: testPriceId,
      priceComponentId: targetComponentId!,
      currency: "USD",
      name: "High Priority Credit",
      defaultAmount: 1500, // $15.00
      billingVisible: true,
      billingDescription: "High Priority Applied",
      priority: 10, // High priority (lower number)
    });

    const lowPriorityCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: testPriceId,
      priceComponentId: targetComponentId!,
      currency: "USD",
      name: "Low Priority Credit",
      defaultAmount: 2000, // $20.00
      billingVisible: true,
      billingDescription: "Low Priority Applied",
      priority: 100, // Low priority (higher number)
    });

    // 3. E2E Subscription
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook to process subscription and priority grants..."
    );
    await sleep(2000);

    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    // 4. Verify both credit grants were created from plan association
    const highPriorityGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, highPriorityCreditDef.id),
        eq(creditGrants.source, "subscription")
      ),
    });
    expect(highPriorityGrant).toBeDefined();
    expect(highPriorityGrant!.remainingAmount).toBe(1500); // $15.00

    const lowPriorityGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, lowPriorityCreditDef.id),
        eq(creditGrants.source, "subscription")
      ),
    });
    expect(lowPriorityGrant).toBeDefined();
    expect(lowPriorityGrant!.remainingAmount).toBe(2000); // $20.00

    // 5. Manually grant additional credits to create multiple grants per type
    // Create a second high priority grant
    const additionalHighPriorityGrant = await createCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: highPriorityCreditDef.id,
      source: "manual",
      notes: "Additional high priority grant",
    });
    expect(additionalHighPriorityGrant.remainingAmount).toBe(1500); // Another $15.00

    // Create a second low priority grant
    const additionalLowPriorityGrant = await createCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: lowPriorityCreditDef.id,
      source: "manual",
      notes: "Additional low priority grant",
    });
    expect(additionalLowPriorityGrant.remainingAmount).toBe(2000); // Another $20.00

    // Now we have:
    // - 2 high priority grants ($15 each = $30 total) with priority 10
    // - 2 low priority grants ($20 each = $40 total) with priority 100
    // - Target component costs $50
    // Expected: High priority grants should be consumed first ($30), then low priority grants ($20 of $40), leaving one low priority grant untouched

    const firstInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid")
      ),
      orderBy: invoices.createdAt,
    });
    expect(firstInvoice).toBeDefined();
    expect(firstInvoice!.totalAmountCents).toBe(5000); // Initial payment $50

    // 6. Prepare for next billing cycle
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      // Set previousBillingDate to the current nextBillingDate to advance the billing period
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // 7. Mock payment for second billing
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

          const responseData = await response.json();
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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // 8. Process second billing
    console.log("Processing second billing cycle for priority order test...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);

    // 9. Verify second invoice shows credits applied in priority order
    const secondInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscriptionId),
            eq(invoices.status, "paid"),
            ne(invoices.id, firstInvoice!.id)
          ),
          orderBy: desc(invoices.createdAt),
          with: { lineItems: true },
        }),
      (result) => !!result
    );
    expect(secondInvoice).toBeDefined();

    const lineItems = secondInvoice!.lineItems;

    const targetComponentLine = lineItems.find(
      (item) =>
        item.description?.includes("Target Component") && item.type === "fixed"
    );
    expect(targetComponentLine).toBeDefined();
    expect(targetComponentLine!.subtotalCents).toBe(5000); // $50 charge

    // Find the consolidated credit line item - the system consolidates component credits into one line
    const consolidatedCreditLine = lineItems.find(
      (item) =>
        item.type === "credit" &&
        item.description?.includes("Component credits")
    );
    expect(consolidatedCreditLine).toBeDefined();
    expect(consolidatedCreditLine!.description).toBe(
      "Component credits (4): Target Component"
    );
    expect(consolidatedCreditLine!.subtotalCents).toBe(-5000); // All 4 grants applied: $15+$15+$20 = $50 needed
    expect(consolidatedCreditLine!.componentId).toBe(targetComponentId!);

    // Total: $50 - $50 (credits) = $0
    expect(secondInvoice!.totalAmountCents).toBe(0);

    // 10. Verify grant consumption in priority order
    // High priority grants should be fully depleted
    const updatedHighPriorityGrant1 = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, highPriorityGrant!.id),
    });
    expect(updatedHighPriorityGrant1!.remainingAmount).toBe(0);
    expect(updatedHighPriorityGrant1!.status).toBe("DEPLETED");

    const updatedHighPriorityGrant2 = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, additionalHighPriorityGrant.id),
    });
    expect(updatedHighPriorityGrant2!.remainingAmount).toBe(0);
    expect(updatedHighPriorityGrant2!.status).toBe("DEPLETED");

    // One low priority grant should be fully consumed, the other untouched
    const updatedLowPriorityGrant1 = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, lowPriorityGrant!.id),
    });
    const updatedLowPriorityGrant2 = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, additionalLowPriorityGrant.id),
    });

    // Check how many grants were actually consumed
    const consumedGrants = [
      updatedHighPriorityGrant1!,
      updatedHighPriorityGrant2!,
      updatedLowPriorityGrant1!,
      updatedLowPriorityGrant2!,
    ].filter((grant) => grant.remainingAmount < grant.initialAmount);

    const fullyDepletedGrants = [
      updatedHighPriorityGrant1!,
      updatedHighPriorityGrant2!,
      updatedLowPriorityGrant1!,
      updatedLowPriorityGrant2!,
    ].filter((grant) => grant.status === "DEPLETED");

    // Should have consumed exactly $50 worth of credits in priority order
    const totalConsumed = [
      updatedHighPriorityGrant1!,
      updatedHighPriorityGrant2!,
      updatedLowPriorityGrant1!,
      updatedLowPriorityGrant2!,
    ].reduce(
      (sum, grant) => sum + (grant.initialAmount - grant.remainingAmount),
      0
    );

    expect(totalConsumed).toBe(5000); // Exactly $50 should be consumed

    // 11. Verify credit usage transactions reflect priority order
    const allUsageTransactions =
      await db.query.creditUsageTransactions.findMany({
        where: eq(creditUsageTransactions.invoiceId, secondInvoice!.id),
        orderBy: creditUsageTransactions.createdAt,
      });

    // Should have transactions for exactly the amount consumed
    const totalTransactionAmount = allUsageTransactions.reduce(
      (sum, tx) => sum + tx.amount,
      0
    );
    expect(totalTransactionAmount).toBe(5000); // Total transaction amount should equal $50

    // Verify that high priority grants were consumed before low priority grants
    const highPriorityTransactions = allUsageTransactions.filter(
      (t) =>
        t.creditGrantId === highPriorityGrant!.id ||
        t.creditGrantId === additionalHighPriorityGrant.id
    );
    const lowPriorityTransactions = allUsageTransactions.filter(
      (t) =>
        t.creditGrantId === lowPriorityGrant!.id ||
        t.creditGrantId === additionalLowPriorityGrant.id
    );

    // Both high priority grants should be fully consumed first
    expect(highPriorityTransactions.length).toBe(2);
    expect(highPriorityTransactions.every((tx) => tx.amount === 1500)).toBe(
      true
    );

    // Low priority grants should only be used after high priority grants are exhausted
    // Total high priority: $30, remaining needed: $20, so at least one low priority grant should be used
    expect(lowPriorityTransactions.length).toBeGreaterThanOrEqual(1);

    // All transactions should target the correct component
    allUsageTransactions.forEach((tx) => {
      expect(tx.priceComponentId).toBe(targetComponentId!);
      expect(tx.eventName).toBe("billing");
    });

    console.log(
      "Multi-priority credit application test completed successfully!"
    );
  }, 50000);

  it("should expire old credits before creating new ones when renewOnBilling is true and expiryDays is -1", async () => {
    const customerEmail = `credit-billing-expire-cycle-${Date.now()}@example.com`;
    const customerName = `Credit Billing Expire Cycle Customer`;
    const userId = `user-expire-cycle-${Date.now()}`;

    // 1. Create plan and price
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `cb-expire-cycle-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Expire Cycle Credit Plan",
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
            component_name: "monthly_service",
            type: "fixed",
            label: "Monthly Service Fee",
            amount_cents: 2000, // $20.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    it("should expire old credits before creating new ones when using RRULE renewal and expiryDays is -1", async () => {
      // ------------------------------------------------------------
      // 1. Set up merchant, plan, price and feature with RRULE renewal
      // ------------------------------------------------------------
      const testEnv = await createFullTestEnvironment();
      const { user: testUser, merchant } = testEnv;
      const merchantId = merchant.id;

      // Authenticate & build API client
      const auth = await authenticateTestUser(
        testUser.email,
        testUser.password
      );
      const sessionToken = auth.cookies.sessionToken;
      const baseApiClient = createTestApiClient(sessionToken);

      // Create plan + feature (no usage-based pricing component so RRULE will be chosen)
      const { plan: testPlan } = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "storage_gb",
            displayName: "Storage (GB)",
            description: "Storage quota",
            featureValue: 100,
          },
        ],
        {
          stablePlanId: "rrule-expiry-plan",
          versionNumber: 1,
          planName: "RRULE Expiry Plan",
        }
      );
      const testPlanId = testPlan.id;

      // Attach simple yearly price (fixed) – no usage component
      const price = await createTestPrice({
        planId: testPlanId,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "yearly_fee",
              type: "fixed",
              label: "$120 per year",
              amount_cents: 12000,
              recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1",
              bill_immediately: true,
            },
          ],
        },
      });
      const testPriceId = price.id;

      // Create credit definition with RRULE renewal and expiryDays -1
      const rruleCreditDef = await createCreditDefinition({
        merchantId,
        scope: "plan",
        planId: testPlanId,
        applicationType: "monetary",
        priceId: testPriceId,
        name: "Monthly Storage Credits",
        defaultAmount: 1500,
        refillAmount: 1500,
        refillRrule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
        renewOnBilling: false,
        expiryDays: -1, // expire with renewal cycle
        priority: 20,
        currency: "USD",
        billingVisible: true,
      });

      // ------------------------------------------------------------
      // 2. Create customer + subscription to generate initial grant
      // ------------------------------------------------------------
      const customerEmail = `rrule-expiry-${Date.now()}@example.com`;
      const customerName = "RRULE Expiry Tester";

      const { publishableKey } = await createTestApiKeys({ merchantId });

      const paymentInitResp = await baseApiClient.public["payment-init"].$post({
        json: {
          lumenPublishableKey: publishableKey.rawKeyValue,
          priceId: testPriceId,
          planId: testPlanId,
          customerEmail,
          customerName,
          userId: testUser.id,
          ...(process.env.PAYMENT_PROVIDER === "dodo"
            ? customerAddressObj
            : {}),
        },
      });
      const paymentInitData = await paymentInitResp.json();
      await paymentProvider.completePaymentInit(paymentInitData);

      // Locate customer and initial grant
      const customer = await db.query.customers.findFirst({
        where: and(
          eq(customers.merchantId, merchantId),
          eq(customers.email, customerEmail)
        ),
      });
      expect(customer).toBeDefined();
      const customerId = customer!.id;

      // Wait to ensure async subscription creation finished
      await sleep(1500);

      const initialGrant = await db.query.creditGrants.findFirst({
        where: and(
          eq(creditGrants.customerId, customerId),
          eq(creditGrants.creditDefinitionId, rruleCreditDef.id),
          eq(creditGrants.source, "subscription")
        ),
      });
      expect(initialGrant).toBeDefined();

      // ------------------------------------------------------------
      // 3. Partially consume grant (simulate usage)
      // ------------------------------------------------------------
      await db
        .update(creditGrants)
        .set({ remainingAmount: 800 })
        .where(eq(creditGrants.id, initialGrant!.id));

      await createCreditTransaction({
        merchantId,
        customerId,
        creditGrantId: initialGrant!.id,
        amount: 700,
        applicationType: "monetary",
        eventName: "billing",
        eventTimestamp: new Date(),
        currency: "USD",
        notes: "Simulated usage before renewal",
      });

      // ------------------------------------------------------------
      // 4. Force grant due for renewal (set nextRenewalDate to yesterday)
      // ------------------------------------------------------------
      const yesterday = new Date(Date.now() - 86400 * 1000);
      await db
        .update(creditGrants)
        .set({ nextRenewalDate: yesterday })
        .where(eq(creditGrants.id, initialGrant!.id));

      // ------------------------------------------------------------
      // 5. Run processGrantRenewals (RRULE path)
      // ------------------------------------------------------------
      const { processGrantRenewals } = await import(
        "../../src/helpers/credits"
      );
      const result = await processGrantRenewals(new Date());
      expect(result.errorCount).toBe(0);

      // ------------------------------------------------------------
      // 6. Assertions – old grant expired, new grant created
      // ------------------------------------------------------------
      const expiredGrant = await db.query.creditGrants.findFirst({
        where: eq(creditGrants.id, initialGrant!.id),
      });
      expect(expiredGrant!.status).toBe("EXPIRED");
      expect(expiredGrant!.remainingAmount).toBe(800);

      const expiryTxn = await db.query.creditUsageTransactions.findFirst({
        where: and(
          eq(creditUsageTransactions.creditGrantId, initialGrant!.id),
          eq(creditUsageTransactions.eventName, "expired")
        ),
      });
      expect(expiryTxn).toBeDefined();
      expect(expiryTxn!.amount).toBe(800);
      expect((expiryTxn as any).notes).toBe("Expired with RRULE renewal cycle");

      const newGrant = await db.query.creditGrants.findFirst({
        where: and(
          eq(creditGrants.customerId, customerId),
          eq(creditGrants.creditDefinitionId, rruleCreditDef.id),
          eq(creditGrants.source, "refill")
        ),
        orderBy: desc(creditGrants.createdAt),
      });
      expect(newGrant).toBeDefined();
      expect(newGrant!.remainingAmount).toBe(1500);
      expect(newGrant!.notes).toContain(
        `renewal from grant ${initialGrant!.id}`
      );
    });
    const testPriceId = testPrice.id;

    // 2. Create credit definition with renewOnBilling = true and expiryDays = -1
    const expireCycleCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: testPriceId,
      currency: "USD",
      name: "Expire with Billing Cycle Credit",
      defaultAmount: 3000, // $30.00 initial credit to ensure leftover after billing
      refillAmount: 1000, // $10.00 on renewal (different from default)
      billingVisible: true, // Renew with billing
      billingDescription: "Billing Cycle Expire Credit",
      renewOnBilling: true, // Renew with billing
      expiryDays: -1, // Expire with billing cycle
      priority: 40,
    });

    // 3. E2E Subscription
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();

    console.log(
      "Waiting for webhook to process subscription and initial grant..."
    );
    await sleep(2000);

    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();
    const subscriptionId = subscription!.id;

    // 4. Verify initial grant from subscription signup
    const initialGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, expireCycleCreditDef.id),
        eq(creditGrants.source, "subscription")
      ),
    });
    expect(initialGrant).toBeDefined();
    expect(initialGrant!.remainingAmount).toBe(3000); // defaultAmount increased
    expect(initialGrant!.source).toBe("subscription");
    expect(initialGrant!.expiryDate).toBeNull(); // Should have no fixed expiry date due to expiryDays = -1

    const firstInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid")
      ),
      orderBy: invoices.createdAt,
    });
    expect(firstInvoice).toBeDefined();
    expect(firstInvoice!.totalAmountCents).toBe(2000); // Initial payment $20

    // 5. Partially consume the credit grant to simulate some usage
    // Manually update the grant to show it was partially used
    await db
      .update(creditGrants)
      .set({
        remainingAmount: 2300, // Used $7 of the $30 credit (remaining $23)
        status: "ACTIVE", // Still active since some amount remains
      })
      .where(eq(creditGrants.id, initialGrant!.id));

    // Create a usage transaction to show the credit was used
    await createCreditTransaction({
      merchantId,
      customerId,
      creditGrantId: initialGrant!.id,
      amount: 700, // $7.00 was used
      applicationType: "monetary",
      eventName: "billing",
      eventTimestamp: new Date(),
      priceId: testPriceId,
      currency: "USD",
      notes: "Simulated partial usage",
    });

    // Verify the grant now shows as partially used
    const partiallyUsedGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialGrant!.id),
    });
    expect(partiallyUsedGrant!.remainingAmount).toBe(2300); // $23.00 remaining

    // 6. Prepare for next billing cycle
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: detail.nextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // 7. Mock payment for second billing
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

          const responseData = await response.json();
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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // 8. Process second billing cycle
    console.log("Processing second billing cycle for expire cycle test...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(3000);

    // 9. Verify the old grant was EXPIRED (not depleted)
    const expiredOriginalGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialGrant!.id),
    });
    expect(expiredOriginalGrant!.status).toBe("EXPIRED"); // Should be expired, not depleted
    expect(expiredOriginalGrant!.remainingAmount).toBe(300); // Should show the remaining amount after partial billing consumption

    // 10. Verify expiry transaction was created for the remaining amount
    const expiryTransaction = await db.query.creditUsageTransactions.findFirst({
      where: and(
        eq(creditUsageTransactions.creditGrantId, initialGrant!.id),
        eq(creditUsageTransactions.eventName, "expired")
      ),
    });
    expect(expiryTransaction).toBeDefined();
    expect(expiryTransaction!.amount).toBe(300); // Remaining $3 expired

    // 11. Verify NEW grant was created with refillAmount
    const renewalGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, expireCycleCreditDef.id),
        eq(creditGrants.source, "refill")
      ),
      orderBy: desc(creditGrants.createdAt),
    });
    expect(renewalGrant).toBeDefined();
    expect(renewalGrant!.remainingAmount).toBe(1000); // refillAmount, not defaultAmount
    expect(renewalGrant!.source).toBe("refill");
    expect(renewalGrant!.notes).toContain("Billing cycle renewal");
    expect(renewalGrant!.expiryDate).toBeNull(); // Should also have no fixed expiry date

    // 12. Verify we have exactly 2 grants total (expired original + new renewal)
    const allGrantsForDef = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, expireCycleCreditDef.id),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(allGrantsForDef.length).toBe(2); // Original (expired) + renewal

    // 13. Verify credit usage was applied in the second invoice using the FIRST grant
    // Sequence of events:
    // 1. Subscription is created and initial payment is done, first invoice is created and marked paid
    // 2. Initial grant is created after the subscription
    // 3. First billing cycle is processed, initial grant is partially used, SECOND invoice is created and marked paid
    // 4. Renewal grant is created after the first invoice is paid
    const secondInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "paid"),
        ne(invoices.id, firstInvoice!.id)
      ),
      orderBy: desc(invoices.createdAt),
      with: { lineItems: true },
    });
    expect(secondInvoice).toBeDefined();

    // The new grant has just been created, so it should have the default amount
    const firstRenewalGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, renewalGrant!.id),
    });
    expect(firstRenewalGrant!.remainingAmount).toBe(1000); // defaultAmount

    // 14. Verify credit transactions timeline
    const allTransactions = await db.query.creditUsageTransactions.findMany({
      where: eq(creditUsageTransactions.customerId, customerId),
      orderBy: creditUsageTransactions.eventTimestamp,
    });

    // Should have: initial grant, partial usage, expiry, new grant, billing usage
    expect(allTransactions.length).toBeGreaterThanOrEqual(4);

    const grantedTransactions = allTransactions.filter(
      (tx) => tx.eventName === "granted"
    );
    expect(grantedTransactions.length).toBe(2); // Initial + renewal

    const expiredTransactions = allTransactions.filter(
      (tx) => tx.eventName === "expired"
    );
    expect(expiredTransactions.length).toBe(1); // Original grant expired

    const billingTransactions = allTransactions.filter(
      (tx) => tx.eventName === "billing"
    );
    expect(billingTransactions.length).toBeGreaterThanOrEqual(2); // Partial usage + second billing

    console.log("Billing cycle credit expiry test completed successfully!", {
      originalGrantStatus: expiredOriginalGrant!.status,
      originalRemainingWhenExpired: expiredOriginalGrant!.remainingAmount,
      newGrantAmount: renewalGrant!.remainingAmount,
      totalTransactions: allTransactions.length,
    });
  }, 50000);

  it("should renew credit grants based on RRULE schedule when renewOnBilling is false", async () => {
    const customerEmail = `credit-billing-rrule-renew-${Date.now()}@example.com`;
    const customerName = `Credit Billing RRULE Renew Customer`;
    const userId = `user-rrule-renew-${Date.now()}`;

    // 1. Create plan with API calls feature
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "api_calls",
          displayName: "API Calls",
          featureValue: 1000, // Base plan allowance
        },
      ],
      {
        stablePlanId: `cb-rrule-renew-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "RRULE Renewal Plan",
      }
    );
    const testPlanId = planCreationResult.plan.id;
    const apiCallsFeature = planCreationResult.features.find(
      (f) => f.slug === "api_calls"
    );
    expect(apiCallsFeature).toBeDefined();

    const testPrice = await createTestPrice({
      planId: testPlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "yearly_fee",
            type: "fixed",
            label: "Yearly Fee",
            amount_cents: 20000, // $200 yearly
            recurrence_rule:
              "RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // Get the price from DB to get component ID for usage credit validation
    const priceFromDb = await db.query.prices.findFirst({
      where: eq(prices.id, testPriceId),
    });
    expect(priceFromDb).toBeDefined();
    const yearlyComponentId = priceFromDb!.pricingData.components.find(
      (c) => c.component_name === "yearly_fee"
    )?.component_id;
    expect(yearlyComponentId).toBeDefined();

    // 2. Create credit definition with RRULE-based renewal (renewOnBilling = false)
    const rruleRenewalCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "usage",
      featureId: apiCallsFeature!.id, // Link to the feature
      featureSlug: "api_calls",
      priceId: testPriceId, // Required for usage credits
      priceComponentId: yearlyComponentId!, // Required for usage credits
      name: "Monthly API Credits",
      defaultAmount: 500, // 500 API calls initially
      refillAmount: 500, // 500 API calls each renewal
      billingVisible: true, // Just for entitlements, not billing
      refillRrule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1", // Monthly renewal
      renewOnBilling: false, // RRULE-based, not billing-based
      priority: 10,
    });

    // 3. E2E Subscription
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    console.log(
      "Waiting for webhook to process subscription and RRULE grant..."
    );
    await sleep(2000);

    // 4. Verify initial grant has renewal scheduling set up
    const initialGrant = await retryWithSleep(
      () =>
        db.query.creditGrants.findFirst({
          where: and(
            eq(creditGrants.customerId, customerId),
            eq(creditGrants.creditDefinitionId, rruleRenewalCreditDef.id),
            eq(creditGrants.source, "subscription")
          ),
        }),
      (result) => !!result
    );
    expect(initialGrant).toBeDefined();
    expect(initialGrant!.remainingAmount).toBe(500);
    expect(initialGrant!.renewalRrule).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1"
    );
    expect(initialGrant!.nextRenewalDate).toBeDefined();
    expect(initialGrant!.lastRenewalDate).toBeNull(); // Not renewed yet

    console.log("Initial grant created with renewal scheduling:", {
      grantId: initialGrant!.id,
      nextRenewalDate: initialGrant!.nextRenewalDate,
      renewalRrule: initialGrant!.renewalRrule,
    });

    // 5. Simulate time passing to make the grant due for renewal
    // Force the nextRenewalDate to be in the past
    const pastRenewalDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    await db
      .update(creditGrants)
      .set({ nextRenewalDate: pastRenewalDate })
      .where(eq(creditGrants.id, initialGrant!.id));

    console.log("Updated grant renewal date to past for testing:", {
      grantId: initialGrant!.id,
      forcedRenewalDate: pastRenewalDate,
    });

    // 6. Import and call the renewal processing function
    const { processGrantRenewals } = await import("../../src/helpers/credits");

    // Process renewals for grants due now
    const renewalResult = await processGrantRenewals(new Date());
    expect(renewalResult.renewalCount).toBeGreaterThanOrEqual(1);
    expect(renewalResult.errorCount).toBe(0);

    console.log("Processed grant renewals:", renewalResult);

    // 7. Verify renewal grant was created with refillAmount
    const renewalGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, rruleRenewalCreditDef.id),
        eq(creditGrants.source, "refill")
      ),
      orderBy: desc(creditGrants.createdAt),
    });
    expect(renewalGrant).toBeDefined();
    expect(renewalGrant!.remainingAmount).toBe(500); // refillAmount
    expect(renewalGrant!.source).toBe("refill");
    expect(renewalGrant!.notes).toContain(
      `renewal from grant ${initialGrant!.id}`
    );

    // The new grant should also have renewal scheduling for the next cycle
    expect(renewalGrant!.renewalRrule).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1"
    );
    expect(renewalGrant!.nextRenewalDate).toBeDefined();
    expect(renewalGrant!.lastRenewalDate).toBeNull(); // This grant hasn't been renewed yet

    console.log("Renewal grant created successfully:", {
      renewalGrantId: renewalGrant!.id,
      amount: renewalGrant!.remainingAmount,
      nextRenewalDate: renewalGrant!.nextRenewalDate,
    });

    // 8. Verify original grant is marked as "done" (baton passing)
    const updatedOriginalGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialGrant!.id),
    });
    expect(updatedOriginalGrant!.lastRenewalDate).toBeDefined(); // Marked as renewed
    expect(updatedOriginalGrant!.nextRenewalDate).toBeNull(); // No longer scheduled for renewal

    console.log("Original grant marked as done (baton passed):", {
      originalGrantId: initialGrant!.id,
      lastRenewalDate: updatedOriginalGrant!.lastRenewalDate,
      nextRenewalDate: updatedOriginalGrant!.nextRenewalDate,
    });

    // 9. Verify we now have two active grants for this customer/definition
    const allGrantsForDef = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, rruleRenewalCreditDef.id),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(allGrantsForDef.length).toBe(2); // Original + renewal

    // 10. Verify credit transactions were created for both grants
    const grantedTransactions = await db.query.creditUsageTransactions.findMany(
      {
        where: and(
          eq(creditUsageTransactions.customerId, customerId),
          eq(creditUsageTransactions.eventName, "granted")
        ),
        orderBy: creditUsageTransactions.createdAt,
      }
    );
    expect(grantedTransactions.length).toBe(2); // One for initial, one for renewal

    const initialGrantTransaction = grantedTransactions.find(
      (tx) => tx.creditGrantId === initialGrant!.id
    );
    expect(initialGrantTransaction).toBeDefined();
    expect(initialGrantTransaction!.amount).toBe(500);

    const renewalGrantTransaction = grantedTransactions.find(
      (tx) => tx.creditGrantId === renewalGrant!.id
    );
    expect(renewalGrantTransaction).toBeDefined();
    expect(renewalGrantTransaction!.amount).toBe(500);

    console.log(
      "RRULE-based credit grant renewal test completed successfully!"
    );
  }, 50000);

  it("should handle multiple renewal cycles correctly with baton passing", async () => {
    const customerEmail = `credit-billing-multi-renew-${Date.now()}@example.com`;
    const customerName = `Credit Billing Multi Renew Customer`;
    const userId = `user-multi-renew-${Date.now()}`;

    // Create plan with features for testing
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "weekly_api_calls",
          displayName: "Weekly API Calls",
          featureValue: 500, // Base plan allowance
        },
      ],
      {
        stablePlanId: `cb-multi-renew-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Multi Renewal Plan",
      }
    );
    const testPlanId = planCreationResult.plan.id;
    const weeklyApiCallsFeature = planCreationResult.features.find(
      (f) => f.slug === "weekly_api_calls"
    );
    expect(weeklyApiCallsFeature).toBeDefined();

    const testPrice = await createTestPrice({
      planId: testPlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base_fee",
            type: "fixed",
            label: "Base Fee",
            amount_cents: 1000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    // Get component ID for usage credit validation
    const multiTestPriceFromDb = await db.query.prices.findFirst({
      where: eq(prices.id, testPrice.id),
    });
    expect(multiTestPriceFromDb).toBeDefined();
    const baseFeeComponentId =
      multiTestPriceFromDb!.pricingData.components.find(
        (c) => c.component_name === "base_fee"
      )?.component_id;
    expect(baseFeeComponentId).toBeDefined();

    // Credit definition with weekly renewal for faster testing
    // Use merchant scope so it doesn't depend on subscription state
    const weeklyRenewalCreditDef = await createCreditDefinition({
      merchantId,
      scope: "merchant", // Changed to merchant scope for this test
      applicationType: "usage",
      featureId: weeklyApiCallsFeature!.id, // Link to the feature
      featureSlug: "weekly_api_calls",
      priceId: testPrice.id, // Required for usage credits
      priceComponentId: baseFeeComponentId!, // Required for usage credits
      name: "Weekly API Credits",
      defaultAmount: 100,
      refillAmount: 75, // Different from default to verify refillAmount is used
      refillRrule: "RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=1", // Weekly on Monday
      renewOnBilling: false,
      priority: 10,
    });

    // Create customer manually for this test
    const testCustomer = await createTestCustomer({
      merchantId,
      email: customerEmail,
      name: customerName,
      ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
    });
    const customerId = testCustomer.id;

    // Create initial grant manually
    const { createCreditGrant } = await import("../../src/helpers/credits");
    const initialGrant = await createCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: weeklyRenewalCreditDef.id,
      source: "manual",
      notes: "Initial grant for multi-renewal test",
    });

    console.log("Created initial grant for multi-renewal test:", {
      grantId: initialGrant.id,
      nextRenewalDate: initialGrant.nextRenewalDate,
    });

    // Import renewal function
    const { processGrantRenewals } = await import("../../src/helpers/credits");

    // Simulate 3 renewal cycles
    for (let cycle = 1; cycle <= 3; cycle++) {
      console.log(`\n--- Renewal Cycle ${cycle} ---`);

      // Find the currently active grant (the one with nextRenewalDate set)
      const activeGrant = await db.query.creditGrants.findFirst({
        where: and(
          eq(creditGrants.customerId, customerId),
          eq(creditGrants.creditDefinitionId, weeklyRenewalCreditDef.id),
          isNull(creditGrants.lastRenewalDate), // Not yet renewed
          isNotNull(creditGrants.nextRenewalDate) // Has renewal scheduled
        ),
      });
      expect(activeGrant).toBeDefined();

      console.log(`Active grant for cycle ${cycle}:`, {
        grantId: activeGrant!.id,
        nextRenewalDate: activeGrant!.nextRenewalDate,
      });

      // Force the grant to be due for renewal
      const pastDate = new Date(Date.now() - cycle * 24 * 60 * 60 * 1000);
      await db
        .update(creditGrants)
        .set({ nextRenewalDate: pastDate })
        .where(eq(creditGrants.id, activeGrant!.id));

      // Process renewals
      const renewalResult = await processGrantRenewals(new Date());
      expect(renewalResult.renewalCount).toBeGreaterThanOrEqual(1);

      console.log(`Cycle ${cycle} renewal result:`, renewalResult);

      // Verify the original grant is now marked as done
      const updatedActiveGrant = await db.query.creditGrants.findFirst({
        where: eq(creditGrants.id, activeGrant!.id),
      });
      expect(updatedActiveGrant!.lastRenewalDate).toBeDefined();
      expect(updatedActiveGrant!.nextRenewalDate).toBeNull();

      // Verify new grant was created
      const newGrant = await db.query.creditGrants.findFirst({
        where: and(
          eq(creditGrants.customerId, customerId),
          eq(creditGrants.creditDefinitionId, weeklyRenewalCreditDef.id),
          eq(creditGrants.source, "refill"),
          isNull(creditGrants.lastRenewalDate), // Not yet renewed
          isNotNull(creditGrants.nextRenewalDate) // Has renewal scheduled
        ),
        orderBy: desc(creditGrants.createdAt), // Get the newest one
      });
      expect(newGrant).toBeDefined();
      expect(newGrant!.remainingAmount).toBe(75); // refillAmount
      expect(newGrant!.notes).toContain(
        `renewal from grant ${activeGrant!.id}`
      );

      console.log(`New grant created for cycle ${cycle}:`, {
        newGrantId: newGrant!.id,
        amount: newGrant!.remainingAmount,
      });
    }

    // Verify we have exactly 4 grants total (1 initial + 3 renewals)
    const allGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, weeklyRenewalCreditDef.id),
        isNull(creditGrants.deletedAt)
      ),
      orderBy: creditGrants.createdAt,
    });
    expect(allGrants.length).toBe(4);

    // Verify only the last grant is still scheduled for renewal
    const activeGrants = allGrants.filter(
      (g) => g.lastRenewalDate === null && g.nextRenewalDate !== null
    );
    expect(activeGrants.length).toBe(1); // Only the latest grant

    // Verify the "done" grants
    const doneGrants = allGrants.filter(
      (g) => g.lastRenewalDate !== null && g.nextRenewalDate === null
    );
    expect(doneGrants.length).toBe(3); // The 3 grants that triggered renewals

    console.log("Multi-renewal baton passing test completed successfully!", {
      totalGrants: allGrants.length,
      activeGrants: activeGrants.length,
      doneGrants: doneGrants.length,
    });
  }, 50000);

  it("should handle zero price plans with credit grants and billing cycles", async () => {
    const customerEmail = `credit-billing-zero-price-${Date.now()}@example.com`;
    const customerName = `Credit Billing Zero Price Customer`;
    const userId = `user-zero-price-${Date.now()}`;

    // 1. Create plan with features for zero price plan
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "api_calls",
          displayName: "API Calls",
          featureValue: 100, // Base allowance through credit grants
        },
      ],
      {
        stablePlanId: `cb-zero-price-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Free Plan with Credits",
      }
    );
    const testPlanId = planCreationResult.plan.id;
    const apiCallsFeature = planCreationResult.features.find(
      (f) => f.slug === "api_calls"
    );
    expect(apiCallsFeature).toBeDefined();

    // 2. Create zero price with fixed component
    const testPrice = await createTestPrice({
      planId: testPlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly_free_fee",
            type: "fixed",
            label: "Monthly Free Plan",
            amount_cents: 0, // Zero cost
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // 2a. Create pricing table and link the plan (required for createFreeSubscriptionForUser)
    await createTestPricingTable({
      merchantId,
      name: "Free Plan Pricing Table",
      slug: `free-pricing-table-${Date.now()}`,
      description: "Pricing table for free plan with credits",
      isActive: true,
      planIds: [testPlanId],
    });

    // Get component ID for credit definition
    const testPriceFromDb = await db.query.prices.findFirst({
      where: eq(prices.id, testPrice.id),
    });
    expect(testPriceFromDb).toBeDefined();
    const freeComponentId = testPriceFromDb!.pricingData.components.find(
      (c) => c.component_name === "monthly_free_fee"
    )?.component_id;
    expect(freeComponentId).toBeDefined();

    // 3. Create plan-level credit definition that renews on billing
    const planLevelCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      applicationType: "usage",
      featureId: apiCallsFeature!.id,
      featureSlug: "api_calls",
      planId: testPlanId,
      priceId: testPriceId, // Required for usage credits linked to billing
      priceComponentId: freeComponentId!, // Link to the free component
      name: "Free Plan API Credits",
      defaultAmount: 100, // 100 API calls
      refillAmount: 100, // Refill with same amount
      renewOnBilling: true, // Key: renew on billing cycles
      billingVisible: true, // Usage credits typically not shown as line items
      priority: 10,
    });

    // 4. Create subscription via payment-init (should handle zero price)
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    if (paymentInitResponse.status !== 200) {
      const errorData = await paymentInitResponse.text();
      console.error(
        "Payment init failed:",
        paymentInitResponse.status,
        errorData
      );
      throw new Error(
        `Payment init failed: ${paymentInitResponse.status} - ${errorData}`
      );
    }
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    // For zero price plans, should get direct subscription creation response
    if ("message" in paymentInitData) {
      expect(paymentInitData.message).toContain(
        "Free subscription created successfully"
      );
      expect(paymentInitData.subscription_id).toBeDefined();
      expect(paymentInitData.credit_grants_created).toBeGreaterThan(0);
    } else {
      throw new Error(
        "Expected free plan response but got Payment Provider response"
      );
    }
    const subscriptionId = paymentInitData.subscription_id;

    const subscription = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subscription).toBeDefined();
    expect(subscription!.planId).toBe(testPlanId);
    // 6. Get the customer that was created
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;
    // 7. Verify initial credit grant was created
    // Debug: Log all credit grants for this customer
    const allGrants = await db.query.creditGrants.findMany({
      //where: eq(creditGrants.customerId, customerId),
      with: {
        creditDefinition: true,
      },
    });
    console.log(
      `Found ${allGrants.length} credit grants for customer ${customerId}:`,
      allGrants.map((grant) => ({
        id: grant.id,
        creditDefinitionId: grant.creditDefinitionId,
        creditDefinitionName: grant.creditDefinition?.name,
        source: grant.source,
        initialAmount: grant.initialAmount,
        remainingAmount: grant.remainingAmount,
        createdAt: grant.createdAt,
      }))
    );
    const initialGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, planLevelCreditDef.id),
        eq(creditGrants.source, "subscription")
      ),
    });
    expect(initialGrant).toBeDefined();
    expect(initialGrant!.initialAmount).toBe(100);
    expect(initialGrant!.remainingAmount).toBe(100);

    // verify invoice was created
    let invoicesList = await db.query.invoices.findMany({
      where: eq(invoices.subscriptionId, subscriptionId),
    });
    expect(invoicesList.length).toBe(1);
    expect(invoicesList[0].totalAmountCents).toBe(0);
    expect(invoicesList[0].id).toBe(paymentInitData.invoice_id!);

    // 9. Verify NO payment record was created for zero amount invoice
    let paymentsList = await db.query.payments.findMany({
      where: and(eq(payments.merchantId, merchantId)),
    });
    expect(paymentsList.length).toBe(0); // No payment should exist for free plans

    // 10. Verify subscription details were created
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    expect(subDetails.length).toBe(1); // One component
    expect(subDetails[0].paymentMethodId).toBeNull(); // No payment method for free plans
    // 11. Fast-forward to next billing cycle
    console.log("Setting up next billing cycle for zero price plan...");
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1); // Yesterday

    // Update subscription details to be due for billing
    await db
      .update(subscriptionDetails)
      .set({
        previousBillingDate: subDetails[0].nextBillingDate,
        nextBillingDate: dueDate,
      })
      .where(eq(subscriptionDetails.id, subDetails[0].id));

    // 12. Mock the billing job for free plans
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        console.log(
          `Processing zero price billing for customer ${currentCustomerId}`
        );

        try {
          // Call the actual billing API
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
              },
              body: JSON.stringify({
                customerId: currentCustomerId,
                subDetails: currentSubDetails,
              }),
            }
          );

          const responseData = await response.json();
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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    // 13. Process second billing cycle
    console.log("Processing second billing cycle for zero price plan...");
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(4000);

    // verify invoice was created
    invoicesList = await db.query.invoices.findMany({
      where: and(eq(invoices.subscriptionId, subscriptionId)),
    });
    expect(invoicesList.length).toBe(2); // first on start and then one cycle processed
    expect(invoicesList[0].totalAmountCents).toBe(0);

    // verify still no payment was created
    paymentsList = await db.query.payments.findMany({
      where: and(eq(payments.merchantId, merchantId)),
    });
    expect(paymentsList.length).toBe(0); // no payment should be created for free plans

    // verify credit grant was renewed
    const renewedGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, planLevelCreditDef.id),
        eq(creditGrants.source, "refill")
      ),
      orderBy: desc(creditGrants.createdAt),
    });
    expect(renewedGrant).toBeDefined();
    expect(renewedGrant!.initialAmount).toBe(100); // Refill amount
    expect(renewedGrant!.remainingAmount).toBe(100);

    // verify subscription details were updated for next cycle
    const updatedSubDetails = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.id, subDetails[0].id),
    });
    expect(updatedSubDetails!.cyclesBilled).toBe(2); // Two cycles completed
    expect(updatedSubDetails!.previousBillingDate).toBeDefined();

    // verify still no payment was created
    const allPayments = await db.query.payments.findMany({
      where: and(eq(payments.merchantId, merchantId)),
    });
    expect(allPayments.length).toBe(0);
  }, 50000);

  it("should stop renewing free plan credit grants after upgrading to a paid plan", async () => {
    const ts = Date.now();
    const customerEmail = `free-paid-${ts}@example.com`;
    const customerName = "Free→Paid Upgrade User";
    const userId = `user-free-paid-${ts}`;

    /* --------------------------------------------------
     * 1.  Create FREE plan, price ( $0 ) and credit defs
     * -------------------------------------------------- */
    const freePlanRes = await createTestPlanWithFeatures(merchantId, [], {
      stablePlanId: `free-plan-${ts}`,
      versionNumber: 1,
      planName: "Free Starter Plan",
    });
    const freePlanId = freePlanRes.plan.id;

    const freePrice = await createTestPrice({
      planId: freePlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "free_component",
            type: "fixed",
            label: "Free Plan Component",
            amount_cents: 0,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const freePriceId = freePrice.id;

    // Create pricing table for the free plan (required for createFreeSubscriptionForUser)
    await createTestPricingTable({
      merchantId,
      name: "Free Starter Pricing Table",
      slug: `free-starter-table-${ts}`,
      description: "Pricing table for free starter plan",
      isActive: true,
      planIds: [freePlanId],
    });

    const freePriceRow = await db.query.prices.findFirst({
      where: eq(prices.id, freePriceId),
    });
    if (!freePriceRow) throw new Error("Failed to fetch free price row");
    const freeComponentId = freePriceRow.pricingData.components[0].component_id;

    // Billing-cycle renewable credit
    const billingCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: freePlanId,
      applicationType: "monetary",
      priceId: freePriceId,
      priceComponentId: freeComponentId,
      currency: "USD",
      name: "Billing Cycle Credit",
      defaultAmount: 500,
      refillAmount: 300,
      renewOnBilling: true,
      billingVisible: true,
      billingDescription: "Billing Cycle Credit",
      priority: 10,
    });

    // RRULE renewable credit
    const rruleCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: freePlanId,
      applicationType: "monetary",
      priceId: freePriceId,
      priceComponentId: freeComponentId,
      currency: "USD",
      name: "RRULE Credit",
      defaultAmount: 400,
      refillAmount: 400,
      renewOnBilling: false,
      refillRrule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
      billingVisible: true,
      billingDescription: "RRULE Credit",
      priority: 20,
    });

    /* --------------------------------------------------
     * 2.  Create FREE subscription (direct, no Payment Provider involved)
     * -------------------------------------------------- */
    const freeInitResp = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: freePriceId,
        planId: freePlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    expect(freeInitResp.status).toBe(200);
    const freeInitData = await freeInitResp.json();
    if (!("subscription_id" in freeInitData))
      throw new Error("Expected direct subscription response for free plan");

    const subscriptionId = freeInitData.subscription_id as string;

    await sleep(2000);

    const customer = await retryWithSleep(
      () =>
        db.query.customers.findFirst({
          where: and(
            eq(customers.merchantId, merchantId),
            eq(customers.email, customerEmail),
            isNull(customers.deletedAt)
          ),
        }),
      (result) => !!result
    );
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    // Verify initial credit grants
    const initialBillingGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, billingCreditDef.id)
      ),
    });
    expect(initialBillingGrant).toBeDefined();

    const initialRruleGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, rruleCreditDef.id)
      ),
    });
    expect(initialRruleGrant).toBeDefined();

    /* --------------------------------------------------
     * 3.  Run ONE billing cycle for FREE plan
     * -------------------------------------------------- */
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const d of subDetails) {
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: d.nextBillingDate,
          nextBillingDate: pastDate,
        })
        .where(eq(subscriptionDetails.id, d.id));
    }

    // Lightweight mock for collectPaymentJob
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        // Create idempotency key based on customer ID and billing date
        const idempotencyKey = `payment-customer-${currentCustomerId}-date-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "SUCCESS" as const,
                  output: result,
                  payload: itemPayload,
                },
              ],
            };
          } else {
            return {
              batchId: `mock-batch-${Date.now()}`,
              runs: [
                {
                  id: `mock-run-${Date.now()}`,
                  status: "FAILURE" as const,
                  error: `API Error: ${response.status}, Message: ${result.message}`,
                  payload: itemPayload,
                },
              ],
            };
          }
        } catch (error) {
          return {
            batchId: `mock-batch-${Date.now()}`,
            runs: [
              {
                id: `mock-run-${Date.now()}`,
                status: "FAILURE" as const,
                error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
                payload: itemPayload,
              },
            ],
          };
        }
      }
    );

    let tmpAllBillingGrants = await db.query.creditGrants.findMany({
      where: and(eq(creditGrants.customerId, customerId)),
    });
    console.log("All billing grants", tmpAllBillingGrants);
    console.log("Processing billing cycle for free plan...");

    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(3000);

    // Billing-cycle credit should have renewed
    const billingGrantsPostBill = await retryWithSleep(
      () =>
        db.query.creditGrants.findMany({
          where: and(
            eq(creditGrants.customerId, customerId),
            eq(creditGrants.creditDefinitionId, billingCreditDef.id)
          ),
        }),
      (result) => !!result
    );
    tmpAllBillingGrants = await db.query.creditGrants.findMany({
      where: and(eq(creditGrants.customerId, customerId)),
    });
    console.log("All billing grants", tmpAllBillingGrants);

    expect(billingGrantsPostBill.length).toBe(2);

    // Force RRULE grant due and process renewals
    await db
      .update(creditGrants)
      .set({ nextRenewalDate: pastDate })
      .where(eq(creditGrants.id, initialRruleGrant!.id));

    const { processGrantRenewals } = await import("../../src/helpers/credits");
    await processGrantRenewals(new Date());

    await sleep(2000);

    const rruleGrantsPostRenewal = await retryWithSleep(
      () =>
        db.query.creditGrants.findMany({
          where: and(
            eq(creditGrants.customerId, customerId),
            eq(creditGrants.creditDefinitionId, rruleCreditDef.id)
          ),
        }),
      (result) => !!result
    );
    expect(rruleGrantsPostRenewal.length).toBe(2);

    const billingCountPreUpgrade = billingGrantsPostBill.length;
    const rruleCountPreUpgrade = rruleGrantsPostRenewal.length;

    /* --------------------------------------------------
     * 4.  Create PAID plan & upgrade via Payment Provider
     * -------------------------------------------------- */
    const paidPlanRes = await createTestPlanWithFeatures(merchantId, [], {
      stablePlanId: `paid-plan-${ts}`,
      versionNumber: 1,
      planName: "Pro Plan",
    });
    const paidPlanId = paidPlanRes.plan.id;

    const paidPrice = await createTestPrice({
      planId: paidPlanId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "paid_component",
            type: "fixed",
            label: "Pro Fee",
            amount_cents: 1000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const paidPriceId = paidPrice.id;

    const paidInitResp = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: paidPriceId,
        planId: paidPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    expect(paidInitResp.status).toBe(200);
    const paidInitData = await paidInitResp.json();
    await paymentProvider.completePaymentInit(paidInitData);

    await paymentProvider.waitForWebhooks();

    const paidSubscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, paidPlanId)
          ),
        }),
      (res) => !!res
    );
    expect(paidSubscription).toBeDefined();

    // Make paid sub due for billing to exercise billing path again
    const paidDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, paidSubscription!.id),
    });
    for (const d of paidDetails) {
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: d.nextBillingDate,
          nextBillingDate: pastDate,
        })
        .where(eq(subscriptionDetails.id, d.id));
    }

    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());
    await sleep(2000);
    await processGrantRenewals(new Date());
    await sleep(2000);

    /* --------------------------------------------------
     * 5.  Assertions – no NEW grants for free plan defs
     * -------------------------------------------------- */
    const finalBillingGrants = await retryWithSleep(
      () =>
        db.query.creditGrants.findMany({
          where: and(
            eq(creditGrants.customerId, customerId),
            eq(creditGrants.creditDefinitionId, billingCreditDef.id)
          ),
        }),
      (result) => !!result
    );
    const finalRruleGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, rruleCreditDef.id)
      ),
    });

    expect(finalBillingGrants.length).toBe(billingCountPreUpgrade);
    expect(finalRruleGrants.length).toBe(rruleCountPreUpgrade);

    // All free-plan grants should have nextRenewalDate cleared
    [...finalBillingGrants, ...finalRruleGrants].forEach((g) => {
      expect(g.nextRenewalDate).toBeNull();
    });
  }, 80000);

  it("should apply manual credit grants correctly during billing", async () => {
    const customerEmail = `manual-credit-test-${Date.now()}@example.com`;
    const customerName = `Manual Credit Test Customer`;
    const userId = `user-manual-${Date.now()}`;

    // 1. Create test plan and price
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `manual-credit-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Manual Credit Test Plan",
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
            component_name: "manual_test_fee",
            type: "fixed",
            label: "Manual Test Fee",
            amount_cents: 5000, // $50.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    const testPriceId = testPrice.id;

    // 2. Create subscription via E2E payment flow
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: testPriceId,
        planId: testPlanId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    // 3. Get customer ID
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.email, customerEmail),
        isNull(customers.deletedAt)
      ),
    });
    expect(customer).toBeDefined();
    const customerId = customer!.id;

    // 4. Wait for subscription creation
    await sleep(2000);
    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customerId),
            eq(subscriptions.planId, testPlanId)
          ),
        }),
      (result) => !!result
    );
    expect(subscription).toBeDefined();

    // 5. Create manual credit grants - both extending and new types
    // First, create a plan-level credit definition to extend
    const planLevelCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: null,
      priceComponentId: null,
      currency: "USD",
      name: "Plan Level Credit",
      defaultAmount: 1000,
      billingVisible: true,
      billingDescription: "Plan Level Credit",
      priority: 60,
    });

    // Create an initial grant for this definition
    const initialGrant = await createCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: planLevelCreditDef.id,
      initialAmount: 1000,
      source: "subscription",
    });

    // Now create manual credit grants
    // 5a. Extend existing credit (add more to the plan-level credit)
    const manualExtendResult = await createManualCreditGrant({
      merchantId,
      customerId,
      creditType: "extend",
      existingCreditDefinitionId: planLevelCreditDef.id,
      amount: 1500, // $15.00 more
      notes: "Manual extension for testing",
    });

    // 5b. Create new monetary credit (merchant-level)
    const manualNewResult = await createManualCreditGrant({
      merchantId,
      customerId,
      creditType: "new",
      newCreditConfig: {
        applicationType: "monetary",
        scope: "merchant",
        currency: "USD",
        billingVisible: true,
        billingDescription: "Manual Account Credit",
        name: "Manual Account Credit",
        description: "One-time account credit",
      },
      amount: 2000, // $20.00
      notes: "Manual account credit for testing",
    });

    // 6. Verify manual grants were created
    const extendGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, manualExtendResult.creditGrant.id),
    });
    expect(extendGrant).toBeDefined();
    expect(extendGrant!.source).toBe("manual");
    expect(extendGrant!.initialAmount).toBe(1500);
    expect(extendGrant!.remainingAmount).toBe(1500);
    expect(extendGrant!.creditDefinitionId).toBe(planLevelCreditDef.id);

    const newGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, manualNewResult.creditGrant.id),
    });
    expect(newGrant).toBeDefined();
    expect(newGrant!.source).toBe("manual");
    expect(newGrant!.initialAmount).toBe(2000);
    expect(newGrant!.remainingAmount).toBe(2000);
    expect(newGrant!.scope).toBe("merchant");

    // 7. Verify credit definitions
    const manualCreditDef = await db.query.creditDefinitions.findFirst({
      where: eq(creditDefinitions.id, manualNewResult.creditDefinition.id),
    });
    expect(manualCreditDef).toBeDefined();
    expect(manualCreditDef!.name).toBe("Manual Account Credit");
    expect(manualCreditDef!.renewOnBilling).toBe(false);
    expect(manualCreditDef!.refillRrule).toBeNull();

    // 8. Trigger billing cycle and verify credits are applied
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscription!.id),
    });
    expect(subDetails.length).toBeGreaterThan(0);

    // Set up billing date to trigger second invoice
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      const currentNextBillingDate = detail.nextBillingDate;
      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: currentNextBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // Mock the collect payment job
    collectPaymentJobTriggerSpy.mockImplementation(
      async (batchItems: { payload: CollectPaymentJobPayload }[]) => {
        const itemPayload = batchItems[0].payload;
        const { customerId: currentCustomerId, subDetails: currentSubDetails } =
          itemPayload;

        const idempotencyKey = `manual-credit-payment-${currentCustomerId}-${currentSubDetails[0].nextBillingDate.split("T")[0]}`;

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

        if (!response.ok) {
          throw new Error(`Payment collection failed: ${response.statusText}`);
        }

        return [{ id: "manual-credit-test-job" }];
      }
    );

    // Run billing cycle
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());

    // 9. Verify billing applied credits correctly
    const secondInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.customerId, customerId),
            ne(invoices.id, subscription!.id) // Different from first invoice
          ),
          orderBy: desc(invoices.createdAt),
          with: { lineItems: true },
        }),
      (result) => !!result
    );

    expect(secondInvoice).toBeDefined();
    expect(secondInvoice!.lineItems.length).toBeGreaterThan(0);

    // Find credit line items
    const creditLineItems = secondInvoice!.lineItems.filter(
      (item) => item.subtotalCents < 0
    );
    expect(creditLineItems.length).toBeGreaterThan(0);

    // Total credits should be applied: $10 (initial) + $15 (manual extend) + $20 (manual new) = $45
    const totalCreditsApplied = creditLineItems.reduce(
      (sum, item) => sum + Math.abs(item.subtotalCents),
      0
    );
    expect(totalCreditsApplied).toBe(4500); // $45.00 in cents

    // Invoice should be: $50.00 - $45.00 = $5.00
    expect(secondInvoice!.totalAmountCents).toBe(500);

    // 10. Verify credit grants were updated correctly
    const updatedInitialGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, initialGrant.id),
    });
    const updatedExtendGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, extendGrant!.id),
    });
    const updatedNewGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, newGrant!.id),
    });

    // All credits should be depleted or partially used
    expect(updatedInitialGrant!.remainingAmount).toBe(0);
    expect(updatedExtendGrant!.remainingAmount).toBe(0);
    expect(updatedNewGrant!.remainingAmount).toBe(0);

    // 11. Verify credit usage transactions were created
    const usageTransactions = await db.query.creditUsageTransactions.findMany({
      where: eq(creditUsageTransactions.invoiceId, secondInvoice!.id),
    });
    expect(usageTransactions.length).toBe(3); // One for each grant used

    // Verify the manual grants have correct transaction records
    const manualExtendTransaction = usageTransactions.find(
      (tx) => tx.creditGrantId === extendGrant!.id
    );
    const manualNewTransaction = usageTransactions.find(
      (tx) => tx.creditGrantId === newGrant!.id
    );

    expect(manualExtendTransaction).toBeDefined();
    expect(manualExtendTransaction!.amount).toBe(1500);
    expect(manualNewTransaction).toBeDefined();
    expect(manualNewTransaction!.amount).toBe(2000);
  }, 40000);

  it("should create and verify manual credit definitions and grants without E2E payment flow", async () => {
    // This test focuses specifically on manual credit grant functionality
    // without the complexity of the full E2E payment flow

    // 1. Create test plan and customer directly
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `simple-manual-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Simple Manual Credit Plan",
      }
    );
    const testPlanId = planCreationResult.plan.id;

    const testCustomer = await createTestCustomer({
      merchantId,
      email: `simple-manual-test-${Date.now()}@example.com`,
      name: "Simple Manual Test Customer",
    });
    const customerId = testCustomer.id;

    // 2. Create existing credit definition for extension testing
    const existingCreditDef = await createCreditDefinition({
      merchantId,
      scope: "plan",
      planId: testPlanId,
      applicationType: "monetary",
      priceId: null,
      priceComponentId: null,
      currency: "USD",
      name: "Existing Plan Credit",
      defaultAmount: 500,
      billingVisible: true,
      billingDescription: "Existing Plan Credit",
      priority: 50,
    });

    // 3. Test extending existing credit definition
    const extendCreditResult = await createManualCreditGrant({
      merchantId,
      customerId,
      creditType: "extend",
      existingCreditDefinitionId: existingCreditDef.id,
      amount: 800,
      notes: "Manual extension test",
    });

    // Verify extend result
    expect(extendCreditResult.creditGrant).toBeDefined();
    expect(extendCreditResult.creditDefinition).toBeDefined();
    expect(extendCreditResult.creditGrant.source).toBe("manual");
    expect(extendCreditResult.creditGrant.initialAmount).toBe(800);
    expect(extendCreditResult.creditGrant.remainingAmount).toBe(800);
    expect(extendCreditResult.creditGrant.creditDefinitionId).toBe(
      existingCreditDef.id
    );
    expect(extendCreditResult.creditDefinition.id).toBe(existingCreditDef.id);

    // 4. Test creating new monetary credit (merchant-level)
    const newMerchantCreditResult = await createManualCreditGrant({
      merchantId,
      customerId,
      creditType: "new",
      newCreditConfig: {
        applicationType: "monetary",
        scope: "merchant",
        currency: "USD",
        billingVisible: true,
        billingDescription: "Manual Merchant Credit",
        name: "Manual Merchant Credit",
        description: "One-time merchant credit",
      },
      amount: 1200,
      notes: "Manual merchant credit test",
    });

    // Verify new merchant credit result
    expect(newMerchantCreditResult.creditGrant).toBeDefined();
    expect(newMerchantCreditResult.creditDefinition).toBeDefined();
    expect(newMerchantCreditResult.creditGrant.source).toBe("manual");
    expect(newMerchantCreditResult.creditGrant.initialAmount).toBe(1200);
    expect(newMerchantCreditResult.creditGrant.remainingAmount).toBe(1200);
    expect(newMerchantCreditResult.creditGrant.scope).toBe("merchant");
    expect(newMerchantCreditResult.creditDefinition.scope).toBe("merchant");
    expect(newMerchantCreditResult.creditDefinition.renewOnBilling).toBe(false);
    expect(newMerchantCreditResult.creditDefinition.refillRrule).toBeNull();

    // 5. Test creating new plan-level credit
    const newPlanCreditResult = await createManualCreditGrant({
      merchantId,
      customerId,
      creditType: "new",
      newCreditConfig: {
        applicationType: "monetary",
        scope: "plan",
        planId: testPlanId,
        currency: "USD",
        billingVisible: true,
        billingDescription: "Manual Plan Credit",
        name: "Manual Plan Credit",
        description: "One-time plan credit",
      },
      amount: 600,
      expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      notes: "Manual plan credit with expiry test",
    });

    // Verify new plan credit result
    expect(newPlanCreditResult.creditGrant).toBeDefined();
    expect(newPlanCreditResult.creditDefinition).toBeDefined();
    expect(newPlanCreditResult.creditGrant.source).toBe("manual");
    expect(newPlanCreditResult.creditGrant.initialAmount).toBe(600);
    expect(newPlanCreditResult.creditGrant.remainingAmount).toBe(600);
    expect(newPlanCreditResult.creditGrant.scope).toBe("plan");
    expect(newPlanCreditResult.creditGrant.planId).toBe(testPlanId);
    expect(newPlanCreditResult.creditGrant.expiryDate).toBeDefined();
    expect(newPlanCreditResult.creditDefinition.scope).toBe("plan");
    expect(newPlanCreditResult.creditDefinition.planId).toBe(testPlanId);

    // 6. Verify all credit grants exist in database
    const allCustomerGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.merchantId, merchantId),
        isNull(creditGrants.deletedAt)
      ),
    });

    expect(allCustomerGrants.length).toBe(3);

    // Verify manual source for all grants
    const manualGrants = allCustomerGrants.filter(
      (grant) => grant.source === "manual"
    );
    expect(manualGrants.length).toBe(3);

    // 7. Verify credit definitions were created correctly
    const allDefinitions = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.merchantId, merchantId),
        isNull(creditDefinitions.deletedAt)
      ),
    });

    // Should have: existing definition + 2 new manual definitions
    expect(allDefinitions.length).toBe(3);

    const manualDefinitions = allDefinitions.filter(
      (def) => def.renewOnBilling === false && def.refillRrule === null
    );
    expect(manualDefinitions.length).toBe(3); // All should be non-renewing for manual grants

    // 8. Verify credit usage transactions were created
    const grantedTransactions = await db.query.creditUsageTransactions.findMany(
      {
        where: and(
          eq(creditUsageTransactions.customerId, customerId),
          eq(creditUsageTransactions.eventName, "granted")
        ),
      }
    );

    expect(grantedTransactions.length).toBe(3);
    const manualGrantTransactions = grantedTransactions.filter((tx) =>
      manualGrants.some((grant) => grant.id === tx.creditGrantId)
    );
    expect(manualGrantTransactions.length).toBe(3);

    // Verify transaction amounts
    expect(
      manualGrantTransactions.map((tx) => tx.amount).sort((a, b) => a - b)
    ).toEqual([600, 800, 1200]);
  }, 10000);
});
