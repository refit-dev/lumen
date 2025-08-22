import { z } from "zod";

// Zod schema based on common/src/questdb/migrations/0001_initial_schema.sql
export const questDbEventSchema = z.object({
  // event_timestamp: TIMESTAMP - Handled separately during ingestion (.at/.atNow) and potentially queried as string/date
  merchant_id: z.string().describe("Merchant ID (SYMBOL)"),
  customer_id: z.string().describe("Customer ID (SYMBOL)"),
  ext_customer_id: z
    .string()
    .optional()
    .describe("External Customer ID (SYMBOL, optional)"),
  event_name: z.string().describe("Event Name (SYMBOL)"),
  event_value: z
    .number()
    .optional()
    .describe("Numeric event value (DOUBLE, optional)"),
  event_string: z
    .string()
    .optional()
    .describe("String event value (VARCHAR, optional)"),
  idempotency_key: z.string().describe("Idempotency Key (VARCHAR, required)"),
  properties: z
    .record(z.unknown())
    .optional()
    .describe("JSON properties, stored as VARCHAR string (optional)"),
  // Add timestamp field separate from the schema definition as it's handled by the client/database directly
  timestamp: z.date().describe("Timestamp for the event (required)."),
});

// Type for input when ingesting events using the service
export type QuestDbEventInput = z.infer<typeof questDbEventSchema>;

// Example of how properties might be structured if known, replace z.unknown() if needed
// export const questDbEventSchemaWithKnownProps = questDbEventSchema.extend({
//   properties: z.object({
//     knownProp1: z.string(),
//     knownProp2: z.number().optional(),
//     // ... other known properties
//   }).optional()
// });

// REST API Response Validators

// Zod Schema for a single column definition in QuestDB REST API response
export const questDbColumnSchema = z.object({
  name: z.string().describe("Column name"),
  type: z.string().describe("QuestDB data type"), // Consider refining with known QuestDB types if needed
});

// Zod Schema for the entire QuestDB REST API response
export const questDbRestResponseSchema = z.object({
  query: z.string().describe("The executed SQL query"),
  columns: z.array(questDbColumnSchema).describe("Column definitions"),
  dataset: z.array(z.array(z.any())).describe("Array of arrays with row data"), // Array of arrays with any value type
  count: z.number().describe("Number of rows returned"),
  ddl: z.string().optional().describe("Optional DDL status"), // Optional DDL status
  error: z.string().optional().describe("Optional error message"), // Optional error message from QuestDB
  timings: z.any().optional().describe("Optional query timing info"), // Optional timings info
});

// Types for the REST API response
export type QuestDbColumn = z.infer<typeof questDbColumnSchema>;

// Type for a successfully parsed and processed response
export type ParsedQuestDbResult<T extends Record<string, any>> = {
  success: true;
  query: string;
  columns: QuestDbColumn[];
  dataset: any[][];
  count: number;
  ddl?: string;
  timings?: any;
  parsedRows: T[];
};

// Type for a failed response
export type FailedQuestDbResult = {
  success: false;
  error: string;
  query?: string; // Include query if available from response even on error
};

// Union type for the complete result
export type QuestDbExecuteResult<T extends Record<string, any>> =
  | ParsedQuestDbResult<T>
  | FailedQuestDbResult;
