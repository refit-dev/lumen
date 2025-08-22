CREATE TABLE "credit_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"scope" text NOT NULL,
	"plan_id" text,
	"application_type" text NOT NULL,
	"feature_id" text,
	"feature_slug" text,
	"price_id" text,
	"price_component_id" text,
	"billing_visible" boolean DEFAULT false,
	"billing_description" text,
	"currency" text,
	"default_amount" integer NOT NULL,
	"refill_amount" integer,
	"expiry_days" integer,
	"refill_rrule" text,
	"renew_on_billing" boolean DEFAULT false,
	"last_renewal_date" timestamp,
	"priority" integer DEFAULT 100,
	"is_active" boolean DEFAULT true,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"credit_definition_id" text NOT NULL,
	"application_type" text NOT NULL,
	"feature_id" text,
	"feature_slug" text,
	"scope" text NOT NULL,
	"plan_id" text,
	"price_id" text,
	"price_component_id" text,
	"currency" text,
	"billing_visible" boolean DEFAULT false,
	"initial_amount" integer NOT NULL,
	"remaining_amount" integer NOT NULL,
	"start_date" timestamp NOT NULL,
	"expiry_date" timestamp,
	"next_renewal_date" timestamp,
	"last_renewal_date" timestamp,
	"renewal_rrule" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"priority" integer DEFAULT 100,
	"source" text NOT NULL,
	"reference_code" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "credit_usage_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"credit_grant_id" text NOT NULL,
	"amount" integer NOT NULL,
	"application_type" text NOT NULL,
	"event_id" text,
	"event_name" text NOT NULL,
	"event_timestamp" timestamp NOT NULL,
	"feature_id" text,
	"feature_slug" text,
	"price_id" text,
	"price_component_id" text,
	"invoice_id" text,
	"billing_session_id" text,
	"currency" text,
	"transaction_date" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD CONSTRAINT "credit_definitions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD CONSTRAINT "credit_definitions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD CONSTRAINT "credit_definitions_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_definitions" ADD CONSTRAINT "credit_definitions_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_credit_definition_id_credit_definitions_id_fk" FOREIGN KEY ("credit_definition_id") REFERENCES "public"."credit_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_usage_transactions" ADD CONSTRAINT "credit_usage_transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_usage_transactions" ADD CONSTRAINT "credit_usage_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_usage_transactions" ADD CONSTRAINT "credit_usage_transactions_credit_grant_id_credit_grants_id_fk" FOREIGN KEY ("credit_grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credit_definitions_merchant_scope" ON "credit_definitions" USING btree ("merchant_id","scope","is_active") WHERE "credit_definitions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_definitions_plan" ON "credit_definitions" USING btree ("plan_id","is_active") WHERE "credit_definitions"."deleted_at" IS NULL AND "credit_definitions"."scope" = 'plan';--> statement-breakpoint
CREATE INDEX "idx_credit_definitions_application_type" ON "credit_definitions" USING btree ("application_type","merchant_id") WHERE "credit_definitions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_grants_customer_active" ON "credit_grants" USING btree ("customer_id","status","application_type") WHERE "credit_grants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_grants_feature" ON "credit_grants" USING btree ("feature_id","customer_id","status") WHERE "credit_grants"."deleted_at" IS NULL AND "credit_grants"."application_type" = 'usage';--> statement-breakpoint
CREATE INDEX "idx_credit_grants_feature_slug_entitlements" ON "credit_grants" USING btree ("merchant_id","customer_id","feature_slug","status") WHERE "credit_grants"."deleted_at" IS NULL AND "credit_grants"."application_type" = 'usage';--> statement-breakpoint
CREATE INDEX "idx_credit_grants_component" ON "credit_grants" USING btree ("price_id","price_component_id","status") WHERE "credit_grants"."deleted_at" IS NULL AND "credit_grants"."application_type" = 'component';--> statement-breakpoint
CREATE INDEX "idx_credit_grants_expiry" ON "credit_grants" USING btree ("expiry_date","status") WHERE "credit_grants"."deleted_at" IS NULL AND "credit_grants"."expiry_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_grants_renewal_due" ON "credit_grants" USING btree ("next_renewal_date","status") WHERE "credit_grants"."deleted_at" IS NULL AND "credit_grants"."next_renewal_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_grants_merchant" ON "credit_grants" USING btree ("merchant_id","status") WHERE "credit_grants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_grants_definition" ON "credit_grants" USING btree ("credit_definition_id","status");--> statement-breakpoint
CREATE INDEX "idx_credit_grants_priority" ON "credit_grants" USING btree ("customer_id","priority","status") WHERE "credit_grants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_usage_customer_date" ON "credit_usage_transactions" USING btree ("customer_id","transaction_date");--> statement-breakpoint
CREATE INDEX "idx_credit_usage_invoice" ON "credit_usage_transactions" USING btree ("invoice_id") WHERE "credit_usage_transactions"."invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_usage_grant" ON "credit_usage_transactions" USING btree ("credit_grant_id","transaction_date");--> statement-breakpoint
CREATE INDEX "idx_credit_usage_event" ON "credit_usage_transactions" USING btree ("event_id","event_timestamp") WHERE "credit_usage_transactions"."event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_credit_usage_merchant" ON "credit_usage_transactions" USING btree ("merchant_id","transaction_date");--> statement-breakpoint
CREATE INDEX "idx_credit_usage_billing_session" ON "credit_usage_transactions" USING btree ("billing_session_id") WHERE "credit_usage_transactions"."billing_session_id" IS NOT NULL;