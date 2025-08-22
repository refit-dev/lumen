import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { relations } from "drizzle-orm";
import { encryptedFieldSchema } from "../../utils/encryption";

export const dodo = pgTable("dodo", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.dodo)),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  secretKey: jsonb("secret_key"),
  webhookSecret: jsonb("webhook_secret"),
  environment: text("environment").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

export const dodoRelations = relations(dodo, ({ one }) => ({
  merchant: one(merchants, {
    fields: [dodo.merchantId],
    references: [merchants.id],
  }),
}));

export const dodoSelectSchema = createSelectSchema(dodo);
export const dodoInsertSchema = createInsertSchema(dodo).extend({
  secretKey: encryptedFieldSchema.optional(),
  webhookSecret: encryptedFieldSchema.optional(),
});
export const dodoUpdateSchema = createUpdateSchema(dodo);
