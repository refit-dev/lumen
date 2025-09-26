ALTER TABLE "invoices" ADD COLUMN "document_type" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "original_invoice_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "cancellation_or_credit_reason" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "adjustment_invoice_id" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_adjustment_invoice_id_invoices_id_fk" FOREIGN KEY ("adjustment_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;