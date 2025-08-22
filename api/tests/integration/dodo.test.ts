import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  setDefaultTimeout,
} from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createTestPlanWithPrice,
} from "../test-helpers";
import { db } from "../../src/db/client";
import {
  payments as paymentsTable,
  invoices as invoicesTable,
  dodo as dodoDbSchema,
} from "@lumen/common/schema";
import { and, eq, isNull } from "drizzle-orm";
import { createPaymentProvider } from "../test-helpers/paymentProvider";
import { createTestPublishableKey } from "../test-helpers/data/api-keys";
import { testEnv } from "../test-env";

setDefaultTimeout(10000);

describe("Dodo Payments Integration", async () => {
  let merchantId: string;
  let sessionToken: string;
  let client: ReturnType<typeof createTestApiClient>;
  const paymentProvider = await createPaymentProvider("dodo");

  beforeEach(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
    client = createTestApiClient(sessionToken);

    await paymentProvider.registerIntegration(merchantId);
  });

  afterEach(async () => {
    await paymentProvider.cleanup();
    try {
      await db.delete(dodoDbSchema);
    } catch {}
  });

  it("should create a payment via payment-init and process Dodo webhook, updating invoice tax fields", async () => {
    // Create plan and price (with bill_immediately) for merchant
    const { plan, price } = await createTestPlanWithPrice(merchantId);

    // Create publishable key for public payment-init
    const publishable = await createTestPublishableKey({
      merchantId,
      environment: "live",
    });

    // Kick off payment-init
    const paymentInitResponse = await client.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishable.rawKeyValue,
        userId: `user_${Date.now()}`,
        planId: plan.id,
        priceId: price.id,
        customerEmail: "dodo-test@example.com",
        customerName: "Dodo Test User",
        customerAddress: "Main St 1",
        customerZip: "10115",
        customerCity: "Berlin",
        customerCountry: "DE",
        customerStateProvince: "BE",
      },
    });

    expect(paymentInitResponse.status).toBe(200);
    const initData = await paymentInitResponse.json();

    // Dodo returns subscription id and payment link
    if (!("id" in initData) || !("payment_link" in initData)) {
      throw new Error(
        `Unexpected payment-init response: ${JSON.stringify(initData)}`
      );
    }

    // The initial payment row uses externalPaymentId = Dodo subscription_id
    const dodoSubscriptionId = initData.id as string;

    // Locate the initial payment row created by payment-init
    const initialPayment = await db.query.payments.findFirst({
      where: and(
        eq(paymentsTable.merchantId, merchantId),
        eq(paymentsTable.externalPaymentId, dodoSubscriptionId)
      ),
    });
    expect(initialPayment).not.toBeNull();

    const tax_rate = 0.19;

    // @ts-ignore
    const amount = price.pricingData.components[0].amount_cents as number;
    const totalAmount = Math.round(amount * (1 + tax_rate));
    const taxAmount = Math.round(amount * tax_rate);

    const payload = {
      business_id: "bus_test",
      data: {
        billing: {
          city: "Berlin",
          country: "DE",
          state: "Berlin",
          street: "Kurfürstendamm 100",
          zipcode: "10707",
        },
        brand_id: "bus_test",
        business_id: "bus_test",
        card_issuing_country: "DE",
        card_last_four: "4242",
        card_network: "VISA",
        card_type: "CREDIT",
        created_at: new Date().toISOString(),
        currency: "USD",
        customer: {
          customer_id: "cus_test",
          email: "test@example.com",
          name: "Test User",
        },
        digital_products_delivered: false,
        discount_id: null,
        disputes: [],
        error_code: null,
        error_message: null,
        metadata: {
          lumen_payment_id: initialPayment!.id,
        },
        payload_type: "Payment",
        payment_id: testEnv.TEST_DODO_PAYMENT_ID,
        payment_link: paymentInitResponse.payment_link || "",
        payment_method: "card",
        payment_method_type: null,
        product_cart: null,
        refunds: [],
        settlement_amount: totalAmount,
        settlement_currency: "USD",
        settlement_tax: 0,
        status: "succeeded",
        subscription_id: `sub_1234567890`,
        tax: taxAmount,
        total_amount: totalAmount,
        updated_at: null,
      },
      timestamp: new Date().toISOString(),
      type: "payment.succeeded",
    };

    await fetch(`http://localhost:8000/v1/public/webhook-dodo/${merchantId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Fetch the updated payment by id (should now be succeeded and have Dodo payment_id)
    const payment = await db.query.payments.findFirst({
      where: eq(paymentsTable.id, initialPayment!.id),
    });

    expect(payment).not.toBeNull();
    expect(payment!.status).toBe("succeeded");

    // Invoice id should be set in metadata by webhook processing
    const invoiceId = (payment!.metadata as any)?.invoice_id as
      | string
      | undefined;
    expect(invoiceId).toBeDefined();

    const invoice = await db.query.invoices.findFirst({
      where: eq(invoicesTable.id, invoiceId!),
    });
    expect(invoice).not.toBeNull();
    console.log("🚀 ~ invoice:", invoice);

    // Dodo webhook overwrites tax_amount_cents based on PSP payload; rate/method/jurisdiction are preserved from metadata
    expect(invoice!.subtotalCents).toBe(totalAmount - taxAmount);
    expect(invoice!.taxAmountCents).toBe(taxAmount);
  });
});
