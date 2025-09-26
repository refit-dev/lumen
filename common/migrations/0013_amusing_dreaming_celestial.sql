CREATE TYPE "public"."enrollment_matcher_type" AS ENUM('email', 'domain');--> statement-breakpoint
CREATE TABLE "plan_enrollment_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"matcher_type" "enrollment_matcher_type" NOT NULL,
	"matcher_value" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "plan_enrollment_rules" ADD CONSTRAINT "plan_enrollment_rules_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_enrollment_rules" ADD CONSTRAINT "plan_enrollment_rules_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plan_enroll_rules_merchant_plan_active" ON "plan_enrollment_rules" USING btree ("merchant_id","plan_id") WHERE "plan_enrollment_rules"."deleted_at" IS NULL;