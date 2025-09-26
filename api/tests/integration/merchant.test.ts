/**
 * Integration test for merchant functionality
 */
import { describe, it, expect } from "bun:test";
import {
  createTestUser,
  authenticateTestUser,
  createTestOrganization,
  createTestMerchant,
  createTestApiClient,
  createFullTestEnvironment,
} from "../test-helpers";
import { db } from "../../src/db/client";
import { merchants } from "@lumen/common/schema";
import { eq } from "drizzle-orm";
import { testEnv } from "../test-env";

describe("Merchant", () => {
  it("should create a merchant with valid data", async () => {
    // Create prerequisites
    const user = await createTestUser();
    const org = await createTestOrganization({
      userId: user.id,
      email: user.email,
      password: user.password,
    });

    // Test merchant creation
    const merchant = await createTestMerchant({
      organizationId: org.id,
      userId: user.id,
      legalName: "Test Merchant Inc",
      displayName: "Test Merchant",
    });

    // Verify the merchant was created
    expect(merchant).toBeDefined();
    expect(merchant.id).toBeDefined();
    expect(merchant.legalName).toBe("Test Merchant Inc");
    expect(merchant.organizationId).toBe(org.id);

    // Verify we can retrieve it from the database
    const retrieved = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchant.id),
    });

    expect(retrieved).toBeDefined();
    expect(retrieved?.legalName).toBe("Test Merchant Inc");
  });

  it("should create a merchant using the full environment helper", async () => {
    // Create the full test environment
    const { merchant } = await createFullTestEnvironment({
      merchantOptions: {
        legalName: "Full Environment Merchant",
      },
    });

    // Verify the merchant was created
    expect(merchant).toBeDefined();
    expect(merchant.legalName).toBe("Full Environment Merchant");

    // This test demonstrates how you can use the full environment
    // helper to set up all prerequisites in a single line
  });

  it("should authenticate a user and use their session", async () => {
    // Create prerequisites
    const { user } = await createFullTestEnvironment();

    // Authenticate the user
    const authResult = await authenticateTestUser(user.email, user.password);

    // Verify the authentication worked
    expect(authResult.session).toBeDefined();
    expect(authResult.session.token).toBeDefined();
    expect(authResult.session.userId).toBe(user.id);

    // This test demonstrates the complete flow through to authentication
    // The session token can now be used to make authenticated requests
    // to your API endpoints with Hono
  });

  it("should fetch merchant data using Hono RPC client", async () => {
    // Create user and organization first
    const user = await createTestUser({
      name: "API Test User",
      email: `api-test-${Date.now()}@example.com`,
      password: testEnv.DEV_PASSWORD,
    });

    // Authenticate the user
    const authResult = await authenticateTestUser(user.email, user.password);

    // Create API client
    const apiClient = createTestApiClient(authResult.cookies.sessionToken);

    // First create a merchant through the API
    const createResponse = await apiClient.merchants[
      "onboarding-create-merchant"
    ].$post({
      json: {
        legalName: "Test Merchant for API Testing",
        displayName: "API Test Merchant",
        addressLine1: "123 Main St",
        city: "Anytown",
        postalCode: "12345",
        country: "US",
        defaultCurrency: "USD",
        supportedCurrencies: ["USD", "EUR"],
      },
    });

    expect(createResponse.ok).toBe(true);

    const createdMerchant = await createResponse.json();
    if ("error" in createdMerchant) {
      throw new Error(`Unexpected error: ${createdMerchant.error}`);
    }
    // Then fetch the merchant using the RPC client
    const response = await apiClient.merchants[":id"].$get({
      param: {
        id: createdMerchant.id,
      },
    });

    expect(response.ok).toBe(true);

    const fetchedMerchant = await response.json();
    expect(fetchedMerchant).toBeDefined();
    expect(fetchedMerchant).not.toHaveProperty("error");
    expect(fetchedMerchant).toHaveProperty("id");
    if ("error" in fetchedMerchant) {
      // needed for type inference below
      throw new Error(`Unexpected error: ${fetchedMerchant.error}`);
    }
    expect(fetchedMerchant.id).toBe(createdMerchant.id);
    expect(fetchedMerchant.legalName).toBe("Test Merchant for API Testing");
  });
});
