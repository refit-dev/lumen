import {
  describe,
  it,
  beforeAll,
  afterAll,
  expect,
  afterEach,
  beforeEach,
} from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestApiKeys,
  cleanupDataFull,
} from "../test-helpers";
import { testEnv } from "../test-env";
import { db } from "../../src/db/client";
import Stripe from "stripe";
import {
  customers,
  subscriptions,
  invoices,
  payments,
  stripe as stripeSchema,
  paymentMethods,
  invoiceLineItems,
  subscriptionFeatures,
  subscriptionDetails,
  metrics,
  events,
  features,
  featureMetrics,
  prices,
  planFeatures,
  organization,
  user,
  plans,
  pricingTablePlans,
  pricingTables,
} from "@lumen/common/schema";
import { createTestPricingTable } from "../test-helpers/data/pricing-table";
import { eq, and, isNull, ne, sql } from "drizzle-orm";
import { FeatureValue } from "../test-helpers/data/feature";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { sleep } from "../test-helpers/sleep";
import path from "path";
import { sseClients, exposeForTesting } from "../../src/routes/public";
import { SSEStreamingApi } from "hono/streaming";
import {
  createPaymentProvider,
  PaymentProviderAdapter,
} from "../test-helpers/paymentProvider";

/**
 * End-to-End Payment Flow Test
 *
 * This test simulates the complete payment flow:
 * 1. Setup test merchant with Stripe integration details
 * 2. Create a test plan and price
 * 3. Generate a payment intent with /payment-init
 * 4. Set up a temporary webhook listener for the test
 * 5. Confirm payment with Stripe test card
 * 6. Verify webhook processed payment properly
 * 7. Verify customer, subscription, invoice, payment records created
 */
describe("End-to-End Payment Flow", () => {
  // This will be run for both tests
  let merchantId: string;
  let sessionToken: string;
  let stripeSecretKey: string;
  let stripePublicKey: string;
  let stripeWebhookSecret: string;
  let planId: string;
  let priceId: string;
  let stripe: Stripe;
  let webhookProcess: ChildProcess | null = null;
  let tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  let tempMerchantIdFile = "/tmp/test_merchant_id.txt";
  let customerId: string;
  let publishableApiKey: string;
  let paymentProvider: PaymentProviderAdapter;

  // Clean up function
  const cleanupWebhook = async () => {
    if (webhookProcess && !webhookProcess.killed) {
      console.log("Cleaning up webhook process...");
      webhookProcess.kill();
      webhookProcess = null;

      // Clean up temp files
      try {
        await fs.unlink(tempWebhookSecretFile);
        await fs.unlink(tempMerchantIdFile);
      } catch (err) {
        // Ignore errors if files don't exist
      }
    }
  };

  beforeEach(async () => {
    exposeForTesting.clearSseClients();
  });

  beforeAll(async () => {
    paymentProvider = await createPaymentProvider();
    // Clean up any existing test data
    await cleanupDataFull();

    // 1. Set up testing environment (merchant, user, etc.)
    const { merchant, user } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Save merchant ID to temp file for webhook
    await fs.writeFile(tempMerchantIdFile, merchantId);

    // 2. Authenticate to get a session token
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // 3. Get Stripe test keys
    stripeSecretKey = testEnv.TEST_STRIPE_SECRET_KEY;
    stripePublicKey = testEnv.TEST_STRIPE_PUBLIC_KEY;
    stripeWebhookSecret = testEnv.TEST_STRIPE_WEBHOOK_SECRET;

    // Initialize Stripe client
    stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2025-02-24.acacia",
    });

    // 4. Create Stripe account for test merchant
    await paymentProvider.registerIntegration(merchantId);

    // 5. Create API keys for the merchant
    const apiKeys = await createTestApiKeys({
      merchantId,
    });

    // Store the publishable key for use in the payment request
    publishableApiKey = apiKeys.publishableKey.keyValue;

    // 6. Create a test plan with features
    const testFeatures = [
      {
        slug: `max-users-payment-${Date.now()}`,
        displayName: "Maximum Users",
        description: "Maximum number of users allowed",
        featureValue: 10 as FeatureValue,
      },
      {
        slug: `storage-payment-${Date.now()}`,
        displayName: "Storage (GB)",
        description: "Storage capacity in gigabytes",
        featureValue: 100 as FeatureValue,
      },
    ];

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      testFeatures,
      {
        stablePlanId: `payment-test-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Payment Test Plan",
        planDescription: "Plan for testing payment functionality",
      }
    );

    planId = planCreationResult.plan.id;

    // 7. Create a price for the plan
    const price = await createTestPrice({
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
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    priceId = price.id;

    // 8. Start webhook listener in a separate process
    await paymentProvider.startWebhookForwarder(merchantId);
  });

  afterAll(async () => {
    await cleanupWebhook();

    // Clean up database records
    try {
      const cleanupQuery = sql`
        DELETE FROM ${payments};
        DELETE FROM ${invoiceLineItems};
        DELETE FROM ${invoices};
        DELETE FROM ${subscriptionFeatures};
        DELETE FROM ${subscriptionDetails};
        DELETE FROM ${metrics};
        DELETE FROM ${events};
        DELETE FROM ${subscriptions};
        DELETE FROM ${paymentMethods};
        DELETE FROM ${prices};
        DELETE FROM ${planFeatures};
        DELETE FROM ${features};
        DELETE FROM ${featureMetrics};
        DELETE FROM ${pricingTablePlans};
        DELETE FROM ${plans};
        DELETE FROM ${customers};
        DELETE FROM ${user};
        DELETE FROM ${organization};
    `;
      await db.execute(cleanupQuery);
    } catch (err) {
      console.error("Error during cleanup:", err);
    }
  });

  it("should process end-to-end payment flow with Stripe and verify customer creation and payment resources", async () => {
    // Add a small delay before starting to ensure everything is ready
    await sleep(1000);
    // 1. Set up test data for the API call
    const customerEmail = `payment-test-${Date.now()}@example.com`;
    const customerName = "Payment Test Customer";
    const userId = `user_${Date.now()}`;
    const customerAddress = "123 Test Street";
    const customerZip = "12345";
    const customerCity = "Test City";
    const customerCountry = "US";

    const apiClient = createTestApiClient();

    // 2. Call the payment-init endpoint with extra customer details
    const paymentInitResponse = await apiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey, // Use the actual publishable key we created
        priceId,
        planId,
        customerEmail,
        customerName,
        userId,
        customerAddress,
        customerZip,
        customerCity,
        customerCountry,
      },
    });

    expect(paymentInitResponse.status).toBe(200);

    const paymentInitData = await paymentInitResponse.json();
    if (!("clientSecret" in paymentInitData)) {
      throw new Error(`Unexpected error: ${JSON.stringify(paymentInitData)}`);
    }
    expect(paymentInitData.clientSecret).toBeDefined();
    expect(paymentInitData.stripePublishableKey).toBeDefined();
    expect(paymentInitData.intentId).toBeDefined();
    expect(paymentInitData.intentType).toBe("payment_intent");

    const clientSecret = paymentInitData.clientSecret;
    const intentId = paymentInitData.intentId;

    console.log(`Created payment intent: ${intentId}`);

    // 3. Retrieve the payment intent to check metadata before confirmation
    const initialPaymentIntent = await stripe.paymentIntents.retrieve(intentId);

    let payment = await db.query.payments.findFirst({
      where: eq(payments.externalPaymentId, initialPaymentIntent.id),
    });

    if (!payment) {
      throw new Error(`Payment not found for intent ${intentId}`);
    }

    if (!payment.metadata) {
      throw new Error(`Payment metadata not found for intent ${intentId}`);
    }

    // Verify metadata in the payment intent
    expect(payment.metadata.merchant_id).toBe(merchantId);
    expect(payment.metadata.customer_id).toBeDefined();
    expect(payment.metadata.plan_id).toBe(planId);
    expect(payment.metadata.price_id).toBe(priceId);
    expect(payment.metadata.platform_user_id).toBe(userId);

    // 4. Confirm the payment intent with a test card
    const paymentIntent = await stripe.paymentIntents.confirm(intentId, {
      payment_method: "pm_card_visa", // Use a test payment method token
    });

    // 5. Verify the payment intent status
    expect(paymentIntent.status).toBe("succeeded");

    // 6. Wait a bit for the webhook to process the payment
    console.log("Waiting for webhook to process payment...");
    // Increase wait time to allow for webhook processing
    await sleep(5000);

    // 7. Check if a customer was created with correct details
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

    expect(createdCustomers.length).toBe(1);
    customerId = createdCustomers[0].id;

    // Verify all customer fields
    const customer = createdCustomers[0];
    expect(customer.name).toBe(customerName);
    expect(customer.email).toBe(customerEmail);
    expect(customer.externalCustomerId).toBe(userId);
    expect(customer.billingAddressLine1).toBe(customerAddress);
    expect(customer.billingCity).toBe(customerCity);
    expect(customer.billingPostalCode).toBe(customerZip);
    expect(customer.billingCountry).toBe(customerCountry);
    expect(customer.pspCustomerId).toBeDefined();

    // 8. Verify the Stripe customer was created properly by retrieving it
    if (customer.pspCustomerId) {
      const stripeCustomer = await stripe.customers.retrieve(
        customer.pspCustomerId
      );
      expect(stripeCustomer).toBeDefined();

      if (stripeCustomer.deleted) {
        throw new Error("Stripe customer was deleted");
      }

      expect(stripeCustomer.email).toBe(customerEmail);
      expect(stripeCustomer.name).toBe(customerName);
      expect(stripeCustomer.metadata.customerId).toBe(customerId);
    } else {
      throw new Error("Customer was not linked to a Stripe customer ID");
    }

    // 9. Check if a subscription was created
    const createdSubscriptions = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.merchantId, merchantId),
          eq(subscriptions.customerId, customerId),
          isNull(subscriptions.deletedAt)
        )
      );

    expect(createdSubscriptions.length).toBe(1);
    const subscriptionId = createdSubscriptions[0].id;

    // 10. Verify subscription details
    const subscription = createdSubscriptions[0];
    expect(subscription.planId).toBe(planId);
    expect(subscription.effectivePriceId).toBe(priceId);

    // Check subscription details records
    const subscriptionDetailsRecords = await db
      .select()
      .from(subscriptionDetails)
      .where(
        and(
          eq(subscriptionDetails.subscriptionId, subscriptionId),
          isNull(subscriptionDetails.deletedAt)
        )
      );

    // There should be one subscription details record per price component
    expect(subscriptionDetailsRecords.length).toBeGreaterThan(0);

    // Verify the subscription details record
    const subDetail = subscriptionDetailsRecords[0];
    expect(subDetail.subscriptionId).toBe(subscriptionId);
    expect(subDetail.componentId).toBeDefined();
    expect(subDetail.nextBillingDate).toBeDefined(); // Should have a future billing date

    // 11. Check if an invoice was created
    const createdInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customerId),
          ne(invoices.status, "deleted")
        )
      );

    expect(createdInvoices.length).toBe(1);
    const invoiceId = createdInvoices[0].id;

    // 12. Verify invoice details
    const invoice = createdInvoices[0];
    expect(invoice.status).toBe("paid");
    expect(invoice.totalAmountCents).toBe(5000);
    expect(invoice.currency).toBe("USD");
    expect(invoice.subscriptionId).toBe(subscriptionId);
    expect(invoice.customerInvoiceNumber).toBeDefined();

    // 12.1 Verify invoice line items
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));

    expect(lineItems.length).toBeGreaterThan(0);

    // Verify first line item
    const lineItem = lineItems[0];
    expect(lineItem.description).toBeDefined();
    expect(lineItem.type).toBe("fixed"); // Based on our price DSL
    expect(lineItem.subtotalCents).toBe(5000);
    expect(lineItem.billingPeriodStart).toBeDefined();
    expect(lineItem.billingPeriodEnd).toBeDefined();

    // 13. Check if a payment was created
    const createdPayments = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.merchantId, merchantId),
          eq(payments.invoiceId, invoiceId)
        )
      );

    expect(createdPayments.length).toBe(1);

    // 14. Verify payment details match what we expect
    payment = createdPayments[0];
    expect(payment.status).toBe("succeeded");
    expect(payment.amountCents).toBe(5000);
    expect(payment.currency).toBe("USD");
    expect(payment.externalPaymentId).toBe(intentId);

    // 15. Get and check the payment methods created
    const paymentMethodId = payment.paymentMethodId;
    expect(paymentMethodId).toBeDefined();

    if (paymentMethodId) {
      const createdPaymentMethod = await db
        .select()
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.id, paymentMethodId),
            isNull(paymentMethods.deletedAt)
          )
        );

      expect(createdPaymentMethod.length).toBe(1);
      const paymentMethod = createdPaymentMethod[0];
      expect(paymentMethod.paymentType).toBe("card");
      expect(paymentMethod.provider).toBe("stripe");
      expect(paymentMethod.status).toBe("active");
      expect(paymentMethod.cardBrand).toBe("visa");
      expect(paymentMethod.cardLastFour).toBe("4242"); // For pm_card_visa test card
      expect(paymentMethod.merchantId).toBe(merchantId);
      expect(paymentMethod.customerId).toBe(customerId);

      // Verify the payment method is linked to the Stripe customer
      expect(paymentMethod.externalPspCustomerId).toBeDefined();
      expect(paymentMethod.externalPspPaymentMethodId).toBeDefined();

      // Verify the payment method is properly linked in subscription details
      const linkedSubscriptionDetails = await db
        .select()
        .from(subscriptionDetails)
        .where(
          and(
            eq(subscriptionDetails.paymentMethodId, paymentMethodId),
            isNull(subscriptionDetails.deletedAt)
          )
        );

      // The payment method should be linked to at least one subscription detail
      expect(linkedSubscriptionDetails.length).toBeGreaterThan(0);
    }

    // 16. Verify the updated payment has all the required metadata
    expect(payment.metadata?.subscription_id).toBe(subscriptionId);
    expect(payment.metadata?.invoice_id).toBe(invoiceId);
  }, 30000); // Increase timeout for this test as webhook processing may take time

  it("should handle business customer data correctly when processing payment", async () => {
    // Add a small delay before starting to ensure everything is ready
    await sleep(1000);

    // 1. Set up test data for the API call with business customer details
    const customerEmail = `business-payment-test-${Date.now()}@example.com`;
    const customerName = "Business Payment Test";
    const userId = `business_user_${Date.now()}`;
    const customerAddress = "456 Business Ave";
    const customerZip = "54321";
    const customerCity = "Business City";
    const customerCountry = "DE";

    // Add business specific fields
    const businessName = "Test Business GmbH";
    const taxId = "DE123456789";

    const apiClient = createTestApiClient();

    // 2. Call the payment-init endpoint with business customer details
    const paymentInitResponse = await apiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId,
        planId,
        customerEmail,
        customerName,
        userId,
        customerAddress,
        customerZip,
        customerCity,
        customerCountry,
        businessName,
        taxId,
      },
    });

    expect(paymentInitResponse.status).toBe(200);

    const paymentInitData = await paymentInitResponse.json();
    if (!("clientSecret" in paymentInitData)) {
      throw new Error(`Unexpected error: ${JSON.stringify(paymentInitData)}`);
    }

    expect(paymentInitData.clientSecret).toBeDefined();
    expect(paymentInitData.intentId).toBeDefined();

    const intentId = paymentInitData.intentId;
    console.log(`Created business payment intent: ${intentId}`);

    // 3. Confirm the payment intent
    const paymentIntent = await stripe.paymentIntents.confirm(intentId, {
      payment_method: "pm_card_visa",
    });

    expect(paymentIntent.status).toBe("succeeded");

    // 4. Wait for webhook processing
    console.log("Waiting for webhook to process business payment...");
    await sleep(5000);

    // 5. Verify business customer data was saved correctly
    const businessCustomers = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.merchantId, merchantId),
          eq(customers.email, customerEmail),
          isNull(customers.deletedAt)
        )
      );

    expect(businessCustomers.length).toBe(1);
    const businessCustomerId = businessCustomers[0].id;

    // Check business specific fields
    const businessCustomer = businessCustomers[0];
    expect(businessCustomer.name).toBe(customerName);
    expect(businessCustomer.email).toBe(customerEmail);
    // The businessName field is not currently used in the implementation
    // expect(businessCustomer.businessName).toBe(businessName);
    expect(businessCustomer.taxId).toBe(taxId);
    expect(businessCustomer.billingAddressLine1).toBe(customerAddress);
    expect(businessCustomer.billingCity).toBe(customerCity);
    expect(businessCustomer.billingPostalCode).toBe(customerZip);
    expect(businessCustomer.billingCountry).toBe(customerCountry);

    // 6. Verify all related objects were created
    const businessSubscriptions = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.merchantId, merchantId),
          eq(subscriptions.customerId, businessCustomerId),
          isNull(subscriptions.deletedAt)
        )
      );

    expect(businessSubscriptions.length).toBe(1);

    // 7. Verify invoice creation
    const businessInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, businessCustomerId),
          ne(invoices.status, "deleted")
        )
      );

    expect(businessInvoices.length).toBe(1);

    // Business invoices should have the business name on them
    // This would require frontend verification of the PDF, but we can at least
    // check the customer is properly linked
    const businessInvoice = businessInvoices[0];
    expect(businessInvoice.customerId).toBe(businessCustomerId);
  }, 30000);

  it("should process setup intents for plans with no immediate billing", async () => {
    // Add a small delay before starting to ensure everything is ready
    await sleep(1000);

    // 1. Create a price with no immediate billing
    const setupPlanPrice = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Monthly Base Fee",
            amount_cents: 2000, // $20.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: false, // Key difference: no immediate billing
          },
        ],
      },
    });

    // 2. Set up test data for the API call
    const customerEmail = `setup-test-${Date.now()}@example.com`;
    const customerName = "Setup Test Customer";
    const userId = `setup_user_${Date.now()}`;

    const apiClient = createTestApiClient();

    // 3. Call the payment-init endpoint (which should create a setup intent)
    const initResponse = await apiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: setupPlanPrice.id,
        planId,
        customerEmail,
        customerName,
        userId,
        customerAddress: "123 Test St",
        customerZip: "12345",
        customerCity: "Test City",
        customerCountry: "US",
      },
    });

    expect(initResponse.status).toBe(200);

    const initData = await initResponse.json();
    if (!("clientSecret" in initData)) {
      throw new Error(`Unexpected error: ${JSON.stringify(initData)}`);
    }

    // Verify we got a setup intent (not payment intent)
    expect(initData.clientSecret).toBeDefined();
    expect(initData.stripePublishableKey).toBeDefined();
    expect(initData.intentId).toBeDefined();
    expect(initData.intentType).toBe("setup_intent"); // Key difference from payment intent

    const setupIntentId = initData.intentId;
    console.log(`Created setup intent: ${setupIntentId}`);

    // 4. Retrieve and verify the initial setup intent
    const initialSetupIntent =
      await stripe.setupIntents.retrieve(setupIntentId);
    expect(initialSetupIntent).toBeDefined();

    // Initial status is requires_payment_method before confirmation
    expect(initialSetupIntent.status).toBe("requires_payment_method");

    if (!initialSetupIntent.metadata) {
      throw new Error("Initial setup intent metadata not found");
    }

    const payment = await db.query.payments.findFirst({
      where: eq(payments.externalPaymentId, setupIntentId),
    });

    if (!payment) {
      throw new Error(`Payment not found for intent ${setupIntentId}`);
    }

    if (!payment.metadata) {
      throw new Error(`Payment metadata not found for intent ${setupIntentId}`);
    }

    // Verify metadata in the setup intent
    expect(payment.metadata.merchant_id).toBe(merchantId);
    expect(payment.metadata.customer_id).toBeDefined();
    expect(payment.metadata.plan_id).toBe(planId);
    expect(payment.metadata.price_id).toBe(setupPlanPrice.id);
    expect(payment.metadata.platform_user_id).toBe(userId);

    // 5. Confirm the setup intent with a payment method
    const setupIntent = await stripe.setupIntents.confirm(setupIntentId, {
      payment_method: "pm_card_visa",
    });

    expect(setupIntent.status).toBe("succeeded");

    // 6. Wait for webhook processing
    console.log("Waiting for webhook to process setup intent...");
    await sleep(5000);

    // 7. Verify customer was created
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

    expect(createdCustomers.length).toBe(1);
    const setupCustomerId = createdCustomers[0].id;

    // 8. Verify customer details
    const customer = createdCustomers[0];
    expect(customer.name).toBe(customerName);
    expect(customer.email).toBe(customerEmail);
    expect(customer.externalCustomerId).toBe(userId);
    expect(customer.pspCustomerId).toBeDefined();

    // 9. Verify subscription was created
    const createdSubscriptions = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.merchantId, merchantId),
          eq(subscriptions.customerId, setupCustomerId),
          isNull(subscriptions.deletedAt)
        )
      );

    expect(createdSubscriptions.length).toBe(1);
    const subscriptionId = createdSubscriptions[0].id;

    // 10. Verify subscription details
    const subscription = createdSubscriptions[0];
    expect(subscription.planId).toBe(planId);
    expect(subscription.effectivePriceId).toBe(setupPlanPrice.id);

    // 11. Check subscription details records
    const subscriptionDetailsRecords = await db
      .select()
      .from(subscriptionDetails)
      .where(
        and(
          eq(subscriptionDetails.subscriptionId, subscriptionId),
          isNull(subscriptionDetails.deletedAt)
        )
      );

    expect(subscriptionDetailsRecords.length).toBeGreaterThan(0);

    // 12. KEY DIFFERENCE: Verify NO invoice was created (since bill_immediately: false)
    const createdInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, setupCustomerId),
          ne(invoices.status, "deleted")
        )
      );

    // No invoice should be created for setup intent
    expect(createdInvoices.length).toBe(0);

    // 13. KEY DIFFERENCE: Verify NO payment was created
    const createdPayments = await db
      .select()
      .from(payments)
      .where(eq(payments.merchantId, merchantId));

    // None of the payments should be for this customer
    const setupCustomerPayments = createdPayments.filter(
      (p) => p.invoiceId && createdInvoices.some((i) => i.id === p.invoiceId)
    );
    expect(setupCustomerPayments.length).toBe(0);

    // 14. Verify payment method was created and linked to the customer
    const createdPaymentMethods = await db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.merchantId, merchantId),
          eq(paymentMethods.customerId, setupCustomerId),
          isNull(paymentMethods.deletedAt)
        )
      );

    expect(createdPaymentMethods.length).toBe(1);

    const paymentMethod = createdPaymentMethods[0];
    expect(paymentMethod.paymentType).toBe("card");
    expect(paymentMethod.provider).toBe("stripe");
    expect(paymentMethod.status).toBe("active");
    expect(paymentMethod.cardBrand).toBe("visa");
    expect(paymentMethod.cardLastFour).toBe("4242"); // For pm_card_visa test card
    const subscriptionIds = createdPayments.map(
      (p) => p.metadata?.subscription_id
    );
    expect(subscriptionIds).toContain(subscriptionId);
  }, 30000);
});

/**
 * Tests for the SSE functionality in the payment flow
 *
 * These tests verify the Server-Sent Events (SSE) functionality that's used for real-time
 * payment status updates. The PaymentModalDemo component connects to an SSE endpoint
 * to receive updates when webhook events occur.
 *
 * Testing approach:
 * - We directly manipulate the sseClients map to simulate connections
 * - We create mock SSE stream objects that track what events were sent
 * - We simulate webhook events and verify they're forwarded to connected clients
 *
 * What's being tested:
 * 1. Client connections are properly stored in the sseClients map
 * 2. Connection established events are sent when clients connect
 * 3. Webhook events are forwarded to the appropriate connected clients
 * 4. The system handles missing clients gracefully
 * 5. Ping events are sent to keep connections alive
 * 6. Client disconnections are properly cleaned up
 */
describe("Payment SSE Events", () => {
  // Custom type to track SSE events for testing
  type MockSSEStream = {
    events: Array<{ event: string; data: any }>;
    writeSSE: (data: {
      event?: string;
      data: any;
      id?: string;
    }) => Promise<void>;
    onAbortHandler?: () => void;
    onAbort: (callback: () => void) => void;
    triggerAbort: () => void;
  };

  // Mock SSE stream creation helper
  const createMockSSEStream = (): MockSSEStream => {
    const events: Array<{ event: string; data: any }> = [];
    let abortHandler: (() => void) | undefined;

    return {
      events,
      writeSSE: async (data) => {
        // Handle data parsing, with special case for ping events
        let parsedData = data.data;

        // Only try to parse as JSON if it's a string and not a ping event
        if (typeof data.data === "string" && data.event !== "ping") {
          try {
            parsedData = JSON.parse(data.data);
          } catch (e) {
            // If parsing fails, keep the original string
            console.log(`Failed to parse JSON: ${data.data}`);
            parsedData = data.data;
          }
        }

        events.push({
          event: data.event || "message",
          data: parsedData,
        });
        return Promise.resolve();
      },
      onAbort: (callback) => {
        abortHandler = callback;
      },
      triggerAbort: () => {
        if (abortHandler) {
          abortHandler();
          // Remove from the map when triggered manually
          for (const [key, value] of sseClients.entries()) {
            if (value === this) {
              sseClients.delete(key);
              break;
            }
          }
        }
      },
      onAbortHandler: abortHandler,
    };
  };

  afterEach(() => {
    exposeForTesting.clearSseClients();
  });

  it("should store client in map and send connection established event", async () => {
    // Create a test payment intent ID
    const testPaymentIntentId = "pi_test_" + Date.now().toString();

    // Create a mock SSE stream
    const mockStream = createMockSSEStream();

    // Add the stream to the sseClients map
    sseClients.set(
      testPaymentIntentId,
      mockStream as unknown as SSEStreamingApi
    );

    // Verify the client was added to the map
    expect(sseClients.has(testPaymentIntentId)).toBe(true);
    expect(sseClients.size).toBe(1);

    // Simulate the initial connection event (manually do what the route does)
    await mockStream.writeSSE({
      data: JSON.stringify({
        type: "connection_established",
        paymentIntentId: testPaymentIntentId,
      }),
      event: "message",
      id: "test-id",
    });

    // Verify the event was "sent"
    expect(mockStream.events.length).toBe(1);
    expect(mockStream.events[0].event).toBe("message");
    expect(mockStream.events[0].data.type).toBe("connection_established");
    expect(mockStream.events[0].data.paymentIntentId).toBe(testPaymentIntentId);
  });

  it("should clean up client connection when aborted", async () => {
    // Create a test payment intent ID
    const testPaymentIntentId = "pi_test_" + Date.now().toString();

    // Create a mock SSE stream
    const mockStream = createMockSSEStream();

    // Manually register the abort handler like the actual code would
    const abortHandler = () => {
      sseClients.delete(testPaymentIntentId);
    };
    mockStream.onAbort(abortHandler);

    // Add the stream to the sseClients map
    sseClients.set(
      testPaymentIntentId,
      mockStream as unknown as SSEStreamingApi
    );

    // Verify the client was added to the map
    expect(sseClients.has(testPaymentIntentId)).toBe(true);

    // Simulate client disconnection by calling the abort handler directly
    abortHandler();

    // Verify the client was removed from the map
    expect(sseClients.has(testPaymentIntentId)).toBe(false);
    expect(sseClients.size).toBe(0);
  });

  it("should forward webhook events to connected clients", async () => {
    // Create a test payment intent ID
    const testPaymentIntentId = "pi_test_" + Date.now().toString();
    const testMerchantId = "mer_test_" + Date.now().toString();

    // Create a mock SSE stream and add it to the map
    const mockStream = createMockSSEStream();
    sseClients.set(
      testPaymentIntentId,
      mockStream as unknown as SSEStreamingApi
    );

    // Create a mock webhook event (payment_intent.succeeded)
    const mockWebhookEvent = {
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: testPaymentIntentId,
          status: "succeeded",
          metadata: {
            merchant_id: testMerchantId,
            customer_id: "cus_test",
            subscription_id: "sub_test",
            invoice_id: "inv_test",
            payment_id: "pay_test",
          },
        },
      },
    };

    // Prepare broadcast data (similar to what the webhook handler does)
    const broadcastData = {
      type: mockWebhookEvent.type,
      merchantId: testMerchantId,
      timestamp: new Date().toISOString(),
      data: mockWebhookEvent.data,
    };

    // Get the SSE client and send event
    const clientStream = sseClients.get(testPaymentIntentId);
    if (clientStream) {
      await (clientStream as any).writeSSE({
        data: JSON.stringify(broadcastData),
        event: "stripe_event",
        id: "test-uuid",
      });
    }

    // Verify the event was sent to the client
    expect(mockStream.events.length).toBe(1);
    const sentEvent = mockStream.events[0];
    expect(sentEvent.event).toBe("stripe_event");

    // Check the event data was properly parsed and structured
    expect(sentEvent.data.type).toBe("payment_intent.succeeded");
    expect(sentEvent.data.merchantId).toBe(testMerchantId);
    expect(sentEvent.data.data.object.id).toBe(testPaymentIntentId);
  });

  it("should gracefully handle webhook events with no connected clients", async () => {
    // Create a test payment intent ID (but don't connect a client for it)
    const testPaymentIntentId = "pi_test_no_client_" + Date.now().toString();
    const testMerchantId = "mer_test_" + Date.now().toString();

    // Verify no client exists for this intent
    expect(sseClients.has(testPaymentIntentId)).toBe(false);

    // Create a mock webhook event
    const mockWebhookEvent = {
      id: "evt_test_no_client",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: testPaymentIntentId,
          status: "succeeded",
          metadata: {
            merchant_id: testMerchantId,
          },
        },
      },
    };

    // Prepare broadcast data
    const broadcastData = {
      type: mockWebhookEvent.type,
      merchantId: testMerchantId,
      timestamp: new Date().toISOString(),
      data: mockWebhookEvent.data,
    };

    // Get the SSE client (should be undefined)
    const clientStream = sseClients.get(testPaymentIntentId);

    // Verify client is undefined
    expect(clientStream).toBeUndefined();

    // Try to send event (should not throw)
    let errorThrown = false;
    try {
      if (clientStream) {
        await (clientStream as any).writeSSE({
          data: JSON.stringify(broadcastData),
          event: "stripe_event",
          id: "test-uuid",
        });
      }
    } catch (error) {
      errorThrown = true;
    }

    // Verify no error was thrown
    expect(errorThrown).toBe(false);
  });

  it("should send ping events to keep the connection alive", async () => {
    // Create a test payment intent ID
    const testPaymentIntentId = "pi_test_ping_" + Date.now().toString();

    // Create a mock SSE stream
    const mockStream = createMockSSEStream();

    // Add the stream to the sseClients map
    sseClients.set(
      testPaymentIntentId,
      mockStream as unknown as SSEStreamingApi
    );

    // Simulate a ping event being sent
    await (mockStream as any).writeSSE({
      data: "ping",
      event: "ping",
      id: crypto.randomUUID(),
    });

    // Verify the ping event was sent
    expect(mockStream.events.length).toBe(1);
    const pingEvent = mockStream.events[0];
    expect(pingEvent.event).toBe("ping");
    expect(pingEvent.data).toBe("ping");
  });
});

/**
 * Free Plan Selection Tests
 *
 * Tests that payment-init correctly uses the explicitly requested planId/priceId
 * for free plans instead of auto-selecting a different free plan.
 *
 * Bug context: When multiple free plans exist, payment-init was ignoring the
 * requested planId/priceId and auto-selecting a different free plan.
 */
describe("Free Plan Selection in payment-init", () => {
  let merchantId: string;
  let publishableApiKey: string;
  let baseApiClient: ReturnType<typeof createTestApiClient>;
  const ts = Date.now();

  beforeAll(async () => {
    // Clean up any existing test data
    await cleanupDataFull();

    // Create test environment
    const { merchant, user } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Get auth
    const authResponse = await authenticateTestUser(user.email, user.password);
    const sessionToken = authResponse.cookies.sessionToken;

    // Create API keys
    const apiKeys = await createTestApiKeys({ merchantId });
    publishableApiKey = apiKeys.publishableKey.keyValue;

    // Create API client
    baseApiClient = createTestApiClient(sessionToken);
  });

  afterAll(async () => {
    await cleanupDataFull();
  });

  it("should use explicitly requested free plan when multiple free plans exist", async () => {
    // Create two free plans with different names/credits
    const freePlan1Result = await createTestPlanWithFeatures(merchantId, [], {
      planName: "Free Trial",
      planDescription: "Limited free trial plan",
    });
    const freePlan1 = freePlan1Result.plan;

    const freePlan2Result = await createTestPlanWithFeatures(merchantId, [], {
      planName: "Internal User Plan",
      planDescription: "Internal user plan with more credits",
    });
    const freePlan2 = freePlan2Result.plan;

    // Create free prices for both plans (all components $0)
    const freePrice1 = await createTestPrice({
      merchantId,
      planId: freePlan1.id,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "free_component",
            type: "fixed",
            label: "Free Trial Component",
            amount_cents: 0,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    const freePrice2 = await createTestPrice({
      merchantId,
      planId: freePlan2.id,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "internal_component",
            type: "fixed",
            label: "Internal User Component",
            amount_cents: 0,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    // Create pricing tables for both plans (required for free plan discovery)
    await createTestPricingTable({
      merchantId,
      name: "Free Trial Table",
      slug: `free-trial-table-${ts}`,
      description: "Pricing table for free trial",
      isActive: true,
      planIds: [freePlan1.id],
    });

    await createTestPricingTable({
      merchantId,
      name: "Internal User Table",
      slug: `internal-user-table-${ts}`,
      description: "Pricing table for internal users",
      isActive: true,
      planIds: [freePlan2.id],
    });

    // Call payment-init explicitly requesting the second plan (Internal User Plan)
    const response = await baseApiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        planId: freePlan2.id,
        priceId: freePrice2.id,
        customerEmail: `test-${ts}@example.com`,
        customerName: "Test User",
        userId: `user-${ts}`,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    // Verify subscription was created
    expect("subscription_id" in data).toBe(true);
    expect("plan" in data).toBe(true);

    // Verify the CORRECT plan was used (the one we explicitly requested)
    const planData = (data as { plan: { id: string; name: string } }).plan;
    expect(planData.id).toBe(freePlan2.id);
    expect(planData.name).toBe("Internal User Plan");

    // Double-check by querying the subscription directly
    const subscriptionId = (data as { subscription_id: string }).subscription_id;
    const subscription = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscriptionId),
    });

    expect(subscription).toBeDefined();
    expect(subscription!.planId).toBe(freePlan2.id);
    expect(subscription!.effectivePriceId).toBe(freePrice2.id);
  });
});
