ALTER TABLE "stripe" ALTER COLUMN "secret_key" SET DATA TYPE jsonb USING "secret_key"::jsonb;
ALTER TABLE "stripe" ALTER COLUMN "webhook_secret" SET DATA TYPE jsonb USING "webhook_secret"::jsonb;
CREATE INDEX "prefix_idx" ON "api_keys" USING btree ("prefix");