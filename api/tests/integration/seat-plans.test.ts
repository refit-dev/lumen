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
} from "../test-helpers";
import {
  invoices,
  invoiceLineItems,
  subscriptionDetails,
  subscriptions,
  customers,
  plans,
  prices,
  payments,
  metrics,
  events,
  subscriptionsScheduledChanges,
  subscriptionFeatures,
  paymentMethods,
  creditUsageTransactions,
  creditGrants,
  creditDefinitions,
  planFeatures,
  features,
  featureMetrics,
  pricingTablePlans,
  pricingTables,
  user,
  organization,
  billingTasks,
} from "@lumen/common/schema";
import { env } from "../../src/env";
import { setTimeout as sleep } from "timers/promises";
import questDbService from "../../src/db/questDbService";
import { z } from "zod";
import { collectPaymentJob } from "../../trigger/jobs/collectPayment";
import { collectPaymentPayloadSchema } from "../../trigger/helpers/collectPayment";
import { prorateAmountCents } from "../../src/helpers/proration";

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
      // First batch: Clean up payment and invoice records
      await db.execute(sql`
        DELETE FROM ${payments};
        DELETE FROM ${invoiceLineItems};
        DELETE FROM ${invoices};
      `);

      // Second batch: Clean up subscription-related records (in proper order)
      await db.execute(sql`
        DELETE FROM ${subscriptionsScheduledChanges};
        DELETE FROM ${subscriptionFeatures};
        DELETE FROM ${subscriptionDetails};
        DELETE FROM ${billingTasks};
        DELETE FROM ${subscriptions};
        DELETE FROM ${paymentMethods};
      `);

      // Third batch: Clean up credit records
      await db.execute(sql`
        DELETE FROM ${creditUsageTransactions};
        DELETE FROM ${creditGrants};
        DELETE FROM ${creditDefinitions};
      `);

      // Fourth batch: Clean up metrics and events
      await db.execute(sql`
        DELETE FROM ${metrics};
        DELETE FROM ${events};
      `);

      // Fifth batch: Clean up plan and feature records
      await db.execute(sql`
        DELETE FROM ${prices};
        DELETE FROM ${planFeatures};
        DELETE FROM ${features};
        DELETE FROM ${featureMetrics};
        DELETE FROM ${pricingTablePlans};
        DELETE FROM ${pricingTables};
        DELETE FROM ${plans};
        DELETE FROM ${customers};
        DELETE FROM ${user};
        DELETE FROM ${organization};
      `);
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
        newFeatures: [],
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
  const addSeats = async (userIds: string[], eventTimestamp?: Date) => {
    const results: (
      | {
          message: string;
          user_id: string;
          created_user_id: string;
          subscription_id: string;
          idempotency_key: string;
        }
      | { error: string }
    )[] = [];
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
    const results: (
      | {
          message: string;
          user_id: string;
          removed_user_id: string;
          subscription_id: string;
          idempotency_key: string;
        }
      | { error: string }
    )[] = [];
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
    planId: string
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
      planId
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

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    const eventTimestamp = subDays(testStartTime, 15);

    // Add 5 seats
    await addSeats(
      ["user1", "user2", "user3", "user4", "user5"],
      eventTimestamp
    );

    // Wait a bit to make sure the seat count is updated
    await sleep(1000);

    // Verify seat count
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(5);

    // Remove 2 seats
    await removeSeats(["user2", "user4"], addMinutes(eventTimestamp, 1));

    await sleep(1000);
    seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime, // new cycle started
      addDays(testStartTime, 30) // 30 days later
    );
    expect(seatCount).toBe(3);

    // Trigger billing cycle
    const billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    await sleep(3000);

    // Check invoice - should bill for ALL 5 seats (removals take effect next month)
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

    expect(invoice!.totalAmountCents).toBe(5000); // 5 seats × $10 = $50
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(5);
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
      planId
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    // === MONTH 1 ===
    const eventTimestamp1 = subDays(testStartTime, 45); // Events for first billing cycle
    // Add 3 seats
    await addSeats(["user1", "user2", "user3"], eventTimestamp1);

    // Remove 1 seat
    await removeSeats(["user2"], addMinutes(eventTimestamp1, 1));

    await sleep(1000);

    // Current active seats: 2, but billing should be for 3 (all additions)
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(2);

    // Trigger first billing cycle
    let billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    await sleep(3000);

    // Check first invoice - should bill for 3 seats (all additions, removals take effect next month)
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
    // 2 seats × $10 = $20, no tax or credits (seat removed in the billing cycle BEFORE the start of the backdated billing cycle)
    expect(invoice1[0].totalAmountCents).toBe(2000);

    // === MONTH 2 ===
    const eventTimestamp2 = subDays(testStartTime, 15); // Events for second billing cycle
    // Add 2 more seats
    await addSeats(["user4", "user5"], eventTimestamp2);

    // Remove 1 more seat
    await removeSeats(["user3"], addMinutes(eventTimestamp2, 1));

    await sleep(1000);

    // Current active seats should be 3 (user1, user4, user5)
    seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(3);

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
    // the removal of user3 now falls INSIDE the billing cycle after backdating so we have 4 seats
    expect(invoices2[1].totalAmountCents).toBe(4000); // 4 seats × $10 = $40

    // === MONTH 3 ===
    const eventTimestamp3 = subDays(testStartTime, 5); // Events for third billing cycle
    // Only add seats, no removals
    await addSeats(["user6", "user7"], eventTimestamp3);

    await sleep(1000);

    // Current active seats should be 5 (user1, user4, user5, user6, user7)
    seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      subDays(testStartTime, 5),
      addDays(testStartTime, 25)
    );
    expect(seatCount).toBe(5);

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
    // the removal of user3 is still INSIDE the billing cycle after backdating so users 1, 3, 4, 5, 6 and 7
    expect(invoices3[2].totalAmountCents).toBe(6000); // 5 seats × $10 = $50
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
      planId
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    const eventTimestamp = subDays(testStartTime, 15);

    // Add 3 seats
    await addSeats(["user1", "user2", "user3"], eventTimestamp);

    await sleep(1000);

    // Verify seat count
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(3);

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

    expect(invoice!.totalAmountCents).toBe(28800); // 3 seats × $8 * 12 yearly = $288
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(3);
    expect(invoice!.lineItems[0].unitAmountCents).toBe(9600); // $8 * 12 = $96 per seat per year
  }, 20000);

  it("should handle zero seats correctly", async () => {
    // Create seat-based plan
    const seatPlan = await createSeatBasedPlan(1000); // $10 per seat per month
    planId = seatPlan.plan.id;

    // Create subscription using proper payment flow
    const customerEmail = `${externalCustomerId}@example.com`;
    const subResult = await createSubscription(
      customerEmail,
      seatPlan.monthlyPrice!.id,
      planId
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    // Don't add any seats - should have 0 seats
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(0);

    // Trigger billing cycle
    const billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    // Check invoice - should bill for 0 seats
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
    });

    expect(invoice).toBeDefined();
    invoice!.lineItems = invoice!.lineItems.filter(
      (item) => item.type !== "tax"
    );

    expect(invoice!.totalAmountCents).toBe(0); // 0 seats × $10 = $0
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(0);
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
      planId
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

    await sleep(1000);

    // Current active seats should be 3 (user5, user6, user7)
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      testStartTime,
      addDays(testStartTime, 30)
    );
    expect(seatCount).toBe(3);

    // Trigger billing cycle in
    const billingResult = await advanceBillingAndProcess();
    expect(billingResult.subscriptionsProcessed).toBe(1);

    // We backdate by a month. So, all the additions 2mo ago and 1mo are in (5 + 2)
    // minus the removals 2mo ago (3) = 5 + 2 - 3 = 4 seats
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      with: { lineItems: true },
    });

    expect(invoice).toBeDefined();
    invoice!.lineItems = invoice!.lineItems.filter(
      (item) => item.type !== "tax"
    );

    expect(invoice!.totalAmountCents).toBe(4000); // 4 seats × $10 = $40
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(4);
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
      planId
    );
    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    const eventTimestamp = subDays(testStartTime, 15);

    // Add 2 seats at the beginning
    await addSeats(["user1", "user2"], eventTimestamp);

    // Wait a bit to simulate mid-cycle
    await sleep(1000);

    // Add 1 more seat mid-cycle
    await addSeats(["user3"], addMinutes(eventTimestamp, 1));

    await sleep(1000);

    // Current active seats should be 3
    let seatCount = await getCurrentSeatCount(
      customerId,
      subscriptionId,
      seatPlan.seatMetric!.id,
      subDays(testStartTime, 15),
      addDays(testStartTime, 15)
    );
    expect(seatCount).toBe(3);

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

    expect(invoice!.totalAmountCents).toBe(9000); // 3 seats × $30 = $90
    expect(invoice!.lineItems).toHaveLength(1);
    expect(invoice!.lineItems[0].quantity).toBe(3);
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
      planId
    );

    subscriptionId = subResult.subscription.id;
    customerId = subResult.customer.id;

    // Verify only one invoice exists and amount is 3000 cents
    let invoicesInitial = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
    });
    expect(invoicesInitial).toHaveLength(1);
    expect(invoicesInitial[0].totalAmountCents).toBe(3000);

    // Step 3: add 3 users (within min seats) – no immediate payment expected
    await addSeats(["u1", "u2", "u3"]);
    await sleep(1000);

    // Verify still only one invoice
    invoicesInitial = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
    });
    expect(invoicesInitial).toHaveLength(1);

    // Step 4: add a 4th user – should trigger immediate overage billing and charge
    // Add a 4th user with a later timestamp to test proration
    const prorationTimestamp = addDays(testStartTime, 10);
    await addSeats(["u4"], prorationTimestamp);

    // wait for async billing task collection
    await sleep(5000);

    const customerInvoices = await db.query.invoices.findMany({
      where: eq(invoices.customerId, customerId),
    });

    const invoiceIds = customerInvoices.map((inv) => inv.id);
    expect(invoiceIds).toHaveLength(2);

    // filter out the initial invoice
    const overageInvoice = customerInvoices.filter(
      (inv) => inv.id !== invoicesInitial[0].id
    );
    expect(overageInvoice).toHaveLength(1);

    // Calculate expected prorated amount
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

    expect(overageInvoice[0].totalAmountCents).toBe(expectedProratedAmount);
    expect(overageInvoice[0].status).toBe("paid"); // Should be immediately charged

    // Get line items for the overage invoice
    const overageLineItems = await db.query.invoiceLineItems.findMany({
      where: and(
        eq(invoiceLineItems.invoiceId, overageInvoice[0].id),
        ne(invoiceLineItems.type, "tax")
      ),
    });
    expect(overageLineItems).toHaveLength(1);
    expect(overageLineItems[0].unitAmountCents).toBe(expectedProratedAmount);

    const paymentsForCustomer = await db.query.payments.findMany({
      where: inArray(payments.invoiceId, invoiceIds),
      orderBy: (payments, { asc }) => [asc(payments.createdAt)],
    });

    expect(paymentsForCustomer.length).toBe(2);

    // Check that the first payment is for the initial invoice
    expect(paymentsForCustomer[0].invoiceId).toBe(invoicesInitial[0].id);
    expect(paymentsForCustomer[0].amountCents).toBe(3000);

    // Check that the second payment corresponds to the overage invoice and amount
    const overagePayment = paymentsForCustomer.find(
      (p) => p.invoiceId === overageInvoice[0].id
    );
    expect(overagePayment).toBeDefined();
    expect(overagePayment!.amountCents).toBe(expectedProratedAmount);
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
    await createSubscription(customerEmail, monthlyPrice!.id, originalPlanId);

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
});
