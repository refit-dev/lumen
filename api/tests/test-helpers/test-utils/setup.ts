import { createTestUser } from "../data/auth";
import { createTestOrganization } from "../data/organization";
import { createTestMerchant } from "../data/merchant";
import { createTestPlan } from "../data/plan";
import { createTestPrice } from "../data/price";
import {
  MerchantUpdate,
  OrganizationUpdate,
  PlanUpdate,
  PriceUpdate,
  TestUserProps,
} from "../types";
import { db } from "../../../src/db/client";
import { sql } from "drizzle-orm";
import {
  creditUsageTransactions,
  payments,
  invoiceLineItems,
  invoices,
  subscriptionFeatures,
  subscriptionDetails,
  events,
  subscriptionsScheduledChanges,
  subscriptions,
  subscriptionPriceOverrides,
  paymentMethods,
  creditGrants,
  creditDefinitions,
  prices,
  planFeatures,
  features,
  featureMetrics,
  metrics,
  pricingTablePlans,
  pricingTables,
  plans,
  stripe as stripeSchema,
  dodo as dodoSchema,
  customers,
  user,
  organization,
  merchants,
  taxRegistrations,
  usNexusConfig,
  taxRateDefinitions,
  merchantTaxConfig,
  refunds,
} from "@lumen/common/schema";

import dotenv from "dotenv";
import { PriceDSLSchemaCreate } from "@lumen/common/validators";
dotenv.config();

export interface FullTestEnvironmentProps {
  userOptions?: TestUserProps;
  orgOptions?: OrganizationUpdate;
  merchantOptions?: MerchantUpdate;
  planOptions?: PlanUpdate;
  priceOptions?: PriceUpdate;
  createPlan?: boolean;
}
/**
 * Creates a complete test environment with user, organization, merchant, and optionally plan/price
 */
export async function createTestEnvironment(
  options: FullTestEnvironmentProps = {}
) {
  const {
    userOptions = {},
    orgOptions = {},
    merchantOptions = {},
    planOptions = {},
    priceOptions = {},
    createPlan = false,
  } = options;

  // Create test user
  const user = await createTestUser(userOptions);

  // Create organization for the user
  const org = await createTestOrganization({
    ...orgOptions,
    userId: user.id,
    email: user.email,
    password: user.password,
  });

  // Create merchant for the organization
  const merchant = await createTestMerchant({
    ...merchantOptions,
    organizationId: org.id,
    userId: user.id,
  });

  // Optionally create plan and price
  let plan, price;
  if (createPlan) {
    plan = await createTestPlan({
      ...planOptions,
      merchantId: merchant.id,
    });

    price = await createTestPrice({
      planId: plan.id,
      merchantId: merchant.id,
      currency: priceOptions.currency || "USD",
      pricingData: (priceOptions.pricingData as PriceDSLSchemaCreate) || {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            label: "Monthly Fee (USD)",
            amount_cents: 1000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
          },
        ],
      },
      isOverridePrice: priceOptions.isOverridePrice || false,
    });
  }

  // Return all created entities
  return {
    user,
    org,
    merchant,
    ...(createPlan ? { plan, price } : {}),
  };
}

export const cleanupDataFull = async (
  options: { deleteTestSetupData?: boolean } = {}
) => {
  const { deleteTestSetupData = false } = options;
  try {
    // First batch: Clean up usage and transaction records
    await db.execute(sql`
      DELETE FROM ${creditUsageTransactions};
      DELETE FROM ${refunds};
      DELETE FROM ${payments};
      DELETE FROM ${invoiceLineItems};
      DELETE FROM ${invoices};
      DELETE FROM ${subscriptionFeatures};
      DELETE FROM ${subscriptionDetails};
      DELETE FROM ${events};
    `);

    // Second batch: Clean up subscription-related records that reference prices
    await db.execute(sql`
      DELETE FROM ${subscriptionsScheduledChanges};
      DELETE FROM ${subscriptions};
      DELETE FROM ${subscriptionPriceOverrides};
      DELETE FROM ${paymentMethods};
    `);

    // Third batch: Clean up credit records that reference prices
    await db.execute(sql`
      DELETE FROM ${creditGrants};
      DELETE FROM ${creditDefinitions};
    `);

    // Fifth batch: Clean up prices and dependent records
    await db.execute(sql`
      DELETE FROM ${prices};
      DELETE FROM ${planFeatures};
      DELETE FROM ${features};
      DELETE FROM ${featureMetrics};
      DELETE FROM ${metrics};
      DELETE FROM ${pricingTablePlans};
      DELETE FROM ${pricingTables};
      DELETE FROM ${plans};
      DELETE FROM ${customers};
    `);

    // Fourth batch: Clean up tax tables in correct dependency order
    await db.execute(sql`
      DELETE FROM ${taxRegistrations};
      DELETE FROM ${usNexusConfig};
      DELETE FROM ${taxRateDefinitions};
      DELETE FROM ${merchantTaxConfig};
    `);

    // Final batch: Clean up core records
    if (deleteTestSetupData) {
      await db.execute(sql`
        DELETE FROM ${dodoSchema};
        DELETE FROM ${stripeSchema};
        DELETE FROM ${merchants};
        DELETE FROM ${user};
        DELETE FROM ${organization};
      `);
    }
  } catch (error) {
    console.error("Error during cleanup:", error);
    throw error;
  }
};
