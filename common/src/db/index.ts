import {  type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

// Export the schema for use elsewhere
export { schema };

// Export the type of the database client
export type PostgresDB = PostgresJsDatabase<typeof schema>;