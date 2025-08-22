#!/usr/bin/env bun

import { serve } from "bun";

try {
  // Get the path from command line arguments
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun redirect-webhook-with-path.ts <path>");
    console.error(
      "Example: bun redirect-webhook-with-path.ts /webhooks/stripe"
    );
    process.exit(1);
  }

  const redirectPath = args[0];
  const targetUrl = `http://localhost:8000${redirectPath}`;

  console.log(`Starting redirect server on port 8001`);
  console.log(`All requests will be redirected to: ${targetUrl}`);

  const server = serve({
    port: 8001,
    async fetch(request) {
      try {
        // Log the incoming request
        console.log(
          `[${new Date().toISOString()}] ${request.method} ${request.url} -> ${targetUrl}`
        );

        // Forward the request to the target URL
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });

        // Log the response status
        console.log(
          `[${new Date().toISOString()}] Response: ${response.status} ${response.statusText}`
        );

        return response;
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] Error forwarding request:`,
          error
        );
        return new Response("Internal Server Error", { status: 500 });
      }
    },
  });

  console.log(`✅ Redirect server running on http://localhost:${server.port}`);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down redirect server...");
    server.stop();
    process.exit(0);
  });
} catch (error) {
  console.error("Error starting redirect server:", error);
  process.exit(1);
}
