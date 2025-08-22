#!/usr/bin/env bun
/**
 * Script to generate a test user with API keys
 * Creates a test user with Stripe publishable keys and API keys
 */

import colors from "ansi-colors";
import {
  createTestUser,
  createTestOrganization,
  createTestMerchant,
  createTestPlanWithPrice,
} from "../test-helpers";
import { getMinimalTemplate } from "./generation-templates";
import { db } from "../../src/db/client";
import {
  stripe,
  apiKeys,
  merchants,
  organization,
  user,
  prices,
  plans,
} from "@lumen/common/schema";
import { eq } from "drizzle-orm";
import { createTestStripe } from "../test-helpers/data/stripe";

const MERCHANT_ID = "11111111-1111-1111-1111-111111111111";
const USER_EMAIL = "test-api-keys@withpretzel.com";
const ORGANIZATION_SLUG = "test-api-keys-org";

async function main() {
  try {
    // Cleanup
    await db.delete(apiKeys).where(eq(apiKeys.merchantId, MERCHANT_ID));
    await db.delete(stripe).where(eq(stripe.merchantId, MERCHANT_ID));
    await db.delete(prices).where(eq(prices.merchantId, MERCHANT_ID));
    await db.delete(plans).where(eq(plans.merchantId, MERCHANT_ID));
    await db.delete(merchants).where(eq(merchants.id, MERCHANT_ID));
    await db
      .delete(organization)
      .where(eq(organization.slug, ORGANIZATION_SLUG));

    await db.delete(user).where(eq(user.email, USER_EMAIL));
    console.log(
      `${colors.green("✓")} Cleaned up existing API keys and Stripe credentials`
    );

    // Get minimal template for base data
    const template = getMinimalTemplate();

    // Create test user with specific email
    const userData = await createTestUser({
      ...template.user,
      name: "Test API Keys User",
      email: USER_EMAIL,
      password: "password123!",
    });
    console.log(`${colors.green("✓")} Created test user: ${userData.email}`);

    // Create organization for the user
    const org = await createTestOrganization({
      ...template.organization,
      name: "Test API Keys Organization",
      slug: ORGANIZATION_SLUG,
      userId: userData.id,
      email: userData.email,
      password: userData.password,
    });
    console.log(`${colors.green("✓")} Created organization: ${org.name}`);

    // Create merchant for the organization
    const merchant = await createTestMerchant({
      id: MERCHANT_ID,
      ...template.merchant,
      displayName: "Test API Keys Merchant",
      legalName: "Test API Keys Merchant Inc",
      organizationId: org.id,
      userId: userData.id,
    });
    console.log(
      `${colors.green("✓")} Created merchant: ${merchant.displayName}`
    );

    const { price } = await createTestPlanWithPrice(
      merchant.id,
      {
        planName: "Test API Keys Plan",
        planDescription: "Test API Keys Plan Description",
      },
      {
        currency: "eur",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "base_fee",
              type: "fixed",
              label: "Base Fee",
              amount_cents: 99,
              recurrence_rule: "RRULE:FREQ=MONTHLY",
              bill_immediately: true,
            },
          ],
        },
      },
      MERCHANT_ID
    );

    await createTestStripe({
      merchantId: merchant.id,
      publicKey: process.env.TEST_STRIPE_PUBLIC_KEY,
      secretKey: process.env.TEST_STRIPE_SECRET_KEY,
      webhookSecret: process.env.TEST_STRIPE_WEBHOOK_SECRET,
    });
    console.log(`${colors.green("✓")} Created Stripe keys for merchant`);

    const apiKeysData = {
      publicKey: "pk_test_pretzel",
      secretKey: "sk_test_pretzel",
    };
    await db.insert(apiKeys).values({
      merchantId: merchant.id,
      name: "Test API Keys",
      keyType: "secret",
      keyValue: apiKeysData.secretKey,
      prefix: "test",
      lastUsedAt: null,
    });

    await db.insert(apiKeys).values({
      merchantId: merchant.id,
      name: "Test API Keys",
      keyType: "publishable",
      keyValue: apiKeysData.publicKey,
      prefix: "test",
      lastUsedAt: null,
    });

    console.log(`${colors.green("✓")} Created API keys for merchant`);

    console.log("\nTest user created successfully!");
    console.log("\nLogin Credentials:");
    console.log(`Email: ${userData.email}`);
    console.log(`Password: ${userData.password}`);
    console.log(`\nMerchant ID: ${merchant.id}`);
    console.log(`\nPrice ID: ${price.id}`);
    console.log(`Organization ID: ${org.id}`);
    console.log("\nAPI Keys:");
    console.log(`Public Key: ${apiKeysData.publicKey}`);
    console.log(`Secret Key: ${apiKeysData.secretKey}`);
    console.log("\nStripe Keys:");
    console.log(`Public Key: ${process.env.TEST_STRIPE_PUBLIC_KEY}`);
    console.log(`Secret Key: ${process.env.TEST_STRIPE_SECRET_KEY}`);
    console.log(`Webhook Secret: ${process.env.TEST_STRIPE_WEBHOOK_SECRET}`);
    process.exit(0);
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`${colors.red("✗")} Error: ${err.message}`);
      console.error(err);
    } else {
      console.error(`${colors.red("✗")} An unknown error occurred`);
      console.error(err);
    }
    process.exit(1);
  }
}

main();
