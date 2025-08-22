import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    // General
    NODE_ENV: z.enum(["development", "test", "staging", "production"]),
    PORT: z.coerce.number(),
    API_URL: z.string().url(),

    // Storage / S3
    STORAGE_REGION: z.string(), // ONLY THIS IS NEEDED FOR AWS S3
    STORAGE_ENDPOINT: z.string().default("http://localhost:9000"), // minio only
    STORAGE_ACCESS_KEY_ID: z.string().default("lumen_minio"), // minio only
    STORAGE_SECRET_ACCESS_KEY: z.string().default("lumen_minio_local"), // minio only
    STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(true), // Only needed for MinIO

    INVOICE_BUCKET: z.string(),
    SSM_PATH: z.string(),
    AWS_REGION: z.string(),

    // Security / Auth
    TRIGGER_API_ACCESS_KEY: z.string().optional(), // Set inside the Trigger.dev dashboard
    TRIGGER_SECRET_KEY: z.string().optional(),
    CORS_ORIGIN: z.string(),
    GOOGLE_CLIENT_ID: z.string(),
    GOOGLE_CLIENT_SECRET: z.string(),
    DEV_SKIP_EMAIL_CHECK: z.coerce.boolean().default(true), // Skip email verification in dev mode by default
    FIELD_ENCRYPTION_KEY: z.string().optional(), // Base64 encoded 256-bit key for field-level encryption

    // Database - Credentials sourced differently based on NODE_ENV
    // In dev/test: use these env vars directly
    // In staging/prod: user/password from Secrets Manager, host/port/name from env (often set by platform like Beanstalk)
    DB_HOST: z.string(),
    DB_PORT: z.coerce.number(),
    DB_NAME: z.string(),
    DB_USER: z.string().optional(), // Optional because it might come from Secrets Manager
    DB_PASSWORD: z.string().optional(), // Optional because it might come from Secrets Manager

    // Redis / Rate limiter
    REDIS_HOST: z.string(),
    REDIS_PORT: z.coerce.number(),
    REDIS_PASSWORD: z.string().optional(), // Password used directly only in dev/test
    REDIS_TLS_ENABLED: z.coerce.boolean().optional(),
    // Redis reconnection settings
    REDIS_RECONNECT_STRATEGY: z.enum(["default", "backoff"]).optional(),
    REDIS_RECONNECT_MAX_RETRIES: z.coerce.number().optional(),
    REDIS_RECONNECT_MAX_DELAY_MS: z.coerce.number().optional(),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(60),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
    RATE_LIMIT_IP_WINDOW_SECONDS: z.coerce.number().default(60),
    RATE_LIMIT_IP_MAX_REQUESTS: z.coerce.number().default(100),

    // Event persistence worker settings
    EVENT_PERSISTENCE_BATCH_SIZE: z.coerce.number().default(100),
    EVENT_PERSISTENCE_FLUSH_INTERVAL_MS: z.coerce.number().default(500),

    // TTL for event idempotency keys
    EVENT_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().default(86400),

    // QuestDB Settings
    QUESTDB_HOST: z.string(),
    QUESTDB_INGEST_PORT: z.coerce.number(), // ILP Port
    QUESTDB_QUERY_PORT: z.coerce.number(), // PGWire Port
    QUESTDB_USER: z.string(),
    QUESTDB_PASSWORD: z.string().optional(), // Only required in dev/test environments

    // Notifications
    SLACK_WEBHOOK: z.string().optional(),

    // Dogfooding create free subscription
    LUMEN_API_KEY: z.string().optional(),
  },
  clientPrefix: "",
  client: {},
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
