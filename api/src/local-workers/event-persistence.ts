import { Worker, Job } from "bullmq";
import { env } from "../env";
import { db } from "../db/client";
import { events } from "@lumen/common/schema";
import { logger } from "../helpers/logging";
import {
  queuedEventDataSchema,
  type QueuedEventData,
  type DBReadyEventData,
} from "@lumen/common/validators";
import { connectionOptions, DEFAULT_EVENT_QUEUE_NAME } from "../lib/queues";

// Default batch settings for bulk DB writes
const BATCH_SIZE = env.EVENT_PERSISTENCE_BATCH_SIZE;
const FLUSH_INTERVAL_MS = env.EVENT_PERSISTENCE_FLUSH_INTERVAL_MS;
let buffer: DBReadyEventData[] = [];
let timer: NodeJS.Timeout | null = null;
let processing = false;

async function flushBuffer() {
  logger.debug(
    `Flush buffer called. Current buffer size: ${buffer.length}, Processing flag: ${processing}`
  );
  if (processing || buffer.length === 0) return;
  processing = true;
  const batchToInsert = buffer; // Use the whole buffer
  buffer = [];

  if (batchToInsert.length === 0) {
    logger.info("No events in buffer to persist.");
    processing = false;
    return;
  }

  try {
    logger.debug(
      `[Worker Flush] Attempting to insert batch of ${batchToInsert.length} events into PG.`
    );
    await db
      .insert(events)
      .values(batchToInsert as (typeof events.$inferInsert)[])
      .onConflictDoNothing(); // Keep handling potential duplicates based on idempotency key

    logger.info(
      `[Worker Flush] Successfully persisted batch of ${batchToInsert.length} events to PG.`
    );
  } catch (error: any) {
    // Handle foreign key constraint violations by dropping those events
    if (
      error.code === "23503" ||
      (error.message &&
        error.message.includes("violates foreign key constraint"))
    ) {
      logger.error(
        `[Worker Flush] Dropping ${batchToInsert.length} events due to FK constraint violation: ${error.message}`,
        { firstEventId: batchToInsert[0]?.idempotencyKey } // Log first key for context
      );
    } else {
      logger.error(`[Worker Flush] Failed to persist batch events: ${error}`, {
        firstEventId: batchToInsert[0]?.idempotencyKey, // Log first key for context
        errorCode: error.code,
      });
      // Re-queue the filtered valid batch
      buffer.unshift(...batchToInsert);
    }
  } finally {
    processing = false;
    logger.debug(
      `[Worker Flush] Finished flushBuffer. Buffer size now: ${buffer.length}`
    );
  }
}

// Worker configuration for the current instance
let currentBatchSize = BATCH_SIZE;
let currentFlushIntervalMs = FLUSH_INTERVAL_MS;

const processor = async (job: Job<QueuedEventData>) => {
  logger.debug(`[Worker Process] Starting job ${job.id}`);

  // 1. Validate the data received from the queue
  const parseResult = queuedEventDataSchema.safeParse(job.data);

  if (!parseResult.success) {
    logger.error(
      `[Worker Process] Failed validation for job ${job.id}: ${parseResult.error.message}`,
      { errors: parseResult.error.errors }
    );
    throw new Error(
      `Invalid event data received: ${parseResult.error.message}`
    );
  }

  const validatedEventData = parseResult.data;
  logger.debug(`[Worker Process] Job ${job.id} validated successfully.`);

  // 2. Transform data for DB insertion (convert timestamp string to Date)
  const dbReadyEventData: DBReadyEventData = {
    ...validatedEventData,
    eventTimestamp: new Date(validatedEventData.eventTimestamp),
  };

  // 3. Add the DB-ready data to the buffer
  buffer.push(dbReadyEventData);
  logger.debug(
    `[Worker Process] Job ${job.id} added to buffer. Buffer size: ${buffer.length}`
  );

  // Trigger flush when buffer reaches threshold
  if (buffer.length >= currentBatchSize) {
    logger.debug(
      `[Worker Process] Buffer reached size ${currentBatchSize}. Flushing immediately.`
    );
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Flush buffer synchronously
    await flushBuffer();
  } else if (!timer) {
    logger.debug(
      `[Worker Process] Buffer size ${buffer.length} < ${currentBatchSize}. Setting ${currentFlushIntervalMs}ms timer.`
    );
    // Schedule flush after interval
    timer = setTimeout(async () => {
      logger.debug(`[Worker Process] Timer fired.`);
      timer = null;
      await flushBuffer();
    }, currentFlushIntervalMs);
  }
  logger.debug(`[Worker Process] Job ${job.id} finished processing.`);
  return { status: "queued" };
};

/**
 * Configuration options for the event persistence worker
 */
export interface EventPersistenceWorkerOptions {
  /** Name of the queue to process */
  queueName?: string;
  /** Number of events to batch before writing to database */
  batchSize?: number;
  /** Maximum time (ms) to wait before flushing partial batches */
  flushIntervalMs?: number;
  /** Number of jobs to process concurrently */
  concurrency?: number;
}

/**
 * Start a worker that processes jobs from the specified queue
 *
 * @param options Configuration options for the worker
 * @returns The Worker instance
 */
function startWorker(options: EventPersistenceWorkerOptions = {}) {
  // Apply defaults for all options
  const queueName = options.queueName ?? DEFAULT_EVENT_QUEUE_NAME;
  currentBatchSize = options.batchSize ?? BATCH_SIZE;
  currentFlushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const concurrency = options.concurrency ?? 5;

  // Log configuration
  logger.info(`Initializing Event Persistence Worker with config:
  - Queue: ${queueName}
  - Batch Size: ${currentBatchSize}
  - Flush Interval: ${currentFlushIntervalMs}ms
  - Concurrency: ${concurrency}`);

  const worker = new Worker<QueuedEventData>(queueName, processor, {
    connection: connectionOptions,
    concurrency, // Process jobs concurrently based on config
    removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs
    removeOnFail: { count: 5000 }, // Keep last 5000 failed jobs
  });

  worker.on("completed", (job, result) => {
    logger.info(
      `[Worker Event] Job ${job.id} completed. Result: ${JSON.stringify(result)}`
    );
  });

  worker.on("failed", (job: Job<QueuedEventData> | undefined, err) => {
    logger.error(
      `[Worker Event] Job ${job?.id ?? "<unknown>"} failed. Error: ${err.message}`,
      { stack: err.stack }
    );
  });

  worker.on("error", (err) => {
    logger.error(`[Worker Event] Worker encountered an error: ${err.message}`, {
      stack: err.stack,
    });
  });

  logger.info(
    `Event Persistence Worker for queue '${queueName}' started successfully.`
  );

  // Setup graceful shutdown handler
  const gracefulShutdown = async () => {
    logger.info(
      `Shutting down event persistence worker for queue '${queueName}'...`
    );
    await worker.close();
    logger.info("Worker closed.");
    process.exit(0);
  };

  // Only register shutdown handlers when running as a standalone script
  if (import.meta.main) {
    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGINT", gracefulShutdown);
  }

  return worker;
}

// --- Worker Initialization: only when executed as a standalone script ---
if (import.meta.main) {
  // Start the worker with configuration from environment variables
  startWorker({
    batchSize: BATCH_SIZE,
    flushIntervalMs: FLUSH_INTERVAL_MS,
  });
} else {
  logger.info(
    "Skipping Event Persistence Worker initialization (module imported)."
  );
}

// Export processor, flushBuffer, and startWorker for testing purposes
export { processor, flushBuffer, startWorker };
