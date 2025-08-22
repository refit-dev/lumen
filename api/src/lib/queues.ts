import { Queue, QueueOptions } from "bullmq";
import { env } from "../env";
import type { QueuedEventData } from "@lumen/common/validators";
import { getSecret } from "../helpers/secrets";

const redisPassword =
  env.NODE_ENV !== "development" && env.NODE_ENV !== "test"
    ? await getSecret(`lumen/${env.NODE_ENV}/redis-password`)
    : env.REDIS_PASSWORD;

// Build connection options for BullMQ (ioredis) with optional TLS
const _opts: Record<string, any> = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: redisPassword ?? undefined,
};
// For AWS ElastiCache in-transit encryption
if (env.REDIS_TLS_ENABLED) {
  console.log("TLS enabled");
  _opts.tls = {};
}

export const connectionOptions: QueueOptions["connection"] = _opts;

// Default queue name for event persistence
export const DEFAULT_EVENT_QUEUE_NAME = "event-persistence";

// Initialize a BullMQ queue for persisting usage events asynchronously
export const eventPersistenceQueue = new Queue<QueuedEventData>(
  DEFAULT_EVENT_QUEUE_NAME,
  {
    connection: connectionOptions, // Pass the defined connection options object
  }
);
