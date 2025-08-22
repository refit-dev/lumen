import fs from "fs";
import { type PostgresDB, schema } from "@lumen/common";
import { env } from "../env";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

/**
 * Create a new database client with a connection URL and optional SSL config.
 */
export function createDbClient(
  connectionString: string,
  sslConfig?: Record<string, unknown>
) {
  console.log("[DB_CLIENT] Creating database client with SSL config");
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ...(sslConfig || {}),
  });
  const drizzleClient = drizzle(client, { schema });
  console.log("[DB_CLIENT] Drizzle client created");
  return drizzleClient;
}

// Define the path to the CA certificate *inside the container*
const caCertPath = "/app/certs/us-west-2-bundle.pem";
console.log("[DB_CLIENT] CA cert path defined:", caCertPath);

// --- Function to get DB credentials, adapted for API env ---
async function getDbCredentials() {
  console.log("[DB_CLIENT] Starting credential retrieval...");
  const {
    NODE_ENV,
    AWS_REGION,
    DB_HOST,
    DB_PORT,
    DB_NAME,
    DB_USER,
    DB_PASSWORD,
  } = env;

  if (NODE_ENV === "staging" || NODE_ENV === "production") {
    const secretName = `lumen/${NODE_ENV}/db-credentials`;
    console.log(
      `[DB_CLIENT] Fetching DB secret: ${secretName} in region ${AWS_REGION}`
    );
    const client = new SecretsManagerClient({ region: AWS_REGION });
    const command = new GetSecretValueCommand({ SecretId: secretName });

    try {
      const data = await client.send(command);
      if (data.SecretString) {
        const secret = JSON.parse(data.SecretString);
        console.log("[DB_CLIENT] Secret parsed successfully");
        // Combine secrets with env vars for host/port/name
        return {
          host: DB_HOST,
          port: DB_PORT,
          database: DB_NAME,
          username: secret.username, // From Secrets Manager
          password: secret.password, // From Secrets Manager
        };
      } else {
        throw new Error(`Secret string is empty for ${secretName}`);
      }
    } catch (error) {
      console.error(`[DB_CLIENT] Failed to fetch secret ${secretName}:`, error);
      throw new Error(
        `Could not retrieve database credentials from Secrets Manager: ${error}`
      );
    }
  } else {
    console.log("[DB_CLIENT] Using environment variables for credentials");
    // Local/Development/Test environment - use environment variables directly from env
    // Ensure required variables are present (env validation should handle this)
    if (!DB_USER || !DB_PASSWORD) {
      throw new Error(
        "DB_USER and DB_PASSWORD must be set in non-production environments"
      );
    }
    return {
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      username: DB_USER,
      password: DB_PASSWORD,
    };
  }
}

// --- Initialize connection using Top-Level Await ---
console.log("[DB_CLIENT] Starting database initialization...");
let creds;
try {
  // Await the credentials directly at the top level
  creds = await getDbCredentials();
  console.log(
    `[DB_CLIENT] Obtained DB credentials for: ${creds.host}:${creds.port}/${creds.database}`
  );
} catch (error) {
  console.error(
    "[DB_CLIENT] FATAL: Failed to get database credentials:",
    error
  );
  console.error(
    "[DB_CLIENT] Stack trace:",
    error instanceof Error ? error.stack : "No stack trace available"
  );
  process.exit(1); // Exit if we can't get credentials
}

// Construct connection string from resolved credentials
const connectionString = `postgres://${creds.username}:${creds.password}@${creds.host}:${creds.port}/${creds.database}`;

// Conditionally configure SSL based on API env
const sslConfig =
  env.NODE_ENV === "staging" || env.NODE_ENV === "production"
    ? {
        ssl: {
          rejectUnauthorized: true,
          ca: fs.readFileSync(caCertPath).toString(),
        },
      }
    : {}; // Empty object for local/dev/test

// Initialize and export the db client using the factory from common
console.log("[DB_CLIENT] Creating database client...");
export const db: PostgresDB = createDbClient(connectionString, sslConfig);

console.log("[DB_CLIENT] Database client initialized in API.");
