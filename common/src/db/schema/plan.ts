import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  type AnyPgColumn,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { relations, sql } from "drizzle-orm";
import { planFeatures, features } from "./feature";
import { z } from "zod";
import { Price, prices } from "./price";
import { pricingTablePlans } from "./pricing_table";
import { creditDefinitions } from "./credits";

// Dunning action enum for end-of-grace-period behavior
export const dunningActionEnum = pgEnum("dunning_action", [
  "pause_subscription",
  "cancel_subscription",
  "mark_as_unpaid",
]);

export const plans = pgTable("plans", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.plan)),
  pspPlanId: text("psp_plan_id"), // for Dodo Payments
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  stablePlanId: text("stable_plan_id")
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.stablePlan))
    .notNull(),
  versionNumber: integer("version_number").notNull(),
  planName: text("plan_name").notNull(),
  planDescription: text("plan_description"),
  commitMessage: text("commit_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
  isTrialPlan: boolean("is_trial_plan").default(false).notNull(),
  trialParentPlanId: text("trial_parent_plan_id").references(
    (): AnyPgColumn => plans.id
  ),
  trialDays: integer("trial_days"),
});

// Hierarchical dunning configuration table - supports both plan-specific and merchant-level defaults
export const dunningConfigs = pgTable(
  "dunning_configs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.dunningConfig)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    planId: text("plan_id").references(() => plans.id), // Optional - null means merchant-level default
    gracePeriodDays: integer("grace_period_days").notNull().default(7),
    retrySchedule: jsonb("retry_schedule").$type<number[]>().default([1, 3, 7]), // Days after initial failure to retry
    endOfDunningAction: dunningActionEnum("end_of_dunning_action")
      .default("pause_subscription")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Unique constraint: one config per merchant (when planId is null) or per plan
    // This allows both merchant-level defaults and plan-specific overrides
    // 1) Ensure at most one (merchantId, planId) pair overall
    uniqueIndex("uniq_dunning_configs_merchant_plan").on(
      table.merchantId,
      table.planId
    ),
    // 2) Additionally enforce only one merchant-level default (planId IS NULL)
    uniqueIndex("uniq_dunning_configs_merchant_default")
      .on(table.merchantId)
      .where(sql`${table.planId} is null`),
  ]
);

// Define plan relations
export const plansRelations = relations(plans, ({ many, one }) => ({
  planFeatures: many(planFeatures),
  prices: many(prices),
  pricingTablePlans: many(pricingTablePlans),
  creditDefinitions: many(creditDefinitions),
  dunningConfig: one(dunningConfigs, {
    fields: [plans.id],
    references: [dunningConfigs.planId],
  }),
}));

// Dunning configs relations
export const dunningConfigsRelations = relations(dunningConfigs, ({ one }) => ({
  merchant: one(merchants, {
    fields: [dunningConfigs.merchantId],
    references: [merchants.id],
  }),
  plan: one(plans, {
    fields: [dunningConfigs.planId],
    references: [plans.id],
  }),
}));

export const plansSelectSchema = createSelectSchema(plans);
export const plansInsertSchema = createInsertSchema(plans).extend({
  stablePlanId: z.string().nonempty("Stable plan ID cannot be empty"),
  planName: z.string().nonempty("Plan name cannot be empty"),
});
export const plansUpdateSchema = createUpdateSchema(plans);

export type Plan = typeof plans.$inferSelect;

type Feature = typeof features.$inferSelect;

export interface PlanWithFeatures extends Plan {
  features: Feature[];
  isVisibleInPricingTable: boolean;
  isEnterprisePlan: boolean;
  enterpriseRedirectUrl: string | null;
  buttonText: string;
}

export type PlanWithFeaturesAndPrices = PlanWithFeatures & {
  prices: Price[];
};

export const dunningConfigsSelectSchema = createSelectSchema(dunningConfigs);
export const dunningConfigsInsertSchema = createInsertSchema(dunningConfigs);
export const dunningConfigsUpdateSchema = createUpdateSchema(dunningConfigs);
