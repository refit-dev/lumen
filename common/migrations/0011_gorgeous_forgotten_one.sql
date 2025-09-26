CREATE TYPE "public"."dunning_action" AS ENUM('pause_subscription', 'cancel_subscription', 'mark_as_unpaid');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'trialing', 'past_due', 'paused', 'unpaid', 'canceled');--> statement-breakpoint
CREATE TABLE "payment_retries" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "dunning_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"plan_id" text,
	"grace_period_days" integer DEFAULT 7 NOT NULL,
	"retry_schedule" jsonb DEFAULT '[1,3,7]'::jsonb,
	"end_of_dunning_action" "dunning_action" DEFAULT 'pause_subscription' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "status" "subscription_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "grace_period_ends_at" timestamp;--> statement-breakpoint
-- Backfill subscription statuses based on whether the subscription has ended
UPDATE "subscriptions" SET "status" = 'canceled' WHERE "end_timestamp" IS NOT NULL;--> statement-breakpoint
UPDATE "subscriptions" SET "status" = 'active' WHERE "end_timestamp" IS NULL;--> statement-breakpoint
ALTER TABLE "payment_retries" ADD CONSTRAINT "payment_retries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_retries" ADD CONSTRAINT "payment_retries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_configs" ADD CONSTRAINT "dunning_configs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_configs" ADD CONSTRAINT "dunning_configs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_payment_retries_payment" ON "payment_retries" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "idx_payment_retries_invoice" ON "payment_retries" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_dunning_configs_merchant_plan" ON "dunning_configs" USING btree ("merchant_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_dunning_configs_merchant_default" ON "dunning_configs" USING btree ("merchant_id") WHERE "dunning_configs"."plan_id" is null;--> statement-breakpoint
CREATE INDEX "idx_subscriptions_status_grace_period" ON "subscriptions" USING btree ("status","grace_period_ends_at");