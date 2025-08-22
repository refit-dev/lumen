import { describe, it, beforeEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlan,
  createTestPrice,
  createTestApiClient,
} from "../test-helpers";
import { PlanSelect, PriceSelect } from "../test-helpers/types";
import {
  PriceDSLSchemaType,
  FixedPriceComponentSchemaType,
  UsageBasedPriceComponentSchemaType,
} from "@lumen/common/validators";

describe("Prices API", () => {
  let merchantId: string;
  let token: string;
  let createdPlan: PlanSelect;
  let createdPrice: PriceSelect;

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    token = authResponse.cookies.sessionToken;

    // Create a test plan for this merchant
    createdPlan = await createTestPlan({
      merchantId,
      planName: "Standard Plan",
      planDescription: "Perfect for small businesses",
      stablePlanId: `plan_${Date.now()}`,
      versionNumber: 1,
    });

    // Create a price for this plan
    createdPrice = await createTestPrice({
      planId: createdPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly-base-fee",
            type: "fixed" as const,
            label: "Monthly Subscription Fee",
            amount_cents: 2900,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });
  });

  it("should list all prices for a plan", async () => {
    // Create a client with auth
    const client = createTestApiClient(token);

    // Fetch prices filtered by plan ID
    const response = await client.prices.$get({
      query: { planId: createdPlan.id },
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.prices).toBeDefined();
    expect(Array.isArray(body.prices)).toBe(true);
    expect(body.prices.length).toBeGreaterThanOrEqual(1);

    // Verify our price is in the list
    const foundPrice = body.prices.find((p) => p.id === createdPrice.id);
    expect(foundPrice).toBeDefined();
    expect(foundPrice?.currency).toBe("USD");
    // Instead of checking billingInterval, verify the price has valid components
    expect(foundPrice?.pricingData?.components).toBeInstanceOf(Array);
  });

  it("should get a specific price by ID", async () => {
    const client = createTestApiClient(token);

    // Call the API to get a specific price
    const response = await client.prices[":priceId"].$get({
      param: { priceId: createdPrice.id },
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.price).toBeDefined();
    expect(body.price.id).toBe(createdPrice.id);
    expect(body.price.planId).toBe(createdPlan.id);
    expect(body.price.currency).toBe("USD");
    // Check the specific amount in the first component
    const component = body.price.pricingData.components[0];
    if ("amount_cents" in component) {
      expect(component.amount_cents).toBe(2900);
    }
  });

  it("should create a new price", async () => {
    const client = createTestApiClient(token);

    // Create new price data
    const newPriceData = {
      planId: createdPlan.id,
      currency: "EUR",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "yearly-subscription",
            type: "fixed" as const,
            label: "Annual Subscription Fee",
            amount_cents: 29900,
            recurrence_rule: "RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    };

    // Call the API to create a price
    const response = await client.prices.$post({
      json: newPriceData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.price).toBeDefined();
    expect(body.price.planId).toBe(createdPlan.id);
    expect(body.price.currency).toBe("EUR");
    // Check the specific amount in the first component
    const component = body.price.pricingData.components[0];
    if ("amount_cents" in component) {
      expect(component.amount_cents).toBe(29900);
    }
  });

  it("should delete a price", async () => {
    const client = createTestApiClient(token);

    // Call the API to delete the price
    const response = await client.prices[":priceId"].$delete({
      param: { priceId: createdPrice.id },
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    // Try to get the deleted price
    const getResponse = await client.prices[":priceId"].$get({
      param: { priceId: createdPrice.id },
    });

    // Should return 404
    expect(getResponse.status).toBe(404);
  });

  it("should clone a price", async () => {
    const client = createTestApiClient(token);

    // Create clone modifications
    const cloneData = {
      planId: createdPlan.id, // Same plan
      currency: "EUR", // Change currency
      pricingData: {
        // Modify pricing data
        dsl_version: 1,
        components: [
          {
            component_name: "cloned-yearly-subscription",
            type: "fixed" as const,
            label: "Annual Subscription Fee (Cloned)",
            amount_cents: 29900,
            recurrence_rule: "RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    };

    // Call the API to clone the price
    const response = await client.prices.clone[":priceId"].$post({
      param: { priceId: createdPrice.id },
      json: cloneData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.price).toBeDefined();
    expect(body.price.planId).toBe(createdPlan.id);
    expect(body.price.currency).toBe("EUR");
    // Check the specific amount in the first component
    const component = body.price.pricingData.components[0];
    if ("amount_cents" in component) {
      expect(component.amount_cents).toBe(29900);
    }
    expect(body.price.clonedFromPriceId).toBe(createdPrice.id);
  });

  it("should create a price with an override flag", async () => {
    const client = createTestApiClient(token);

    // Create a price with override flag
    const overridePriceData = {
      planId: createdPlan.id,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "custom-override-fee",
            type: "fixed" as const,
            label: "Custom Fee (Override)",
            amount_cents: 1999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
      isOverridePrice: true,
    };

    // Call the API to create a price
    const response = await client.prices.$post({
      json: overridePriceData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.price).toBeDefined();
    expect(body.price.isOverridePrice).toBe(true); // Should now respect the isOverridePrice flag
    expect(body.price.planId).toBe(createdPlan.id);
    expect(body.price.currency).toBe("USD");
    // Check the specific amount in the first component
    const component = body.price.pricingData.components[0];
    if ("amount_cents" in component) {
      expect(component.amount_cents).toBe(1999);
    }
  });

  it("should batch clone multiple prices to a new plan", async () => {
    const client = createTestApiClient(token);

    // Create a second price for the plan
    const secondPrice = await createTestPrice({
      planId: createdPlan.id,
      merchantId,
      currency: "EUR",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "eur-yearly-fee",
            type: "fixed" as const,
            label: "Annual Fee (EUR)",
            amount_cents: 29900,
            recurrence_rule: "RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    });

    // Create a new plan to clone prices to
    const newPlan = await createTestPlan({
      merchantId,
      planName: "Premium Plan",
      planDescription: "Advanced features for power users",
      stablePlanId: `premium_${Date.now()}`,
      versionNumber: 1,
    });

    // Clone both prices to the new plan
    const clonePromises = [createdPrice.id, secondPrice.id].map((priceId) =>
      client.prices.clone[":priceId"].$post({
        param: { priceId },
        json: { planId: newPlan.id },
      })
    );

    const responses = await Promise.all(clonePromises);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    const clonedPrices = bodies.map((body) => {
      if ("error" in body) {
        throw new Error(`Failed to clone price: ${body.error}`);
      }
      return body.price;
    });

    // Verify the response
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(clonedPrices.length).toBe(2);

    // Verify the cloned prices have the correct plan ID and references
    expect(clonedPrices[0].planId).toBe(newPlan.id);
    expect(clonedPrices[1].planId).toBe(newPlan.id);

    // Check that both prices were cloned with proper references
    const clonedUsdPrice = clonedPrices.find((p) => p.currency === "USD");
    const clonedEurPrice = clonedPrices.find((p) => p.currency === "EUR");

    expect(clonedUsdPrice).toBeDefined();
    expect(clonedEurPrice).toBeDefined();

    if (!clonedUsdPrice || !clonedEurPrice) {
      throw new Error("Expected both USD and EUR prices to be present");
    }

    // Verify original price IDs are referenced
    const originalPriceIds = [createdPrice.id, secondPrice.id];
    expect(originalPriceIds).toContain(clonedUsdPrice.clonedFromPriceId);
    expect(originalPriceIds).toContain(clonedEurPrice.clonedFromPriceId);
  });

  it("should automatically generate component IDs when not provided", async () => {
    const client = createTestApiClient(token);

    // Create a new price using component_name instead of component_id
    const priceData = {
      planId: createdPlan.id,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly-subscription-fee",
            type: "fixed" as const,
            label: "Auto-generated Fixed Component",
            amount_cents: 5000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
          {
            component_name: "per-user-fee",
            type: "per_unit" as const,
            label: "Auto-generated Per-Unit Component",
            unit_label: "User",
            amount_cents: 1000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
          {
            component_name: "api-usage-fee",
            type: "usage" as const,
            label: "Auto-generated Usage Component",
            unit_label: "API call",
            metric_id: "met_" + Date.now(),
            unit_cost_cents: 1,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    };

    // Call the API to create a price
    const response = await client.prices.$post({
      json: priceData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.price).toBeDefined();

    // Verify component IDs were auto-generated with the correct prefixes
    const components = body.price.pricingData.components;
    expect(components.length).toBe(3);

    // Check fixed component
    expect(components[0].type).toBe("fixed");
    expect(components[0].component_id).toMatch(/^price_comp_fix_/);

    // Check per_unit component
    expect(components[1].type).toBe("per_unit");
    expect(components[1].component_id).toMatch(/^price_comp_unit_/);

    // Check usage component
    expect(components[2].type).toBe("usage");
    expect(components[2].component_id).toMatch(/^price_comp_usage_/);

    // Verify all component IDs are unique
    const componentIds = components.map((c) => c.component_id);
    const uniqueIds = new Set(componentIds);
    expect(uniqueIds.size).toBe(3);
  });
});

describe("Multiple Price Components", () => {
  let merchantId: string;
  let token: string;
  let createdPlan: PlanSelect;

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    token = authResponse.cookies.sessionToken;

    // Create a test plan for this merchant
    createdPlan = await createTestPlan({
      merchantId,
      planName: "Multi-Component Plan",
      planDescription: "Plan for testing multiple price components",
      stablePlanId: `multi_comp_plan_${Date.now()}`,
      versionNumber: 1,
    });
  });

  it("should create a price with multiple component types", async () => {
    const client = createTestApiClient(token);

    // Create price with multiple components: fixed, per_unit, and usage
    const priceData = {
      planId: createdPlan.id,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base-subscription",
            type: "fixed" as const,
            label: "Monthly Base Subscription",
            amount_cents: 2999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
          {
            component_name: "per-user-fee",
            type: "per_unit" as const,
            label: "Per User Fee",
            unit_label: "User",
            amount_cents: 999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: false,
          },
          {
            component_name: "api-calls",
            type: "usage" as const,
            label: "API Calls",
            unit_label: "API Call",
            metric_id: "met_" + Date.now(),
            unit_cost_cents: 1,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
            bill_immediately: false,
          },
        ],
      },
    };

    // Call the API to create a price
    const response = await client.prices.$post({
      json: priceData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.price).toBeDefined();
    expect(body.price.planId).toBe(createdPlan.id);
    expect(body.price.currency).toBe("USD");

    // Validate the price DSL structure
    const components = body.price.pricingData.components;
    expect(components.length).toBe(3);

    // Check fixed component
    const fixedComponent = components.find((c) => c.type === "fixed");
    expect(fixedComponent).toBeDefined();
    if (!fixedComponent) {
      throw new Error("Fixed component not found");
    }
    expect(fixedComponent.amount_cents).toBe(2999);
    expect(fixedComponent.recurrence_rule).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=1"
    );
    expect(fixedComponent.component_id).toMatch(/^price_comp_fix_/);

    // Check per_unit component
    const perUnitComponent = components.find((c) => c.type === "per_unit");
    expect(perUnitComponent).toBeDefined();
    if (!perUnitComponent) {
      throw new Error("Per-unit component not found");
    }
    expect(perUnitComponent.amount_cents).toBe(999);
    expect(perUnitComponent.unit_label).toBe("User");
    expect(perUnitComponent.component_id).toMatch(/^price_comp_unit_/);

    // Check usage component
    const usageComponent = components.find((c) => c.type === "usage");
    expect(usageComponent).toBeDefined();
    if (!usageComponent) {
      throw new Error("Usage component not found");
    }
    expect(usageComponent.unit_cost_cents).toBe(1);
    expect(usageComponent.metric_id).toBeDefined();
    expect(usageComponent.unit_label).toBe("API Call");
    expect(usageComponent.component_id).toMatch(/^price_comp_usage_/);
    expect(usageComponent.recurrence_rule).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=15"
    );
  });

  it("should create a price with components having different billing cycles", async () => {
    const client = createTestApiClient(token);

    // Create price with components on different billing cycles
    const priceData = {
      planId: createdPlan.id,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly-base",
            type: "fixed" as const,
            label: "Monthly Base Fee",
            amount_cents: 1999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
          {
            component_name: "quarterly-service",
            type: "fixed" as const,
            label: "Quarterly Service Fee",
            amount_cents: 4999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15",
            bill_immediately: false,
          },
          {
            component_name: "yearly-support",
            type: "fixed" as const,
            label: "Annual Support",
            amount_cents: 14999,
            recurrence_rule: "RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    };

    // Call the API to create a price
    const response = await client.prices.$post({
      json: priceData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${JSON.stringify(body.error)}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.price).toBeDefined();

    // Validate the price DSL structure
    const components = body.price.pricingData.components;
    expect(components.length).toBe(3);

    // Find components by name
    const monthlyComponent = components.find(
      (c) => c.component_name === "monthly-base"
    );
    const quarterlyComponent = components.find(
      (c) => c.component_name === "quarterly-service"
    );
    const yearlyComponent = components.find(
      (c) => c.component_name === "yearly-support"
    );

    // Verify components are present
    expect(monthlyComponent).toBeDefined();
    if (!monthlyComponent) {
      throw new Error("Monthly component not found");
    }
    expect(quarterlyComponent).toBeDefined();
    if (!quarterlyComponent) {
      throw new Error("Quarterly component not found");
    }
    expect(yearlyComponent).toBeDefined();
    if (!yearlyComponent) {
      throw new Error("Yearly component not found");
    }

    // Verify recurrence rules
    expect(monthlyComponent.recurrence_rule).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=1"
    );
    expect(quarterlyComponent.recurrence_rule).toBe(
      "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15"
    );
    expect(yearlyComponent.recurrence_rule).toBe(
      "RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1"
    );
  });

  it("should create a zero price (free plan pricing)", async () => {
    const client = createTestApiClient(token);

    // Create a completely free price
    const freePriceData = {
      planId: createdPlan.id,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "free-tier",
            type: "fixed" as const,
            label: "Free Tier",
            amount_cents: 0,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    };

    const response = await client.prices.$post({
      json: freePriceData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create free price: ${body.error}`);
    }

    expect(response.status).toBe(200);
    expect(
      (body.price.pricingData.components[0] as FixedPriceComponentSchemaType)
        .amount_cents
    ).toBe(0);
    expect(body.price.pricingData.components[0].type).toBe("fixed");
  });

  it("should validate price data correctly", async () => {
    const client = createTestApiClient(token);

    // Test with invalid price data (missing required fields)
    const invalidPriceData = {
      planId: createdPlan.id,
      // Missing currency and pricingData
    };

    const response = await client.prices.$post({
      json: invalidPriceData as any,
    });

    expect(response.status).toBe(400);
  });

  it("should handle invalid price ID retrieval", async () => {
    const client = createTestApiClient(token);

    const response = await client.prices[":priceId"].$get({
      param: { priceId: "price_invalid_id_123" },
    });

    // Should return 400 for invalid ID format, not 404
    expect(response.status).toBe(400);
  });

  it("should create usage-based pricing", async () => {
    const client = createTestApiClient(token);

    const usagePriceData = {
      planId: createdPlan.id,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "api-usage",
            type: "usage" as const,
            label: "API Usage",
            unit_label: "API Call",
            metric_id: "met_" + Date.now(),
            unit_cost_cents: 10,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: false,
          },
        ],
      },
    };

    const response = await client.prices.$post({
      json: usagePriceData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create usage price: ${body.error}`);
    }

    expect(response.status).toBe(200);
    expect(body.price.pricingData.components[0].type).toBe("usage");
    expect(
      (
        body.price.pricingData
          .components[0] as UsageBasedPriceComponentSchemaType
      ).unit_cost_cents
    ).toBe(10);
    expect(
      (
        body.price.pricingData
          .components[0] as UsageBasedPriceComponentSchemaType
      ).metric_id
    ).toBeDefined();
  });
});

describe("Basic Price Operations", () => {
  let merchantId: string;
  let token: string;
  let testPlan: PlanSelect;

  beforeEach(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResponse = await authenticateTestUser(user.email, user.password);
    token = authResponse.cookies.sessionToken;

    // Create a simple test plan
    testPlan = await createTestPlan({
      merchantId,
      planName: "Basic Test Plan",
      planDescription: "Plan for basic price tests",
      stablePlanId: `basic_plan_${Date.now()}`,
      versionNumber: 1,
    });
  });

  it("should list prices for a specific plan", async () => {
    const client = createTestApiClient(token);

    // Create a price first
    await createTestPrice({
      planId: testPlan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "base-price",
            type: "fixed" as const,
            label: "Base Price",
            amount_cents: 1000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
            bill_immediately: true,
          },
        ],
      },
    });

    const response = await client.prices.$get({
      query: { planId: testPlan.id },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to list prices: ${body.error}`);
    }

    expect(Array.isArray(body.prices)).toBe(true);
    expect(body.prices.length).toBeGreaterThan(0);
  });

  it("should list prices for a plan with multiple currencies", async () => {
    const client = createTestApiClient(token);

    // Create prices in different currencies for the same plan
    await Promise.all([
      createTestPrice({
        planId: testPlan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "usd-price",
              type: "fixed" as const,
              label: "USD Price",
              amount_cents: 1000,
              recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
              bill_immediately: true,
            },
          ],
        },
      }),
      createTestPrice({
        planId: testPlan.id,
        merchantId,
        currency: "EUR",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "eur-price",
              type: "fixed" as const,
              label: "EUR Price",
              amount_cents: 900,
              recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
              bill_immediately: true,
            },
          ],
        },
      }),
    ]);

    // Get all prices for the plan
    const response = await client.prices.$get({
      query: { planId: testPlan.id },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to list prices: ${body.error}`);
    }

    // Should have both USD and EUR prices
    expect(body.prices.length).toBe(2);
    const currencies = body.prices.map((p: any) => p.currency);
    expect(currencies).toContain("USD");
    expect(currencies).toContain("EUR");
  });
});
