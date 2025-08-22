#!/bin/bash

# Function to check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo "Docker is not running. Please start Docker and try again."
        exit 1
    fi
}

# Function to check if containers are running and healthy
check_containers() {
    if docker ps -q -f name=lumen-postgres >/dev/null 2>&1 && \
       docker ps -q -f name=lumen-minio >/dev/null 2>&1 && \
       docker ps -q -f name=lumen-redis >/dev/null 2>&1 && \
       docker ps -q -f name=lumen-questdb >/dev/null 2>&1; then
        # Check if containers are healthy
        if [[ "$(docker inspect -f {{.State.Health.Status}} lumen-postgres 2>/dev/null)" == "healthy" ]] && \
           [[ "$(docker inspect -f {{.State.Health.Status}} lumen-minio 2>/dev/null)" == "healthy" ]] && \
           [[ "$(docker inspect -f {{.State.Health.Status}} lumen-redis 2>/dev/null)" == "healthy" ]] && \
           [[ "$(docker inspect -f {{.State.Health.Status}} lumen-questdb 2>/dev/null)" == "healthy" ]]; then
            return 0  # Containers are running and healthy
        fi
    fi
    return 1  # Containers are not running or not healthy
}

# Function to wait for containers to be healthy
wait_for_containers() {
    echo "Waiting for containers to be ready..."
    while [[ "$(docker inspect -f {{.State.Health.Status}} lumen-postgres 2>/dev/null)" != "healthy" ]] || \
          [[ "$(docker inspect -f {{.State.Health.Status}} lumen-minio 2>/dev/null)" != "healthy" ]] || \
          [[ "$(docker inspect -f {{.State.Health.Status}} lumen-redis 2>/dev/null)" != "healthy" ]] || \
          [[ "$(docker inspect -f {{.State.Health.Status}} lumen-questdb 2>/dev/null)" != "healthy" ]]; do
        echo -n "."
        sleep 1
    done
    echo -e "\nAll containers are ready!"
}

# Check if Docker is running
check_docker

# Check if containers are already running and healthy
if check_containers; then
    echo "Development containers are already running and healthy!"
else
    # Stop any existing containers without removing volumes
    echo "Stopping any existing containers..."
    docker compose down > /dev/null 2>&1

    # Start containers
    echo "Starting development containers (postgres, minio, redis, pgadmin, questdb)..."
    # Explicitly list the services to start for the dev environment
    docker compose up -d postgres minio redis pgadmin questdb

    # Wait for containers to be healthy
    wait_for_containers
fi

echo "Development environment is ready!"
echo "- API will be available at: http://localhost:8000"
echo "- Frontend will be available at: http://localhost:3000"
echo "- pgAdmin is available at: http://localhost:5050"
echo "- MinIO Console is available at: http://localhost:9001"
echo "- QuestDB Web Console is available at: http://localhost:9010"