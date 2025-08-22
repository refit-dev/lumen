CREATE TYPE "public"."aggregation_type_enum" AS ENUM('COUNT', 'SUM', 'MAX', 'MIN', 'AVG', 'UNIQUE_COUNT');--> statement-breakpoint
CREATE TYPE "public"."query_type_enum" AS ENUM('simple', 'indexed', 'complex');--> statement-breakpoint
CREATE TYPE "public"."value_type_enum" AS ENUM('NUMERIC', 'STRING');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text NOT NULL,
	"key_type" text NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"permissions" text[] DEFAULT '{"public"}' NOT NULL,
	"key_value" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"last_used_at" timestamp,
	CONSTRAINT "api_keys_key_value_unique" UNIQUE("key_value")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text,
	"email" text,
	"phone_number" text,
	"psp_customer_id" text,
	"external_customer_id" text,
	"billing_address_line1" text,
	"billing_address_line2" text,
	"billing_city" text,
	"billing_state_province" text,
	"billing_postal_code" text,
	"billing_country" text,
	"business_name" text,
	"tax_id" text,
	"tax_exempt" boolean DEFAULT false,
	"tax_exemption_reason" text,
	"tax_exemption_certificate" text,
	"invoice_prefix" varchar(20),
	"preferred_language" text DEFAULT 'en',
	"timezone" text DEFAULT 'UTC',
	"preferred_currency" text DEFAULT 'USD',
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"event_name" varchar(255) NOT NULL,
	"customer_id" text,
	"ext_customer_id" varchar(255),
	"event_timestamp" timestamp NOT NULL,
	"event_value" double precision,
	"event_string" text,
	"properties" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "feature_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"feature_slug" text NOT NULL,
	"metric_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_feature_metric" UNIQUE("merchant_id","feature_id","metric_id")
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"feature_type" text NOT NULL,
	"feature_value" jsonb NOT NULL,
	"is_override_feature" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_features_merchant_slug" UNIQUE("merchant_id","slug")
);
--> statement-breakpoint
CREATE TABLE "plan_features" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"feature_slug" text NOT NULL,
	"feature_value" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "subscription_features" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"feature_slug" text NOT NULL,
	"feature_value" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"type" text,
	"component_id" text,
	"metric_id" text,
	"description" text NOT NULL,
	"quantity" integer,
	"unit_amount_cents" integer,
	"subtotal_cents" integer NOT NULL,
	"tier_details" jsonb,
	"billing_period_start" timestamp,
	"billing_period_end" timestamp,
	"usage_period_start" timestamp,
	"usage_period_end" timestamp,
	"proration_type" text,
	"proration_period_start" timestamp,
	"proration_period_end" timestamp,
	"discount_code" text,
	"discount_type" text,
	"discount_percent" integer,
	"discount_applied_to_components" text[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_invoice_number" varchar(50),
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text,
	"status" text NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"due_date" timestamp,
	"issue_date" timestamp,
	"paid_date" timestamp,
	"billing_period_start" timestamp,
	"billing_period_end" timestamp,
	"pdf_url" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "customer_invoice_counters" (
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"last_invoice_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_invoice_counters_merchant_id_customer_id_pk" PRIMARY KEY("merchant_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text,
	"tax_id" text,
	"website_url" text,
	"support_email" text,
	"billing_email" text,
	"phone_number" text,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"state_province" text,
	"postal_code" text NOT NULL,
	"country" text NOT NULL,
	"default_currency" text DEFAULT 'USD',
	"supported_currencies" text[],
	"timezone" text DEFAULT 'UTC',
	"default_payment_terms" text DEFAULT '30',
	"default_payment_methods" text[] DEFAULT '{"card"}',
	"invoice_prefix" text,
	"invoice_template_id" text,
	"branding_settings" jsonb,
	"notification_preferences" jsonb,
	"feature_flags" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "merchants_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "merchants_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"provider" text NOT NULL,
	"payment_type" text NOT NULL,
	"status" text NOT NULL,
	"verification_status" text,
	"last_used_at" timestamp,
	"last_failed_at" timestamp,
	"failure_reason" text,
	"card_last_four" text,
	"card_brand" text,
	"card_expiry_month" integer,
	"card_expiry_year" integer,
	"card_issuer_country" text,
	"card_network" text,
	"bank_last_four" text,
	"bank_name" text,
	"bank_account_type" text,
	"bank_routing_number" text,
	"bank_account_holder_name" text,
	"bank_account_holder_type" text,
	"bank_currency" text,
	"bank_country" text,
	"paypal_email" text,
	"paypal_payer_id" text,
	"paypal_merchant_id" text,
	"external_psp_payment_method_id" text,
	"external_psp_customer_id" text,
	"external_psp_account_id" text,
	"external_psp_metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"payment_method_id" text,
	"external_payment_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"refunded_amount_cents" integer DEFAULT 0,
	"refund_status" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"external_refund_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"error_message" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"stable_plan_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"plan_name" text NOT NULL,
	"plan_description" text,
	"commit_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"currency" text NOT NULL,
	"pricing_data" jsonb NOT NULL,
	"is_override_price" boolean DEFAULT false NOT NULL,
	"cloned_from_price_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "pricing_table_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"pricing_table_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_popular" boolean DEFAULT false,
	"popular_text" text,
	"button_text" text DEFAULT 'Choose Plan',
	"button_outline" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_pricing_table_plans_table_plan" UNIQUE("pricing_table_id","plan_id")
);
--> statement-breakpoint
CREATE TABLE "pricing_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"heading" text,
	"subheading" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_pricing_tables_slug_merchant" UNIQUE("slug","merchant_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"type" varchar(20) NOT NULL,
	"previous_state" jsonb,
	"new_state" jsonb NOT NULL,
	"effective_date" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "subscription_details" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"component_id" text NOT NULL,
	"next_billing_date" timestamp NOT NULL,
	"subscription_start_date" timestamp NOT NULL,
	"previous_billing_date" timestamp,
	"cycles_billed" integer DEFAULT 0 NOT NULL,
	"payment_method_id" text,
	"recurrence_rule" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	"deleted_at" timestamp,
	CONSTRAINT "uniq_subscription_details_subscription_component" UNIQUE("subscription_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_feature_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"feature_ids" text[] NOT NULL,
	"active_from" timestamp DEFAULT now() NOT NULL,
	"active_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_price_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"ephemeral_price_id" text NOT NULL,
	"active_from" timestamp DEFAULT now() NOT NULL,
	"active_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"stable_subscription_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"effective_price_id" text NOT NULL,
	"price_override_id" text,
	"feature_override_id" text,
	"start_timestamp" timestamp DEFAULT now() NOT NULL,
	"end_timestamp" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "subscriptions_scheduled_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"effective_date" timestamp,
	"effective_on_next_billing" boolean DEFAULT false,
	"new_plan_id" text,
	"new_version_number" text,
	"new_price_id" text,
	"new_price_override_id" text,
	"new_feature_override_id" text,
	"proration_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"query_type" "query_type_enum" DEFAULT 'simple' NOT NULL,
	"aggregation_type" "aggregation_type_enum",
	"event_name" varchar(255) DEFAULT '',
	"value_type" "value_type_enum",
	"sql_definition" text DEFAULT '',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "stripe" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"public_key" text,
	"secret_key" text,
	"webhook_secret" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_metrics" ADD CONSTRAINT "feature_metrics_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_metrics" ADD CONSTRAINT "feature_metrics_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_metrics" ADD CONSTRAINT "feature_metrics_metric_id_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_features" ADD CONSTRAINT "subscription_features_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_features" ADD CONSTRAINT "subscription_features_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_features" ADD CONSTRAINT "subscription_features_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_features" ADD CONSTRAINT "subscription_features_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_metric_id_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metrics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_counters" ADD CONSTRAINT "customer_invoice_counters_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_counters" ADD CONSTRAINT "customer_invoice_counters_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_table_plans" ADD CONSTRAINT "pricing_table_plans_pricing_table_id_pricing_tables_id_fk" FOREIGN KEY ("pricing_table_id") REFERENCES "public"."pricing_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_table_plans" ADD CONSTRAINT "pricing_table_plans_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_table_plans" ADD CONSTRAINT "pricing_table_plans_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_tables" ADD CONSTRAINT "pricing_tables_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_details" ADD CONSTRAINT "subscription_details_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_details" ADD CONSTRAINT "subscription_details_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_price_overrides" ADD CONSTRAINT "subscription_price_overrides_ephemeral_price_id_prices_id_fk" FOREIGN KEY ("ephemeral_price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_effective_price_id_prices_id_fk" FOREIGN KEY ("effective_price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_price_override_id_subscription_price_overrides_id_fk" FOREIGN KEY ("price_override_id") REFERENCES "public"."subscription_price_overrides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_feature_override_id_subscription_feature_overrides_id_fk" FOREIGN KEY ("feature_override_id") REFERENCES "public"."subscription_feature_overrides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions_scheduled_changes" ADD CONSTRAINT "subscriptions_scheduled_changes_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions_scheduled_changes" ADD CONSTRAINT "subscriptions_scheduled_changes_new_plan_id_plans_id_fk" FOREIGN KEY ("new_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions_scheduled_changes" ADD CONSTRAINT "subscriptions_scheduled_changes_new_price_id_prices_id_fk" FOREIGN KEY ("new_price_id") REFERENCES "public"."prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions_scheduled_changes" ADD CONSTRAINT "subscriptions_scheduled_changes_new_price_override_id_subscription_price_overrides_id_fk" FOREIGN KEY ("new_price_override_id") REFERENCES "public"."subscription_price_overrides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions_scheduled_changes" ADD CONSTRAINT "subscriptions_scheduled_changes_new_feature_override_id_subscription_feature_overrides_id_fk" FOREIGN KEY ("new_feature_override_id") REFERENCES "public"."subscription_feature_overrides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe" ADD CONSTRAINT "stripe_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_merchant_idempotency_idx" ON "events" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "events_merchant_event_name_idx" ON "events" USING btree ("merchant_id","event_name");--> statement-breakpoint
CREATE INDEX "events_customer_idx" ON "events" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "events_timestamp_idx" ON "events" USING btree ("event_timestamp");--> statement-breakpoint
CREATE INDEX "idx_feature_metrics_merchant_feature_active" ON "feature_metrics" USING btree ("merchant_id","feature_id") WHERE "feature_metrics"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_feature_metrics_merchant_slug_active" ON "feature_metrics" USING btree ("merchant_id","feature_slug") WHERE "feature_metrics"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_feature_metrics_feature_active" ON "feature_metrics" USING btree ("feature_id") WHERE "feature_metrics"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_feature_metrics_metric_active" ON "feature_metrics" USING btree ("metric_id") WHERE "feature_metrics"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_feature_metrics_merchant_feature" ON "feature_metrics" USING btree ("merchant_id","feature_id");--> statement-breakpoint
CREATE INDEX "idx_feature_metrics_feature" ON "feature_metrics" USING btree ("feature_id");--> statement-breakpoint
CREATE INDEX "idx_feature_metrics_metric" ON "feature_metrics" USING btree ("metric_id");--> statement-breakpoint
CREATE INDEX "idx_features_merchant_slug" ON "features" USING btree ("merchant_id","slug");--> statement-breakpoint
CREATE INDEX "idx_features_slug_lower" ON "features" USING btree (LOWER("slug"));--> statement-breakpoint
CREATE INDEX "idx_features_merchant_type" ON "features" USING btree ("merchant_id","feature_type");--> statement-breakpoint
CREATE INDEX "idx_features_merchant_active" ON "features" USING btree ("merchant_id") WHERE "features"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_subscription_features_merchant_customer" ON "subscription_features" USING btree ("merchant_id","customer_id") WHERE "subscription_features"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_subscription_features_merchant_customer_feature" ON "subscription_features" USING btree ("merchant_id","customer_id","feature_slug") WHERE "subscription_features"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_subscription_features_merchant_customer_feature_id" ON "subscription_features" USING btree ("merchant_id","customer_id","feature_id") WHERE "subscription_features"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_subscription_features_sub_id_slug" ON "subscription_features" USING btree ("subscription_id","feature_slug");--> statement-breakpoint
CREATE INDEX "idx_subscription_features_sub_id_feature_id" ON "subscription_features" USING btree ("subscription_id","feature_id");--> statement-breakpoint
CREATE INDEX "idx_subscription_features_subscription_id" ON "subscription_features" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_table_plans_table_plan_active" ON "pricing_table_plans" USING btree ("pricing_table_id","plan_id") WHERE "pricing_table_plans"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_pricing_tables_slug_merchant_active" ON "pricing_tables" USING btree ("slug","merchant_id") WHERE "pricing_tables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_subscription_details_next_billing" ON "subscription_details" USING btree ("next_billing_date");--> statement-breakpoint
CREATE INDEX "idx_subscription_details_subscription" ON "subscription_details" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_merchant_customer_active" ON "subscriptions" USING btree ("merchant_id","customer_id") WHERE "subscriptions"."end_timestamp" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_subscriptions_customer_merchant" ON "subscriptions" USING btree ("merchant_id","customer_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_stable_id" ON "subscriptions" USING btree ("stable_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_metrics_merchant_id_active" ON "metrics" USING btree ("merchant_id","id") WHERE "metrics"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_metrics_merchant_active" ON "metrics" USING btree ("merchant_id") WHERE "metrics"."deleted_at" IS NULL;