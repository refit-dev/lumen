import { describe, it, expect, beforeAll } from "bun:test";
import {
  createFullTestEnvironment,
  createTestFeature,
  createTestFeatures,
  createAuthenticatedClient,
} from "../test-helpers";
import { db } from "../../src/db/client";
import { eq } from "drizzle-orm";
import { features, FeatureType } from "@lumen/common/schema";
import type { FeatureSelect } from "../test-helpers/types";
import { ClientType } from "../test-helpers/api/client";

// Define a FeatureResponse type for API responses
interface FeatureResponse {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  featureValue: boolean | number | string;
  merchantId: string;
  isOverrideFeature: boolean | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  featureType: "string" | "number" | "boolean";
}

describe("Features API", () => {
  let client: ClientType;
  let testMerchantId: string;
  let createdFeatures: FeatureSelect[] = [];

  // Setup environment before tests
  beforeAll(async () => {
    // Create test environment with merchant
    const { user, merchant } = await createFullTestEnvironment();
    testMerchantId = merchant.id;

    // Create an authenticated client
    client = await createAuthenticatedClient(user.email, user.password);

    // Create some test features
    createdFeatures = await createTestFeatures(testMerchantId, 5, [
      {
        slug: "api-access",
        displayName: "API Access",
        description: "Access to API endpoints",
        featureValue: true,
      },
      {
        slug: "storage-limit",
        displayName: "Storage Limit",
        description: "Storage limit in gigabytes",
        featureValue: 100,
      },
      {
        slug: "team-members",
        displayName: "Team Members",
        description: "Number of team members allowed",
        featureValue: 5,
      },
      {
        slug: "support-tier",
        displayName: "Support Tier",
        description: "Level of support provided",
        featureValue: "standard",
      },
      {
        slug: "white-labeling",
        displayName: "White Labeling",
        description: "Ability to white label the product",
        featureValue: false,
      },
    ]);
  });

  it("should list all features", async () => {
    const response = await client.features.$get();

    expect(response.status).toBe(200);
    const data = await response.json();

    // Should have features array
    expect(data).toHaveProperty("features");
    if ("error" in data) {
      throw new Error(`Expected features but got error: ${data.error}`);
    }
    expect(Array.isArray(data.features)).toBe(true);

    // Cast the response to the expected type
    const features = data.features as unknown as FeatureResponse[];

    // Should include at least the 5 we created
    expect(features.length).toBeGreaterThanOrEqual(5);

    // All created features should be in the response
    const featureSlugs = createdFeatures.map((f) => f.slug);
    const responseSlugs = features.map((f) => f.slug);

    featureSlugs.forEach((slug) => {
      expect(responseSlugs).toContain(slug);
    });

    // Should include proper type information
    const apiAccess = features.find((f) => f.slug === "api-access");
    expect(apiAccess?.featureType).toBe("boolean");

    const storageLimit = features.find((f) => f.slug === "storage-limit");
    expect(storageLimit?.featureType).toBe("number");

    const supportTier = features.find((f) => f.slug === "support-tier");
    expect(supportTier?.featureType).toBe("string");
  });

  it("should create a new feature", async () => {
    const newFeature = {
      slug: `test-feature-${Date.now()}`,
      displayName: "Test Feature",
      description: "A test feature",
      featureValue: true,
    };

    const response = await client.features.$post({
      json: newFeature,
    });

    expect(response.status).toBe(201);
    const data = await response.json();

    if ("error" in data) {
      throw new Error(`Expected feature but got error: ${data.error}`);
    }

    expect(data.feature).toHaveProperty("id");
    expect(data.feature.slug).toBe(newFeature.slug);
    expect(data.feature.displayName).toBe(newFeature.displayName);
    expect(data.feature.description).toBe(newFeature.description);
    expect(data.feature.featureValue).toBe(newFeature.featureValue);
    expect(data.feature.merchantId).toBe(testMerchantId);
    expect(data.feature.featureType).toBe("boolean");

    // Verify feature was created in database
    const dbFeature = await db.query.features.findFirst({
      where: eq(features.slug, newFeature.slug),
    });

    expect(dbFeature).not.toBeNull();
    expect(dbFeature?.id).toBe(data.feature.id);
  });

  it("should get a specific feature by ID", async () => {
    const featId = createdFeatures[0].id;
    const response = await client.features[":featureId"].$get({
      param: { featureId: featId },
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    if ("error" in data) {
      throw new Error(`Expected feature but got error: ${data.error}`);
    }

    expect(data.feature).toHaveProperty("id", featId);
    expect(data.feature).toHaveProperty("slug", createdFeatures[0].slug);
    expect(data.feature).toHaveProperty("featureType");
  });

  it("should update an existing feature", async () => {
    const featId = createdFeatures[1].id;
    const updateData = {
      displayName: "Updated Feature Name",
      description: "Updated feature description",
    };

    const response = await client.features[":featureId"].$put({
      param: { featureId: featId },
      json: updateData,
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    if ("error" in data) {
      throw new Error(`Expected feature but got error: ${data.error}`);
    }

    expect(data.feature).toHaveProperty("id", featId);
    expect(data.feature.displayName).toBe(updateData.displayName);
    expect(data.feature.description).toBe(updateData.description);

    // Original values should be preserved
    expect(data.feature.slug).toBe(createdFeatures[1].slug);

    // Compare with original value as string since the JSON might transform it
    const originalValue = String(createdFeatures[1].featureValue);
    const responseValue = String(data.feature.featureValue);
    expect(responseValue).toBe(originalValue);
  });

  it("should delete a feature", async () => {
    // First create a feature to delete
    const tempFeature = await createTestFeature({
      merchantId: testMerchantId,
      slug: `temp-feature-${Date.now()}`,
      displayName: "Temporary Feature",
      description: "A feature to be deleted",
      featureValue: true,
    });

    const response = await client.features[":featureId"].$delete({
      param: { featureId: tempFeature.id },
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    if ("error" in data) {
      throw new Error(`Expected success but got error: ${data.error}`);
    }

    expect(data.success).toBe(true);

    // Feature should be soft deleted
    const dbFeature = await db.query.features.findFirst({
      where: eq(features.id, tempFeature.id),
    });

    expect(dbFeature?.deletedAt).not.toBeNull();
  });

  it("should filter features by search term", async () => {
    const searchTerm = "api";
    const response = await client.features.$get({
      query: { search: searchTerm },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    if ("error" in data) {
      throw new Error(`Expected features but got error: ${data.error}`);
    }

    // Cast the response to the expected type
    const features = data.features as unknown as FeatureResponse[];

    // All results should contain the search term in slug or displayName
    features.forEach((feature) => {
      const matchesSlug = feature.slug.includes(searchTerm);
      const matchesName = feature.displayName
        .toLowerCase()
        .includes(searchTerm.toLowerCase());
      expect(matchesSlug || matchesName).toBe(true);
    });

    // Should find our "api-access" feature
    const hasApiAccess = features.some((f) => f.slug === "api-access");
    expect(hasApiAccess).toBe(true);
  });

  it("should reject feature creation with duplicate slug", async () => {
    // Try to create a feature with an existing slug
    const duplicateFeature = {
      slug: "api-access", // Already exists
      displayName: "Duplicate API Access",
      description: "This should fail",
      featureValue: true,
      // merchantId is not needed - will be taken from auth context
    };

    const response = await client.features.$post({
      json: duplicateFeature,
    });

    expect(response.status).toBe(409); // Conflict
    const data = await response.json();
    expect(data).toHaveProperty("error");
  });

  it("should filter features by text search", async () => {
    const response = await client.features.$get({
      query: { search: "storage" },
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    if ("error" in data) {
      throw new Error(`Expected features but got error: ${data.error}`);
    }

    // Cast the response to the expected type
    const features = data.features as unknown as FeatureResponse[];

    // All results should contain "storage" in slug or displayName
    features.forEach((feature) => {
      const matchesSlug = feature.slug.toLowerCase().includes("storage");
      const matchesName = feature.displayName.toLowerCase().includes("storage");
      expect(matchesSlug || matchesName).toBe(true);
    });

    // Should find our "storage-limit" feature
    const hasStorageLimit = features.some((f) => f.slug === "storage-limit");
    expect(hasStorageLimit).toBe(true);
  });
});
