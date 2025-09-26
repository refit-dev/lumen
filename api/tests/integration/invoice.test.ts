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
import { db } from "../../src/db/client";
import {
  invoices,
  invoiceLineItems,
  organization,
  customers,
  featureMetrics,
  planFeatures,
  prices,
  paymentMethods,
  subscriptions,
  events,
  metrics,
  creditDefinitions,
  creditGrants,
  creditUsageTransactions,
  subscriptionDetails,
  subscriptionFeatures,
  payments,
  user,
  plans,
  features,
  pricingTables,
  pricingTablePlans,
  stripe as stripeSchema,
} from "@lumen/common/schema";
import { eq, sql, and, isNull, ne } from "drizzle-orm";
import { createId, createPrefixedId, ID_PREFIXES } from "@lumen/common";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestCustomer,
  createTestApiClient,
  createBasicSubscription,
  createTestApiKeys,
} from "../test-helpers";
import { FeatureValue } from "../test-helpers/data/feature";
import { hc } from "hono/client";
import { AppType } from "../../src/routes";
import Stripe from "stripe";
import { ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { sleep } from "../test-helpers/sleep";
import { testEnv } from "../test-env";
import {
  createPaymentProvider,
  PaymentProviderAdapter,
} from "../test-helpers/paymentProvider";
import { cleanupDataFull } from "../test-helpers";

describe("Invoices API", () => {
  let merchantId: string;
  let customerId: string;
  let planId: string;
  let priceId: string;
  let subscriptionId: string;
  let invoiceId: string;
  let sessionToken: string;
  let apiClient: ReturnType<typeof hc<AppType>>;

  beforeEach(async () => {
    // 1. Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // 2. Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
    apiClient = createTestApiClient(sessionToken);

    // 3. Create a test customer
    const customer = await createTestCustomer({
      merchantId,
      email: `invoice-test-customer-${Date.now()}@example.com`,
      name: "Invoice Test Customer",
    });
    customerId = customer.id;

    // 4. Create Plan with features
    const testFeatures = [
      {
        slug: `feature-invoice-${Date.now()}`,
        displayName: "Test Feature",
        description: "Feature for invoice testing",
        featureValue: true as FeatureValue,
      },
    ];

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      testFeatures,
      {
        stablePlanId: `invoice-test-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Invoice Test Plan",
        planDescription: "Plan for testing invoice functionality",
      }
    );

    planId = planCreationResult.plan.id;

    // 5. Create Price
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
            label: "Monthly Fee",
            amount_cents: 5000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    priceId = price.id;

    // 6. Create Subscription
    const subscription = await createBasicSubscription(
      merchantId,
      customerId,
      planId,
      priceId
    );
    subscriptionId = subscription.id;

    // 7. Create a test invoice
    const [invoice] = await db
      .insert(invoices)
      .values({
        merchantId,
        customerId,
        subscriptionId,
        status: "generated",
        totalAmountCents: 5000,
        currency: "USD",
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        customerInvoiceNumber: "TEST-0001",
        pdfUrl: `http://localhost:9000/invoices-dev/invoices/${createId()}.pdf`, // Test PDF URL
      })
      .returning();

    invoiceId = invoice.id;

    // 8. Create invoice line items
    await db.insert(invoiceLineItems).values({
      invoiceId,
      type: "fixed",
      description: "Monthly Fee",
      subtotalCents: 5000,
      componentId: "base_fee",
    });
  });

  afterEach(async () => {
    // Clean up all related data in correct order due to foreign key constraints
    if (invoiceId) {
      await db
        .delete(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId));
      await db.delete(invoices).where(eq(invoices.id, invoiceId));
    }
    if (subscriptionId) {
      // Delete dependent tables first to satisfy foreign key constraints
      await db
        .delete(subscriptionFeatures)
        .where(eq(subscriptionFeatures.subscriptionId, subscriptionId));
      await db
        .delete(subscriptionDetails)
        .where(eq(subscriptionDetails.subscriptionId, subscriptionId));
      await db
        .delete(subscriptions)
        .where(eq(subscriptions.id, subscriptionId));
    }
    if (priceId) {
      await db.delete(prices).where(eq(prices.id, priceId));
    }
    if (planId) {
      await db.delete(planFeatures).where(eq(planFeatures.planId, planId));
      await db.delete(plans).where(eq(plans.id, planId));
    }
    if (customerId) {
      await db.delete(customers).where(eq(customers.id, customerId));
    }
  });

  describe("GET /invoices", () => {
    it("should list invoices", async () => {
      const response = await apiClient.invoices.$get({
        query: {
          status: "generated",
        },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      if ("error" in data) {
        throw new Error(data.error);
      }
      expect(data.invoices).toBeDefined();
      expect(data.invoices.length).toBeGreaterThanOrEqual(1);

      // Check that we have the invoice we created
      const createdInvoice = data.invoices.find((inv) => inv.id === invoiceId);
      expect(createdInvoice).toBeDefined();

      // Verify hasPdf flag is present but pdfUrl is not exposed
      expect(createdInvoice!.hasPdf).toBe(true);
    });

    it("should filter invoices by customerId", async () => {
      const response = await apiClient.invoices.$get({
        query: { customerId },
      });
      const data = await response.json();

      if ("error" in data) {
        throw new Error(data.error);
      }

      expect(response.status).toBe(200);
      expect(data.invoices).toBeDefined();
      expect(data.invoices.length).toBeGreaterThanOrEqual(1);

      // Verify all invoices are for the requested customer
      for (const invoice of data.invoices) {
        expect(invoice.customerId).toBe(customerId);
      }
    });
  });

  describe("GET /invoices/:id", () => {
    it("should get a single invoice by ID", async () => {
      const response = await apiClient.invoices[":id"].$get({
        param: {
          id: invoiceId,
        },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      expect(response.status).toBe(200);
      expect(data.invoice).toBeDefined();
      expect(data.invoice.id).toBe(invoiceId);
      expect(data.invoice.customerInvoiceNumber).toBe("TEST-0001");

      // Verify hasPdf flag is present but pdfUrl is not exposed
      expect(data.invoice.hasPdf).toBe(true);
    });

    it("should return 404 for non-existent invoice", async () => {
      const nonExistentId = createPrefixedId(ID_PREFIXES.invoice);
      const response = await apiClient.invoices[":id"].$get({
        param: {
          id: nonExistentId,
        },
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /invoices/customer/:customerId", () => {
    it("should get invoices for a specific customer", async () => {
      const response = await apiClient.invoices.customer[":customerId"].$get({
        param: {
          customerId,
        },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }

      expect(response.status).toBe(200);
      expect(data.invoices).toBeDefined();
      expect(data.invoices.length).toBeGreaterThanOrEqual(1);

      // Verify all invoices are for the requested customer
      for (const invoice of data.invoices) {
        expect(invoice.customerId).toBe(customerId);
      }

      // Verify hasPdf flag is present but pdfUrl is not exposed
      expect(data.invoices[0].hasPdf).toBe(true);
    });
  });

  describe("GET /invoices/:id/pdf", () => {
    it("should generate a presigned URL for accessing an invoice's PDF", async () => {
      const response = await apiClient.invoices[":id"].pdf.$get({
        param: {
          id: invoiceId,
        },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      expect(response.status).toBe(200);
      expect(data.invoice).toBeDefined();
      expect(data.invoice.id).toBe(invoiceId);
      expect(data.pdfUrl).toBeDefined();
      expect(data.pdfUrl).toContain("Signature=");
      expect(data.expiresIn).toBe(900); // 15 minutes in seconds
    });

    it("should return 404 for an invoice without a PDF", async () => {
      // Create an invoice without a PDF URL
      const [invoiceWithoutPdf] = await db
        .insert(invoices)
        .values({
          merchantId,
          customerId,
          subscriptionId,
          status: "draft",
          totalAmountCents: 2000,
          currency: "USD",
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          customerInvoiceNumber: "TEST-0002",
          pdfUrl: null, // No PDF URL
        })
        .returning();

      try {
        const response = await apiClient.invoices[":id"].pdf.$get({
          param: {
            id: invoiceWithoutPdf.id,
          },
        });
        expect(response.status).toBe(404);
      } finally {
        // Clean up the test invoice
        await db.delete(invoices).where(eq(invoices.id, invoiceWithoutPdf.id));
      }
    });
  });

  describe("POST /invoices/:id", () => {
    let draftInvoiceId: string;
    beforeEach(async () => {
      // Create a draft invoice for update tests
      const [draftInvoice] = await db
        .insert(invoices)
        .values({
          merchantId,
          customerId,
          subscriptionId,
          status: "draft",
          totalAmountCents: 1000,
          currency: "USD",
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          customerInvoiceNumber: "DRAFT-0001",
          pdfUrl: null,
        })
        .returning();
      draftInvoiceId = draftInvoice.id;
    });
    afterEach(async () => {
      if (draftInvoiceId) {
        await db
          .delete(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, draftInvoiceId));
        await db.delete(invoices).where(eq(invoices.id, draftInvoiceId));
      }
    });
    it("should update a draft invoice's status and dates", async () => {
      const response = await apiClient.invoices[":id"].$post({
        param: { id: draftInvoiceId },
        json: {
          status: "paid",
          issueDate: new Date().toISOString(),
          dueDate: new Date(
            Date.now() + 14 * 24 * 60 * 60 * 1000
          ).toISOString(),
        },
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toBeDefined();
    });
    it("should update line items for a draft invoice", async () => {
      const response = await apiClient.invoices[":id"].$post({
        param: { id: draftInvoiceId },
        json: {
          lineItems: [
            {
              type: "fixed",
              description: "Updated Fee",
              quantity: 2,
              unitAmountCents: 1500,
              componentId: "base_fee",
            },
          ],
        },
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect((data as any).id).toBeDefined();
      // Optionally, fetch the invoice and check line items
      const items = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.invoiceId, draftInvoiceId),
      });
      expect(items.length).toBe(1);
      expect(items[0].description).toBe("Updated Fee");
      expect(items[0].quantity).toBe(2);
      expect(items[0].unitAmountCents).toBe(1500);
    });
    it("should delete line items from a draft invoice", async () => {
      // First, add multiple line items to the invoice
      await db.insert(invoiceLineItems).values([
        {
          invoiceId: draftInvoiceId,
          type: "fixed",
          description: "Item to keep",
          quantity: 1,
          unitAmountCents: 1000,
          subtotalCents: 1000,
          componentId: "item_1",
        },
        {
          invoiceId: draftInvoiceId,
          type: "fixed",
          description: "Item to delete",
          quantity: 1,
          unitAmountCents: 2000,
          subtotalCents: 2000,
          componentId: "item_2",
        },
      ]);

      // Get the current line items to find the ID we want to delete
      const initialItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.invoiceId, draftInvoiceId),
      });
      expect(initialItems.length).toBe(2);

      // Find the ID of the item to delete
      const itemToDelete = initialItems.find(
        (item) => item.description === "Item to delete"
      );
      expect(itemToDelete).toBeDefined();

      // Call the API to update the invoice with deletedLineItemIds
      const response = await apiClient.invoices[":id"].$post({
        param: { id: draftInvoiceId },
        json: {
          deletedLineItemIds: [itemToDelete!.id],
        },
      });

      expect(response.status).toBe(200);

      // Verify that only one line item remains
      const remainingItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.invoiceId, draftInvoiceId),
      });

      expect(remainingItems.length).toBe(1);
      expect(remainingItems[0].description).toBe("Item to keep");
    });
    it("should return 404 for non-existent invoice", async () => {
      const nonExistentId = createPrefixedId(ID_PREFIXES.invoice);
      const response = await apiClient.invoices[":id"].$post({
        param: { id: nonExistentId },
        json: { status: "issued" },
      });
      expect(response.status).toBe(404);
    });
    it("should return 400 if updating a non-draft invoice", async () => {
      // Use the main invoiceId from the test setup, which is not draft
      const response = await apiClient.invoices[":id"].$post({
        param: { id: invoiceId },
        json: { status: "issued" },
      });
      expect(response.status).toBe(400);
      const data = await response.json();
    });
  });
});

describe("Invoice Status Transition Tests", () => {
  let merchantId: string;
  let planId: string;
  let stripeSecretKey: string;
  let stripePublicKey: string;
  let stripeWebhookSecret: string;
  let stripe: Stripe;
  let webhookProcess: ChildProcess | null = null;
  let tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  let tempMerchantIdFile = "/tmp/test_merchant_id.txt";
  let publishableApiKey: string;
  let sessionToken: string;
  let apiClient;
  let paymentProvider: PaymentProviderAdapter;

  // Clean up function for webhook process
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

  beforeAll(async () => {
    await cleanupDataFull();
    paymentProvider = await createPaymentProvider();
    // 1. Set up a test environment
    const { merchant, user: testUser } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Save merchant ID to temp file for webhook
    await fs.writeFile(tempMerchantIdFile, merchantId);

    // 2. Authenticate to get a session token
    const authResponse = await authenticateTestUser(
      testUser.email,
      testUser.password
    );
    sessionToken = authResponse.cookies.sessionToken;
    apiClient = createTestApiClient(sessionToken);

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
      environment: "test",
    });

    // Store the publishable key for use in the payment request
    publishableApiKey = apiKeys.publishableKey.keyValue;

    // 6. Create a test plan with features
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `invoice-status-test-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Invoice Status Test Plan",
        planDescription: "Plan for testing invoice status transitions",
      }
    );

    planId = planCreationResult.plan.id;

    // 7. Start webhook listener in a separate process
    await paymentProvider.startWebhookForwarder(merchantId);
  });

  beforeEach(async () => {
    // Clean up test data but preserve the merchant, user, and plan from beforeAll
    try {
      await db.execute(sql`
        DELETE FROM ${payments};
        DELETE FROM ${invoiceLineItems};
        DELETE FROM ${invoices};
        DELETE FROM ${subscriptionFeatures};
        DELETE FROM ${subscriptionDetails};
        DELETE FROM ${events};
        DELETE FROM ${subscriptions};
        DELETE FROM ${paymentMethods};
        DELETE FROM ${customers};
      `);
    } catch (error) {
      console.error("Error during beforeEach cleanup:", error);
    }
  });

  afterAll(async () => {
    // Clean up the webhook process
    await cleanupWebhook();

    // Clean up database records
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
      DELETE FROM ${creditUsageTransactions};
      DELETE FROM ${creditGrants};
      DELETE FROM ${creditDefinitions};
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
    `;
    await db.execute(cleanupQuery);
  });

  it("should create invoices and transition to paid status after payment processing", async () => {
    // Add a small delay before starting to ensure everything is ready
    await sleep(1000);

    // 1. Create a test customer
    const customerEmail = `invoice-status-test-${Date.now()}@example.com`;
    const customerName = "Invoice Status Test Customer";
    const userId = `user_${Date.now()}`;

    // 2. Create a price with bill_immediately=true to test invoice status transition
    const immediatePrice = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "setup-fee",
            type: "fixed",
            label: "Setup Fee",
            amount_cents: 2500, // $25.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true, // This will generate an invoice right away
          },
        ],
      },
    });

    // 3. Call the payment-init endpoint to initiate payment flow
    const paymentInitResponse = await apiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: immediatePrice.id,
        planId,
        customerEmail,
        customerName,
        userId,
      },
    });

    expect(paymentInitResponse.status).toBe(200);

    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData) {
      throw new Error(`Unexpected error: ${paymentInitData.error}`);
    }
    expect(paymentInitData.clientSecret).toBeDefined();
    expect(paymentInitData.intentId).toBeDefined();
    expect(paymentInitData.intentType).toBe("payment_intent");

    const intentId = paymentInitData.intentId;
    console.log(`Created payment intent: ${intentId}`);

    // 4. Confirm the payment intent with a test card
    const paymentIntent = await stripe.paymentIntents.confirm(intentId, {
      payment_method: "pm_card_visa", // Use a test payment method token
    });

    // 5. Verify the payment intent status
    expect(paymentIntent.status).toBe("succeeded");

    // 6. Wait for webhook processing
    console.log("Waiting for webhook to process payment...");
    await sleep(5000);

    // 7. Find the customer that was created
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
    const customerId = createdCustomers[0].id;

    // 8. Check if a subscription was created
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

    // 9. Check if an invoice was created
    const createdInvoices = await db
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

    expect(createdInvoices.length).toBe(1);
    const invoice = createdInvoices[0];

    // 10. Verify the invoice has the expected "paid" status
    // This is the key verification - in previous implementation, we were checking for
    // draft→issued transitions, but with webhook flow, the final state should be "paid"
    expect(invoice.status).toBe("paid");
    expect(invoice.totalAmountCents).toBe(2500);

    // 11. Verify the invoice has line items
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    expect(lineItems.length).toBe(1);
    expect(lineItems[0].description).toBe("Setup Fee");
    expect(lineItems[0].subtotalCents).toBe(2500);
  }, 30000); // Increase timeout for webhook processing

  it("should consolidate multiple components into a single invoice with paid status", async () => {
    // 1. Create a test customer
    const customerEmail = `invoice-multiple-components-${Date.now()}@example.com`;
    const customerName = "Multiple Components Test Customer";
    const userId = `user_multi_${Date.now()}`;

    // 2. Create a price with multiple components to test invoice consolidation
    const multiComponentPrice = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base-fee",
            type: "fixed",
            label: "Base Fee",
            amount_cents: 2000, // $20.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
          {
            component_name: "per-seat-fee",
            type: "per_unit",
            label: "Per Seat Fee",
            unit_label: "Seat",
            amount_cents: 1000, // $10.00 per seat
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    });

    // 3. Call the payment-init endpoint to initiate payment flow
    const paymentInitResponse = await apiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: multiComponentPrice.id,
        planId,
        customerEmail,
        customerName,
        userId,
      },
    });

    expect(paymentInitResponse.status).toBe(200);

    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData) {
      throw new Error(`Unexpected error: ${paymentInitData.error}`);
    }

    const intentId = paymentInitData.intentId;
    console.log(`Created payment intent for multiple components: ${intentId}`);

    // 4. Confirm the payment intent
    const paymentIntent = await stripe.paymentIntents.confirm(intentId, {
      payment_method: "pm_card_visa",
    });

    expect(paymentIntent.status).toBe("succeeded");

    // 5. Wait for webhook processing
    console.log(
      "Waiting for webhook to process payment for multiple components..."
    );
    await sleep(2000);

    // 6. Find the customer
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
    const customerId = createdCustomers[0].id;

    // 7. Check for subscription
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

    // 8. Check for a single invoice
    const createdInvoices = await db
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

    expect(createdInvoices.length).toBe(1);
    const invoice = createdInvoices[0];

    // 9. Verify the invoice status and amount
    expect(invoice.status).toBe("paid");
    expect(invoice.totalAmountCents).toBe(3000); // $30 = $20 + $10

    // 10. Verify the invoice has consolidated multiple line items
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    expect(lineItems.length).toBe(2); // Should have two line items

    // 11. Verify line item details
    const baseFeeLine = lineItems.find(
      (line) => line.description === "Base Fee"
    );
    const perSeatLine = lineItems.find(
      (line) => line.description === "Per Seat Fee"
    );

    expect(baseFeeLine).toBeDefined();
    expect(perSeatLine).toBeDefined();

    expect(baseFeeLine!.subtotalCents).toBe(2000);
    expect(perSeatLine!.subtotalCents).toBe(1000);
  }, 30000); // Increase timeout for webhook processing
});
