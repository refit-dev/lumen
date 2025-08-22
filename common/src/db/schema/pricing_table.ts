import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  unique,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import { plans } from "./plan";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { relations, sql } from "drizzle-orm";
import { z } from "zod";

// Main pricing table schema
export const pricingTables = pgTable(
  "pricing_tables",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.pricingTable)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    isActive: boolean("is_active").default(true).notNull(),
    heading: text("heading"),
    subheading: text("subheading"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Index for unique slug per merchant when not deleted
    unique("uniq_pricing_tables_slug_merchant").on(
      table.slug,
      table.merchantId
    ),
    index("idx_pricing_tables_slug_merchant_active")
      .on(table.slug, table.merchantId)
      .where(sql`${table.deletedAt} IS NULL`),
  ]
);

// Junction table for pricing tables and plans
export const pricingTablePlans = pgTable(
  "pricing_table_plans",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.pricingTablePlan)),
    pricingTableId: text("pricing_table_id")
      .notNull()
      .references(() => pricingTables.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    displayOrder: integer("display_order").default(0).notNull(),
    isPopular: boolean("is_popular").default(false),
    popularText: text("popular_text"),
    buttonText: text("button_text").default("Choose Plan"),
    buttonOutline: boolean("button_outline").default(false),
    isEnterprisePlan: boolean("is_enterprise_plan").default(false),
    enterpriseRedirectUrl: text("enterprise_redirect_url"),
    creditAllowances: jsonb("credit_allowances").$type<{
      // UNUSED - remove in the future with some other migration
      [featureId: string]: {
        featureName: string;
        amount: number;
        renewal: "monthly" | "yearly" | "none";
      };
    }>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Index for unique pricing table plan combinations when not deleted
    unique("uniq_pricing_table_plans_table_plan").on(
      table.pricingTableId,
      table.planId
    ),
    index("idx_pricing_table_plans_table_plan_active")
      .on(table.pricingTableId, table.planId)
      .where(sql`${table.deletedAt} IS NULL`),
  ]
);

// Define relations
export const pricingTablesRelations = relations(pricingTables, ({ many }) => ({
  pricingTablePlans: many(pricingTablePlans),
}));

export const pricingTablePlansRelations = relations(
  pricingTablePlans,
  ({ one }) => ({
    pricingTable: one(pricingTables, {
      fields: [pricingTablePlans.pricingTableId],
      references: [pricingTables.id],
    }),
    plan: one(plans, {
      fields: [pricingTablePlans.planId],
      references: [plans.id],
    }),
  })
);

// Create zod schemas for validation
export const pricingTablesSelectSchema = createSelectSchema(pricingTables);
export const pricingTablesInsertSchema = createInsertSchema(
  pricingTables
).extend({
  name: z.string().min(1, "Pricing table name is required"),
  slug: z
    .string()
    .min(1, "Slug is required")
    .regex(/^[a-z0-9-]+$/, {
      message: "Slug must contain only lowercase letters, numbers, and hyphens",
    }),
});
export const pricingTablesUpdateSchema = createUpdateSchema(pricingTables);

export const pricingTablePlansSelectSchema =
  createSelectSchema(pricingTablePlans);
export const pricingTablePlansInsertSchema =
  createInsertSchema(pricingTablePlans);
export const pricingTablePlansUpdateSchema =
  createUpdateSchema(pricingTablePlans);

// Request schemas
export const pricingTablesInsertSchemaReq = pricingTablesInsertSchema.omit({
  merchantId: true,
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

export const pricingTablePlansInsertSchemaReq =
  pricingTablePlansInsertSchema.omit({
    merchantId: true,
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  });
