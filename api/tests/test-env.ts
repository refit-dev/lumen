import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Re-export the main environment for tests to use non-test-specific vars
export { env as baseEnv } from "../src/env";

// Define and export environment variables specific to tests
export const testEnv = createEnv({
  server: {
    TEST_STRIPE_CUSTOMER_ID: z.string(),
    TEST_STRIPE_PAYMENT_METHOD_ID: z.string(),
    TEST_STRIPE_SECRET_KEY: z.string(),
    TEST_DODO_SECRET_KEY: z.string(),
    TEST_DODO_PAYMENT_ID: z.string(),
    NGROK_AUTHTOKEN: z.string(),
    NGROK_URL: z.string(),
    TEST_STRIPE_PUBLIC_KEY: z.string(),
    TEST_PRETZEL_SECRET_KEY: z.string(),
    TEST_PRETZEL_PUBLIC_KEY: z.string(),
    TEST_STRIPE_WEBHOOK_SECRET: z.string(),
    DEV_PASSWORD: z.string().default("password123!"),
  },
  clientPrefix: "", // No client-side vars specific to tests expected
  client: {},
  runtimeEnv: process.env, // Still read from process.env
  emptyStringAsUndefined: true,
});
