import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  setDefaultTimeout,
  spyOn,
} from "bun:test";
import { addDays, addMinutes, subDays } from "date-fns";
import { db } from "../../src/db/client";
import { env } from "../../src/env";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import {
  invoices,
  subscriptionDetails,
  subscriptions,
  customers,
  paymentMethods,
  payments,
  invoiceLineItems,
  subscriptionsScheduledChanges,
  subscriptionFeatures,
  subscriptionPriceOverrides,
  paymentRetries,
  customerInvoiceCounters,
  planFeatures,
  pricingTablePlans,
  pricingTables,
  features,
  featureMetrics,
  plans,
  prices,
  organization,
  user,
  creditGrants,
  creditDefinitions,
  creditUsageTransactions,
  events,
  metrics,
  dunningConfigs,
  stripe as stripeSchema,
} from "@lumen/common/schema";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createTestApiKeys,
  createPaymentProvider,
  PaymentProviderAdapter,
  expectDateWithinMargin,
} from "../test-helpers";
import { processBillingCycle } from "../../trigger/helpers/billing";
import { z } from "zod";
import { collectPaymentJob } from "../../trigger/jobs/collectPayment";
import { collectPaymentPayloadSchema } from "../../trigger/helpers/collectPayment";
import {
  createTestCreditDefinition,
  createTestCreditGrant,
} from "../test-helpers/data/credits";
import { createTestPlanWithFeatures } from "../test-helpers/data/plan";
import { createTestPrice } from "../test-helpers/data/price";
import { createTestPricingTable } from "../test-helpers/data/pricing-table";
import Stripe from "stripe";
import { testEnv } from "../test-env";
import { resumeSubscriptionAndResetCycle } from "../../src/helpers/billing";

setDefaultTimeout(20000);

describe("Dunning flows - recurring payment failures and recovery", () => {
  let merchantId: string;
  let customerId: string;
  let subscriptionId: string;
  let publishableApiKey: string;
  let apiClient: ReturnType<typeof createTestApiClient>;
  let paymentProvider: PaymentProviderAdapter;
  let sessionToken: string;
  let apiUrl: string;
  let triggerApiAccessKey: string;
  let testStartTime: Date;
  let batchTriggerSpy: ReturnType<typeof spyOn>;

  // Define the type for batch items based on the job payload schema
  type BatchItem = { payload: z.infer<typeof collectPaymentPayloadSchema> };

  // Define the type for the mock run result
  type MockRunResult = {
    id: string;
    status: "SUCCESS" | "FAILURE";
    output?: {
      success: boolean;
      status: string;
      message: string;
    };
    error?: string;
    payload: z.infer<typeof collectPaymentPayloadSchema>;
  };

  beforeEach(async () => {
    testStartTime = new Date();
    apiUrl = env.API_URL;
    triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY!;

    // Fresh environment per test
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    paymentProvider = await createPaymentProvider();
    await paymentProvider.registerIntegration(merchantId);

    const apiKeys = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    publishableApiKey = apiKeys.publishableKey.keyValue;

    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
    apiClient = createTestApiClient(sessionToken);

    await paymentProvider.startWebhookForwarder(merchantId);

    // --- Mock Setup ---
    batchTriggerSpy = spyOn(collectPaymentJob, "batchTrigger");
    batchTriggerSpy.mockImplementation(async (batchItems: BatchItem[]) => {
      const runResults: MockRunResult[] = [];
      console.log(
        `Mock batchTrigger (collectPaymentJob) executing for ${batchItems.length} items (Dunning Test)...`
      );

      const collectPaymentResponseSchema = z.object({
        success: z.boolean(),
        status: z.string(),
        message: z.string(),
      });

      for (const item of batchItems) {
        const payload = item.payload;
        try {
          const response = await fetch(
            `${apiUrl}/trigger/billing/collect-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${triggerApiAccessKey}`,
              },
              body: JSON.stringify(payload),
            }
          );

          const responseData = await response.json();
          const parsedResult = collectPaymentResponseSchema.parse(responseData);

          runResults.push({
            id: `mock-run-${payload.customerId}-dunning`,
            status: response.ok && parsedResult.success ? "SUCCESS" : "FAILURE",
            output: parsedResult,
            payload: payload,
          });
        } catch (error) {
          runResults.push({
            id: `mock-run-${payload.customerId}-dunning`,
            status: "FAILURE",
            error:
              error instanceof Error
                ? error.message
                : "Unknown mock fetch error",
            payload: payload,
          });
        }
      }
      return {
        batchId: `mock-batch-${Date.now()}-dunning`,
        runs: runResults,
      };
    });
  });

  afterEach(async () => {
    if (paymentProvider) await paymentProvider.cleanup();

    try {
      // Use a single SQL statement for all deletions in proper foreign key order
      await db.execute(sql`
        DELETE FROM ${dunningConfigs};
        DELETE FROM ${paymentRetries};
        DELETE FROM ${creditUsageTransactions};
        DELETE FROM ${payments};
        DELETE FROM ${invoiceLineItems};
        DELETE FROM ${invoices};
        DELETE FROM ${subscriptionFeatures};
        DELETE FROM ${subscriptionDetails};
        DELETE FROM ${events};
        DELETE FROM ${subscriptionsScheduledChanges};
        DELETE FROM ${subscriptions};
        DELETE FROM ${subscriptionPriceOverrides};
        DELETE FROM ${paymentMethods};
        DELETE FROM ${creditGrants};
        DELETE FROM ${creditDefinitions};
        DELETE FROM ${prices};
        DELETE FROM ${planFeatures};
        DELETE FROM ${features};
        DELETE FROM ${featureMetrics};
        DELETE FROM ${metrics};
        DELETE FROM ${pricingTablePlans};
        DELETE FROM ${pricingTables};
        DELETE FROM ${plans};
        DELETE FROM ${stripeSchema};
        DELETE FROM ${customers};
        DELETE FROM ${customerInvoiceCounters};
        DELETE FROM ${user};
        DELETE FROM ${organization};
      `);
    } catch (error) {
      console.error("Error during test cleanup (dunning):", error);
      throw error;
    }

    if (batchTriggerSpy) {
      batchTriggerSpy.mockRestore();
    }
  });

  // Helper: create a simple fixed-price monthly plan via API and subscribe
  const createPlanAndSubscribe = async (customerEmail: string) => {
    const planResp = await apiClient.plans.$post({
      json: {
        planName: "Test Plan Dunning",
        planDescription: "Dunning flow test plan",
        commitMessage: "create dunning test plan",
        currency: "USD",
        monthlyPrice: 1000,
        hasYearlyPrice: false,
        showInPricingTable: false,
        isEnterprisePlan: false,
        isSeatBased: false,
        newFeatures: [],
      },
    });
    const planData = await planResp.json();
    if ("error" in planData) throw new Error(String(planData.error));
    const plan = planData.plans[0];

    const pricesResp = await apiClient.prices.$get({
      query: { planId: plan.id },
    });
    const pricesJson = await pricesResp.json();
    if ("error" in pricesJson) throw new Error(String(pricesJson.error));
    const monthlyPrice = pricesJson.prices[0];

    const paymentInitResp = await apiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: monthlyPrice.id,
        planId: plan.id,
        customerEmail,
        customerName: "Dunning Test Customer",
        userId: `dunning-user-${Date.now()}`,
      },
    });
    const paymentInitData = await paymentInitResp.json();
    if ("error" in paymentInitData)
      throw new Error(String(paymentInitData.error));

    await paymentProvider.completePaymentInit(paymentInitData);
    await paymentProvider.waitForWebhooks();

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
    if (createdCustomers.length !== 1) throw new Error("Customer not created");
    const customer = createdCustomers[0];
    customerId = customer.id;

    const createdSubs = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.merchantId, merchantId),
          eq(subscriptions.customerId, customer.id),
          isNull(subscriptions.deletedAt)
        )
      );
    if (createdSubs.length !== 1) throw new Error("Subscription not created");
    subscriptionId = createdSubs[0].id;

    return { planId: plan.id };
  };

  // Test 1: Recurring failure transitions to past_due and sets grace period
  it("recurring failure sets subscription to past_due and applies grace period", async () => {
    await createPlanAndSubscribe(`dunning1_${Date.now()}@example.com`);

    // Force failing PM for recurring charges
    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pm) throw new Error("Payment method not found");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pm.id));

    // Advance billing: set nextBillingDate in the past and process cycle
    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetail) throw new Error("Subscription detail not found");

    const pastDate = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDate,
        previousBillingDate: addMinutes(pastDate, -30),
      })
      .where(eq(subscriptionDetails.id, subDetail.id));

    // Trigger billing via helper that calls trigger API
    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    // Assertions: invoice created & not paid; subscription is past_due with gracePeriodEndsAt
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.subscriptionId, subscriptionId),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    expect(invoice).toBeDefined();
    expect(invoice!.status).toBe("issued");

    const sub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(sub).toBeDefined();
    expect(sub!.status).toBe("past_due");
    expect(sub!.gracePeriodEndsAt).not.toBeNull();
  });

  it("end-to-end: retry failure does not extend grace; retry success recovers and pays invoice", async () => {
    await createPlanAndSubscribe(`dunning2_${Date.now()}@example.com`);

    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pm) throw new Error("Payment method not found");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pm.id));

    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetail) throw new Error("Subscription detail not found");

    const pastDate = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDate,
        previousBillingDate: addMinutes(pastDate, -30),
      })
      .where(eq(subscriptionDetails.id, subDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.subscriptionId, subscriptionId),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!invoice) throw new Error("Invoice not found after failure");

    const subBeforeRetry = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });

    // Assertions: subscription is past_due with grace period
    expect(subBeforeRetry).toBeDefined();
    expect(subBeforeRetry!.status).toBe("past_due");
    expect(subBeforeRetry!.gracePeriodEndsAt).not.toBeNull();
    const originalGrace = subBeforeRetry!.gracePeriodEndsAt;
    // default grace period is 7 days - check the value with acceptable margin
    expectDateWithinMargin(originalGrace, addDays(testStartTime, 7));

    // Check that payment is marked as failed
    const payment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invoice.id),
    });
    expect(payment).toBeDefined();
    expect(payment!.status).toBe("failed");
    expect(payment!.errorMessage).toBe("Your card was declined.");

    const retryResp1 = await fetch(
      `${apiUrl}/trigger/billing/dunning/retry-payments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(retryResp1.ok).toBe(true);
    await paymentProvider.waitForWebhooks(3000);

    const subAfterRetryFail = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subAfterRetryFail).toBeDefined();
    expect(subAfterRetryFail!.status).toBe("past_due");
    expect(subAfterRetryFail!.gracePeriodEndsAt).not.toBeNull();
    // check that grace period is unchanged
    expectDateWithinMargin(subAfterRetryFail!.gracePeriodEndsAt, originalGrace);

    const retriesAfterFail = await db
      .select()
      .from(paymentRetries)
      .where(eq(paymentRetries.invoiceId, invoice.id));
    expect(retriesAfterFail.length).toBe(1);
    expect(retriesAfterFail[0].status).toBe("failed");
    expect(retriesAfterFail[0].attemptNumber).toBe(1);

    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa" })
      .where(eq(paymentMethods.id, pm.id));

    const retryResp2 = await fetch(
      `${apiUrl}/trigger/billing/dunning/retry-payments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(retryResp2.ok).toBe(true);
    await paymentProvider.waitForWebhooks(4000);

    const updatedInvoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoice.id),
    });
    expect(updatedInvoice).toBeDefined();
    expect(updatedInvoice!.status).toBe("paid");

    const subAfterRetrySuccess = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subAfterRetrySuccess).toBeDefined();
    expect(subAfterRetrySuccess!.status).toBe("active");
    expect(subAfterRetrySuccess!.gracePeriodEndsAt).toBeNull();

    const retriesFinal = await db.query.paymentRetries.findMany({
      where: eq(paymentRetries.invoiceId, invoice.id),
      orderBy: (paymentRetries, { desc }) => [desc(paymentRetries.createdAt)],
    });
    expect(retriesFinal.length).toBe(2);
    const statuses = retriesFinal.map((r) => r.status).sort();
    expect(statuses).toEqual(["failed", "succeeded"]);

    const relatedPayments = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, invoice.id));
    expect(relatedPayments.length).toBe(1);
  });

  it("enforcement: applies configured end-of-dunning action - pause, unpaid, cancel", async () => {
    // Helper to create failing subscription and return identifiers
    const setupFailingSub = async (emailSuffix: string) => {
      const { planId } = await createPlanAndSubscribe(
        `enforce_${emailSuffix}@example.com`
      );

      // Force failing PM for recurring charges
      const pm = await db.query.paymentMethods.findFirst({
        where: and(
          eq(paymentMethods.customerId, customerId),
          isNull(paymentMethods.deletedAt)
        ),
        orderBy: (paymentMethods, { desc }) => [
          desc(paymentMethods.lastUsedAt),
        ],
      });
      if (!pm) throw new Error("Payment method not found");
      await db
        .update(paymentMethods)
        .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
        .where(eq(paymentMethods.id, pm.id));

      // Move billing into the past to trigger invoice + charge attempt
      const subDetail = await db.query.subscriptionDetails.findFirst({
        where: eq(subscriptionDetails.subscriptionId, subscriptionId),
      });
      if (!subDetail) throw new Error("Subscription detail not found");
      const pastDate = subDays(testStartTime, 1);
      await db
        .update(subscriptionDetails)
        .set({
          nextBillingDate: pastDate,
          previousBillingDate: addMinutes(pastDate, -30),
        })
        .where(eq(subscriptionDetails.id, subDetail.id));

      // Trigger billing cycle and wait for webhook handling
      await processBillingCycle(apiUrl, triggerApiAccessKey);
      await paymentProvider.waitForWebhooks(3000);

      // Fetch latest invoice for this subscription
      const inv = await db.query.invoices.findFirst({
        where: eq(invoices.subscriptionId, subscriptionId),
        orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
      });
      if (!inv) throw new Error("Invoice not created");

      // Subscription should be past_due with grace period (~7 days default)
      const sub = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, subscriptionId),
      });
      expect(sub).toBeDefined();
      expect(sub!.status).toBe("past_due");
      expect(sub!.gracePeriodEndsAt).not.toBeNull();
      expectDateWithinMargin(sub!.gracePeriodEndsAt, addDays(testStartTime, 7));

      // Payment should be marked failed; invoice issued
      const pay = await db.query.payments.findFirst({
        where: eq(payments.invoiceId, inv.id),
      });
      expect(pay).toBeDefined();
      expect(pay!.status).toBe("failed");
      expect(inv.status).toBe("issued");

      return { subId: subscriptionId, planId, invoiceId: inv.id };
    };

    // Case 1: pause_subscription
    const pauseSetup = await setupFailingSub("pause");
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: pauseSetup.planId,
        gracePeriodDays: 7,
        endOfDunningAction: "pause_subscription",
      })
      .onConflictDoNothing();

    // Expire grace period and enforce
    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, pauseSetup.subId));
    const enforceResp1 = await fetch(
      `${apiUrl}/trigger/billing/dunning/enforce-grace-periods`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(enforceResp1.ok).toBe(true);

    const pausedSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, pauseSetup.subId),
    });
    expect(pausedSub!.status).toBe("paused");
    expect(pausedSub!.gracePeriodEndsAt).toBeNull();
    expect(pausedSub!.endTimestamp).toBeNull();
    // Payment remains failed; invoice remains issued
    const pausedPayment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, pauseSetup.invoiceId),
    });
    expect(pausedPayment!.status).toBe("failed");

    // Case 2: mark_as_unpaid
    const unpaidSetup = await setupFailingSub("unpaid");
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: unpaidSetup.planId,
        gracePeriodDays: 7,
        endOfDunningAction: "mark_as_unpaid",
      })
      .onConflictDoNothing();
    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, unpaidSetup.subId));
    const enforceResp2 = await fetch(
      `${apiUrl}/trigger/billing/dunning/enforce-grace-periods`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(enforceResp2.ok).toBe(true);

    const unpaidSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, unpaidSetup.subId),
    });
    expect(unpaidSub!.status).toBe("unpaid");
    expect(unpaidSub!.gracePeriodEndsAt).toBeNull();
    expect(unpaidSub!.endTimestamp).not.toBeNull();
    const unpaidPayment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, unpaidSetup.invoiceId),
    });
    expect(unpaidPayment!.status).toBe("failed");

    // Case 3: cancel_subscription
    const cancelSetup = await setupFailingSub("cancel");
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: cancelSetup.planId,
        gracePeriodDays: 7,
        endOfDunningAction: "cancel_subscription",
      })
      .onConflictDoNothing();
    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, cancelSetup.subId));
    const enforceResp3 = await fetch(
      `${apiUrl}/trigger/billing/dunning/enforce-grace-periods`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(enforceResp3.ok).toBe(true);

    const canceledSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, cancelSetup.subId),
    });
    expect(canceledSub!.status).toBe("canceled");
    expect(canceledSub!.gracePeriodEndsAt).toBeNull();
    expect(canceledSub!.endTimestamp).not.toBeNull();
    const canceledPayment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, cancelSetup.invoiceId),
    });
    expect(canceledPayment!.status).toBe("failed");

    // Ensure subscription details/features soft-deleted on cancel
    const canceledDetails = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, cancelSetup.subId),
    });
    const canceledFeatures = await db.query.subscriptionFeatures.findFirst({
      where: eq(subscriptionFeatures.subscriptionId, cancelSetup.subId),
    });
    // We can't filter details by subscriptionId directly via schema, so just assert there exists at least one soft-deleted detail for this subscription
    expect(canceledDetails).toBeDefined();
    expect(canceledDetails!.deletedAt).not.toBeNull();
    // For features, ensure soft delete flag is set for rows tied to this subscription
    if (canceledFeatures) {
      expect(canceledFeatures.deletedAt).not.toBeNull();
    }

    // Case 3b: cancel_subscription with a free plan available should downgrade to free
    const cancelFreeSetup = await setupFailingSub("cancel_free");

    // Create a free plan + price and expose via active pricing table
    const { plan: freePlan } = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `free-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Free Plan For Dunning",
        planDescription: "Auto-downgrade target",
      }
    );
    await createTestPrice({
      planId: freePlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: `free_component_${Date.now()}`,
            type: "fixed",
            label: "Free Base",
            amount_cents: 0,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });
    await createTestPricingTable({
      merchantId,
      name: "Downgrade Free Table",
      slug: `downgrade-free-${Date.now()}`,
      description: "Active table to expose free plan",
      isActive: true,
      planIds: [freePlan.id],
    });

    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: cancelFreeSetup.planId,
        gracePeriodDays: 7,
        endOfDunningAction: "cancel_subscription",
      })
      .onConflictDoNothing();

    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, cancelFreeSetup.subId));
    const enforceResp4 = await fetch(
      `${apiUrl}/trigger/billing/dunning/enforce-grace-periods`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(enforceResp4.ok).toBe(true);

    const oldSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, cancelFreeSetup.subId),
    });
    expect(oldSub).toBeDefined();
    expect(oldSub!.status).toBe("canceled");
    expect(oldSub!.endTimestamp).not.toBeNull();

    const newSub = await db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.customerId, oldSub!.customerId),
        eq(subscriptions.merchantId, merchantId),
        isNull(subscriptions.deletedAt),
        isNull(subscriptions.endTimestamp)
      ),
      orderBy: (subscriptions, { desc }) => [desc(subscriptions.createdAt)],
    });
    expect(newSub).toBeDefined();
    expect(newSub!.planId).toBe(freePlan.id);
    expect(newSub!.status).toBe("active");
    if (oldSub!.stableSubscriptionId && newSub!.stableSubscriptionId) {
      expect(newSub!.stableSubscriptionId).toBe(oldSub!.stableSubscriptionId);
    }
  }, 40000);

  it("manual retry API: creates paymentRetries and reuses existing payment object", async () => {
    await createPlanAndSubscribe(`manual_retry_${Date.now()}@example.com`);

    // Force failing PM for recurring charges
    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pm) throw new Error("Payment method not found");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pm.id));

    // Move billing into the past to trigger invoice + charge attempt
    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetail) throw new Error("Subscription detail not found");
    const pastDate = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDate,
        previousBillingDate: addMinutes(pastDate, -30),
      })
      .where(eq(subscriptionDetails.id, subDetail.id));

    // Trigger billing cycle and wait for webhook handling
    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    // Fetch latest invoice and payment after failure
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.subscriptionId, subscriptionId),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!invoice) throw new Error("Invoice not created");
    const initialPayment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invoice.id),
      orderBy: (payments, { desc }) => [desc(payments.createdAt)],
    });
    expect(initialPayment).toBeDefined();
    const originalPaymentId = initialPayment!.id;
    expect(initialPayment!.status).toBe("failed");
    expect(invoice.status).toBe("issued");

    // Manual retry (still failing PM) via merchant-auth API
    const manualRetryResp1 = await apiClient.invoices[":id"][
      "retry-payment"
    ].$post({
      param: { id: invoice.id },
    });
    expect(manualRetryResp1.ok).toBe(true);
    const manualRetryData1Json = await manualRetryResp1.json();
    if ("error" in manualRetryData1Json) {
      throw new Error(String(manualRetryData1Json.error));
    }
    const manualRetryData1 = manualRetryData1Json as {
      success: boolean;
      message: string;
      attemptNumber: number;
      paymentId: string;
    };
    expect(manualRetryData1.success).toBe(true);
    expect(typeof manualRetryData1.paymentId).toBe("string");
    await paymentProvider.waitForWebhooks(3000);

    // Assert paymentRetries recorded and payment object reused
    const retriesAfterManual1 = await db.query.paymentRetries.findMany({
      where: eq(paymentRetries.invoiceId, invoice.id),
      orderBy: (paymentRetries, { desc }) => [desc(paymentRetries.createdAt)],
    });
    expect(retriesAfterManual1.length).toBe(1);
    expect(retriesAfterManual1[0].attemptNumber).toBe(1);
    expect(retriesAfterManual1[0].status).toBe("failed");

    const paymentsAfterManual1 = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, invoice.id));
    expect(paymentsAfterManual1.length).toBe(1);
    expect(paymentsAfterManual1[0].id).toBe(originalPaymentId);

    // Switch to passing PM and retry again via manual API
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa" })
      .where(eq(paymentMethods.id, pm.id));

    const manualRetryResp2 = await apiClient.invoices[":id"][
      "retry-payment"
    ].$post({
      param: { id: invoice.id },
    });
    expect(manualRetryResp2.ok).toBe(true);
    const manualRetryData2Json = await manualRetryResp2.json();
    if ("error" in manualRetryData2Json) {
      throw new Error(String(manualRetryData2Json.error));
    }
    const manualRetryData2 = manualRetryData2Json as {
      success: boolean;
      message: string;
      attemptNumber: number;
      paymentId: string;
    };
    expect(manualRetryData2.success).toBe(true);
    await paymentProvider.waitForWebhooks(4000);

    // Invoice paid; subscription active; retries reflect success
    const updatedInvoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoice.id),
    });
    expect(updatedInvoice!.status).toBe("paid");

    const sub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(sub!.status).toBe("active");
    expect(sub!.gracePeriodEndsAt).toBeNull();

    const retriesFinal = await db.query.paymentRetries.findMany({
      where: eq(paymentRetries.invoiceId, invoice.id),
      orderBy: (paymentRetries, { desc }) => [desc(paymentRetries.createdAt)],
    });
    expect(retriesFinal.length).toBe(2);
    const statuses = retriesFinal.map((r) => r.status).sort();
    expect(statuses).toEqual(["failed", "succeeded"]);

    const paymentsAfterManual2 = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, invoice.id));
    expect(paymentsAfterManual2.length).toBe(1);
    expect(paymentsAfterManual2[0].id).toBe(originalPaymentId);
  }, 40000);

  it("idempotency and selection: ignores duplicate webhooks; retry job selects eligible subs", async () => {
    // Create eligible subscription (past_due within grace)
    await createPlanAndSubscribe(`idemp_eligible_${Date.now()}@example.com`);
    const eligibleSubId = subscriptionId;

    // Force failing PM for eligible customer
    const eligibleSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, eligibleSubId),
    });
    if (!eligibleSub) throw new Error("Eligible subscription not found");
    const eligiblePm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, eligibleSub.customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!eligiblePm) throw new Error("Eligible payment method not found");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, eligiblePm.id));

    // Move billing into the past and process
    const eligibleDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, eligibleSubId),
    });
    if (!eligibleDetail) throw new Error("Eligible sub detail not found");
    const pastDateA = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDateA,
        previousBillingDate: addMinutes(pastDateA, -30),
      })
      .where(eq(subscriptionDetails.id, eligibleDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    // Create ineligible subscription (grace expired)
    await createPlanAndSubscribe(`idemp_ineligible_${Date.now()}@example.com`);
    const ineligibleSubId = subscriptionId;

    const ineligibleSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, ineligibleSubId),
    });
    if (!ineligibleSub) throw new Error("Ineligible subscription not found");
    const ineligiblePm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, ineligibleSub.customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!ineligiblePm) throw new Error("Ineligible payment method not found");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, ineligiblePm.id));

    const ineligibleDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, ineligibleSubId),
    });
    if (!ineligibleDetail) throw new Error("Ineligible sub detail not found");
    const pastDateB = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDateB,
        previousBillingDate: addMinutes(pastDateB, -30),
      })
      .where(eq(subscriptionDetails.id, ineligibleDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const ineligibleInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, ineligibleSubId),
        eq(invoices.status, "issued")
      ),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!ineligibleInvoice) throw new Error("Ineligible invoice not found");

    // Expire ineligible's grace period so retry job should skip it
    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, ineligibleSubId));

    // Run retry job first time
    const retryRespA = await fetch(
      `${apiUrl}/trigger/billing/dunning/retry-payments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(retryRespA.ok).toBe(true);
    await paymentProvider.waitForWebhooks(4000);

    const eligibleInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, eligibleSubId),
        eq(invoices.status, "issued")
      ),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!eligibleInvoice) throw new Error("Eligible invoice not found");

    const eligibleRetriesAfterA = await db.query.paymentRetries.findMany({
      where: eq(paymentRetries.invoiceId, eligibleInvoice.id),
      orderBy: (paymentRetries, { desc }) => [desc(paymentRetries.createdAt)],
    });
    expect(eligibleRetriesAfterA.length).toBe(1);
    expect(eligibleRetriesAfterA[0].attemptNumber).toBe(1);

    // Ineligible should not have retries
    const ineligibleRetriesAfterA = await db.query.paymentRetries.findMany({
      where: eq(paymentRetries.invoiceId, ineligibleInvoice.id),
    });
    expect(ineligibleRetriesAfterA.length).toBe(0);

    // Ensure payment object reused
    const eligiblePaymentsA = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, eligibleInvoice.id));
    expect(eligiblePaymentsA.length).toBe(1);

    // Run retry job second time (idempotency: still reuse same payment; new retry attempt created)
    const retryRespB = await fetch(
      `${apiUrl}/trigger/billing/dunning/retry-payments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(retryRespB.ok).toBe(true);
    await paymentProvider.waitForWebhooks(3000);

    const eligibleRetriesAfterB = await db.query.paymentRetries.findMany({
      where: eq(paymentRetries.invoiceId, eligibleInvoice.id),
      orderBy: (paymentRetries, { desc }) => [desc(paymentRetries.createdAt)],
    });
    expect(eligibleRetriesAfterB.length).toBe(2);
    const attemptNumbers = eligibleRetriesAfterB
      .map((r) => r.attemptNumber)
      .sort((a, b) => a - b);
    expect(attemptNumbers).toEqual([1, 2]);

    const eligiblePaymentsB = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, eligibleInvoice.id));
    expect(eligiblePaymentsB.length).toBe(1);
  }, 60000);

  it("failover: recurring failure on PM A immediately retries with PM B and succeeds", async () => {
    await createPlanAndSubscribe(`failover_${Date.now()}@example.com`);

    // Locate initial PM A (created by payment-init) and force it to fail
    const pmA = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pmA) throw new Error("Payment method A not found");

    // Capture Stripe customer id from existing PM A
    const stripeCustomerId = pmA.externalPspCustomerId!;

    // Make PM A a guaranteed failure for the next attempt
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pmA.id));

    // Create PM B in Stripe and attach to same customer
    const stripe = new Stripe(testEnv.TEST_STRIPE_SECRET_KEY, {
      apiVersion: "2025-02-24.acacia",
    });
    const stripePmB = await stripe.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomerId,
    });

    // Insert PM B into our DB
    const [dbPmB] = await db
      .insert(paymentMethods)
      .values({
        merchantId,
        customerId,
        provider: "stripe",
        paymentType: "card",
        status: "active",
        externalPspPaymentMethodId: stripePmB.id,
        externalPspCustomerId: stripeCustomerId,
        cardLastFour: stripePmB.card?.last4,
        cardBrand: stripePmB.card?.brand,
        lastUsedAt: null,
      })
      .returning();

    // Make the subscription due now to trigger a charge attempt with A (will fail)
    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetail)
      throw new Error("Subscription detail not found for failover test");
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: subDays(testStartTime, 1),
        previousBillingDate: addMinutes(subDays(testStartTime, 1), -30),
      })
      .where(eq(subscriptionDetails.id, subDetail.id));

    // Process billing - first attempt with A fails; webhook should immediately retry with B
    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(5000);

    // Validate latest invoice is paid
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.subscriptionId, subscriptionId),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    expect(invoice).toBeDefined();
    expect(invoice!.status).toBe("paid");

    // Validate payment succeeded and used PM B after failover
    const payment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invoice!.id),
      orderBy: (payments, { desc }) => [desc(payments.createdAt)],
    });
    expect(payment).toBeDefined();
    expect(payment!.status).toBe("succeeded");
    expect(payment!.paymentMethodId).toBe(dbPmB.id);

    // Metadata should record attempted list including PM A and PM B
    const meta = (payment!.metadata || {}) as any;
    const attempted = (meta.attempted_payment_method_ids || []) as string[];
    expect(Array.isArray(attempted)).toBe(true);
    expect(attempted).toContain(pmA.id);
    expect(attempted).toContain(dbPmB.id);

    // PM A should be stamped as failed; PM B should have lastUsedAt updated
    const pmAAfter = await db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, pmA.id),
    });
    expect(pmAAfter!.lastFailedAt).not.toBeNull();
    expect(pmAAfter!.failureReason).toBeTruthy();

    const pmBAfter = await db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, dbPmB.id),
    });
    expect(pmBAfter!.lastUsedAt).not.toBeNull();

    // Subscription should be active (not moved to past_due)
    const sub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(sub!.status).toBe("active");
  }, 60000);

  it("paused, unpaid, canceled skip billing - resumes to active on successful payment", async () => {
    // Helper to get invoice count for a subscription
    const getInvoiceCount = async (subId: string) => {
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(invoices)
        .where(eq(invoices.subscriptionId, subId));
      return rows[0]?.count ?? 0;
    };

    // Case A: paused skips billing
    await createPlanAndSubscribe(`skip_paused_${Date.now()}@example.com`);
    const pausedSubId = subscriptionId;
    const pausedDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, pausedSubId),
    });
    if (!pausedDetail) throw new Error("Paused detail not found");
    const pausedBefore = await getInvoiceCount(pausedSubId);
    await db
      .update(subscriptions)
      .set({ status: "paused" })
      .where(eq(subscriptions.id, pausedSubId));
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: subDays(testStartTime, 1),
        previousBillingDate: addMinutes(subDays(testStartTime, 1), -30),
      })
      .where(eq(subscriptionDetails.id, pausedDetail.id));
    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(2000);
    const pausedAfter = await getInvoiceCount(pausedSubId);
    expect(pausedAfter).toBe(pausedBefore);

    // Case B: unpaid skips billing
    await createPlanAndSubscribe(`skip_unpaid_${Date.now()}@example.com`);
    const unpaidSubId = subscriptionId;
    const unpaidDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, unpaidSubId),
    });
    if (!unpaidDetail) throw new Error("Unpaid detail not found");
    const unpaidBefore = await getInvoiceCount(unpaidSubId);
    await db
      .update(subscriptions)
      .set({ status: "unpaid", endTimestamp: testStartTime })
      .where(eq(subscriptions.id, unpaidSubId));
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: subDays(testStartTime, 1),
        previousBillingDate: addMinutes(subDays(testStartTime, 1), -30),
      })
      .where(eq(subscriptionDetails.id, unpaidDetail.id));
    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(2000);
    const unpaidAfter = await getInvoiceCount(unpaidSubId);
    expect(unpaidAfter).toBe(unpaidBefore);

    // Case C: canceled skips billing
    await createPlanAndSubscribe(`skip_canceled_${Date.now()}@example.com`);
    const canceledSubId = subscriptionId;
    const canceledDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, canceledSubId),
    });
    if (!canceledDetail) throw new Error("Canceled detail not found");
    const canceledBefore = await getInvoiceCount(canceledSubId);
    await db
      .update(subscriptions)
      .set({ status: "canceled", endTimestamp: testStartTime })
      .where(eq(subscriptions.id, canceledSubId));
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: subDays(testStartTime, 1),
        previousBillingDate: addMinutes(subDays(testStartTime, 1), -30),
      })
      .where(eq(subscriptionDetails.id, canceledDetail.id));
    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(2000);
    const canceledAfter = await getInvoiceCount(canceledSubId);
    expect(canceledAfter).toBe(canceledBefore);

    // Resume to active on successful payment from paused
    await createPlanAndSubscribe(`resume_active_${Date.now()}@example.com`);
    const resumeSubId = subscriptionId;

    // Force recurring failure to create an issued invoice and set past_due
    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(
          paymentMethods.customerId,
          (await db.query.subscriptions.findFirst({
            where: eq(subscriptions.id, resumeSubId),
          }))!.customerId
        ),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pm) throw new Error("Payment method not found (resume)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pm.id));
    const resumeDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, resumeSubId),
    });
    if (!resumeDetail) throw new Error("Resume detail not found");
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: subDays(testStartTime, 1),
        previousBillingDate: addMinutes(subDays(testStartTime, 1), -30),
      })
      .where(eq(subscriptionDetails.id, resumeDetail.id));
    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const resumeInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, resumeSubId),
        eq(invoices.status, "issued")
      ),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!resumeInvoice) throw new Error("Resume invoice not found");

    // Pause the subscription explicitly, then pay the invoice successfully
    await db
      .update(subscriptions)
      .set({ status: "paused" })
      .where(eq(subscriptions.id, resumeSubId));
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa" })
      .where(eq(paymentMethods.id, pm.id));

    const manualRetryResp = await apiClient.invoices[":id"][
      "retry-payment"
    ].$post({
      param: { id: resumeInvoice.id },
    });
    expect(manualRetryResp.ok).toBe(true);
    await paymentProvider.waitForWebhooks(4000);

    const updatedResumeInvoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, resumeInvoice.id),
    });
    expect(updatedResumeInvoice!.status).toBe("paid");

    const resumeSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, resumeSubId),
    });
    expect(resumeSub!.status).toBe("active");
    expect(resumeSub!.gracePeriodEndsAt).toBeNull();
  }, 60000);

  it("dunning config hierarchy: uses plan-level override, falls back to merchant-level", async () => {
    // Set merchant-level default (fallback): 3 days, mark_as_unpaid
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: null,
        gracePeriodDays: 3,
        endOfDunningAction: "mark_as_unpaid",
      })
      .onConflictDoNothing();

    // Plan A: create + subscribe, then set plan-level override (10 days, pause_subscription)
    const { planId: planAId } = await createPlanAndSubscribe(
      `hierarchy_planA_${Date.now()}@example.com`
    );
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: planAId,
        gracePeriodDays: 10,
        endOfDunningAction: "pause_subscription",
      })
      .onConflictDoNothing();

    const subAId = subscriptionId;
    // Force failure on Plan A next cycle
    const pmA = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pmA) throw new Error("Payment method not found (Plan A)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pmA.id));

    const subADetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subAId),
    });
    if (!subADetail) throw new Error("Subscription detail not found (Plan A)");
    const pastA = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastA,
        previousBillingDate: addMinutes(pastA, -30),
      })
      .where(eq(subscriptionDetails.id, subADetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const invA = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subAId),
        eq(invoices.status, "issued")
      ),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!invA) throw new Error("Invoice not created (Plan A)");
    const payA = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invA.id),
    });
    expect(payA).toBeDefined();
    expect(payA!.status).toBe("failed");

    const subA = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subAId),
    });
    expect(subA).toBeDefined();
    expect(subA!.status).toBe("past_due");
    expectDateWithinMargin(subA!.gracePeriodEndsAt, addDays(testStartTime, 10));

    // Enforce: should pause (plan-level override)
    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, subAId));
    const enforceA = await fetch(
      `${apiUrl}/trigger/billing/dunning/enforce-grace-periods`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(enforceA.ok).toBe(true);
    const subAAfter = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subAId),
    });
    expect(subAAfter!.status).toBe("paused");
    expect(subAAfter!.endTimestamp).toBeNull();

    // Plan B: create + subscribe (no plan-level, should fall back to merchant-level 3 days + unpaid)
    const { planId: planBId } = await createPlanAndSubscribe(
      `hierarchy_planB_${Date.now()}@example.com`
    );
    const subBId = subscriptionId;

    // Force failure on Plan B next cycle
    const pmB = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pmB) throw new Error("Payment method not found (Plan B)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pmB.id));

    const subBDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subBId),
    });
    if (!subBDetail) throw new Error("Subscription detail not found (Plan B)");
    const pastB = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastB,
        previousBillingDate: addMinutes(pastB, -30),
      })
      .where(eq(subscriptionDetails.id, subBDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const invB = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subBId),
        eq(invoices.status, "issued")
      ),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!invB) throw new Error("Invoice not created (Plan B)");
    const payB = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invB.id),
    });
    expect(payB).toBeDefined();
    expect(payB!.status).toBe("failed");

    const subB = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subBId),
    });
    expect(subB).toBeDefined();
    expect(subB!.status).toBe("past_due");
    expectDateWithinMargin(subB!.gracePeriodEndsAt, addDays(testStartTime, 3));

    // Enforce: should mark as unpaid (merchant-level default)
    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, subBId));
    const enforceB = await fetch(
      `${apiUrl}/trigger/billing/dunning/enforce-grace-periods`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(enforceB.ok).toBe(true);
    const subBAfter = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subBId),
    });
    expect(subBAfter!.status).toBe("unpaid");
    expect(subBAfter!.endTimestamp).not.toBeNull();
  }, 60000);

  it("payment metadata: invoice_id available via metadata or by reading payment.invoiceId", async () => {
    await createPlanAndSubscribe(`meta_${Date.now()}@example.com`);

    // Force recurring failure to create an issued invoice and a payment with metadata
    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pm) throw new Error("Payment method not found (metadata test)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pm.id));

    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetail) throw new Error("Subscription detail not found (metadata)");
    const pastDate = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDate,
        previousBillingDate: addMinutes(pastDate, -30),
      })
      .where(eq(subscriptionDetails.id, subDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "issued")
      ),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!invoice) throw new Error("Invoice not created (metadata)");

    const payment = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invoice.id),
      orderBy: (payments, { desc }) => [desc(payments.createdAt)],
    });
    expect(payment).toBeDefined();
    // Column presence
    expect(payment!.invoiceId).toBe(invoice.id);
    // Metadata presence
    expect((payment!.metadata as any)?.invoice_id).toBe(invoice.id);

    // Optional: trigger manual retry to ensure metadata stamping for retry also occurs on the same payment
    const retryResp = await apiClient.invoices[":id"]["retry-payment"].$post({
      param: { id: invoice.id },
    });
    expect(retryResp.ok).toBe(true);
    await paymentProvider.waitForWebhooks(3000);

    const paymentAfterRetry = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invoice.id),
    });
    expect(paymentAfterRetry!.id).toBe(payment!.id);
    expect(
      (paymentAfterRetry!.metadata as any)?.payment_retry_id
    ).toBeDefined();
  }, 30000);

  it("failure handler: zero-grace immediate enforcement and expired-grace enforcement; PM stamping and credits expiry", async () => {
    // Case 1: Zero grace, end action cancel -> immediate cancel on failure with credits expiry and PM stamping
    const { planId: planZId } = await createPlanAndSubscribe(
      `zero_grace_${Date.now()}@example.com`
    );

    // Plan-level config: zero grace, cancel
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: planZId,
        gracePeriodDays: 0,
        endOfDunningAction: "cancel_subscription",
      })
      .onConflictDoNothing();

    // Create feature for usage-based credits
    const featureSlug = `api-calls-${Date.now()}`;
    const [feature] = await db
      .insert(features)
      .values({
        merchantId,
        slug: featureSlug,
        displayName: "API Calls",
        description: "Number of API calls allowed",
        featureType: "number",
        featureValue: 1000,
      })
      .returning();

    // Add feature to the plan
    await db.insert(planFeatures).values({
      planId: planZId,
      featureId: feature.id,
      featureSlug: feature.slug,
      featureValue: 1000,
    });

    // Seed a plan-scoped usage credit grant for this customer/plan
    const priceZ = await db.query.prices.findFirst({
      where: eq(prices.planId, planZId),
    });
    if (!priceZ) throw new Error("Price not found for planZ");
    const creditDef = await createTestCreditDefinition({
      merchantId,
      scope: "plan",
      applicationType: "usage",
      name: "PlanZ Usage Credits",
      planId: planZId,
      priceId: priceZ.id,
      priceComponentId: "base_fee", // Using base fee component for usage credits
      featureId: feature.id,
      featureSlug: feature.slug,
      defaultAmount: 500,
      expiryDays: 30,
      billingVisible: false,
    });
    const grant = await createTestCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: creditDef.id,
      initialAmount: 500,
      source: "subscription",
    });

    // Force failing PM and process billing
    const pmZ = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pmZ) throw new Error("Payment method not found (zero grace)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pmZ.id));

    const subZDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subZDetail)
      throw new Error("Subscription detail not found (zero grace)");
    const pastZ = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastZ,
        previousBillingDate: addMinutes(pastZ, -30),
      })
      .where(eq(subscriptionDetails.id, subZDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(4000);

    // console log all invoices with id, createdAt, status
    const allInvoices = await db.query.invoices.findMany();
    console.log(
      "All invoices:",
      allInvoices.map((i) => ({
        id: i.id,
        createdAt: i.createdAt,
        status: i.status,
      }))
    );

    // console log all payments with id, createdAt, status
    const allPayments = await db.query.payments.findMany();
    console.log(
      "All payments:",
      allPayments.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        status: p.status,
      }))
    );

    // Verify immediate cancel
    const invZ = await db.query.invoices.findFirst({
      where: eq(invoices.subscriptionId, subscriptionId),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    expect(invZ).toBeDefined();
    expect(invZ!.status).toBe("issued");

    const payZ = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invZ!.id),
    });
    expect(payZ).toBeDefined();
    expect(payZ!.status).toBe("failed");
    const subZ = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subZ!.status).toBe("canceled");
    expect(subZ!.gracePeriodEndsAt).toBeNull();
    expect(subZ!.endTimestamp).not.toBeNull();

    // PM stamping
    const stampedPm = await db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, pmZ.id),
    });
    expect(stampedPm!.lastFailedAt).not.toBeNull();
    expect(stampedPm!.failureReason).toBeTruthy();

    // Credit grants expired
    const expiredGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, grant.id),
    });
    expect(expiredGrant!.status).toBe("EXPIRED");
    expect(expiredGrant!.expiryDate).not.toBeNull();

    // Case 2: Expired grace should enforce on next failure (plan-level 1 day pause)
    const { planId: planYId } = await createPlanAndSubscribe(
      `expired_grace_${Date.now()}@example.com`
    );
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: planYId,
        gracePeriodDays: 1,
        endOfDunningAction: "pause_subscription",
      })
      .onConflictDoNothing();

    const pmY = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pmY) throw new Error("Payment method not found (expired grace)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pmY.id));

    const subYDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subYDetail)
      throw new Error("Subscription detail not found (expired grace)");
    const pastY = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastY,
        previousBillingDate: addMinutes(pastY, -30),
      })
      .where(eq(subscriptionDetails.id, subYDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const invY = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "issued")
      ),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!invY) throw new Error("Invoice not created (expired grace)");

    // Make grace expired, then trigger another failure via manual retry
    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, subscriptionId));

    const retryResp = await apiClient.invoices[":id"]["retry-payment"].$post({
      param: { id: invY.id },
    });
    expect(retryResp.ok).toBe(true);
    await paymentProvider.waitForWebhooks(3000);

    const subYAfter = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subYAfter!.status).toBe("paused");
    expect(subYAfter!.gracePeriodEndsAt).toBeNull();
    expect(subYAfter!.endTimestamp).toBeNull();
  }, 60000);

  it("auto-recovery: portal payment method update retries latest unpaid invoice and resumes from past_due", async () => {
    await createPlanAndSubscribe(`pm_update_recover_${Date.now()}@example.com`);

    // Force failing PM for recurring charges
    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pm) throw new Error("Payment method not found (pm update)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pm.id));

    // Trigger next billing to create issued invoice and failed payment
    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetail)
      throw new Error("Subscription detail not found (pm update)");
    const pastDate = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDate,
        previousBillingDate: addMinutes(pastDate, -30),
      })
      .where(eq(subscriptionDetails.id, subDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.subscriptionId, subscriptionId),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    expect(invoice).toBeDefined();
    expect(invoice!.status).toBe("issued");

    const subBefore = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subBefore!.status).toBe("past_due");

    // Simulate portal add-payment-method flow
    const cust = await db.query.customers.findFirst({
      where: eq(customers.id, customerId),
    });
    if (!cust?.externalCustomerId)
      throw new Error("externalCustomerId not found");

    const setupResp = await apiClient.customers.portal[
      "create-setup-intent"
    ].$post({
      json: { externalCustomerId: cust.externalCustomerId },
    });
    expect(setupResp.ok).toBe(true);
    const setupJson = (await setupResp.json()) as any;
    const setupIntentId = setupJson?.stripe?.intentId as string;
    expect(typeof setupIntentId).toBe("string");

    // Complete the setup intent with a valid PM; this triggers webhook handling
    await paymentProvider.completePaymentInit({
      intentId: setupIntentId,
      intentType: "setup_intent",
    } as any);
    await paymentProvider.waitForWebhooks(5000);

    // Auto-retry should have paid the latest invoice and resumed the subscription
    const updatedInvoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoice!.id),
    });
    expect(updatedInvoice!.status).toBe("paid");

    const subAfter = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subAfter!.status).toBe("active");
    expect(subAfter!.gracePeriodEndsAt).toBeNull();

    const retries = await db.query.paymentRetries.findMany({
      where: eq(paymentRetries.invoiceId, invoice!.id),
      orderBy: (paymentRetries, { desc }) => [desc(paymentRetries.createdAt)],
    });
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(retries[0].status).toBe("succeeded");

    const relatedPayments = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, invoice!.id));
    expect(relatedPayments.length).toBe(1);
  }, 60000);

  it("auto-recovery: portal payment method update resumes a paused subscription", async () => {
    await createPlanAndSubscribe(`pm_update_resume_${Date.now()}@example.com`);

    // Force failing PM and trigger dunning to create an issued invoice
    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pm) throw new Error("Payment method not found (pm update paused)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pm.id));

    const subDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetail) throw new Error("Subscription detail not found (paused)");
    const pastDate = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDate,
        previousBillingDate: addMinutes(pastDate, -30),
      })
      .where(eq(subscriptionDetails.id, subDetail.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, "issued")
      ),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!invoice) throw new Error("Invoice not created for paused flow");

    // Configure plan-level dunning to pause and enforce immediately by expiring grace
    const sub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    if (!sub) throw new Error("Subscription not found for paused flow");
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId: sub.planId,
        gracePeriodDays: 1,
        endOfDunningAction: "pause_subscription",
      })
      .onConflictDoNothing();

    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, subscriptionId));

    const enforceResp = await fetch(
      `${apiUrl}/trigger/billing/dunning/enforce-grace-periods`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(enforceResp.ok).toBe(true);

    const pausedSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(pausedSub!.status).toBe("paused");

    // Now simulate portal payment method add and completion
    const cust = await db.query.customers.findFirst({
      where: eq(customers.id, customerId),
    });
    if (!cust?.externalCustomerId)
      throw new Error("externalCustomerId not found (paused)");

    const setupResp = await apiClient.customers.portal[
      "create-setup-intent"
    ].$post({
      json: { externalCustomerId: cust.externalCustomerId },
    });
    expect(setupResp.ok).toBe(true);
    const setupJson = (await setupResp.json()) as any;
    const setupIntentId = setupJson?.stripe?.intentId as string;
    expect(typeof setupIntentId).toBe("string");

    await paymentProvider.completePaymentInit({
      intentId: setupIntentId,
      intentType: "setup_intent",
    } as any);
    await paymentProvider.waitForWebhooks(5000);

    const updatedInvoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoice.id),
    });
    expect(updatedInvoice!.status).toBe("paid");

    const resumedSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(resumedSub!.status).toBe("active");
    expect(resumedSub!.gracePeriodEndsAt).toBeNull();
    expect(resumedSub!.endTimestamp).toBeNull();

    const retries = await db.query.paymentRetries.findMany({
      where: eq(paymentRetries.invoiceId, invoice.id),
      orderBy: (paymentRetries, { desc }) => [desc(paymentRetries.createdAt)],
    });
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(retries[0].status).toBe("succeeded");
  }, 70000);

  it("resume helper: after enforced pause, resets billing cycle and credits", async () => {
    // 1) Create plan and subscribe
    const { planId } = await createPlanAndSubscribe(
      `resume_helper_${Date.now()}@example.com`
    );

    // 2) Force failing PM and create an issued invoice (past_due)
    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });
    if (!pm) throw new Error("Payment method not found (resume helper)");
    await db
      .update(paymentMethods)
      .set({ externalPspPaymentMethodId: "pm_card_visa_chargeDeclined" })
      .where(eq(paymentMethods.id, pm.id));

    const subDetailBefore = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!subDetailBefore) throw new Error("Subscription detail not found");
    const pastDate = subDays(testStartTime, 1);
    await db
      .update(subscriptionDetails)
      .set({
        nextBillingDate: pastDate,
        previousBillingDate: addMinutes(pastDate, -30),
      })
      .where(eq(subscriptionDetails.id, subDetailBefore.id));

    await processBillingCycle(apiUrl, triggerApiAccessKey);
    await paymentProvider.waitForWebhooks(3000);

    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.subscriptionId, subscriptionId),
      orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
    });
    if (!invoice) throw new Error("Invoice not created (resume helper)");

    const subPastDue = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subPastDue!.status).toBe("past_due");

    // 3) Configure plan-level dunning to pause and enforce by expiring grace
    await db
      .insert(dunningConfigs)
      .values({
        merchantId,
        planId,
        gracePeriodDays: 1,
        endOfDunningAction: "pause_subscription",
      })
      .onConflictDoNothing();
    await db
      .update(subscriptions)
      .set({ gracePeriodEndsAt: subDays(testStartTime, 1) })
      .where(eq(subscriptions.id, subscriptionId));
    const enforceResp = await fetch(
      `${apiUrl}/trigger/billing/dunning/enforce-grace-periods`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(enforceResp.ok).toBe(true);

    const subPaused = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subPaused!.status).toBe("paused");

    // 4) Seed a plan-scoped usage credit definition and an ACTIVE grant (to be expired/revoked)
    const priceRow = await db.query.prices.findFirst({
      where: and(eq(prices.planId, planId), isNull(prices.deletedAt)),
    });
    if (!priceRow) throw new Error("Price not found for plan (resume helper)");

    const usageDef = await createTestCreditDefinition({
      merchantId,
      scope: "plan",
      applicationType: "usage",
      name: `Resume Helper Credits ${Date.now()}`,
      planId,
      priceId: priceRow.id,
      priceComponentId: "base_fee",
      defaultAmount: 500,
      expiryDays: 30,
      billingVisible: false,
    });

    const manualGrant = await createTestCreditGrant({
      merchantId,
      customerId,
      creditDefinitionId: usageDef.id,
      initialAmount: 500,
      source: "subscription",
    });

    // 5) Pretend we add a new PM later (not strictly necessary for resume helper)
    await db.insert(paymentMethods).values({
      merchantId,
      customerId,
      provider: "stripe",
      paymentType: "card",
      status: "active",
      externalPspPaymentMethodId: "pm_card_visa",
      externalPspCustomerId: pm.externalPspCustomerId,
      lastUsedAt: null,
    });

    // Capture state before resume to compare
    const beforeDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!beforeDetail) throw new Error("Before detail not found");
    const beforeNext = beforeDetail.nextBillingDate!;

    // 6) Manually run resume helper
    const resumedAt = new Date();
    await resumeSubscriptionAndResetCycle({
      subscriptionId,
      resumedAt,
    });

    // 7) Assertions: subscription reset
    const subAfter = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });
    expect(subAfter!.status).toBe("active");
    expect(subAfter!.gracePeriodEndsAt).toBeNull();
    expectDateWithinMargin(subAfter!.startTimestamp!, resumedAt);

    const afterDetail = await db.query.subscriptionDetails.findFirst({
      where: eq(subscriptionDetails.subscriptionId, subscriptionId),
    });
    if (!afterDetail) throw new Error("After detail not found");
    expect(afterDetail.previousBillingDate).toBeNull();
    expect(afterDetail.cyclesBilled).toBe(0);
    expect(afterDetail.nextBillingDate!.getTime()).toBeGreaterThan(
      resumedAt.getTime()
    );
    // Ensure we actually moved the next billing forward from the pre-resume value
    expect(afterDetail.nextBillingDate!.getTime()).toBeGreaterThan(
      beforeNext.getTime()
    );

    // 8) Credits: old grant should be EXPIRED/REVOKED; new grant created for definition
    const oldGrant = await db.query.creditGrants.findFirst({
      where: eq(creditGrants.id, manualGrant.id),
    });
    expect(["EXPIRED", "REVOKED"]).toContain(oldGrant!.status);

    const newGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.merchantId, merchantId),
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.creditDefinitionId, usageDef.id),
        isNull(creditGrants.deletedAt)
      ),
      orderBy: (creditGrants, { desc }) => [desc(creditGrants.createdAt)],
    });
    const newestGrant = newGrants[0];
    expect(newestGrant).toBeDefined();
    expect(newestGrant!.status).toBe("ACTIVE");
  }, 70000);
});
