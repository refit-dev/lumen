#!/usr/bin/env bun
/**
 * Data generation script to create test data
 *
 * Creates test data according to templates or custom parameters
 * Run with: bun run api/tests/scripts/generate.ts --help
 *
 * Or: Use the package.json scripts:
 * bun run data:generate:minimal
 * bun run data:generate:medium
 * bun run data:generate:large
 * bun run data:generate:custom -- --merchants 5 --plans 3 --prices 2
 *
 */
import { Command } from "commander";
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
import { createBasicSubscription } from "../test-helpers/data/subscription";
import {
  createTestPricingTable,
  createTestPricingTablePlan,
} from "../test-helpers/data/pricing-table";
import {
  getTemplate,
  templates,
  DataTemplate,
  LargeScaleTemplate,
  getMinimalTemplate,
} from "./generation-templates";
import {
  Merchant,
  PlanSelect,
  PriceSelect,
  Customer,
} from "../test-helpers/types";
import { createApiKey } from "../../src/helpers/api_keys";
import {
  apiKeysSelectSchema,
  pricingTablePlans,
  planFeatures,
} from "@lumen/common/schema";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../src/db/client";
import { merchants } from "@lumen/common/schema";
import { Stripe } from "stripe";
import fs from "fs";

// Define ApiKey type from schema
type ApiKey = z.infer<typeof apiKeysSelectSchema> & { keyValue: string };

/**
 * Type for storing generated entities
 */
interface GeneratedEntities {
  users: Array<{
    id: string;
    name: string;
    email: string;
    password: string;
  }>;
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
  }>;
  merchants: Merchant[];
  plans: PlanSelect[];
  prices: PriceSelect[];
  customers: Customer[];
  subscriptions: Array<{
    id: string;
    customerId: string;
    planId: string;
    priceId: string;
  }>;
  pricingTables: Array<{
    id: string;
    name: string;
    slug: string;
    merchantId: string;
  }>;
  pricingTablePlans: Array<{
    id: string;
    pricingTableId: string;
    planId: string;
    displayOrder: number;
  }>;
  apiKeys: ApiKey[];
  metrics: Array<{
    id: string;
    name: string;
    merchantId: string;
  }>;
  creditDefinitions: Array<{
    id: string;
    name: string;
    merchantId: string;
    planId: string;
  }>;
}

// Setup the command line interface
const program = new Command();

program
  .name("lumen-generator")
  .description("Generate test data for Lumen")
  .version("1.0.0");

// Template command
program
  .command("template")
  .description("Generate data using a predefined template")
  .argument("<n>", "Template name (minimal, medium, large-scale)")
  .option("-v, --verbose", "Display verbose output", false)
  .option("--no-summary", "Hide summary output")
  .option("--customers <count>", "Number of customers per merchant", "3")
  .action(async (templateName, options) => {
    try {
      // Get the requested template
      const template = getTemplate(templateName);

      // Parse customer count
      const customersPerMerchant = parseInt(options.customers, 10) || 3;

      // Show generation start info
      info(`Generating data using ${templateName} template`);
      info(template.description);
      info(
        `Creating ${customersPerMerchant} customers per merchant (one subscription per customer)`
      );

      // Track created entities
      const entities: GeneratedEntities = {
        users: [],
        organizations: [],
        merchants: [],
        plans: [],
        prices: [],
        customers: [],
        subscriptions: [],
        pricingTables: [],
        pricingTablePlans: [],
        apiKeys: [],
        metrics: [],
        creditDefinitions: [],
      };

      // Handle based on template type
      if (template.name === "large-scale") {
        await generateLargeScaleData(
          template as LargeScaleTemplate,
          entities,
          customersPerMerchant
        );
      } else {
        await generateStandardData(
          template as DataTemplate,
          entities,
          options.verbose,
          customersPerMerchant
        );
      }

      // Show summary if requested
      if (options.summary) {
        showSummary(entities);
      }
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
  });

// Custom generation command
program
  .command("custom")
  .description("Generate custom test data based on specified parameters")
  .option("-m, --merchants <count>", "Number of merchants to create", "1")
  .option("-p, --plans <count>", "Number of plans per merchant", "1")
  .option("-r, --prices <count>", "Number of prices per plan", "1")
  .option("-c, --customers <count>", "Number of customers per merchant", "3")
  .option("-v, --verbose", "Display verbose output", false)
  .option("--no-summary", "Hide summary output")
  .action(async (options) => {
    try {
      // Parse counts
      const merchantCount = parseInt(options.merchants, 10);
      const plansPerMerchant = parseInt(options.plans, 10);
      const pricesPerPlan = parseInt(options.prices, 10);
      const customersPerMerchant = parseInt(options.customers, 10);

      // Show generation start info
      info(
        `Generating custom data with ${merchantCount} merchants, ${plansPerMerchant} plans per merchant, ${pricesPerPlan} prices per plan`
      );
      info(
        `Creating ${customersPerMerchant} customers per merchant (one subscription per customer)`
      );

      // Track created entities
      const entities: GeneratedEntities = {
        users: [],
        organizations: [],
        merchants: [],
        plans: [],
        prices: [],
        customers: [],
        subscriptions: [],
        pricingTables: [],
        pricingTablePlans: [],
        apiKeys: [],
        metrics: [],
        creditDefinitions: [],
      };

      // Create base template from minimal
      const template = getMinimalTemplate();

      info(
        `Creating ${merchantCount} merchants with ${plansPerMerchant} plans each and ${pricesPerPlan} prices per plan`
      );

      info(
        `Each merchant will have a single pricing table containing all its plans`
      );

      // Create requested number of merchants with strict one-to-one relationships
      for (let i = 0; i < merchantCount; i++) {
        const merchantNumber = i + 1;
        progress(i + 1, merchantCount, "merchants");
        const merchantName = `${template.merchant.displayName} ${merchantNumber}`;

        // Create a separate user for each merchant
        const merchantUser = await createTestUser({
          ...template.user,
          name: `${template.user.name} Merchant ${merchantNumber}`,
          email: `merchant-${merchantNumber}-${Date.now()}@example.com`,
        });
        entities.users.push(merchantUser);
        success(
          `Created merchant user: ${merchantUser.email}`,
          options.verbose
        );

        // Create a separate organization for each merchant
        const merchantOrgName = `${template.organization.name} ${merchantNumber}`;
        const merchantOrg = await createTestOrganization({
          ...template.organization,
          name: merchantOrgName,
          slug: `${template.organization.slug}-${merchantNumber}`,
          userId: merchantUser.id,
          email: merchantUser.email,
          password: merchantUser.password,
        });
        entities.organizations.push(merchantOrg);
        success(
          `Created merchant organization: ${merchantOrg.name}`,
          options.verbose
        );

        const merchant = await createTestMerchant({
          ...template.merchant,
          displayName: merchantName,
          legalName: `${template.merchant.legalName} ${merchantNumber}`,
          organizationId: merchantOrg.id,
          userId: merchantUser.id,
        });
        fs.writeFileSync("/tmp/test_merchant_id.txt", merchant.id);
        entities.merchants.push(merchant);
        success(`Created merchant: ${merchant.displayName}`, options.verbose);

        // Create API Keys for this merchant
        const secretKey = await createApiKey({
          merchantId: merchant.id,
          name: `Live Secret Key ${merchantNumber}`,
          keyType: "secret",
        });
        entities.apiKeys.push(secretKey);
        success(
          `Created secret API key for ${merchant.displayName}`,
          options.verbose
        );

        const publishableKey = await createApiKey({
          merchantId: merchant.id,
          name: `Live Publishable Key ${merchantNumber}`,
          keyType: "publishable",
        });
        entities.apiKeys.push(publishableKey);
        success(
          `Created publishable API key for ${merchant.displayName}`,
          options.verbose
        );

        // Create Stripe API Keys and create webhook
        const stripeSecretKey = process.env.TEST_STRIPE_SECRET_KEY;
        const stripePublicKey = process.env.TEST_STRIPE_PUBLIC_KEY;

        if (stripeSecretKey && stripePublicKey) {
          try {
            // First, fetch merchant data from Stripe (simulating UI onboarding)
            const stripeClient = new Stripe(stripeSecretKey, {
              apiVersion: "2025-02-24.acacia",
            });

            // Get the account data
            const account = await stripeClient.accounts.retrieve();

            // Update merchant with Stripe data (similar to UI onboarding flow)
            await db
              .update(merchants)
              .set({
                defaultCurrency:
                  account.default_currency?.toUpperCase() || "USD",
                websiteUrl:
                  account.business_profile?.url || merchant.websiteUrl,
              })
              .where(eq(merchants.id, merchant.id))
              .returning();

            // Save Stripe integration with webhook secret
            await createTestStripe({
              merchantId: merchant.id,
              secretKey: stripeSecretKey,
              publicKey: stripePublicKey,
              webhookSecret: "whsec_test_1234567890",
            });

            success(`Created Stripe API keys with webhook`, options.verbose);
          } catch (error) {
            console.error("Error setting up Stripe integration:", error);

            // Fallback to simple creation without webhook if it fails
            await createTestStripe({
              merchantId: merchant.id,
              secretKey: stripeSecretKey,
              publicKey: stripePublicKey,
            });
            success(
              `Created Stripe API keys (without webhook)`,
              options.verbose
            );
          }
        }

        // Create plans for this merchant
        const merchantPlans: PlanSelect[] = [];
        const merchantPrices: PriceSelect[] = [];

        for (let j = 0; j < plansPerMerchant; j++) {
          const planNumber = j + 1;
          const planName = `Plan ${planNumber}`;

          // Define feature definitions for this plan
          const featureDefinitions = [
            {
              // Dynamic slug since this is custom generation with variable counts
              slug: `custom-${merchant.id}-users-plan${planNumber}`,
              displayName: "Users",
              featureValue: 5 + j * 5,
            },
            {
              slug: `custom-${merchant.id}-storage-plan${planNumber}`,
              displayName: "Storage",
              featureValue: `${(j + 1) * 10}GB`,
            },
            {
              slug: `custom-${merchant.id}-premium-plan${planNumber}`,
              displayName: "Premium",
              featureValue: j >= 1,
            },
          ];

          // Create the plan with features using the junction table approach
          const { plan } = await createTestPlanWithFeatures(
            merchant.id,
            featureDefinitions,
            {
              planName,
              planDescription: `Description for ${planName}`,
            }
          );

          entities.plans.push(plan);
          merchantPlans.push(plan);
          success(`Created plan: ${plan.planName}`, options.verbose);

          // Create prices for this plan
          for (let k = 0; k < pricesPerPlan; k++) {
            // Define a simple pricing structure for custom generation
            const isMonthly = k % 2 === 0;
            const priceData = {
              dsl_version: 1,
              components: [
                {
                  type: "fixed" as const,
                  component_name: `${isMonthly ? "monthly" : "yearly"}_custom_fee_plan${planNumber}`,
                  label: `${isMonthly ? "Monthly" : "Annual"} Custom Fee`,
                  amount_cents: isMonthly ? 1999 : 19990,
                  bill_immediately: true,
                  recurrence_rule: isMonthly
                    ? "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1"
                    : "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
                },
              ],
            };

            const price = await createTestPrice({
              currency: k % 2 === 0 ? "USD" : "EUR",
              pricingData: priceData,
              planId: plan.id,
              merchantId: merchant.id,
            });

            entities.prices.push(price);
            merchantPrices.push(price);
            verbose(
              `Created price: ${price.currency} (${priceData.components[0].label})`,
              options.verbose
            );
          }
        }

        // Create a pricing table with all the plans
        if (merchantPlans.length > 0) {
          // Create a pricing table with all plans for this merchant
          const pricingTable = await createTestPricingTable({
            merchantId: merchant.id,
            name: "Pricing Plans",
            slug: `pricing-${merchantNumber}`,
            heading: "Choose the Plan that Works for You",
            subheading:
              "All plans include a 14-day free trial. No credit card needed. Cancel anytime.",
            isActive: true,
            // Add all plans directly during creation
            planIds: merchantPlans.map((plan) => plan.id),
            planConfigs: merchantPlans.map((plan, index) => {
              // Configure display options based on plan index and count
              const isBudgetPlan = index === 0;
              const isPremiumPlan = index === merchantPlans.length - 1;
              const isMiddlePlan =
                index > 0 && index < merchantPlans.length - 1;

              return {
                planId: plan.id,
                displayOrder: index + 1,
                isPopular:
                  merchantPlans.length >= 3 ? isMiddlePlan : index === 0,
                popularText:
                  merchantPlans.length >= 3
                    ? isMiddlePlan
                      ? "Most Popular"
                      : undefined
                    : "Best Value",
                buttonText: isBudgetPlan
                  ? "Pay Now"
                  : isPremiumPlan
                    ? "Pay Now 2"
                    : "Pay Now Diff Text",
                buttonOutline: isPremiumPlan,
              };
            }),
          });

          entities.pricingTables.push(pricingTable);
          success(
            `Created pricing table with ${merchantPlans.length} plans for merchant ${merchantNumber}`,
            options.verbose
          );

          // Store all pricing table plan associations for tracking
          const pricingTablePlanAssociations =
            await db.query.pricingTablePlans.findMany({
              where: and(
                eq(pricingTablePlans.merchantId, merchant.id),
                isNull(pricingTablePlans.deletedAt)
              ),
            });

          entities.pricingTablePlans.push(...pricingTablePlanAssociations);
        } else {
          console.warn(
            `Warning: No plans available to create pricing tables for merchant ${merchantNumber}`
          );
        }

        // Create customers for this merchant
        for (let c = 0; c < customersPerMerchant; c++) {
          progress(c + 1, customersPerMerchant, "customers");

          const customer = await generateCustomer(
            merchant.id,
            c + 1,
            options.verbose
          );

          entities.customers.push(customer);
          success(`Created customer: ${customer.email}`, options.verbose);

          // Create one subscription for this customer
          // Choose a plan and price based on the customer number to distribute them evenly
          const planIndex = c % merchantPlans.length;
          const plan = merchantPlans[planIndex];

          // Pick a price for this plan (cycle through available prices for this plan)
          const planPrices = merchantPrices.filter((p) => p.planId === plan.id);
          const priceIndex = c % planPrices.length;
          const price = planPrices[priceIndex];

          if (plan && price) {
            const subscription = await createBasicSubscription(
              merchant.id,
              customer.id,
              plan.id,
              price.id
            );

            entities.subscriptions.push({
              id: subscription.id,
              customerId: customer.id,
              planId: plan.id,
              priceId: price.id,
            });

            // Extract label for logging
            const priceLabel =
              price.pricingData?.components?.[0]?.label ?? "Unknown Price";
            success(
              `Created subscription for ${customer.email} to ${plan.planName} (${priceLabel})`, // Updated log
              options.verbose
            );
          }
        }
      }

      // Show summary if requested
      if (options.summary) {
        showSummary(entities);
      }
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
  });

// List available templates
program
  .command("list")
  .description("List available templates")
  .action(() => {
    console.log(`\n${colors.bold("Available Templates:")}\n`);

    for (const [name, templateFn] of Object.entries(templates)) {
      const template = templateFn();
      console.log(`${colors.green(name)}: ${template.description}`);
    }

    console.log(
      `\nRun ${colors.cyan("bun run api/tests/scripts/generate.ts template <n>")} to use a template\n`
    );
  });

// Parse command line arguments
program.parse();

/**
 * Generate data using a standard template
 */
async function generateStandardData(
  template: DataTemplate,
  entities: GeneratedEntities,
  isVerbose: boolean,
  customersPerMerchant: number = 3
) {
  // Create user
  const user = await createTestUser(template.user);
  entities.users.push(user);
  success(`Created user: ${user.email} ${user.password}`, isVerbose);

  // Create organization
  const org = await createTestOrganization({
    ...template.organization,
    userId: user.id,
    email: user.email,
    password: user.password,
  });
  entities.organizations.push(org);
  success(`Created organization: ${org.name}`, isVerbose);

  // Create merchant using the same user and organization
  const merchant = await createTestMerchant({
    ...template.merchant,
    organizationId: org.id,
    userId: user.id,
  });
  fs.writeFileSync("/tmp/test_merchant_id.txt", merchant.id);
  entities.merchants.push(merchant);
  success(`Created merchant: ${merchant.displayName}`, isVerbose);

  // Create API Keys for this merchant
  const secretKey = await createApiKey({
    merchantId: merchant.id,
    name: "Test Secret Key",
    keyType: "secret",
  });
  entities.apiKeys.push(secretKey);
  success(`Created secret API key for ${merchant.displayName}`, isVerbose);

  const publishableKey = await createApiKey({
    merchantId: merchant.id,
    name: "Test Publishable Key",
    keyType: "publishable",
  });
  entities.apiKeys.push(publishableKey);
  success(`Created publishable API key for ${merchant.displayName}`, isVerbose);

  // Create Stripe API Keys and create webhook
  const stripeSecretKey = process.env.TEST_STRIPE_SECRET_KEY;
  const stripePublicKey = process.env.TEST_STRIPE_PUBLIC_KEY;

  if (stripeSecretKey && stripePublicKey) {
    try {
      // First, fetch merchant data from Stripe (simulating UI onboarding)
      const stripeClient = new Stripe(stripeSecretKey, {
        apiVersion: "2025-02-24.acacia",
      });

      // Get the account data
      const account = await stripeClient.accounts.retrieve();

      // Update merchant with Stripe data (similar to UI onboarding flow)
      await db
        .update(merchants)
        .set({
          defaultCurrency: account.default_currency?.toUpperCase() || "USD",
          websiteUrl: account.business_profile?.url || merchant.websiteUrl,
        })
        .where(eq(merchants.id, merchant.id))
        .returning();

      // Save Stripe integration with webhook secret
      await createTestStripe({
        merchantId: merchant.id,
        secretKey: stripeSecretKey,
        publicKey: stripePublicKey,
        webhookSecret: "whsec_test_1234567890",
      });

      success(`Created Stripe API keys with webhook`, isVerbose);
    } catch (error) {
      console.error("Error setting up Stripe integration:", error);

      // Fallback to simple creation without webhook if it fails
      await createTestStripe({
        merchantId: merchant.id,
        secretKey: stripeSecretKey,
        publicKey: stripePublicKey,
      });
      success(`Created Stripe API keys (without webhook)`, isVerbose);
    }
  }

  // Create API calls metric for usage-based billing and credit grants
  const apiCallsMetric = await createTestMetric({
    merchantId: merchant.id,
    name: "API Calls",
    description: "Count of API calls made by customers",
    aggregationType: "COUNT",
    eventName: "api.call",
    valueType: "NUMERIC",
  });
  entities.metrics.push({
    id: apiCallsMetric.id,
    name: apiCallsMetric.name,
    merchantId: merchant.id,
  });
  success(`Created API calls metric: ${apiCallsMetric.name}`, isVerbose);

  // Create plans and prices
  const merchantPlans: PlanSelect[] = [];
  const merchantPrices: PriceSelect[] = [];

  for (const planTemplate of template.plans) {
    const { prices: priceTemplates, features, ...planData } = planTemplate;

    // Create plan with features using the junction table approach
    const { plan } = await createTestPlanWithFeatures(
      merchant.id,
      features,
      planData
    );

    entities.plans.push(plan);
    merchantPlans.push(plan);
    success(`Created plan: ${plan.planName}`, isVerbose);

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

      entities.prices.push(price);
      merchantPrices.push(price);
      const priceLabel = price.pricingData.components[0].label;
      verbose(`Created price: ${price.currency} (${priceLabel})`, isVerbose);
    }
  }

  // Create a single pricing table with all available plans
  if (merchantPlans.length > 0) {
    // Create a pricing table with all plans
    const allPlans = merchantPlans;

    const pricingTable = await createTestPricingTable({
      merchantId: merchant.id,
      name: "Pricing Plans",
      slug: "pricing-standard",
      heading: "Choose the Plan that Works for You",
      subheading:
        "All plans include a 14-day free trial. No credit card needed. Cancel anytime.",
      isActive: true,
      // Add all plans directly during creation
      planIds: allPlans.map((plan) => plan.id),
      planConfigs: allPlans.map((plan, index) => {
        const planName = plan.planName.toLowerCase();

        // Configure display options based on plan name
        const isStarterPlan = planName.includes("starter") || index === 0;
        const isPlusPlan =
          planName.includes("plus") || (allPlans.length >= 2 && index === 1);
        const isProPlan =
          planName.includes("pro") || index === allPlans.length - 1;

        return {
          planId: plan.id,
          displayOrder: index + 1,
          isPopular: isPlusPlan, // Make the middle/plus plan popular
          popularText: isPlusPlan ? "Most Popular" : undefined,
          buttonText: isStarterPlan
            ? "Pay Now"
            : isProPlan
              ? "Pay Now 3"
              : "Pay Now Diff Text",
          buttonOutline: isProPlan, // Outline the pro plan button
        };
      }),
    });

    entities.pricingTables.push(pricingTable);
    success(`Created pricing table with ${allPlans.length} plans`, isVerbose);

    // Store all pricing table plan associations for tracking
    const pricingTablePlanAssociations =
      await db.query.pricingTablePlans.findMany({
        where: and(
          eq(pricingTablePlans.merchantId, merchant.id),
          isNull(pricingTablePlans.deletedAt)
        ),
      });

    entities.pricingTablePlans.push(...pricingTablePlanAssociations);
  } else {
    console.warn("Warning: No plans available to create pricing tables with");
  }

  // Create credit definitions for each plan to enable credit grant testing
  for (const plan of merchantPlans) {
    // Find all features for this plan
    const planFeaturesList = await db.query.planFeatures.findMany({
      where: and(
        eq(planFeatures.planId, plan.id),
        isNull(planFeatures.deletedAt)
      ),
      with: {
        feature: true,
      },
    });

    // Find the API calls feature specifically
    console.log(
      `Debug: Plan ${plan.planName} has ${planFeaturesList.length} features:`
    );
    planFeaturesList.forEach((pf, index) => {
      console.log(
        `  ${index + 1}. ${pf.featureSlug} = ${pf.featureValue} (${typeof pf.featureValue})`
      );
    });

    const apiCallsPlanFeature = planFeaturesList.find((pf) =>
      pf.featureSlug.includes("api-calls")
    );

    console.log(
      `Debug: Found API calls feature:`,
      apiCallsPlanFeature?.featureSlug,
      "=",
      apiCallsPlanFeature?.featureValue
    );

    if (apiCallsPlanFeature) {
      // Find the price and usage component for this plan
      const planPrice = merchantPrices.find((p) => p.planId === plan.id);
      if (planPrice) {
        const usageComponent = planPrice.pricingData.components.find(
          (c) => c.type === "usage" && c.metric_id === apiCallsMetric.id
        );

        if (usageComponent) {
          // Create a usage credit definition that grants free API calls
          const featureValue = apiCallsPlanFeature.featureValue;
          const numericValue =
            typeof featureValue === "number"
              ? featureValue
              : parseInt(featureValue as string, 10);

          if (isNaN(numericValue)) {
            console.warn(
              `Skipping credit definition for plan ${plan.planName}: feature value is not numeric (${featureValue})`
            );
            continue;
          }

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
          });

          entities.creditDefinitions.push({
            id: creditDefinition.id,
            name: creditDefinition.name,
            merchantId: merchant.id,
            planId: plan.id,
          });

          success(
            `Created credit definition: ${creditDefinition.name} (${creditAmount} credits)`,
            isVerbose
          );
        }
      }
    }
  }

  // Create customers for this merchant
  for (let c = 0; c < customersPerMerchant; c++) {
    progress(c + 1, customersPerMerchant, "customers");

    const customer = await generateCustomer(merchant.id, c + 1, isVerbose);

    entities.customers.push(customer);
    success(`Created customer: ${customer.email}`, isVerbose);

    // Create one subscription for this customer
    // Choose a plan and price based on the customer number to distribute them evenly
    const planIndex = c % merchantPlans.length;
    const plan = merchantPlans[planIndex];

    // Pick a price for this plan
    const planPrices = merchantPrices.filter((p) => p.planId === plan.id);
    const priceIndex = c % planPrices.length;
    const price = planPrices[priceIndex];

    if (plan && price) {
      const subscription = await createBasicSubscription(
        merchant.id,
        customer.id,
        plan.id,
        price.id
      );

      entities.subscriptions.push({
        id: subscription.id,
        customerId: customer.id,
        planId: plan.id,
        priceId: price.id,
      });

      // Extract label for logging
      const priceLabel =
        price.pricingData?.components?.[0]?.label ?? "Unknown Price";
      success(
        `Created subscription for ${customer.email} to ${plan.planName} (${priceLabel})`, // Updated log
        isVerbose
      );
    }
  }
}

/**
 * Generate data using a large-scale template
 */
async function generateLargeScaleData(
  template: LargeScaleTemplate,
  entities: GeneratedEntities,
  customersPerMerchant: number = 3
) {
  // Track created entities
  const createdUsers: { id: string; email: string; password: string }[] = [];
  const createdOrgs: { id: string }[] = [];
  const createdMerchants: Merchant[] = [];
  const merchantPlansMap: Record<string, PlanSelect[]> = {};
  const merchantPricesMap: Record<string, PriceSelect[]> = {};

  // Calculate how many of each entity to create
  // Since org->merchant is 1:1, we'll adjust the counts
  const {
    users: baseUserCount,
    orgsPerUser,
    plansPerMerchant,
    pricesPerPlan,
  } = template.counts;

  // Adjust counts based on 1:1 relationships
  const userCount = baseUserCount * orgsPerUser; // Each org needs its own user
  const totalOrgs = userCount; // Each user gets one org
  const totalMerchants = totalOrgs; // Each org gets one merchant (1:1)
  const totalPlans = totalMerchants * plansPerMerchant;
  const totalPrices = totalPlans * pricesPerPlan;
  const totalCustomers = totalMerchants * customersPerMerchant;
  const totalSubscriptions = totalCustomers; // One subscription per customer

  // Display generation info
  info(
    `Generating ${userCount} users, ${totalOrgs} organizations, ${totalMerchants} merchants`
  );
  info(`Will create ${totalPlans} plans with ${totalPrices} total prices`);
  info(
    `Will create ${totalCustomers} customers with ${totalSubscriptions} subscriptions (one per customer)`
  );

  // Process all users first
  progress(0, userCount, "users");
  info(`Creating ${userCount} users...`);

  for (let i = 0; i < userCount; i++) {
    progress(i + 1, userCount, "users");
    const userNumber = i + 1;
    const userData = {
      ...template.userTemplate,
      name: `${template.userTemplate.name} ${userNumber}`,
      email: `large-scale-${userNumber}-${Date.now()}@example.com`,
    };

    const user = await createTestUser(userData);
    createdUsers.push(user);
    entities.users.push(user);
  }

  // Create one organization and one merchant per user
  info(`Creating ${totalOrgs} organizations with merchants...`);
  let orgCount = 0;

  for (let i = 0; i < userCount; i++) {
    const user = createdUsers[i];
    progress(++orgCount, totalOrgs, "organizations");

    // Create organization
    const orgData = {
      ...template.organizationTemplate,
      name: `${template.organizationTemplate.name} ${orgCount}`,
      slug: `large-scale-org-${orgCount}-${Date.now()}`,
      userId: user.id,
      email: user.email,
      password: user.password,
    };

    const org = await createTestOrganization(orgData);
    createdOrgs.push(org);
    entities.organizations.push(org);

    // Create exactly one merchant for this organization
    const merchantData = {
      ...template.merchantTemplate,
      displayName: `${template.merchantTemplate.displayName} ${orgCount}`,
      legalName: `${template.merchantTemplate.legalName} ${orgCount}`,
      organizationId: org.id,
      userId: user.id,
    };

    const merchant = await createTestMerchant(merchantData);
    fs.writeFileSync("/tmp/test_merchant_id.txt", merchant.id);
    createdMerchants.push(merchant);
    entities.merchants.push(merchant);

    // Create API Keys for this merchant
    const secretKey = await createApiKey({
      merchantId: merchant.id,
      name: `Test Secret Key ${orgCount}`,
      keyType: "secret",
    });
    entities.apiKeys.push(secretKey);
    success(`Created secret API key for ${merchant.displayName}`, true);

    const publishableKey = await createApiKey({
      merchantId: merchant.id,
      name: `Test Publishable Key ${orgCount}`,
      keyType: "publishable",
    });
    entities.apiKeys.push(publishableKey);
    success(`Created publishable API key for ${merchant.displayName}`, true);

    // Create Stripe API Keys and create webhook
    const stripeSecretKey = process.env.TEST_STRIPE_SECRET_KEY;
    const stripePublicKey = process.env.TEST_STRIPE_PUBLIC_KEY;

    if (stripeSecretKey && stripePublicKey) {
      try {
        // First, fetch merchant data from Stripe (simulating UI onboarding)
        const Stripe = require("stripe");
        const stripeClient = new Stripe(stripeSecretKey, {
          apiVersion: "2025-02-24.acacia",
        });

        // Get the account data
        const account = await stripeClient.accounts.retrieve();

        // Update merchant with Stripe data (similar to UI onboarding flow)
        await db
          .update(merchants)
          .set({
            defaultCurrency: account.default_currency?.toUpperCase() || "USD",
            websiteUrl: account.business_profile?.url || merchant.websiteUrl,
          })
          .where(eq(merchants.id, merchant.id))
          .returning();

        // Save Stripe integration with webhook secret
        await createTestStripe({
          merchantId: merchant.id,
          secretKey: stripeSecretKey,
          publicKey: stripePublicKey,
          webhookSecret: "whsec_test_1234567890",
        });

        success(`Created Stripe API keys with webhook`, true);
      } catch (error) {
        console.error("Error setting up Stripe integration:", error);

        // Fallback to simple creation without webhook if it fails
        await createTestStripe({
          merchantId: merchant.id,
          secretKey: stripeSecretKey,
          publicKey: stripePublicKey,
        });
        success(`Created Stripe API keys (without webhook)`, true);
      }
    }

    // Initialize arrays to track plans and prices for this merchant
    merchantPlansMap[merchant.id] = [] as PlanSelect[];
    merchantPricesMap[merchant.id] = [] as PriceSelect[];

    // Create plans for this merchant
    for (let l = 0; l < plansPerMerchant; l++) {
      const planNumber = l + 1;

      // Get a plan template - cycle through them if there are multiple
      const planTemplateIndex = l % template.planTemplates.length;
      const planTemplate = template.planTemplates[planTemplateIndex];

      // Create plan with features
      const { plan } = await createTestPlanWithFeatures(
        merchant.id,
        planTemplate.features,
        {
          planName: `${planTemplate.planName} ${planNumber}`,
          planDescription: planTemplate.planDescription,
          stablePlanId: `scale-plan-${orgCount}-${l}`,
          versionNumber: 1,
          commitMessage: `Scale test plan created`,
        }
      );

      entities.plans.push(plan);
      merchantPlansMap[merchant.id].push(plan);

      // Create prices for this plan
      for (let m = 0; m < pricesPerPlan; m++) {
        // Get price template - cycle through them if there are multiple
        const priceTemplateIndex = m % template.priceTemplates.length;
        const priceTemplate = template.priceTemplates[priceTemplateIndex];

        const price = await createTestPrice({
          ...priceTemplate,
          pricingData: {
            ...priceTemplate.pricingData,
            components: priceTemplate.pricingData.components.map((c) => ({
              ...c,
              bill_immediately:
                c.bill_immediately !== undefined ? c.bill_immediately : true,
            })),
          },
          planId: plan.id,
          merchantId: merchant.id,
        });

        entities.prices.push(price);
        merchantPricesMap[merchant.id].push(price);
      }
    }

    // Create a single pricing table with all available plans
    if (
      merchantPlansMap[merchant.id] &&
      merchantPlansMap[merchant.id].length > 0
    ) {
      const merchantPlans = merchantPlansMap[merchant.id];

      // Create a unique slug for each merchant's pricing table
      const pricingTableSlug = `pricing-${merchant.id.substring(0, 8)}`;

      const pricingTable = await createTestPricingTable({
        merchantId: merchant.id,
        name: "Pricing Plans",
        slug: pricingTableSlug,
        heading: "Choose the Plan that Works for You",
        subheading:
          "All plans include a 14-day free trial. No credit card needed. Cancel anytime.",
        isActive: true,
        // Add all plans directly during creation
        planIds: merchantPlans.map((plan) => plan.id),
        planConfigs: merchantPlans.map((plan, index) => {
          const planName = plan.planName.toLowerCase();

          // Configure display options based on plan name
          const isBasicPlan = planName.includes("basic") || index === 0;
          const isProPlan =
            planName.includes("pro") ||
            (merchantPlans.length >= 2 && index === 1);
          const isEnterprisePlan =
            planName.includes("enterprise") ||
            index === merchantPlans.length - 1;

          return {
            planId: plan.id,
            displayOrder: index + 1,
            isPopular: isProPlan, // Make the middle/pro plan popular
            popularText: isProPlan ? "Most Popular" : undefined,
            buttonText: isBasicPlan
              ? "Pay Now"
              : isEnterprisePlan
                ? "Pay Now 4"
                : "Pay Now Diff Text",
            buttonOutline: isEnterprisePlan, // Outline the enterprise plan button
          };
        }),
      });

      entities.pricingTables.push(pricingTable);
      verbose(
        `Created pricing table with ${merchantPlans.length} plans for merchant ${merchant.id}`,
        true
      );

      // Store all pricing table plan associations for tracking
      const pricingTablePlanAssociations =
        await db.query.pricingTablePlans.findMany({
          where: and(
            eq(pricingTablePlans.merchantId, merchant.id),
            isNull(pricingTablePlans.deletedAt)
          ),
        });

      entities.pricingTablePlans.push(...pricingTablePlanAssociations);
    } else {
      console.warn(
        `Warning: No plans available to create pricing tables for merchant ${merchant.id}`
      );
    }
  }

  // Create customers and subscriptions for each merchant
  info(`Creating ${totalCustomers} customers with subscriptions...`);
  let customerCount = 0;

  for (let m = 0; m < createdMerchants.length; m++) {
    const merchant = createdMerchants[m];
    const merchantPlans = merchantPlansMap[merchant.id];
    const merchantPrices = merchantPricesMap[merchant.id];

    // Skip if no plans or prices are available
    if (!merchantPlans.length || !merchantPrices.length) continue;

    for (let c = 0; c < customersPerMerchant; c++) {
      progress(++customerCount, totalCustomers, "customers");

      const customer = await generateCustomer(merchant.id, c + 1, true);

      entities.customers.push(customer);

      // Create one subscription for this customer
      // Choose a plan and price based on the customer number to distribute them evenly
      const planIndex = c % merchantPlans.length;
      const plan = merchantPlans[planIndex];

      // Pick a price for this plan
      const planPrices = merchantPrices.filter((p) => p.planId === plan.id);
      const priceIndex = c % planPrices.length;
      const price = planPrices[priceIndex];

      if (plan && price) {
        const subscription = await createBasicSubscription(
          merchant.id,
          customer.id,
          plan.id,
          price.id
        );

        entities.subscriptions.push({
          id: subscription.id,
          customerId: customer.id,
          planId: plan.id,
          priceId: price.id,
        });
      }
    }
  }

  return entities;
}

/**
 * Show summary of created entities
 */
function showSummary(entities: GeneratedEntities) {
  info("\nData generation complete!");
  success(`Created ${entities.users.length} users`);
  success(`Created ${entities.organizations.length} organizations`);
  success(`Created ${entities.merchants.length} merchants`);
  success(`Created ${entities.plans.length} plans`);
  success(`Created ${entities.prices.length} prices`);
  success(`Created ${entities.pricingTables.length} pricing tables`);
  success(
    `Created ${entities.pricingTablePlans.length} pricing table plan associations`
  );
  success(`Created ${entities.customers.length} customers`);
  success(`Created ${entities.subscriptions.length} subscriptions`);
  success(`Created ${entities.apiKeys.length} API keys`);
  success(`Created ${entities.metrics.length} metrics`);
  success(`Created ${entities.creditDefinitions.length} credit definitions`);

  // Provide sample login details for the first user
  if (entities.users.length > 0) {
    const firstUser = entities.users[0];
    info("\nSample Login Credentials:");
    console.log(`Email: ${firstUser.email}`);
    console.log(`Password: ${firstUser.password}`);

    if (entities.merchants.length > 0) {
      const firstMerchant = entities.merchants[0];
      console.log(`\nFirst Merchant ID: ${firstMerchant.id}`);
      console.log(`First Merchant Name: ${firstMerchant.displayName}`);

      // Display API keys for the first merchant
      const merchantKeys = entities.apiKeys.filter(
        (key) => key.merchantId === firstMerchant.id
      );
      if (merchantKeys.length > 0) {
        info("\n🔑 API Keys:");
        merchantKeys.forEach((key) => {
          if (key.keyType === "secret") {
            console.log(
              `\n${colors.yellow("Secret Key")} (${key.environment}):`
            );
            console.log(colors.green(key.keyValue));
          } else {
            console.log(
              `\n${colors.yellow("Publishable Key")} (${key.environment}):`
            );
            console.log(colors.green(key.keyValue));
          }
        });
      }

      if (entities.customers.length > 0) {
        console.log(`\nFirst Customer Email: ${entities.customers[0].email}`);
        console.log(`First Customer ID: ${entities.customers[0].id}`);
      }

      if (entities.subscriptions.length > 0) {
        console.log(`\nFirst Subscription ID: ${entities.subscriptions[0].id}`);
      }

      if (entities.metrics.length > 0) {
        console.log(`\nAPI Calls Metric ID: ${entities.metrics[0].id}`);
      }

      if (entities.creditDefinitions.length > 0) {
        console.log(`\nCredit definitions created for testing credit grants:`);
        entities.creditDefinitions.forEach((def, index) => {
          console.log(`  ${index + 1}. ${def.name} (ID: ${def.id})`);
        });
      }
    }
  }
}
/**
 * Utility functions for console output
 */

function success(message: string, alwaysShow: boolean = true) {
  if (alwaysShow) {
    console.log(`${colors.green("✓")} ${message}`);
  }
}

function error(message: string) {
  console.error(`${colors.red("✗")} ${message}`);
}

function info(message: string) {
  console.log(`${colors.blue("ℹ")} ${message}`);
}

function verbose(message: string, isVerbose: boolean) {
  if (isVerbose) {
    console.log(`${colors.gray("▶")} ${message}`);
  }
}

function progress(current: number, total: number, entity: string) {
  const percentage = Math.floor((current / total) * 100);
  const bar =
    colors.cyan("█").repeat(Math.floor(percentage / 5)) +
    "░".repeat(20 - Math.floor(percentage / 5));
  "░".repeat(20 - Math.floor(percentage / 5));

  process.stdout.write(
    `\r${colors.yellow("⟳")} Creating ${entity}: [${bar}] ${percentage}% (${current}/${total})`
  );

  if (current === total) {
    process.stdout.write("\n");
  }
}

async function generateCustomer(
  merchantId: string,
  customerNumber: number,
  isVerbose: boolean = false
) {
  // Generate a unique timestamp to use in IDs
  const timestamp = Date.now();

  const customer = await createTestCustomer({
    merchantId,
    name: `Test Customer ${customerNumber}`,
    email: `customer-${customerNumber}-${timestamp}@example.com`,
    phoneNumber: `+49 30 ${Math.floor(1000000 + Math.random() * 9000000)}`,
    externalCustomerId: `user_${customerNumber}_${timestamp}`,
    billingAddressLine1: `Kurfürstendamm ${Math.floor(1 + Math.random() * 200)}`,
    billingAddressLine2: `Floor ${Math.floor(1 + Math.random() * 10)}`,
    billingCity: "Berlin",
    billingStateProvince: "Berlin",
    billingPostalCode: `${Math.floor(10000 + Math.random() * 90000)}`,
    billingCountry: "Germany",
    invoicePrefix: "TEST",
    taxId: `DE${Math.floor(100000000 + Math.random() * 900000000)}`,
    taxExempt: Math.random() > 0.9, // 10% chance of being tax exempt
    preferredLanguage: "de",
    timezone: "Europe/Berlin",
    preferredCurrency: "EUR",
    metadata: {
      customerType: Math.random() > 0.7 ? "enterprise" : "standard",
      industry: ["technology", "retail", "healthcare", "finance"][
        Math.floor(Math.random() * 4)
      ],
      signupSource: ["website", "referral", "sales", "partner"][
        Math.floor(Math.random() * 4)
      ],
    },
  });

  verbose(`Created customer: ${customer.name} (${customer.email})`, isVerbose);
  return customer;
}
