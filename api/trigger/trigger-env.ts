import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Minimal environment schema for Trigger.dev jobs
 * Only includes the variables actually needed by trigger jobs
 */
export const triggerEnv = createEnv({
  server: {
    // Core variables needed by trigger jobs
    API_URL: z.string().url(),
    TRIGGER_API_ACCESS_KEY: z.string(),
    INTERNAL_API_KEY: z.string(),
    NODE_ENV: z.enum(["development", "test", "staging", "production"]),
    CRON_PATTERN: z.string().default("0 * * * *"),
    RESEND_API_KEY: z.string().optional(),
    SLACK_WEBHOOK: z.string().optional(),
    IS_TRIGGER_ENV: z.coerce.boolean().default(false),
  },
  clientPrefix: "",
  client: {},
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
