import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  varchar,
  decimal,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import { taxRateDefinitions } from "./tax";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { relations } from "drizzle-orm";
import { z } from "zod";

export type Customer = z.infer<typeof customersSelectSchema>;

export type CustomerFromApi = z.infer<typeof customerSelectSchemaAPI>;

export const customerOrganizations = pgTable("customer_organizations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.customerOrganization)),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  name: text("name"),
  externalOrgId: text("external_org_id"),
  billingCustomerId: text("billing_customer_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const customerOrganizationsSelectSchema = createSelectSchema(
  customerOrganizations
);
export const customerOrganizationsInsertSchema = createInsertSchema(
  customerOrganizations
);
export const customerOrganizationsUpdateSchema = createUpdateSchema(
  customerOrganizations
);

export const customers = pgTable("customers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.customer)),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  name: text("name"), // For importing data from Stripe, we need to support null names
  email: text("email"),
  phoneNumber: text("phone_number"),
  pspCustomerId: text("psp_customer_id"), // External ID from the PSP (Stripe, etc.)
  externalCustomerId: text("external_customer_id"), // User ID from the platform (e.g. the Supabase user ID in a SaaS app)

  // Address information
  billingAddressLine1: text("billing_address_line1"),
  billingAddressLine2: text("billing_address_line2"),
  billingCity: text("billing_city"),
  billingStateProvince: text("billing_state_province"),
  billingPostalCode: text("billing_postal_code"),
  billingCountry: text("billing_country"),

  // Tax information
  businessName: text("business_name"),
  taxId: text("tax_id"),
  taxExempt: boolean("tax_exempt").default(false),
  taxExemptionReason: text("tax_exemption_reason"), // nonprofit_organization, government_entity, educational_institution, resale, reverse_charge, or custom text
  taxExemptionCertificate: text("tax_exemption_certificate"),
  taxRateDefinitionId: text("tax_rate_definition_id").references(
    () => taxRateDefinitions.id
  ), // Reference to merchant's tax rate definition for manual tax
  taxCalculationMethod: text("tax_calculation_method"), // Override for tax calculation: 'auto', 'manual', or null (use merchant default)

  // Invoice customization
  invoicePrefix: varchar("invoice_prefix", { length: 20 }),

  // Localization preferences
  preferredLanguage: text("preferred_language").default("en"),
  timezone: text("timezone").default("UTC"),
  preferredCurrency: text("preferred_currency").default("USD"),

  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  // Organization support (seats-as-customers)
  customerOrganizationId: text("customer_organization_id").references(
    () => customerOrganizations.id
  ),
  orgRole: text("org_role"), // 'primary' | 'member' | null
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const customersSelectSchema = createSelectSchema(customers);
export const customersInsertSchema = createInsertSchema(customers).extend({
  name: z.string().nonempty("Name cannot be empty"),
});
export const customersUpdateSchema = createUpdateSchema(customers);
export const customerSelectSchemaAPI = customersSelectSchema
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

export const customersInsertSchemaReq = customersInsertSchema
  .omit({
    merchantId: true,
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    email: z.string().email().optional(),
    name: z.string(),
    metadata: z.record(z.unknown()).optional(),
    dangerouslyAllowCustomerWithoutEmail: z.boolean().optional(), // false by default
    dangerouslyAllowSameEmailForDifferentCustomers: z.boolean().optional(), // false by default
  });

export const customersInsertSchemaUI = customersInsertSchema
  .omit({
    merchantId: true,
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    email: z.string().email(),
    name: z.string(),
    metadata: z.record(z.unknown()).optional(),
  });

// Relations
export const customerOrganizationsRelations = relations(
  customerOrganizations,
  ({ many }) => ({
    customers: many(customers),
  })
);

export const customersRelations = relations(customers, ({ one }) => ({
  organization: one(customerOrganizations, {
    fields: [customers.customerOrganizationId],
    references: [customerOrganizations.id],
  }),
}));
