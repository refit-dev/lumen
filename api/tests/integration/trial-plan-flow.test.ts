import {
  describe,
  it,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  expect,
  spyOn,
} from "bun:test";
import { db } from "../../src/db/client";
import {
  createFullTestEnvironment,
  createTestApiKeys,
  createTestStripe,
  createTestApiClient,
  authenticateTestUser,
  cleanupDataFull,
} from "../test-helpers";
import {
  plans,
  subscriptions,
  subscriptionsScheduledChanges,
  subscriptionDetails,
  invoices,
  invoiceLineItems,
  payments,
  creditGrants,
  creditDefinitions,
  prices,
  planFeatures,
  features,
  customers,
  paymentMethods,
  subscriptionFeatures,
  creditUsageTransactions,
  stripe as stripeSchema,
  merchants,
} from "@lumen/common/schema";
import { env } from "../../src/env";
import { testEnv } from "../test-env";
import { eq, and, isNull, desc, lte, sql } from "drizzle-orm";
import Stripe from "stripe";
import { setTimeout as sleep } from "timers/promises";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { EncryptedField, encryptField } from "../../src/helpers/encryption";
import { addMonths } from "date-fns";

// Retry helper from tax.test.ts
async function retryWithSleep<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean = (result) =>
    result !== undefined && result !== null,
  maxAttempts = 5,
  sleepMs = 2500
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

// Cleanup function similar to tax.test.ts but focused on trial data
const cleanupTrialTestData = async () => {
  try {
    // Clean up in proper order to handle foreign key constraints
    await db.execute(sql`
      DELETE FROM ${creditUsageTransactions};
      DELETE FROM ${payments};
      DELETE FROM ${invoiceLineItems};
      DELETE FROM ${invoices};
      DELETE FROM ${subscriptionFeatures};
      DELETE FROM ${subscriptionDetails};
      DELETE FROM ${subscriptionsScheduledChanges};
      DELETE FROM ${subscriptions};
      DELETE FROM ${creditGrants};
      DELETE FROM ${paymentMethods};
      DELETE FROM ${customers};
    `);
  } catch (error) {
    console.error("Error during trial test cleanup:", error);
    throw error;
  }
};

// Helper function to find the Stripe CLI (copied from tax.test.ts)
async function findStripeCLI(): Promise<string | null> {
  try {
    const proc = await Bun.spawn(["which", "stripe"], { stdout: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const result = stdout.trim();
    if (result) return result;
  } catch (e) {
    /* ignore */
  }
  const possiblePaths = [
    "/usr/local/bin/stripe",
    "/opt/homebrew/bin/stripe",
    path.join(process.env.HOME || "", ".local/bin/stripe"),
    process.env.STRIPE_CLI_PATH,
  ];
  for (const p of possiblePaths) {
    if (!p) continue;
    try {
      await fs.access(p, fs.constants.X_OK);
      return p;
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

describe("Trial-to-Paid Plan Flow", () => {
  // Test variables
  let merchantId: string;
  let sessionToken: string;
  let apiClient: ReturnType<typeof createTestApiClient>;
  let publishableApiKey: string;
  let stripeClient: Stripe;
  let webhookProcess: ChildProcess | null = null;
  let apiUrl: string;
  let triggerApiAccessKey: string;

  // Plan and price IDs
  let mainPlanId: string;
  let mainPriceId: string;
  let trialPlanId: string;
  let trialPriceId: string;

  // Subscription IDs
  let trialSubscriptionId: string;
  let paidSubscriptionId: string;
  let customerId: string;
  const tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  const tempMerchantIdFile = "/tmp/test_merchant_id.txt";

  beforeAll(async () => {
    await cleanupDataFull();
    apiUrl = env.API_URL;
    triggerApiAccessKey = env.TRIGGER_API_ACCESS_KEY!;

    // Initialize Stripe client with test environment variables
    stripeClient = new Stripe(testEnv.TEST_STRIPE_SECRET_KEY, {
      apiVersion: "2025-02-24.acacia",
    });

    // Create test environment
    const { user, merchant } = await createFullTestEnvironment({
      createPlan: false,
    });
    merchantId = merchant.id;

    // Authenticate user
    const authRes = await authenticateTestUser(user.email, user.password);
    sessionToken = authRes.cookies.sessionToken;
    apiClient = createTestApiClient(sessionToken);

    // Update merchant to be Germany-based for this test
    await db
      .update(merchants)
      .set({
        country: "DE",
        city: "Berlin",
        defaultCurrency: "EUR",
      })
      .where(eq(merchants.id, merchantId));
    console.log(`Set merchant ${merchantId} country to DE for tax test`);

    // Enable automatic tax calculation for the merchant
    await apiClient.tax.config.update.$post({
      json: { autoTaxCalculation: true },
    });
    console.log(`Enabled automatic tax calculation for merchant ${merchantId}`);

    // Set up Stripe integration
    await createTestStripe({
      merchantId,
      secretKey: testEnv.TEST_STRIPE_SECRET_KEY,
      publicKey: testEnv.TEST_STRIPE_PUBLIC_KEY,
      webhookSecret: testEnv.TEST_STRIPE_WEBHOOK_SECRET,
    });

    // Create API keys
    const apiKeys = await createTestApiKeys({
      merchantId,
      environment: "test",
    });
    publishableApiKey = apiKeys.publishableKey.keyValue;

    // Set up Stripe CLI webhook forwarding (similar to tax.test.ts)
    const stripeCLIPath = await findStripeCLI();
    if (stripeCLIPath) {
      const secretProc = Bun.spawnSync([
        stripeCLIPath,
        "listen",
        "--print-secret",
        "--api-key",
        testEnv.TEST_STRIPE_SECRET_KEY,
      ]);
      if (secretProc.exitCode === 0) {
        const liveWebhookSecret = secretProc.stdout.toString().trim();
        await fs.writeFile(tempWebhookSecretFile, liveWebhookSecret); // test webhook is read from this file

        await db
          .update(stripeSchema)
          .set({ webhookSecret: await encryptField(liveWebhookSecret) })
          .where(eq(stripeSchema.merchantId, merchantId));

        console.log(`Updated webhook secret for merchant ${merchantId}`);

        webhookProcess = spawn(
          stripeCLIPath,
          [
            "listen",
            "--forward-to",
            `${apiUrl}/public/webhook/${merchantId}`,
            "--api-key",
            testEnv.TEST_STRIPE_SECRET_KEY,
            "--events",
            "payment_intent.succeeded,payment_intent.payment_failed,setup_intent.succeeded",
          ],
          { detached: true, stdio: "pipe" }
        );
        webhookProcess.stderr?.on("data", (data) => {
          console.error(`Stripe CLI: ${data}`);
        });
        webhookProcess.on("error", (error) => {
          console.error("Failed to start Stripe CLI:", error);
        });
        console.log(
          `Webhook listener started with PID ${webhookProcess?.pid} for merchant ${merchantId}`
        );
        await sleep(3000);
      }
    } else {
      console.warn(
        "Stripe CLI not found. Webhook-dependent tests may fail or be inaccurate."
      );
    }
  });

  afterAll(async () => {
    // Clean up webhook process
    if (webhookProcess && webhookProcess.pid && !webhookProcess.killed) {
      const killed = process.kill(webhookProcess.pid, "SIGINT");
      if (killed) {
        await new Promise((resolve) => webhookProcess!.on("close", resolve));
      }
      webhookProcess = null;
    }
    await cleanupDataFull();
  });

  beforeEach(async () => {
    try {
      await cleanupTrialTestData();
    } catch (error) {
      console.warn("Cleanup failed in beforeEach:", error);
    }
  });

  afterEach(async () => {
    try {
      await cleanupTrialTestData();
    } catch (error) {
      console.warn("Cleanup failed in afterEach:", error);
    }
  });

  it("should create plan and trial, subscribe customer, upgrade and bill correctly", async () => {
    /* ------------------------------------------------------------------
     * 1. Create plan (with trial) via API
     * ----------------------------------------------------------------*/
    const planPayload = {
      planName: "Pro Plan",
      planDescription: "Pro with 14-day trial",
      monthlyPrice: 2999,
      currency: "USD",
      newFeatures: [
        {
          slug: "api-calls",
          featureName: "API Calls",
          eventName: "api_call",
          isUsageBased: true,
          usagePricePerUnit: 10,
          hasCreditAllowance: true,
          creditAllowanceAmount: 500,
          creditAllowanceRenewal: "monthly" as const,
          trialCreditAllowance: 100, // trial gets 100 calls
        },
        {
          slug: "analytics",
          featureName: "Analytics Dashboard",
          isUsageBased: false,
        },
      ],
      trial: {
        enabled: true,
        days: 14,
        creditOverrides: [{ featureSlug: "api-calls", allowance: 100 }],
      },
    };

    const planResp = await apiClient.plans.$post({ json: planPayload });
    expect(planResp.status).toBe(200);
    const planBody = await planResp.json();
    if ("error" in planBody) throw new Error(planBody.error);

    const mainPlan = planBody.plans[0];
    mainPlanId = mainPlan.id;

    // Fetch trial plan row from DB
    const trialPlan = await retryWithSleep(
      async () => {
        return await db.query.plans.findFirst({
          where: and(
            eq(plans.trialParentPlanId, mainPlanId),
            eq(plans.isTrialPlan, true),
            isNull(plans.deletedAt)
          ),
        });
      },
      (result) => result !== undefined && result !== null
    );
    expect(trialPlan).toBeDefined();
    trialPlanId = trialPlan!.id;
    expect(trialPlan!.trialDays).toBe(14);
    expect(trialPlan!.planName).toBe("Pro Plan - Free Trial");

    // Fetch price IDs for both plans
    const mainPriceRows = await db.query.prices.findMany({
      where: and(eq(prices.planId, mainPlanId), isNull(prices.deletedAt)),
    });
    expect(mainPriceRows).toHaveLength(1);
    mainPriceId = mainPriceRows[0].id;

    const trialPriceRows = await db.query.prices.findMany({
      where: and(eq(prices.planId, trialPlanId), isNull(prices.deletedAt)),
    });
    expect(trialPriceRows).toHaveLength(1);
    trialPriceId = trialPriceRows[0].id;

    // Verify trial plan has zero-cost pricing
    const trialPricing = trialPriceRows[0].pricingData as any;
    expect(trialPricing.components).toHaveLength(1);
    expect(trialPricing.components[0].amount_cents).toBe(0);
    expect(trialPricing.components[0].type).toBe("fixed");

    // Verify trial plan features match main plan
    const mainPlanFeatures = await db.query.planFeatures.findMany({
      where: and(
        eq(planFeatures.planId, mainPlanId),
        isNull(planFeatures.deletedAt)
      ),
    });
    const trialPlanFeatures = await db.query.planFeatures.findMany({
      where: and(
        eq(planFeatures.planId, trialPlanId),
        isNull(planFeatures.deletedAt)
      ),
    });
    expect(trialPlanFeatures).toHaveLength(mainPlanFeatures.length);
    expect(trialPlanFeatures.map((f) => f.featureSlug).sort()).toEqual(
      mainPlanFeatures.map((f) => f.featureSlug).sort()
    );

    // Verify feature values are identical between main and trial plans
    for (const mainFeature of mainPlanFeatures) {
      const correspondingTrialFeature = trialPlanFeatures.find(
        (tf) => tf.featureSlug === mainFeature.featureSlug
      );
      expect(correspondingTrialFeature).toBeDefined();
      expect(correspondingTrialFeature!.featureValue).toEqual(
        mainFeature.featureValue
      );
    }

    // Verify trial credit definitions have correct allowances
    const trialCreditDefinitions = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, trialPlanId),
        eq(creditDefinitions.featureSlug, "api-calls"),
        isNull(creditDefinitions.deletedAt)
      ),
    });
    expect(trialCreditDefinitions).toHaveLength(1);
    expect(trialCreditDefinitions[0].defaultAmount).toBe(100);
    expect(trialCreditDefinitions[0].billingVisible).toBe(false);

    // Also verify main plan credit definitions for comparison
    const mainCreditDefinitions = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.planId, mainPlanId),
        eq(creditDefinitions.featureSlug, "api-calls"),
        isNull(creditDefinitions.deletedAt)
      ),
    });
    expect(mainCreditDefinitions).toHaveLength(1);
    expect(mainCreditDefinitions[0].defaultAmount).toBe(500);
    expect(mainCreditDefinitions[0].billingVisible).toBe(true);
    expect(mainCreditDefinitions[0].renewOnBilling).toBe(true);

    /* ------------------------------------------------------------------
     * 2. Subscribe customer (startTrial=true) using payment-init flow
     * ----------------------------------------------------------------*/
    const customerEmail = `trial_cust_${Date.now()}@example.com`;
    const userId = `user_${Date.now()}`;

    const paymentInitResp = await apiClient.public["payment-init"].$post({
      json: {
        lumenPublishableKey: publishableApiKey,
        priceId: mainPriceId,
        planId: mainPlanId,
        customerEmail,
        customerName: "Trial Customer",
        businessName: "Trial Customer GmbH",
        userId,
        customerAddress: "123 Trial St",
        customerZip: "10115", // Berlin zip code
        customerCity: "Berlin",
        customerCountry: "DE", // Germany
        customerStateProvince: "Berlin", // Berlin state
        startTrial: true,
      },
    });
    expect(paymentInitResp.status).toBe(200);
    const initData = await paymentInitResp.json();
    if (!("clientSecret" in initData))
      throw new Error("payment-init did not return clientSecret");

    // Confirm SetupIntent (trial flow)
    await stripeClient.setupIntents.confirm(initData.intentId, {
      payment_method: "pm_card_visa",
    });

    await sleep(2000);

    // Wait for webhook processing and retry to find the trial subscription
    const trialSub = await retryWithSleep(
      async () => {
        return await db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.planId, trialPlanId),
            isNull(subscriptions.deletedAt),
            isNull(subscriptions.endTimestamp)
          ),
        });
      },
      (result) => result !== undefined && result !== null
    );
    expect(trialSub).toBeDefined();
    trialSubscriptionId = trialSub!.id;
    customerId = trialSub!.customerId;
    expect(trialSub!.planId).toBe(trialPlanId);
    expect(trialSub!.effectivePriceId).toBe(trialPriceId);

    // Verify trial subscription features are properly attached
    const trialSubFeatures = await retryWithSleep(
      async () => {
        return await db.query.subscriptionFeatures.findMany({
          where: and(
            eq(subscriptionFeatures.subscriptionId, trialSubscriptionId),
            isNull(subscriptionFeatures.deletedAt)
          ),
        });
      },
      (result) => result !== undefined && result.length > 0
    );
    expect(trialSubFeatures).toHaveLength(2); // api-calls and analytics
    expect(trialSubFeatures.map((f) => f.featureSlug).sort()).toEqual([
      "analytics",
      "api-calls",
    ]);

    // Verify trial subscription feature values and sources
    const apiCallsTrialFeature = trialSubFeatures.find(
      (f) => f.featureSlug === "api-calls"
    );
    const analyticsTrialFeature = trialSubFeatures.find(
      (f) => f.featureSlug === "analytics"
    );

    expect(apiCallsTrialFeature).toBeDefined();
    expect(apiCallsTrialFeature!.featureValue).toBe("usage_based"); // Usage-based feature
    expect(apiCallsTrialFeature!.source).toBe("plan");
    expect(apiCallsTrialFeature!.customerId).toBe(customerId);
    expect(apiCallsTrialFeature!.merchantId).toBe(merchantId);

    expect(analyticsTrialFeature).toBeDefined();
    expect(analyticsTrialFeature!.featureValue).toBe(true); // Boolean feature
    expect(analyticsTrialFeature!.source).toBe("plan");
    expect(analyticsTrialFeature!.customerId).toBe(customerId);
    expect(analyticsTrialFeature!.merchantId).toBe(merchantId);

    // Verify credit grant (100 credits) exists
    const trialGrant = await retryWithSleep(
      async () => {
        return await db.query.creditGrants.findFirst({
          where: and(
            eq(creditGrants.customerId, customerId),
            eq(creditGrants.featureSlug, "api-calls"),
            eq(creditGrants.planId, trialPlanId),
            isNull(creditGrants.deletedAt)
          ),
        });
      },
      (result) => result !== undefined && result !== null
    );
    expect(trialGrant).toBeDefined();
    expect(trialGrant!.remainingAmount).toBe(100);
    expect(trialGrant!.initialAmount).toBe(100);
    expect(trialGrant!.status).toBe("ACTIVE");
    expect(trialGrant!.source).toBe("subscription");

    // Verify trial credit grant expiry (should expire at end of trial period)
    expect(trialGrant!.expiryDate).toBeDefined();
    expect(trialGrant!.startDate).toBeDefined();

    // Calculate expected expiry (trial days from start)
    const expectedExpiryDate = new Date(trialGrant!.startDate);
    expectedExpiryDate.setDate(expectedExpiryDate.getDate() + 14); // 14 day trial
    const actualExpiryDate = new Date(trialGrant!.expiryDate!);

    // Allow for some variance in timing (within 1 hour)
    const timeDifference = Math.abs(
      actualExpiryDate.getTime() - expectedExpiryDate.getTime()
    );
    expect(timeDifference).toBeLessThan(60 * 60 * 1000); // 1 hour tolerance

    // Verify trial grants don't have renewal settings (one-time only)
    expect(trialGrant!.nextRenewalDate).toBeNull();
    expect(trialGrant!.renewalRrule).toBeNull();

    // Verify scheduled change exists for trial-to-paid migration
    const scheduledChange =
      await db.query.subscriptionsScheduledChanges.findFirst({
        where: and(
          eq(subscriptionsScheduledChanges.subscriptionId, trialSubscriptionId),
          isNull(subscriptionsScheduledChanges.processedAt)
        ),
      });
    expect(scheduledChange).toBeDefined();
    expect(scheduledChange!.newPlanId).toBe(mainPlanId);
    expect(scheduledChange!.newPriceId).toBe(mainPriceId);
    expect(scheduledChange!.effectiveOnNextBilling).toBe(false);

    // scheduled change effective date should be very close to the trial end date
    expect(scheduledChange!.effectiveDate).toBeDefined();
    const timeDifference2 = Math.abs(
      scheduledChange!.effectiveDate!.getTime() -
        trialGrant!.expiryDate!.getTime()
    );
    expect(timeDifference2).toBeLessThan(1000 * 60 * 60 * 24); // 1 day tolerance

    /* ------------------------------------------------------------------
     * 3. Fast-forward trial end & trigger upgrade endpoint
     * ----------------------------------------------------------------*/
    // Update the scheduled change to be in the past (simulate trial expiry)
    const pastDate = new Date();
    pastDate.setHours(pastDate.getHours() - 1); // 1 hour ago

    await db
      .update(subscriptionsScheduledChanges)
      .set({ effectiveDate: pastDate })
      .where(
        eq(subscriptionsScheduledChanges.subscriptionId, trialSubscriptionId)
      );

    // Call upgrade-trial endpoint (this mimics what applyScheduledChangesJob does)
    const upgradeResp = await fetch(
      `${apiUrl}/trigger/billing/migrations/upgrade-trial-subscriptions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${triggerApiAccessKey}`,
        },
      }
    );
    expect(upgradeResp.ok).toBe(true);
    const upgradeData = await upgradeResp.json();
    expect(upgradeData.processed).toBe(1);

    // Wait for webhook/payment processing with retry
    await sleep(7000);

    /* ------------------------------------------------------------------
     * 4. Comprehensive Assertions after upgrade
     * ----------------------------------------------------------------*/

    // === OLD SUBSCRIPTION CLEANUP VERIFICATION ===

    // Old trial subscription should be ended (soft deleted)
    const oldSubRow = await retryWithSleep(
      async () => {
        return await db.query.subscriptions.findFirst({
          where: eq(subscriptions.id, trialSubscriptionId),
        });
      },
      (result) =>
        result !== undefined && result !== null && result.endTimestamp !== null
    );
    expect(oldSubRow!.endTimestamp).toBeTruthy();
    expect(oldSubRow!.planId).toBe(trialPlanId); // Still references trial plan

    // Old subscription features should be cleaned up
    const oldSubFeatures = await db.query.subscriptionFeatures.findMany({
      where: eq(subscriptionFeatures.subscriptionId, trialSubscriptionId),
    });
    // Features should either be deleted or have deletedAt set
    expect(oldSubFeatures.every((f) => f.deletedAt !== null)).toBe(true);

    // Old credit grants should be expired/cancelled
    const oldCreditGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.planId, trialPlanId),
        eq(creditGrants.featureSlug, "api-calls")
      ),
    });
    expect(oldCreditGrant).toBeDefined();
    expect(["EXPIRED", "CANCELLED"]).toContain(oldCreditGrant!.status);

    // Verify old credit grant still maintains its original linkage to trial definition
    expect(oldCreditGrant!.creditDefinitionId).toBe(
      trialCreditDefinitions[0].id
    );
    expect(oldCreditGrant!.planId).toBe(trialPlanId);
    expect(oldCreditGrant!.initialAmount).toBe(100); // Original trial amount
    expect(oldCreditGrant!.billingVisible).toBe(false); // Trial credits weren't billing visible

    // Verify the grant was properly deactivated (not just deleted)
    expect(oldCreditGrant!.deletedAt).toBeNull(); // Should be status change, not deletion
    expect(oldCreditGrant!.id).toBe(trialGrant!.id); // Same grant, different status

    // === NEW PAID SUBSCRIPTION VERIFICATION ===

    // New paid subscription should exist
    const paidSub = await db.query.subscriptions.findMany({
      where: and(
        eq(subscriptions.customerId, customerId),
        eq(subscriptions.planId, mainPlanId),
        isNull(subscriptions.deletedAt),
        isNull(subscriptions.endTimestamp)
      ),
      orderBy: [desc(subscriptions.createdAt)],
    });
    expect(paidSub).toHaveLength(1);
    paidSubscriptionId = paidSub[0].id;
    expect(paidSub[0].planId).toBe(mainPlanId);
    expect(paidSub[0].effectivePriceId).toBe(mainPriceId);
    expect(paidSub[0]!.versionNumber).toBe(2); // New subscription is version 2, version 1 was the trial version subscription

    // New subscription features should be properly attached
    const paidSubFeatures = await db.query.subscriptionFeatures.findMany({
      where: and(
        eq(subscriptionFeatures.subscriptionId, paidSubscriptionId),
        isNull(subscriptionFeatures.deletedAt)
      ),
    });
    expect(paidSubFeatures).toHaveLength(2); // api-calls and analytics
    expect(paidSubFeatures.map((f) => f.featureSlug).sort()).toEqual([
      "analytics",
      "api-calls",
    ]);

    // Verify paid subscription feature values and sources
    const apiCallsPaidFeature = paidSubFeatures.find(
      (f) => f.featureSlug === "api-calls"
    );
    const analyticsPaidFeature = paidSubFeatures.find(
      (f) => f.featureSlug === "analytics"
    );

    expect(apiCallsPaidFeature).toBeDefined();
    expect(apiCallsPaidFeature!.featureValue).toBe("usage_based"); // Usage-based feature
    expect(apiCallsPaidFeature!.source).toBe("plan");
    expect(apiCallsPaidFeature!.customerId).toBe(customerId);
    expect(apiCallsPaidFeature!.merchantId).toBe(merchantId);

    expect(analyticsPaidFeature).toBeDefined();
    expect(analyticsPaidFeature!.featureValue).toBe(true); // Boolean feature
    expect(analyticsPaidFeature!.source).toBe("plan");
    expect(analyticsPaidFeature!.customerId).toBe(customerId);
    expect(analyticsPaidFeature!.merchantId).toBe(merchantId);

    // Verify features were inherited correctly from the main plan
    const mainPlanApiCallsFeature = mainPlanFeatures.find(
      (f) => f.featureSlug === "api-calls"
    );
    const mainPlanAnalyticsFeature = mainPlanFeatures.find(
      (f) => f.featureSlug === "analytics"
    );

    expect(apiCallsPaidFeature!.featureValue).toEqual(
      mainPlanApiCallsFeature!.featureValue
    );
    expect(analyticsPaidFeature!.featureValue).toEqual(
      mainPlanAnalyticsFeature!.featureValue
    );

    // Check subscription has billing details (nextBillingDate is in subscriptionDetails)
    const subscriptionDetailList = await db.query.subscriptionDetails.findMany({
      where: eq(subscriptionDetails.subscriptionId, paidSubscriptionId),
    });
    expect(subscriptionDetailList).toHaveLength(2); // 1 for api-calls, 1 for analytics
    console.info(subscriptionDetailList);
    const analyticsDetail = subscriptionDetailList.find((sd) =>
      sd.componentId.includes("price_comp_fix_")
    ); // fixed component, 1 billing cycle
    const apiCallsDetail = subscriptionDetailList.find((sd) =>
      sd.componentId.includes("price_comp_usage_")
    ); // usage-based component, 0 billing cycles

    // Calculate expected next billing date (should be ~1 month from subscription creation time)
    const expectedNextBillingDate = addMonths(paidSub[0].createdAt, 1);

    // Strict next billing date checks
    expect(analyticsDetail!.nextBillingDate.toISOString().split("T")[0]).toBe(
      expectedNextBillingDate.toISOString().split("T")[0]
    );
    expect(apiCallsDetail!.nextBillingDate.toISOString().split("T")[0]).toBe(
      expectedNextBillingDate.toISOString().split("T")[0]
    );

    expect(analyticsDetail!.cyclesBilled).toBe(1); // First billing cycle occurs when subscription is moved to paid plan
    expect(apiCallsDetail!.cyclesBilled).toBe(0); // Usage-based component, 0 billing cycles
    expect(analyticsDetail!.paymentMethodId).toBeTruthy();

    // === INVOICE AND PAYMENT VERIFICATION ===

    // Invoice should exist and be paid
    const invoiceRow = await db.query.invoices.findFirst({
      where: eq(invoices.subscriptionId, paidSubscriptionId),
    });
    expect(invoiceRow).toBeDefined();
    expect(invoiceRow!.status).toBe("paid");
    expect(invoiceRow!.subtotalCents).toBe(2999);
    // German VAT is 19%
    const expectedTax = Math.round(2999 * 0.19);
    expect(invoiceRow!.taxAmountCents).toBe(expectedTax);
    expect(invoiceRow!.totalAmountCents).toBe(
      invoiceRow!.subtotalCents! + invoiceRow!.taxAmountCents!
    );
    expect(invoiceRow!.currency).toBe("USD");
    expect(invoiceRow!.taxJurisdiction).toBe("DE");
    expect(invoiceRow!.taxCalculationMethod).toBe("auto");

    // Invoice line items should be correct
    const invoiceLineItemsRows = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.invoiceId, invoiceRow!.id),
    });
    expect(invoiceLineItemsRows.length).toBe(2); // 1 for subscription, 1 for tax
    const mainLineItem = invoiceLineItemsRows.find(
      (item) => item.type === "fixed"
    );
    expect(mainLineItem).toBeDefined();
    expect(mainLineItem!.subtotalCents).toBe(2999);

    // Assert tax line item
    const taxLineItem = invoiceLineItemsRows.find(
      (item) => item.type === "tax"
    );
    expect(taxLineItem).toBeDefined();
    expect(taxLineItem!.subtotalCents).toBe(invoiceRow!.taxAmountCents!);
    expect(taxLineItem!.taxMetadata?.taxType).toBe("vat");
    expect(taxLineItem!.taxMetadata?.jurisdiction).toBe("DE");
    expect(taxLineItem!.taxMetadata?.taxRate).toBe(0.19);
    expect(taxLineItem!.description).toContain("EU VAT");

    // Payment should exist and be successful
    const paymentRow = await db.query.payments.findFirst({
      where: eq(payments.invoiceId, invoiceRow!.id),
    });
    expect(paymentRow).toBeDefined();
    expect(paymentRow!.status).toBe("succeeded");
    expect(paymentRow!.amountCents).toBe(invoiceRow!.totalAmountCents);

    // === CREDIT GRANTS VERIFICATION ===

    // New credit grant (500 monthly) should exist for the paid subscription
    const paidGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.featureSlug, "api-calls"),
        eq(creditGrants.planId, mainPlanId), // paid plan credit
        eq(creditGrants.status, "ACTIVE"),
        isNull(creditGrants.deletedAt)
      ),
    });
    expect(paidGrant).toBeDefined();
    expect(paidGrant!.remainingAmount).toBe(500);
    expect(paidGrant!.initialAmount).toBe(500);
    expect(paidGrant!.status).toBe("ACTIVE");
    expect(paidGrant!.source).toBe("subscription");
    expect(paidGrant!.billingVisible).toBe(true); // Paid plan credits are billing visible

    // Verify paid credit grant matches its definition
    const mainCreditDef = mainCreditDefinitions[0];
    expect(paidGrant!.creditDefinitionId).toBe(mainCreditDef.id);
    expect(paidGrant!.applicationType).toBe(mainCreditDef.applicationType);
    expect(paidGrant!.featureId).toBe(mainCreditDef.featureId);
    expect(paidGrant!.featureSlug).toBe(mainCreditDef.featureSlug);
    expect(paidGrant!.scope).toBe(mainCreditDef.scope);
    expect(paidGrant!.planId).toBe(mainCreditDef.planId);
    expect(paidGrant!.billingVisible).toBe(mainCreditDef.billingVisible);
    expect(paidGrant!.initialAmount).toBe(mainCreditDef.defaultAmount);

    // Additional verification that this credit definition is properly configured for billing-based renewal
    expect(mainCreditDef.renewOnBilling).toBe(true);
    expect(mainCreditDef.expiryDays).toBe(-1); // -1 indicates expire on billing cycle
    expect(mainCreditDef.refillAmount).toBe(500); // Should match the defaultAmount/allowance
    expect(mainCreditDef.refillRrule).toBeNull(); // RRULE should be null when renewOnBilling is used

    // Grant-level fields should reflect billing-based renewal configuration
    expect(paidGrant!.expiryDate).toBeNull(); // Expiry handled at billing time
    expect(paidGrant!.renewalRrule).toBeNull(); // No RRULE when renewOnBilling is true

    // Verify paid credit grant renewal settings (should renew with billing)
    expect(paidGrant!.startDate).toBeTruthy();
    // For billing-based renewal, nextRenewalDate is managed at billing time and remains null on the initial grant
    if (mainCreditDef.renewOnBilling) {
      expect(paidGrant!.nextRenewalDate).toBeNull();
    }

    // Verify credit definition for paid plan
    expect(mainCreditDef).toBeDefined();
    expect(mainCreditDef!.defaultAmount).toBe(500);
    expect(mainCreditDef!.renewOnBilling).toBe(true); // Monthly renewal with billing

    // Verify the paid grant was created from the correct definition
    expect(paidGrant!.creditDefinitionId).toBe(mainCreditDef!.id);

    // === SCHEDULED CHANGE VERIFICATION ===

    // The scheduled change should be marked as processed
    const processedChange =
      await db.query.subscriptionsScheduledChanges.findFirst({
        where: eq(
          subscriptionsScheduledChanges.subscriptionId,
          trialSubscriptionId
        ),
      });
    expect(processedChange).toBeDefined();
    expect(processedChange!.processedAt).toBeTruthy();

    console.log("✅ Trial-to-paid migration test completed successfully!");
    console.log(`📊 Trial subscription: ${trialSubscriptionId} (ended)`);
    console.log(`📊 Paid subscription: ${paidSubscriptionId} (active)`);
    console.log(
      `💰 Invoice: ${invoiceRow!.id} (${invoiceRow!.totalAmountCents / 100} USD)`
    );
    console.log(`🎫 Trial credits: ${trialGrant!.remainingAmount} (expired)`);
    console.log(`🎫 Paid credits: ${paidGrant!.remainingAmount} (active)`);
    console.log(
      `✅ Credit system verified: definitions → grants → cleanup → renewal`
    );
  }, 120000); // 2 minute timeout for webhook processing
});
