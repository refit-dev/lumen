CREATE TABLE "dodo" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"secret_key" jsonb,
	"webhook_secret" jsonb,
	"environment" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "is_trial_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "trial_parent_plan_id" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "trial_days" integer;--> statement-breakpoint
ALTER TABLE "dodo" ADD CONSTRAINT "dodo_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_trial_parent_plan_id_plans_id_fk" FOREIGN KEY ("trial_parent_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;