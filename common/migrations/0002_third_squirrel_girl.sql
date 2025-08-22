ALTER TABLE "pricing_table_plans" ADD COLUMN "is_enterprise_plan" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "pricing_table_plans" ADD COLUMN "enterprise_redirect_url" text;