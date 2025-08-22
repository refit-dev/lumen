import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  decimal,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

// Merchant Tax Configuration Table
export const merchantTaxConfig = pgTable("merchant_tax_config", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.merchantTaxConfig)),
  merchantId: text("merchant_id")
    .references(() => merchants.id)
    .notNull(),
  autoTaxCalculation: boolean("auto_tax_calculation").default(false),
  defaultTaxRate: decimal("default_tax_rate", { precision: 5, scale: 4 }), // For manual mode
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Tax Registrations Table
export const taxRegistrations = pgTable("tax_registrations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.taxRegistration)),
  merchantId: text("merchant_id")
    .references(() => merchants.id)
    .notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  registrationNumber: text("registration_number").notNull(),
  taxType: text("tax_type").notNull(), // VAT, GST, Sales Tax
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// US Nexus Configuration Table
export const usNexusConfig = pgTable("us_nexus_config", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.usNexusConfig)),
  merchantId: text("merchant_id")
    .references(() => merchants.id)
    .notNull(),
  state: text("state").notNull(), // Two-letter state code
  hasNexus: boolean("has_nexus").default(false),
  nexusType: text("nexus_type"), // physical, economic, marketplace
  salesThreshold: integer("sales_threshold_cents"),
  transactionThreshold: integer("transaction_threshold"),
  // Physical presence fields (moved from separate table)
  hasOffices: boolean("has_offices").default(false),
  hasEmployees: boolean("has_employees").default(false),
  hasInventory: boolean("has_inventory").default(false),
  otherPresence: text("other_presence"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Tax Rate Definitions Table - Reusable tax rate templates
export const taxRateDefinitions = pgTable("tax_rate_definitions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.taxRateDefinition)),
  merchantId: text("merchant_id")
    .references(() => merchants.id)
    .notNull(),
  name: text("name").notNull(), // e.g., "Germany VAT 19%", "California Sales Tax"
  description: text("description"), // e.g., "Standard VAT rate for German customers"
  taxRate: decimal("tax_rate", { precision: 5, scale: 4 }).notNull(), // e.g., 0.19 for 19%
  jurisdiction: text("jurisdiction"), // e.g., "DE", "US-CA", optional for organizational purposes
  taxType: text("tax_type").notNull().default("manual"), // "manual", could extend later
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations
export const merchantTaxConfigRelations = relations(
  merchantTaxConfig,
  ({ one, many }) => ({
    merchant: one(merchants, {
      fields: [merchantTaxConfig.merchantId],
      references: [merchants.id],
    }),
    taxRegistrations: many(taxRegistrations),
    taxRateDefinitions: many(taxRateDefinitions),
  })
);

export const taxRegistrationsRelations = relations(
  taxRegistrations,
  ({ one }) => ({
    merchant: one(merchants, {
      fields: [taxRegistrations.merchantId],
      references: [merchants.id],
    }),
    merchantTaxConfig: one(merchantTaxConfig, {
      fields: [taxRegistrations.merchantId],
      references: [merchantTaxConfig.merchantId],
    }),
  })
);

export const usNexusConfigRelations = relations(usNexusConfig, ({ one }) => ({
  merchant: one(merchants, {
    fields: [usNexusConfig.merchantId],
    references: [merchants.id],
  }),
}));

export const taxRateDefinitionsRelations = relations(
  taxRateDefinitions,
  ({ one }) => ({
    merchant: one(merchants, {
      fields: [taxRateDefinitions.merchantId],
      references: [merchants.id],
    }),
    merchantTaxConfig: one(merchantTaxConfig, {
      fields: [taxRateDefinitions.merchantId],
      references: [merchantTaxConfig.merchantId],
    }),
  })
);

// Schemas
export const merchantTaxConfigSelectSchema =
  createSelectSchema(merchantTaxConfig);
export const merchantTaxConfigInsertSchema =
  createInsertSchema(merchantTaxConfig);
export const merchantTaxConfigUpdateSchema =
  createUpdateSchema(merchantTaxConfig);

export const merchantTaxConfigSelectSchemaAPI =
  merchantTaxConfigSelectSchema.extend({
    createdAt: z.string(),
    updatedAt: z.string(),
  });

export const taxRegistrationsSelectSchema =
  createSelectSchema(taxRegistrations);
export const taxRegistrationsInsertSchema =
  createInsertSchema(taxRegistrations);
export const taxRegistrationsUpdateSchema =
  createUpdateSchema(taxRegistrations);

export const taxRegistrationsSelectSchemaAPI =
  taxRegistrationsSelectSchema.extend({
    createdAt: z.string(),
    updatedAt: z.string(),
  });

export const usNexusConfigSelectSchema = createSelectSchema(usNexusConfig);
export const usNexusConfigInsertSchema = createInsertSchema(usNexusConfig);
export const usNexusConfigUpdateSchema = createUpdateSchema(usNexusConfig);

export const usNexusConfigSelectSchemaAPI = usNexusConfigSelectSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Types
export type MerchantTaxConfigFromApi = z.infer<
  typeof merchantTaxConfigSelectSchemaAPI
>;
export type TaxRegistrationFromApi = z.infer<
  typeof taxRegistrationsSelectSchemaAPI
>;
export type UsNexusConfigFromApi = z.infer<typeof usNexusConfigSelectSchemaAPI>;

export const taxRateDefinitionsSelectSchema =
  createSelectSchema(taxRateDefinitions);
export const taxRateDefinitionsInsertSchema =
  createInsertSchema(taxRateDefinitions);
export const taxRateDefinitionsUpdateSchema =
  createUpdateSchema(taxRateDefinitions);

export const taxRateDefinitionsSelectSchemaAPI =
  taxRateDefinitionsSelectSchema.extend({
    createdAt: z.string(),
    updatedAt: z.string(),
  });

export type TaxRateDefinitionFromApi = z.infer<
  typeof taxRateDefinitionsSelectSchemaAPI
>;
