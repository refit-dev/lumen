// bun run scripts/delete-stripe-test-webhooks.ts
// Stripe only allows 16 webhooks per account
// This script takes env var TEST_STRIPE_SECRET_KEY
// checks that it is a test key and deletes all webhooks associated with them

import { Stripe } from "stripe";

const secretKey = process.argv[2] || process.env.TEST_STRIPE_SECRET_KEY;

if (!secretKey) {
  throw new Error("Pass secretKey as argument or set TEST_STRIPE_SECRET_KEY");
}

if (!secretKey.startsWith("sk_test_")) {
  throw new Error("use only test keys");
}

const stripe = new Stripe(secretKey, {
  apiVersion: "2025-02-24.acacia",
});

async function deleteWebhooks() {
  try {
    const webhooks = await stripe.webhookEndpoints.list({
      limit: 100,
    });

    console.log(`Found ${webhooks.data.length} webhooks`);

    for (const webhook of webhooks.data) {
      console.log(`Deleting webhook ${webhook.id}...`);
      await stripe.webhookEndpoints.del(webhook.id);
    }

    console.log("Successfully deleted all webhooks");
  } catch (error) {
    console.error("Error deleting webhooks:", error);
    process.exit(1);
  }
}

deleteWebhooks();
