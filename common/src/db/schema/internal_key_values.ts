// This table contains internal data that is not exposed to the public
// It is used to store and update data easily that is consumend by the backend

import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// Current keys:
// "yc-companies-placeholder.com" === import { YC_ENROLLMENT_PLACEHOLDER_DOMAIN } from "@lumen/common/utils"
export const internalKeyValues = pgTable("internal_key_values", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});
