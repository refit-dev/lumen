/**
 * Re-export all helper functions for easier imports
 *
 * COMPATIBILITY LAYER: This file re-exports functions from the new structure
 * to maintain compatibility with existing tests and scripts.
 */

// Data generators
import { createTestUser, authenticateTestUser } from "./data/auth";
import { createTestOrganization } from "./data/organization";
import { createTestMerchant } from "./data/merchant";
import {
  createTestPlan,
  createTestPlanWithPrice,
  createMultiplePlans,
} from "./data/plan";
import {
  createTestPrice,
  createMultiplePrices,
  cloneTestPrice,
} from "./data/price";
import {
  createTestMetric,
  createTestMetrics,
  deleteTestMetric,
} from "./data/metrics";
import { createTestCustomer } from "./data/customer";
import { createBasicSubscription } from "./data/subscription";
import { createTestFeature } from "./data/feature";
import {
  createTestSecretKey,
  createTestPublishableKey,
  createTestApiKeys,
} from "./data/api-keys";
import { createTestStripe } from "./data/stripe";
import { createTestEvents } from "./data/events";

// Test utilities
import { createTestEnvironment } from "./test-utils/setup";

// Export all imported types and functions
export {
  // Auth
  createTestUser,
  authenticateTestUser,

  // Organization
  createTestOrganization,

  // Merchant
  createTestMerchant,

  // Plan
  createTestPlan,
  createTestPlanWithPrice,
  createMultiplePlans,

  // Price
  createTestPrice,
  createMultiplePrices,
  cloneTestPrice,

  // Metrics
  createTestMetric,
  createTestMetrics,
  deleteTestMetric,

  // Customer
  createTestCustomer,

  // Subscription
  createBasicSubscription,

  // Feature
  createTestFeature,

  // API Keys
  createTestSecretKey,
  createTestPublishableKey,
  createTestApiKeys,

  // Stripe
  createTestStripe,

  // Events
  createTestEvents,

  // Test utilities
  createTestEnvironment as createFullTestEnvironment,
};

// Export all types
export * from "./types";

// Export all modules
export * from "./data";
export * from "./api";
export * from "./test-utils";

export * from "./data/feature";
export * from "./data/merchant";
export * from "./data/organization";
export * from "./data/plan";
export * from "./data/subscription";
export * from "./data/auth";
export * from "./data/metrics";

// Export client utilities
export * from "./api";

// Export data generators/helpers
export * from "./data/auth";
export * from "./data/metrics";
export * from "./data/events";
export * from "./data/feature";
export * from "./data/price";
export * from "./data/subscription";
export * from "./data/api-keys";
export * from "./data/plan";
export * from "./data/customer";
export * from "./data/merchant";
export * from "./data/stripe";
export * from "./data/organization";

// Export test utilities
export * from "./test-utils/setup";

// Re-export everything from individual helper files
export * from "./test-utils/questdb-helpers";

// Export types
export * from "./types";

// Provider-agnostic payment harness
export * from "./paymentProvider";
