CREATE TABLE "merchant_tax_config" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"auto_tax_calculation" boolean DEFAULT false,
	"default_tax_rate" numeric(5, 4),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rate_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tax_rate" numeric(5, 4) NOT NULL,
	"jurisdiction" text,
	"tax_type" text DEFAULT 'manual' NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"registration_number" text NOT NULL,
	"tax_type" text NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "us_nexus_config" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"state" text NOT NULL,
	"has_nexus" boolean DEFAULT false,
	"nexus_type" text,
	"sales_threshold_cents" integer,
	"transaction_threshold" integer,
	"has_offices" boolean DEFAULT false,
	"has_employees" boolean DEFAULT false,
	"has_inventory" boolean DEFAULT false,
	"other_presence" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tax_rate_definition_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tax_calculation_method" text;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "tax_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "subtotal_cents" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_amount_cents" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "effective_tax_rate" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_jurisdiction" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_calculation_method" text;--> statement-breakpoint
ALTER TABLE "merchant_tax_config" ADD CONSTRAINT "merchant_tax_config_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rate_definitions" ADD CONSTRAINT "tax_rate_definitions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_registrations" ADD CONSTRAINT "tax_registrations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "us_nexus_config" ADD CONSTRAINT "us_nexus_config_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tax_rate_definition_id_tax_rate_definitions_id_fk" FOREIGN KEY ("tax_rate_definition_id") REFERENCES "public"."tax_rate_definitions"("id") ON DELETE no action ON UPDATE no action;