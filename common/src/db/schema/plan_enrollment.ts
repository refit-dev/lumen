import {
  pgTable,
  text,
  timestamp,
  boolean,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import { plans } from "./plan";
import { relations, sql } from "drizzle-orm";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";

export const enrollmentMatcherTypeEnum = pgEnum("enrollment_matcher_type", [
  "email",
  "domain",
]);

export const planEnrollmentRules = pgTable(
  "plan_enrollment_rules",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.planEnrollmentRule)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    matcherType: enrollmentMatcherTypeEnum("matcher_type").notNull(),
    matcherValue: text("matcher_value").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_plan_enroll_rules_merchant_plan_active")
      .on(table.merchantId, table.planId)
      .where(sql`${table.deletedAt} IS NULL`),
  ]
);

export const planEnrollmentRulesRelations = relations(
  planEnrollmentRules,
  ({ one }) => ({
    merchant: one(merchants, {
      fields: [planEnrollmentRules.merchantId],
      references: [merchants.id],
    }),
    plan: one(plans, {
      fields: [planEnrollmentRules.planId],
      references: [plans.id],
    }),
  })
);

export const planEnrollmentRulesSelectSchema =
  createSelectSchema(planEnrollmentRules);
export const planEnrollmentRulesInsertSchema =
  createInsertSchema(planEnrollmentRules);
export const planEnrollmentRulesUpdateSchema =
  createUpdateSchema(planEnrollmentRules);

export type PlanEnrollmentRule = z.infer<
  typeof planEnrollmentRulesSelectSchema
>;
