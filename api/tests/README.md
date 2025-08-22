# Testing Framework

## Running Tests

```bash
# Run all tests
bun test

# Run a specific test file
bun test tests/integration/merchant.test.ts

# Run all integration tests
bun test tests/integration/

# Run specific test categories
bun test tests/integration/error-handling-recovery.test.ts
bun test tests/integration/events-metrics.test.ts
bun test tests/integration/metric-cache-synchronizer.test.ts
bun test tests/integration/metric-cache-synchronizer-reconnect.test.ts

# Generate test data (choose one)
bun run data:generate:minimal --customers 2   # Creates minimal test data, 2 customers for the merchant
bun run data:generate:medium --customers 10    # Creates medium-scale demo data
bun run data:generate:large     # Creates large-scale test data
bun run data:generate:list      # List available templates
bun run data:generate:custom    # Create custom data with parameters
bun run data:generate           # Show CLI options

# Run tests while skipping API endpoint tests
SKIP_API_TESTS=true bun test
```

## Data Generation

The test framework provides a flexible data generation system with three predefined templates:

- **Minimal**: One user, organization, merchant, plan with prices, and a few customers with subscriptions
- **Medium**: Complete set of demo data with multiple plans, prices, and customers with subscriptions
- **Large-scale**: High volume of test data for performance testing, including many customers and subscriptions

### Entity Relationships

The data generation follows these relationship rules:

1. **One-to-One Relationships**:

   - Each user has one organization
   - Each organization has one merchant
   - Each customer has exactly one subscription per merchant

2. **One-to-Many Relationships**:
   - Each merchant can have multiple plans
   - Each plan can have multiple prices
   - Each merchant can have multiple customers

### Customizing Data Generation

You can customize the generation with CLI options:

```bash
# Example: Create 2 merchants, each with 3 plans, 2 prices per plan, and 5 customers
bun run data:generate:custom -- --merchants 2 --plans 3 --prices 2 --customers 5 --verbose
```

Available options:

- `--merchants <count>`: Number of merchants to create
- `--plans <count>`: Number of plans per merchant
- `--prices <count>`: Number of prices per plan
- `--customers <count>`: Number of customers per merchant (each gets one subscription)
- `--verbose`: Display detailed progress
- `--no-summary`: Hide summary output

## Test Utilities

The tests include utilities for:

- **Data Generation**: Create test entities with `createTest*` functions
- **API Testing**: Use `createTestApiClient` for Hono RPC client
- **Test Setup**: Create complete test environments with `createFullTestEnvironment`
- **Data Cleanup**: Automatic cleanup with `cleanupTestData`
- **Subscription Management**: Create and manage subscriptions with `createBasicSubscription`

## Test Categories

The test suite includes the following major categories:

### Functional Tests

- **Entity Management**: Tests for CRUD operations on core entities (merchants, customers, plans, etc.)
- **Subscription Management**: Tests for subscription lifecycle operations
- **Feature & Entitlement Management**: Tests for feature definitions and entitlement checks
- **API Key Authentication**: Tests for API key creation, validation, and security

### System Resilience Tests

- **Error Handling & Recovery**: Tests for system behavior during failures (see `error-handling-recovery.test.ts`)
- **Cache Synchronizer**: Tests for Redis cache synchronization (see `metric-cache-synchronizer.test.ts`)
- **Redis Reconnection**: Tests for Redis disconnect/reconnect behavior (see `metric-cache-synchronizer-reconnect.test.ts`)
- **Events & Metrics**: Tests for event ingestion and metric aggregation (see `events-metrics.test.ts`)
- **Multi-Tenant Isolation**: Tests for proper isolation between tenant data (see `multi-tenant-isolation.test.ts`)

### Documentation

Each test category includes documentation files explaining:
- Test approach and methodology
- Key findings and observed behavior 
- Recommendations for improvements

Example: See `ERROR_HANDLING_NOTES.md` and `ERROR_HANDLING_TESTING.md` for detailed documentation on error handling tests.

## Best Practices

- Use helper functions for test data creation
- Follow the entity creation sequence: user → org → merchant → plan → price → customer → subscription
- Keep tests independent with proper cleanup
- Use Hono RPC client for testing API endpoints
- Test both REST and RPC client patterns
- Prefer generating test data with the `data:generate` scripts
- Add new entity types to the helper structure
- Ensure each customer has exactly one subscription per merchant
- Document test approaches and key findings in companion Markdown files

## Testing with Hono

- Use `createTestApiClient()` for API client
- Use `$method` syntax for RPC calls (e.g., `$post`, `$get`)
- Pass auth token to create authenticated client
- Use type inference for better testing safety

## Adding New Entities

1. Create helper in `/helpers/data/`
2. Update types in `/helpers/types.ts`
3. Add to test config templates in `/scripts/config/`
4. Add to integration tests
5. Update the data generation script if needed
6. Update the `GeneratedEntities` interface in `generate.ts`
7. Add the entity to the summary output

## Generated Data Structure

The generated data includes:

- Users with login credentials
- Organizations linked to users
- Merchants with business details
- Plans with feature definitions
- Prices with different currencies and intervals
- Customers with metadata
- Subscriptions linking customers to plans and prices

The generation script provides a summary at the end, including sample login credentials and entity IDs for quick testing.
