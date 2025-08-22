# Test Helpers

This directory contains helpers for test data generation, API testing, and test utilities.

## Directory Structure

```
/helpers/
├── data/                  # Entity data generators
│   ├── auth.ts            # User authentication
│   ├── organization.ts    # Organization creation
│   ├── merchant.ts        # Merchant creation
│   ├── plan.ts            # Plan creation
│   ├── price.ts           # Price creation
│   └── index.ts           # Re-exports all data generators
├── api/                   # API testing utilities
│   ├── client.ts          # API client creation
│   └── index.ts           # Re-exports all API utilities
├── test-utils/            # Test utilities
│   ├── cleanup.ts         # Data cleanup functions
│   ├── setup.ts           # Test environment setup
│   └── index.ts           # Re-exports all test utilities
├── types.ts               # Shared type definitions
└── index.ts               # Main exports file
```

## Usage

For most test cases, you can import everything from the main index file:

```typescript
import {
  createTestUser,
  createTestOrganization,
  createTestMerchant,
  createTestPlan,
  createTestPrice,
  createFullTestEnvironment,
  createTestApiClient,
} from "../helpers";
```

## Creating Test Data

Use helper functions to create test entities:

```typescript
// Create a single test entity
const user = await createTestUser();
const org = await createTestOrganization({ userId: user.id });
const merchant = await createTestMerchant({
  organizationId: org.id,
  userId: user.id,
});

// Or create a complete test environment
const { user, org, merchant } = await createFullTestEnvironment();
```

## Testing API Endpoints

Create an API client for testing:

```typescript
// Unauthenticated client
const client = createTestApiClient();

// Authenticated client
const authClient = createTestApiClient(token);

// Make API calls
const response = await authClient.plans.$get();
```
