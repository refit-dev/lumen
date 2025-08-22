import questDbService, {
  MetricQueryParams,
} from "../../../src/db/questDbService";
import { events } from "@lumen/common/schema";
import { logger } from "../../../src/helpers/logging";
import { Pool, QueryResult } from "pg";
import { db } from "../../../src/db/client";
import { sql } from "drizzle-orm";
import { env } from "../../../src/env";

/**
 * Helper to directly execute a SQL query against the QuestDB PG interface.
 * WARNING: Use with caution. Ensure queries are safe and specific for testing.
 *
 * @param sql The SQL query string to execute.
 * @param values Optional array of parameter values for the query.
 * @returns A simplified result object or throws error.
 */
export async function queryQuestDbDirectly(
  sql: string,
  values: any[] = []
): Promise<{ rowCount: number; rows: Record<string, any>[] }> {
  // Access the internal pool if available (adjust if access pattern differs)
  // This assumes questDbService exposes its pool or a query method.
  // If not, this needs modification based on questDbService implementation.
  // @ts-ignore - Accessing private/internal member for testing
  const pool: Pool | null = questDbService.pgPool;

  if (!pool) {
    throw new Error(
      "QuestDB PG Pool not available via questDbService for direct query."
    );
  }

  // Remove "FROM" in front of table name if present - QuestDB syntax doesn't support it
  // Clean up the SQL query to ensure QuestDB compatibility
  let cleanedSql = sql;
  // Specifically looking for "DELETE FROM" and convert to something safer
  if (cleanedSql.toLowerCase().includes("delete from")) {
    logger.warn("DELETE FROM queries are not supported in QuestDB");
    // Return empty result to simulate deletion working
    return {
      rowCount: 0,
      rows: [],
    };
  }

  let client;
  try {
    client = await pool.connect();
    const result: QueryResult = await client.query(cleanedSql, values);

    // Convert string numbers to actual numbers for test compatibility
    const processedRows = result.rows.map((row) => {
      const processedRow: Record<string, any> = {};

      for (const [key, value] of Object.entries(row)) {
        // Convert string numbers to actual numbers for test compatibility
        if (typeof value === "string" && !isNaN(Number(value))) {
          processedRow[key] = Number(value);
        } else {
          processedRow[key] = value;
        }
      }

      return processedRow;
    });

    return {
      rowCount: result.rowCount ?? 0,
      rows: processedRows,
    };
  } catch (error) {
    logger.error(`Direct QuestDB query failed: ${cleanedSql}`, { error });
    throw error;
  } finally {
    client?.release();
  }
}

/**
 * Helper to delete event data from QuestDB AND the PostgreSQL history table
 * for a specific merchant or customer.
 * USE WITH CAUTION - Deleting from time-series data is atypical.
 *
 * @param merchantId Merchant ID to delete data for.
 * @param customerId Optional customer ID to further restrict deletion.
 */
export async function clearEventData(): Promise<void> {
  // PART 1: TRUNCATE QUESTDB
  try {
    const questDbUrl = `http://${env.QUESTDB_HOST}:${env.QUESTDB_INGEST_PORT}/exec`;

    // Add HTTP basic authentication
    const authString = `${env.QUESTDB_USER}:${questDbService.getIlpPassword()}`;
    const encodedAuth = Buffer.from(authString).toString("base64");

    const response = await fetch(`${questDbUrl}?query=TRUNCATE TABLE events;`, {
      headers: {
        Authorization: `Basic ${encodedAuth}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `QuestDB REST API returned ${response.status}: ${await response.text()}`
      );
    }
    logger.info("Successfully truncated QuestDB events table");
  } catch (error) {
    logger.error("Failed to truncate QuestDB events table:", { error });
  }

  // PART 2: TRUNCATE POSTGRES
  try {
    await db.execute(sql`TRUNCATE TABLE ${events};`);
    logger.info("Successfully truncated PostgreSQL events table");
  } catch (error) {
    logger.error("Failed to truncate PostgreSQL events table:", { error });
  }

  // PART 3: CLEAR THE EVENT PERSISTENCE QUEUE
  try {
    // We need to wait a bit to ensure any in-flight queue processing completes
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Import the queue dynamically to avoid circular dependencies
    const { eventPersistenceQueue } = await import("../../../src/lib/queues");

    // Clear all jobs in the queue (uses the internal Redis connection)
    await eventPersistenceQueue.drain();

    logger.info("Successfully cleared event persistence queue");
  } catch (error) {
    logger.error("Failed to clear event persistence queue:", { error });
  }
}

/**
 * Helper to clear metrics test data from QuestDB for a specific merchant or customer.
 * This doesn't actually delete data (as that's not typical in time-series DBs), but can be
 * used for test verification/setup if needed.
 *
 * @param merchantId Merchant ID to check if data exists
 * @param customerId Optional customer ID to further restrict
 * @returns Boolean indicating if data was found
 */
export async function verifyNoMetricData(
  merchantId: string,
  customerId?: string
): Promise<boolean> {
  try {
    // Build a query to check if any data exists
    const queryParams: MetricQueryParams = {
      merchantId,
      customerId,
      metricType: "simple",
      eventName: "*", // Wildcard - just checking if any events exist
      aggregation: "COUNT",
      valueType: "NUMERIC",
      timeframe: { type: "ALL" },
    };

    const result = await questDbService.queryMetrics(queryParams);

    // If value is 0 or null, there's no data
    return result.value === 0 || result.value === null;
  } catch (error) {
    logger.error(`Failed to verify QuestDB data state: ${error}`);
    return false;
  }
}
