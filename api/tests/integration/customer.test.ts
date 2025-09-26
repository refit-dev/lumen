import {
  describe,
  it,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  expect,
} from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  cleanupDataFull,
} from "../test-helpers";
import { Customer } from "../test-helpers/types";
import { createTestCustomer } from "../test-helpers/data/customer";
import { createId, createPrefixedId, ID_PREFIXES } from "@lumen/common";

describe("Customers API", () => {
  let merchantId: string;
  let sessionToken: string;
  let testCustomer: Customer;

  beforeAll(async () => {
    // Do a full cleanup before any tests run
    await cleanupDataFull({ deleteTestSetupData: true });
  });

  afterAll(async () => {
    // Full cleanup after all tests are done
    await cleanupDataFull({ deleteTestSetupData: true });
  });

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create a test customer
    testCustomer = await createTestCustomer({
      merchantId,
      email: `customer-${Date.now()}@example.com`,
      name: "Test Customer",
    });
  });

  afterEach(async () => {
    // Cleanup all DB data after each test for isolation
    await cleanupDataFull({ deleteTestSetupData: true });
  });

  it("should list all customers for a merchant", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a second customer
    await createTestCustomer({
      merchantId,
      email: `customer-2-${Date.now()}@example.com`,
      name: "Second Test Customer",
    });

    // List all customers
    const response = await apiClient.customers.$get();

    expect(response.status).toBe(200);

    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }

    expect(body.customers).toBeDefined();
    expect(Array.isArray(body.customers)).toBe(true);
    expect(body.customers.length).toBeGreaterThanOrEqual(2);

    // Verify both customers are in the list
    const customerEmails = body.customers.map((c) => c.email);
    expect(customerEmails).toContain(testCustomer.email);
  });

  it("should get a specific customer by ID", async () => {
    const apiClient = createTestApiClient(sessionToken);

    const response = await apiClient.customers[":id"].$get({
      param: { id: testCustomer.id },
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }

    expect(body.customer).toBeDefined();
    expect(body.customer.id).toBe(testCustomer.id);
    expect(body.customer.email).toBe(testCustomer.email);
    expect(body.customer.name).toBe(testCustomer.name);
  });

  it("should create a new customer", async () => {
    const apiClient = createTestApiClient(sessionToken);

    const newCustomerData = {
      email: `new-customer-${Date.now()}@example.com`,
      name: "New Test Customer",
      metadata: {
        company: "Test Corp",
        plan: "enterprise",
      },
    };

    const response = await apiClient.customers.$post({
      json: newCustomerData,
    });

    expect(response.status).toBe(201);

    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }

    const createdCustomer = body.customer;
    expect(createdCustomer).toBeDefined();
    expect(createdCustomer.email).toBe(newCustomerData.email);
    expect(createdCustomer.name).toBe(newCustomerData.name);
    expect(createdCustomer.metadata as Record<string, unknown>).toEqual(
      newCustomerData.metadata
    );
    expect(createdCustomer.merchantId).toBe(merchantId);
  });

  it("should prevent creating a customer with duplicate email", async () => {
    const apiClient = createTestApiClient(sessionToken);

    const duplicateEmail = "failing-duplicated-email@example.com";

    await apiClient.customers.$post({
      json: {
        email: duplicateEmail,
        name: "Duplicate Customer 1",
      },
    });
    const response = await apiClient.customers.$post({
      json: {
        email: duplicateEmail,
        name: "Duplicate Customer 2",
      },
    });

    expect(response.status).toBe(409);
  });

  it("should allow creating customers with duplicate emails when dangerouslyAllowSameEmailForDifferentCustomers is true", async () => {
    const apiClient = createTestApiClient(sessionToken);

    const duplicateEmail = "working-duplicated-email@example.com";

    await apiClient.customers.$post({
      json: {
        email: duplicateEmail,
        name: "Duplicate Customer 1",
      },
    });
    const response = await apiClient.customers.$post({
      json: {
        email: duplicateEmail,
        name: "Duplicate Customer 2",
        dangerouslyAllowSameEmailForDifferentCustomers: true,
      },
    });

    expect(response.status).toBe(201);
  });

  it("should prevent creating a customer without email", async () => {
    const apiClient = createTestApiClient(sessionToken);

    const response = await apiClient.customers.$post({
      json: {
        name: "No Email Customer",
      },
    });

    expect(response.status).toBe(400);
  });

  it("should allow creating a customer without email when dangerouslyAllowCustomerWithoutEmail is true", async () => {
    const apiClient = createTestApiClient(sessionToken);

    const response = await apiClient.customers.$post({
      json: {
        name: "No Email Customer",
        dangerouslyAllowCustomerWithoutEmail: true,
      },
    });

    expect(response.status).toBe(201);
  });

  it("should update an existing customer", async () => {
    const apiClient = createTestApiClient(sessionToken);

    const updateData = {
      name: "Updated Customer Name",
      metadata: {
        updated: true,
        timestamp: Date.now(),
      },
    };

    const response = await apiClient.customers[":id"].$post({
      param: { id: testCustomer.id },
      json: updateData,
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }

    const updatedCustomer = body.customer;
    expect(updatedCustomer).toBeDefined();
    expect(updatedCustomer.id).toBe(testCustomer.id);
    expect(updatedCustomer.email).toBe(testCustomer.email); // Email should not change
    expect(updatedCustomer.name).toBe(updateData.name);
    expect(updatedCustomer.metadata as Record<string, unknown>).toEqual(
      updateData.metadata
    );
  });

  it("should prevent updating customer email to an existing one", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a second customer
    const secondCustomer = await createTestCustomer({
      merchantId,
      email: `customer-3-${Date.now()}@example.com`,
      name: "Second Customer",
    });

    // Try to update testCustomer's email to match secondCustomer's email
    const response = await apiClient.customers[":id"].$post({
      param: { id: testCustomer.id },
      json: {
        email: secondCustomer.email!,
      },
    });

    expect(response.status).toBe(409);

    const body = await response.json();
    if (!("error" in body)) {
      throw new Error("Expected error response");
    }
    expect(body.error).toBe(
      "Another customer with this email already exists. Use dangerouslyAllowSameEmailForDifferentCustomers to allow."
    );
  });

  it("should delete a customer", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Delete the test customer
    const response = await apiClient.customers[":id"].$delete({
      param: { id: testCustomer.id },
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }
    expect(body.success).toBe(true);

    // Verify the customer is deleted by trying to fetch it
    const getResponse = await apiClient.customers[":id"].$get({
      param: { id: testCustomer.id },
    });

    expect(getResponse.status).toBe(404);
  });

  it("should handle non-existent customer IDs", async () => {
    const apiClient = createTestApiClient(sessionToken);

    const nonExistentId = createPrefixedId(ID_PREFIXES.customer);

    // Try to get non-existent customer
    const getResponse = await apiClient.customers[":id"].$get({
      param: { id: nonExistentId },
    });
    expect(getResponse.status).toBe(404);

    // Try to update non-existent customer
    const updateResponse = await apiClient.customers[":id"].$post({
      param: { id: nonExistentId },
      json: { name: "New Name" },
    });
    expect(updateResponse.status).toBe(404);

    // Try to delete non-existent customer
    const deleteResponse = await apiClient.customers[":id"].$delete({
      param: { id: nonExistentId },
    });
    expect(deleteResponse.status).toBe(404);
  });

  it("should enforce merchant isolation", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Create a second merchant and customer
    const { merchant: otherMerchant } = await createFullTestEnvironment();
    const otherCustomer = await createTestCustomer({
      merchantId: otherMerchant.id,
      email: `other-merchant-customer-${Date.now()}@example.com`,
      name: "Other Merchant Customer",
    });

    // Try to access other merchant's customer
    const getResponse = await apiClient.customers[":id"].$get({
      param: { id: otherCustomer.id },
    });
    expect(getResponse.status).toBe(404);

    // Try to update other merchant's customer
    const updateResponse = await apiClient.customers[":id"].$post({
      param: { id: otherCustomer.id },
      json: { name: "Hacked Name" },
    });
    expect(updateResponse.status).toBe(404);

    // Try to delete other merchant's customer
    const deleteResponse = await apiClient.customers[":id"].$delete({
      param: { id: otherCustomer.id },
    });
    expect(deleteResponse.status).toBe(404);
  });
});
