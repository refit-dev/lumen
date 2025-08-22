import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import {
  metrics,
  AggregationTypes,
  QueryType,
  ValueType,
  AggregationType,
} from "@lumen/common/schema";
import {
  createMetricDefinitionSchema,
  updateMetricDefinitionSchema,
  metricDefinitionResponseSchema,
  timeFrameSchema,
} from "@lumen/common/validators";
import { getRedisClient } from "../lib/redis";
import { z } from "zod";
import { isNull } from "drizzle-orm";
import { logger } from "../helpers/logging";
import { bootstrapMetricDefinitions } from "../lib/metricDefinitions";
import {
  MetricQueryParams,
  default as questDbService,
} from "../db/questDbService";
import {
  Parser,
  Select,
  AST,
  From,
  Join,
  Function as SqlFunction,
} from "node-sql-parser";

const redisMetricHashSchema = z.object({
  name: z.string(),
  description: z.string(),
  queryType: z.enum(["simple", "indexed", "complex"]).default("simple"),
  // Fields for 'simple' queryType
  aggregationType: z.enum(AggregationTypes).nullable().optional(),
  eventName: z.string().optional(),
  valueType: z.enum(["NUMERIC", "STRING"]).nullable().optional(),
  // SQL Definition for 'indexed' and 'complex' queryTypes
  sqlDefinition: z.string().optional(),
});
const redisMetricHashPartialSchema = redisMetricHashSchema.partial();

// Helper function to convert null values in an object to empty strings
function nullsToEmptyStrings(obj: Record<string, any>): Record<string, string> {
  const newObj: Record<string, string> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      newObj[key] = obj[key] === null ? "" : String(obj[key]); // Convert null to "", ensure others are strings
    }
  }
  return newObj;
}

// Schema for backfill request body
const backfillRequestSchema = z.object({
  limit: z.number().int().positive().max(100000).optional().default(10000),
});

// Schema for backfill response
const backfillResponseSchema = z.object({
  message: z.string(),
  processedEvents: z.number().int().nonnegative(),
  currentValue: z.number(),
});

// Schema for metric value request query
const metricValueQuerySchema = z.object({
  customerId: z.string(),
  // timeframe: timeFrameSchema.optional(),
  timeframe: z.preprocess((val) => {
    if (typeof val === "string") {
      return JSON.parse(val);
    }
    return val;
  }, timeFrameSchema.optional()),
});

// Define a more specific type for the validation result
interface SqlValidationResult {
  isValid: boolean;
  error?: string;
}

export const validateMetricSqlStructure = (
  sql: string | null | undefined // Allow null/undefined input for the initial check
): SqlValidationResult => {
  if (!sql) {
    return { isValid: false, error: "SQL definition cannot be empty." };
  }
  const parser = new Parser();
  try {
    // astify can return AST[] if multiple statements are found
    const ast: AST | AST[] = parser.astify(sql, { database: "postgresql" });

    // Check if it's a single SELECT statement
    if (Array.isArray(ast) || !ast || ast.type !== "select") {
      return {
        isValid: false,
        error: "SQL must be a single SELECT statement.",
      };
    }

    // We've confirmed it's a single Select statement, so we can safely cast
    const selectAst = ast as Select;

    // Define allowed functions (adjust as needed)
    const allowedFunctions = new Set<string>([
      "count",
      "sum",
      "avg",
      "min",
      "max",
      "upper",
      "lower",
      "length",
      "coalesce",
      "date_trunc",
      "extract",
      // Add standard SQL functions considered safe
    ]);

    // Define the allowed table name (case-insensitive check later)
    const ALLOWED_TABLE = "filtered_events";

    // *** NEW: Set to store names of validated CTEs ***
    const allowedCteNames = new Set<string>();

    // Recursive function to check nodes within the AST
    const checkNode = (node: any): void => {
      // Base case or irrelevant node types (null, primitives)
      if (!node || typeof node !== "object") {
        return;
      }

      // 1. Explicitly check columns in SELECT statements
      if (
        node.type === "select" &&
        node.columns &&
        Array.isArray(node.columns)
      ) {
        node.columns.forEach((column: any) => {
          // Check if the column expression itself is a function with the expected structure
          if (
            column.expr &&
            column.expr.type === "function" &&
            column.expr.name &&
            column.expr.name.name &&
            Array.isArray(column.expr.name.name) &&
            column.expr.name.name.length > 0 &&
            typeof column.expr.name.name[0].value === "string"
          ) {
            const funcName = column.expr.name.name[0].value.toLowerCase();
            const originalFuncName = column.expr.name.name[0].value;
            if (!allowedFunctions.has(funcName)) {
              throw new Error(`Disallowed function call: ${originalFuncName}`);
            }
            // Recurse into arguments of the function found in column
            if (column.expr.args && typeof column.expr.args === "object") {
              checkNode(column.expr.args);
            }
          } else if (column.expr && typeof column.expr === "object") {
            // Otherwise, recurse into the non-function column expression
            checkNode(column.expr);
          }
        });
      }

      // 2. Check if the current node itself is a function (could be anywhere)
      if (node.type === "function") {
        let funcNameToValidate: string | null = null;
        let originalFuncNameStr: string = "unknown_function";

        // Handle structure found in SELECT columns
        if (
          node.name &&
          node.name.name &&
          Array.isArray(node.name.name) &&
          node.name.name.length > 0 &&
          typeof node.name.name[0].value === "string"
        ) {
          funcNameToValidate = node.name.name[0].value.toLowerCase();
          originalFuncNameStr = node.name.name[0].value;
        } else if (typeof node.name === "string") {
          // Handle simpler structure (often found in WHERE/HAVING etc.)
          funcNameToValidate = node.name.toLowerCase();
          originalFuncNameStr = node.name;
        }

        if (funcNameToValidate && !allowedFunctions.has(funcNameToValidate)) {
          throw new Error(`Disallowed function call: ${originalFuncNameStr}`);
        }
        // Always recurse into arguments, regardless of allowance
        if (node.args && typeof node.args === "object") {
          checkNode(node.args);
        }
      }

      // 3. Check table references in FROM/JOIN clauses
      const checkTableReference = (sourceOrJoin: any, context: string) => {
        let tableName: string | null = null;
        if (sourceOrJoin.table && typeof sourceOrJoin.table === "string") {
          tableName = sourceOrJoin.table;
        } else if (sourceOrJoin.expr && typeof sourceOrJoin.expr === "object") {
          // If it's a subquery, recurse into it
          checkNode(sourceOrJoin.expr);
          return; // Don't check table name for subqueries here
        }

        if (tableName) {
          const tableNameLower = tableName.toLowerCase();
          // *** UPDATED: Check against allowed table OR allowed CTE names ***
          if (
            tableNameLower !== ALLOWED_TABLE &&
            !allowedCteNames.has(tableName) // Check original case against CTE names
          ) {
            throw new Error(
              `Invalid table reference${context}: ${tableName}. Only '${ALLOWED_TABLE}' or valid CTEs allowed.`
            );
          }
        }
        // Check JOIN conditions if applicable
        if (sourceOrJoin.on && typeof sourceOrJoin.on === "object") {
          checkNode(sourceOrJoin.on);
        }
      };

      if (node.from && Array.isArray(node.from)) {
        node.from.forEach((source: any) => checkTableReference(source, ""));
      }
      if (node.join && Array.isArray(node.join)) {
        node.join.forEach((join: any) => checkTableReference(join, " in JOIN"));
      }

      // 4. Generic recursion for other properties and nested structures
      // This loop will handle recursing into `where`, `left`, `right`, `expr`, etc.
      Object.keys(node).forEach((key) => {
        // Avoid re-processing structures already handled specifically above or known non-nodes
        if (
          [
            "columns",
            "from",
            "join",
            "type",
            "name",
            "args",
            "table",
            "value",
            "operator",
          ].includes(key)
        ) {
          return;
        }

        const value = node[key];
        if (value && typeof value === "object") {
          // Recurse into nested objects or arrays of objects
          checkNode(value);
        }
      });
    };

    // *** NEW: Validate CTEs defined in WITH clause first ***
    if (selectAst.with && Array.isArray(selectAst.with)) {
      for (const cte of selectAst.with) {
        if (!cte.name || typeof cte.name.value !== "string") {
          throw new Error("CTE definition is missing a valid name.");
        }
        if (!cte.stmt || typeof cte.stmt !== "object") {
          throw new Error(
            `CTE definition for '${cte.name.value}' is missing a statement.`
          );
        }
        // Recursively validate the statement defining the CTE
        checkNode(cte.stmt);
        // If validation passed, add the CTE name to the allowed set
        allowedCteNames.add(cte.name.value);
      }
    }

    // Start the recursive check from the main body of the SELECT AST
    checkNode(selectAst);

    // If no errors were thrown, the SQL is valid according to the rules
    return { isValid: true };
  } catch (error: any) {
    // Log the detailed error for debugging
    logger.warn({
      message: "SQL AST validation failed",
      sql: sql, // Log the original SQL
      error: error?.message || String(error), // Get the specific error message
      stack: error?.stack, // Optionally log stack trace
    });
    // Return a user-friendly error message
    return {
      isValid: false,
      // Prefer the specific error message thrown by the validation logic or parser
      error: error?.message || "Failed to parse or validate SQL structure.",
    };
  }
};

// Router for metric definitions
export const metricsRouter = new Hono()
  // POST /metrics
  .post("/", zValidator("json", createMetricDefinitionSchema), async (c) => {
    const body = c.req.valid("json");
    const merchantId = c.get("merchant")!.id;

    // *** Add validation for sqlDefinition here ***
    if (
      (body.queryType === "indexed" || body.queryType === "complex") &&
      body.sqlDefinition
    ) {
      const validationResult = validateMetricSqlStructure(body.sqlDefinition);
      if (!validationResult.isValid) {
        return c.json(
          { error: `Invalid sqlDefinition: ${validationResult.error}` },
          400
        );
      }
    } else if (
      (body.queryType === "indexed" || body.queryType === "complex") &&
      !body.sqlDefinition
    ) {
      // This case should be caught by Zod refine, but double-check
      return c.json(
        { error: "sqlDefinition is required for indexed/complex metrics" },
        400
      );
    }

    const redis = await getRedisClient();
    try {
      const created = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(metrics)
          .values({ ...body, merchantId })
          .returning();

        const defKey = `metric_def:${merchantId}:${inserted.id}`;
        const multi = redis.multi();

        // Create Redis hash data using the new schema
        const hashData = {
          name: inserted.name,
          description: inserted.description ?? "",
          queryType: inserted.queryType,
          // Simple metric fields
          aggregationType: inserted.aggregationType,
          eventName: inserted.eventName ?? "",
          valueType: inserted.valueType,
          // Unified SQL field
          sqlDefinition: inserted.sqlDefinition ?? "", // Use sqlDefinition
        };

        const validatedHash = redisMetricHashSchema.parse(hashData);
        const redisHashData = nullsToEmptyStrings(validatedHash);
        multi.hSet(defKey, redisHashData);

        // NEW: Add to event index if simple metric
        if (inserted.queryType === "simple" && inserted.eventName) {
          const idxKey = `metrics_for_event:${merchantId}:${inserted.eventName}`;
          multi.sAdd(idxKey, inserted.id);
        }

        await multi.exec();
        return inserted;
      });

      return c.json(metricDefinitionResponseSchema.parse(created), 201);
    } catch (error: any) {
      logger.error("Failed to create metric definition", error);
      if (error instanceof z.ZodError) {
        return c.json(
          {
            error: "Internal validation error for Redis hash",
            details: error.issues,
          },
          500
        );
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  // GET /metrics/:id/value (requires customerId)
  .get("/:id/value", zValidator("query", metricValueQuerySchema), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const id = c.req.param("id");
    const { customerId, timeframe } = c.req.valid("query");

    try {
      // Ensure the metric exists and belongs to the merchant
      const metric = await db.query.metrics.findFirst({
        where: and(
          eq(metrics.id, id),
          eq(metrics.merchantId, merchantId),
          isNull(metrics.deletedAt)
        ),
      });

      if (!metric) {
        return c.json({ error: "Metric not found" }, 404);
      }

      // Map our metric definition to QuestDB's query params
      let queryParams: Partial<MetricQueryParams> = {
        merchantId,
        customerId,
        metricType: metric.queryType as QueryType,
        timeframe: timeframe ?? { type: "ALL" },
      };

      if (metric.queryType === "simple") {
        if (!metric.eventName || !metric.aggregationType || !metric.valueType) {
          throw new Error(
            "Simple metric definition is missing required fields (event, aggregation, valueType)"
          );
        }
        queryParams.eventName = metric.eventName;
        queryParams.aggregation = metric.aggregationType as AggregationType;
        queryParams.valueType = metric.valueType as ValueType;
      } else if (
        metric.queryType === "indexed" ||
        metric.queryType === "complex"
      ) {
        // Check for both indexed and complex
        if (!metric.sqlDefinition) {
          // Use unified sqlDefinition
          throw new Error(
            `${metric.queryType} metric definition is missing SQL`
          );
        }
        queryParams.sqlQuery = metric.sqlDefinition; // Assign from unified field
      } else {
        throw new Error(`Unsupported metric query type: ${metric.queryType}`);
      }

      // Query the metric (add explicit type assertion after checks)
      const result = await questDbService.queryMetrics(
        queryParams as MetricQueryParams
      );

      return c.json({
        id: metric.id,
        name: metric.name,
        customerId,
        value: result.value || 0,
        queryType: metric.queryType,
        timeframe: timeframe ?? { type: "ALL" },
      });
    } catch (error) {
      logger.error(`Failed to get metric value for ${id}:`, error);
      return c.json({ error: "Failed to get metric value" }, 500);
    }
  })

  // GET /metrics
  .get("/", async (c) => {
    const merchantId = c.get("merchant")!.id;
    // Ensure Redis cache is bootstrapped on list metrics
    await bootstrapMetricDefinitions();
    try {
      const list = await db.query.metrics.findMany({
        where: and(
          eq(metrics.merchantId, merchantId),
          isNull(metrics.deletedAt)
        ),
        orderBy: metrics.createdAt,
      });
      // Validate list items
      const validatedList = list.map((item) =>
        metricDefinitionResponseSchema.parse(item)
      );
      return c.json(validatedList);
    } catch (error: any) {
      console.error("Failed to list metrics", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  // GET /metrics/:id
  .get("/:id", async (c) => {
    const merchantId = c.get("merchant")!.id;
    const id = c.req.param("id");

    try {
      const metric = await db.query.metrics.findFirst({
        where: and(
          eq(metrics.id, id),
          eq(metrics.merchantId, merchantId),
          isNull(metrics.deletedAt)
        ),
      });

      if (!metric) {
        return c.json({ error: "Metric not found" }, 404);
      }

      // Validate and return the single metric
      const validatedMetric = metricDefinitionResponseSchema.parse(metric);
      return c.json(validatedMetric);
    } catch (error) {
      logger.error(`Failed to get metric definition for ${id}:`, error);
      if (error instanceof z.ZodError) {
        // Handle validation errors during parse
        return c.json(
          { error: "Invalid data format", details: error.issues },
          500
        );
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  // POST /metrics/:id/update
  .post(
    "/:id/update",
    zValidator("json", updateMetricDefinitionSchema),
    async (c) => {
      const updates = c.req.valid("json");
      const merchantId = c.get("merchant")!.id;
      const id = c.req.param("id");

      // NEW: Explicitly reject attempts to update immutable fields
      if (updates.aggregationType !== undefined) {
        return c.json(
          { error: "Cannot update immutable field 'aggregationType'" },
          400
        );
      }
      if (updates.valueType !== undefined) {
        return c.json(
          { error: "Cannot update immutable field 'valueType'" },
          400
        );
      }

      // Prevent disallowed updates (redundant now but safe)
      const allowedUpdates = { ...updates };
      delete allowedUpdates.aggregationType;
      delete allowedUpdates.valueType;

      // *** Add validation if sqlDefinition is being updated ***
      if (allowedUpdates.sqlDefinition !== undefined) {
        // Allow empty string to clear definition if changing type to simple, maybe?
        if (allowedUpdates.sqlDefinition) {
          const validationResult = validateMetricSqlStructure(
            allowedUpdates.sqlDefinition
          );
          if (!validationResult.isValid) {
            return c.json(
              { error: `Invalid sqlDefinition: ${validationResult.error}` },
              400
            );
          }
        } else if (
          allowedUpdates.queryType === "indexed" ||
          allowedUpdates.queryType === "complex"
        ) {
          // If setting type to indexed/complex, cannot provide empty sqlDefinition
          // Note: Zod validation might also catch this depending on refine logic
          return c.json(
            {
              error:
                "Cannot clear sqlDefinition when type is indexed or complex",
            },
            400
          );
        }
      }

      // TODO: Add logic to check if the *resulting* metric would be valid
      // (e.g., if queryType changes to indexed/complex but sqlDefinition remains null/empty from existing).
      // This requires fetching the existing record *before* the transaction.

      const redis = await getRedisClient();
      try {
        const updated = await db.transaction(async (tx) => {
          const existing = await tx.query.metrics.findFirst({
            where: and(
              eq(metrics.id, id),
              eq(metrics.merchantId, merchantId),
              isNull(metrics.deletedAt)
            ),
          });
          if (!existing) throw new Error("NotFound");

          // Check if this is a simple metric and if the event name is changing
          const eventNameChanging =
            allowedUpdates.eventName !== undefined &&
            allowedUpdates.eventName !== existing.eventName;
          const isOriginallySimple = existing.queryType === "simple";
          const oldEventName = existing.eventName;

          // Check if query type is changing
          const isBecomingSimple =
            allowedUpdates.queryType === "simple" && !isOriginallySimple;
          const isLeavingSimple =
            allowedUpdates.queryType !== undefined &&
            allowedUpdates.queryType !== "simple" &&
            isOriginallySimple;
          const newQueryType = allowedUpdates.queryType ?? existing.queryType;
          const newEventName = allowedUpdates.eventName ?? existing.eventName;

          // Update the metric - use sqlDefinition
          const updatedMetric = await tx
            .update(metrics)
            .set({
              ...allowedUpdates,
              updatedAt: new Date(), // Explicitly set updatedAt
              // Ensure sqlDefinition and valueType are handled correctly
              // sqlDefinition: allowedUpdates.sqlDefinition === undefined ? existing.sqlDefinition : allowedUpdates.sqlDefinition, // This logic might be too simple
              // valueType: allowedUpdates.valueType === undefined ? existing.valueType : allowedUpdates.valueType, // Already deleted from allowedUpdates
            })
            .where(
              and(
                eq(metrics.id, id),
                eq(metrics.merchantId, merchantId),
                isNull(metrics.deletedAt)
              )
            )
            .returning();

          const defKey = `metric_def:${merchantId}:${id}`;
          const multi = redis.multi();

          // Update Redis hash data - use the actual result from DB
          const hashUpdates = {
            name: updatedMetric[0].name,
            description: updatedMetric[0].description ?? "",
            queryType: updatedMetric[0].queryType,
            aggregationType: updatedMetric[0].aggregationType,
            eventName: updatedMetric[0].eventName ?? "",
            valueType: updatedMetric[0].valueType,
            sqlDefinition: updatedMetric[0].sqlDefinition ?? "",
          };
          const validatedHashUpdates =
            redisMetricHashPartialSchema.parse(hashUpdates);
          const redisHashUpdates = nullsToEmptyStrings(validatedHashUpdates);
          multi.hSet(defKey, redisHashUpdates);

          // NEW: Update Redis event index based on changes
          if (isLeavingSimple && oldEventName) {
            const oldIdxKey = `metrics_for_event:${merchantId}:${oldEventName}`;
            multi.sRem(oldIdxKey, id);
          } else if (
            isOriginallySimple &&
            eventNameChanging &&
            oldEventName &&
            newEventName
          ) {
            const oldIdxKey = `metrics_for_event:${merchantId}:${oldEventName}`;
            const newIdxKey = `metrics_for_event:${merchantId}:${newEventName}`;
            multi.sMove(oldIdxKey, newIdxKey, id);
          } else if (isBecomingSimple && newEventName) {
            const newIdxKey = `metrics_for_event:${merchantId}:${newEventName}`;
            multi.sAdd(newIdxKey, id);
          } else if (
            isOriginallySimple &&
            eventNameChanging &&
            !oldEventName &&
            newEventName
          ) {
            // Case where eventName was initially null/empty for a simple metric (shouldn't happen?) but is now being set
            const newIdxKey = `metrics_for_event:${merchantId}:${newEventName}`;
            multi.sAdd(newIdxKey, id);
          }

          await multi.exec();
          const newEntity = await tx.query.metrics.findFirst({
            where: and(
              eq(metrics.id, id),
              eq(metrics.merchantId, merchantId),
              isNull(metrics.deletedAt)
            ),
          });
          if (!newEntity) throw new Error("Updated metric could not be found");
          return newEntity;
        });
        // Validate and return typed response
        const validatedUpdated = metricDefinitionResponseSchema.parse(updated);
        return c.json(validatedUpdated);
      } catch (error: any) {
        if (error.message === "NotFound") {
          return c.json({ error: "Not found" }, 404);
        }
        logger.error("Failed to update metric definition", error);
        // Handle potential ZodError from hash parse
        if (error instanceof z.ZodError) {
          return c.json(
            {
              error: "Internal validation error for Redis hash update",
              details: error.issues,
            },
            500
          );
        }
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )

  // DELETE /metrics/:id/delete
  .post("/:id/delete", async (c) => {
    const merchantId = c.get("merchant")!.id;
    const id = c.req.param("id");
    const redis = await getRedisClient();
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query.metrics.findFirst({
          where: and(
            eq(metrics.id, id),
            eq(metrics.merchantId, merchantId),
            isNull(metrics.deletedAt)
          ),
        });
        if (!existing) throw new Error("NotFound");

        // Perform soft delete
        await tx
          .update(metrics)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(metrics.id, id),
              eq(metrics.merchantId, merchantId),
              isNull(metrics.deletedAt) // Ensure we only delete if not already deleted
            )
          );

        // Clear Redis cache entries
        const defKey = `metric_def:${merchantId}:${id}`;
        const multi = redis.multi();
        multi.del(defKey);

        // NEW: Remove from event index if it was a simple metric
        if (existing.queryType === "simple" && existing.eventName) {
          const idxKey = `metrics_for_event:${merchantId}:${existing.eventName}`;
          multi.sRem(idxKey, id);
        }

        await multi.exec();
      });
      return c.body(null, 204);
    } catch (error: any) {
      if (error.message === "NotFound") {
        return c.json({ error: "Not found" }, 404);
      }
      logger.error("Failed to delete metric definition", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  });
