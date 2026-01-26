import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { merchants } from "./merchants";
import { customers } from "./customer";
import { features } from "./feature";
import { prices } from "./price";
import { plans } from "./plan";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";

// Credit Grant Sources
export const creditGrantSources = [
  "subscription",
  "promotion",
  "manual",
  "refill",
  "topup",
] as const;

// Top-up Expiry Behavior
export const topupExpiryBehaviors = [
  "billing_cycle",
  "custom_days",
  "never",
] as const;
export type TopupExpiryBehavior = (typeof topupExpiryBehaviors)[number];
export type CreditGrantSource = (typeof creditGrantSources)[number];

// Credit Application Types
export const creditApplicationTypes = ["usage", "monetary"] as const;
export type CreditApplicationType = (typeof creditApplicationTypes)[number];

// Credit Scopes
export const creditScopes = ["plan", "merchant"] as const;
export type CreditScope = (typeof creditScopes)[number];

// Credit Grant Status
export const creditGrantStatuses = [
  "ACTIVE",
  "DEPLETED",
  "EXPIRED",
  "REVOKED",
] as const;
export type CreditGrantStatus = (typeof creditGrantStatuses)[number];

// Credit Definitions - templates for creating credit grants with enhanced flexibility
export const creditDefinitions = pgTable(
  "credit_definitions",
  {
    id: text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.creditDefinition)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),

    // SCOPE CONFIGURATION
    scope: text("scope", { enum: creditScopes }).notNull(), // 'plan' or 'merchant'
    planId: text("plan_id").references(() => plans.id), // Required if scope = 'plan'

    // APPLICATION TYPE CONFIGURATION
    applicationType: text("application_type", {
      enum: creditApplicationTypes,
    }).notNull(),

    // TARGET LINKAGE (conditional based on applicationType)
    // Required for 'usage' type if using with entitlement checks
    featureId: text("feature_id").references(() => features.id),
    featureSlug: text("feature_slug"), // Denormalized for performance
    priceId: text("price_id").references(() => prices.id), // Required for 'monetary'
    // Required for 'usage' type for billing. When 'monetary' credits, then ONLY this component's
    // price can be reduced with credits.
    priceComponentId: text("price_component_id"),

    // BILLING BEHAVIOR
    billingVisible: boolean("billing_visible").default(false), // Show credits on invoices?
    billingDescription: text("billing_description"), // Invoice line item description

    // MONETARY CONFIGURATION
    currency: text("currency"), // Required for monetary/component/account types

    // AMOUNT CONFIGURATION
    defaultAmount: integer("default_amount").notNull(), // Interpretation depends on applicationType
    refillAmount: integer("refill_amount"), // Amount for periodic refills

    // RENEWAL CONFIGURATION
    expiryDays: integer("expiry_days"), // Days until credit expires
    refillRrule: text("refill_rrule"), // RRULE for scheduled renewals
    renewOnBilling: boolean("renew_on_billing").default(false), // Renew directly after invoice generation
    lastRenewalDate: timestamp("last_renewal_date"), // Track renewal timing

    // PRIORITIZATION
    priority: integer("priority").default(100), // Lower = higher priority

    // STATUS
    isActive: boolean("is_active").default(true), // Enable/disable definition

    // METADATA
    name: text("name").notNull(),
    description: text("description"),

    // TOP-UP CONFIGURATION
    enableTopups: boolean("enable_topups").default(false),
    topupPricePerCreditCents: integer("topup_price_per_credit_cents"),
    topupMinQuantity: integer("topup_min_quantity").default(1),
    topupMaxQuantity: integer("topup_max_quantity"),
    topupExpiryBehavior: text("topup_expiry_behavior", {
      enum: topupExpiryBehaviors,
    }).default("billing_cycle"),
    topupCustomExpiryDays: integer("topup_custom_expiry_days"),

    // TIMESTAMPS
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Index for merchant + scope lookups
    index("idx_credit_definitions_merchant_scope")
      .on(table.merchantId, table.scope, table.isActive)
      .where(sql`${table.deletedAt} IS NULL`),

    // Index for plan-scoped definitions
    index("idx_credit_definitions_plan")
      .on(table.planId, table.isActive)
      .where(sql`${table.deletedAt} IS NULL AND ${table.scope} = 'plan'`),

    // Index for application type filtering
    index("idx_credit_definitions_application_type")
      .on(table.applicationType, table.merchantId)
      .where(sql`${table.deletedAt} IS NULL`),

    // Index for top-up enabled credit definitions
    index("idx_credit_definitions_topups")
      .on(table.planId, table.enableTopups, table.isActive)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.enableTopups} = true`
      ),
  ]
);

// Credit Grants - actual credits given to customers with inherited configuration
export const creditGrants = pgTable(
  "credit_grants",
  {
    id: text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.creditGrant)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    creditDefinitionId: text("credit_definition_id")
      .references(() => creditDefinitions.id)
      .notNull(),

    // INHERITED CONFIGURATION (denormalized for performance)
    applicationType: text("application_type", {
      enum: creditApplicationTypes,
    }).notNull(),
    featureId: text("feature_id").references(() => features.id),
    featureSlug: text("feature_slug"),
    scope: text("scope", { enum: creditScopes }).notNull(), // 'plan' or 'merchant'
    planId: text("plan_id").references(() => plans.id), // For plan-level credits
    priceId: text("price_id").references(() => prices.id), // For component/monetary credits
    priceComponentId: text("price_component_id"), // For component credits
    currency: text("currency"), // For monetary credits
    billingVisible: boolean("billing_visible").default(false),

    // AMOUNT TRACKING
    initialAmount: integer("initial_amount").notNull(), // Original grant amount
    remainingAmount: integer("remaining_amount").notNull(), // Current remaining amount

    // TIMING
    startDate: timestamp("start_date").notNull(), // When credits become available
    expiryDate: timestamp("expiry_date"), // When credits expire

    // RENEWAL SCHEDULING (new fields for grant-centric renewals)
    nextRenewalDate: timestamp("next_renewal_date"), // When this grant should be renewed
    lastRenewalDate: timestamp("last_renewal_date"), // When this grant was last renewed
    renewalRrule: text("renewal_rrule"), // RRULE for this grant's renewal schedule (denormalized from definition)

    // STATUS AND PRIORITY
    status: text("status", { enum: creditGrantStatuses })
      .default("ACTIVE")
      .notNull(),
    priority: integer("priority").default(100), // Consumption priority

    // TRACKING
    source: text("source", { enum: creditGrantSources }).notNull(),
    referenceCode: text("reference_code"),
    notes: text("notes"),

    // TIMESTAMPS
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Index for customer active credit lookups
    index("idx_credit_grants_customer_active")
      .on(table.customerId, table.status, table.applicationType)
      .where(sql`${table.deletedAt} IS NULL`),

    // Index for usage credits by feature
    index("idx_credit_grants_feature")
      .on(table.featureId, table.customerId, table.status)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.applicationType} = 'usage'`
      ),

    // Index for usage credits by feature slug (optimized for entitlement checks)
    index("idx_credit_grants_feature_slug_entitlements")
      .on(table.merchantId, table.customerId, table.featureSlug, table.status)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.applicationType} = 'usage'`
      ),

    // Index for component credits
    index("idx_credit_grants_component")
      .on(table.priceId, table.priceComponentId, table.status)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.applicationType} = 'component'`
      ),

    // Index for expiry management
    index("idx_credit_grants_expiry")
      .on(table.expiryDate, table.status)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.expiryDate} IS NOT NULL`
      ),

    // NEW: Index for grant-centric renewal processing (most important new index)
    index("idx_credit_grants_renewal_due")
      .on(table.nextRenewalDate, table.status)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.nextRenewalDate} IS NOT NULL`
      ),

    // Index for merchant queries
    index("idx_credit_grants_merchant")
      .on(table.merchantId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),

    // Index for credit definition lookups
    index("idx_credit_grants_definition").on(
      table.creditDefinitionId,
      table.status
    ),

    // Index for priority-based consumption
    index("idx_credit_grants_priority")
      .on(table.customerId, table.priority, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
  ]
);

// Credit Usage Transactions - detailed tracking of credit usage across all types
export const creditUsageTransactions = pgTable(
  "credit_usage_transactions",
  {
    id: text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.creditUsageTransaction)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),

    // Link to grant that was used
    creditGrantId: text("credit_grant_id")
      .notNull()
      .references(() => creditGrants.id),

    // USAGE DETAILS
    amount: integer("amount").notNull(), // Amount used in this transaction
    applicationType: text("application_type", {
      enum: creditApplicationTypes,
    }).notNull(),

    // EVENT LINKAGE
    eventId: text("event_id"), // Optional link to event that triggered usage
    eventName: text("event_name").notNull(), // Name of the event that caused this usage (e.g., 'billing', 'api_call')
    eventTimestamp: timestamp("event_timestamp").notNull(), // When the event occurred

    // TARGET LINKAGE (optional, depends on credit type)
    featureId: text("feature_id"), // For usage credits
    featureSlug: text("feature_slug"), // For usage credits
    priceId: text("price_id"), // For component/monetary credits
    priceComponentId: text("price_component_id"), // For component credits

    // BILLING CONTEXT (for monetary credits)
    invoiceId: text("invoice_id"), // Link to invoice if this was used during billing
    billingSessionId: text("billing_session_id"), // Links all transactions in one billing cycle
    currency: text("currency"), // For monetary credit transactions

    // TIMESTAMPS
    transactionDate: timestamp("transaction_date").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Index for customer usage history
    index("idx_credit_usage_customer_date").on(
      table.customerId,
      table.transactionDate
    ),

    // Index for invoice-related transactions
    index("idx_credit_usage_invoice")
      .on(table.invoiceId)
      .where(sql`${table.invoiceId} IS NOT NULL`),

    // Index for grant usage tracking
    index("idx_credit_usage_grant").on(
      table.creditGrantId,
      table.transactionDate
    ),

    // Index for event-based lookups
    index("idx_credit_usage_event")
      .on(table.eventId, table.eventTimestamp)
      .where(sql`${table.eventId} IS NOT NULL`),

    // Index for merchant analytics
    index("idx_credit_usage_merchant").on(
      table.merchantId,
      table.transactionDate
    ),

    // Index for billing session lookups
    index("idx_credit_usage_billing_session")
      .on(table.billingSessionId)
      .where(sql`${table.billingSessionId} IS NOT NULL`),
  ]
);

// Relations
export const creditDefinitionsRelations = relations(
  creditDefinitions,
  ({ many, one }) => ({
    creditGrants: many(creditGrants),
    merchant: one(merchants, {
      fields: [creditDefinitions.merchantId],
      references: [merchants.id],
    }),
    plan: one(plans, {
      fields: [creditDefinitions.planId],
      references: [plans.id],
    }),
    feature: one(features, {
      fields: [creditDefinitions.featureId],
      references: [features.id],
    }),
    price: one(prices, {
      fields: [creditDefinitions.priceId],
      references: [prices.id],
    }),
  })
);

export const creditGrantsRelations = relations(
  creditGrants,
  ({ one, many }) => ({
    creditDefinition: one(creditDefinitions, {
      fields: [creditGrants.creditDefinitionId],
      references: [creditDefinitions.id],
    }),
    merchant: one(merchants, {
      fields: [creditGrants.merchantId],
      references: [merchants.id],
    }),
    customer: one(customers, {
      fields: [creditGrants.customerId],
      references: [customers.id],
    }),
    feature: one(features, {
      fields: [creditGrants.featureId],
      references: [features.id],
    }),
    creditUsageTransactions: many(creditUsageTransactions),
  })
);

export const creditUsageTransactionsRelations = relations(
  creditUsageTransactions,
  ({ one }) => ({
    creditGrant: one(creditGrants, {
      fields: [creditUsageTransactions.creditGrantId],
      references: [creditGrants.id],
    }),
    merchant: one(merchants, {
      fields: [creditUsageTransactions.merchantId],
      references: [merchants.id],
    }),
    customer: one(customers, {
      fields: [creditUsageTransactions.customerId],
      references: [customers.id],
    }),
    feature: one(features, {
      fields: [creditUsageTransactions.featureId],
      references: [features.id],
    }),
  })
);

export const creditDefinitionsInsertSchema =
  createInsertSchema(creditDefinitions);
export const creditDefinitionsSelectSchema =
  createSelectSchema(creditDefinitions);
export const creditDefinitionsUpdateSchema =
  createUpdateSchema(creditDefinitions);
