import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./migrations",
  schema: "./src/db/schema/*.ts",
  dialect: "postgresql",
  dbCredentials: { 
    // this is supplied via ENV setting in EB postdeploy hook
    // on dev, this ENV VAR is set in common/.env
    url: process.env.DATABASE_URL!,
  },
});
