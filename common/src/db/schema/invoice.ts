import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  varchar,
  decimal,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import { customers } from "./customer";
import { subscriptions, subscriptionDetails } from "./subscription";
import { metrics } from "./metrics";
import { payments } from "./payment";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";
import { merchantSelectSchemaAPI } from "./merchants";
import { customerSelectSchemaAPI } from "./customer";

export const invoices = pgTable("invoices", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.invoice)),
  customerInvoiceNumber: varchar("customer_invoice_number", { length: 50 }),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id),
  subscriptionId: text("subscription_id").references(() => subscriptions.id),
  status: text("status").notNull(),
  totalAmountCents: integer("total_amount_cents").notNull(),
  subtotalCents: integer("subtotal_cents"), // Pre-tax amount
  taxAmountCents: integer("tax_amount_cents").default(0),
  effectiveTaxRate: decimal("effective_tax_rate", { precision: 5, scale: 4 }),
  taxJurisdiction: text("tax_jurisdiction"),
  taxCalculationMethod: text("tax_calculation_method"), // auto, manual, exempt
  currency: text("currency").notNull(),
  dueDate: timestamp("due_date"),
  issueDate: timestamp("issue_date"),
  paidDate: timestamp("paid_date"),
  billingPeriodStart: timestamp("billing_period_start"),
  billingPeriodEnd: timestamp("billing_period_end"),
  pdfUrl: varchar("pdf_url", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  notes: text("notes"),
  // Document typing and linkage for cancellations/credit notes
  documentType: text("document_type").default("standard").notNull(), // 'standard' | 'cancellation' | 'credit_note'
  originalInvoiceId: text("original_invoice_id"),
  cancellationOrCreditReason: text("cancellation_or_credit_reason"),
  // no deleted_at column, we will use the status column to check if the invoice is "deleted"
  // in the EU, you can only apply a credit note to an invoice that has been paid
});

export const invoiceRelations = relations(invoices, ({ many, one }) => ({
  lineItems: many(invoiceLineItems),
  merchant: one(merchants, {
    fields: [invoices.merchantId],
    references: [merchants.id],
  }),
  customer: one(customers, {
    fields: [invoices.customerId],
    references: [customers.id],
  }),
  subscription: one(subscriptions, {
    fields: [invoices.subscriptionId],
    references: [subscriptions.id],
  }),
  subscriptionDetails: one(subscriptionDetails, {
    fields: [invoices.subscriptionId],
    references: [subscriptionDetails.subscriptionId],
  }),
  payment: one(payments, {
    fields: [invoices.id],
    references: [payments.invoiceId],
  }),
  originalInvoice: one(invoices, {
    fields: [invoices.originalInvoiceId],
    references: [invoices.id],
  }),
}));

export const invoiceUpdateSchema = createUpdateSchema(invoices);
export const invoiceInsertSchema = createInsertSchema(invoices);
export const invoiceSelectSchema = createSelectSchema(invoices);
export const invoiceSelectSchemaAPI = invoiceSelectSchema.extend({
  createdAt: z.string(),
  dueDate: z.string().nullable(),
  issueDate: z.string().nullable(),
  billingPeriodStart: z.string().nullable(),
  billingPeriodEnd: z.string().nullable(),
  pdfUrl: z.string().nullable(),
});

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.invoiceLineItem)),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  // Updated type to support different component types from price DSL
  type: text("type"), // "fixed", "usage", "per_unit", "discount", "proration", "tax", etc.
  // Component ID from the pricing DSL
  componentId: text("component_id"),
  metricId: text("metric_id").references(() => metrics.id),
  description: text("description").notNull(),
  quantity: integer("quantity"),
  unitAmountCents: integer("unit_amount_cents"),
  subtotalCents: integer("subtotal_cents").notNull(),
  // Currency is at the invoice level, so removed from line item
  tierDetails:
    jsonb("tier_details").$type<Record<string, string | number | boolean>>(),
  taxMetadata: jsonb("tax_metadata").$type<{
    taxAuthority?: string;
    taxType?: string;
    jurisdiction?: string;
    taxRate?: number;
    rateSource?: string;
    exemptionReason?: string;
    reasonCode?: number;
    fullDescription?: string;
  }>(),

  // Structured fields - keeping all as nullable for compatibility with one-time payments
  billingPeriodStart: timestamp("billing_period_start"),
  billingPeriodEnd: timestamp("billing_period_end"),
  usagePeriodStart: timestamp("usage_period_start"),
  usagePeriodEnd: timestamp("usage_period_end"),
  prorationType: text("proration_type"),
  prorationPeriodStart: timestamp("proration_period_start"),
  prorationPeriodEnd: timestamp("proration_period_end"),
  discountCode: text("discount_code"),
  discountType: text("discount_type"),
  discountPercent: integer("discount_percent"),
  discountAppliedToComponents: text("discount_applied_to_components").array(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const invoiceLineItemRelations = relations(
  invoiceLineItems,
  ({ one }) => ({
    invoice: one(invoices, {
      fields: [invoiceLineItems.invoiceId],
      references: [invoices.id],
    }),
  })
);

export const invoiceLineItemInsertSchema = createInsertSchema(invoiceLineItems);
export const invoiceLineItemSelectSchema = createSelectSchema(invoiceLineItems);
export const invoiceWithLineItemsSchema = invoiceSelectSchema.extend({
  lineItems: z.array(invoiceLineItemSelectSchema),
});

export const invoiceLineItemSelectSchemaAPI =
  invoiceLineItemSelectSchema.extend({
    billingPeriodStart: z.string().nullable(),
    billingPeriodEnd: z.string().nullable(),
    usagePeriodStart: z.string().nullable(),
    usagePeriodEnd: z.string().nullable(),
    prorationType: z.string().nullable(),
    prorationPeriodStart: z.string().nullable(),
    prorationPeriodEnd: z.string().nullable(),
    createdAt: z.string(),
  });

export const invoiceWithLineItemsSchemaAPI = invoiceSelectSchemaAPI.extend({
  lineItems: z.array(invoiceLineItemSelectSchemaAPI),
});

export const invoiceWithLineItemsMerchantCustomerSchemaAPI =
  invoiceWithLineItemsSchemaAPI.extend({
    merchant: merchantSelectSchemaAPI,
    customer: customerSelectSchemaAPI,
  });

export const invoiceInsertSchemaReq = invoiceInsertSchema
  .omit({
    merchantId: true,
  })
  .extend({
    issueDate: z.string().optional(),
    dueDate: z.string().optional(),
    subtotalCents: z.number().optional(),
    taxAmountCents: z.number().optional(),
    totalAmountCents: z.number().optional(),
    effectiveTaxRate: z.string().optional(),
    taxJurisdiction: z.string().optional(),
    taxCalculationMethod: z.string().optional(),
    lineItems: z
      .array(
        invoiceLineItemInsertSchema.omit({
          invoiceId: true,
          subtotalCents: true,
        })
      )
      .optional(),
  });

export const invoiceUpdateSchemaReq = invoiceInsertSchema
  .omit({
    merchantId: true,
    totalAmountCents: true,
    customerId: true,
  })
  .extend({
    status: z.string().optional(),
    currency: z.string().optional(),
    issueDate: z.string().optional(),
    dueDate: z.string().optional(),
    lineItems: z
      .array(
        invoiceLineItemInsertSchema.omit({
          invoiceId: true,
          subtotalCents: true,
        })
      )
      .optional(),
    deletedLineItemIds: z.array(z.string()).optional(),
  });
