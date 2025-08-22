import { z } from "zod";

// Base schema for event properties, allowing string, number, or boolean values
export const eventPropertiesSchema = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .nullable()
  .optional() // Allow properties to be completely omitted
  .describe(
    "A JSON object containing key-value pairs with additional event details."
  );

// Schema for a single event payload - Aligned with QuestDB events table
// Define the base object structure first
const baseEventSchema = z.object({
  idempotencyKey: z
    .string()
    .min(1, "Idempotency key cannot be empty.")
    .max(255)
    .describe("A unique key provided by the client to ensure idempotency."),
  eventName: z
    .string()
    .min(1, "Event name cannot be empty.")
    .max(255, "Event name too long.")
    .describe("The name of the event being reported."),
  customerId: z
    .string()
    .max(255)
    .optional()
    .describe(
      "The unique identifier for the customer associated with the event (optional)."
    ),
  extCustomerId: z
    .string()
    .max(255)
    .optional()
    .describe("An external customer identifier, if applicable (optional)."),
  eventTimestamp: z
    .string()
    .datetime({ offset: true, message: "Invalid ISO 8601 timestamp format." })
    .pipe(z.coerce.date()) // Coerce to Date object after validation
    .describe("The timestamp when the event occurred in ISO 8601 format."),
  eventValue: z
    .number()
    .optional()
    .describe(
      "The primary numeric value associated with the event, if applicable."
    ),
  eventString: z
    .string()
    .optional()
    .describe(
      "The primary string value associated with the event, if applicable."
    ),
  properties: eventPropertiesSchema, // Use the defined properties schema
});

// Apply refinements to the base schema for the final eventSchema
export const eventSchema = baseEventSchema
  // Refine 1: Ensure exactly one of eventValue or eventString is present
  .refine(
    (data) =>
      // XOR: checks if exactly one of the two is defined
      (data.eventValue !== undefined) !== (data.eventString !== undefined),
    {
      message: "Exactly one of eventValue or eventString must be provided.",
      path: ["eventValue", "eventString"], // Apply error to both fields
    }
  )
  // Refine 2: Ensure at least one of customerId or extCustomerId is present
  .refine(
    (data) => data.customerId !== undefined || data.extCustomerId !== undefined,
    {
      message: "At least one of customerId or extCustomerId must be provided.",
      path: ["customerId", "extCustomerId"], // Apply error to both fields
    }
  );

export const eventInsertSchemaAPI = baseEventSchema
  .extend({
    idempotencyKey: baseEventSchema.shape.idempotencyKey.optional(),
    eventTimestamp: baseEventSchema.shape.eventTimestamp.optional(),
  })
  // Re-apply refinement 1: Ensure exactly one of eventValue or eventString is present
  .refine(
    (data) =>
      (data.eventValue !== undefined) !== (data.eventString !== undefined),
    {
      message: "Exactly one of eventValue or eventString must be provided.",
      path: ["eventValue", "eventString"],
    }
  )
  // Re-apply refinement 2: Ensure at least one of customerId or extCustomerId is present
  .refine(
    (data) => data.customerId !== undefined || data.extCustomerId !== undefined,
    {
      message: "At least one of customerId or extCustomerId must be provided.",
      path: ["customerId", "extCustomerId"],
    }
  );

export type EventOutput = z.infer<typeof eventSchema>;

export type EventInput = z.infer<typeof eventInsertSchemaAPI>;

// Schema for batch event submission
export const eventBatchSchema = z.object({
  events: z
    .array(eventInsertSchemaAPI)
    .min(1, "Batch must contain at least one event.")
    .max(100, "Batch size cannot exceed 100 events."), // Example limit, adjust as needed
});

export type EventBatchInput = z.infer<typeof eventBatchSchema>;

// Schema for query parameters when fetching events
export const eventQuerySchema = z
  .object({
    customerId: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Filter by customer ID(s)."),
    eventName: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Filter by event name(s)."),
    startDate: z
      .string()
      .datetime({ offset: true })
      .pipe(z.coerce.date())
      .optional()
      .describe("Filter events occurring after this timestamp (inclusive)."),
    endDate: z
      .string()
      .datetime({ offset: true })
      .pipe(z.coerce.date())
      .optional()
      .describe("Filter events occurring before this timestamp (inclusive)."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100) // Max page size
      .optional()
      .describe("Maximum number of events to return."),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Number of events to skip for pagination."),
  })
  .optional()
  .default({ limit: 100, offset: 0 }); // If they are omitted (undefined), default to an empty object

// Schema for events enqueued for persistence (includes merchantId)
// This represents the data structure *after* serialization in the queue
// We access the underlying object schema (.schema) before extending,
// as .refine() returns a ZodEffects object which doesn't have .extend()
// Use the base schema for extending
export const queuedEventDataSchema = baseEventSchema
  .extend({
    merchantId: z
      .string()
      .describe("The merchant ID associated with the event."),
  })
  .omit({ eventTimestamp: true }) // Remove the coerced date version from base
  .extend({
    eventTimestamp: z
      .string()
      .datetime({ offset: true, message: "Invalid ISO 8601 timestamp format." })
      .describe(
        "The timestamp when the event occurred (as string in queue) in ISO 8601 format."
      ),
  });

export type QueuedEventData = z.infer<typeof queuedEventDataSchema>;

// Define a type for the data ready for DB insertion (timestamp as Date)
export type DBReadyEventData = Omit<QueuedEventData, "eventTimestamp"> & {
  eventTimestamp: Date;
};
