import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.apiKey)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyType: text("key_type", { enum: ["secret", "publishable"] }).notNull(),
    environment: text("environment", { enum: ["test", "live"] })
      .notNull()
      .default("live"),
    permissions: text("permissions", {
      enum: ["admin", "public"], // TODO: for now, we only support admin and public
    })
      .array()
      .notNull()
      .default(["public"]),
    keyValue: text("key_value").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    lastUsedAt: timestamp("last_used_at"),
  },
  (table) => [index("prefix_idx").on(table.prefix)]
);

// Create relations constant for use in queries
export const apiKeysRelations = {
  merchant: {
    relationName: "api_keys_merchant",
    columns: [apiKeys.merchantId],
    references: [merchants.id],
  },
};

// Create schemas for validation
export const apiKeysSelectSchema = createSelectSchema(apiKeys);
export const apiKeysInsertSchema = createInsertSchema(apiKeys);
export const apiKeysUpdateSchema = createUpdateSchema(apiKeys);

// Create API response schema
export const apiKeysSelectSchemaAPI = apiKeysSelectSchema.extend({
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});

// Create listing schema that excludes the full key value for display
export const apiKeysListSchema = apiKeysSelectSchemaAPI.omit({
  keyValue: true,
});

export const apiKeysPermissionsSchema = apiKeys.permissions.enumValues;
