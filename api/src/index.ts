// Entry point for Bun development server
import { app } from "./app";
import { env } from "./env";
import { bootstrapFeatureMetrics } from "./lib/featureMetrics";
import { bootstrapMetricDefinitions } from "./lib/metricDefinitions";
import { forceReconciliation } from "./lib/cacheSynchronizer";
import {
  initializeSSESubscriber,
  shutdownSSESubscriber,
} from "./lib/sse-manager";

const port = env.PORT;
console.log(`Starting server on port ${port}...`);

// Seed Redis cache for feature→metric mappings
console.log("[STARTUP] Starting async bootstrap operations...");
(async () => {
  console.log("Bootstrapping feature-metric cache...");
  try {
    await bootstrapFeatureMetrics();
    console.log("Feature-metric cache bootstrapped");
  } catch (error) {
    console.error("Failed to bootstrap feature-metric cache:", error);
  }
  console.log("Bootstrapping metric-definition cache...");
  try {
    await bootstrapMetricDefinitions();
    console.log("Metric-definition cache bootstrapped");
  } catch (error) {
    console.error("Failed to bootstrap metric-definition cache:", error);
  }

  // Run an initial reconciliation, but don't start a periodic interval
  // Periodic reconciliation will be handled by Trigger.dev job
  console.log("Running initial cache reconciliation...");
  forceReconciliation().catch((err) => {
    console.error("Initial cache reconciliation failed:", err);
  });

  // Initialize SSE Redis subscriber for cross-instance event broadcasting
  console.log("Initializing SSE Redis subscriber...");
  try {
    await initializeSSESubscriber();
    console.log("SSE Redis subscriber initialized");
  } catch (error) {
    console.error("Failed to initialize SSE subscriber:", error);
    console.error(
      "SSE events will only work on the same instance that handles the webhook"
    );
  }

  console.log("[STARTUP] Bootstrap function completed");
})().catch((error) => {
  console.error("[STARTUP] Bootstrap function failed:", error);
});

console.log("[STARTUP] About to start Bun server...");

// Explicitly start the server to get the server instance
const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Server listening on http://${server.hostname}:${server.port}`);

// Graceful shutdown handler to handle shutdown of ec2 containers
const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  // Clean up SSE subscriber
  try {
    await shutdownSSESubscriber();
  } catch (error) {
    console.error("Error during SSE subscriber shutdown:", error);
  }

  // The 'true' argument attempts to wait for active connections to finish
  server.stop(true);
  console.log("Server stopped.");
  // Exit after stopping. Adjust timeout if needed.
  setTimeout(() => process.exit(0), 500); // Added exit after stop
};

// Listen for termination signals
process.on("SIGINT", () => shutdown("SIGINT")); // Ctrl+C
process.on("SIGTERM", () => shutdown("SIGTERM")); // Terminate signal from OS/EB

// The Bun server itself keeps the process alive, no extra interval needed.
