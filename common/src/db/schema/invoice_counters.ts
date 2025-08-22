import { relations } from "drizzle-orm";
import {
  integer,
  pgTable,
  primaryKey,
  timestamp,
  text,
} from "drizzle-orm/pg-core";
import { merchants } from "./merchants";
import { customers } from "./customer";

export const customerInvoiceCounters = pgTable(
  "customer_invoice_counters",
  {
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, {
        onDelete: "cascade", // If a merchant is deleted, delete their counters
      }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, {
        onDelete: "cascade", // If a customer is deleted, delete their counters
      }),
    lastInvoiceNumber: integer("last_invoice_number").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.merchantId, table.customerId] })]
);

export const customerInvoiceCountersRelations = relations(
  customerInvoiceCounters,
  ({ one }) => ({
    merchant: one(merchants, {
      fields: [customerInvoiceCounters.merchantId],
      references: [merchants.id],
    }),
    customer: one(customers, {
      fields: [customerInvoiceCounters.customerId],
      references: [customers.id],
    }),
  })
);
