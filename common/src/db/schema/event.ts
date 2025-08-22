import {
  pgTable,
  varchar,
  timestamp,
  text,
  jsonb,
  doublePrecision,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import { customers } from "./customer";

export const events = pgTable(
  "events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.event)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    eventName: varchar("event_name", { length: 255 }).notNull(),
    // Note: customerId is optional in the input schema, but we might require it
    // for internal consistency or make it nullable here.
    // Making it nullable for now to align closer with input flexibility.
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    extCustomerId: varchar("ext_customer_id", { length: 255 }), // Optional
    eventTimestamp: timestamp("event_timestamp").notNull(), // Use timestamp with timezone, mode: 'date' for Date object
    eventValue: doublePrecision("event_value"), // Optional numeric value
    eventString: text("event_string"), // Optional string value
    properties:
      jsonb("properties").$type<Record<string, string | number | boolean>>(), // Optional JSON properties
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Unique constraint for idempotency within a merchant
    uniqueIndex("events_merchant_idempotency_idx").on(
      table.merchantId,
      table.idempotencyKey
    ),
    // Index for common filtering/querying scenarios
    index("events_merchant_event_name_idx").on(
      table.merchantId,
      table.eventName
    ),
    index("events_customer_idx").on(table.customerId),
    index("events_timestamp_idx").on(table.eventTimestamp),
  ]
);
