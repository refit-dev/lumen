ALTER TABLE "credit_definitions" ADD COLUMN "enable_topups" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD COLUMN "topup_price_per_credit_cents" integer;--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD COLUMN "topup_min_quantity" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD COLUMN "topup_max_quantity" integer;--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD COLUMN "topup_expiry_behavior" text DEFAULT 'billing_cycle';--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD COLUMN "topup_custom_expiry_days" integer;--> statement-breakpoint
CREATE INDEX "idx_credit_definitions_topups" ON "credit_definitions" USING btree ("plan_id","enable_topups","is_active") WHERE "credit_definitions"."deleted_at" IS NULL AND "credit_definitions"."enable_topups" = true;