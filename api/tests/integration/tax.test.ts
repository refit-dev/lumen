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
  merchantTaxConfig,
  taxRegistrations,
  usNexusConfig,
  taxRateDefinitions,
  invoices,
  invoiceLineItems,
  subscriptions,
  subscriptionDetails,
  subscriptionsScheduledChanges,
  subscriptionPriceOverrides,
  customers,
  merchants,
  payments,
  paymentMethods,
  events,
  features,
  featureMetrics,
  metrics,
  subscriptionFeatures,
} from "@lumen/common/schema";
import { sql, eq, and, isNull, desc } from "drizzle-orm";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlanWithFeatures,
  createTestPrice,
  createTestCustomer,
  createTestApiClient,
  createTestApiKeys,
  cleanupDataFull,
} from "../test-helpers";
import { hc } from "hono/client";
import { AppType } from "../../src/routes";
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
import { processInvoicePdfGeneration } from "../../src/helpers/invoices";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { prorateAmountCents } from "../../src/helpers/proration";
import {
  createPaymentProvider,
  PaymentProviderAdapter,
} from "../test-helpers/paymentProvider";

type CollectPaymentJobPayload = z.infer<typeof collectPaymentPayloadSchema>;

const customerAddressObj = {
  customerAddress: "123 Test Street",
  customerZip: "12345",
  customerCity: "Test City",
  customerCountry: "US",
  customerStateProvince: "CA",
};

const cleanupTestData = async () => {
  // this is different from cleanupDataFull because it doesn't clean up the merchant, user, and payment provider config
  try {
    // First batch: Clean up transaction records and invoice data
    await db.execute(sql`
      DELETE FROM ${payments};
      DELETE FROM ${invoiceLineItems};
      DELETE FROM ${invoices};
      DELETE FROM ${subscriptionFeatures};
      DELETE FROM ${subscriptionDetails};
      DELETE FROM ${events};
    `);

    // Second batch: Clean up subscription-related records
    await db.execute(sql`
      DELETE FROM ${subscriptionsScheduledChanges};
      DELETE FROM ${subscriptions};
      DELETE FROM ${subscriptionPriceOverrides};
      DELETE FROM ${paymentMethods};
    `);

    // Third batch: Clean up tax configuration records
    await db.execute(sql`
      DELETE FROM ${taxRegistrations};
      DELETE FROM ${usNexusConfig};
      DELETE FROM ${invoiceLineItems};
      DELETE FROM ${invoices};
      DELETE FROM ${customers};
      DELETE FROM ${taxRateDefinitions};
      DELETE FROM ${merchantTaxConfig};
    `);

    // Fourth batch: Clean up customers and features
    await db.execute(sql`
      DELETE FROM ${features};
      DELETE FROM ${featureMetrics};
      DELETE FROM ${metrics};
    `);
  } catch (error) {
    console.error("Error during test cleanup:", error);
    throw error;
  }
};

describe("Tax System Integration Tests", () => {
  let merchantId: string;
  let sessionToken: string;
  let baseApiClient: any;
  let authedApiClient: ReturnType<typeof hc<AppType>>;
  let collectPaymentJobTriggerSpy: ReturnType<typeof spyOn>;
  let webhookProcess: ChildProcess | null = null;
  const tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  const tempMerchantIdFile = "/tmp/test_merchant_id.txt";
  let publishableApiKey: string;
  let apiUrl: string;
  let triggerApiAccessKey: string;
  let paymentProvider: PaymentProviderAdapter;

  // Test data that will be reused across tests
  let testPlanId: string;
  let testPriceId: string;

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

    // Create reusable test plan and price
    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      [],
      {
        stablePlanId: `tax-test-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "Tax Test Plan",
      }
    );
    testPlanId = planCreationResult.plan.id;

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
            amount_cents: 10000, // $100.00
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });
    testPriceId = testPrice.id;
  });

  afterAll(async () => {
    if (webhookProcess && webhookProcess.pid && !webhookProcess.killed) {
      const killed = process.kill(webhookProcess.pid, "SIGINT");
      if (killed) {
        await new Promise((resolve) => webhookProcess!.on("close", resolve));
      }
      webhookProcess = null;
    }
    try {
      await fs.unlink(tempWebhookSecretFile).catch(() => {});
      await fs.unlink(tempMerchantIdFile).catch(() => {});
    } catch (err) {
      /* ignore */
    }
    await cleanupDataFull();
  });

  beforeEach(async () => {
    // Ensure merchant starts in baseline US location to avoid bleed-through
    try {
      if (merchantId) {
        await db
          .update(merchants)
          .set({ country: "US", stateProvince: "CA" })
          .where(eq(merchants.id, merchantId));
      }
    } catch (err) {
      console.warn("Merchant reset failed in beforeEach:", err);
    }

    try {
      await cleanupTestData();
    } catch (error) {
      console.warn(
        "Cleanup failed in beforeEach, attempting to continue:",
        error
      );
    }
    collectPaymentJobTriggerSpy = spyOn(collectPaymentJob, "batchTrigger");
  });

  afterEach(async () => {
    if (collectPaymentJobTriggerSpy) collectPaymentJobTriggerSpy.mockRestore();

    try {
      await cleanupTestData();
    } catch (error) {
      console.warn("Cleanup failed in afterEach:", error);
    }
  });

  // Helper function to create subscription and trigger billing
  async function createSubscriptionAndBill(customerData: {
    name: string;
    email: string;
    billingCountry: string;
    billingStateProvince?: string;
    businessName?: string;
    taxId?: string;
    taxExempt?: boolean;
    taxRateDefinitionId?: string;
    taxCalculationMethod?: string;
  }) {
    const userId = `user-${Date.now()}`;

    // Create payment and subscription
    const paymentInitResponse = await baseApiClient.public[
      "payment-init"
    ].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        planId: testPlanId,
        priceId: testPriceId,
        customerEmail: customerData.email,
        customerName: customerData.name,
        userId,
        ...(process.env.PAYMENT_PROVIDER === "dodo" ? customerAddressObj : {}),
      },
    });

    if (paymentInitResponse.status !== 200) {
      const errorData = await paymentInitResponse.json();
      console.error(
        "Payment init failed:",
        paymentInitResponse.status,
        errorData
      );
      throw new Error(
        `Payment init failed: ${paymentInitResponse.status} - ${JSON.stringify(errorData)}`
      );
    }
    const paymentInitData = await paymentInitResponse.json();
    if ("error" in paymentInitData)
      throw new Error(paymentInitData.error as string);

    await paymentProvider.completePaymentInit(paymentInitData);

    await sleep(3000); // Wait for webhook processing

    // Get the customer ID that was created by payment-init
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.merchantId, merchantId),
        eq(customers.externalCustomerId, userId),
        isNull(customers.deletedAt)
      ),
    });

    expect(customer).toBeDefined();
    const customerId = customer!.id;

    // Update customer with tax information for testing
    const updatedCustomer = await db
      .update(customers)
      .set({
        billingCountry: customerData.billingCountry,
        billingStateProvince: customerData.billingStateProvince,
        businessName:
          customerData.businessName !== undefined
            ? customerData.businessName
            : "Test Business",
        taxId: customerData.taxId,
        taxExempt: customerData.taxExempt || false,
        taxRateDefinitionId: customerData.taxRateDefinitionId,
        taxCalculationMethod: customerData.taxCalculationMethod,
      })
      .where(eq(customers.id, customerId))
      .returning();

    console.log("Updated customer:", updatedCustomer);

    const subscription = await db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.customerId, customerId),
        eq(subscriptions.planId, testPlanId)
      ),
    });
    expect(subscription).toBeDefined();

    console.log("Subscription:", subscription);

    // Trigger billing by manipulating subscription details
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, subscription!.id),
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 1);
    for (const detail of subDetails) {
      const previousBillingDate = new Date(
        detail.previousBillingDate || new Date()
      );
      previousBillingDate.setDate(previousBillingDate.getDate() - 30);

      await db
        .update(subscriptionDetails)
        .set({
          previousBillingDate: previousBillingDate,
          nextBillingDate: dueDate,
        })
        .where(eq(subscriptionDetails.id, detail.id));
    }

    // Mock and trigger billing
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

    // Trigger the billing cycle
    await processBillingCycle(apiUrl, triggerApiAccessKey!, new Date());

    // Wait for webhook to process before cleanup (prevents race condition)
    await sleep(2000);

    // Get the generated invoice
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.customerId, customerId),
      orderBy: desc(invoices.createdAt),
      with: { lineItems: true },
    });

    return { customerId, subscriptionId: subscription!.id, invoice };
  }

  // Helper function to configure merchant tax settings
  async function configureMerchantTax(config: {
    autoTaxCalculation: boolean;
    defaultTaxRate?: string;
  }) {
    await authedApiClient.tax["config"]["update"].$post({
      json: config,
    });
  }

  // Helper function to create tax rate definition
  async function createTaxRateDefinition(rateData: {
    name: string;
    description?: string;
    taxRate: string;
    jurisdiction?: string;
  }) {
    const response = await authedApiClient.tax["rate-definitions"][
      "create"
    ].$post({
      json: rateData,
    });
    const result = await response.json();
    return result;
  }

  // Helper function to configure US nexus
  async function configureUsNexus(
    state: string,
    nexusData: {
      hasNexus: boolean;
      nexusType?: string;
      hasOffices?: boolean;
      hasEmployees?: boolean;
    }
  ) {
    await authedApiClient.tax.nexus[state]["update"].$post({
      json: nexusData,
    });
  }

  describe("Tax Exemption Scenarios", () => {
    it("should not apply tax to tax-exempt customers", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Create tax-exempt customer
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Tax Exempt Customer",
          email: `tax-exempt-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
          taxExempt: true,
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(0);
      expect(invoice!.taxJurisdiction).toBe("exempt");
      expect(invoice!.taxCalculationMethod).toBe("exempt");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify tax exempt line item was created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0); // No tax charged
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("exempt");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("exempt");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0);
      expect(taxLineItems[0].taxMetadata?.exemptionReason).toBe(
        "customer_exempt"
      );
      expect(taxLineItems[0].description).toBe("0%: Tax Exempt");

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal
    }, 40000);

    it("should apply zero tax with proper exemption reason for tax-exempt customers", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Create tax-exempt customer with specific exemption reason
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Tax Exempt Nonprofit",
          email: `tax-exempt-nonprofit-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "NY",
          taxExempt: true,
        });

      // Update customer with specific exemption reason
      await db
        .update(customers)
        .set({
          taxExemptionReason: "nonprofit_organization",
        })
        .where(eq(customers.id, customerId));

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(0);
      expect(invoice!.taxJurisdiction).toBe("exempt");
      expect(invoice!.taxCalculationMethod).toBe("exempt");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify tax exempt line item was created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0); // No tax charged
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("exempt");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("exempt");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0);
      expect(taxLineItems[0].taxMetadata?.exemptionReason).toBe(
        "customer_exempt"
      );
      expect(taxLineItems[0].description).toBe("0%: Tax Exempt");

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal

      // Verify customer has exemption reason stored
      const updatedCustomer = await db.query.customers.findFirst({
        where: eq(customers.id, customerId),
      });
      expect(updatedCustomer!.taxExemptionReason).toBe(
        "nonprofit_organization"
      );
    }, 40000);
  });

  describe("US Domestic Tax Scenarios", () => {
    beforeEach(async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });
    });

    it("should apply state tax for same-state US transactions", async () => {
      // Create US customer in California (same state transactions should have tax)
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "US California Customer",
          email: `us-ca-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBeGreaterThan(0);
      expect(invoice!.taxJurisdiction).toBe("US-CA");
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBeGreaterThan(0);

      // Verify tax line items were created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBeGreaterThan(0);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("sales_tax");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("US-CA");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("US-CA");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBeGreaterThan(0);
      expect(taxLineItems[0].description).toContain("CA Sales Tax");
    }, 40000);

    it("should apply state tax when merchant has nexus in customer state", async () => {
      // Configure US nexus for Texas (customer state)
      await configureUsNexus("TX", {
        hasNexus: true,
        nexusType: "physical",
        hasOffices: true,
        hasEmployees: true,
      });

      // Create US customer in Texas (different state from merchant who is in CA)
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "US Texas Customer",
          email: `us-tx-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "TX",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBeGreaterThan(0);
      expect(invoice!.taxJurisdiction).toBe("US-TX");
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBeGreaterThan(0);

      // Verify tax line items were created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBeGreaterThan(0);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("sales_tax");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("US-TX");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("US-TX");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBeGreaterThan(0);
      expect(taxLineItems[0].description).toContain("TX Sales Tax");
    }, 40000);

    it("should not apply tax when merchant has no nexus in customer state", async () => {
      // Explicitly configure no nexus for Florida (customer state)
      await configureUsNexus("FL", {
        hasNexus: false,
        nexusType: "none",
        hasOffices: false,
        hasEmployees: false,
      });

      // Create US customer in Florida (different state from merchant who is in CA, no nexus)
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "US Florida Customer",
          email: `us-fl-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "FL",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(0); // No tax due to no nexus
      expect(invoice!.taxJurisdiction).toBe("US-FL");
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify zero tax line item was created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0); // No tax charged
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("zero");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("US-FL");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0);
      expect(taxLineItems[0].taxMetadata?.exemptionReason).toBe("no_nexus");
      expect(taxLineItems[0].description).toBe("0%: No Nexus");

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal
    }, 40000);

    it("should handle US nexus configuration properly", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Test nexus configuration for Washington state
      await configureUsNexus("WA", {
        hasNexus: true,
        nexusType: "economic",
        hasOffices: false,
        hasEmployees: false,
      });

      // Create customer in Washington state
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Washington Customer",
          email: `wa-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "WA",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBeGreaterThan(0); // Should have tax due to nexus
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("US-WA");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBeGreaterThan(0);

      // Verify tax line items were created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBeGreaterThan(0);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("sales_tax");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("US-WA");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("US-WA");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBeGreaterThan(0);
      expect(taxLineItems[0].description).toContain("WA Sales Tax");

      // Now test disabling nexus
      await configureUsNexus("WA", {
        hasNexus: false,
        nexusType: "none",
        hasOffices: false,
        hasEmployees: false,
      });

      // Create another customer in Washington state (should have no tax now)
      const { customerId: customerId2, invoice: invoice2 } =
        await createSubscriptionAndBill({
          name: "Washington Customer No Nexus",
          email: `wa-customer-no-nexus-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "WA",
        });

      expect(invoice2).toBeDefined();
      expect(invoice2!.taxAmountCents).toBe(0); // No tax due to no nexus
      expect(invoice2!.taxCalculationMethod).toBe("auto");
      expect(invoice2!.taxJurisdiction).toBe("US-WA");
      expect(parseFloat(invoice2!.effectiveTaxRate || "0")).toBe(0);

      // Verify zero tax line item was created with proper metadata
      const taxLineItems2 = invoice2!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems2.length).toBe(1);
      expect(taxLineItems2[0].subtotalCents).toBe(0); // No tax charged
      expect(taxLineItems2[0].taxMetadata?.taxType).toBe("zero");
      expect(taxLineItems2[0].taxMetadata?.jurisdiction).toBe("US-WA");
      expect(taxLineItems2[0].taxMetadata?.taxRate).toBe(0);
      expect(taxLineItems2[0].taxMetadata?.exemptionReason).toBe("no_nexus");
      expect(taxLineItems2[0].description).toBe("0%: No Nexus");
    }, 40000);
  });

  describe("EU VAT Scenarios", () => {
    it("should apply domestic VAT for same-country EU transactions", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be Germany-based for this test
      await db
        .update(merchants)
        .set({ country: "DE" })
        .where(eq(merchants.id, merchantId));

      // Create German customer for domestic VAT calculation
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "German Domestic Customer",
          email: `de-domestic-customer-${Date.now()}@example.com`,
          billingCountry: "DE",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(1900); // 19% German VAT of $100.00 = $19.00
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("DE");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.19); // 19% VAT

      // Verify German VAT line items were created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(1900); // 19% of $100.00
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("vat");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("DE");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("DE");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0.19);
      expect(taxLineItems[0].description).toBe("19.00%: EU VAT");

      // Verify total includes VAT
      expect(invoice!.totalAmountCents).toBe(11900); // $100.00 + $19.00 = $119.00

      // Reset merchant country back to US for other tests
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should apply reverse charge (0% tax) for B2B EU cross-border with VAT ID", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be Germany-based for this test
      await db
        .update(merchants)
        .set({ country: "DE" })
        .where(eq(merchants.id, merchantId));

      // Create French B2B customer with VAT ID for reverse charge scenario
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "French B2B Customer",
          email: `fr-b2b-customer-${Date.now()}@example.com`,
          billingCountry: "FR",
          taxId: "FR12345678901", // Valid VAT ID format triggers reverse charge
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(0); // Reverse charge = 0% tax for seller
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("FR");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0); // 0% due to reverse charge

      // Verify reverse charge tax line item was created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0); // No tax charged
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("reverse_charge");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("FR");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("FR");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0);
      expect(taxLineItems[0].taxMetadata?.exemptionReason).toBe(
        "reverse_charge"
      );
      expect(taxLineItems[0].description).toBe("0%: Reverse Charge");

      // Verify subtotal equals total (no tax charged to seller)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal

      // Generate PDF for reverse charge invoice
      console.log("🔄 Generating PDF for reverse charge invoice...");

      // Get the full invoice data with customer and merchant for PDF generation
      const fullInvoice = await db.query.invoices.findFirst({
        where: eq(invoices.id, invoice!.id),
        with: {
          customer: true,
          merchant: true,
          lineItems: true,
        },
      });

      expect(fullInvoice).toBeDefined();
      expect(fullInvoice!.customer).toBeDefined();
      expect(fullInvoice!.merchant).toBeDefined();

      // Convert to the format expected by PDF generation
      // Separate tax line items from regular line items for PDF generation
      const pdfTaxLineItems = fullInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      const pdfRegularLineItems = fullInvoice!.lineItems.filter(
        (item) => item.type !== "tax"
      );

      const invoiceForPdf = {
        id: fullInvoice!.id,
        customerInvoiceNumber: fullInvoice!.customerInvoiceNumber,
        currency: fullInvoice!.currency,
        issueDate: fullInvoice!.issueDate
          ? fullInvoice!.issueDate.toISOString()
          : null,
        dueDate: fullInvoice!.dueDate
          ? fullInvoice!.dueDate.toISOString()
          : null,
        billingPeriodStartDate: (fullInvoice as any).billingPeriodStart
          ? (fullInvoice as any).billingPeriodStart.toISOString()
          : null,
        billingPeriodEndDate: (fullInvoice as any).billingPeriodEnd
          ? (fullInvoice as any).billingPeriodEnd.toISOString()
          : null,
        subtotalCents: fullInvoice!.subtotalCents,
        taxAmountCents: fullInvoice!.taxAmountCents,
        totalAmountCents: fullInvoice!.totalAmountCents,
        effectiveTaxRate: fullInvoice!.effectiveTaxRate,
        taxJurisdiction: fullInvoice!.taxJurisdiction,
        taxCalculationMethod: fullInvoice!.taxCalculationMethod,
        lineItems: pdfRegularLineItems.map((item) => ({
          id: item.id,
          description: item.description ?? "",
          subtotalCents: item.subtotalCents,
        })),
        taxLineItems: pdfTaxLineItems.map((item) => ({
          type: "tax" as const,
          description: item.description ?? "",
          subtotalCents: item.subtotalCents,
          taxMetadata: item.taxMetadata || {},
          billingPeriodStart: item.billingPeriodStart || new Date(),
          billingPeriodEnd: item.billingPeriodEnd || new Date(),
        })),
        customer: fullInvoice!.customer,
        merchant: fullInvoice!.merchant,
      };

      const pdfResult = await processInvoicePdfGeneration([
        invoiceForPdf as any,
      ]);

      expect(pdfResult.success).toBe(1);
      expect(pdfResult.failed).toBe(0);
      expect(pdfResult.generatedPdfs.length).toBe(1);

      const generatedPdf = pdfResult.generatedPdfs[0];
      expect(generatedPdf.status).toBe("success");
      expect(generatedPdf.pdfBuffer).toBeTruthy();
      expect(generatedPdf.pdfData?.isReverseCharge).toBe(true);
      expect(generatedPdf.pdfData?.reverseChargeMessage).toContain(
        "EU Reverse Charge"
      );
      expect(generatedPdf.pdfData?.reverseChargeMessage).toContain("FR");

      if (generatedPdf.pdfBuffer) {
        expect(generatedPdf.pdfBuffer instanceof Buffer).toBe(true);
        expect(generatedPdf.pdfBuffer.length).toBeGreaterThan(0);

        // Save PDF for inspection
        const tempDir = join(process.cwd(), "..", "tmp");
        const pdfPath = join(tempDir, "test-reverse-charge-invoice.pdf");

        // Create tmp directory if it doesn't exist
        mkdirSync(tempDir, { recursive: true });

        // Write the PDF
        writeFileSync(pdfPath, generatedPdf.pdfBuffer);
        console.log(
          "\n✨ Reverse charge PDF saved for inspection at:",
          pdfPath,
          "\n"
        );
      }

      // Reset merchant country back to US for other tests
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should apply destination VAT for B2C EU cross-border transactions", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be Germany-based for this test
      await db
        .update(merchants)
        .set({ country: "DE" })
        .where(eq(merchants.id, merchantId));

      // Create French B2C customer (no VAT ID) for destination VAT scenario
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "French B2C Customer",
          email: `fr-b2c-customer-${Date.now()}@example.com`,
          billingCountry: "FR",
          // No taxId - B2C customer triggers destination VAT
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(2000); // 20% French VAT of $100.00 = $20.00
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("FR");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.2); // 20% French VAT

      // Verify French VAT line items were created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(2000); // 20% of $100.00
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("vat");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("FR");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("FR");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0.2);
      expect(taxLineItems[0].description).toBe("20.00%: EU VAT");

      // Verify total includes destination VAT
      expect(invoice!.totalAmountCents).toBe(12000); // $100.00 + $20.00 = $120.00

      // Reset merchant country back to US for other tests
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should handle VAT ID validation properly", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be Germany-based for this test
      await db
        .update(merchants)
        .set({ country: "DE" })
        .where(eq(merchants.id, merchantId));

      // Test 1: Valid VAT ID format should trigger reverse charge
      const { customerId: validVatCustomerId, invoice: validVatInvoice } =
        await createSubscriptionAndBill({
          name: "Valid VAT ID Customer",
          email: `valid-vat-customer-${Date.now()}@example.com`,
          billingCountry: "FR",
          taxId: "FR12345678901", // Valid VAT ID format
        });

      expect(validVatInvoice).toBeDefined();
      expect(validVatInvoice!.taxAmountCents).toBe(0); // Reverse charge
      expect(validVatInvoice!.taxCalculationMethod).toBe("auto");

      await sleep(2000);
      // Test 2: Customer without VAT ID should get destination VAT
      const { customerId: noVatCustomerId, invoice: noVatInvoice } =
        await createSubscriptionAndBill({
          name: "No VAT ID Customer",
          email: `no-vat-customer-${Date.now()}@example.com`,
          billingCountry: "FR",
          // No taxId provided
        });

      expect(noVatInvoice).toBeDefined();
      expect(noVatInvoice!.taxAmountCents).toBe(2000); // 20% French VAT
      expect(noVatInvoice!.taxCalculationMethod).toBe("auto");

      await sleep(2000);
      // Test 3: Empty VAT ID should be treated as no VAT ID
      const { customerId: emptyVatCustomerId, invoice: emptyVatInvoice } =
        await createSubscriptionAndBill({
          name: "Empty VAT ID Customer",
          email: `empty-vat-customer-${Date.now()}@example.com`,
          billingCountry: "FR",
          taxId: "", // Empty VAT ID
        });

      expect(emptyVatInvoice).toBeDefined();
      expect(emptyVatInvoice!.taxAmountCents).toBe(2000); // 20% French VAT (treated as B2C)
      expect(emptyVatInvoice!.taxCalculationMethod).toBe("auto");

      // Reset merchant country back to US for other tests
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);
  });

  describe("Manual Tax Rate Scenarios", () => {
    it("should use customer-assigned tax rate definition over merchant default", async () => {
      // Configure merchant for manual tax calculation with a default rate
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: "0.085", // 8.5% default rate (stored as decimal)
      });

      // Create a custom tax rate definition
      const response = await authedApiClient.tax["rate-definitions"][
        "create"
      ].$post({
        json: {
          name: "Premium Customer Rate",
          description: "Special tax rate for premium customers",
          taxRate: "0.095", // 9.5% special rate (stored as decimal, fits in precision 5,4)
          jurisdiction: "US-NY",
        },
      });

      if (response.status !== 201) {
        const errorData = await response.json();
        console.error(
          "Tax rate definition creation failed:",
          response.status,
          errorData
        );
        throw new Error(
          `Failed to create tax rate definition: ${response.status} - ${JSON.stringify(errorData)}`
        );
      }

      const taxRateDefResponse = await response.json();
      if ("error" in taxRateDefResponse) {
        throw new Error(
          `Failed to create tax rate definition: ${taxRateDefResponse.error}`
        );
      }

      const taxRateDefinitionId = (taxRateDefResponse as any).id;

      // Create customer with specific tax rate definition
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Premium Customer",
          email: `premium-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "NY",
          taxRateDefinitionId: taxRateDefinitionId,
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(950); // 9.5% of $100.00 = $9.50
      expect(invoice!.taxCalculationMethod).toBe("manual");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.095); // 9.5%

      // Verify tax line items were created with customer-specific rate and proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(950); // 9.5% of $100.00
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("manual");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0.095);
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBeDefined();
      expect(taxLineItems[0].taxMetadata?.rateSource).toContain(
        "Premium Customer Rate"
      );
      expect(taxLineItems[0].description).toBe("9.50%: Manual Tax");
    }, 40000);

    it("should fall back to merchant default rate when customer has no tax rate definition", async () => {
      // Configure merchant for manual tax calculation with a default rate
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: "0.075", // 7.5% default rate
      });

      // Create customer WITHOUT a specific tax rate definition (should use merchant default)
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Regular Customer",
          email: `regular-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
          // No taxRateDefinitionId - should fall back to merchant default
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(750); // 7.5% of $100.00 = $7.50
      expect(invoice!.taxCalculationMethod).toBe("manual");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.075); // 7.5%

      // Verify tax line items were created with merchant default rate and proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(750); // 7.5% of $100.00
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("manual");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0.075);
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBeDefined();
      expect(taxLineItems[0].taxMetadata?.rateSource).toBe("default");
      expect(taxLineItems[0].description).toBe("7.50%: Manual Tax");
    }, 40000);

    it("should apply zero tax when no manual rates are configured", async () => {
      // Configure merchant for manual tax calculation with NO default rate
      await configureMerchantTax({
        autoTaxCalculation: false,
        // No defaultTaxRate provided - should result in zero tax
      });

      // Create customer without any tax rate definition (should use zero tax)
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Regular Customer No Tax",
          email: `regular-customer-no-tax-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
          // No taxRateDefinitionId and no merchant default rate - should be zero tax
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(0); // No tax due to no rates configured
      expect(invoice!.taxCalculationMethod).toBe("manual");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify zero tax line item was created with proper metadata
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0); // No tax charged
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("zero");
      expect(taxLineItems[0].taxMetadata?.taxRate).toBe(0);
      expect(taxLineItems[0].taxMetadata?.exemptionReason).toBe(
        "no_manual_rate_configured"
      );
      expect(taxLineItems[0].description).toBe("0%: No Manual Rate");

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal
    }, 40000);

    it("should create and use tax rate definitions correctly", async () => {
      // Configure merchant for manual tax calculation
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: "0.08", // 8% default rate
      });

      // Create multiple tax rate definitions
      const californiaRateResponse = await authedApiClient.tax[
        "rate-definitions"
      ]["create"].$post({
        json: {
          name: "California Sales Tax",
          description: "Standard California sales tax rate",
          taxRate: "0.0875", // 8.75% (stored as decimal)
          jurisdiction: "US-CA",
        },
      });
      expect(californiaRateResponse.status).toBe(201);
      const californiaRateData = await californiaRateResponse.json();
      const californiaRateId = (californiaRateData as any).id;

      const texasRateResponse = await authedApiClient.tax["rate-definitions"][
        "create"
      ].$post({
        json: {
          name: "Texas Sales Tax",
          description: "Standard Texas sales tax rate",
          taxRate: "0.0625", // 6.25% (stored as decimal)
          jurisdiction: "US-TX",
        },
      });
      expect(texasRateResponse.status).toBe(201);
      const texasRateData = await texasRateResponse.json();
      const texasRateId = (texasRateData as any).id;

      // Create customer with California tax rate
      const { customerId: caCustomerId, invoice: caInvoice } =
        await createSubscriptionAndBill({
          name: "California Customer",
          email: `ca-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
          taxRateDefinitionId: californiaRateId,
        });

      // Verify California customer gets correct tax rate
      expect(caInvoice).toBeDefined();
      expect(caInvoice!.taxAmountCents).toBe(875); // 8.75% of $100.00 = $8.75
      expect(caInvoice!.taxCalculationMethod).toBe("manual");
      expect(parseFloat(caInvoice!.effectiveTaxRate || "0")).toBe(0.0875);

      const caTaxLineItems = caInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(caTaxLineItems.length).toBe(1);
      expect(caTaxLineItems[0].subtotalCents).toBe(875); // 8.75% of $100.00
      expect(caTaxLineItems[0].taxMetadata?.taxType).toBe("manual");
      expect(caTaxLineItems[0].taxMetadata?.taxRate).toBe(0.0875);
      expect(caTaxLineItems[0].taxMetadata?.jurisdiction).toBeDefined();
      expect(caTaxLineItems[0].taxMetadata?.rateSource).toContain(
        "California Sales Tax"
      );
      expect(caTaxLineItems[0].description).toBe("8.75%: Manual Tax");

      // Create customer with Texas tax rate
      const { customerId: txCustomerId, invoice: txInvoice } =
        await createSubscriptionAndBill({
          name: "Texas Customer",
          email: `tx-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "TX",
          taxRateDefinitionId: texasRateId,
        });

      // Verify Texas customer gets correct tax rate
      expect(txInvoice).toBeDefined();
      expect(txInvoice!.taxAmountCents).toBe(625); // 6.25% of $100.00 = $6.25
      expect(txInvoice!.taxCalculationMethod).toBe("manual");
      expect(parseFloat(txInvoice!.effectiveTaxRate || "0")).toBe(0.0625);

      const txTaxLineItems = txInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(txTaxLineItems.length).toBe(1);
      expect(txTaxLineItems[0].subtotalCents).toBe(625); // 6.25% of $100.00
      expect(txTaxLineItems[0].taxMetadata?.taxType).toBe("manual");
      expect(txTaxLineItems[0].taxMetadata?.taxRate).toBe(0.0625);
      expect(txTaxLineItems[0].taxMetadata?.jurisdiction).toBeDefined();
      expect(txTaxLineItems[0].taxMetadata?.rateSource).toContain(
        "Texas Sales Tax"
      );
      expect(txTaxLineItems[0].description).toBe("6.25%: Manual Tax");

      // Verify we can list and retrieve the tax rate definitions
      const rateDefinitionsResponse =
        await authedApiClient.tax["rate-definitions"].$get();
      expect(rateDefinitionsResponse.status).toBe(200);
      const rateDefinitions = await rateDefinitionsResponse.json();
      expect(Array.isArray(rateDefinitions)).toBe(true);

      // Type guard to ensure we have an array, not an error object
      if (!Array.isArray(rateDefinitions)) {
        throw new Error(
          `Expected array of rate definitions, got: ${JSON.stringify(rateDefinitions)}`
        );
      }

      expect(rateDefinitions.length).toBeGreaterThanOrEqual(2);

      // Find our created definitions
      const caRateDef = rateDefinitions.find(
        (def: any) => def.id === californiaRateId
      );
      const txRateDef = rateDefinitions.find(
        (def: any) => def.id === texasRateId
      );
      expect(caRateDef).toBeDefined();
      expect(txRateDef).toBeDefined();
      expect(caRateDef!.name).toBe("California Sales Tax");
      expect(txRateDef!.name).toBe("Texas Sales Tax");
    }, 40000);
  });

  describe("Auto vs Manual Tax Calculation", () => {
    it("should use automatic calculation when merchant enables auto tax", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
        // defaultTaxRate is ignored when autoTaxCalculation is true
      });

      // Create US customer for automatic tax calculation
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Auto Tax Customer",
          email: `auto-tax-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
          // No taxRateDefinitionId - should use automatic calculation
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBeGreaterThan(0); // Should have tax with automatic calculation
      expect(invoice!.taxCalculationMethod).toBe("auto"); // Should use automatic calculation
      expect(invoice!.taxJurisdiction).toBe("US-CA");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBeGreaterThan(0);

      // Verify tax line items were created with automatic calculation
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBeGreaterThan(0);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("sales_tax");
      expect(taxLineItems[0].taxMetadata?.jurisdiction).toBe("US-CA");
      expect(taxLineItems[0].description).toContain("CA Sales Tax");

      // Verify total includes tax
      expect(invoice!.subtotalCents).toBeDefined();
      expect(invoice!.totalAmountCents).toBeGreaterThan(
        invoice!.subtotalCents!
      );
      expect(invoice!.totalAmountCents).toBe(
        (invoice!.subtotalCents || 0) + invoice!.taxAmountCents!
      );
    }, 40000);

    it("should use manual rates when merchant disables auto tax", async () => {
      // Configure merchant for manual tax calculation with default rate
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: "0.09", // 9% default manual rate
      });

      // Create customer for manual tax calculation
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Manual Tax Customer",
          email: `manual-tax-customer-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
          // No taxRateDefinitionId - should use merchant default manual rate
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(900); // 9% of $100.00 = $9.00
      expect(invoice!.taxCalculationMethod).toBe("manual"); // Should use manual calculation
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.09); // 9%

      // Verify tax line items were created with manual calculation
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("manual");
      expect(taxLineItems[0].taxMetadata?.rateSource).toBe("default");
      expect(taxLineItems[0].description).toBe("9.00%: Manual Tax");

      // Verify total includes tax
      expect(invoice!.subtotalCents).toBeDefined();
      expect(invoice!.totalAmountCents).toBe(
        (invoice!.subtotalCents || 0) + invoice!.taxAmountCents!
      );
      expect(invoice!.totalAmountCents).toBe(10900); // $100.00 + $9.00 = $109.00
    }, 40000);

    it("should respect customer tax calculation method override", async () => {
      // Configure merchant for automatic tax calculation (default)
      await configureMerchantTax({
        autoTaxCalculation: true,
        defaultTaxRate: "0.08", // This should be ignored for auto calculation
      });

      // Create customer with manual tax calculation method override
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Customer Override Manual",
          email: `customer-override-manual-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
          taxCalculationMethod: "manual", // Override to manual despite merchant setting auto
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(800); // 8% of $100.00 = $8.00 (using default rate)
      expect(invoice!.taxCalculationMethod).toBe("manual"); // Should respect customer override
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.08);

      // Verify tax line items were created with manual calculation
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("manual");
      expect(taxLineItems[0].taxMetadata?.rateSource).toBe("default");
      expect(taxLineItems[0].description).toBe("8.00%: Manual Tax");

      // Now test the opposite scenario: merchant manual, customer auto override
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: "0.12", // 12% manual rate
      });

      const { customerId: customerId2, invoice: invoice2 } =
        await createSubscriptionAndBill({
          name: "Customer Override Auto",
          email: `customer-override-auto-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
          taxCalculationMethod: "auto", // Override to auto despite merchant setting manual
        });

      expect(invoice2).toBeDefined();
      expect(invoice2!.taxAmountCents).toBeGreaterThan(0); // Should calculate automatically
      expect(invoice2!.taxCalculationMethod).toBe("auto"); // Should respect customer override
      expect(invoice2!.taxJurisdiction).toBe("US-CA");

      // Verify auto calculation was used (not the merchant's 12% manual rate)
      const taxLineItems2 = invoice2!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems2.length).toBeGreaterThan(0);
      expect(taxLineItems2[0].taxMetadata?.taxType).toBe("sales_tax");
      expect(taxLineItems2[0].description).toContain("CA Sales Tax");

      // The amount should be different from 12% (1200 cents) which would be the manual rate
      expect(invoice2!.taxAmountCents).not.toBe(1200);
    }, 40000);
  });

  describe("Other Country Tax Scenarios", () => {
    it("should apply UK VAT for UK domestic transactions", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be UK-based for this test
      await db
        .update(merchants)
        .set({ country: "GB" })
        .where(eq(merchants.id, merchantId));

      // Create UK customer for domestic VAT calculation
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "UK Domestic Customer",
          email: `uk-domestic-customer-${Date.now()}@example.com`,
          billingCountry: "GB",
          billingStateProvince: "England",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(2000); // 20% UK VAT of $100.00 = $20.00
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("GB");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.2); // 20% VAT

      // Verify UK VAT line items were created
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("vat");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("GB");
      expect(taxLineItems[0].description).toBe("20.00%: EU VAT");

      // Verify total includes VAT
      expect(invoice!.totalAmountCents).toBe(12000); // $100.00 + $20.00 = $120.00

      // Reset merchant country back to US for other tests
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should apply Canada GST/HST for Canadian domestic transactions", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be Canada-based for this test
      await db
        .update(merchants)
        .set({ country: "CA", stateProvince: "ON" })
        .where(eq(merchants.id, merchantId));

      // Test HST province (Ontario) - should get single combined HST rate
      const { customerId: onCustomerId, invoice: onInvoice } =
        await createSubscriptionAndBill({
          name: "Canada Ontario Customer",
          email: `ca-on-customer-${Date.now()}@example.com`,
          billingCountry: "CA",
          billingStateProvince: "ON",
        });

      expect(onInvoice).toBeDefined();
      expect(onInvoice!.taxAmountCents).toBe(1300); // 13% HST of $100.00 = $13.00
      expect(onInvoice!.taxCalculationMethod).toBe("auto");
      expect(onInvoice!.taxJurisdiction).toBe("CA");
      expect(parseFloat(onInvoice!.effectiveTaxRate || "0")).toBe(0.13); // 13% HST

      // Verify HST line items were created
      const onTaxLineItems = onInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(onTaxLineItems.length).toBe(1);
      expect(onTaxLineItems[0].taxMetadata?.taxType).toBe("hst");
      expect(onTaxLineItems[0].taxMetadata?.taxAuthority).toBe("CA-ON");
      expect(onTaxLineItems[0].description).toBe("13.00%: HST");

      // Test GST + PST province (British Columbia) - should get separate GST and PST
      const { customerId: bcCustomerId, invoice: bcInvoice } =
        await createSubscriptionAndBill({
          name: "Canada BC Customer",
          email: `ca-bc-customer-${Date.now()}@example.com`,
          billingCountry: "CA",
          billingStateProvince: "BC",
        });

      expect(bcInvoice).toBeDefined();
      expect(bcInvoice!.taxAmountCents).toBe(1200); // 5% GST + 7% PST = 12% of $100.00 = $12.00
      expect(bcInvoice!.taxCalculationMethod).toBe("auto");
      expect(bcInvoice!.taxJurisdiction).toBe("CA");
      expect(parseFloat(bcInvoice!.effectiveTaxRate || "0")).toBe(0.12); // 12% total

      // Verify GST and PST line items were created separately
      const bcTaxLineItems = bcInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(bcTaxLineItems.length).toBe(2); // GST + PST

      const gstLineItem = bcTaxLineItems.find((item) =>
        item.description?.includes("GST")
      );
      const pstLineItem = bcTaxLineItems.find((item) =>
        item.description?.includes("PST")
      );

      expect(gstLineItem).toBeDefined();
      expect(pstLineItem).toBeDefined();
      expect(gstLineItem!.taxMetadata?.taxType).toBe("gst");
      expect(pstLineItem!.taxMetadata?.taxType).toBe("pst");
      expect(gstLineItem!.description).toBe("5.00%: GST");
      expect(pstLineItem!.description).toBe("7.00%: PST");

      // Reset merchant country back to US for other tests
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should handle Switzerland VAT correctly", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be Switzerland-based for this test
      await db
        .update(merchants)
        .set({ country: "CH" })
        .where(eq(merchants.id, merchantId));

      // Create Switzerland customer for domestic VAT calculation
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Switzerland Domestic Customer",
          email: `ch-domestic-customer-${Date.now()}@example.com`,
          billingCountry: "CH",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(810); // 8.1% Switzerland VAT of $100.00 = $8.10
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("CH");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.081); // 8.1% VAT

      // Verify Switzerland VAT line items were created
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("vat");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("CH");
      expect(taxLineItems[0].description).toBe("8.10%: EU VAT");

      // Verify total includes VAT
      expect(invoice!.totalAmountCents).toBe(10810); // $100.00 + $8.10 = $108.10

      // Reset merchant country back to US for other tests
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should apply Norway VAT for Norway domestic transactions", async () => {
      await configureMerchantTax({ autoTaxCalculation: true });

      // Set merchant country to Norway
      await db
        .update(merchants)
        .set({ country: "NO" })
        .where(eq(merchants.id, merchantId));

      const { invoice } = await createSubscriptionAndBill({
        name: "Norway Domestic Customer",
        email: `no-domestic-${Date.now()}@example.com`,
        billingCountry: "NO",
      });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(2500); // 25% of $100.00
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("NO");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.25);

      const taxLineItems = invoice!.lineItems.filter((i) => i.type === "tax");
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe("vat");
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("NO");
      expect(taxLineItems[0].description).toBe("25.00%: EU VAT");

      // Reset merchant
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should apply Iceland VAT for Iceland domestic transactions", async () => {
      await configureMerchantTax({ autoTaxCalculation: true });

      // Set merchant country to Iceland
      await db
        .update(merchants)
        .set({ country: "IS" })
        .where(eq(merchants.id, merchantId));

      const { invoice } = await createSubscriptionAndBill({
        name: "Iceland Domestic Customer",
        email: `is-domestic-${Date.now()}@example.com`,
        billingCountry: "IS",
      });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(2400); // 24% of $100.00
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("IS");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.24);

      const taxLineItems = invoice!.lineItems.filter((i) => i.type === "tax");
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("IS");
      expect(taxLineItems[0].description).toBe("24.00%: EU VAT");

      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should apply Turkey VAT for Turkey domestic transactions", async () => {
      await configureMerchantTax({ autoTaxCalculation: true });

      await db
        .update(merchants)
        .set({ country: "TR" })
        .where(eq(merchants.id, merchantId));

      const { invoice } = await createSubscriptionAndBill({
        name: "Turkey Domestic Customer",
        email: `tr-domestic-${Date.now()}@example.com`,
        billingCountry: "TR",
      });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(2000); // 20% of $100.00
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("TR");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.2);

      const taxLineItems = invoice!.lineItems.filter((i) => i.type === "tax");
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("TR");
      expect(taxLineItems[0].description).toBe("20.00%: EU VAT");

      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);
  });

  describe("Cross-Border Tax Matrix Scenarios", () => {
    it("should apply tax matrix rates for US to EU transactions", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Merchant is already US-based (CA), create EU customer
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "German EU Customer",
          email: `de-eu-customer-${Date.now()}@example.com`,
          billingCountry: "DE",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(0); // Cross-border US->EU should be 0% (reverse charge)
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("DE");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify tax line items were created with reverse charge (0% tax)
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0);
      expect(taxLineItems[0].description).toBe("0%: Reverse Charge");

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal
    }, 40000);

    it("should apply tax matrix rates for EU to US transactions", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be EU-based (Germany) for this test
      await db
        .update(merchants)
        .set({ country: "DE" })
        .where(eq(merchants.id, merchantId));

      // Create US customer for cross-border EU->US transaction
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "US Customer for EU Merchant",
          email: `us-customer-eu-merchant-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(0); // Cross-border EU->US should be 0% (no VAT for foreign seller)
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("US");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify tax line items were created with 0% tax (no tax on foreign digital services)
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0);
      expect(taxLineItems[0].description).toBe("0%: Reverse Charge");

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal

      // Reset merchant country back to US for other tests
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should handle Mexico registration requirement", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Merchant is US-based, create Mexican customer
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Mexican Customer",
          email: `mx-customer-${Date.now()}@example.com`,
          billingCountry: "MX",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(1600); // 16% Mexico VAT of $100.00 = $16.00
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("MX");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0.16); // 16% Mexico VAT

      // Verify Mexico VAT line items were created
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].taxMetadata?.taxType).toBe(
        "foreign_registration_required"
      );
      expect(taxLineItems[0].taxMetadata?.taxAuthority).toBe("MX");
      expect(taxLineItems[0].description).toBe(
        "16.00%: Foreign Seller Registration Required"
      );

      // Verify total includes Mexico VAT
      expect(invoice!.totalAmountCents).toBe(11600); // $100.00 + $16.00 = $116.00
    }, 40000);

    it("should apply zero tax for unsupported cross-border combinations", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Merchant is US-based, create customer in Brazil (should be 0% according to tax matrix reason code 4)
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Brazilian Customer",
          email: `br-customer-${Date.now()}@example.com`,
          billingCountry: "BR",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.taxAmountCents).toBe(0); // Brazil does not tax this type of cross-border import
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(invoice!.taxJurisdiction).toBe("BR");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify tax line items were created with 0% tax
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0);
      expect(taxLineItems[0].description).toBe(
        "0%: No Tax on Cross-Border Digital Services"
      );

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal
    }, 40000);
  });

  describe("Tax Line Item and Invoice Integration", () => {
    it("should create proper tax line items in invoices", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Create customer with tax liability
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Line Item Test Customer",
          email: `line-item-test-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
        });

      expect(invoice).toBeDefined();
      expect(invoice!.lineItems).toBeDefined();
      expect(Array.isArray(invoice!.lineItems)).toBe(true);

      // Find tax line items
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBeGreaterThan(0);

      // Verify tax line item structure
      const taxLineItem = taxLineItems[0];
      expect(taxLineItem.type).toBe("tax");
      expect(taxLineItem.description).toBeDefined();
      expect(typeof taxLineItem.subtotalCents).toBe("number");
      expect(taxLineItem.billingPeriodStart).toBeDefined();
      expect(taxLineItem.billingPeriodEnd).toBeDefined();

      // Verify tax metadata is properly structured
      expect(taxLineItem.taxMetadata).toBeDefined();
      expect(taxLineItem.taxMetadata?.taxType).toBe("sales_tax");
      expect(taxLineItem.taxMetadata?.jurisdiction).toBe("US-CA");
      expect(taxLineItem.taxMetadata?.taxAuthority).toBe("US-CA");
      expect(typeof taxLineItem.taxMetadata?.taxRate).toBe("number");
      expect(taxLineItem.taxMetadata?.taxRate).toBeGreaterThan(0);

      // Verify non-tax line items also exist (subscription charges)
      const nonTaxLineItems = invoice!.lineItems.filter(
        (item) => item.type !== "tax"
      );
      expect(nonTaxLineItems.length).toBeGreaterThan(0);

      // Verify total line item amounts match invoice totals
      const totalLineItemAmount = invoice!.lineItems.reduce(
        (sum, item) => sum + item.subtotalCents,
        0
      );
      expect(totalLineItemAmount).toBe(invoice!.totalAmountCents);
    }, 40000);

    it("should store correct tax metadata in line items", async () => {
      // Test manual tax metadata
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: "0.085", // 8.5% manual rate
      });

      const { customerId: manualCustomerId, invoice: manualInvoice } =
        await createSubscriptionAndBill({
          name: "Manual Tax Metadata Customer",
          email: `manual-tax-metadata-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "NY",
        });

      expect(manualInvoice).toBeDefined();
      const manualTaxLineItems = manualInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(manualTaxLineItems.length).toBe(1);

      const manualTaxItem = manualTaxLineItems[0];
      expect(manualTaxItem.taxMetadata?.taxType).toBe("manual");
      expect(manualTaxItem.taxMetadata?.rateSource).toBe("default");
      expect(manualTaxItem.taxMetadata?.taxRate).toBe(0.085);
      expect(manualTaxItem.description).toBe("8.50%: Manual Tax");

      // Test automatic tax metadata with EU VAT
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Update merchant to be Germany-based for VAT
      await db
        .update(merchants)
        .set({ country: "DE" })
        .where(eq(merchants.id, merchantId));

      const { customerId: vatCustomerId, invoice: vatInvoice } =
        await createSubscriptionAndBill({
          name: "VAT Metadata Customer",
          email: `vat-metadata-${Date.now()}@example.com`,
          billingCountry: "DE",
        });

      expect(vatInvoice).toBeDefined();
      const vatTaxLineItems = vatInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(vatTaxLineItems.length).toBe(1);

      const vatTaxItem = vatTaxLineItems[0];
      expect(vatTaxItem.taxMetadata?.taxType).toBe("vat");
      expect(vatTaxItem.taxMetadata?.taxAuthority).toBe("DE");
      expect(vatTaxItem.taxMetadata?.jurisdiction).toBe("DE");
      expect(vatTaxItem.taxMetadata?.taxRate).toBe(0.19); // German VAT
      expect(vatTaxItem.description).toBe("19.00%: EU VAT");

      // Reset merchant country back to US
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);

    it("should calculate invoice totals correctly with tax", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Create customer with known tax rate
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Invoice Total Test Customer",
          email: `invoice-total-test-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
        });

      expect(invoice).toBeDefined();

      // Verify basic invoice structure
      expect(invoice!.subtotalCents).toBeDefined();
      expect(invoice!.taxAmountCents).toBeDefined();
      expect(invoice!.totalAmountCents).toBeDefined();

      // Expected subtotal (from our test plan)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00

      // Tax should be greater than 0 for CA
      expect(invoice!.taxAmountCents).toBeGreaterThan(0);

      // Total should equal subtotal + tax
      const expectedTotal = invoice!.subtotalCents! + invoice!.taxAmountCents!;
      expect(invoice!.totalAmountCents).toBe(expectedTotal);

      // Verify line items add up correctly
      const totalLineItemAmount = invoice!.lineItems.reduce(
        (sum, item) => sum + item.subtotalCents,
        0
      );
      expect(totalLineItemAmount).toBe(invoice!.totalAmountCents);

      // Verify tax line items match invoice tax amount
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      const totalTaxFromLineItems = taxLineItems.reduce(
        (sum, item) => sum + item.subtotalCents,
        0
      );
      expect(totalTaxFromLineItems).toBe(invoice!.taxAmountCents!);

      // Verify non-tax line items match subtotal
      const nonTaxLineItems = invoice!.lineItems.filter(
        (item) => item.type !== "tax"
      );
      const totalNonTaxFromLineItems = nonTaxLineItems.reduce(
        (sum, item) => sum + item.subtotalCents,
        0
      );
      expect(totalNonTaxFromLineItems).toBe(invoice!.subtotalCents!);
    }, 40000);

    it("should store tax data in invoice fields correctly", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Create customer with known tax scenario
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Invoice Tax Data Test Customer",
          email: `invoice-tax-data-test-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
        });

      expect(invoice).toBeDefined();

      // Verify tax calculation method is stored
      expect(invoice!.taxCalculationMethod).toBe("auto");

      // Verify tax jurisdiction is stored
      expect(invoice!.taxJurisdiction).toBe("US-CA");

      // Verify effective tax rate is stored and reasonable
      expect(invoice!.effectiveTaxRate).toBeDefined();
      const effectiveTaxRate = parseFloat(invoice!.effectiveTaxRate || "0");
      expect(effectiveTaxRate).toBeGreaterThan(0);
      expect(effectiveTaxRate).toBeLessThan(1); // Should be less than 100%

      // Verify calculated effective tax rate matches actual calculation
      const calculatedRate = invoice!.taxAmountCents! / invoice!.subtotalCents!;
      expect(Math.abs(effectiveTaxRate - calculatedRate)).toBeLessThan(0.001); // Allow small rounding differences

      // Test tax-exempt scenario
      const { customerId: exemptCustomerId, invoice: exemptInvoice } =
        await createSubscriptionAndBill({
          name: "Exempt Invoice Tax Data Customer",
          email: `exempt-invoice-tax-data-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "NY",
          taxExempt: true,
        });

      expect(exemptInvoice).toBeDefined();
      expect(exemptInvoice!.taxCalculationMethod).toBe("exempt");
      expect(exemptInvoice!.taxJurisdiction).toBe("exempt");
      expect(exemptInvoice!.effectiveTaxRate).toBeDefined();
      expect(parseFloat(exemptInvoice!.effectiveTaxRate || "0")).toBe(0);
      expect(exemptInvoice!.taxAmountCents).toBe(0);

      // Test manual tax calculation
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: "0.075", // 7.5%
      });

      const { customerId: manualCustomerId, invoice: manualInvoice } =
        await createSubscriptionAndBill({
          name: "Manual Invoice Tax Data Customer",
          email: `manual-invoice-tax-data-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "TX",
        });

      expect(manualInvoice).toBeDefined();
      expect(manualInvoice!.taxCalculationMethod).toBe("manual");
      expect(manualInvoice!.effectiveTaxRate).toBeDefined();
      expect(parseFloat(manualInvoice!.effectiveTaxRate || "0")).toBe(0.075);
      expect(manualInvoice!.taxAmountCents).toBe(750); // 7.5% of $100
    }, 40000);
  });

  describe("Edge Cases and Error Handling", () => {
    // REVIEW: Scenario uses deliberately invalid merchant data; asserts graceful fallback. Acceptable though not deeply strict.
    it("should handle missing merchant data gracefully", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Test with merchant in an unsupported country that has no tax configuration
      const originalCountry = "US";
      const originalStateProvince = "CA";

      await db
        .update(merchants)
        .set({ country: "ZZ", stateProvince: null }) // Use invalid country code
        .where(eq(merchants.id, merchantId));

      try {
        // Create customer and attempt billing
        const { customerId, subscriptionId, invoice } =
          await createSubscriptionAndBill({
            name: "Missing Merchant Data Customer",
            email: `missing-merchant-data-${Date.now()}@example.com`,
            billingCountry: "US",
            billingStateProvince: "CA",
          });

        // System should handle missing merchant tax data gracefully
        expect(invoice).toBeDefined();

        // Should fall back to no tax when merchant country is not supported
        expect(invoice!.taxAmountCents).toBe(0);
        expect(invoice!.taxCalculationMethod).toBe("auto");
        expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

        // Verify tax line items were created with 0% tax
        const taxLineItems = invoice!.lineItems.filter(
          (item) => item.type === "tax"
        );
        expect(taxLineItems.length).toBe(1);
        expect(taxLineItems[0].subtotalCents).toBe(0);

        // Verify subtotal equals total (no tax added)
        expect(invoice!.subtotalCents).toBe(10000); // $100.00
        expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal
      } finally {
        // Restore merchant data
        await db
          .update(merchants)
          .set({
            country: originalCountry,
            stateProvince: originalStateProvince,
          })
          .where(eq(merchants.id, merchantId));
      }
    }, 40000);

    // REVIEW: Tests graceful handling for customers lacking location info; fine.
    it("should handle missing customer data gracefully", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Create customer with missing billing country (should fall back gracefully)
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Missing Customer Data Customer",
          email: `missing-customer-data-${Date.now()}@example.com`,
          billingCountry: "", // Empty country should be handled gracefully
          billingStateProvince: "",
        });

      expect(invoice).toBeDefined();

      // Should handle missing customer location data gracefully
      // Most likely falls back to no tax when location is unknown
      expect(invoice!.taxAmountCents).toBe(0);
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify tax line items were created with 0% tax
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0);

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal

      // Test with invalid country code
      const { customerId: invalidCustomerId, invoice: invalidInvoice } =
        await createSubscriptionAndBill({
          name: "Invalid Country Customer",
          email: `invalid-country-${Date.now()}@example.com`,
          billingCountry: "INVALID", // Invalid country code
          billingStateProvince: "XX",
        });

      console.log("Invalid customer id:", invalidCustomerId);
      console.log("Invalid invoice:", invalidInvoice);

      expect(invalidInvoice).toBeDefined();
      expect(invalidInvoice!.taxAmountCents).toBe(0);
      expect(invalidInvoice!.taxCalculationMethod).toBe("auto");

      const invalidTaxLineItems = invalidInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(invalidTaxLineItems.length).toBe(1);
      expect(invalidTaxLineItems[0].taxMetadata?.reasonCode).toBe(20);
    }, 40000);

    // REVIEW: Exercises error paths (no rate / unsupported countries); decent coverage.
    it("should fall back to exempt tax on calculation errors", async () => {
      // Configure merchant for manual tax calculation with invalid rate
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: undefined, // No default rate set
      });

      // Create customer when no tax rate is configured (should handle gracefully)
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Tax Error Fallback Customer",
          email: `tax-error-fallback-${Date.now()}@example.com`,
          billingCountry: "US",
          billingStateProvince: "CA",
        });

      expect(invoice).toBeDefined();

      // Should handle calculation errors gracefully by falling back to no tax
      expect(invoice!.taxAmountCents).toBe(0);
      expect(invoice!.taxCalculationMethod).toBe("manual");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify tax line items were created with 0% tax
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0);

      // Verify subtotal equals total (no tax added)
      expect(invoice!.subtotalCents).toBe(10000); // $100.00
      expect(invoice!.totalAmountCents).toBe(10000); // Same as subtotal

      // Test automatic calculation with unsupported merchant/customer combination
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Set merchant to unsupported country combination
      const originalCountry = "US";
      const originalStateProvince = "CA";

      await db
        .update(merchants)
        .set({ country: "XX" }) // Unsupported country
        .where(eq(merchants.id, merchantId));

      try {
        const { customerId: autoCustomerId, invoice: autoInvoice } =
          await createSubscriptionAndBill({
            name: "Auto Tax Error Customer",
            email: `auto-tax-error-${Date.now()}@example.com`,
            billingCountry: "YY", // Another unsupported country
          });

        expect(autoInvoice).toBeDefined();

        // Should handle unsupported combination gracefully
        expect(autoInvoice!.taxAmountCents).toBe(0);
        expect(autoInvoice!.taxCalculationMethod).toBe("auto");

        const autoTaxLineItems = autoInvoice!.lineItems.filter(
          (item) => item.type === "tax"
        );
        expect(autoTaxLineItems.length).toBe(1);
        expect(autoTaxLineItems[0].taxMetadata?.reasonCode).toBe(20);
      } finally {
        // Restore merchant data
        await db
          .update(merchants)
          .set({
            country: originalCountry,
            stateProvince: originalStateProvince,
          })
          .where(eq(merchants.id, merchantId));
      }
    }, 40000);

    it("should handle zero-amount invoices correctly", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // We can't easily create a zero-amount invoice with our current test setup
      // since the test plan has a fixed $100 price. Instead, let's test the
      // tax calculation logic directly with zero amounts using the tax preview API

      const zeroAmountTaxPreview = await authedApiClient.tax[
        "calculate-preview"
      ].$post({
        json: {
          customerId: "cus_test_zero_amount",
          amount: 0, // Zero amount
          currency: "USD",
          lineItems: [],
        },
      });

      // Zero amount requests should return 400 (validation error) as they are invalid
      expect(zeroAmountTaxPreview.status).toBe(400);

      const errorResult = await zeroAmountTaxPreview.json();
      expect("error" in errorResult).toBe(true);

      // Test with very small amount (1 cent)
      const smallAmountTaxPreview = await authedApiClient.tax[
        "calculate-preview"
      ].$post({
        json: {
          customerId: "cus_test_small_amount",
          amount: 1, // 1 cent
          currency: "USD",
          lineItems: [
            {
              type: "subscription",
              description: "Test small amount",
              subtotalCents: 1,
              billingPeriodStart: new Date(),
              billingPeriodEnd: new Date(),
            },
          ],
        },
      });

      expect(smallAmountTaxPreview.status).toBe(200);
      const smallTaxResult = await smallAmountTaxPreview.json();

      // Should handle small amounts gracefully
      expect(
        "error" in smallTaxResult || smallTaxResult.totalTaxCents >= 0
      ).toBe(true);

      if (!("error" in smallTaxResult)) {
        expect(typeof smallTaxResult.totalTaxCents).toBe("number");
        expect(smallTaxResult.totalTaxCents).toBeGreaterThanOrEqual(0);
      }
    }, 40000);

    // REVIEW: Gracefully handles missing sub-national info; fine.
    it("should handle missing state/province information", async () => {
      // Configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Create US customer without state/province information
      const { customerId, subscriptionId, invoice } =
        await createSubscriptionAndBill({
          name: "Missing State Customer",
          email: `missing-state-${Date.now()}@example.com`,
          billingCountry: "US",
          // No billingStateProvince provided
        });

      expect(invoice).toBeDefined();

      // Should handle missing state information gracefully
      // Most likely falls back to no tax when state is unknown for US customers
      expect(invoice!.taxAmountCents).toBe(0);
      expect(invoice!.taxCalculationMethod).toBe("auto");
      expect(parseFloat(invoice!.effectiveTaxRate || "0")).toBe(0);

      // Verify tax line items were created with 0% tax
      const taxLineItems = invoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(taxLineItems.length).toBe(1);
      expect(taxLineItems[0].subtotalCents).toBe(0);

      // Test EU customer without specific region (should still work for VAT)
      // Update merchant to be Germany-based
      await db
        .update(merchants)
        .set({ country: "DE" })
        .where(eq(merchants.id, merchantId));

      const { customerId: euCustomerId, invoice: euInvoice } =
        await createSubscriptionAndBill({
          name: "EU No Region Customer",
          email: `eu-no-region-${Date.now()}@example.com`,
          billingCountry: "FR",
          // No billingStateProvince (not typically needed for EU)
        });

      expect(euInvoice).toBeDefined();

      // EU VAT should work without state/province since it's country-based
      expect(euInvoice!.taxAmountCents).toBe(2000); // 20% French VAT
      expect(euInvoice!.taxCalculationMethod).toBe("auto");
      expect(euInvoice!.taxJurisdiction).toBe("FR");

      const euTaxLineItems = euInvoice!.lineItems.filter(
        (item) => item.type === "tax"
      );
      expect(euTaxLineItems.length).toBe(1);
      expect(euTaxLineItems[0].taxMetadata?.taxType).toBe("vat");

      // Reset merchant country back to US
      await db
        .update(merchants)
        .set({ country: "US", stateProvince: "CA" })
        .where(eq(merchants.id, merchantId));
    }, 40000);
  });

  describe("Tax Configuration API Integration", () => {
    // REVIEW: **Potential weakness** – validation test allows 400 or 500; should target specific validation status (400).
    it("should update merchant tax configuration via API", async () => {
      // Test getting initial config
      const initialConfigResponse = await authedApiClient.tax.config.$get();
      expect(initialConfigResponse.status).toBe(200);
      const initialConfig = await initialConfigResponse.json();
      expect(initialConfig).toBeDefined();

      // Test updating to automatic tax calculation
      const autoConfigResponse = await authedApiClient.tax.config.update.$post({
        json: {
          autoTaxCalculation: true,
          defaultTaxRate: null, // Should be ignored for auto calculation
        },
      });
      expect(autoConfigResponse.status).toBe(200);
      const autoConfig = await autoConfigResponse.json();
      expect("error" in autoConfig).toBe(false);
      if (!("error" in autoConfig)) {
        expect(autoConfig.autoTaxCalculation).toBe(true);
        expect(autoConfig.defaultTaxRate).toBeNull();
      }

      // Test updating to manual tax calculation with default rate
      const manualConfigResponse =
        await authedApiClient.tax.config.update.$post({
          json: {
            autoTaxCalculation: false,
            defaultTaxRate: "0.08", // 8% default rate
          },
        });
      expect(manualConfigResponse.status).toBe(200);
      const manualConfig = await manualConfigResponse.json();
      expect("error" in manualConfig).toBe(false);
      if (!("error" in manualConfig)) {
        expect(manualConfig.autoTaxCalculation).toBe(false);
        expect(manualConfig.defaultTaxRate).toBe("0.0800");
      }

      // Verify the configuration persists by getting it again
      const persistedConfigResponse = await authedApiClient.tax.config.$get();
      expect(persistedConfigResponse.status).toBe(200);
      const persistedConfig = await persistedConfigResponse.json();
      expect("error" in persistedConfig).toBe(false);
      if (!("error" in persistedConfig)) {
        expect(persistedConfig.autoTaxCalculation).toBe(false);
        expect(persistedConfig.defaultTaxRate).toBe("0.0800");
      }

      // Test validation - invalid tax rate should be rejected
      const invalidConfigResponse =
        await authedApiClient.tax.config.update.$post({
          json: {
            autoTaxCalculation: false,
            defaultTaxRate: "invalid", // Invalid rate
          },
        });
      // Invalid input should return 400 (validation error), not 500 (server error)
      expect(invalidConfigResponse.status).toBe(400);
    }, 40000);

    // REVIEW: **Potential weakness** – invalid rate test also allows 400 or 500, which could hide server-side errors.
    it("should create and manage tax rate definitions via API", async () => {
      // Test getting initial rate definitions (should be empty or from previous tests)
      const initialRatesResponse =
        await authedApiClient.tax["rate-definitions"].$get();
      expect(initialRatesResponse.status).toBe(200);
      const initialRates = await initialRatesResponse.json();
      expect(Array.isArray(initialRates)).toBe(true);

      // Test creating a new tax rate definition
      const createRateResponse = await authedApiClient.tax["rate-definitions"][
        "create"
      ].$post({
        json: {
          name: "Test API Rate",
          description: "Test tax rate created via API",
          taxRate: "0.0925", // 9.25%
          jurisdiction: "US-NY",
        },
      });
      expect(createRateResponse.status).toBe(201);
      const createdRate = await createRateResponse.json();
      expect("error" in createdRate).toBe(false);

      if (!("error" in createdRate)) {
        expect(createdRate.name).toBe("Test API Rate");
        expect(createdRate.description).toBe("Test tax rate created via API");
        expect(createdRate.taxRate).toBe("0.0925");
        expect(createdRate.jurisdiction).toBe("US-NY");
        expect(createdRate.isActive).toBe(true);
        expect(createdRate.id).toBeDefined();
      }

      const rateId = "error" in createdRate ? "" : createdRate.id;

      // Test updating the tax rate definition
      const updateRateResponse = await authedApiClient.tax["rate-definitions"][
        rateId
      ]["update"].$post({
        json: {
          name: "Updated API Rate",
          description: "Updated test tax rate",
          taxRate: "0.095", // 9.5%
          jurisdiction: "US-CA",
          isActive: true,
        },
      });
      expect(updateRateResponse.status).toBe(200);
      const updatedRate = await updateRateResponse.json();
      expect("error" in updatedRate).toBe(false);

      if (!("error" in updatedRate)) {
        expect(updatedRate.name).toBe("Updated API Rate");
        expect(updatedRate.description).toBe("Updated test tax rate");
        expect(updatedRate.taxRate).toBe("0.0950");
        expect(updatedRate.jurisdiction).toBe("US-CA");
        expect(updatedRate.isActive).toBe(true);
      }

      // Test getting all rate definitions (should include our created one)
      const allRatesResponse =
        await authedApiClient.tax["rate-definitions"].$get();
      expect(allRatesResponse.status).toBe(200);
      const allRates = await allRatesResponse.json();
      expect(Array.isArray(allRates)).toBe(true);

      if (Array.isArray(allRates)) {
        const ourRate = allRates.find((rate: any) => rate.id === rateId);
        expect(ourRate).toBeDefined();
        expect(ourRate?.name).toBe("Updated API Rate");
      }

      // Test deactivating the rate definition
      const deactivateResponse = await authedApiClient.tax["rate-definitions"][
        rateId
      ]["update"].$post({
        json: {
          isActive: false,
        },
      });
      expect(deactivateResponse.status).toBe(200);
      const deactivatedRate = await deactivateResponse.json();
      expect("error" in deactivatedRate).toBe(false);

      if (!("error" in deactivatedRate)) {
        expect(deactivatedRate.isActive).toBe(false);
      }

      // Test validation - invalid rate should be rejected
      const invalidRateResponse = await authedApiClient.tax["rate-definitions"][
        "create"
      ].$post({
        json: {
          name: "Invalid Rate",
          taxRate: "invalid_rate", // Invalid rate
        },
      });
      // Invalid rate should return 400 (validation error), not 500 (server error)
      expect(invalidRateResponse.status).toBe(400);
    }, 40000);

    it("should validate tax rate definition updates and reject invalid data", async () => {
      // First create a valid tax rate definition
      const createRateResponse = await authedApiClient.tax["rate-definitions"][
        "create"
      ].$post({
        json: {
          name: "Validation Test Rate",
          description: "Rate for testing validation",
          taxRate: "0.075", // 7.5%
          jurisdiction: "US-FL",
        },
      });
      expect(createRateResponse.status).toBe(201);
      const createdRate = await createRateResponse.json();
      expect("error" in createdRate).toBe(false);

      if ("error" in createdRate) {
        throw new Error("Failed to create test rate definition");
      }

      const rateId = createdRate.id;

      // Test updating with invalid tax rate format - should return 400, not 500
      const invalidUpdateResponse = await authedApiClient.tax[
        "rate-definitions"
      ][rateId]["update"].$post({
        json: {
          taxRate: "invalid", // Invalid tax rate format
        },
      });
      expect(invalidUpdateResponse.status).toBe(400);
      const invalidUpdateError = await invalidUpdateResponse.json();
      expect("error" in invalidUpdateError).toBe(true);

      // Test updating with tax rate out of range (>1.0) - should return 400
      const outOfRangeResponse = await authedApiClient.tax["rate-definitions"][
        rateId
      ]["update"].$post({
        json: {
          taxRate: "1.5", // 150% - invalid, should be between 0 and 1
        },
      });
      expect(outOfRangeResponse.status).toBe(400);
      const outOfRangeError = await outOfRangeResponse.json();
      expect("error" in outOfRangeError).toBe(true);

      // Test updating with negative tax rate - should return 400
      const negativeRateResponse = await authedApiClient.tax[
        "rate-definitions"
      ][rateId]["update"].$post({
        json: {
          taxRate: "-0.05", // Negative rate - invalid
        },
      });
      expect(negativeRateResponse.status).toBe(400);
      const negativeRateError = await negativeRateResponse.json();
      expect("error" in negativeRateError).toBe(true);

      // Test updating with valid rate should still work
      const validUpdateResponse = await authedApiClient.tax["rate-definitions"][
        rateId
      ]["update"].$post({
        json: {
          taxRate: "0.085", // 8.5% - valid
          name: "Updated Valid Rate",
        },
      });
      expect(validUpdateResponse.status).toBe(200);
      const validUpdatedRate = await validUpdateResponse.json();
      expect("error" in validUpdatedRate).toBe(false);

      if (!("error" in validUpdatedRate)) {
        expect(validUpdatedRate.taxRate).toBe("0.0850");
        expect(validUpdatedRate.name).toBe("Updated Valid Rate");
      }
    }, 40000);

    it("should configure US nexus via API", async () => {
      // Test getting initial nexus configurations
      const initialNexusResponse = await authedApiClient.tax.nexus.$get();
      expect(initialNexusResponse.status).toBe(200);
      const initialNexusConfigs = await initialNexusResponse.json();
      expect(Array.isArray(initialNexusConfigs)).toBe(true);

      // Test configuring nexus for Oregon (physical presence)
      const oregonNexusResponse = await authedApiClient.tax.nexus[
        ":state"
      ].update.$post({
        param: { state: "OR" },
        json: {
          hasNexus: true,
          nexusType: "physical",
          hasOffices: true,
          hasEmployees: true,
          hasInventory: false,
          otherPresence: "Corporate headquarters",
        },
      });
      expect(oregonNexusResponse.status).toBe(200);
      const oregonNexus = await oregonNexusResponse.json();

      if (!("error" in oregonNexus)) {
        expect(oregonNexus.state).toBe("OR");
        expect(oregonNexus.hasNexus).toBe(true);
        expect(oregonNexus.nexusType).toBe("physical");
        expect(oregonNexus.hasOffices).toBe(true);
        expect(oregonNexus.hasEmployees).toBe(true);
        expect(oregonNexus.hasInventory).toBe(false);
        expect(oregonNexus.otherPresence).toBe("Corporate headquarters");
      }

      // Test configuring economic nexus for Nevada
      const nevadaNexusResponse = await authedApiClient.tax.nexus[
        ":state"
      ].update.$post({
        param: { state: "NV" },
        json: {
          hasNexus: true,
          nexusType: "economic",
          salesThreshold: 10000000, // $100,000 in cents
          transactionThreshold: 200,
          hasOffices: false,
          hasEmployees: false,
        },
      });
      expect(nevadaNexusResponse.status).toBe(200);
      const nevadaNexus = await nevadaNexusResponse.json();

      if (!("error" in nevadaNexus)) {
        expect(nevadaNexus.state).toBe("NV");
        expect(nevadaNexus.hasNexus).toBe(true);
        expect(nevadaNexus.nexusType).toBe("economic");
        expect(nevadaNexus.salesThreshold).toBe(10000000);
        expect(nevadaNexus.transactionThreshold).toBe(200);
        expect(nevadaNexus.hasOffices).toBe(false);
        expect(nevadaNexus.hasEmployees).toBe(false);
      }

      // Test disabling nexus for a state
      const noNexusResponse = await authedApiClient.tax.nexus[
        ":state"
      ].update.$post({
        param: { state: "MT" },
        json: {
          hasNexus: false,
          nexusType: "none",
          hasOffices: false,
          hasEmployees: false,
        },
      });
      expect(noNexusResponse.status).toBe(200);
      const noNexus = await noNexusResponse.json();

      if (!("error" in noNexus)) {
        expect(noNexus.state).toBe("MT");
        expect(noNexus.hasNexus).toBe(false);
        expect(noNexus.nexusType).toBe("none");
      }

      // Test getting all nexus configurations (should include our configured ones)
      const allNexusResponse = await authedApiClient.tax.nexus.$get();
      expect(allNexusResponse.status).toBe(200);
      const allNexusConfigs = await allNexusResponse.json();
      expect(Array.isArray(allNexusConfigs)).toBe(true);

      if (Array.isArray(allNexusConfigs)) {
        const oregonConfig = allNexusConfigs.find(
          (config: any) => config.state === "OR"
        );
        const nevadaConfig = allNexusConfigs.find(
          (config: any) => config.state === "NV"
        );
        const montanaConfig = allNexusConfigs.find(
          (config: any) => config.state === "MT"
        );

        expect(oregonConfig).toBeDefined();
        expect(oregonConfig?.hasNexus).toBe(true);
        expect(oregonConfig?.nexusType).toBe("physical");

        expect(nevadaConfig).toBeDefined();
        expect(nevadaConfig?.hasNexus).toBe(true);
        expect(nevadaConfig?.nexusType).toBe("economic");

        expect(montanaConfig).toBeDefined();
        expect(montanaConfig?.hasNexus).toBe(false);
      }

      // Test validation - API should reject invalid state codes
      const invalidStateResponse = await authedApiClient.tax.nexus[
        ":state"
      ].update.$post({
        param: { state: "XX" },
        json: {
          hasNexus: true,
          nexusType: "physical",
        },
      });
      // Invalid state code should return 400 (validation error)
      expect(invalidStateResponse.status).toBe(400);
      const invalidStateError = await invalidStateResponse.json();
      expect("error" in invalidStateError).toBe(true);
    }, 40000);

    // REVIEW: **Weakness** – final assertions accept 200/400/500, making the test non-deterministic and too forgiving.
    it("should provide tax calculation preview via API", async () => {
      // First, configure merchant for automatic tax calculation
      await configureMerchantTax({
        autoTaxCalculation: true,
      });

      // Create a real test customer for the preview calculation
      const previewCustomer = await createTestCustomer({
        merchantId,
        name: "Preview Test",
        email: `preview-test-${Date.now()}@example.com`,
        billingCountry: "US",
        billingStateProvince: "CA",
      });
      const testCustomerId = previewCustomer.id;

      // Test tax calculation preview with automatic calculation
      const autoPreviewResponse = await authedApiClient.tax[
        "calculate-preview"
      ].$post({
        json: {
          customerId: testCustomerId,
          amount: 5000, // $50.00
          currency: "USD",
          lineItems: [
            {
              type: "subscription",
              description: "Monthly subscription",
              subtotalCents: 5000,
              billingPeriodStart: new Date(),
              billingPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          ],
        },
      });

      // Preview API may work with placeholder customer IDs or handle customer creation internally
      if (autoPreviewResponse.status === 200) {
        const autoPreview = await autoPreviewResponse.json();
        if (!("error" in autoPreview)) {
          expect(autoPreview.taxableAmount).toBe(5000);
          expect(autoPreview.totalTaxCents).toBeGreaterThan(0);
          expect(autoPreview.effectiveTaxRate).toBeGreaterThan(0);
          expect(autoPreview.calculationMethod).toBe("auto");
          expect(Array.isArray(autoPreview.taxLineItems)).toBe(true);
          expect(autoPreview.taxLineItems.length).toBeGreaterThan(0);
        }
      }

      // Test with manual tax calculation
      await configureMerchantTax({
        autoTaxCalculation: false,
        defaultTaxRate: "0.075", // 7.5%
      });

      const manualPreviewResponse = await authedApiClient.tax[
        "calculate-preview"
      ].$post({
        json: {
          customerId: testCustomerId,
          amount: 10000, // $100.00
          currency: "USD",
          lineItems: [
            {
              type: "subscription",
              description: "Monthly subscription",
              subtotalCents: 10000,
              billingPeriodStart: new Date(),
              billingPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          ],
        },
      });

      if (manualPreviewResponse.status === 200) {
        const manualPreview = await manualPreviewResponse.json();
        if (!("error" in manualPreview)) {
          expect(manualPreview.taxableAmount).toBe(10000);
          expect(manualPreview.totalTaxCents).toBe(750); // 7.5% of $100.00
          expect(manualPreview.effectiveTaxRate).toBe(0.075);
          expect(manualPreview.calculationMethod).toBe("manual");
          expect(Array.isArray(manualPreview.taxLineItems)).toBe(true);
          expect(manualPreview.taxLineItems.length).toBe(1);

          const manualTaxLineItem = manualPreview.taxLineItems[0];
          expect(manualTaxLineItem.type).toBe("tax");
          expect(manualTaxLineItem.subtotalCents).toBe(750);
          expect(manualTaxLineItem.taxMetadata?.taxType).toBe("manual");
        }
      }

      // Test validation - invalid amount should be rejected
      const invalidPreviewResponse = await authedApiClient.tax[
        "calculate-preview"
      ].$post({
        json: {
          customerId: testCustomerId,
          amount: -1000, // Negative amount
          currency: "USD",
          lineItems: [],
        },
      });
      // Negative amount should return 400 (validation error), not 500 (server error)
      expect(invalidPreviewResponse.status).toBe(400);

      // Manual tax preview should succeed with 200
      expect(manualPreviewResponse.status).toBe(200);
    }, 40000);
  });

  describe("Seat Overage Tax Scenarios", () => {
    it("should apply VAT correctly for immediate seat overage billing", async () => {
      // Configure merchant for automatic tax calculation and set to Germany
      await configureMerchantTax({ autoTaxCalculation: true });
      await db
        .update(merchants)
        .set({ country: "DE" })
        .where(eq(merchants.id, merchantId));

      // External customer identifier
      const externalCustomerId = `seat-tax-customer-${Date.now()}`;

      // Create seat-based plan (EUR) with min 3 seats, billed immediately
      const planResp = await authedApiClient.plans.$post({
        json: {
          planName: "Seat Tax Plan",
          planDescription: "Seat-based plan for VAT test",
          commitMessage: "Create seat tax plan",
          currency: "EUR",
          monthlyPrice: 1000, // €10 per seat
          showInPricingTable: false,
          isEnterprisePlan: false,
          isSeatBased: true,
          minSeats: 3,
          billImmediately: true,
          newFeatures: [],
        },
      });
      const planData = await planResp.json();
      if ("error" in planData) throw new Error(planData.error);
      const seatPlan = planData.plans[0];

      // Fetch prices
      const pricesResp = await authedApiClient.prices.$get({
        query: { planId: seatPlan.id },
      });
      const pricesData = await pricesResp.json();
      if ("error" in pricesData) throw new Error(pricesData.error);
      const monthlyPrice = pricesData.prices.find((p: any) =>
        p.pricingData.components.some((c: any) =>
          c.recurrence_rule?.includes("MONTHLY")
        )
      );
      if (!monthlyPrice) throw new Error("Monthly price not found");

      // Subscribe customer via payment-init
      const customerEmail = `${externalCustomerId}@example.de`;
      const paymentInitResp = await baseApiClient.public["payment-init"].$post({
        json: {
          lumenPublishableKey: publishableApiKey,
          planId: seatPlan.id,
          priceId: monthlyPrice.id,
          customerEmail,
          customerName: "Seat Tax Test Customer",
          customerCountry: "DE",
          taxId: "366513651",
          userId: externalCustomerId,
          ...(process.env.PAYMENT_PROVIDER === "dodo"
            ? customerAddressObj
            : {}),
        },
      });
      expect(paymentInitResp.status).toBe(200);
      const paymentInitData = await paymentInitResp.json();
      if ("error" in paymentInitData) throw new Error(paymentInitData.error);

      await paymentProvider.completePaymentInit(paymentInitData);

      // Wait for webhook to create subscription/invoice
      await sleep(3000);

      // Fetch created customer
      const customer = await db.query.customers.findFirst({
        where: and(
          eq(customers.merchantId, merchantId),
          eq(customers.email, customerEmail),
          isNull(customers.deletedAt)
        ),
      });
      expect(customer).toBeDefined();
      const customerId = customer!.id;

      // Initial invoice (min 3 seats) should include VAT
      let customerInvoices = await db.query.invoices.findMany({
        where: eq(invoices.customerId, customerId),
        with: { lineItems: true },
        orderBy: (inv, { asc }) => [asc(inv.createdAt)],
      });
      expect(customerInvoices).toHaveLength(1);
      const firstInvoice = customerInvoices[0];
      expect(firstInvoice.totalAmountCents).toBe(3000); // we didn't configure tax for the first payment so no tax is applied

      // Add 3 seats within min (no immediate charge)
      for (const uid of ["u1", "u2", "u3"]) {
        await authedApiClient.seats.add.$post({
          json: {
            user_id: externalCustomerId,
            created_user_id: uid,
            idempotency_key: `add-${uid}-${Date.now()}`,
          },
        });
      }
      await sleep(1000);

      customerInvoices = await db.query.invoices.findMany({
        where: eq(invoices.customerId, customerId),
        with: { lineItems: true },
        orderBy: (inv, { asc }) => [asc(inv.createdAt)],
      });
      expect(customerInvoices).toHaveLength(1); // still only initial invoice

      // Fetch subscription to determine billing period for accurate proration
      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.customerId, customerId),
          eq(subscriptions.planId, seatPlan.id)
        ),
      });
      expect(subscription).toBeDefined();

      const subDetail = await db.query.subscriptionDetails.findFirst({
        where: and(
          eq(subscriptionDetails.subscriptionId, subscription!.id),
          isNull(subscriptionDetails.deletedAt)
        ),
      });
      expect(subDetail).toBeDefined();

      // Create the 4th seat 5 days before the billing period ends to test proration
      const prorationStart = new Date(
        subDetail!.nextBillingDate.getTime() - 5 * 24 * 60 * 60 * 1000
      );

      // Add 4th seat to trigger immediate overage billing with custom timestamp for proration
      await authedApiClient.seats.add.$post({
        json: {
          user_id: externalCustomerId,
          created_user_id: "u4",
          idempotency_key: `add-u4-${Date.now()}`,
          timestamp: prorationStart.toISOString(),
        },
      });

      // Brief wait for database consistency
      await sleep(5000);

      // Verify new invoice was immediately generated, charged, and includes VAT
      customerInvoices = await db.query.invoices.findMany({
        where: eq(invoices.customerId, customerId),
        with: { lineItems: true },
        orderBy: (inv, { asc }) => [asc(inv.createdAt)],
      });
      expect(customerInvoices.length).toBe(2);
      const latestInvoice = customerInvoices[customerInvoices.length - 1];
      expect(latestInvoice.status).toBe("paid"); // Should be immediately charged

      // Calculate expected prorated seat amount
      const expectedSeatSubtotal = prorateAmountCents(
        1000,
        subDetail!.previousBillingDate || subDetail!.subscriptionStartDate,
        subDetail!.nextBillingDate,
        prorationStart
      );

      const expectedTax = Math.round(expectedSeatSubtotal * 0.19); // 19% VAT

      expect(latestInvoice.subtotalCents).toBe(expectedSeatSubtotal);
      expect(latestInvoice.taxAmountCents).toBe(expectedTax);
      expect(latestInvoice.totalAmountCents).toBe(
        expectedSeatSubtotal + expectedTax
      );
      const taxLine = latestInvoice.lineItems.find((li) => li.type === "tax");
      expect(taxLine).toBeDefined();
      expect(taxLine!.subtotalCents).toBe(expectedTax);
    }, 40000);
  });
});
