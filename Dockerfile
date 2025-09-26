FROM oven/bun:1.2.21 AS base
WORKDIR /app

# Copy entire project context (respecting .dockerignore)
COPY . .

# Install ALL workspace dependencies (needed for linking)
# Use --frozen-lockfile for reproducible installs
# Use --ignore-scripts to prevent prepare scripts from running here (Matches Dockerfile.buildtest)
RUN bun install --frozen-lockfile --ignore-scripts

# --- Stage 2: Builder (only builds common & api) ---
FROM base AS builder
WORKDIR /app

# Source code is already copied in 'base' stage

RUN cd common && bun run clean && bun run build

RUN cd api && bun run build

# --- Stage 3: Production Runtime (API Only) ---
FROM oven/bun:1.2.21-slim AS runtime
WORKDIR /app

# Copy production dependencies and built code from builder stage
# Copy manifests first
COPY --from=builder /app/bun.lock /app/package.json ./
COPY --from=builder /app/common/package.json ./common/
COPY --from=builder /app/api/package.json ./api/

# Copy installed node_modules (contains linked workspaces + built @lumen/react)
COPY --from=builder /app/node_modules ./node_modules

# Copy entire common directory for migrations and built code
COPY --from=builder /app/common/ ./common/

# Copy built API code
COPY --from=builder /app/api/dist ./api/dist

# Copy Trigger assets (fonts for PDF generation)
COPY --from=builder /app/api/trigger/assets ./api/trigger/assets

# Create certs directory and copy the CA bundle
RUN mkdir -p /app/certs
COPY --from=builder /app/common/src/db/us-west-2-bundle.pem /app/certs/us-west-2-bundle.pem

# Ensure all Node/Bun TLS consumers trust the RDS CA bundle by default
ENV NODE_EXTRA_CA_CERTS=/app/certs/us-west-2-bundle.pem

# Set working directory to API
WORKDIR /app/api

COPY --from=builder /app/api/dist ./dist
COPY --from=builder /app/start.sh ./start.sh
RUN chmod +x start.sh

EXPOSE 8000

CMD ["bash", "start.sh"]