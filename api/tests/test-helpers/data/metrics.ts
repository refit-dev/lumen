import { db } from "../../../src/db/client";
import { metrics } from "@lumen/common/schema";
import { createId, createPrefixedId, ID_PREFIXES } from "@lumen/common";
import {
  createMetricDefinitionSchema,
  MetricDefinitionResponse,
} from "@lumen/common/validators";
import {
  AggregationType as MetricAggregationType,
  ValueType,
  metrics as metricsSchema,
} from "@lumen/common/schema";
import { getRedisClient } from "../../../src/lib/redis";
import { eq } from "drizzle-orm";

interface TestMetricOptions {
  merchantId: string;
  name?: string;
  description?: string;
  aggregationType?: MetricAggregationType;
  eventName?: string;
  valueType?: ValueType;
  filterCriteria?: Record<string, any>;
  sqlDefinition?: string;
  queryType?: "simple" | "indexed" | "complex";
}

/**
 * Creates a single test metric definition in the database and Redis.
 * @param options Options for creating the metric.
 * @returns The created metric definition.
 */
export async function createTestMetric(
  options: TestMetricOptions
): Promise<MetricDefinitionResponse> {
  // For backward compatibility, handle any uses of "SET" in test code
  if (options.aggregationType === ("SET" as any)) {
    options.aggregationType = "UNIQUE_COUNT";
    if (!options.valueType) {
      options.valueType = "STRING"; // UNIQUE_COUNT always uses STRING value type
    }
  }

  const { merchantId, queryType = "simple", ...rest } = options;

  let metricData: any = {
    id: createPrefixedId(ID_PREFIXES.metric),
    merchantId,
    queryType,
    name: options.name || `Test Metric ${createId()}`,
    description: options.description || "A test metric",
    ...rest,
  };

  if (queryType === "simple") {
    metricData.aggregationType = options.aggregationType || "COUNT";
    metricData.eventName = options.eventName || `test.event.${createId()}`;
    if (!options.valueType) {
      if (metricData.aggregationType === "UNIQUE_COUNT") {
        metricData.valueType = "STRING";
      } else if (
        ["SUM", "AVG", "MIN", "MAX", "COUNT"].includes(
          metricData.aggregationType
        )
      ) {
        metricData.valueType = "NUMERIC";
      }
    } else {
      metricData.valueType = options.valueType;
    }
    metricData.sqlDefinition = undefined;
  } else {
    metricData.sqlDefinition =
      options.sqlDefinition || "SELECT count(*) FROM events";
    metricData.aggregationType = null;
    metricData.eventName = null;
    metricData.valueType = null;
  }

  const dataForZod = { ...metricData };
  delete dataForZod.merchantId;

  const validatedData = createMetricDefinitionSchema.parse(dataForZod);

  const dbData = { ...validatedData, merchantId };

  const [created] = await db.insert(metricsSchema).values(dbData).returning();

  const redis = await getRedisClient();
  const defKey = `metric_def:${merchantId}:${created.id}`;
  const hashData: Record<string, string> = {
    name: created.name,
    description: created.description || "",
    queryType: created.queryType,
  };
  if (created.queryType === "simple") {
    if (created.aggregationType)
      hashData.aggregationType = created.aggregationType;
    if (created.eventName) hashData.eventName = created.eventName;
    if (created.valueType) hashData.valueType = created.valueType;
  } else if (
    created.queryType === "indexed" ||
    created.queryType === "complex"
  ) {
    if (created.sqlDefinition) hashData.sqlDefinition = created.sqlDefinition;
  }
  await redis.hSet(defKey, hashData);

  if (created.queryType === "simple" && created.eventName) {
    const idxKey = `metrics_for_event:${merchantId}:${created.eventName}`;
    await redis.sAdd(idxKey, created.id);
  }

  const responseData = {
    ...created,
    description: created.description ?? null,
    aggregationType: created.aggregationType ?? null,
    eventName: created.eventName ?? null,
    valueType: created.valueType ?? null,
    sqlDefinition: created.sqlDefinition ?? null,
    deletedAt: created.deletedAt ?? null,
  };

  return responseData as MetricDefinitionResponse;
}

/**
 * Creates multiple test metrics with different aggregation types
 */
export async function createTestMetrics(
  merchantId: string,
  count: number = 5
): Promise<MetricDefinitionResponse[]> {
  const metricsList: MetricDefinitionResponse[] = [];
  const aggregationTypes: MetricAggregationType[] = [
    "COUNT",
    "SUM",
    "MAX",
    "MIN",
    "AVG",
    "UNIQUE_COUNT",
  ];

  for (let i = 0; i < count; i++) {
    const aggregationType = aggregationTypes[i % aggregationTypes.length];
    const valueType: ValueType | undefined =
      aggregationType === "UNIQUE_COUNT"
        ? "STRING"
        : ["SUM", "AVG", "MIN", "MAX"].includes(aggregationType)
          ? "NUMERIC"
          : undefined;

    const metric = await createTestMetric({
      merchantId,
      name: `${aggregationType} Metric ${i + 1}`,
      aggregationType: aggregationType,
      eventName: `test.${aggregationType.toLowerCase()}.event`,
      valueType: valueType,
    });

    metricsList.push(metric);
  }

  return metricsList;
}

/**
 * Deletes test metrics (both from DB and Redis)
 */
export async function deleteTestMetric(
  metricId: string,
  merchantId: string,
  eventName: string
) {
  const redis = await getRedisClient();
  const defKey = `metric_def:${merchantId}:${metricId}`;
  const idxKey = `metrics_for_event:${merchantId}:${eventName}`;

  try {
    await redis.del(defKey);
    await redis.sRem(idxKey, metricId);
  } catch (error) {
    console.error("Failed to remove metric from Redis in test helper", error);
  }

  await db.delete(metrics).where(eq(metrics.id, metricId));

  return true;
}
