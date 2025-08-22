#!/bin/bash

# Ensure the script exits if any command fails
set -e

# Get the directory of the current script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Go to the project root
cd "$SCRIPT_DIR/.."

# --- Step 1: Ensure Base Dev Environment is Ready --- 
echo "Ensuring base development services (Postgres, Redis, MinIO) are running..."
bash "$SCRIPT_DIR/dev-setup.sh"

# --- Step 2: Build the Application Images --- 
echo "\nBuilding API and UI Docker images using Dockerfile..."
# This will use the 'build' sections defined in docker-compose.yml
docker compose build api-built ui-built

# --- Step 3: Start Built Application Containers --- 
echo "\nStarting containers for the built API and UI..."
# Stop them first if they are already running from a previous test
docker compose stop api-built ui-built > /dev/null 2>&1 || true 
docker compose rm -f api-built ui-built > /dev/null 2>&1 || true
# Start the new containers in detached mode
docker compose up -d api-built ui-built

echo "\nBuild and container startup completed successfully!"

# --- Step 4: Access Instructions --- 
echo "\nThe built applications are now running in Docker containers:"
echo "  Built API Server: http://localhost:8001"
echo "  Built UI/Frontend: http://localhost:3001"
echo ""
echo "Base services remain accessible:"
echo "  Postgres (via host): localhost:5432"
echo "  Redis (via host):    localhost:6379"
echo "  MinIO Console:     http://localhost:9001"
echo "  pgAdmin:           http://localhost:5050"
echo ""
