import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// For CLI migrations
const connectionString = `postgres://${process.env.POSTGRES_USER || "lumen"}:${
  process.env.POSTGRES_PASSWORD || "lumen_local"
}@${process.env.POSTGRES_HOST || "localhost"}:${
  process.env.POSTGRES_PORT || 5432
}/${process.env.POSTGRES_DB || "lumen"}`;

const runMigration = async () => {
  const migrationClient = postgres(connectionString, { max: 1 });
  const db = drizzle(migrationClient);

  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations completed successfully!");

  // Close the connection
  await migrationClient.end();
  process.exit(0);
};

runMigration().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
