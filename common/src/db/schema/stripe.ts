import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { relations } from "drizzle-orm";
import { z } from "zod";
import { encryptedFieldSchema } from "../../utils/encryption";

export const stripe = pgTable("stripe", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createPrefixedId(ID_PREFIXES.stripe)),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  publicKey: text("public_key"),
  secretKey: jsonb("secret_key"), // encrypted field structure
  webhookSecret: jsonb("webhook_secret"), // encrypted field structure
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

// Define stripe relations
export const stripeRelations = relations(stripe, ({ one }) => ({
  merchant: one(merchants, {
    fields: [stripe.merchantId],
    references: [merchants.id],
  }),
}));

export const stripeSelectSchema = createSelectSchema(stripe);
export const stripeInsertSchema = createInsertSchema(stripe).extend({
  publicKey: z.string().nonempty("Public key cannot be empty").optional(),
  secretKey: encryptedFieldSchema.optional(),
  webhookSecret: encryptedFieldSchema.optional(),
});
export const stripeUpdateSchema = createUpdateSchema(stripe);
