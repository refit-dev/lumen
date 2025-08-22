#!/bin/bash

# Exit on error
set -e

# Safety check to ensure we're in a development environment
if [[ -z "${NODE_ENV}" ]] || [[ "${NODE_ENV}" == "development" ]]; then
    echo "Running in development mode..."
else
    echo " Error: This script can only be run in development mode!"
    echo "Current NODE_ENV: ${NODE_ENV}"
    exit 1
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo " Error: Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check if our development container exists and is running
if ! docker ps | grep -q "lumen-postgres"; then
    echo " Error: Development database container is not running!"
    echo "Please start the development environment first with: npm run docker:up"
    exit 1
fi

# Confirm with the user
echo "  WARNING: This will:"
echo "  1. Reset the entire development database"
echo "  2. Remove all existing migrations"
echo "  3. Generate fresh migrations from your current schema and better-auth config"
echo
echo "Database: lumen"
echo "Host: localhost:5432"
read -p "Are you sure you want to proceed? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Operation cancelled."
    exit 1
fi

echo "  Resetting development database..."

# First, terminate all connections to the database
docker exec lumen-postgres psql -U lumen -d postgres -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = 'lumen' AND pid <> pg_backend_pid();"

# Now drop and recreate the database
docker exec lumen-postgres psql -U lumen -d postgres -c "DROP DATABASE IF EXISTS lumen;"
docker exec lumen-postgres psql -U lumen -d postgres -c "CREATE DATABASE lumen OWNER lumen;"

if [ $? -eq 0 ]; then
    echo "✅ Development database has been reset successfully!"

    echo "🔄 Generating better-auth schema..."
    yes | bun run better-auth:generate-schema # yes is needed to avoid prompt

    echo "💡 Generating and applying migration..."
    bun run db:generate
    bun run db:migrate

    # Reset QuestDB schema for events table (dev)
    echo "🔄 Resetting QuestDB schema..."
    echo "  Dropping existing events table..."
    cd common
    curl -G --user "admin:quest" --data-urlencode "query=DROP TABLE IF EXISTS events;" http://localhost:9010/exec || {
        echo "❌ Failed to drop events table in QuestDB!"
        exit 1
    }
    echo "  ✓ Events table dropped successfully"

    echo "  Creating new events table..."
    curl -G --user "admin:quest" --data-urlencode "query@src/questdb/migrations/0001_initial_schema.sql" http://localhost:9010/exec || {
        echo "❌ Failed to create events table in QuestDB!"
        exit 1
    }
    echo "  ✓ Events table created successfully"

    if [ $? -eq 0 ]; then
        echo "✅ Schema reset complete! Your database is now in sync with your schema files."
    else
        echo "❌ Failed to reset the database!"
        exit 1
    fi
else
    echo "❌ Failed to reset the database!"
    exit 1
fi