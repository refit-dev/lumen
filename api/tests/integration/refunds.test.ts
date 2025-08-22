import {
  describe,
  it,
  beforeEach,
  beforeAll,
  afterAll,
  expect,
  setDefaultTimeout,
} from "bun:test";
import { db } from "../../src/db/client";
import {
  customers,
  subscriptions,
  invoices,
  payments,
  refunds,
  subscriptionDetails,
} from "@lumen/common/schema";
import { and, eq, isNull, desc } from "drizzle-orm";
import { hc } from "hono/client";
import { AppType } from "../../src/routes";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestApiKeys,
  createPaymentProvider,
  PaymentProviderAdapter,
  retryWithSleep,
  cleanupDataFull,
} from "../test-helpers";

// Basic address for Dodo tests (tax requirements)
const customerAddressObj = {
  customerAddress: "123 Main St",
  customerCity: "Anytown",
  customerStateProvince: "CA",
  customerZip: "12345",
  customerCountry: "US",
};

setDefaultTimeout(10000);

describe("Refunds API integration", () => {
  let merchantId: string;
  let sessionToken: string;
  let authedApiClient: ReturnType<typeof hc<AppType>>;
  let baseApiClient: ReturnType<typeof hc<AppType>>;
  let publishableApiKey: string;
  let paymentProvider: PaymentProviderAdapter;

  beforeAll(async () => {
    await cleanupDataFull();

    const { merchant, user } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResp = await authenticateTestUser(user.email, user.password);
    sessionToken = authResp.cookies.sessionToken;
    authedApiClient = createTestApiClient(sessionToken);
    baseApiClient = createTestApiClient();

    paymentProvider = await createPaymentProvider();
    await paymentProvider.registerIntegration(merchantId);
    await paymentProvider.startWebhookForwarder(merchantId);

    const apiKeys = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    publishableApiKey = apiKeys.publishableKey.keyValue;
  });

  afterAll(async () => {
    await paymentProvider.cleanup();
    await cleanupDataFull();
  });

  beforeEach(async () => {
    // Clean data but keep merchant/provider setup intact
    await cleanupDataFull();
  });

  it("issues a partial refund and updates payment/refund records", async () => {
    const ts = Date.now();
    const customerEmail = `refunds-partial-${ts}@example.com`;
    const customerName = "Refunds Partial";
    const userId = `user-refunds-partial-${ts}`;

    const planRes = await createTestPlanWithFeatures(merchantId, [], {
      stablePlanId: `rf-partial-plan-${ts}`,
      versionNumber: 1,
      planName: "Refunds Partial Plan",
    });
    const planId = planRes.plan.id;

    const price = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base_fee",
            type: "fixed",
            label: "Base Fee",
            amount_cents: 2000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    const initResp = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: price.id,
        planId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    expect(initResp.status).toBe(200);
    const initData = await initResp.json();
    if ("error" in initData) throw new Error(String(initData.error));

    await paymentProvider.completePaymentInit(initData);
    await paymentProvider.waitForWebhooks(2000);

    const customer = await retryWithSleep({
      fn: () =>
        db.query.customers.findFirst({
          where: and(
            eq(customers.merchantId, merchantId),
            eq(customers.email, customerEmail),
            isNull(customers.deletedAt)
          ),
        }),
      validate: (r) => !!r,
    });

    const subscription = await retryWithSleep({
      fn: () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customer!.id),
            eq(subscriptions.planId, planId)
          ),
        }),
      validate: (r) => !!r,
    });

    const firstInvoice = await retryWithSleep({
      fn: () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscription!.id),
            eq(invoices.status, "paid")
          ),
          orderBy: desc(invoices.createdAt),
        }),
      validate: (r) => !!r,
    });

    const payment = await retryWithSleep({
      fn: () =>
        db.query.payments.findFirst({
          where: eq(payments.invoiceId, firstInvoice!.id),
        }),
      validate: (r) => !!r && !!r.externalPaymentId,
    });

    // Call refunds API for partial amount
    const refundsResp = await authedApiClient.subscriptions[
      ":id"
    ].refunds.$post({
      param: { id: subscription!.stableSubscriptionId },
      json: {
        paymentId: payment!.id,
        amountCents: 500,
        reason: "test partial refund",
      },
    });

    expect(refundsResp.status).toBe(200);
    const refundsData = await refundsResp.json();
    expect("success" in refundsData ? refundsData.success : false).toBe(true);
    expect("refund" in refundsData && refundsData.refund.amountCents).toBe(500);

    const updatedPayment = await db.query.payments.findFirst({
      where: eq(payments.id, payment!.id),
    });
    expect(updatedPayment!.refundedAmountCents).toBe(500);
    expect(updatedPayment!.refundStatus).toBe("partial");

    const refundRow = await db.query.refunds.findFirst({
      where: and(
        eq(refunds.paymentId, payment!.id),
        eq(refunds.merchantId, merchantId)
      ),
    });
    expect(refundRow).toBeDefined();
    expect(refundRow!.amountCents).toBe(500);
    expect(refundRow!.status).toBe("succeeded");

    // Subscription should NOT be terminated
    const freshSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscription!.id),
    });
    expect(freshSub!.endTimestamp).toBeNull();
  });

  it("issues a full refund (no amount specified) and marks payment fully refunded", async () => {
    const ts = Date.now();
    const customerEmail = `refunds-full-${ts}@example.com`;
    const customerName = "Refunds Full";
    const userId = `user-refunds-full-${ts}`;

    const planRes = await createTestPlanWithFeatures(merchantId, [], {
      stablePlanId: `rf-full-plan-${ts}`,
      versionNumber: 1,
      planName: "Refunds Full Plan",
    });
    const planId = planRes.plan.id;

    const price = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base_fee",
            type: "fixed",
            label: "Base Fee",
            amount_cents: 3000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    const initResp = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: price.id,
        planId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    expect(initResp.status).toBe(200);
    const initData = await initResp.json();
    if ("error" in initData) throw new Error(String(initData.error));

    await paymentProvider.completePaymentInit(initData);
    await paymentProvider.waitForWebhooks(2000);

    const customer = await retryWithSleep({
      fn: () =>
        db.query.customers.findFirst({
          where: and(
            eq(customers.merchantId, merchantId),
            eq(customers.email, customerEmail),
            isNull(customers.deletedAt)
          ),
        }),
      validate: (r) => !!r,
    });

    const subscription = await retryWithSleep({
      fn: () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customer!.id),
            eq(subscriptions.planId, planId)
          ),
        }),
      validate: (r) => !!r,
    });

    const firstInvoice = await retryWithSleep({
      fn: () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscription!.id),
            eq(invoices.status, "paid")
          ),
          orderBy: desc(invoices.createdAt),
        }),
      validate: (r) => !!r,
    });

    const payment = await retryWithSleep({
      fn: () =>
        db.query.payments.findFirst({
          where: eq(payments.invoiceId, firstInvoice!.id),
        }),
      validate: (r) => !!r && !!r.externalPaymentId,
    });

    const refundResp = await authedApiClient.subscriptions[":id"].refunds.$post(
      {
        param: { id: subscription!.stableSubscriptionId },
        json: {
          paymentId: payment!.id,
          reason: "full refund",
        },
      }
    );
    expect(refundResp.status).toBe(200);
    const refundData = await refundResp.json();
    expect("success" in refundData ? refundData.success : false).toBe(true);

    const refreshedPayment = await db.query.payments.findFirst({
      where: eq(payments.id, payment!.id),
    });
    expect(refreshedPayment!.refundedAmountCents).toBe(
      refreshedPayment!.amountCents
    );
    expect(refreshedPayment!.refundStatus).toBe("full");

    const refundRow = await db.query.refunds.findFirst({
      where: and(
        eq(refunds.paymentId, payment!.id),
        eq(refunds.merchantId, merchantId)
      ),
      orderBy: desc(refunds.createdAt),
    });
    expect(refundRow).toBeDefined();
    expect(refundRow!.amountCents).toBe(refreshedPayment!.amountCents);
    expect(refundRow!.status).toBe("succeeded");
  });

  it("terminates subscription when refund requested with termination", async () => {
    const ts = Date.now();
    const customerEmail = `refunds-term-${ts}@example.com`;
    const customerName = "Refunds Terminate";
    const userId = `user-refunds-term-${ts}`;

    const planRes = await createTestPlanWithFeatures(merchantId, [], {
      stablePlanId: `rf-term-plan-${ts}`,
      versionNumber: 1,
      planName: "Refunds Termination Plan",
    });
    const planId = planRes.plan.id;

    const price = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base_fee",
            type: "fixed",
            label: "Base Fee",
            amount_cents: 1500,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    const initResp = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: price.id,
        planId,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    expect(initResp.status).toBe(200);
    const initData = await initResp.json();
    if ("error" in initData) throw new Error(String(initData.error));

    await paymentProvider.completePaymentInit(initData);
    await paymentProvider.waitForWebhooks(2000);

    const customer = await retryWithSleep({
      fn: () =>
        db.query.customers.findFirst({
          where: and(
            eq(customers.merchantId, merchantId),
            eq(customers.email, customerEmail),
            isNull(customers.deletedAt)
          ),
        }),
      validate: (r) => !!r,
    });

    const subscription = await retryWithSleep({
      fn: () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customer!.id),
            eq(subscriptions.planId, planId)
          ),
        }),
      validate: (r) => !!r,
    });

    const firstInvoice = await retryWithSleep({
      fn: () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.subscriptionId, subscription!.id),
            eq(invoices.status, "paid")
          ),
          orderBy: desc(invoices.createdAt),
        }),
      validate: (r) => !!r,
    });

    const payment = await retryWithSleep({
      fn: () =>
        db.query.payments.findFirst({
          where: eq(payments.invoiceId, firstInvoice!.id),
        }),
      validate: (r) => !!r && !!r.externalPaymentId,
    });

    const refundResp = await authedApiClient.subscriptions[":id"].refunds.$post(
      {
        param: { id: subscription!.stableSubscriptionId },
        json: {
          paymentId: payment!.id,
          reason: "terminate with refund",
          terminateSubscription: true,
        },
      }
    );
    expect(refundResp.status).toBe(200);
    const respData = await refundResp.json();
    expect("success" in respData ? respData.success : false).toBe(true);
    expect("terminated" in respData && respData.terminated).toBe(true);

    const endedSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscription!.id),
    });
    expect(endedSub!.endTimestamp).not.toBeNull();

    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscription!.id),
    });
    if (subDetails.length > 0) {
      expect(subDetails.every((d) => d.deletedAt !== null)).toBe(true);
    }
  });
});
