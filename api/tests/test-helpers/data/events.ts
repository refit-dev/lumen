import { createId, createPrefixedId, ID_PREFIXES } from "@lumen/common";
import questDbService from "../../../src/db/questDbService";
import { QuestDbEventInput } from "@lumen/common/validators";
import { logger } from "../../../src/helpers/logging";
import { eventQueueService } from "../../../src/routes/events";

/**
 * Create and ingest test events into QuestDB
 *
 * @param merchantId The merchant ID
 * @param customerId The customer ID
 * @param eventName The event name to use
 * @param count The number of events to create
 * @param properties Array of property objects to use for each event, if provided
 * @returns Promise<boolean> indicating success or failure
 */
export async function createTestEvents(
  merchantId: string,
  customerId: string,
  eventName: string,
  count: number = 1,
  properties?: Array<{ name: string; value: any }>
): Promise<boolean> {
  try {
    const events: QuestDbEventInput[] = [];

    for (let i = 0; i < count; i++) {
      // Base event properties
      const eventProps: Record<string, any> = {};

      // Add specific properties if provided
      if (properties && properties[i]) {
        const { name, value } = properties[i];
        eventProps[name] = value;
      }

      // Allow for numeric value or string value in QuestDB
      // In the new QuestDB migration, we directly use event_value for NUMERIC types
      // and event_string for STRING types without relying on propertyName
      const hasNumericValue =
        properties &&
        properties[i] &&
        typeof properties[i].value === "number" &&
        properties[i].name !== "event_value"; // Don't double-set

      const hasStringValue =
        properties &&
        properties[i] &&
        typeof properties[i].value === "string" &&
        properties[i].name !== "event_string"; // Don't double-set

      const event: QuestDbEventInput = {
        merchant_id: merchantId,
        customer_id: customerId,
        event_name: eventName,
        idempotency_key: `test-event-${createId()}`,
        timestamp: new Date(),
        properties: Object.keys(eventProps).length > 0 ? eventProps : undefined,
        // Conditionally set event_value or event_string based on property value type
        event_value: hasNumericValue ? properties![i].value : undefined,
        event_string: hasStringValue ? properties![i].value : undefined,
      };

      events.push(event);
    }

    // Ingest all events at once into QuestDB
    const questDbSuccess = await questDbService.ingestEvents(events);
    if (!questDbSuccess) {
      logger.error(
        `Failed to ingest test events into QuestDB for ${merchantId}, event ${eventName}`
      );
      return false;
    }

    // Also enqueue events for PostgreSQL persistence
    try {
      const eventBatchForQueue = events.map((event) => ({
        idempotencyKey: event.idempotency_key,
        data: {
          merchantId: event.merchant_id,
          customerId: event.customer_id || "",
          eventName: event.event_name,
          idempotencyKey: event.idempotency_key,
          eventTimestamp: event.timestamp?.toISOString() || "",
          eventValue: event.event_value,
          eventString: event.event_string,
          properties: event.properties,
        },
      }));

      await eventQueueService.enqueueBatch(eventBatchForQueue);
      logger.debug(
        `Successfully enqueued ${eventBatchForQueue.length} events for PG persistence in tests`
      );
    } catch (error) {
      logger.warn(
        `Failed to enqueue events for PostgreSQL persistence (non-critical): ${error}`
      );
      // Don't return false here as QuestDB ingestion succeeded
    }

    return true;
  } catch (error) {
    logger.error(`Error creating test events: ${error}`);
    return false;
  }
}
