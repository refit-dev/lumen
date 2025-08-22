import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_fuqjpiywzklermkqrqsg",
  runtime: "node",
  logLevel: "log",
  maxDuration: 60, // Required: max compute seconds a task is allowed to run (minimum 5 seconds)
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["trigger"],
  build: {
    extensions: [
      additionalFiles({
        files: ["./trigger/assets/**"],
      }),
    ],
  },
});
