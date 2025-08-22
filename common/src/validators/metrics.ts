import { z } from "zod";
import { eventPropertiesSchema } from "./events";
// Import constants from the schema file
import {
  AggregationTypes as MetricAggregationTypes,
  QueryTypes,
  ValueTypes,
} from "../db/schema/metrics";

/**
 * Validates if a given SQL string appears to be SELECT-only.
 * Performs basic checks for keywords and starting words.
 * Does NOT guarantee perfect security, but prevents common DML/DDL.
 * @param sql The SQL string to validate.
 * @returns True if the SQL seems SELECT-only, false otherwise.
 */
export function validateSqlIsSelectOnly(
  sql: string | null | undefined
): boolean {
  if (!sql) {
    return false; // SQL must be provided for indexed/complex
  }

  const lowerSql = sql.trim().toLowerCase();

  // Must start with SELECT or WITH (for CTEs)
  if (!lowerSql.startsWith("select") && !lowerSql.startsWith("with")) {
    return false;
  }

  // Check for forbidden keywords (case-insensitive)
  // Use word boundaries to avoid matching keywords within identifiers
  const forbiddenKeywords = [
    "insert",
    "update",
    "delete",
    "drop",
    "create",
    "alter",
    "truncate",
    "grant",
    "revoke",
    "commit",
    "rollback",
    // Add any other keywords deemed unsafe
  ];

  for (const keyword of forbiddenKeywords) {
    // Match the keyword as a standalone word
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(lowerSql)) {
      // Found a forbidden keyword
      return false;
    }
  }

  // Basic check passed
  return true;
}

export const metricFilterCriteriaSchema = eventPropertiesSchema
  .optional()
  .describe("Optional key-value pairs to filter events before aggregation.");

// Base schema for metric definition to match database schema
export const metricDefinitionBaseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .describe("Unique, human-readable name for the metric."),
  description: z
    .string()
    .optional()
    .describe("Optional description of the metric."),

  // Query classification
  queryType: z
    .enum(QueryTypes)
    .default("simple")
    .describe("Type of query: simple, indexed, or complex"),

  // Fields for 'simple' queryType
  aggregationType: z
    .enum(MetricAggregationTypes)
    .optional()
    .describe("How to aggregate matching events (for simple metrics)."),
  eventName: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("The event name to track (for simple metrics)."),
  valueType: z
    .enum(ValueTypes)
    .optional()
    .describe(
      "Type of value to aggregate: NUMERIC or STRING (for simple metrics)."
    ),

  // Unified SQL definition for 'indexed' and 'complex' queryTypes
  sqlDefinition: z
    .string()
    .optional()
    .describe("SQL definition for indexed or complex metrics."),
});

// Schema for creating a new metric definition with refined validation
export const createMetricDefinitionSchema = metricDefinitionBaseSchema.refine(
  (data) => {
    switch (data.queryType) {
      case "simple":
        if (!data.aggregationType || !data.eventName || !data.valueType) {
          return false; // Simple needs aggregation, event, valueType
        }
        // Simple type should not have sqlDefinition
        if (data.sqlDefinition) {
          return false;
        }
        break;
      case "indexed":
      case "complex":
        // Indexed/Complex need sqlDefinition and it must be SELECT-only
        if (
          !data.sqlDefinition ||
          !validateSqlIsSelectOnly(data.sqlDefinition)
        ) {
          return false;
        }
        // Indexed/Complex should not have simple fields
        if (data.aggregationType || data.eventName || data.valueType) {
          return false;
        }
        break;
    }
    return true;
  },
  {
    message:
      "Invalid metric definition. " +
      "Simple metrics require aggregationType, eventName, valueType and no sqlDefinition. " +
      "Indexed/Complex metrics require a valid SELECT-only sqlDefinition and no simple metric fields.",
    // No specific path, relates to multiple fields based on queryType
  }
);

export type CreateMetricDefinitionInput = z.infer<
  typeof createMetricDefinitionSchema
>;

// Schema for updating a metric definition with partial fields
export const updateMetricDefinitionSchema = metricDefinitionBaseSchema
  .partial() // Make all base fields optional
  .refine(
    (data) => {
      // If sqlDefinition is provided, it must be SELECT-only, regardless of type change
      if (
        data.sqlDefinition !== undefined &&
        !validateSqlIsSelectOnly(data.sqlDefinition)
      ) {
        return false;
      }

      // Further validation might require knowing the existing type,
      // which is complex in refine. For updates, we mainly rely on:
      // 1. The sqlDefinition validation above.
      // 2. The database constraints/application logic ensuring incompatible fields aren't mixed.
      // Example: Can't have aggregationType AND sqlDefinition on the final record.
      // This Zod validation focuses on the input data itself.

      // If specifically setting type to indexed/complex, sqlDefinition should be present
      if (
        (data.queryType === "indexed" || data.queryType === "complex") &&
        data.sqlDefinition === undefined
      ) {
        // This is tricky: are they updating OTHER fields of an existing indexed/complex?
        // Or are they changing the type TO indexed/complex without providing SQL?
        // For simplicity, we allow updating other fields without re-supplying sqlDefinition.
        // The requirement is enforced more strictly on CREATE.
      }

      // If specifically setting type to simple, simple fields should be present eventually
      if (
        data.queryType === "simple" &&
        (data.aggregationType === undefined ||
          data.eventName === undefined ||
          data.valueType === undefined)
      ) {
        // Similar complexity as above for updates.
      }

      return true; // Keep update validation relatively lenient on cross-type requirements
    },
    {
      message:
        "Invalid update. sqlDefinition, if provided, must be a valid SELECT-only query. " +
        "Ensure final metric state is consistent (e.g., simple metrics need simple fields, indexed/complex need sqlDefinition).",
      // No specific path, check relates potentially to multiple fields
    }
  );

export type UpdateMetricDefinitionInput = z.infer<
  typeof updateMetricDefinitionSchema
>;

// Schema for metric definition response with all fields
export const metricDefinitionResponseSchema = metricDefinitionBaseSchema.extend(
  {
    id: z.string(),
    merchantId: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
    deletedAt: z.date().nullable().optional(),

    // Make all fields nullable to match database schema
    queryType: z.enum(QueryTypes).default("simple"),
    aggregationType: z.enum(MetricAggregationTypes).nullable().optional(),
    eventName: z.string().nullable().optional(),
    valueType: z.enum(ValueTypes).nullable().optional(),
    sqlDefinition: z.string().nullable().optional(), // Unified field
  }
);

export type MetricDefinitionResponse = z.infer<
  typeof metricDefinitionResponseSchema
>;

// Define TimeFrame schema for querying metrics over time periods
export const timeFrameSchema = z
  .object({
    type: z.enum(["ABSOLUTE", "RELATIVE", "ALL"]),
    start: z.coerce.date().optional(),
    end: z.coerce.date().optional(),
    days: z.number().int().positive().optional(),
  })
  .refine(
    (data) => {
      if (data.type === "ABSOLUTE" && (!data.start || !data.end)) {
        return false;
      }
      if (data.type === "RELATIVE" && !data.days) {
        return false;
      }
      // ALL type doesn't need any additional parameters
      return true;
    },
    {
      message: "Invalid timeframe parameters for the specified timeframe type",
    }
  );

export type TimeFrame = z.infer<typeof timeFrameSchema>;

// Schema for metric value query parameters
export const metricValueQuerySchema = z.object({
  customerId: z.string(),
  timeframe: timeFrameSchema.optional(),
});

// Schema for metric query parameters (listing)
export const metricQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
  // Add other filters like name if needed
});
