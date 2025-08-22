import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { relations } from "drizzle-orm";
import { planFeatures } from "./feature";
import { z } from "zod";
import { prices } from "./price";
import { pricingTablePlans } from "./pricing_table";
import { creditDefinitions } from "./credits";

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

// Define plan relations
export const plansRelations = relations(plans, ({ many }) => ({
  planFeatures: many(planFeatures),
  prices: many(prices),
  pricingTablePlans: many(pricingTablePlans),
  creditDefinitions: many(creditDefinitions),
}));

export const plansSelectSchema = createSelectSchema(plans);
export const plansInsertSchema = createInsertSchema(plans).extend({
  stablePlanId: z.string().nonempty("Stable plan ID cannot be empty"),
  planName: z.string().nonempty("Plan name cannot be empty"),
});
export const plansUpdateSchema = createUpdateSchema(plans);

export type Plan = z.infer<typeof plansSelectSchema>;
