import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  spyOn,
  beforeAll,
  afterAll,
  setDefaultTimeout,
} from "bun:test";
import { addDays, addMinutes, subDays } from "date-fns";
import { processBillingCycle } from "../../trigger/helpers/billing";
import { db } from "../../src/db/client";
import { sql, eq, and, isNull, inArray, ne } from "drizzle-orm";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createTestApiKeys,
  createPaymentProvider,
  PaymentProviderAdapter,
  createTestPrice,
  createApiKeyClient,
} from "../test-helpers";
import { cleanupDataFull } from "../test-helpers/test-utils/setup";
import { clearEventData } from "../test-helpers/test-utils/questdb-helpers";
import {
  invoices,
  invoiceLineItems,
  subscriptionDetails,
  subscriptions,
  customers,
  metrics,
  creditGrants,
  creditDefinitions,
  subscriptionFeatures,
  customerOrganizations,
  creditUsageTransactions,
  payments,
  paymentMethods,
  customerInvoiceCounters,
  plans,
  features,
  featureMetrics,
  prices,
  events,
  pricingTablePlans,
  pricingTables,
  planFeatures,
} from "@lumen/common/schema";
import { env } from "../../src/env";
// QuestDB race conditions so we using real sleep instead of immediate mock
// import { setTimeout as sleep } from "timers/promises";
import { sleep } from "../test-helpers/sleep";
import questDbService from "../../src/db/questDbService";
import { z } from "zod";
import { collectPaymentJob } from "../../trigger/jobs/collectPayment";
import { collectPaymentPayloadSchema } from "../../trigger/helpers/collectPayment";
import { prorateAmountCents } from "../../src/helpers/proration";
import fs from "fs";

setDefaultTimeout(10000);

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

// Stripe CLI resolution and webhook management handled by provider harness

describe("Seat-Based Plans Integration Tests", () => {
  let merchantId: string;
  let customerId: string;
  let externalCustomerId: string;
  let planId: string;
  let subscriptionId: string;
  let apiClient: ReturnType<typeof createTestApiClient>;
  let batchTriggerSpy: ReturnType<typeof spyOn>;
  let testStartTime: Date;
  let apiUrl: string;
  let triggerApiAccessKey: string;
  let sessionToken: string;
  let paymentProvider: PaymentProviderAdapter;
  let publishableApiKey: string;

  // Webhook lifecycle handled by provider harness

  beforeAll(async () => {
    await cleanupDataFull();

    // Clean up any existing Stripe mock store
    try {
      await fs.promises.unlink("/tmp/stripe_mock_store.json");
    } catch (error) {
      // File doesn't exist, which is fine
    }
    paymentProvider = await createPaymentProvider();

    // Initialize QuestDB service for the test process
    const {
      QUESTDB_HOST,
      QUESTDB_INGEST_PORT,
      QUESTDB_QUERY_PORT,
      QUESTDB_USER,
      QUESTDB_PASSWORD,
    } = env;
    await questDbService.initialize(
      QUESTDB_HOST,
      QUESTDB_INGEST_PORT,
      QUESTDB_QUERY_PORT,
      QUESTDB_USER,
      QUESTDB_PASSWORD!
    );
  });

  afterAll(async () => {
    await paymentProvider.cleanup();

    // Close QuestDB connection
    try {
      await questDbService.close();
    } catch (error) {
      console.error("Failed to close QuestDB for test process:", error);
    }
  });

  const cleanupTestData = async () => {
    // this is different from cleanupDataFull because it doesn't clean up the merchant, user, and payment provider config
    try {
      await db.execute(sql`
        DELETE FROM ${creditUsageTransactions};
        DELETE FROM ${creditGrants};
        DELETE FROM ${creditDefinitions};
        DELETE FROM ${payments};
        DELETE FROM ${invoiceLineItems};
        DELETE FROM ${invoices};
        DELETE FROM ${subscriptionFeatures};
        DELETE FROM ${subscriptionDetails};
        DELETE FROM ${subscriptions};
        DELETE FROM ${paymentMethods};
        DELETE FROM ${customerInvoiceCounters};
        DELETE FROM ${customers};
        DELETE FROM ${customerOrganizations};
        DELETE FROM ${prices};
        DELETE FROM ${planFeatures};
        DELETE FROM ${features};
        DELETE FROM ${featureMetrics};
        DELETE FROM ${metrics};
        DELETE FROM ${pricingTablePlans};
        DELETE FROM ${pricingTables};
        DELETE FROM ${plans};
        DELETE FROM ${events};
      `);
    } catch (error) {
      console.error("Error during test cleanup:", error);
      throw error;
    }
  };

  beforeEach(async () => {
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

    // 1. Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Register provider integration for the merchant
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

    // Create API client
    apiClient = createTestApiClient(sessionToken);

    // 3. Set up external customer ID for use in tests
    externalCustomerId = `seat-test-customer-${Date.now()}`;

    // Start provider webhook forwarder
    await paymentProvider.startWebhookForwarder(merchantId);

    // --- Mock Setup ---
    batchTriggerSpy = spyOn(collectPaymentJob, "batchTrigger");
    batchTriggerSpy.mockImplementation(async (batchItems: BatchItem[]) => {
      const runResults: MockRunResult[] = [];

      console.log(
        `Mock batchTrigger (collectPaymentJob) executing for ${batchItems.length} items (Seat-Based)...`
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
          `   Mock processing item for customer: ${payload.customerId} with ${payload.subDetails.length} subscription details (Seat-Based) for billing date ${firstSubDetailBillingDate}`
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
              id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-seat`,
              status: "SUCCESS",
              output: parsedResult,
              payload: payload,
            });
            console.log(
              `      Mock API call to /collect-payment successful for customer: ${payload.customerId} (Seat-Based), PaymentIntentID: ${parsedResult.paymentIntentId}`
            );
          } else {
            console.error(
              `      Mock API call to /collect-payment failed for customer ${payload.customerId} (Seat-Based): Status ${response.status}, Response: ${JSON.stringify(responseData)}`
            );
            runResults.push({
              id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-seat`,
              status: "FAILURE",
              error: `API Error: ${response.status}, Message: ${parsedResult.message}`,
              payload: payload,
            });
          }
        } catch (error) {
          console.error(
            `      Mock fetch error for customer ${payload.customerId} (Seat-Based): ${error instanceof Error ? error.message : String(error)}`
          );
          runResults.push({
            id: `mock-run-${payload.customerId}-${firstSubDetailBillingDate}-seat`,
            status: "FAILURE",
            error: `Fetch Error: ${error instanceof Error ? error.message : String(error)}`,
            payload: payload,
          });
        }
      }

      console.log(
        `   Mock batchTrigger (collectPaymentJob) finished processing (Seat-Based). Successful runs: ${runResults.filter((r) => r.status === "SUCCESS").length}`
      );

      return {
        batchId: `mock-batch-${Date.now()}-seat`,
        runs: runResults,
      };
    });
  });

  afterEach(async () => {
    // Restore the original implementation
    if (batchTriggerSpy) {
      batchTriggerSpy.mockRestore();
    }

    await paymentProvider.cleanup();

    try {
      // Clear event data from both QuestDB and PostgreSQL + event queue
      await clearEventData();

      // Use selective cleanup function for test data only
      await cleanupTestData();
    } catch (error) {
      console.error("Error during test cleanup:", error);
      throw error;
    }
  });

  /**
   * Helper function to create a seat-based plan using the API
   */
  const createSeatBasedPlan = async (
    monthlyPricePerSeat: number,
    yearlyPricePerSeat?: number,
    options?: {
      currency?: string;
      minSeats?: number;
      billImmediately?: boolean;
      features?: Array<{
        featureName: string;
        slug: string;
        eventName?: string;
        isUsageBased: boolean;
        usagePricePerUnit?: number;
        hasCreditAllowance?: boolean;
        creditAllowanceAmount?: number;
        creditAllowanceRenewal?: "monthly" | "yearly" | "none";
      }>;
    }
  ) => {
    // Create plan using the API
    const planResponse = await apiClient.plans.$post({
      json: {
        planName: "Test Seat Plan",
        planDescription: "A seat-based plan for testing",
        commitMessage: "Created seat-based plan for testing",
        currency: options?.currency ?? "USD",
        monthlyPrice: monthlyPricePerSeat,
        ...(yearlyPricePerSeat && {
          yearlyPrice: yearlyPricePerSeat,
          hasYearlyPrice: true,
        }),
        showInPricingTable: true,
        isEnterprisePlan: false,
        isSeatBased: true,
        ...(options?.minSeats && { minSeats: options.minSeats }),
        ...(options?.billImmediately !== undefined && {
          billImmediately: options.billImmediately,
        }),
        newFeatures: options?.features || [],
      },
    });

    const planData = await planResponse.json();
    if ("error" in planData) {
      throw new Error(planData.error);
    }

    const plan = planData.plans[0];

    // Get the created prices
    const pricesResponse = await apiClient.prices.$get({
      query: { planId: plan.id },
    });

    const pricesData = await pricesResponse.json();
    if ("error" in pricesData) {
      throw new Error(pricesData.error);
    }

    const prices = pricesData.prices;
    const monthlyPrice = prices.find((p) =>
      p.pricingData.components.some((c) =>
        c.recurrence_rule?.includes("MONTHLY")
      )
    );
    const yearlyPrice = prices.find((p) =>
      p.pricingData.components.some((c) =>
        c.recurrence_rule?.includes("YEARLY")
      )
    );

    // Get the metric that was created
    const metricsResponse = await apiClient.metrics.$get();
    const metricsData = await metricsResponse.json();
    if ("error" in metricsData) {
      throw new Error(metricsData.error);
    }

    const seatMetric = metricsData.find((m) =>
      m.name.includes("Active seat count for Test Seat Plan")
    );

    return {
      plan,
      monthlyPrice,
      yearlyPrice,
      seatMetric,
    };
  };

  /**
   * Helper function to add seats via API
   */
  type AddSeatSuccess = {
    message: string;
    user_id?: string;
    organization_id?: string;
    created_user_id: string;
    subscription_id: string;
    idempotency_key: string;
  };
  type RemoveSeatSuccess = {
    message: string;
    user_id?: string;
    organization_id?: string;
    removed_user_id: string;
    subscription_id: string;
    idempotency_key: string;
  };
  type ErrorResponse = { error: string };

  const addSeats = async (userIds: string[], eventTimestamp?: Date) => {
    const results: Array<AddSeatSuccess | ErrorResponse> = [];
    for (const userId of userIds) {
      const response = await apiClient.seats.add.$post({
        json: {
          user_id: externalCustomerId,
          created_user_id: userId,
          metadata: { role: "user" },
          idempotency_key: `add-seat-${userId}-${Date.now()}`,
          ...(eventTimestamp && {
            timestamp: eventTimestamp.toISOString(),
          }),
        },
      });

      const result = await response.json();
      results.push(result);
    }
    return results;
  };

  /**
   * Helper function to remove seats via API
   */
  const removeSeats = async (userIds: string[], eventTimestamp?: Date) => {
    const results: Array<RemoveSeatSuccess | ErrorResponse> = [];
    for (const userId of userIds) {
      const response = await apiClient.seats.remove.$post({
        json: {
          user_id: externalCustomerId,
          removed_user_id: userId,
          metadata: { reason: "user_deactivated" },
          idempotency_key: `remove-seat-${userId}-${Date.now()}`,
          ...(eventTimestamp && {
            timestamp: eventTimestamp.toISOString(),
          }),
        },
      });

      const result = await response.json();
      results.push(result);
    }
    return results;
  };

  /**
   * Helper function to get current seat count using the actual billing metric
   */
  const getCurrentSeatCount = async (
    customerId: string,
    subscriptionId: string,
    metricId: string,
    periodStart?: Date,
    periodEnd?: Date
  ): Promise<number> => {
    // Default to a very long period that covers all events if not specified
    const defaultPeriodStart = new Date("2020-01-01");
    const defaultPeriodEnd = new Date();

    const result = await questDbService.queryMetrics({
      merchantId,
      metricType: "complex",
      timeframe: { type: "ALL" },
      rawSql: `
        WITH user_events_before_period AS (
          SELECT
            event_string as user_id,
            event_name,
            event_timestamp,
            row_number() OVER (
              PARTITION BY event_string
              ORDER BY event_timestamp DESC
            ) as rn
          FROM events
          WHERE merchant_id = $1
            AND customer_id = $2
            AND json_extract(properties, '$.subscription_id')::varchar = $3
            AND event_name IN ('seat_added', 'seat_removed')
            AND event_timestamp < $4
        ),
        users_active_at_period_start AS (
          SELECT user_id
          FROM user_events_before_period
          WHERE rn = 1 AND event_name = 'seat_added'
        ),
        users_added_during_period AS (
          SELECT DISTINCT event_string as user_id
          FROM events
          WHERE merchant_id = $1
            AND customer_id = $2
            AND json_extract(properties, '$.subscription_id')::varchar = $3
            AND event_name = 'seat_added'
            AND event_timestamp >= $4
            AND event_timestamp <= $5
        )
        SELECT COUNT(DISTINCT user_id) as value
        FROM (
          SELECT user_id FROM users_active_at_period_start
          UNION
          SELECT user_id FROM users_added_during_period
        ) combined_users
      `,
      rawValues: [
        merchantId,
        customerId,
        subscriptionId,
        (periodStart || defaultPeriodStart).toISOString(),
        (periodEnd || defaultPeriodEnd).toISOString(),
      ],
    });

    if (result.error) {
      throw new Error(`Failed to get seat count: ${result.error}`);
    }

    const rawValue = result.rows?.[0]?.value;
    if (rawValue === null || rawValue === undefined) {
      return 0;
    }

    const numericValue = Number(rawValue);
    return isNaN(numericValue) ? 0 : numericValue;
  };

  /**
   * Helper function to create a subscription using the proper payment flow
   */
  const createSubscription = async (
    customerEmail: string,
    priceId: string,
    planId: string,
    primarySeatEventTimestamp?: Date
  ) => {
    // Use the payment-init endpoint to create the proper payment flow
    const paymentInitResponse = await apiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId,
        planId,
        customerEmail,
        customerName: "Seat Test Customer",
        userId: externalCustomerId,
        ...(primarySeatEventTimestamp && {
          primarySeatEventTimestamp: primarySeatEventTimestamp.toISOString(),
        }),
        ...(process.env.PAYMENT_PROVIDER === "dodo"
          ? {
              customerAddress: "123 Test Street",
              customerZip: "12345",
              customerCity: "Test City",
              customerCountry: "US",
              customerStateProvince: "CA",
            }
          : {}),
      },
    });

    if (paymentInitResponse.status !== 200) {
      throw new Error(
        `Payment init failed with status ${paymentInitResponse.status}`
      );
    }

    const paymentInitData = await paymentInitResponse.json();

    await paymentProvider.completePaymentInit(paymentInitData);
    await paymentProvider.waitForWebhooks();

    // Find the created customer
    const createdCustomers = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.merchantId, merchantId),
          eq(customers.email, customerEmail),
          isNull(customers.deletedAt)
        )
      );

    if (createdCustomers.length !== 1) {
      throw new Error(`Expected 1 customer, found ${createdCustomers.length}`);
    }

    const customer = createdCustomers[0];

    // Find the created subscription
    const createdSubscriptions = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.merchantId, merchantId),
          eq(subscriptions.customerId, customer.id),
          isNull(subscriptions.deletedAt)
        )
      );

    if (createdSubscriptions.length !== 1) {
      throw new Error(
        `Expected 1 subscription, found ${createdSubscriptions.length}`
      );
    }

    const subscription = createdSubscriptions[0];

    // Get subscription details
    const details = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscription.id),
    });

    if (!details) {
      throw new Error("Subscription details not found");
    }

    return {
      subscription,
      subscriptionDetails: details,
      customer,
    };
  };

  /**
   * Helper function to advance billing date and trigger billing cycle
   */
  const advanceBillingAndProcess = async (
    daysToAdvance: number = 1,
    previousBillingDateSubDays: number = 30
  ) => {
    // Check for existing invoices and slightly perturb their dates to avoid collisions
    const existingInvoices = await db.query.invoices.findMany({
      where: eq(invoices.subscriptionId, subscriptionId),
    });

    // Slightly adjust existing invoice dates to avoid billing period collisions
    for (let i = 0; i < existingInvoices.length; i++) {
      const invoice = existingInvoices[i];
      if (!invoice.billingPeriodStart) continue;

      const offsetMinutes = (i + 1) * 5; // 5 minutes per existing invoice
      const adjustedDate = addMinutes(
        invoice.billingPeriodStart,
        offsetMinutes
      );

      await db
        .update(invoices)
        .set({
          billingPeriodStart: adjustedDate,
        })
        .where(eq(invoices.id, invoice.id));
    }

    // Update the next billing date to be in the past
    const pastDate = subDays(testStartTime, daysToAdvance);

    await db.update(subscriptionDetails).set({
      nextBillingDate: pastDate,
      previousBillingDate: subDays(pastDate, previousBillingDateSubDays), // 30 days before
    });

    // Process billing cycle
    const result = await processBillingCycle(apiUrl, triggerApiAccessKey);

    // Wait for payment processing
    await sleep(3000);

    return result;
  };

  it("should create a seat-based plan and subscription correctly", async () => {
    // Create seat-based plan
    const seatPlan = await createSeatBasedPlan(1000); // $10 per seat per month
    planId = seatPlan.plan.id;

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId,
      testStartTime // No backdating needed for this basic test
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    // Verify subscription was created correctly
    expect(subResult.subscription.planId).toBe(planId);
    expect(subResult.subscription.customerId).toBe(customerId);
    expect(subResult.subscription.merchantId).toBe(merchantId);

    // Verify subscription details exist
    expect(subResult.subscriptionDetails).toBeDefined();
    expect(subResult.subscriptionDetails.nextBillingDate).toBeDefined();
  });

  it("should bill correctly for seat additions/removals in same month", async () => {
    // Create seat-based plan
    const seatPlan = await createSeatBasedPlan(1000); // $10 per seat per month
    planId = seatPlan.plan.id;
    const eventTimestamp = subDays(testStartTime, 15);

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId,
      eventTimestamp
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    await sleep(1000, { alsoSleepInStripeMock: true }); // one customer would already have been added in the createSubscription call
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(1);

    // Add 5 seats
    await addSeats(
      ["user1", "user2", "user3", "user4", "user5"],
      eventTimestamp
    );

    // Wait a bit to make sure the seat count is updated
    await sleep(1000, { alsoSleepInStripeMock: true });

    // Verify seat count
    seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(6);

    // Remove 2 seats
    await removeSeats(["user2", "user4"], addMinutes(eventTimestamp, 1));

    await sleep(1000, { alsoSleepInStripeMock: true });
    seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime, // new cycle started
      addDays(testStartTime, 30) // 30 days later
    );
    expect(seatCount).toBe(4);

    // Trigger billing cycle
    const billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    await sleep(3000);

    // Check invoice - should bill for ALL 6 seats (removals take effect next month)
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      with: {
        lineItems: true,
      },
    });

    expect(invoice).toBeDefined();
    invoice!.lineItems = invoice!.lineItems.filter(
      (item) => item.type !== "tax"
    );

    expect(invoice!.totalAmountCents).toBe(6000); // 6 seats × $10 = $60
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(6);
    expect(invoice!.lineItems[0].unitAmountCents).toBe(1000);
  }, 20000);

  it("should handle multiple billing cycles with seat changes correctly", async () => {
    // Create seat-based plan
    const seatPlan = await createSeatBasedPlan(1000); // $10 per seat per month
    planId = seatPlan.plan.id;

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId,
      subDays(testStartTime, 45) // Primary seat event needs to be at the earliest event timestamp
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    // === MONTH 1 ===
    const eventTimestamp1 = subDays(testStartTime, 45); // Events for first billing cycle
    // Add 3 seats
    await addSeats(["user1", "user2", "user3"], eventTimestamp1);

    // Remove 1 seat
    await removeSeats(["user2"], addMinutes(eventTimestamp1, 1));

    await sleep(1000, { alsoSleepInStripeMock: true });

    // Current active seats: 3 (including primary seat), but billing should be for 4 (all additions)
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(3);

    // Trigger first billing cycle
    let billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    await sleep(3000);

    let invoices1 = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
      orderBy: (invoices, { asc }) => [asc(invoices.createdAt)],
    });

    // filter out tax line items
    const invoice1 = invoices1.filter((invoice) =>
      invoice.lineItems.some((item) => item.type !== "tax")
    );
    expect(invoice1).toHaveLength(1);
    // 3 seats × $10 = $30, no tax or credits (seat removed in the billing cycle BEFORE the start of the backdated billing cycle)
    expect(invoice1[0].totalAmountCents).toBe(3000);

    // === MONTH 2 ===
    const eventTimestamp2 = subDays(testStartTime, 15); // Events for second billing cycle
    // Add 2 more seats
    await addSeats(["user4", "user5"], eventTimestamp2);

    // Remove 1 more seat
    await removeSeats(["user3"], addMinutes(eventTimestamp2, 1));

    await sleep(1000, { alsoSleepInStripeMock: true });

    // Current active seats should be 4 (primary, user1, user4, user5)
    seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(4);

    // Trigger second billing cycle
    billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);
    // Check second invoice
    // should have 2 invoices - one from first billing cycle, one from second billing cycle
    let invoices2 = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
      orderBy: (invoices, { asc }) => [asc(invoices.createdAt)],
    });

    expect(invoices2).toHaveLength(2);
    // the removal of user3 now falls INSIDE the billing cycle after backdating so we have 5 seats
    expect(invoices2[1].totalAmountCents).toBe(5000); // 5 seats × $10 = $50

    // === MONTH 3 ===
    const eventTimestamp3 = subDays(testStartTime, 5); // Events for third billing cycle
    // Only add seats, no removals
    await addSeats(["user6", "user7"], eventTimestamp3);

    await sleep(1000, { alsoSleepInStripeMock: true });

    // Current active seats should be 6 (primary, user1, user4, user5, user6, user7)
    seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      subDays(testStartTime, 5),
      addDays(testStartTime, 25)
    );
    expect(seatCount).toBe(6);

    // Trigger third billing cycle
    billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    // Check third invoice
    let invoices3 = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
      orderBy: (invoices, { asc }) => [asc(invoices.createdAt)],
    });

    expect(invoices3).toHaveLength(3);
    // the removal of user3 is still INSIDE the billing cycle after backdating so we have 7 seats
    expect(invoices3[2].totalAmountCents).toBe(7000); // 7 seats × $10 = $70
  }, 30000);

  it("should handle seat-based yearly pricing correctly", async () => {
    // Create seat-based plan with yearly pricing
    const seatPlan = await createSeatBasedPlan(1000, 800); // $10/month, $8 * 12 = $96/year per seat
    planId = seatPlan.plan.id;

    // Create subscription with yearly price using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.yearlyPrice!.id,
      planId,
      subDays(testStartTime, 15)
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    const eventTimestamp = subDays(testStartTime, 15);

    // Add 3 seats
    await addSeats(["user1", "user2", "user3"], eventTimestamp);

    await sleep(1000, { alsoSleepInStripeMock: true });

    // Verify seat count
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(4);

    // Trigger billing cycle
    const billingResult = await advanceBillingAndProcess(1, 365);
    expect(billingResult.subscriptionsProcessed).toBe(1);

    // Check invoice - should bill for yearly amount per seat
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
    });

    expect(invoice).toBeDefined();
    invoice!.lineItems = invoice!.lineItems.filter(
      (item) => item.type !== "tax"
    );

    expect(invoice!.totalAmountCents).toBe(38400); // 4 seats × $8 * 12 yearly = $384
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(4);
    expect(invoice!.lineItems[0].unitAmountCents).toBe(9600); // $8 * 12 = $96 per seat per year
  }, 50000);

  it("should handle seat-based plan with usage component and usage credits across cycles", async () => {
    // Create seat-based plan WITH usage features and credits all in one API call
    const apiCallsEventName = `api_usage_${Date.now()}`;
    const seatPlan = await createSeatBasedPlan(1000, undefined, {
      currency: "USD",
      minSeats: 0,
      billImmediately: false,
      features: [
        {
          featureName: "API Calls",
          slug: `api-calls-${Date.now()}`,
          eventName: apiCallsEventName, // Event name for tracking usage
          isUsageBased: true,
          usagePricePerUnit: 5, // $0.05 per call overage
          hasCreditAllowance: true,
          creditAllowanceAmount: 100, // 100 free calls per seat per month
          creditAllowanceRenewal: "monthly",
        },
      ],
    });

    planId = seatPlan.plan.id;

    // Get the created prices (the API creates everything for us)
    const pricesResponse = await apiClient.prices.$get({
      query: { planId: seatPlan.plan.id },
    });
    const pricesData = await pricesResponse.json();
    if ("error" in pricesData) {
      throw new Error(pricesData.error);
    }

    // Find the monthly price (should have both seat per_unit and usage components)
    const monthlyPrice = pricesData.prices.find((p) =>
      p.pricingData.components.some((c) =>
        c.recurrence_rule?.includes("MONTHLY")
      )
    );

    if (!monthlyPrice) {
      throw new Error("Monthly price not found");
    }

    // Verify price has both seat and usage components with expected pricing
    const seatComponent = monthlyPrice.pricingData.components.find(
      (c: any) => c.type === "per_unit"
    ) as any;
    const usageComponent = monthlyPrice.pricingData.components.find(
      (c: any) => c.type === "usage"
    ) as any;
    expect(seatComponent).toBeDefined();
    expect(usageComponent).toBeDefined();
    expect(seatComponent!.amount_cents).toBe(1000); // $10 per seat
    expect(usageComponent!.unit_cost_cents).toBe(5); // $0.05 per call

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      monthlyPrice.id,
      planId,
      subDays(testStartTime, 20)
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    await sleep(1000, { alsoSleepInStripeMock: true });

    // Check seats current count
    const seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 10)
    );
    expect(seatCount).toBe(1); // Primary customer

    // Assert: primary customer has organization created and role=primary
    const primaryOrgResult = await db
      .select({
        customerOrganizationId: customers.customerOrganizationId,
        orgRole: customers.orgRole,
      })
      .from(customers)
      .where(eq(customers.id, customerId));

    expect(primaryOrgResult.length).toBe(1);
    const primaryOrgId = primaryOrgResult[0].customerOrganizationId;
    const primaryOrgRole = primaryOrgResult[0].orgRole;
    expect(primaryOrgId).toBeTruthy();
    expect(primaryOrgRole).toBe("primary");

    // Assert: customer_organizations row exists
    const orgExists = await db
      .select({ id: customerOrganizations.id })
      .from(customerOrganizations)
      .where(eq(customerOrganizations.id, primaryOrgId!));
    expect(orgExists.length).toBe(1);

    // Add 2 seats – should create seat customers and grant initial usage credits to each seat
    await addSeats(["u1", "u2"], subDays(testStartTime, 10));

    // Wait for seats to be processed
    await sleep(1000, { alsoSleepInStripeMock: true });

    // Find seat customers by external ID
    const allCustomers = await db
      .select()
      .from(customers)
      .where(
        and(eq(customers.merchantId, merchantId), isNull(customers.deletedAt))
      );

    const seatMembers = allCustomers.filter((c) =>
      ["u1", "u2"].includes(c.externalCustomerId || "")
    );
    expect(seatMembers.length).toBe(2);

    // Assert: both seats are attached to same organization and have role=member
    const seat1Meta = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.externalCustomerId, "u1"),
        isNull(customers.deletedAt)
      ),
      columns: {
        id: true,
        customerOrganizationId: true,
        orgRole: true,
        externalCustomerId: true,
      },
    });
    const seat2Meta = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.externalCustomerId, "u2"),
        isNull(customers.deletedAt)
      ),
      columns: {
        id: true,
        customerOrganizationId: true,
        orgRole: true,
        externalCustomerId: true,
      },
    });

    expect(seat1Meta).toBeDefined();
    expect(seat2Meta).toBeDefined();
    expect(seat1Meta!.customerOrganizationId).toBe(primaryOrgId);
    expect(seat2Meta!.customerOrganizationId).toBe(primaryOrgId);
    expect(seat1Meta!.orgRole).toBe("member");
    expect(seat2Meta!.orgRole).toBe("member");

    // Assert: org has exactly 3 active customers (1 primary + 2 seats)
    const orgCustomers = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(customers)
      .where(
        and(
          eq(customers.merchantId, merchantId),
          eq(customers.customerOrganizationId, primaryOrgId!),
          isNull(customers.deletedAt)
        )
      );
    const orgCustomerCount = orgCustomers[0]?.count ?? 0;
    expect(orgCustomerCount).toBe(3);

    // Verify grants exist for seat customers (exactly one grant with 100/100 and ACTIVE)
    for (const seat of seatMembers) {
      const grants = await db.query.creditGrants.findMany({
        where: and(
          eq(creditGrants.merchantId, merchantId),
          eq(creditGrants.customerId, seat.id),
          eq(creditGrants.priceId, monthlyPrice.id),
          eq(creditGrants.applicationType, "usage"),
          isNull(creditGrants.deletedAt)
        ),
      });

      expect(grants.length).toBe(1);
      expect(grants[0].initialAmount).toBe(100);
      expect(grants[0].remainingAmount).toBe(100);
      expect(grants[0].status).toBe("ACTIVE");
    }

    // Verify subscription features copied to seats (should be exactly one feature per seat)
    for (const seat of seatMembers) {
      const seatFeatures = await db.query.subscriptionFeatures.findMany({
        where: and(
          eq(subscriptionFeatures.merchantId, merchantId),
          eq(subscriptionFeatures.customerId, seat.id),
          eq(subscriptionFeatures.subscriptionId, subscriptionId),
          isNull(subscriptionFeatures.deletedAt)
        ),
      });
      expect(seatFeatures.length).toBe(1);
    }

    // Create API keys for sending usage events
    const apiKeys = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    const apiKeyClient = createApiKeyClient(apiKeys.secretKey.rawKeyValue);

    // Find the usage metric that was created for the API calls feature
    const usageMetric = await db.query.metrics.findFirst({
      where: and(
        eq(metrics.merchantId, merchantId),
        eq(metrics.eventName, apiCallsEventName)
      ),
    });

    expect(usageMetric).toBeDefined();
    if (!usageMetric?.eventName) {
      throw new Error("Usage metric is missing eventName");
    }

    // Get the subscription billing details to ensure events are in the correct billing period
    const subDetails = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    expect(subDetails).toBeDefined();

    // Calculate a timestamp within the billing period
    const billingPeriodStart =
      subDetails!.previousBillingDate || subDetails!.subscriptionStartDate;
    const billingPeriodEnd = subDetails!.nextBillingDate;
    const eventTimestampInPeriod = subDays(testStartTime, 10);

    console.log(
      `Billing period: ${billingPeriodStart.toISOString()} to ${billingPeriodEnd.toISOString()}`
    );
    console.log(`Event timestamp: ${eventTimestampInPeriod.toISOString()}`);

    // Send real usage events for BOTH seats to test comprehensive billing
    const seat1 = seatMembers[0]; // Primary customer seat
    const seat2 = seatMembers[1]; // Second seat

    // Seat 1: Send 60 API calls (within 100 credit allowance, no overage)
    const seat1Event = {
      idempotencyKey: `api-call-seat1-${Date.now()}`,
      eventName: usageMetric.eventName,
      customerId: seat1.id,
      eventValue: 60, // Send all 60 calls in one event
      subscriptionId: subscriptionId,
      eventTimestamp: eventTimestampInPeriod.toISOString(),
    };
    const r1 = await apiKeyClient.events.$post({ json: seat1Event });
    expect(r1.status).toBe(202);

    // Seat 2: Send 120 API calls (exceeds 100 credit allowance, 20 overage)
    const seat2Event = {
      idempotencyKey: `api-call-seat2-${Date.now()}`,
      eventName: usageMetric.eventName,
      customerId: seat2.id,
      eventValue: 120, // Send all 120 calls in one event
      subscriptionId: subscriptionId,
      eventTimestamp: eventTimestampInPeriod.toISOString(),
    };
    const r2 = await apiKeyClient.events.$post({ json: seat2Event });
    expect(r2.status).toBe(202);

    // Wait for events to be processed
    await sleep(2000, { alsoSleepInStripeMock: true });

    // Trigger billing cycle
    const billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(2); // 2 components: per_unit (seats) + usage (API calls)

    // Wait for billing to process
    await sleep(3000);

    // After billing cycle, check for renewal
    const postBillingGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.merchantId, merchantId),
        eq(creditGrants.customerId, seat1.id),
        eq(creditGrants.priceId, monthlyPrice.id),
        eq(creditGrants.applicationType, "usage"),
        isNull(creditGrants.deletedAt)
      ),
      orderBy: (creditGrants, { desc }) => [desc(creditGrants.createdAt)],
    });

    // Should have grants (original + renewed or just renewed)
    expect(postBillingGrants.length).toBeGreaterThan(0);

    // Calculate total available credits for seat1
    let totalAvailable = 0;
    for (const grant of postBillingGrants) {
      // Only count non-expired active grants
      if (grant.status === "ACTIVE") {
        totalAvailable += grant.remainingAmount ?? 0;
      }
    }

    // Should have renewed credits available after billing cycle
    // Seat1 used 60/100 credits, so should get renewed to 100 again
    expect(totalAvailable).toBeGreaterThanOrEqual(100);

    // Verify invoice was created with comprehensive line items (like the example invoice)
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      with: {
        lineItems: true,
      },
    });

    expect(invoice).toBeDefined();
    expect(invoice!.lineItems.length).toBeGreaterThan(0);

    // Filter out tax line items for cleaner analysis
    const nonTaxLineItems = invoice!.lineItems.filter(
      (item) => item.type !== "tax"
    );

    console.log(nonTaxLineItems);

    // PRECISE TEST: Expected line items structure based on actual billing behavior
    // 1. Exactly 1 seat line item (3 seats × $10.00)
    // 2. Exactly 2 usage line items (u1: 60 calls, u2: 120 calls)
    // 3. Exactly 2 credit line items (u1: 60 credits consumed, u2: 100 credits consumed)

    // 1. SEAT CHARGES - Should have exactly 1 per_unit line item
    const seatLineItems = nonTaxLineItems.filter(
      (item) => item.type === "per_unit"
    );
    expect(seatLineItems).toHaveLength(1);

    // Should bill for exactly 3 total seats (1 primary + 2 added seats)
    const seatLineItem = seatLineItems[0];
    expect(seatLineItem.quantity).toBe(3);
    expect(seatLineItem.unitAmountCents).toBe(1000); // $10.00 per seat
    expect(seatLineItem.subtotalCents).toBe(3000); // 3 × $10.00
    expect(seatLineItem.description).toContain("per month per seat");

    // 2. USAGE CHARGES - Should have exactly 2 usage line items (one per seat with usage)
    const usageLineItems = nonTaxLineItems.filter(
      (item) => item.type === "usage"
    );
    expect(usageLineItems).toHaveLength(2);

    // Sort by quantity to get consistent ordering (u1=60, u2=120)
    usageLineItems.sort((a, b) => (a.quantity || 0) - (b.quantity || 0));

    // u1 usage: 60 calls at $0.05 each = $3.00
    const u1UsageItem = usageLineItems[0];
    expect(u1UsageItem.quantity).toBe(60);
    expect(u1UsageItem.unitAmountCents).toBe(5); // $0.05 per call
    expect(u1UsageItem.subtotalCents).toBe(300); // 60 × $0.05
    expect(u1UsageItem.description).toContain("API Calls usage (u1)");

    // u2 usage: 120 calls at $0.05 each = $6.00
    const u2UsageItem = usageLineItems[1];
    expect(u2UsageItem.quantity).toBe(120);
    expect(u2UsageItem.unitAmountCents).toBe(5); // $0.05 per call
    expect(u2UsageItem.subtotalCents).toBe(600); // 120 × $0.05
    expect(u2UsageItem.description).toContain("API Calls usage (u2)");

    // 3. CREDIT DEDUCTIONS - Should have exactly 2 credit line items (one per seat)
    const creditLineItems = nonTaxLineItems.filter(
      (item) => item.type === "credit"
    );
    expect(creditLineItems).toHaveLength(2);

    // Sort by quantity to get consistent ordering (u1=60 credits, u2=100 credits)
    creditLineItems.sort((a, b) => (a.quantity || 0) - (b.quantity || 0));

    // u1 credit deduction: 60 credits consumed × -$0.05 = -$3.00
    const u1CreditItem = creditLineItems[0];
    expect(u1CreditItem.quantity).toBe(60);
    expect(u1CreditItem.unitAmountCents).toBe(-5); // -$0.05 per credit
    expect(u1CreditItem.subtotalCents).toBe(-300); // 60 × -$0.05
    expect(u1CreditItem.description).toContain(
      "Credits (60 units × $0.05) (u1)"
    );

    // u2 credit deduction: 100 credits consumed × -$0.05 = -$5.00 (maxed out allowance)
    const u2CreditItem = creditLineItems[1];
    expect(u2CreditItem.quantity).toBe(100);
    expect(u2CreditItem.unitAmountCents).toBe(-5); // -$0.05 per credit
    expect(u2CreditItem.subtotalCents).toBe(-500); // 100 × -$0.05
    expect(u2CreditItem.description).toContain(
      "Credits (100 units × $0.05) (u2)"
    );

    // 4. INVOICE TOTAL CALCULATION
    // Expected: (3 seats × $10) + (60+120 usage × $0.05) - (60+100 credits × $0.05) = $30 + $9 - $8 = $31
    expect(invoice!.totalAmountCents).toBe(3100); // $31.00

    console.log("Precise invoice breakdown:");
    console.log(`- Seat charges: 1 line item, 3 seats, $30.00`);
    console.log(
      `- Usage charges: 2 line items, u1=60 calls ($3.00) + u2=120 calls ($6.00) = $9.00`
    );
    console.log(
      `- Credit deductions: 2 line items, u1=60 credits (-$3.00) + u2=100 credits (-$5.00) = -$8.00`
    );
    console.log(`- Final total: $${invoice!.totalAmountCents / 100}`);

    // 5. VERIFY TOTAL LINE ITEMS
    expect(nonTaxLineItems).toHaveLength(5); // 1 seat + 2 usage + 2 credits
  }, 60000);

  it("should revoke seat credits immediately on seat removal", async () => {
    // Create seat-based plan WITH usage features and credits
    const seatPlan = await createSeatBasedPlan(1000, undefined, {
      currency: "USD",
      minSeats: 0,
      billImmediately: false,
      features: [
        {
          featureName: "API Calls",
          slug: `api-calls-revoke-${Date.now()}`,
          eventName: `api_usage_revoke_${Date.now()}`,
          isUsageBased: true,
          usagePricePerUnit: 5,
          hasCreditAllowance: true,
          creditAllowanceAmount: 100,
          creditAllowanceRenewal: "monthly",
        },
      ],
    });

    planId = seatPlan.plan.id;

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}-revoke@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    // Add 1 seat
    await addSeats(["revoke_user_1"], subDays(testStartTime, 10));

    await sleep(2000, { alsoSleepInStripeMock: true });

    // Find the seat customer by external ID
    const seatCustomer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.externalCustomerId, "revoke_user_1"),
        isNull(customers.deletedAt)
      ),
    });
    expect(seatCustomer).toBeDefined();

    // Verify initial grant exists and is ACTIVE with full remaining
    const initialGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.merchantId, merchantId),
        eq(creditGrants.customerId, seatCustomer!.id),
        eq(creditGrants.applicationType, "usage"),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(initialGrants.length).toBe(1);
    expect(initialGrants[0].status).toBe("ACTIVE");
    const prevRemaining = initialGrants[0].remainingAmount;
    expect(prevRemaining).toBeGreaterThanOrEqual(100);

    // Remove the seat
    const removeResult = await removeSeats(
      ["revoke_user_1"],
      addMinutes(testStartTime, 1)
    );
    expect(removeResult.length).toBe(1);
    if (!("error" in removeResult[0])) {
      expect(removeResult[0].message).toBe("Seat removed successfully");
    }

    // Verify grants are revoked immediately
    const afterRemovalGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.merchantId, merchantId),
        eq(creditGrants.customerId, seatCustomer!.id),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(afterRemovalGrants.length).toBeGreaterThan(0);
    for (const g of afterRemovalGrants) {
      expect(["REVOKED", "EXPIRED", "DEPLETED", "ACTIVE"]).toContain(g.status);
    }

    // At least the previously ACTIVE grant should now be REVOKED with 0 remaining
    const revoked = afterRemovalGrants.find((g) => g.status === "REVOKED");
    expect(revoked).toBeDefined();
    expect(revoked!.remainingAmount).toBe(0);

    // Verify there is a revoke transaction for that grant
    const revokeTx = await db.query.creditUsageTransactions.findMany({
      where: and(
        eq(creditUsageTransactions.merchantId, merchantId),
        eq(creditUsageTransactions.customerId, seatCustomer!.id),
        eq(creditUsageTransactions.creditGrantId, revoked!.id),
        eq(creditUsageTransactions.eventName, "revoked")
      ),
    });
    expect(revokeTx.length).toBe(1);

    // Verify entitlements are soft-deleted for the seat on this subscription
    const entitlements = await db.query.subscriptionFeatures.findMany({
      where: and(
        eq(subscriptionFeatures.merchantId, merchantId),
        eq(subscriptionFeatures.customerId, seatCustomer!.id),
        eq(subscriptionFeatures.subscriptionId, subscriptionId)
      ),
    });
    // If any entitlements existed, they should be soft-deleted now
    for (const sf of entitlements) {
      expect(sf.deletedAt).not.toBeNull();
    }
  }, 20000);

  it("should handle zero added seats correctly", async () => {
    // Create seat-based plan
    const seatPlan = await createSeatBasedPlan(1000); // $10 per seat per month
    planId = seatPlan.plan.id;

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId,
      subDays(testStartTime, 20) // No backdating needed, primary seat event should be in billing window
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    // Don't add any seats - should have 1 seat (the primary customer)
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(1);

    // Trigger billing cycle
    const billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    // Check invoice - should bill for 1 seats
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
    });

    expect(invoice).toBeDefined();
    invoice!.lineItems = invoice!.lineItems.filter(
      (item) => item.type !== "tax"
    );

    expect(invoice!.totalAmountCents).toBe(1000); // 1 seats × $10 = $10
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(1);
  }, 20000);

  it("should handle seat churning (rapid add/remove) correctly", async () => {
    // Create seat-based plan
    const seatPlan = await createSeatBasedPlan(1000); // $10 per seat per month
    planId = seatPlan.plan.id;

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId,
      subDays(testStartTime, 45) // Primary seat event needs to be at the earliest event timestamp
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    const eventTimestamp_2mo_ago = subDays(testStartTime, 45);
    const eventTimestamp_1mo_ago = subDays(testStartTime, 15);

    // Add 5 seats
    await addSeats(
      ["user1", "user2", "user3", "user4", "user5"],
      eventTimestamp_2mo_ago
    );

    // Remove 3 seats
    await removeSeats(
      ["user2", "user3", "user4"],
      addMinutes(eventTimestamp_2mo_ago, 1)
    );

    // Add 2 different seats
    await addSeats(["user6", "user7"], addMinutes(eventTimestamp_1mo_ago, 2));

    // Remove 1 seat
    await removeSeats(["user1"], addMinutes(eventTimestamp_1mo_ago, 3));

    await sleep(1000, { alsoSleepInStripeMock: true });

    // Current active seats should be 3 (primary, user5, user6, user7)
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(4);

    // Trigger billing cycle in
    const billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    // We backdate by a month. So, all the additions 2mo ago and 1mo are in (5 + 2)
    // minus the removals 2mo ago (3) = 5 + 2 - 3 = 4 seats. plus primary is 5
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
    });

    expect(invoice).toBeDefined();
    invoice!.lineItems = invoice!.lineItems.filter(
      (item) => item.type !== "tax"
    );

    expect(invoice!.totalAmountCents).toBe(5000); // 5 seats × $10 = $50
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(5);
  }, 20000);

  it("should handle proration correctly for mid-cycle changes", async () => {
    // Create seat-based plan
    const seatPlan = await createSeatBasedPlan(3000); // $30 per seat per month
    planId = seatPlan.plan.id;

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId,
      subDays(testStartTime, 20)
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    const eventTimestamp = subDays(testStartTime, 15);

    // Add 2 seats at the beginning
    await addSeats(["user1", "user2"], eventTimestamp);

    // Wait a bit to simulate mid-cycle
    await sleep(1000, { alsoSleepInStripeMock: true });

    // Add 1 more seat mid-cycle
    await addSeats(["user3"], addMinutes(eventTimestamp, 1));

    await sleep(1000, { alsoSleepInStripeMock: true });

    // Current active seats should be 3
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      subDays(testStartTime, 15),
      addDays(testStartTime, 15)
    );
    expect(seatCount).toBe(4);

    // Trigger billing cycle
    const billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    // Check invoice - should bill for all 3 seats for the full period
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
    });

    expect(invoice).toBeDefined();
    invoice!.lineItems = invoice!.lineItems.filter(
      (item) => item.type !== "tax"
    );

    expect(invoice!.totalAmountCents).toBe(12000); // 4 seats × $30 = $120
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(4);
  }, 20000);

  it("should create USD plan with min seats and bill additional seat immediately", async () => {
    // Step 1: create seat-based plan in USD with min 3 users
    const seatPlan = await createSeatBasedPlan(1000 /* €10 */, undefined, {
      currency: "USD",
      minSeats: 3,
      billImmediately: true,
    });

    planId = seatPlan.plan.id;

    // Step 2: subscribe customer – invoice should be €30 (3 × 10)
    const customerEmail = `${externalCustomerId}@example.eu`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId,
      testStartTime // No backdating needed, this test doesn't use backdated events
    );

    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    // Verify only one invoice exists and amount is 3000 cents
    let invoicesInitial = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
    });
    expect(invoicesInitial).toHaveLength(1);
    expect(invoicesInitial[0].totalAmountCents).toBe(3000);

    // Step 3: add 2 users (within min seats) – no immediate payment expected
    await addSeats(["u1", "u2"]);
    await sleep(1000, { alsoSleepInStripeMock: true });

    // Verify still only one invoice
    invoicesInitial = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
    });
    expect(invoicesInitial).toHaveLength(1);

    // Step 4: add a 3rd user – should trigger immediate overage billing and charge
    await addSeats(["u3"]);

    // Add a 4th user with a later timestamp to test proration
    const prorationTimestamp = addDays(testStartTime, 10);
    await addSeats(["u4"], prorationTimestamp);

    // wait for async billing task collection
    await sleep(5000);

    const customerInvoices = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
    });

    const invoiceIds = customerInvoices.map((inv) => inv.id);
    expect(invoiceIds).toHaveLength(3);

    // filter out the initial invoice
    const overageInvoices = customerInvoices.filter(
      (inv) => inv.id !== invoicesInitial[0].id
    );
    expect(overageInvoices).toHaveLength(2);
    // sort by amount
    overageInvoices.sort((a, b) => a.totalAmountCents - b.totalAmountCents);

    // Calculate expected prorated amount for the second overage invoice
    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetail) throw new Error("Subscription detail not found");
    const expectedProratedAmount = prorateAmountCents(
      1000,
      subDetail.subscriptionStartDate,
      subDetail.nextBillingDate,
      prorationTimestamp
    );

    // First overage invoice should be for a full seat
    expect(overageInvoices[1].totalAmountCents).toBe(1000);
    expect(overageInvoices[1].status).toBe("paid"); // Should be immediately charged

    // Second overage invoice should be prorated
    expect(overageInvoices[0].totalAmountCents).toBe(expectedProratedAmount);
    expect(overageInvoices[0].status).toBe("paid"); // Should be immediately charged

    // Get line items for the overage invoice
    const overageLineItems = await db.query.invoiceLineItems.findMany({
      where: and(
        eq(invoiceLineItems.invoiceId, overageInvoices[1].id),
        ne(invoiceLineItems.type, "tax")
      ),
    });
    expect(overageLineItems).toHaveLength(1);
    expect(overageLineItems[0].unitAmountCents).toBe(1000);

    const proratedOverageLineItems = await db.query.invoiceLineItems.findMany({
      where: and(
        eq(invoiceLineItems.invoiceId, overageInvoices[0].id),
        ne(invoiceLineItems.type, "tax")
      ),
    });
    expect(proratedOverageLineItems).toHaveLength(1);
    expect(proratedOverageLineItems[0].unitAmountCents).toBe(
      expectedProratedAmount
    );

    const paymentsForCustomer = await db.query.payments.findMany({
      where: inArray(payments.invoiceId, invoiceIds),
      orderBy: (payments, { asc }) => [asc(payments.createdAt)],
    });

    expect(paymentsForCustomer.length).toBe(3);

    // Check that the first payment is for the initial invoice
    expect(paymentsForCustomer[0].invoiceId).toBe(invoicesInitial[0].id);
    expect(paymentsForCustomer[0].amountCents).toBe(3000);

    // Check that the second payment corresponds to the overage invoice and amount
    const overagePayment = paymentsForCustomer.find(
      (p) => p.invoiceId === overageInvoices[1].id
    );
    expect(overagePayment).toBeDefined();
    expect(overagePayment!.amountCents).toBe(1000);

    // Check that the third payment corresponds to the prorated overage invoice and amount
    const proratedOveragePayment = paymentsForCustomer.find(
      (p) => p.invoiceId === overageInvoices[0].id
    );
    expect(proratedOveragePayment).toBeDefined();
    expect(proratedOveragePayment!.amountCents).toBe(expectedProratedAmount);
  }, 20000);

  it("should edit a seat-based plan in-place for metadata-only changes when subscribers exist", async () => {
    // 1. Create a seat-based plan.
    const { plan: originalPlan, monthlyPrice } = await createSeatBasedPlan(
      1500,
      undefined,
      { minSeats: 1, billImmediately: false }
    );
    const originalPlanId = originalPlan.id;
    const originalStablePlanId = originalPlan.stablePlanId;

    expect(monthlyPrice).toBeDefined();

    // 2. Create a subscription for this plan, so it has an active subscriber.
    const customerEmail = `${externalCustomerId}-metadata-edit@example.com`;
    await createSubscription(
      customerEmail,
      monthlyPrice!.id,
      originalPlanId,
      testStartTime
    );

    // 3. Construct the edit payload with only the name changed.
    const newPlanName = "Updated Seat Plan Name";
    const newDescription = "Updated description for seat plan metadata test";

    const editPayload = {
      planName: newPlanName,
      planDescription: newDescription,
      currency: "USD",
      monthlyPrice: 1500,
      yearlyPrice: 0,
      hasYearlyPrice: false,
      isSeatBased: true,
      minSeats: 1,
      billImmediately: false,
      isEnterprisePlan: false,
      showInPricingTable: false, // toggle visibility metadata
      features: [], // The created plan has no features.
    };

    // 4. Perform a metadata-only edit.
    const editResponse = await apiClient.plans[":id"].edit.$post({
      param: { id: originalPlanId },
      json: editPayload,
    });

    const editResult = await editResponse.json();

    expect(editResponse.status).toBe(200);
    if ("error" in editResult) {
      throw new Error(`Edit failed: ${editResult.error}`);
    }

    // 5. Assert that the edit was performed in-place (no new version).
    expect(editResult.changeAnalysis.isNewVersion).toBe(false);
    expect(editResult.plan.id).toBe(originalPlanId);
    expect(editResult.plan.planName).toBe(newPlanName);
    expect(editResult.plan.stablePlanId).toBe(originalStablePlanId);
    expect(editResult.plan.versionNumber).toBe(1);

    // 6. Verify the state in the database.
    const plansInDb = await db
      .select()
      .from(plans)
      .where(eq(plans.stablePlanId, originalStablePlanId));

    // There should still be only one plan record.
    expect(plansInDb).toHaveLength(1);

    const updatedPlanInDb = plansInDb[0];
    expect(updatedPlanInDb.id).toBe(originalPlanId);
    expect(updatedPlanInDb.planName).toBe(newPlanName);
    expect(updatedPlanInDb.planDescription).toBe(newDescription);
  }, 20000);

  it("should automatically count primary customer as first seat when subscribing to seat-based plan", async () => {
    // Create a simple seat-based plan
    const seatPlan = await createSeatBasedPlan(2000); // $20/month per seat

    const planId = seatPlan.plan.id;
    const monthlyPrice = seatPlan.monthlyPrice;

    if (!monthlyPrice) {
      throw new Error("Monthly price not found for seat-based plan");
    }

    // Create subscription for primary customer
    const customerEmail = `primary-${Date.now()}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      monthlyPrice.id,
      planId,
      testStartTime
    );

    const primaryCustomerId = subResult.customer.id;
    const primaryExternalId = subResult.customer.externalCustomerId!;

    // Wait a moment for events to process
    await sleep(2000);

    // Check that the primary customer has a seat_added event
    const seatEvents = await questDbService.queryMetrics({
      merchantId,
      metricType: "complex",
      timeframe: { type: "ALL" },
      rawSql: `
        SELECT event_name, event_string, customer_id, event_timestamp
        FROM events
        WHERE merchant_id = $1
          AND customer_id = $2
          AND event_name = 'seat_added'
          AND event_string = $3
        ORDER BY event_timestamp DESC
      `,
      rawValues: [merchantId, primaryCustomerId, primaryExternalId],
    });

    expect(seatEvents.error).toBeFalsy();
    expect(seatEvents.rows?.length).toBe(1);

    const seatEvent = seatEvents.rows![0];
    expect(seatEvent.event_name).toBe("seat_added");
    expect(seatEvent.event_string).toBe(primaryExternalId);
    expect(seatEvent.customer_id).toBe(primaryCustomerId);

    // Verify organization setup
    const primaryCustomer = await db.query.customers.findFirst({
      where: eq(customers.id, primaryCustomerId),
    });

    expect(primaryCustomer?.customerOrganizationId).toBeTruthy();
    expect(primaryCustomer?.orgRole).toBe("primary");

    console.info(
      `Test completed: Primary customer ${primaryExternalId} automatically counted as first seat in plan ${planId}`
    );
  }, 20000);
});
