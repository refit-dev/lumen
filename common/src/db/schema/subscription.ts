import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  varchar,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import { customers } from "./customer";
import { plans } from "./plan";
import { prices } from "./price";
import { subscriptionFeatures } from "./feature";
import { paymentMethods } from "./payment";
import { sql, relations } from "drizzle-orm";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-zod";

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.subscription)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    stableSubscriptionId: text("stable_subscription_id")
      .notNull()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.stableSubscription)),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    versionNumber: integer("version_number").notNull(),
    effectivePriceId: text("effective_price_id")
      .notNull()
      .references(() => prices.id),

    // Reference to the separate override tables
    priceOverrideId: text("price_override_id").references(
      () => subscriptionPriceOverrides.id
    ),
    featureOverrideId: text("feature_override_id").references(
      () => subscriptionFeatureOverrides.id
    ),

    startTimestamp: timestamp("start_timestamp").defaultNow().notNull(),
    endTimestamp: timestamp("end_timestamp"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Index for active subscription lookups by customer and merchant (most common in entitlements API)
    // Order optimized for WHERE merchantId = X AND customerId = Y AND endTimestamp IS NULL
    index("idx_subscriptions_merchant_customer_active")
      .on(table.merchantId, table.customerId)
      .where(sql`${table.endTimestamp} IS NULL`),

    // General lookup for customer subscriptions across merchants
    index("idx_subscriptions_customer_merchant").on(
      table.merchantId,
      table.customerId
    ),

    // For stable subscription ID lookups
    index("idx_subscriptions_stable_id").on(table.stableSubscriptionId),
  ]
);

// Subscription relations
export const subscriptionsRelations = relations(
  subscriptions,
  ({ one, many }) => ({
    customer: one(customers, {
      fields: [subscriptions.customerId],
      references: [customers.id],
    }),
    plan: one(plans, {
      fields: [subscriptions.planId],
      references: [plans.id],
    }),
    price: one(prices, {
      fields: [subscriptions.effectivePriceId],
      references: [prices.id],
    }),
    priceOverride: one(subscriptionPriceOverrides, {
      fields: [subscriptions.priceOverrideId],
      references: [subscriptionPriceOverrides.id],
    }),
    featureOverride: one(subscriptionFeatureOverrides, {
      fields: [subscriptions.featureOverrideId],
      references: [subscriptionFeatureOverrides.id],
    }),
    subscriptionFeatures: many(subscriptionFeatures),
    subscriptionDetails: many(subscriptionDetails),
  })
);

// Price overrides table
export const subscriptionPriceOverrides = pgTable(
  "subscription_price_overrides",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() =>
        createPrefixedId(ID_PREFIXES.subscriptionPriceOverride)
      ),
    ephemeralPriceId: text("ephemeral_price_id")
      .notNull()
      .references(() => prices.id),
    activeFrom: timestamp("active_from").defaultNow().notNull(),
    activeUntil: timestamp("active_until"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  }
);

// Price override relations
export const subscriptionPriceOverridesRelations = relations(
  subscriptionPriceOverrides,
  ({ one }) => ({
    price: one(prices, {
      fields: [subscriptionPriceOverrides.ephemeralPriceId],
      references: [prices.id],
    }),
  })
);

// Feature overrides table
export const subscriptionFeatureOverrides = pgTable(
  "subscription_feature_overrides",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() =>
        createPrefixedId(ID_PREFIXES.subscriptionFeatureOverride)
      ),
    featureIds: text("feature_ids").array().notNull(),
    activeFrom: timestamp("active_from").defaultNow().notNull(),
    activeUntil: timestamp("active_until"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  }
);

export const subscriptionsScheduledChanges = pgTable(
  "subscriptions_scheduled_changes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() =>
        createPrefixedId(ID_PREFIXES.subscriptionScheduledChange)
      ),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    effectiveDate: timestamp("effective_date"),
    effectiveOnNextBilling: boolean("effective_on_next_billing").default(false),
    newPlanId: text("new_plan_id").references(() => plans.id),
    newVersionNumber: text("new_version_number"),
    newPriceId: text("new_price_id").references(() => prices.id),
    // Update to reference both override tables
    newPriceOverrideId: text("new_price_override_id").references(
      () => subscriptionPriceOverrides.id
    ),
    newFeatureOverrideId: text("new_feature_override_id").references(
      () => subscriptionFeatureOverrides.id
    ),
    prorationType: text("proration_type"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  }
);

// Subscription scheduled changes relations
export const subscriptionsScheduledChangesRelations = relations(
  subscriptionsScheduledChanges,
  ({ one }) => ({
    subscription: one(subscriptions, {
      fields: [subscriptionsScheduledChanges.subscriptionId],
      references: [subscriptions.id],
    }),
    newPlan: one(plans, {
      fields: [subscriptionsScheduledChanges.newPlanId],
      references: [plans.id],
    }),
    newPrice: one(prices, {
      fields: [subscriptionsScheduledChanges.newPriceId],
      references: [prices.id],
    }),
  })
);

export const subscriptionChanges = pgTable("subscription_changes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.subscriptionChange)),
  subscriptionId: text("subscription_id")
    .notNull()
    .references(() => subscriptions.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 20 }).notNull(), // create, update, cancel, reactivate
  previousState:
    jsonb("previous_state").$type<Record<string, string | number | boolean>>(),
  newState: jsonb("new_state")
    .$type<Record<string, string | number | boolean>>()
    .notNull(),
  effectiveDate: timestamp("effective_date").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  createdBy: text("created_by"),
});

// Create schemas for validation
export const subscriptionsSelectSchema = createSelectSchema(subscriptions);
export const subscriptionsInsertSchema = createInsertSchema(subscriptions);
export const subscriptionsUpdateSchema = createUpdateSchema(subscriptions);

export const subscriptionPriceOverridesSelectSchema = createSelectSchema(
  subscriptionPriceOverrides
);
export const subscriptionPriceOverridesInsertSchema = createInsertSchema(
  subscriptionPriceOverrides
);

export const subscriptionFeatureOverridesSelectSchema = createSelectSchema(
  subscriptionFeatureOverrides
);
export const subscriptionFeatureOverridesInsertSchema = createInsertSchema(
  subscriptionFeatureOverrides
);

// Subscription details table for billing cycle information
export const subscriptionDetails = pgTable(
  "subscription_details",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.subscriptionDetail)),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    componentId: text("component_id").notNull(),
    nextBillingDate: timestamp("next_billing_date").notNull(),
    subscriptionStartDate: timestamp("subscription_start_date").notNull(),
    previousBillingDate: timestamp("previous_billing_date"),
    cyclesBilled: integer("cycles_billed").notNull().default(0),
    paymentMethodId: text("payment_method_id").references(
      () => paymentMethods.id
    ),
    recurrenceRule: text("recurrence_rule"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Index for finding subscriptions due for billing
    index("idx_subscription_details_next_billing").on(table.nextBillingDate),
    // Index for subscription lookups
    index("idx_subscription_details_subscription").on(table.subscriptionId),
    // New composite index to ensure uniqueness of subscription + component
    unique("uniq_subscription_details_subscription_component").on(
      table.subscriptionId,
      table.componentId
    ),
  ]
);
// Subscription details relations
export const subscriptionDetailsRelations = relations(
  subscriptionDetails,
  ({ one }) => ({
    subscription: one(subscriptions, {
      fields: [subscriptionDetails.subscriptionId],
      references: [subscriptions.id],
    }),
    paymentMethod: one(paymentMethods, {
      fields: [subscriptionDetails.paymentMethodId],
      references: [paymentMethods.id],
    }),
  })
);

// Create schemas for validation
export const subscriptionDetailsSelectSchema =
  createSelectSchema(subscriptionDetails);
export const subscriptionDetailsInsertSchema =
  createInsertSchema(subscriptionDetails);
export const subscriptionDetailsUpdateSchema =
  createUpdateSchema(subscriptionDetails);
