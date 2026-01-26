import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { addDays } from "date-fns";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../src/db/client";
import {
  creditGrants,
  creditDefinitions,
  creditUsageTransactions,
  invoices,
  invoiceLineItems,
  payments,
  paymentMethods,
  subscriptionDetails,
  subscriptions,
  subscriptionsScheduledChanges,
  subscriptionPriceOverrides,
  subscriptionFeatures,
  FeatureType,
  customers,
  plans,
  prices,
  features,
  featureMetrics,
  metrics,
  planFeatures,
  pricingTables,
  pricingTablePlans,
  events,
  customerInvoiceCounters,
} from "@lumen/common/schema";
import {
  authenticateTestUser,
  createFullTestEnvironment,
  createTestApiClient,
  createTestCreditDefinition,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestApiKeys,
  createPaymentProvider,
  PaymentProviderAdapter,
  cleanupDataFull,
} from "../test-helpers";
import type { ClientType } from "../test-helpers/api/client";
import { FeatureValue } from "../test-helpers/data/feature";
import { sleep } from "../test-helpers/sleep";

const customerAddressObj = {
  customerAddress: "123 Main St",
  customerCity: "Anytown",
  customerStateProvince: "CA",
  customerZip: "12345",
  customerCountry: "US",
};

// Lighter cleanup that doesn't delete merchant/user/payment provider config
const cleanupTestData = async () => {
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
      DELETE FROM ${subscriptionsScheduledChanges};
      DELETE FROM ${subscriptionPriceOverrides};
      DELETE FROM ${paymentMethods};
      DELETE FROM ${customerInvoiceCounters};
      DELETE FROM ${customers};
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

async function retryWithSleep<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean = (result) =>
    result !== undefined && result !== null,
  maxAttempts = 10,
  sleepMs = 1000
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

type TopupTestContext = {
  creditDefinitionId: string;
  externalCustomerId: string;
  customerId: string;
  subscriptionId: string;
  nextBillingDate: Date;
  featureName: string;
  pricePerCredit: number;
};

describe("Credit top-ups mid-cycle flow", () => {
  let merchantId: string;
  let sessionToken: string;
  let authedApiClient: ClientType;
  let baseApiClient: ClientType;
  let publishableApiKey: string;
  let paymentProvider: PaymentProviderAdapter;

  beforeAll(async () => {
    await cleanupDataFull();
    paymentProvider = await createPaymentProvider();
  });

  afterAll(async () => {
    if (paymentProvider) {
      await paymentProvider.cleanup();
    }
    await cleanupDataFull();
  });

  beforeEach(async () => {
    // Create fresh test environment for each test (following seat-plans pattern)
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Register payment provider integration for this merchant
    await paymentProvider.registerIntegration(merchantId);

    // Generate API keys
    const { publishableKey } = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    publishableApiKey = publishableKey.rawKeyValue;

    // Authenticate
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
    authedApiClient = createTestApiClient(sessionToken);
    baseApiClient = createTestApiClient();

    // Start webhook forwarder
    await paymentProvider.startWebhookForwarder(merchantId);
  });

  afterEach(async () => {
    // Cleanup in proper order (following seat-plans pattern)
    if (paymentProvider) {
      await paymentProvider.cleanup();
    }
    await cleanupTestData();
  });

  async function setupTopupScenario(): Promise<TopupTestContext> {
    const uniqueSuffix = Date.now();
    const featureSlug = `ai-credits-${uniqueSuffix}`;
    const customerEmail = `topup-user-${uniqueSuffix}@example.com`;
    const customerName = `Topup User ${uniqueSuffix}`;
    const userId = `user-topup-${uniqueSuffix}`;

    const { plan, features: planFeaturesList } =
      await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: featureSlug,
            displayName: "AI Chat Credits",
            description: "Usage-based entitlements for AI chats",
            featureValue: "usage_based" as FeatureValue,
            featureType: "number" as FeatureType,
          },
        ],
        {
          planName: `Topup Ready Plan ${uniqueSuffix}`,
          planDescription: "Plan configured for on-demand credit purchases",
          stablePlanId: `topup-plan-${uniqueSuffix}`,
        }
      );

    const price = await createTestPrice({
      planId: plan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly",
            type: "fixed",
            label: "Monthly Subscription",
            amount_cents: 5000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    const usageFeature = planFeaturesList[0];

    const creditDefinition = await createTestCreditDefinition({
      merchantId,
      scope: "plan",
      applicationType: "usage",
      name: "AI Chat Allowance",
      description: "Credit allowance with mid-cycle top-ups",
      planId: plan.id,
      featureId: usageFeature.id,
      featureSlug,
      priceId: price.id,
      currency: "USD",
      defaultAmount: 1000,
      enableTopups: true,
      topupPricePerCreditCents: 45,
      topupMinQuantity: 25,
      topupMaxQuantity: 1000,
      topupExpiryBehavior: "billing_cycle",
    });

    // Create subscription via payment-init
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: price.id,
        planId: plan.id,
        customerEmail,
        customerName,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData) {
      throw new Error(`Payment init failed: ${paymentInitData.error}`);
    }

    // Complete payment and wait for webhooks (following seat-plans pattern)
    await paymentProvider.completePaymentInit(paymentInitData);
    await paymentProvider.waitForWebhooks();

    // Find the created customer with retry
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

    if (!customer) {
      throw new Error(`Customer not found for email ${customerEmail}`);
    }

    // Find the subscription with retry
    const subscription = await retryWithSleep(
      () =>
        db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.customerId, customer.id),
            eq(subscriptions.planId, plan.id),
            isNull(subscriptions.deletedAt)
          ),
        }),
      (result) => !!result
    );

    if (!subscription) {
      throw new Error(`Subscription not found for customer ${customer.id}`);
    }

    // Get subscription details
    const subDetail = await retryWithSleep(
      () =>
        db.query.subscriptionDetails.findFirst({
          where: eq(subscriptionDetails.subscriptionId, subscription.id),
        }),
      (result) => !!result
    );

    if (!subDetail) {
      throw new Error(
        `Subscription details not found for subscription ${subscription.id}`
      );
    }

    // Verify payment method was created
    const paymentMethod = await retryWithSleep(
      () =>
        db.query.paymentMethods.findFirst({
          where: and(
            eq(paymentMethods.customerId, customer.id),
            isNull(paymentMethods.deletedAt)
          ),
        }),
      (result) => !!result
    );

    if (!paymentMethod) {
      throw new Error(`Payment method not found for customer ${customer.id}`);
    }
    console.log(`Payment method created: ${paymentMethod.id}`);

    const externalCustomerId =
      customer.externalCustomerId || userId || customer.id;

    return {
      creditDefinitionId: creditDefinition.id,
      externalCustomerId,
      customerId: customer.id,
      subscriptionId: subscription.id,
      nextBillingDate: subDetail.nextBillingDate || addDays(new Date(), 21),
      featureName: usageFeature.displayName,
      pricePerCredit: creditDefinition.topupPricePerCreditCents || 0,
    };
  }

  it("should invoice and grant credits for a mid-cycle topup purchase", async () => {
    const context = await setupTopupScenario();
    const idempotencyKey = `topup-${Date.now()}`;
    const quantity = 120;

    // Verify available topups endpoint works
    const availableRes = await authedApiClient.credits["available-topups"].$get(
      {
        query: { externalCustomerId: context.externalCustomerId },
      }
    );
    expect(availableRes.status).toBe(200);
    const availableBody = await availableRes.json();
    if ("error" in availableBody) {
      throw new Error(
        `Failed to fetch available topups: ${availableBody.error}`
      );
    }
    expect(availableBody.availableTopups).toHaveLength(1);
    const availableTopup = availableBody.availableTopups[0];
    expect(availableTopup.creditDefinitionId).toBe(context.creditDefinitionId);
    expect(availableTopup.expiryBehavior).toBe("billing_cycle");
    expect(availableTopup.estimatedExpiryDate).toBe(
      context.nextBillingDate.toISOString()
    );
    expect(availableTopup.minQuantity).toBe(25);
    expect(availableTopup.maxQuantity).toBe(1000);
    expect(availableTopup.topupPricePerCreditCents).toBe(
      context.pricePerCredit
    );

    // Purchase topup - payment-first flow
    const purchaseRes = await authedApiClient.credits.topup.$post({
      json: {
        externalCustomerId: context.externalCustomerId,
        creditDefinitionId: context.creditDefinitionId,
        quantity,
        idempotencyKey,
      },
    });
    expect(purchaseRes.status).toBe(201);
    const purchaseBody = await purchaseRes.json();
    if ("error" in purchaseBody) {
      throw new Error(`Topup purchase failed: ${purchaseBody.error}`);
    }

    // New payment-first flow: API returns payment info, credits/invoice created via webhook
    expect(purchaseBody.success).toBe(true);
    expect(purchaseBody.payment.id).toBeTruthy();
    expect(purchaseBody.expectedCredits.quantity).toBe(quantity);
    expect(purchaseBody.totalAmountCents).toBe(
      quantity * context.pricePerCredit
    );

    // Wait for webhook to process the topup payment
    console.log("Waiting for topup webhook...");
    await paymentProvider.waitForWebhooks(5000);

    // Invoice is created by webhook, find it by reference code in notes
    const invoiceRecord = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.customerId, context.customerId),
            eq(invoices.status, "paid")
          ),
          with: { lineItems: true },
          orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
        }),
      (invoice) => !!invoice && !!invoice.notes?.includes(idempotencyKey)
    );
    expect(invoiceRecord).toBeDefined();
    expect(invoiceRecord!.customerId).toBe(context.customerId);
    expect(invoiceRecord!.subscriptionId).toBe(context.subscriptionId);
    expect(invoiceRecord!.notes).toContain(idempotencyKey);
    expect(invoiceRecord!.status).toBe("paid");
    const nonTaxLineItems = invoiceRecord!.lineItems.filter(
      (item) => item.type !== "tax"
    );
    expect(nonTaxLineItems).toHaveLength(1);
    const lineItem = nonTaxLineItems[0];
    expect(lineItem.type).toBe("credit_topup");
    expect(lineItem.quantity).toBe(quantity);
    expect(lineItem.unitAmountCents).toBe(context.pricePerCredit);
    expect(lineItem.subtotalCents).toBe(quantity * context.pricePerCredit);
    expect(lineItem.billingPeriodEnd?.toISOString()).toBe(
      context.nextBillingDate.toISOString()
    );
    expect(lineItem.description).toBe(
      `Top-up: ${quantity} ${context.featureName}`
    );

    // Payment record should be linked to invoice and succeeded
    const paymentRecord = await retryWithSleep(
      () =>
        db.query.payments.findFirst({
          where: eq(payments.invoiceId, invoiceRecord!.id),
        }),
      (payment) => !!payment && payment.status === "succeeded"
    );
    expect(paymentRecord!.metadata?.is_topup).toBe("true");
    expect(paymentRecord!.metadata?.topup_credit_definition_id).toBe(
      context.creditDefinitionId
    );
    expect(paymentRecord!.metadata?.topup_customer_id).toBe(context.customerId);
    expect(paymentRecord!.metadata?.topup_quantity).toBe(String(quantity));
    expect(paymentRecord!.metadata?.topup_expiry_date).toBe(
      context.nextBillingDate.toISOString()
    );
    expect(paymentRecord!.metadata?.topup_reference_code).toBe(idempotencyKey);

    const createdGrant = await retryWithSleep(
      () =>
        db.query.creditGrants.findFirst({
          where: and(
            eq(creditGrants.customerId, context.customerId),
            eq(creditGrants.creditDefinitionId, context.creditDefinitionId),
            eq(creditGrants.source, "topup"),
            isNull(creditGrants.deletedAt)
          ),
        }),
      (grant) => !!grant
    );
    expect(createdGrant!.initialAmount).toBe(quantity);
    expect(createdGrant!.remainingAmount).toBe(quantity);
    expect(createdGrant!.expiryDate?.toISOString()).toBe(
      context.nextBillingDate.toISOString()
    );
    expect(createdGrant!.referenceCode).toBe(idempotencyKey);
    expect(createdGrant!.status).toBe("ACTIVE");

    const grantsAfter = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, context.customerId),
        eq(creditGrants.source, "topup"),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(grantsAfter).toHaveLength(1);
  }, 90000);

  it("should reuse invoice and grant when a topup purchase is retried with the same idempotency key", async () => {
    const context = await setupTopupScenario();
    const idempotencyKey = `idempotent-${Date.now()}`;
    const quantity = 60;

    // First purchase - initiates payment
    const firstPurchaseRes = await authedApiClient.credits.topup.$post({
      json: {
        externalCustomerId: context.externalCustomerId,
        creditDefinitionId: context.creditDefinitionId,
        quantity,
        idempotencyKey,
      },
    });
    expect(firstPurchaseRes.status).toBe(201);
    const firstBody = await firstPurchaseRes.json();
    if ("error" in firstBody) {
      throw new Error(`Initial purchase failed: ${firstBody.error}`);
    }

    // Wait for webhook to process
    console.log("Waiting for first topup webhook...");
    await paymentProvider.waitForWebhooks(5000);

    // Wait for invoice to be created by webhook
    const firstInvoice = await retryWithSleep(
      () =>
        db.query.invoices.findFirst({
          where: and(
            eq(invoices.customerId, context.customerId),
            eq(invoices.status, "paid")
          ),
          orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
        }),
      (invoice) => !!invoice && !!invoice.notes?.includes(idempotencyKey)
    );
    expect(firstInvoice).toBeDefined();

    const firstPayment = await retryWithSleep(
      () =>
        db.query.payments.findFirst({
          where: eq(payments.invoiceId, firstInvoice!.id),
        }),
      (payment) => !!payment && payment.status === "succeeded"
    );

    const firstGrant = await retryWithSleep(
      () =>
        db.query.creditGrants.findFirst({
          where: and(
            eq(creditGrants.customerId, context.customerId),
            eq(creditGrants.creditDefinitionId, context.creditDefinitionId),
            eq(creditGrants.source, "topup"),
            isNull(creditGrants.deletedAt)
          ),
        }),
      (grant) => !!grant
    );

    const invoicesBefore = await db.query.invoices.findMany({
      where: eq(invoices.customerId, context.customerId),
    });
    const paymentsBefore = await db.query.payments.findMany({
      where: eq(payments.invoiceId, firstInvoice!.id),
    });

    // Duplicate purchase with same idempotency key - should return existing data
    const duplicateRes = await authedApiClient.credits.topup.$post({
      json: {
        externalCustomerId: context.externalCustomerId,
        creditDefinitionId: context.creditDefinitionId,
        quantity,
        idempotencyKey,
      },
    });
    expect(duplicateRes.status).toBe(201);
    const duplicateBody = await duplicateRes.json();
    if ("error" in duplicateBody) {
      throw new Error(`Duplicate purchase failed: ${duplicateBody.error}`);
    }

    // Idempotent response should return existing data
    expect(duplicateBody.success).toBe(true);
    expect(duplicateBody.expectedCredits.quantity).toBe(
      firstGrant!.initialAmount
    );
    expect(duplicateBody.expectedCredits.expiryDate).toBe(
      context.nextBillingDate.toISOString()
    );

    const invoicesAfter = await db.query.invoices.findMany({
      where: eq(invoices.customerId, context.customerId),
    });
    const paymentsAfter = await db.query.payments.findMany({
      where: eq(payments.invoiceId, firstInvoice!.id),
    });

    // Should not create new invoices or payments
    expect(invoicesAfter.length).toBe(invoicesBefore.length);
    expect(paymentsAfter.length).toBe(paymentsBefore.length);

    const grants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, context.customerId),
        eq(creditGrants.source, "topup"),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe(firstGrant!.id);
  }, 90000);
});
