import {
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  setDefaultTimeout,
} from "bun:test";
import { db } from "../../src/db/client";
import { env } from "../../src/env";
import { sql, eq } from "drizzle-orm";
import {
  invoices,
  invoiceLineItems,
  subscriptions,
  subscriptionDetails,
  subscriptionsScheduledChanges,
  subscriptionFeatures,
  customers,
  payments,
  paymentMethods,
  events,
  metrics,
  creditGrants,
  creditDefinitions,
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
  merchants,
} from "@lumen/common/schema";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createTestApiKeys,
  createPaymentProvider,
  PaymentProviderAdapter,
} from "../test-helpers";

setDefaultTimeout(20000);

describe("Payment Failure Flow - Setup", () => {
  let merchantId: string;
  let sessionToken: string;
  let apiClient: ReturnType<typeof createTestApiClient>;
  let paymentProvider: PaymentProviderAdapter;
  let publishableApiKey: string;
  let apiUrl: string;
  let triggerApiAccessKey: string;

  const cleanupTestData = async () => {
    try {
      // Payments and invoices
      await db.execute(sql`
        DELETE FROM ${paymentRetries};
        DELETE FROM ${payments};
        DELETE FROM ${invoiceLineItems};
        DELETE FROM ${invoices};
      `);

      // Subscriptions and related
      await db.execute(sql`
        DELETE FROM ${subscriptionsScheduledChanges};
        DELETE FROM ${subscriptionFeatures};
        DELETE FROM ${subscriptionDetails};
        DELETE FROM ${subscriptions};
        DELETE FROM ${paymentMethods};
      `);

      // Credits
      await db.execute(sql`
        DELETE FROM ${creditGrants};
        DELETE FROM ${creditDefinitions};
      `);

      // Metrics and events
      await db.execute(sql`
        DELETE FROM ${metrics};
        DELETE FROM ${events};
      `);

      // Pricing/plan scaffolding
      await db.execute(sql`
        DELETE FROM ${customerInvoiceCounters};
        DELETE FROM ${pricingTablePlans};
        DELETE FROM ${pricingTables};
        DELETE FROM ${planFeatures};
        DELETE FROM ${featureMetrics};
        DELETE FROM ${features};
        DELETE FROM ${prices};
        DELETE FROM ${plans};
      `);

      // User/org created by test environment
      await db.execute(sql`
        DELETE FROM ${user};
        DELETE FROM ${organization};
      `);
    } catch (error) {
      console.error("Error during test cleanup (payment-failure):", error);
      throw error;
    }
  };

  beforeAll(async () => {
    apiUrl = env.API_URL;
    triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY!;
  });

  afterAll(async () => {
    // No-op; each test manages its own environment and cleanup
  });

  beforeEach(async () => {
    // Fresh environment per test for isolation
    const { merchant, user } = await createFullTestEnvironment();
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

    // Start Stripe/Dodo webhook forwarder for this merchant
    await paymentProvider.startWebhookForwarder(merchantId);
  });

  afterEach(async () => {
    if (paymentProvider) await paymentProvider.cleanup();
    await cleanupTestData();
  });
});
