import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { relations, sql } from "drizzle-orm";
import { plans } from "./plan";
import { subscriptions } from "./subscription";
import { customers } from "./customer";
import { metrics } from "./metrics";

export type FeatureType = "boolean" | "number" | "string";

// Main feature table
export const features = pgTable(
  "features",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.feature)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),

    // Feature identity
    slug: text("slug").notNull(), // Machine-readable identifier
    displayName: text("display_name").notNull(),
    description: text("description"),

    // Feature configuration
    featureType: text("feature_type", {
      enum: ["boolean", "number", "string"],
    }).notNull(),
    featureValue: jsonb("feature_value")
      .$type<boolean | number | string>()
      .notNull(), // Default value
    isOverrideFeature: boolean("is_override_feature").default(false),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Primary lookup: Optimize feature lookups by slug and merchant (common in entitlements API)
    index("idx_features_merchant_slug").on(table.merchantId, table.slug),

    // Case-insensitive lookup
    index("idx_features_slug_lower").on(sql`LOWER(${table.slug})`),

    // Add combined index for merchant+type to optimize feature type lookups
    index("idx_features_merchant_type").on(table.merchantId, table.featureType),

    // Composite lookup with merchant for non-deleted features
    index("idx_features_merchant_active")
      .on(table.merchantId)
      .where(sql`${table.deletedAt} IS NULL`),

    // unqiue on merchantId, slug combination
    unique("uniq_features_merchant_slug").on(table.merchantId, table.slug),
  ]
);

// Plan-Features junction table
export const planFeatures = pgTable("plan_features", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.planFeature)),
  planId: text("plan_id")
    .notNull()
    .references(() => plans.id),
  featureId: text("feature_id")
    .notNull()
    .references(() => features.id),
  featureSlug: text("feature_slug").notNull(), // For direct slug-based queries
  featureValue: jsonb("feature_value")
    .$type<boolean | number | string>()
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

// Subscription-Features junction table
export const subscriptionFeatures = pgTable(
  "subscription_features",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.subscriptionFeature)),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id),
    featureSlug: text("feature_slug").notNull(), // For direct slug-based queries
    featureValue: jsonb("feature_value")
      .$type<boolean | number | string>()
      .notNull(),
    source: text("source", { enum: ["plan", "override"] }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"), // should be set when subscription <-> feature map no longer exists
  },
  (table) => [
    // Most common query pattern - direct lookup by merchant + customer
    index("idx_subscription_features_merchant_customer")
      .on(table.merchantId, table.customerId)
      .where(sql`${table.deletedAt} IS NULL`),

    // Optimize for merchant + customer + feature - direct entitlement check
    index("idx_subscription_features_merchant_customer_feature")
      .on(table.merchantId, table.customerId, table.featureSlug)
      .where(sql`${table.deletedAt} IS NULL`),

    // Optimize for merchant + customer + featureId - direct entitlement check
    index("idx_subscription_features_merchant_customer_feature_id")
      .on(table.merchantId, table.customerId, table.featureId)
      .where(sql`${table.deletedAt} IS NULL`),

    //  internal: subscription + featureSlug
    index("idx_subscription_features_sub_id_slug").on(
      table.subscriptionId,
      table.featureSlug
    ),

    //  internal: subscription + featureId
    index("idx_subscription_features_sub_id_feature_id").on(
      table.subscriptionId,
      table.featureId
    ),

    //  internal: subscriptionId
    index("idx_subscription_features_subscription_id").on(table.subscriptionId),
  ]
);

// Feature relations
export const featuresRelations = relations(features, ({ many }) => ({
  planFeatures: many(planFeatures),
  subscriptionFeatures: many(subscriptionFeatures),
  featureMetrics: many(featureMetrics),
}));

// Plan-Feature relations
export const planFeaturesRelations = relations(planFeatures, ({ one }) => ({
  plan: one(plans, {
    fields: [planFeatures.planId],
    references: [plans.id],
  }),
  feature: one(features, {
    fields: [planFeatures.featureId],
    references: [features.id],
  }),
}));

// Subscription-Feature relations
export const subscriptionFeaturesRelations = relations(
  subscriptionFeatures,
  ({ one }) => ({
    subscription: one(subscriptions, {
      fields: [subscriptionFeatures.subscriptionId],
      references: [subscriptions.id],
    }),
    feature: one(features, {
      fields: [subscriptionFeatures.featureId],
      references: [features.id],
    }),
  })
);

// Junction table mapping features to metrics per merchant
export const featureMetrics = pgTable(
  "feature_metrics",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.featureMetric)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    featureSlug: text("feature_slug").notNull(), // For direct slug-based queries
    metricId: text("metric_id")
      .notNull()
      .references(() => metrics.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Unique constraint on all records (required for data integrity)
    unique("uniq_feature_metric").on(
      table.merchantId,
      table.featureId,
      table.metricId
    ),

    // Most common query pattern: lookup by merchant + feature for active records
    index("idx_feature_metrics_merchant_feature_active")
      .on(table.merchantId, table.featureId)
      .where(sql`${table.deletedAt} IS NULL`),

    // Add index for merchant + feature slug lookups
    index("idx_feature_metrics_merchant_slug_active")
      .on(table.merchantId, table.featureSlug)
      .where(sql`${table.deletedAt} IS NULL`),

    // Secondary lookups
    index("idx_feature_metrics_feature_active")
      .on(table.featureId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("idx_feature_metrics_metric_active")
      .on(table.metricId)
      .where(sql`${table.deletedAt} IS NULL`),

    // Fallback indexes for historical queries (including deleted records)
    index("idx_feature_metrics_merchant_feature").on(
      table.merchantId,
      table.featureId
    ),
    index("idx_feature_metrics_feature").on(table.featureId),
    index("idx_feature_metrics_metric").on(table.metricId),
  ]
);

// Relations for the junction table
export const featureMetricsRelations = relations(featureMetrics, ({ one }) => ({
  feature: one(features, {
    fields: [featureMetrics.featureId],
    references: [features.id],
  }),
  metric: one(metrics, {
    fields: [featureMetrics.metricId],
    references: [metrics.id],
  }),
}));

// Zod schemas for validation
export const featureMetricsSelectSchema = createSelectSchema(featureMetrics);
export const featureMetricsInsertSchema = createInsertSchema(featureMetrics);
export const featureMetricsUpdateSchema = createUpdateSchema(featureMetrics);

// Create schemas for validation
export const featuresSelectSchema = createSelectSchema(features);
export const featuresInsertSchema = createInsertSchema(features);
export const featuresUpdateSchema = createUpdateSchema(features);

export const planFeaturesSelectSchema = createSelectSchema(planFeatures);
export const planFeaturesInsertSchema = createInsertSchema(planFeatures);

export const subscriptionFeaturesSelectSchema =
  createSelectSchema(subscriptionFeatures);
export const subscriptionFeaturesInsertSchema =
  createInsertSchema(subscriptionFeatures);
