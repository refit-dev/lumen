import {
  pgTable,
  varchar,
  text,
  timestamp,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createPrefixedId, ID_PREFIXES } from "../utils";
import { merchants } from "./merchants";

export const AggregationTypes = [
  "COUNT",
  "SUM",
  "MAX",
  "MIN",
  "AVG",
  "UNIQUE_COUNT",
] as const;
export type AggregationType = (typeof AggregationTypes)[number];

// Create PostgreSQL enum for aggregation types
export const aggregationTypeEnum = pgEnum(
  "aggregation_type_enum",
  AggregationTypes
);

// Define Query Types
export const QueryTypes = ["simple", "indexed", "complex"] as const;
export type QueryType = (typeof QueryTypes)[number];

// Create PostgreSQL enum for query types
export const queryTypeEnum = pgEnum("query_type_enum", QueryTypes);

// Define Value Types for simple metrics
export const ValueTypes = ["NUMERIC", "STRING"] as const;
export type ValueType = (typeof ValueTypes)[number];

// Create PostgreSQL enum for value types
export const valueTypeEnum = pgEnum("value_type_enum", ValueTypes);

/**
 * Table: metrics
 * Stores metric definitions, supporting simple aggregations and custom SQL.
 */
export const metrics = pgTable(
  "metrics",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createPrefixedId(ID_PREFIXES.metric)),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description").notNull().default(""),

    // Query classification
    queryType: queryTypeEnum("query_type").notNull().default("simple"),

    // Fields for 'simple' queryType
    aggregationType: aggregationTypeEnum("aggregation_type"), // Nullable, only for simple
    eventName: varchar("event_name", { length: 255 }).default(""), // Nullable, only for simple
    valueType: valueTypeEnum("value_type"), // Nullable, only for simple

    // Unified SQL Definition for 'indexed' and 'complex' queryTypes
    sqlDefinition: text("sql_definition").default(""), // Unified field

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // Index for common lookups by merchant and id (active records)
    index("idx_metrics_merchant_id_active")
      .on(table.merchantId, table.id)
      .where(sql`${table.deletedAt} IS NULL`),

    // Index for lookups by merchant (active records)
    index("idx_metrics_merchant_active")
      .on(table.merchantId)
      .where(sql`${table.deletedAt} IS NULL`),
  ]
);
