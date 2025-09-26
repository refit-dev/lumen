import {
  describe,
  it,
  beforeEach,
  afterEach,
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
  invoiceLineItems,
  merchants,
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
  createTestCustomer,
  createTestApiKeys,
  createPaymentProvider,
  PaymentProviderAdapter,
  retryWithSleep,
  cleanupDataFull,
} from "../test-helpers";

// Realistic address for Dodo tests (consistent US/CA address)
const customerAddressObj = {
  customerAddress: "1600 Amphitheatre Pkwy",
  customerCity: "Mountain View",
  customerStateProvince: "CA",
  customerZip: "94043",
  customerCountry: "US",
};

// Business details to help Dodo tax calculation (B2B context)
const customerBusinessObj = {
  businessName: "Google LLC",
  taxId: "770493581",
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
    // Do a full cleanup before any tests run
    await cleanupDataFull({ deleteTestSetupData: true });
    paymentProvider = await createPaymentProvider();
  });

  afterAll(async () => {
    await paymentProvider.cleanup();
    // Full cleanup after all tests are done
    await cleanupDataFull({ deleteTestSetupData: true });
  });

  beforeEach(async () => {
    // Setup fresh environment for each test for full isolation
    const { merchant, user } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResp = await authenticateTestUser(user.email, user.password);
    sessionToken = authResp.cookies.sessionToken;
    authedApiClient = createTestApiClient(sessionToken);
    baseApiClient = createTestApiClient();

    await paymentProvider.registerIntegration(merchantId);
    await paymentProvider.startWebhookForwarder(merchantId);

    const apiKeys = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    publishableApiKey = apiKeys.publishableKey.keyValue;
  });

  afterEach(async () => {
    // Cleanup provider resources and all DB data after each test
    await paymentProvider.cleanup();
    await cleanupDataFull({ deleteTestSetupData: true });
  });

  it("issues a partial refund and updates payment and refund records", async () => {
    // Enable auto tax calculation
    await authedApiClient.tax.config.update.$post({
      json: { autoTaxCalculation: true },
    });

    // Set merchant location to trigger tax
    await db
      .update(merchants)
      .set({ country: "US", stateProvince: "CA" })
      .where(eq(merchants.id, merchantId));

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

    // Ensure customer is initialized with full details for Dodo tax
    await createTestCustomer({
      merchantId,
      email: customerEmail,
      name: customerName,
      businessName: customerBusinessObj.businessName,
      taxId: customerBusinessObj.taxId,
      externalCustomerId: userId,
      billingAddressLine1: customerAddressObj.customerAddress,
      billingCity: customerAddressObj.customerCity,
      billingStateProvince: customerAddressObj.customerStateProvince,
      billingPostalCode: customerAddressObj.customerZip,
      billingCountry: customerAddressObj.customerCountry,
    });

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

    // Provider-specific first tax calculation (Stripe only; Dodo no-op)
    const initialTaxData = await paymentProvider.firstTaxCalculation({
      apiClient: baseApiClient,
      publishableApiKey,
      planId,
      priceId: price.id,
      subtotalCents: 3000,
      currency: "USD",
      customerCountry: customerAddressObj.customerCountry,
      customerStateProvince: customerAddressObj.customerStateProvince,
      taxId: customerBusinessObj.taxId,
      businessName: customerBusinessObj.businessName,
    });

    const initResp = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: price.id,
        planId,
        customerEmail,
        customerName,
        userId,
        ...customerAddressObj,
        ...customerBusinessObj,
        ...(initialTaxData ? { taxData: initialTaxData } : {}),
      },
    });
    expect(initResp.status).toBe(200);
    const initData = await initResp.json();
    if ("error" in initData) throw new Error(String(initData.error));

    await paymentProvider.completePaymentInit(initData);
    await paymentProvider.waitForWebhooks(3000);

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

    // Assert tax on original invoice (provider-aware)
    expect(firstInvoice).toBeDefined();
    if (paymentProvider.name === "stripe") {
      expect(firstInvoice!.taxAmountCents).toBeGreaterThan(0);
    } else {
      expect(firstInvoice!.taxAmountCents ?? 0).toBeGreaterThanOrEqual(0);
    }
    const originalTaxAmount = firstInvoice!.taxAmountCents!;
    const originalSubtotalAmount = firstInvoice!.subtotalCents!;
    const originalTotalAmount = firstInvoice!.totalAmountCents!;
    expect(originalTotalAmount).toBe(
      originalSubtotalAmount + originalTaxAmount
    );

    const payment = await retryWithSleep({
      fn: () =>
        db.query.payments.findFirst({
          where: eq(payments.invoiceId, firstInvoice!.id),
        }),
      validate: (r) => !!r && !!r.externalPaymentId,
    });

    // Call refunds API for partial amount
    const refundAmountCents = 500;
    const refundsResp = await authedApiClient.subscriptions[
      ":id"
    ].refunds.$post({
      param: { id: subscription!.stableSubscriptionId },
      json: {
        paymentId: payment!.id,
        amountCents: refundAmountCents,
        reason: "test partial refund",
      },
    });

    expect(refundsResp.status).toBe(200);
    const refundsData = await refundsResp.json();
    expect("success" in refundsData ? refundsData.success : false).toBe(true);
    expect("refund" in refundsData && refundsData.refund.amountCents).toBe(
      refundAmountCents
    );

    // Verify credit note (adjustment invoice) created and linked to original
    const adjustmentInvoiceId = (refundsData as any).adjustmentInvoiceId as
      | string
      | null;
    expect(adjustmentInvoiceId).toBeTruthy();

    const creditNote = await db.query.invoices.findFirst({
      where: eq(invoices.id, adjustmentInvoiceId!),
      with: { lineItems: true },
    });
    expect(creditNote).toBeTruthy();
    expect((creditNote as any).documentType).toBe("credit_note");
    expect(creditNote!.originalInvoiceId).toBe(firstInvoice!.id);
    expect(creditNote!.currency).toBe("USD");
    expect(creditNote!.totalAmountCents).toBe(refundAmountCents);

    // subtotal should be less than total when tax was present on original
    const expectedRefundedTax = Math.round(
      (refundAmountCents * originalTaxAmount) / originalTotalAmount
    );
    const expectedRefundedSubtotal = refundAmountCents - expectedRefundedTax;

    expect(creditNote!.subtotalCents).toBe(expectedRefundedSubtotal);
    expect(creditNote!.taxAmountCents).toBe(expectedRefundedTax);

    // Sum of line items should equal invoice total
    const cnItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, creditNote!.id),
    });
    const cnSum = cnItems.reduce((sum, li) => sum + (li.subtotalCents || 0), 0);
    expect(cnSum).toBe(creditNote!.totalAmountCents);

    // Original invoice should list this adjustment
    const adjustmentsForOriginal = await db.query.invoices.findMany({
      where: and(
        eq(invoices.originalInvoiceId, firstInvoice!.id),
        eq(invoices.merchantId, merchantId)
      ),
    });
    expect(adjustmentsForOriginal.some((a) => a.id === creditNote!.id)).toBe(
      true
    );

    const updatedPayment = await db.query.payments.findFirst({
      where: eq(payments.id, payment!.id),
    });
    expect(updatedPayment!.refundedAmountCents).toBe(refundAmountCents);
    expect(updatedPayment!.refundStatus).toBe("partial");

    const refundRow = await db.query.refunds.findFirst({
      where: and(
        eq(refunds.paymentId, payment!.id),
        eq(refunds.merchantId, merchantId)
      ),
    });
    expect(refundRow).toBeDefined();
    expect(refundRow!.amountCents).toBe(refundAmountCents);
    expect(refundRow!.status).toBe("succeeded");

    // Subscription should NOT be terminated
    const freshSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscription!.id),
    });
    expect(freshSub!.endTimestamp).toBeNull();
  }, 30000);

  it("issues a full refund - no amount specified - and marks payment fully refunded", async () => {
    // Enable auto tax calculation
    await authedApiClient.tax.config.update.$post({
      json: { autoTaxCalculation: true },
    });

    // Set merchant location to trigger tax
    await db
      .update(merchants)
      .set({ country: "US", stateProvince: "CA" })
      .where(eq(merchants.id, merchantId));

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

    // Ensure customer is initialized with full details for Dodo tax
    await createTestCustomer({
      merchantId,
      email: customerEmail,
      name: customerName,
      businessName: customerBusinessObj.businessName,
      taxId: customerBusinessObj.taxId,
      externalCustomerId: userId,
      billingAddressLine1: customerAddressObj.customerAddress,
      billingCity: customerAddressObj.customerCity,
      billingStateProvince: customerAddressObj.customerStateProvince,
      billingPostalCode: customerAddressObj.customerZip,
      billingCountry: customerAddressObj.customerCountry,
    });

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

    // Provider-specific first tax calculation (Stripe only; Dodo no-op)
    const initialTaxData = await paymentProvider.firstTaxCalculation({
      apiClient: baseApiClient,
      publishableApiKey,
      planId,
      priceId: price.id,
      subtotalCents: 3000,
      currency: "USD",
      customerCountry: customerAddressObj.customerCountry,
      customerStateProvince: customerAddressObj.customerStateProvince,
      taxId: customerBusinessObj.taxId,
      businessName: customerBusinessObj.businessName,
    });

    const initResp = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: price.id,
        planId,
        customerEmail,
        customerName,
        userId,
        ...customerAddressObj,
        ...customerBusinessObj,
        ...(initialTaxData ? { taxData: initialTaxData } : {}),
      },
    });
    expect(initResp.status).toBe(200);
    const initData = await initResp.json();
    if ("error" in initData) throw new Error(String(initData.error));

    await paymentProvider.completePaymentInit(initData);
    await paymentProvider.waitForWebhooks(3000);

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

    // Assert tax on original invoice (provider-aware)
    expect(firstInvoice).toBeDefined();
    if (paymentProvider.name === "stripe") {
      expect(firstInvoice!.taxAmountCents).toBeGreaterThan(0);
    } else {
      expect(firstInvoice!.taxAmountCents ?? 0).toBeGreaterThanOrEqual(0);
    }

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

    // Verify cancellation invoice (adjustment invoice) created and linked
    const cancelAdjustmentInvoiceId = (refundData as any)
      .adjustmentInvoiceId as string | null;
    expect(cancelAdjustmentInvoiceId).toBeTruthy();

    const cancellation = await db.query.invoices.findFirst({
      where: eq(invoices.id, cancelAdjustmentInvoiceId!),
      with: { lineItems: true },
    });
    expect(cancellation).toBeTruthy();
    expect((cancellation as any).documentType).toBe("cancellation");
    expect(cancellation!.originalInvoiceId).toBe(firstInvoice!.id);
    // Totals should match the original invoice totals
    expect(cancellation!.totalAmountCents).toBe(firstInvoice!.totalAmountCents);
    expect(cancellation!.subtotalCents).toBe(firstInvoice!.subtotalCents);
    expect(cancellation!.taxAmountCents).toBe(firstInvoice!.taxAmountCents);

    // Sum of line items should equal invoice total
    const cancItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, cancellation!.id),
    });
    const cancSum = cancItems.reduce(
      (sum, li) => sum + (li.subtotalCents || 0),
      0
    );
    expect(cancSum).toBe(cancellation!.totalAmountCents);

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
  }, 30000);

  it("terminates subscription when refund requested with termination", async () => {
    // Enable auto tax calculation
    await authedApiClient.tax.config.update.$post({
      json: { autoTaxCalculation: true },
    });

    // Set merchant location to trigger tax
    await db
      .update(merchants)
      .set({ country: "US", stateProvince: "CA" })
      .where(eq(merchants.id, merchantId));

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

    // Ensure customer is initialized with full details for Dodo tax
    await createTestCustomer({
      merchantId,
      email: customerEmail,
      name: customerName,
      businessName: customerBusinessObj.businessName,
      taxId: customerBusinessObj.taxId,
      externalCustomerId: userId,
      billingAddressLine1: customerAddressObj.customerAddress,
      billingCity: customerAddressObj.customerCity,
      billingStateProvince: customerAddressObj.customerStateProvince,
      billingPostalCode: customerAddressObj.customerZip,
      billingCountry: customerAddressObj.customerCountry,
    });

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

    // Provider-specific first tax calculation (Stripe only; Dodo no-op)
    const initialTaxData = await paymentProvider.firstTaxCalculation({
      apiClient: baseApiClient,
      publishableApiKey,
      planId,
      priceId: price.id,
      subtotalCents: 1500,
      currency: "USD",
      customerCountry: customerAddressObj.customerCountry,
      customerStateProvince: customerAddressObj.customerStateProvince,
      taxId: customerBusinessObj.taxId,
      businessName: customerBusinessObj.businessName,
    });

    const initResp = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: price.id,
        planId,
        customerEmail,
        customerName,
        userId,
        ...customerAddressObj,
        ...customerBusinessObj,
        ...(initialTaxData ? { taxData: initialTaxData } : {}),
      },
    });
    expect(initResp.status).toBe(200);
    const initData = await initResp.json();
    if ("error" in initData) throw new Error(String(initData.error));

    await paymentProvider.completePaymentInit(initData);
    await paymentProvider.waitForWebhooks(3000);

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

    // Assert tax on original invoice (provider-aware)
    expect(firstInvoice).toBeDefined();
    if (paymentProvider.name === "stripe") {
      expect(firstInvoice!.taxAmountCents).toBeGreaterThan(0);
    } else {
      expect(firstInvoice!.taxAmountCents ?? 0).toBeGreaterThanOrEqual(0);
    }

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

    // Verify cancellation invoice (adjustment invoice) created and linked
    const cancelAdjustmentInvoiceId = (respData as any).adjustmentInvoiceId as
      | string
      | null;
    expect(cancelAdjustmentInvoiceId).toBeTruthy();

    const cancellation = await db.query.invoices.findFirst({
      where: eq(invoices.id, cancelAdjustmentInvoiceId!),
      with: { lineItems: true },
    });
    expect(cancellation).toBeTruthy();
    expect((cancellation as any).documentType).toBe("cancellation");
    expect(cancellation!.originalInvoiceId).toBe(firstInvoice!.id);
    // Totals should match the original invoice totals
    expect(cancellation!.totalAmountCents).toBe(firstInvoice!.totalAmountCents);
    expect(cancellation!.subtotalCents).toBe(firstInvoice!.subtotalCents);
    expect(cancellation!.taxAmountCents).toBe(firstInvoice!.taxAmountCents);

    // Sum of line items should equal invoice total
    const cancItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, cancellation!.id),
    });
    const cancSum = cancItems.reduce(
      (sum, li) => sum + (li.subtotalCents || 0),
      0
    );
    expect(cancSum).toBe(cancellation!.totalAmountCents);

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
  }, 30000);
});
