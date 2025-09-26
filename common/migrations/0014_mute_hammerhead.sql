CREATE TABLE "customer_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text,
	"external_org_id" text,
	"billing_customer_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_organization_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "org_role" text;--> statement-breakpoint
ALTER TABLE "customer_organizations" ADD CONSTRAINT "customer_organizations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_organization_id_customer_organizations_id_fk" FOREIGN KEY ("customer_organization_id") REFERENCES "public"."customer_organizations"("id") ON DELETE no action ON UPDATE no action;