import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";
import { customers } from "./customer";
import { subscriptions } from "./subscription";

export const billingTasks = pgTable(
  "billing_tasks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.billingTask)),

    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),

    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),

    subscriptionId: text("subscription_id").references(() => subscriptions.id),

    // When the billing engine should process this task (UTC)
    scheduledAt: timestamp("scheduled_at").notNull(),

    status: text("status").default("pending"), // pending | processing | done | failed

    // Behaviour switches for the billing engine
    applyCredits: boolean("apply_credits").default(true).notNull(),
    renewCredits: boolean("renew_credits").default(true).notNull(),

    // Array of line items with full pricing context (see docs)
    lineItemsJson: jsonb("line_items_json")
      .$type<
        Array<{
          type: string;
          description: string;
          quantity?: number;
          unit_amount_cents?: number;
          subtotal_cents: number;
          component_id?: string;
          price_id?: string;
          metric_id?: string;
          billing_period_start?: string;
          billing_period_end?: string;
          tax_metadata?: Record<string, unknown>;
        }>
      >()
      .notNull(),

    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    errorMessage: text("error_message"),
  },
  // Indices
  (table) => [
    index("idx_billing_tasks_pending").on(table.status, table.scheduledAt),
  ]
);
