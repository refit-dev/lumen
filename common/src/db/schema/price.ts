import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { plans } from "./plan";
import { merchants } from "./merchants";
import { relations } from "drizzle-orm";
import { PriceDSLSchemaType } from "../../validators/pricing";
import { priceDSLSchemaZod } from "../../validators/pricing";

export const prices = pgTable("prices", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.price)),
  planId: text("plan_id")
    .notNull()
    .references(() => plans.id, { onDelete: "cascade" }),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  currency: text("currency").notNull(),
  pricingData: jsonb("pricing_data").$type<PriceDSLSchemaType>().notNull(),
  isOverridePrice: boolean("is_override_price").notNull().default(false),
  clonedFromPriceId: text("cloned_from_price_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const pricesRelations = relations(prices, ({ one }) => ({
  plan: one(plans, {
    fields: [prices.planId],
    references: [plans.id],
  }),
}));

export const pricesSelectSchema = createSelectSchema(prices);
export const pricesInsertSchema = createInsertSchema(prices);
export const pricesUpdateSchema = createUpdateSchema(prices).extend({
  pricingData: priceDSLSchemaZod.optional(),
});
