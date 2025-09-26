import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { customers } from "./customer";
import { invoices } from "./invoice";
import { merchants } from "./merchants";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { relations } from "drizzle-orm";

export const paymentMethods = pgTable("payment_methods", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.paymentMethod)),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id),
  provider: text("provider").notNull(),
  paymentType: text("payment_type").notNull(),
  status: text("status").notNull(), // 'active', 'pending', 'failed', 'expired', etc.
  verificationStatus: text("verification_status"),
  lastUsedAt: timestamp("last_used_at"),
  lastFailedAt: timestamp("last_failed_at"),
  failureReason: text("failure_reason"),

  // Card-specific fields
  cardLastFour: text("card_last_four"),
  cardBrand: text("card_brand"),
  cardExpiryMonth: integer("card_expiry_month"),
  cardExpiryYear: integer("card_expiry_year"),
  cardIssuerCountry: text("card_issuer_country"),
  cardNetwork: text("card_network"),

  // Bank account specific fields
  bankLastFour: text("bank_last_four"),
  bankName: text("bank_name"),
  bankAccountType: text("bank_account_type"),
  bankRoutingNumber: text("bank_routing_number"),
  bankAccountHolderName: text("bank_account_holder_name"),
  bankAccountHolderType: text("bank_account_holder_type"),
  bankCurrency: text("bank_currency"),
  bankCountry: text("bank_country"),

  // PayPal specific fields
  paypalEmail: text("paypal_email"),
  paypalPayerId: text("paypal_payer_id"),
  paypalMerchantId: text("paypal_merchant_id"),

  // PSP-specific metadata
  externalPspPaymentMethodId: text("external_psp_payment_method_id"),
  externalPspCustomerId: text("external_psp_customer_id"),
  externalPspAccountId: text("external_psp_account_id"),
  externalPspMetadata: jsonb("external_psp_metadata").$type<
    Record<string, string | number | boolean>
  >(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const payments = pgTable("payments", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.payment)),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  invoiceId: text("invoice_id").references(() => invoices.id),
  paymentMethodId: text("payment_method_id").references(
    () => paymentMethods.id
  ),
  externalPaymentId: text("external_payment_id"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(), // 'pending', 'succeeded', 'failed'
  errorMessage: text("error_message"),
  refundedAmountCents: integer("refunded_amount_cents").default(0),
  refundStatus: text("refund_status"),
  metadata:
    jsonb("metadata").$type<Record<string, string | number | boolean | any>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const refunds = pgTable("refunds", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.refund)),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  paymentId: text("payment_id")
    .notNull()
    .references(() => payments.id),
  externalRefundId: text("external_refund_id"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  adjustmentInvoiceId: text("adjustment_invoice_id").references(
    () => invoices.id
  ),
  errorMessage: text("error_message"),
  metadata:
    jsonb("metadata").$type<Record<string, string | number | boolean>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Payment retry tracking table - logs each dunning attempt
export const paymentRetries = pgTable(
  "payment_retries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.paymentRetry)),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(), // 'succeeded' or 'failed'
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Index for finding retries by payment/invoice
    index("idx_payment_retries_payment").on(table.paymentId),
    index("idx_payment_retries_invoice").on(table.invoiceId),
  ]
);

// Payment retries relations
export const paymentRetriesRelations = relations(paymentRetries, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentRetries.paymentId],
    references: [payments.id],
  }),
  invoice: one(invoices, {
    fields: [paymentRetries.invoiceId],
    references: [invoices.id],
  }),
}));

export const paymentMethodInsertSchema = createInsertSchema(paymentMethods);

export const paymentMethodInsertSchemaReq = paymentMethodInsertSchema.omit({
  merchantId: true,
});

export const paymentRetriesSelectSchema = createSelectSchema(paymentRetries);
export const paymentRetriesInsertSchema = createInsertSchema(paymentRetries);

// export const paymentServiceProviders = pgTable("payment_service_providers", {
//   id: text("id")
//     .primaryKey()
//     .$defaultFn(() => createPrefixedId("psp_")),
//   merchantId: text("merchant_id")
//     .notNull()
//     .references(() => merchants.id),
//   pspName: text("psp_name").notNull(),
//   displayName: text("display_name"),
//   mode: text("mode").notNull(),
//   status: text("status").notNull(),
//   capabilities: text("capabilities").array(),
//   supportedCurrencies: text("supported_currencies").array(),

//   // PSP-specific configuration
//   providerConfig: jsonb("provider_config")
//     .$type<Record<string, string | number | boolean>>()
//     .notNull(),

//   // Webhook configuration
//   webhookUrl: text("webhook_url"),
//   webhookVersion: text("webhook_version"),
//   webhookEnabled: boolean("webhook_enabled").default(true),

//   // Standard timestamps
//   createdAt: timestamp("created_at").defaultNow().notNull(),
//   updatedAt: timestamp("updated_at").defaultNow().notNull(),
//   deletedAt: timestamp("deleted_at"),
// });

// export const paymentServiceProvidersSelectSchema = createSelectSchema(
//   paymentServiceProviders
// );
// export const paymentServiceProvidersInsertSchema = createInsertSchema(
//   paymentServiceProviders
// );
// export const paymentServiceProvidersUpdateSchema = createUpdateSchema(
//   paymentServiceProviders
// );
