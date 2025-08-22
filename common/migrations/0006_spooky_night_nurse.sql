CREATE TABLE "billing_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text,
	"scheduled_at" timestamp NOT NULL,
	"status" text DEFAULT 'pending',
	"apply_credits" boolean DEFAULT true NOT NULL,
	"renew_credits" boolean DEFAULT true NOT NULL,
	"line_items_json" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "billing_tasks" ADD CONSTRAINT "billing_tasks_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_tasks" ADD CONSTRAINT "billing_tasks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_tasks" ADD CONSTRAINT "billing_tasks_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_billing_tasks_pending" ON "billing_tasks" USING btree ("status","scheduled_at");