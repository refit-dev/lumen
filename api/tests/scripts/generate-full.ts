#!/usr/bin/env bun
/**
 * Full data generation script
 * Creates complete test data setup but stops before creating subscriptions
 * This allows for manual subscription creation with proper Stripe integration
 *
 * Run with: bun run api/tests/scripts/generate-full.ts
 */
import colors from "ansi-colors";
import {
  createTestUser,
  createTestOrganization,
  createTestMerchant,
  createTestPrice,
  createTestPlanWithFeatures,
  createTestCustomer,
  createTestStripe,
  createTestMetric,
  createTestUsageCreditDefinition,
} from "../test-helpers/data";
import { createTestPricingTable } from "../test-helpers/data/pricing-table";
import { getMinimalTemplate } from "./generation-templates";
import type {
  Merchant,
  PlanSelect,
  PriceSelect,
  Customer,
} from "../test-helpers/types";
import { createApiKey } from "../../src/helpers/api_keys";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../src/db/client";
import { merchants, planFeatures } from "@lumen/common/schema";
import { Stripe } from "stripe";
import fs from "fs";

/**
 * Generated entities for tracking
 */
interface GeneratedEntities {
  user: {
    id: string;
    name: string;
    email: string;
    password: string;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  merchant: Merchant;
  plans: PlanSelect[];
  prices: PriceSelect[];
  customer: Customer;
  pricingTable: {
    id: string;
    name: string;
    slug: string;
    merchantId: string;
  };
  apiKeys: Array<{
    id: string;
    keyValue: string;
    keyType: string;
    environment: string;
    merchantId: string;
  }>;
  metric: {
    id: string;
    name: string;
    merchantId: string;
  };
  creditDefinitions: Array<{
    id: string;
    name: string;
    merchantId: string;
    planId: string;
  }>;
}

/**
 * Main generation function
 */
async function generateFullData(): Promise<GeneratedEntities> {
  info("🚀 Starting full data generation...");

  // Get the minimal template
  const template = getMinimalTemplate();

  info("Creating user and organization...");

  // Create user
  const user = await createTestUser(template.user);
  success(`Created user: ${user.email} (password: ${user.password})`);

  // Create organization
  const organization = await createTestOrganization({
    ...template.organization,
    userId: user.id,
    email: user.email,
    password: user.password,
  });
  success(`Created organization: ${organization.name}`);

  // Create merchant
  const merchant = await createTestMerchant({
    ...template.merchant,
    organizationId: organization.id,
    userId: user.id,
  });
  fs.writeFileSync("/tmp/test_merchant_id.txt", merchant.id);
  success(`Created merchant: ${merchant.displayName}`);

  info("Creating API keys...");

  // Create API Keys
  const secretKey = await createApiKey({
    merchantId: merchant.id,
    name: "Full Test Secret Key",
    keyType: "secret",
    environment: "test",
  });
  success(`Created secret API key`);

  const publishableKey = await createApiKey({
    merchantId: merchant.id,
    name: "Full Test Publishable Key",
    keyType: "publishable",
    environment: "test",
  });
  success(`Created publishable API key`);

  info("Setting up Stripe integration...");

  // Create Stripe integration
  const stripeSecretKey = process.env.TEST_STRIPE_SECRET_KEY;
  const stripePublicKey = process.env.TEST_STRIPE_PUBLIC_KEY;

  if (stripeSecretKey && stripePublicKey) {
    try {
      // Fetch merchant data from Stripe
      const stripeClient = new Stripe(stripeSecretKey, {
        apiVersion: "2025-02-24.acacia",
      });

      const account = await stripeClient.accounts.retrieve();

      // Update merchant with Stripe data
      await db
        .update(merchants)
        .set({
          defaultCurrency: account.default_currency?.toUpperCase() || "USD",
          websiteUrl: account.business_profile?.url || merchant.websiteUrl,
        })
        .where(eq(merchants.id, merchant.id))
        .returning();

      // Save Stripe integration
      await createTestStripe({
        merchantId: merchant.id,
        secretKey: stripeSecretKey,
        publicKey: stripePublicKey,
        webhookSecret: "whsec_test_1234567890",
      });

      success("Created Stripe integration with webhook");
    } catch (error) {
      console.error("Error setting up Stripe integration:", error);

      // Fallback without webhook
      await createTestStripe({
        merchantId: merchant.id,
        secretKey: stripeSecretKey,
        publicKey: stripePublicKey,
      });
      success("Created Stripe integration (without webhook)");
    }
  } else {
    warning("No Stripe credentials found - skipping Stripe integration");
  }

  info("Creating metrics...");

  // Create API calls metric for usage-based billing
  const apiCallsMetric = await createTestMetric({
    merchantId: merchant.id,
    name: "API Calls",
    description: "Sum of API calls made by customers",
    aggregationType: "SUM",
    eventName: "api.call",
    valueType: "NUMERIC",
  });
  success(`Created API calls metric: ${apiCallsMetric.name}`);

  info("Creating plans and prices...");

  const plans: PlanSelect[] = [];
  const prices: PriceSelect[] = [];

  // Create plans and prices from template
  for (const planTemplate of template.plans) {
    const { prices: priceTemplates, features, ...planData } = planTemplate;

    // Create plan with features
    const { plan } = await createTestPlanWithFeatures(
      merchant.id,
      features,
      planData
    );

    plans.push(plan);
    success(`Created plan: ${plan.planName}`);

    // Create prices for this plan
    for (const priceTemplate of priceTemplates) {
      const price = await createTestPrice({
        ...priceTemplate,
        pricingData: {
          ...priceTemplate.pricingData,
          components: priceTemplate.pricingData.components.map((c) => ({
            ...c,
            // Replace placeholder metric_id with actual metric ID
            ...(c.type === "usage" && c.metric_id === "api_calls_metric"
              ? { metric_id: apiCallsMetric.id }
              : {}),
            bill_immediately:
              c.bill_immediately !== undefined ? c.bill_immediately : true,
          })),
        },
        planId: plan.id,
        merchantId: merchant.id,
      });

      prices.push(price);
      const priceLabel = price.pricingData.components[0].label;
      success(`Created price: ${price.currency} (${priceLabel})`);
    }
  }

  info("Creating pricing table...");

  // Create pricing table with all plans
  const pricingTable = await createTestPricingTable({
    merchantId: merchant.id,
    name: "Pricing Plans",
    slug: "pricing-full",
    heading: "Choose the Plan that Works for You",
    subheading:
      "All plans include a 14-day free trial. No credit card needed. Cancel anytime.",
    isActive: true,
    planIds: plans.map((plan) => plan.id),
    planConfigs: plans.map((plan, index) => {
      const planName = plan.planName.toLowerCase();

      const isFreePlan = planName.includes("free");
      const isStarterPlan = planName.includes("starter");
      const isPlusPlan = planName.includes("plus");
      const isProPlan = planName.includes("pro");

      return {
        planId: plan.id,
        displayOrder: index + 1,
        isPopular: isPlusPlan,
        popularText: isPlusPlan ? "Most Popular" : undefined,
        buttonText: isFreePlan
          ? "Get Started Free"
          : isStarterPlan
            ? "Start Now"
            : isProPlan
              ? "Get Pro"
              : "Upgrade",
        buttonOutline: isProPlan,
      };
    }),
  });
  success(`Created pricing table with ${plans.length} plans`);

  info("Creating credit definitions...");

  const creditDefinitions: Array<{
    id: string;
    name: string;
    merchantId: string;
    planId: string;
  }> = [];

  // Create credit definitions for each plan
  for (const plan of plans) {
    const planFeaturesList = await db.query.planFeatures.findMany({
      where: and(
        eq(planFeatures.planId, plan.id),
        isNull(planFeatures.deletedAt)
      ),
      with: {
        feature: true,
      },
    });

    const apiCallsPlanFeature = planFeaturesList.find((pf) =>
      pf.featureSlug.includes("api-calls")
    );

    if (apiCallsPlanFeature) {
      const planPrice = prices.find((p) => p.planId === plan.id);
      if (planPrice) {
        const isFreePlan = plan.planName.toLowerCase().includes("free");

        if (isFreePlan) {
          // For free plans, create usage credits that cover the entire API call limit
          const featureValue = apiCallsPlanFeature.featureValue;
          const numericValue =
            typeof featureValue === "number"
              ? featureValue
              : parseInt(featureValue as string, 10);

          if (!isNaN(numericValue)) {
            // For free plans, we need a component to link the credit to
            // Use the fixed component as the price component
            const fixedComponent = planPrice.pricingData.components.find(
              (c) => c.type === "fixed"
            );

            if (!fixedComponent) {
              console.warn(
                `No fixed component found for free plan ${plan.planName}`
              );
              continue;
            }

            const creditDefinition = await createTestUsageCreditDefinition({
              merchantId: merchant.id,
              planId: plan.id,
              featureId: apiCallsPlanFeature.featureId,
              featureSlug: apiCallsPlanFeature.featureSlug,
              priceId: planPrice.id,
              priceComponentId: fixedComponent.component_id,
              currency: planPrice.currency,
              creditAmount: numericValue, // Full API call limit as credits
              name: `${plan.planName} API Credits`,
              description: `Free ${numericValue} API calls for ${plan.planName} subscribers`,
              expiryDays: 30,
              renewOnBilling: true,
              billingVisible: true,
              applicationType: "usage",
            });

            creditDefinitions.push({
              id: creditDefinition.id,
              name: creditDefinition.name,
              merchantId: merchant.id,
              planId: plan.id,
            });

            success(
              `Created credit definition: ${creditDefinition.name} (${numericValue} credits)`
            );
          }
        } else {
          // For paid plans, create usage credits only if there's a usage component
          const usageComponent = planPrice.pricingData.components.find(
            (c) => c.type === "usage" && c.metric_id === apiCallsMetric.id
          );

          if (usageComponent) {
            const featureValue = apiCallsPlanFeature.featureValue;
            const numericValue =
              typeof featureValue === "number"
                ? featureValue
                : parseInt(featureValue as string, 10);

            if (!isNaN(numericValue)) {
              const creditAmount = Math.floor(numericValue * 0.1); // 10% of limit as free credits

              const creditDefinition = await createTestUsageCreditDefinition({
                merchantId: merchant.id,
                planId: plan.id,
                featureId: apiCallsPlanFeature.featureId,
                featureSlug: apiCallsPlanFeature.featureSlug,
                priceId: planPrice.id,
                priceComponentId: usageComponent.component_id,
                currency: planPrice.currency,
                creditAmount: creditAmount,
                name: `${plan.planName} API Credits`,
                description: `Free ${creditAmount} API calls for ${plan.planName} subscribers`,
                expiryDays: 30,
                renewOnBilling: true,
                billingVisible: true,
                applicationType: "usage",
              });

              creditDefinitions.push({
                id: creditDefinition.id,
                name: creditDefinition.name,
                merchantId: merchant.id,
                planId: plan.id,
              });

              success(
                `Created credit definition: ${creditDefinition.name} (${creditAmount} credits)`
              );
            }
          }
        }
      }
    }

    // Also create a monetary credit grant for the fixed fee component of paid plans
    const planPrice = prices.find((p) => p.planId === plan.id);
    if (planPrice) {
      const isFreePlan = plan.planName.toLowerCase().includes("free");
      const fixedComponent = planPrice.pricingData.components.find(
        (c) => c.type === "fixed"
      );

      // Only create monetary credits for paid plans (fixed components with non-zero amounts)
      if (fixedComponent && !isFreePlan && fixedComponent.amount_cents > 0) {
        // Create a monetary credit that covers 20% of the fixed fee
        const creditAmountCents = Math.floor(fixedComponent.amount_cents * 0.2);

        const monetaryCreditDefinition = await createTestUsageCreditDefinition({
          merchantId: merchant.id,
          planId: plan.id,
          priceId: planPrice.id,
          priceComponentId: fixedComponent.component_id,
          creditAmount: creditAmountCents,
          refillAmount: creditAmountCents, // Same amount renews each billing cycle
          name: `${plan.planName} Welcome Credit`,
          description: `Welcome credit of $${(creditAmountCents / 100).toFixed(2)} towards ${fixedComponent.label}`,
          expiryDays: 90,
          renewOnBilling: true, // Renewable credit
          billingVisible: true,
          currency: planPrice.currency,
          applicationType: "monetary",
        });

        creditDefinitions.push({
          id: monetaryCreditDefinition.id,
          name: monetaryCreditDefinition.name,
          merchantId: merchant.id,
          planId: plan.id,
        });

        success(
          `Created monetary credit definition: ${monetaryCreditDefinition.name} ($${(creditAmountCents / 100).toFixed(2)})`
        );
      }
    }
  }

  info("Creating customer...");

  // Create a single customer
  const timestamp = Date.now();
  const customer = await createTestCustomer({
    merchantId: merchant.id,
    name: "Full Test Customer",
    email: `full-customer-${timestamp}@example.com`,
    phoneNumber: `+49 30 ${Math.floor(1000000 + Math.random() * 9000000)}`,
    externalCustomerId: `full_customer_${timestamp}`,
    billingAddressLine1: "Kurfürstendamm 123",
    billingAddressLine2: "Floor 4",
    billingCity: "Berlin",
    billingStateProvince: "Berlin",
    billingPostalCode: "10117",
    billingCountry: "Germany",
    taxId: `DE${Math.floor(100000000 + Math.random() * 900000000)}`,
    taxExempt: false,
    preferredLanguage: "en",
    timezone: "Europe/Berlin",
    preferredCurrency: "EUR",
    metadata: {
      customerType: "test",
      industry: "technology",
      signupSource: "full-generation",
    },
  });
  success(`Created customer: ${customer.name} (${customer.email})`);

  return {
    user,
    organization,
    merchant,
    plans,
    prices,
    customer,
    pricingTable,
    apiKeys: [secretKey, publishableKey],
    metric: {
      id: apiCallsMetric.id,
      name: apiCallsMetric.name,
      merchantId: merchant.id,
    },
    creditDefinitions,
  };
}

/**
 * Show summary of generated data
 */
function showSummary(entities: GeneratedEntities) {
  info("\n✅ Full data generation complete!");
  console.log("\n" + colors.bold("Generated Entities:"));

  success(`User: ${entities.user.email}`);
  success(`Organization: ${entities.organization.name}`);
  success(
    `Merchant: ${entities.merchant.displayName} (ID: ${entities.merchant.id})`
  );
  success(`Plans: ${entities.plans.length} created`);
  success(`Prices: ${entities.prices.length} created`);
  success(`Customer: ${entities.customer.name} (ID: ${entities.customer.id})`);
  success(`Pricing Table: ${entities.pricingTable.name}`);
  success(`API Keys: ${entities.apiKeys.length} created`);
  success(`Metric: ${entities.metric.name} (ID: ${entities.metric.id})`);
  success(`Credit Definitions: ${entities.creditDefinitions.length} created`);

  console.log("\n" + colors.bold("Login Credentials:"));
  console.log(`Email: ${colors.green(entities.user.email)}`);
  console.log(`Password: ${colors.green(entities.user.password)}`);

  console.log("\n" + colors.bold("API Keys:"));
  entities.apiKeys.forEach((key) => {
    if (key.keyType === "secret") {
      console.log(`${colors.yellow("Secret Key")} (${key.environment}):`);
      console.log(colors.green(key.keyValue));
    } else {
      console.log(`${colors.yellow("Publishable Key")} (${key.environment}):`);
      console.log(colors.green(key.keyValue));
    }
  });

  console.log("\n" + colors.bold("Key IDs for Manual Subscription Creation:"));
  console.log(`Customer ID: ${colors.cyan(entities.customer.id)}`);
  console.log(`Available Plans:`);
  entities.plans.forEach((plan, index) => {
    const planPrices = entities.prices.filter((p) => p.planId === plan.id);
    console.log(
      `  ${index + 1}. ${colors.cyan(plan.planName)} (ID: ${plan.id})`
    );
    planPrices.forEach((price, priceIndex) => {
      const priceLabel = price.pricingData.components[0].label;
      console.log(
        `     Price ${priceIndex + 1}: ${price.currency} - ${priceLabel} (ID: ${price.id})`
      );
    });
  });

  console.log(
    "\n" + colors.yellow("⚠️  Ready for manual subscription creation!")
  );
  console.log(
    colors.gray(
      "Use the Customer ID and Plan/Price IDs above to create subscriptions manually."
    )
  );
}

/**
 * Utility functions for console output
 */
function success(message: string) {
  console.log(`${colors.green("✓")} ${message}`);
}

function error(message: string) {
  console.error(`${colors.red("✗")} ${message}`);
}

function info(message: string) {
  console.log(`${colors.blue("ℹ")} ${message}`);
}

function warning(message: string) {
  console.log(`${colors.yellow("⚠")} ${message}`);
}

/**
 * Main execution
 */
async function main() {
  try {
    const entities = await generateFullData();
    showSummary(entities);
    process.exit(0);
  } catch (err: unknown) {
    if (err instanceof Error) {
      error(`Error generating data: ${err.message}`);
      console.error(err);
    } else {
      error("An unknown error occurred");
      console.error(err);
    }
    process.exit(1);
  }
}

// Run the script
main();
