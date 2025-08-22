import { Sender } from "@questdb/nodejs-client";
import { logger } from "../helpers/logging";
import { Pool, QueryResult } from "pg";
import pg from "pg";
import { QueryType, AggregationType, ValueType } from "@lumen/common/schema";
import { QuestDbEventInput, TimeFrame } from "@lumen/common/validators";
import { env } from "../env";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export interface MetricQueryParams {
  merchantId: string;
  customerId?: string;
  externalCustomerId?: string;
  eventName?: string;
  metricType: QueryType;
  aggregation?: AggregationType; // For simple metrics
  valueType?: ValueType; // For simple metrics (NUMERIC/STRING)
  sqlQuery?: string; // For indexed and complex metrics
  rawSql?: string; // When provided, metricType is ignored and this SQL runs directly
  rawValues?: any[]; // Optional bind parameters for rawSql
  timeframe: TimeFrame; // Use the shared TimeFrame type
  additionalFilters?: Record<string, string | number | boolean | null>;
}

export interface MetricQueryResult {
  value: number | null;
  rows?: Record<string, string | number | boolean | null>[];
  error?: string;
}

// Interface for the query parameters of the new method
export interface EventQueryParams {
  merchantId: string;
  customerId?: string | string[];
  externalCustomerId?: string | string[];
  eventName?: string | string[];
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// Interface for the result of the new method
export interface EventQueryResult {
  data: Record<string, any>[]; // Array of event objects
  totalPossible?: number; // Optional: QuestDB doesn't easily give total count with LIMIT
  error?: string;
}

class QuestDbService {
  private static instance: QuestDbService;
  private pgPool: Pool | null = null;
  private sender: Sender | null = null; // Add persistent Sender instance
  private logger = logger;
  private isConnected = false;
  private reconnecting = false;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // ms
  private connectionErrors = 0;
  private explicitlyClosed = false;
  private ilpPass: string | null = null;

  // Add a getter to access password safely
  public getIlpPassword(): string | null {
    return this.ilpPass;
  }

  // Store config for creating temporary senders if needed
  // REMOVED: No longer needed as sender is persistent
  // private ilpHost: string | null = null;
  // private ilpPort: number | null = null;
  // private ilpUser: string | null = null;

  private constructor() {}

  public static getInstance(): QuestDbService {
    if (!QuestDbService.instance) {
      QuestDbService.instance = new QuestDbService();
    }
    return QuestDbService.instance;
  }

  /**
   * Initializes the QuestDB service with connection parameters
   * In staging/production environments, it will fetch the password from Secrets Manager
   */
  public async initialize(
    host?: string,
    ingestPort?: number,
    queryPort?: number,
    user?: string,
    password?: string
  ): Promise<void> {
    this.explicitlyClosed = false;

    try {
      // Fetch credentials based on environment
      const creds = await this.getQuestDbCredentials(
        host,
        ingestPort,
        queryPort,
        user,
        password
      );

      this.logger.debug(
        "QuestDbService: Configuring connections with fetched credentials..."
      );

      // Store password for use in authentication
      this.ilpPass = creds.password;

      // --- Initialize Sender ---
      // Keep auto_flush off to mimic previous manual flush behavior
      const ilpConfig = `http::addr=${creds.host}:${creds.ingestPort};username=${creds.username};password=${creds.password};auto_flush=off;`;
      try {
        this.sender = Sender.fromConfig(ilpConfig);
        this.logger.info(
          `QuestDBService: ILP Sender configured for ${creds.host}:${creds.ingestPort}`
        );
      } catch (senderError) {
        this.logger.error("Failed to initialize QuestDB ILP Sender", {
          senderError,
        });
        throw senderError; // Propagate error
      }
      // --- End Initialize Sender ---

      let pgInitialized = false;
      try {
        this.logger.debug("QuestDBService: Configuring PG Pool...");

        // Tell node-postgres to parse TIMESTAMP columns (OID 1114) as UTC
        // by appending 'Z' before creating the Date object.
        pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (stringValue) => {
          return new Date(stringValue + "Z");
        });

        this.pgPool = new Pool({
          host: creds.host,
          port: creds.queryPort,
          user: creds.username,
          password: creds.password,
          database: "qdb",
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });

        this.pgPool.on("error", (err) => {
          this.logger.error("Unexpected error on idle PG client", err);
          this.isConnected = false;
          this.connectionErrors++;
        });

        this.logger.info(
          `QuestDBService: PG Pool configured for ${creds.host}:${creds.queryPort}`
        );
        pgInitialized = true;

        await this.testConnections();
        this.isConnected = true;
        this.connectionErrors = 0;
      } catch (error) {
        this.isConnected = false;
        this.logger.error("Failed to initialize QuestDB service", { error });
        if (pgInitialized) await this.pgPool?.end();
        this.pgPool = null;
        // --- Close sender if PG pool fails ---
        if (this.sender) {
          try {
            await this.sender.close();
          } catch (closeErr) {
            this.logger.warn(
              `Error closing sender during initialization failure: ${String(closeErr)}`
            );
          }
          this.sender = null;
        }
        // --- End Close sender ---
        this.explicitlyClosed = true;
        throw error;
      }
    } catch (error) {
      this.logger.error("Error setting up QuestDB credentials", { error });
      throw error;
    }
  }

  /**
   * Gets the QuestDB credentials, either from environment variables directly or
   * by fetching the password from AWS Secrets Manager in staging/production environments
   */
  private async getQuestDbCredentials(
    providedHost?: string,
    providedIngestPort?: number,
    providedQueryPort?: number,
    providedUser?: string,
    providedPassword?: string
  ): Promise<{
    host: string;
    ingestPort: number;
    queryPort: number;
    username: string;
    password: string;
  }> {
    const {
      NODE_ENV,
      AWS_REGION,
      QUESTDB_HOST,
      QUESTDB_INGEST_PORT,
      QUESTDB_QUERY_PORT,
      QUESTDB_USER,
      QUESTDB_PASSWORD,
    } = env;

    // If all credentials are explicitly provided, use those (useful for testing)
    if (
      providedHost &&
      providedIngestPort &&
      providedQueryPort &&
      providedUser &&
      providedPassword
    ) {
      this.logger.debug("Using explicitly provided QuestDB credentials");
      return {
        host: providedHost,
        ingestPort: providedIngestPort,
        queryPort: providedQueryPort,
        username: providedUser,
        password: providedPassword,
      };
    }

    // For staging/production environments, get password from Secrets Manager
    if (NODE_ENV === "staging" || NODE_ENV === "production") {
      const secretName = `lumen/${NODE_ENV}/questdb-password`;
      this.logger.info(`Fetching QuestDB password from secret: ${secretName}`);

      const client = new SecretsManagerClient({ region: AWS_REGION });
      const command = new GetSecretValueCommand({ SecretId: secretName });

      try {
        const data = await client.send(command);
        if (!data.SecretString) {
          throw new Error(`Secret string is empty for ${secretName}`);
        }

        // In our case, the secret string is just the password directly
        const password = data.SecretString;

        // Use the environment variables for other connection details
        if (
          !QUESTDB_HOST ||
          !QUESTDB_INGEST_PORT ||
          !QUESTDB_QUERY_PORT ||
          !QUESTDB_USER
        ) {
          throw new Error("Missing required QuestDB environment variables");
        }

        return {
          host: QUESTDB_HOST,
          ingestPort: QUESTDB_INGEST_PORT,
          queryPort: QUESTDB_QUERY_PORT,
          username: QUESTDB_USER,
          password: password,
        };
      } catch (error) {
        this.logger.error(
          `Failed to fetch QuestDB password from Secrets Manager:`,
          error
        );
        throw new Error(
          `Could not retrieve QuestDB password from Secrets Manager: ${error}`
        );
      }
    } else {
      // Development/local environment - use environment variables directly
      if (
        !QUESTDB_HOST ||
        !QUESTDB_INGEST_PORT ||
        !QUESTDB_QUERY_PORT ||
        !QUESTDB_USER ||
        !QUESTDB_PASSWORD
      ) {
        throw new Error("Missing required QuestDB environment variables");
      }

      return {
        host: QUESTDB_HOST,
        ingestPort: QUESTDB_INGEST_PORT,
        queryPort: QUESTDB_QUERY_PORT,
        username: QUESTDB_USER,
        password: QUESTDB_PASSWORD,
      };
    }
  }

  private async testConnections(): Promise<void> {
    this.logger.debug("QuestDBService: Starting testConnections...");
    if (!this.pgPool) {
      throw new Error("PG Pool not initialized during connection test.");
    }
    let pgClient = null;
    try {
      // Test PG Pool
      pgClient = await this.pgPool.connect();
      await pgClient.query("SELECT 1");
      this.logger.info("PG Pool connection test successful.");
    } catch (pgError) {
      this.logger.error("PG Pool connection test failed", { error: pgError });
      throw new Error(`PG Pool connection test failed: ${pgError}`);
    } finally {
      pgClient?.release();
    }

    // Test Sender Connection (optional but good practice)
    if (!this.sender) {
      throw new Error("ILP Sender not initialized during connection test.");
    }
    try {
      // Sender doesn't have a direct 'ping'. Flushing an empty buffer might work or is low impact.
      await this.sender.flush();
      this.logger.info("ILP Sender connection test successful (via flush).");
    } catch (senderError) {
      this.logger.error("ILP Sender connection test failed", {
        error: senderError,
      });
      // Decide if sender failure should halt initialization. It might recover.
      // For now, let's log the error but not throw, allowing PG-only operation if needed.
      // throw new Error(`ILP Sender connection test failed: ${senderError}`);
    }
  }

  private async tryReconnect(): Promise<boolean> {
    if (this.explicitlyClosed || this.reconnecting) {
      return false;
    }

    this.reconnecting = true;
    let attempt = 0;
    this.logger.info("QuestDBService: Starting reconnection process...");

    try {
      while (attempt < this.maxReconnectAttempts) {
        attempt++;
        this.logger.info(
          `QuestDBService: Attempting reconnect (${attempt}/${this.maxReconnectAttempts})`
        );

        try {
          await this.testConnections();
          this.isConnected = true;
          this.connectionErrors = 0;
          this.logger.info("Successfully reconnected QuestDB service");
          return true;
        } catch (error) {
          this.logger.error(`Reconnection attempt ${attempt} failed`, {
            error: String(error),
          });
          const delay =
            this.reconnectDelay * Math.pow(2, Math.min(attempt - 1, 4));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      this.logger.error(
        `Failed to reconnect after ${this.maxReconnectAttempts} attempts`
      );
      this.isConnected = false;
      return false;
    } finally {
      this.reconnecting = false;
    }
  }

  public async close(): Promise<void> {
    this.explicitlyClosed = true;
    let pgError = null;
    let senderError = null;

    // Close PG Pool
    if (this.pgPool) {
      try {
        await this.pgPool.end();
        this.logger.info("QuestDBService: PG Pool closed.");
      } catch (err) {
        pgError = err;
        this.logger.error("Error closing QuestDB PG Pool", { error: err });
      } finally {
        this.pgPool = null;
      }
    }

    // Close Sender
    if (this.sender) {
      try {
        await this.sender.close();
        this.logger.info("QuestDBService: ILP Sender closed.");
      } catch (err) {
        senderError = err;
        this.logger.error("Error closing QuestDB ILP Sender", { error: err });
      } finally {
        this.sender = null;
      }
    }

    this.isConnected = false;
    if (pgError || senderError) {
      // Combine errors if both occurred
      const combinedError = new Error("Error closing QuestDB connections");
      (combinedError as any).pgError = pgError;
      (combinedError as any).senderError = senderError;
      throw combinedError;
    }
  }

  public async ingestEvent(event: QuestDbEventInput): Promise<boolean> {
    if (this.explicitlyClosed) {
      this.logger.error("Ingestion failed: QuestDB service explicitly closed.");
      return false;
    }
    // --- Use persistent sender ---
    if (!this.sender) {
      this.logger.error("Ingestion failed: ILP Sender not initialized.");
      return false;
    }
    const sender = this.sender;
    // --- End Use persistent sender ---

    // REMOVED: Temporary sender creation logic removed
    // let tempSender: Sender | null = null;

    try {
      // REMOVED: ILP config check removed

      // --- Use the class member sender ---
      sender.table("events");
      sender.symbol("merchant_id", event.merchant_id);
      sender.symbol("customer_id", event.customer_id || "");
      sender.symbol("event_name", event.event_name);

      if (event.ext_customer_id) {
        sender.symbol("ext_customer_id", event.ext_customer_id);
      }
      if (event.event_value !== undefined) {
        sender.floatColumn("event_value", event.event_value);
      }
      if (event.event_string) {
        sender.stringColumn("event_string", event.event_string);
      }
      if (event.idempotency_key) {
        sender.stringColumn("idempotency_key", event.idempotency_key);
      }
      if (event.properties) {
        const propertiesValue =
          typeof event.properties === "string"
            ? event.properties
            : JSON.stringify(event.properties);
        sender.stringColumn("properties", propertiesValue);
      }
      if (event.timestamp) {
        sender.at(event.timestamp.getTime(), "ms");
      } else {
        sender.atNow();
      }

      // Flush immediately for single event ingestion to maintain similar behavior
      await sender.flush();
      // --- End Use the class member sender ---
      return true;
    } catch (error) {
      this.logger.error("Failed to ingest single event", {
        error: String(error),
        event,
      });
      // TODO: Handle connection errors vs other errors? Maybe trigger reconnect?
      return false;
    }
    // REMOVED: Finally block for temporary sender removed
  }

  public async ingestEvents(events: QuestDbEventInput[]): Promise<boolean> {
    if (this.explicitlyClosed) {
      this.logger.error(
        "Batch ingestion failed: QuestDB service explicitly closed."
      );
      return false;
    }
    if (!events.length) {
      return true;
    }

    // --- Use persistent sender ---
    if (!this.sender) {
      this.logger.error("Batch ingestion failed: ILP Sender not initialized.");
      return false;
    }
    const sender = this.sender;
    // --- End Use persistent sender ---

    // REMOVED: Temporary sender creation logic removed

    try {
      // REMOVED: ILP config check removed

      for (const event of events) {
        // --- Use the class member sender ---
        sender.table("events");
        sender.symbol("merchant_id", event.merchant_id);
        sender.symbol("customer_id", event.customer_id || "");
        sender.symbol("event_name", event.event_name);

        if (event.ext_customer_id) {
          sender.symbol("ext_customer_id", event.ext_customer_id);
        }
        if (event.event_value !== undefined) {
          sender.floatColumn("event_value", event.event_value);
        }
        if (event.event_string) {
          sender.stringColumn("event_string", event.event_string);
        }
        if (event.idempotency_key) {
          sender.stringColumn("idempotency_key", event.idempotency_key);
        }
        if (event.properties) {
          const propertiesValue =
            typeof event.properties === "string"
              ? event.properties
              : JSON.stringify(event.properties);
          sender.stringColumn("properties", propertiesValue);
        }
        if (event.timestamp) {
          sender.at(event.timestamp.getTime(), "ms");
        } else {
          sender.atNow();
        }
        // --- End Use the class member sender ---
      }

      // --- Flush after the batch ---
      await sender.flush();
      this.logger.debug(
        `Successfully flushed batch of ${events.length} events`
      );
      // --- End Flush after the batch ---
      return true;
    } catch (error) {
      this.logger.error("Failed to ingest events in batch", {
        error: String(error),
        count: events.length,
      });
      // TODO: Handle connection errors vs other errors? Maybe trigger reconnect?
      return false;
    }
    // REMOVED: Finally block for temporary sender removed
  }

  /**
   * Query metrics from QuestDB using PG Pool
   */
  public async queryMetrics(
    params: MetricQueryParams
  ): Promise<MetricQueryResult> {
    if (this.explicitlyClosed) {
      return {
        value: null,
        error: "Query failed: QuestDB service explicitly closed.",
        rows: [],
      };
    }
    if (!this.isConnected || !this.pgPool) {
      if (!this.reconnecting) {
        if (this.connectionErrors < this.maxReconnectAttempts) {
          this.connectionErrors++;
          const reconnected = await this.tryReconnect();
          if (!reconnected) {
            return {
              value: null,
              error:
                "Failed to reconnect to QuestDB PG Pool for metric querying",
              rows: [],
            };
          }
        } else {
          return {
            value: null,
            error: `QuestDB PG Pool not connected after ${this.maxReconnectAttempts} attempts`,
            rows: [],
          };
        }
      } else {
        return {
          value: null,
          error: "QuestDB PG Pool connection unavailable (reconnecting)",
          rows: [],
        };
      }
    }

    if (!this.pgPool) {
      return {
        value: null,
        error: "QuestDB PG Pool is not initialized.",
        rows: [],
      };
    }

    try {
      if (!params.rawSql) {
        this.validateTimeframeStructure(params.timeframe);
      }
      this.validateMetricParams(params);

      let sql: string;
      let values: any[] = [];

      if (params.rawSql) {
        sql = params.rawSql;
        values = params.rawValues || [];
      } else {
        let startTs: Date | null = null;
        let endTs: Date | null = null;
        if (params.timeframe.type !== "ALL") {
          const dateRange = await this.buildDateRange(params.timeframe);
          startTs = dateRange.startTs;
          endTs = dateRange.endTs;
        }
        const built = this.buildMetricSql(params, startTs, endTs);
        sql = built.sql;
        values = built.values;
      }

      this.logger.debug(
        params.rawSql
          ? `Executing RAW metric query: SQL=${sql}\n\n Values=${JSON.stringify(values)}`
          : `Executing metric query: Type=${params.metricType}, TF=${params.timeframe.type}, SQL=${sql}, Values=${JSON.stringify(values)}`
      );

      const pgClient = await this.pgPool.connect();
      try {
        const result: QueryResult = await pgClient.query(sql, values);
        return this.processPgQueryResult(
          result,
          params.metricType as QueryType
        );
      } finally {
        pgClient.release();
      }
    } catch (error) {
      this.logger.error("Failed to query metrics via PG", {
        error: String(error),
        params,
      });
      this.isConnected = false;
      this.connectionErrors++;
      return {
        value: null,
        error: `Error querying metrics via PG: ${error instanceof Error ? error.message : String(error)}`,
        rows: [],
      };
    }
  }

  private validateTimeframeStructure(timeframe: TimeFrame): void {
    switch (timeframe.type) {
      case "ABSOLUTE":
        if (!timeframe.start || !timeframe.end) {
          throw new Error(
            "start and end dates are required within the timeframe object for ABSOLUTE type"
          );
        }
        break;
      case "RELATIVE":
        if (!timeframe.days || timeframe.days <= 0) {
          throw new Error(
            "A positive number of days is required within the timeframe object for RELATIVE type"
          );
        }
        break;
      case "ALL":
        break;
      default:
        throw new Error(`Unsupported timeframe type: ${timeframe.type}`);
    }
  }

  private validateMetricParams(params: MetricQueryParams): void {
    if (params.rawSql) {
      // Raw SQL bypasses normal validation
      return;
    }
    switch (params.metricType as QueryType) {
      case "simple":
        if (!params.eventName || !params.aggregation || !params.valueType) {
          throw new Error(
            "eventName, aggregation, and valueType are required for SIMPLE metrics"
          );
        }
        break;
      case "indexed":
      case "complex":
        if (!params.sqlQuery) {
          throw new Error(
            "sqlQuery is required for INDEXED and COMPLEX metrics"
          );
        }
        break;
      default:
        throw new Error(`Unsupported metric type: ${params.metricType}`);
    }
  }

  private async buildDateRange(
    timeframe: TimeFrame
  ): Promise<{ startTs: Date; endTs: Date }> {
    switch (timeframe.type) {
      case "ABSOLUTE":
        if (!timeframe.start || !timeframe.end) {
          throw new Error("Absolute timeframe requires start and end dates.");
        }
        return {
          startTs: timeframe.start,
          endTs: timeframe.end,
        };
      case "RELATIVE":
        if (!timeframe.days) {
          throw new Error("Relative timeframe requires days.");
        }
        const endTs = new Date();
        const startTs = new Date();
        startTs.setDate(startTs.getDate() - timeframe.days);
        return { startTs, endTs };
      case "ALL":
        throw new Error(
          "buildDateRange should not be called for ALL timeframe type"
        );
      default:
        throw new Error(`Unsupported timeframe type: ${timeframe.type}`);
    }
  }

  private buildMetricSql(
    params: MetricQueryParams,
    startTs: Date | null = null,
    endTs: Date | null = null
  ): { sql: string; values: any[] } {
    const values: any[] = [];
    let paramIndex = 0;
    const conditions: string[] = [];

    paramIndex++;
    conditions.push(`merchant_id = $${paramIndex}`);
    values.push(params.merchantId);

    if (params.timeframe.type !== "ALL") {
      if (!startTs || !endTs) {
        throw new Error(
          "Start and end timestamps required for non-ALL timeframes"
        );
      }
      paramIndex++;
      conditions.push(`event_timestamp >= $${paramIndex}`);
      values.push(startTs);
      paramIndex++;
      conditions.push(`event_timestamp <= $${paramIndex}`);
      values.push(endTs);
    }

    // Handle customer ID filtering with OR logic (same as buildEventSql)
    if (params.customerId || params.externalCustomerId) {
      const customerConditions: string[] = [];

      if (params.customerId) {
        paramIndex++;
        customerConditions.push(`customer_id = $${paramIndex}`);
        values.push(params.customerId);
      }

      if (params.externalCustomerId) {
        paramIndex++;
        customerConditions.push(`ext_customer_id = $${paramIndex}`);
        values.push(params.externalCustomerId);
      }

      if (customerConditions.length > 0) {
        conditions.push(`(${customerConditions.join(" OR ")})`);
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    switch (params.metricType as QueryType) {
      case "simple":
        if (!params.aggregation || !params.eventName || !params.valueType) {
          throw new Error(
            "Simple metrics require aggregation, eventName, and valueType"
          );
        }

        const aggregation = String(params.aggregation).toUpperCase();
        const valueType = String(params.valueType).toUpperCase();
        let targetColumn: string;
        if (valueType === "NUMERIC") targetColumn = "event_value";
        else if (valueType === "STRING") targetColumn = "event_string";
        else throw new Error(`Unsupported valueType: ${params.valueType}`);

        const validAggregations = [
          "COUNT",
          "SUM",
          "AVG",
          "MIN",
          "MAX",
          "UNIQUE_COUNT",
        ];
        if (!validAggregations.includes(aggregation)) {
          throw new Error(
            `Invalid aggregation function: ${params.aggregation}`
          );
        }

        let aggregationExpression: string;
        if (aggregation === "COUNT") aggregationExpression = "COUNT(*)";
        else if (aggregation === "UNIQUE_COUNT")
          aggregationExpression = `COUNT(DISTINCT ${targetColumn})`;
        else {
          if (valueType !== "NUMERIC")
            throw new Error(`${aggregation} requires NUMERIC valueType`);
          aggregationExpression = `${aggregation}(${targetColumn})`;
        }

        paramIndex++;
        const simpleWhereClause = `${whereClause} AND event_name = $${paramIndex}`;
        values.push(params.eventName);

        return {
          sql: `SELECT ${aggregationExpression} as metric_value FROM events ${simpleWhereClause}`,
          values,
        };

      case "indexed":
      case "complex":
        if (!params.sqlQuery) {
          throw new Error(`${params.metricType} metrics require sqlQuery`);
        }

        return {
          sql: `
            WITH filtered_events AS (
              SELECT
                event_timestamp,
                merchant_id,
                customer_id,
                ext_customer_id,
                event_name,
                event_value,
                event_string,
                idempotency_key,
                properties
              FROM events
              ${whereClause}
            )
            ${params.sqlQuery}
          `,
          values,
        };

      default:
        throw new Error(`Unsupported metric type: ${params.metricType}`);
    }
  }

  private processPgQueryResult(
    result: QueryResult<any>,
    metricType: QueryType
  ): MetricQueryResult {
    const rows = result.rows;

    if (rows.length === 0) {
      if (metricType === "simple") return { value: 0, rows: [] };
      return { value: null, rows: [] };
    }

    switch (metricType as QueryType) {
      case "simple":
        const simpleValue = rows[0]?.metric_value;
        let numericValue: number | null = null;

        if (simpleValue !== null && simpleValue !== undefined) {
          const parsed = parseFloat(simpleValue);
          if (!isNaN(parsed)) {
            numericValue = parsed;
          } else {
            this.logger.warn(
              `Simple metric query returned non-numeric value: ${simpleValue}`
            );
          }
        } else {
          numericValue = 0;
        }

        return { value: numericValue, rows: rows };

      case "indexed":
      case "complex":
        const firstRow = rows[0];
        let extractedValue: number | null = null;
        if (firstRow) {
          const valueKeys = [
            "value",
            "metric_value",
            "count",
            "sum",
            "avg",
            "max",
            "min",
          ];
          for (const key of valueKeys) {
            if (firstRow.hasOwnProperty(key)) {
              const val = firstRow[key];
              if (val !== null && val !== undefined) {
                const parsed = parseFloat(val);
                if (!isNaN(parsed)) {
                  extractedValue = parsed;
                  break;
                }
              }
            }
          }
          if (extractedValue === null) {
            for (const key in firstRow) {
              const val = firstRow[key];
              if (val !== null && val !== undefined) {
                const parsed = parseFloat(val);
                if (!isNaN(parsed)) {
                  extractedValue = parsed;
                  break;
                }
              }
            }
          }
        }
        return { value: extractedValue, rows: rows };

      default:
        this.logger.warn(`Unhandled metric type: ${metricType}`);
        return {
          value: null,
          rows: rows,
          error: `Unhandled metric type: ${metricType}`,
        };
    }
  }

  /**
   * Query historical events from QuestDB using PG Pool
   */
  public async queryEvents(
    params: EventQueryParams
  ): Promise<EventQueryResult> {
    if (this.explicitlyClosed) {
      return {
        data: [],
        error: "Query failed: QuestDB service explicitly closed.",
      };
    }
    // Add connection checks similar to queryMetrics
    if (!this.isConnected || !this.pgPool) {
      // Simplified check - assumes reconnection handled elsewhere or fails if needed
      return {
        data: [],
        error: "QuestDB PG Pool not connected or initialized.",
      };
    }

    const { sql, values } = this.buildEventSql(params);
    this.logger.debug(
      `Executing event query: SQL=${sql}, Values=${JSON.stringify(values)}`
    );

    const pgClient = await this.pgPool.connect();
    try {
      const result: QueryResult = await pgClient.query(sql, values);
      // Return raw rows, column names match QuestDB table
      return { data: result.rows };
    } catch (error) {
      this.logger.error("Failed to query events via PG", {
        error: String(error),
        params,
      });
      this.isConnected = false; // Consider connection state management
      this.connectionErrors++;
      return {
        data: [],
        error: `Error querying events via PG: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      pgClient.release();
    }
  }

  // Helper to build SQL for querying events
  private buildEventSql(params: EventQueryParams): {
    sql: string;
    values: any[];
  } {
    const values: any[] = [];
    let paramIndex = 0;
    const conditions: string[] = [];

    paramIndex++;
    conditions.push(`merchant_id = $${paramIndex}`);
    values.push(params.merchantId);

    // Handle customer ID filtering with support for arrays
    if (params.customerId || params.externalCustomerId) {
      const customerConditions: string[] = [];

      if (params.customerId) {
        const customerIds = Array.isArray(params.customerId)
          ? params.customerId
          : [params.customerId];
        if (customerIds.length > 0) {
          const placeholders = customerIds
            .map(() => {
              paramIndex++;
              return `$${paramIndex}`;
            })
            .join(", ");
          customerConditions.push(`customer_id IN (${placeholders})`);
          values.push(...customerIds);
        }
      }

      if (params.externalCustomerId) {
        const extCustomerIds = Array.isArray(params.externalCustomerId)
          ? params.externalCustomerId
          : [params.externalCustomerId];
        if (extCustomerIds.length > 0) {
          const placeholders = extCustomerIds
            .map(() => {
              paramIndex++;
              return `$${paramIndex}`;
            })
            .join(", ");
          customerConditions.push(`ext_customer_id IN (${placeholders})`);
          values.push(...extCustomerIds);
        }
      }

      if (customerConditions.length > 0) {
        conditions.push(`(${customerConditions.join(" OR ")})`);
      }
    }

    if (params.eventName) {
      const eventNames = Array.isArray(params.eventName)
        ? params.eventName
        : [params.eventName];
      if (eventNames.length > 0) {
        const placeholders = eventNames
          .map(() => {
            paramIndex++;
            return `$${paramIndex}`;
          })
          .join(", ");
        conditions.push(`event_name IN (${placeholders})`);
        values.push(...eventNames);
      }
    }

    if (params.startDate) {
      paramIndex++;
      conditions.push(`event_timestamp >= $${paramIndex}`);
      values.push(params.startDate);
    }

    if (params.endDate) {
      paramIndex++;
      conditions.push(`event_timestamp <= $${paramIndex}`);
      values.push(params.endDate);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let sql = `SELECT * FROM events ${whereClause} ORDER BY event_timestamp DESC`;

    // QuestDB doesn't support standard OFFSET syntax in PostgreSQL wire protocol.
    // Instead, it uses LIMIT with range syntax: LIMIT lowerBound,upperBound
    // where lowerBound is exclusive and upperBound is inclusive.
    // Since limit and offset are validated integers within safe ranges, we embed them directly.

    const safeLimit =
      params.limit !== undefined && params.limit > 0 ? params.limit : undefined;
    const safeOffset =
      params.offset !== undefined && params.offset > 0
        ? params.offset
        : undefined;

    if (safeLimit !== undefined && safeOffset !== undefined) {
      // Range query: LIMIT offset,offset+limit
      // offset is exclusive, so records start from offset+1
      const upperBound = safeOffset + safeLimit;
      sql += ` LIMIT ${safeOffset},${upperBound}`;
    } else if (safeLimit !== undefined) {
      // Simple limit without offset
      sql += ` LIMIT ${safeLimit}`;
    }
    // Note: offset without limit is not supported in this implementation

    return { sql, values };
  }
}

export default QuestDbService.getInstance();
