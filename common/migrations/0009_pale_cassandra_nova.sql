ALTER TABLE "payments" ALTER COLUMN "invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "psp_plan_id" text;--> statement-breakpoint
ALTER TABLE "subscription_details" ADD COLUMN "psp_subscription_id" text;