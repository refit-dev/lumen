#!/usr/bin/env bash
set -e

# Start the API server
bun run dist/index.js &

# Start the event persistence worker
bun run dist/local-workers/event-persistence.js &

# Wait for all background processes
wait