import { pgTable, text, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";

export const merchants = pgTable("merchants", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.merchant)),
  userId: text("user_id").notNull().unique(),
  organizationId: text("organization_id").notNull().unique(),

  // Business Information
  legalName: text("legal_name").notNull(),
  displayName: text("display_name"),
  taxId: text("tax_id"),
  websiteUrl: text("website_url"),
  supportEmail: text("support_email"),
  billingEmail: text("billing_email"),
  phoneNumber: text("phone_number"),

  // Address Information
  addressLine1: text("address_line1").notNull(),
  addressLine2: text("address_line2"),
  city: text("city").notNull(),
  stateProvince: text("state_province"),
  postalCode: text("postal_code").notNull(),
  country: text("country").notNull(),

  // Platform Configuration
  defaultCurrency: text("default_currency").default("USD"),
  supportedCurrencies: text("supported_currencies").array(),
  timezone: text("timezone").default("UTC"),
  defaultPaymentTerms: text("default_payment_terms").default("30"),
  defaultPaymentMethods: text("default_payment_methods")
    .array()
    .default(["card"]),

  // Platform Settings
  invoicePrefix: text("invoice_prefix"),
  invoiceTemplateId: text("invoice_template_id"),
  brandingSettings:
    jsonb("branding_settings").$type<
      Record<string, string | number | boolean>
    >(),
  notificationPreferences: jsonb("notification_preferences").$type<
    Record<string, string | number | boolean>
  >(),
  featureFlags:
    jsonb("feature_flags").$type<Record<string, string | number | boolean>>(),

  // Standard Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const merchantsSelectSchema = createSelectSchema(merchants);
export const merchantsInsertSchema = createInsertSchema(merchants);
export const merchantsUpdateSchema = createUpdateSchema(merchants);
export const merchantSelectSchemaAPI = merchantsSelectSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

export const merchantSelectSchemaUI = merchantsSelectSchema
  .omit({
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
    deletedAt: z.string().nullable(),
  });

export type MerchantFromApi = z.infer<typeof merchantSelectSchemaAPI>;
