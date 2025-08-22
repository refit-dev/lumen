import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestPlanWithFeatures,
  createTestApiClient,
} from "../../test-helpers";
import { cleanupDataFull } from "../../test-helpers/test-utils/setup";
import { PlanSelect } from "../../test-helpers/types";
import { FeatureValue } from "../../test-helpers/data/feature";
import { APIPlanWithFeatures } from "../../../src/helpers";
import { EditPlanInput } from "../../../src/helpers/plans";
import { FeatureType } from "@lumen/common/schema";

describe("Plans API", () => {
  let merchantId: string;
  let sessionToken: string;
  let createdPlans: PlanSelect[];

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create the first test plan for this merchant with features using the new relational approach
    const firstPlanResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "max-users-1",
          displayName: "Maximum Users",
          description: "Maximum number of users allowed",
          featureValue: 5,
        },
        {
          slug: "storage-1",
          displayName: "Storage",
          description: "Storage capacity in gigabytes",
          featureValue: 10,
        },
        {
          slug: "premium-1",
          displayName: "Premium",
          description: "Premium tier access",
          featureValue: false,
        },
      ],
      {
        stablePlanId: "standard-plan",
        versionNumber: 1,
        planName: "Standard Plan",
        planDescription: "Perfect for small businesses",
      }
    );

    // Create the second test plan for this merchant with features using the new relational approach
    const secondPlanResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "max-users-2",
          displayName: "Maximum Users",
          description: "Maximum number of users allowed",
          featureValue: 15,
        },
        {
          slug: "storage-2",
          displayName: "Storage",
          description: "Storage capacity in gigabytes",
          featureValue: 50,
        },
        {
          slug: "premium-2",
          displayName: "Premium",
          description: "Premium tier access",
          featureValue: true,
        },
      ],
      {
        stablePlanId: "premium-plan",
        versionNumber: 1,
        planName: "Premium Plan",
        planDescription: "Ideal for growing businesses",
      }
    );

    // Assign the created plans and prices to variables for later use
    createdPlans = [firstPlanResult.plan, secondPlanResult.plan];
  });

  afterEach(async () => {
    await cleanupDataFull();
  });

  it("should list all plans for a merchant", async () => {
    // Create a client with auth
    const apiClient = createTestApiClient(sessionToken);

    // Call the API to list plans with features
    const response = await apiClient.plans.$get({
      query: { includeFeatures: "true" },
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }
    if (!body.plans || body.plans.length === 0) {
      throw new Error("No plans found");
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.plans).toBeDefined();
    expect(Array.isArray(body.plans)).toBe(true);
    expect(body.plans.length).toBe(2); // We expect exactly 2 plans

    // check that features exists on each plan
    body.plans.forEach((plan) => {
      // Check if plan has features property
      if (!("features" in plan)) {
        throw new Error("Plan does not have features property");
      }
    });

    // Find and verify the first plan (Standard Plan)
    const standardPlan: APIPlanWithFeatures = body.plans.find(
      (p) => p.id === createdPlans[0].id
    ) as APIPlanWithFeatures;
    expect(standardPlan).toBeDefined();
    expect(standardPlan.planName).toBe("Standard Plan");
    expect(standardPlan.stablePlanId).toBe("standard-plan");
    expect(standardPlan.versionNumber).toBe(1);

    // Verify features based on the response structure
    expect(standardPlan.features).toBeDefined();
    expect(Array.isArray(standardPlan.features)).toBe(true);

    // Find features by slug
    const maxUsers = standardPlan.features.find(
      (f) => f.slug === "max-users-1"
    );
    const storage = standardPlan.features.find((f) => f.slug === "storage-1");
    const premium = standardPlan.features.find((f) => f.slug === "premium-1");

    expect(maxUsers).toBeDefined();
    expect(storage).toBeDefined();
    expect(premium).toBeDefined();

    // Check feature values - structure might be feature.value or feature.featureValue
    expect(maxUsers?.featureValue).toBe(5);
    expect(storage?.featureValue).toBe(10);
    expect(premium?.featureValue).toBe(false);

    // Find and verify the second plan (Premium Plan)
    const premiumPlan = body.plans.find(
      (p) => p.id === createdPlans[1].id
    ) as unknown as APIPlanWithFeatures;
    expect(premiumPlan).toBeDefined();
    expect(premiumPlan?.planName).toBe("Premium Plan");
    expect(premiumPlan?.stablePlanId).toBe("premium-plan");
    expect(premiumPlan?.versionNumber).toBe(1);

    // Verify features based on the response structure
    expect(premiumPlan.features).toBeDefined();
    expect(Array.isArray(premiumPlan.features)).toBe(true);

    // Find features by slug
    const premiumMaxUsers = premiumPlan.features.find(
      (f) => f.slug === "max-users-2"
    );
    const premiumStorage = premiumPlan.features.find(
      (f) => f.slug === "storage-2"
    );
    const premiumFeature = premiumPlan.features.find(
      (f) => f.slug === "premium-2"
    );

    expect(premiumMaxUsers).toBeDefined();
    expect(premiumStorage).toBeDefined();
    expect(premiumFeature).toBeDefined();

    // Check feature values - structure might be feature.value or feature.featureValue
    expect(premiumMaxUsers?.featureValue).toBe(15);
    expect(premiumStorage?.featureValue).toBe(50);
    expect(premiumFeature?.featureValue).toBe(true);
  });

  it("should retrieve a specific plan with features", async () => {
    const apiClient = createTestApiClient(sessionToken);

    // Call the API to get a specific plan with features
    const response = await apiClient.plans[":id"].$get({
      param: { id: createdPlans[0].id },
      query: { includeFeatures: "true" },
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }
    // Verify the response
    expect(response.status).toBe(200);
    expect(body.plans).toBeDefined();
    expect(body.plans.length).toBe(1);
    expect(body.plans[0].id).toBe(createdPlans[0].id);
    expect(body.plans[0].merchantId).toBe(merchantId);
    expect(body.plans[0].planName).toBe("Standard Plan");
    expect(body.plans[0].stablePlanId).toBe("standard-plan");
    expect(body.plans[0].versionNumber).toBe(1);

    // Type assertion for features
    const planWithFeatures = body.plans[0] as APIPlanWithFeatures;

    if (!("features" in planWithFeatures)) {
      throw new Error("No features found");
    }

    // Verify features
    expect(planWithFeatures.features).toBeDefined();
    expect(Array.isArray(planWithFeatures.features)).toBe(true);
    expect(planWithFeatures.features.length).toBe(3); // maxUsers, storage, premium

    const maxUsers = planWithFeatures.features.find(
      (f) => f.slug === "max-users-1"
    );
    const storage = planWithFeatures.features.find(
      (f) => f.slug === "storage-1"
    );
    const premium = planWithFeatures.features.find(
      (f) => f.slug === "premium-1"
    );

    expect(maxUsers).toBeDefined();
    expect(storage).toBeDefined();
    expect(premium).toBeDefined();

    // Check feature values - structure might be feature.value or feature.featureValue
    // bang because we know it's not undefined because we checked for it above
    expect(maxUsers!.featureValue).toBe(5);
    expect(storage!.featureValue).toBe(10);
    expect(premium!.featureValue).toBe(false);

    // Get the prices for this plan
    const pricesResponse = await apiClient.prices.$get({
      query: { planId: createdPlans[0].id },
    });
    const pricesBody = await pricesResponse.json();
    if ("error" in pricesBody) {
      throw new Error(`Unexpected error: ${pricesBody.error}`);
    }
  });

  it("should create a new plan with features", async () => {
    const client = createTestApiClient(sessionToken);

    // First create the features we want to include in the plan
    const featurePromises = [
      client.features.$post({
        json: {
          slug: "max-users-3",
          displayName: "Maximum Users",
          description: "Maximum number of users allowed",
          featureValue: 10,
        },
      }),
      client.features.$post({
        json: {
          slug: "storage-3",
          displayName: "Storage",
          description: "Storage capacity in gigabytes",
          featureValue: 50,
        },
      }),
      client.features.$post({
        json: {
          slug: "premium-3",
          displayName: "Premium",
          description: "Premium tier access",
          featureValue: true,
        },
      }),
      client.features.$post({
        json: {
          slug: "concurrent-edits-3",
          displayName: "Concurrent Edits",
          description: "Number of concurrent edits allowed",
          featureValue: 5,
        },
      }),
    ];

    // Create all features in parallel
    const featureResponses = await Promise.all(featurePromises);
    const featureIds: string[] = [];

    for (const response of featureResponses) {
      const body = await response.json();
      if ("error" in body) {
        throw new Error(`Failed to create feature: ${body.error}`);
      }
      featureIds.push(body.feature.id);
    }

    // Create a new plan with the feature IDs
    const newPlanData = {
      planName: "Pro Plan",
      planDescription: "For power users and teams",
      stablePlanId: "pro-plan",
      versionNumber: 1,
      featureIds,
    };

    // Call the API to create a plan
    const response = await client.plans.$post({
      json: newPlanData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    if (!body.plans || body.plans.length === 0) {
      throw new Error("Plan not found in response");
    }
    expect(body.plans[0]).toBeDefined();
    expect(body.plans[0].planName).toBe("Pro Plan");

    // Get the created plan with features to verify
    const getPlanResponse = await client.plans[":id"].$get({
      param: { id: body.plans[0].id },
      query: { includeFeatures: "true" },
    });
    const getPlanBody = await getPlanResponse.json();
    if ("error" in getPlanBody) {
      throw new Error(`Failed to get created plan: ${getPlanBody.error}`);
    }

    const planWithFeatures = getPlanBody.plans[0] as APIPlanWithFeatures;

    // Verify features
    expect(planWithFeatures.features).toBeDefined();
    expect(planWithFeatures.features.length).toBe(4);

    // Verify each feature exists and has correct values
    const maxUsers = planWithFeatures.features.find(
      (f) => f.slug === "max-users-3"
    );
    const storage = planWithFeatures.features.find(
      (f) => f.slug === "storage-3"
    );
    const premium = planWithFeatures.features.find(
      (f) => f.slug === "premium-3"
    );
    const concurrentEdits = planWithFeatures.features.find(
      (f) => f.slug === "concurrent-edits-3"
    );

    expect(maxUsers).toBeDefined();
    expect(storage).toBeDefined();
    expect(premium).toBeDefined();
    expect(concurrentEdits).toBeDefined();

    expect(maxUsers?.featureValue).toBe(10);
    expect(storage?.featureValue).toBe(50);
    expect(premium?.featureValue).toBe(true);
    expect(concurrentEdits?.featureValue).toBe(5);

    expect(planWithFeatures.merchantId).toBe(merchantId);
    expect(planWithFeatures.versionNumber).toBe(1);
    expect(planWithFeatures.stablePlanId).toBeDefined();
  });

  it("should update an existing plan and create a new version", async () => {
    const client = createTestApiClient(sessionToken);

    // We'll use the first plan created in beforeEach
    const planToUpdate = createdPlans[0];

    // First, let's create the new features we want to add
    const newFeatureResponse = await client.features.$post({
      json: {
        slug: "new-feature",
        displayName: "New Feature",
        description: "A new feature for testing",
        featureValue: true,
      },
    });
    const newFeatureBody = await newFeatureResponse.json();
    if ("error" in newFeatureBody) {
      throw new Error(`Failed to create new feature: ${newFeatureBody.error}`);
    }
    const newFeature = newFeatureBody.feature;

    // Get the current plan with its features to know what features to keep
    const currentPlanResponse = await client.plans[":id"].$get({
      param: { id: planToUpdate.id },
      query: { includeFeatures: "true" },
    });
    const currentPlanBody = await currentPlanResponse.json();
    if ("error" in currentPlanBody) {
      throw new Error(`Failed to get current plan: ${currentPlanBody.error}`);
    }

    const currentPlan = currentPlanBody.plans[0] as APIPlanWithFeatures;
    const featureIds = [
      ...currentPlan.features.map((f) => f.id),
      newFeature.id,
    ];

    // Update data with feature IDs
    const updateData = {
      planName: "Updated Standard Plan",
      planDescription: "Now with more features",
      featureIds,
      commitMessage: "Updated plan with new feature",
    };

    // Call the API to update the plan
    const response = await client.plans[":id"].$post({
      param: { id: planToUpdate.id },
      query: {},
      json: updateData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.plans).toBeDefined();
    expect(body.plans).toHaveLength(1);

    const updatedPlan = body.plans[0] as APIPlanWithFeatures;
    expect(updatedPlan.planName).toBe("Updated Standard Plan");
    expect(updatedPlan.stablePlanId).toBe(planToUpdate.stablePlanId);
    expect(updatedPlan.versionNumber).toBe(2);

    // Verify features
    expect(updatedPlan.features).toBeDefined();
    expect(updatedPlan.features).toHaveLength(4); // Original 3 + 1 new feature

    // Find our new feature in the response
    const addedFeature = updatedPlan.features.find(
      (f) => f.slug === "new-feature"
    );
    expect(addedFeature).toBeDefined();
    expect(addedFeature?.displayName).toBe("New Feature");
    expect(addedFeature?.featureValue).toBe(true);

    // Check if original plan is still accessible
    // (should NOT be soft-deleted yet, both version 1 and 2 should be active)
    const getOldResponse = await client.plans[":id"].$get({
      param: { id: planToUpdate.id },
      query: { includeFeatures: "true" },
    });

    // Expecting 200 since the original should NOT be soft-deleted yet
    expect(getOldResponse.status).toBe(200);

    // Get all plans with the same stable ID to verify versioning
    const listResponse = await client.plans[":id"].$get({
      param: { id: planToUpdate.stablePlanId },
      query: {
        includeFeatures: "true",
        isStableId: "true",
      },
    });

    const listBody = await listResponse.json();
    if ("error" in listBody) {
      throw new Error(`Unexpected error: ${listBody.error}`);
    }

    // Should have one plan with version 2 (active)
    const plans = listBody.plans as APIPlanWithFeatures[];
    expect(plans).toHaveLength(2);
    expect(plans[0].versionNumber).toBe(1);
    expect(plans[1].versionNumber).toBe(2);
    expect(plans[0].features).toHaveLength(3);
    expect(plans[1].features).toHaveLength(4);
  });

  it("should create a new plan version with feature updates and clone prices", async () => {
    const client = createTestApiClient(sessionToken);

    // First, create a price for our first plan using the new DSL format
    const priceResponse = await client.prices.$post({
      json: {
        planId: createdPlans[0].id,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: `test_plan_usd_monthly_${Date.now()}`,
              type: "fixed",
              label: "Monthly Base Fee",
              amount_cents: 2999,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            },
            // Note: The old structure had 'perUser'. This needs to be a separate component
            // in the new DSL. For this test, we'll just include the base fee for simplicity,
            // as the test primarily focuses on plan versioning and price cloning, not complex pricing.
            // If per-user pricing is crucial here, we'd need to add a 'per_unit' component.
            // {
            //   component_id: `test_plan_usd_monthly_user_${Date.now()}`,
            //   type: "per_unit",
            //   unit_label: "User",
            //   label: "Per User Fee (Monthly)",
            //   amount_cents: 599,
            //   recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
            // }
          ],
        },
      },
    });

    const priceBody = await priceResponse.json();
    if ("error" in priceBody) {
      throw new Error(`Failed to create price: ${priceBody.error}`);
    }
    const priceId = priceBody.price.id;

    // Get the current plan with its features
    const currentPlanResponse = await client.plans[":id"].$get({
      param: { id: createdPlans[0].id },
      query: { includeFeatures: "true" },
    });
    const currentPlanBody = await currentPlanResponse.json();
    if ("error" in currentPlanBody) {
      throw new Error(`Failed to get current plan: ${currentPlanBody.error}`);
    }

    const currentPlan = currentPlanBody.plans[0] as APIPlanWithFeatures;
    const currentFeatures = currentPlan.features;

    // Find the features we want to update
    const maxUsersFeature = currentFeatures.find(
      (f) => f.slug === "max-users-1"
    );
    const storageFeature = currentFeatures.find((f) => f.slug === "storage-1");
    const premiumFeature = currentFeatures.find((f) => f.slug === "premium-1");

    if (!maxUsersFeature || !storageFeature || !premiumFeature) {
      throw new Error("Required features not found in current plan");
    }

    // Create a new version of the plan with modified features
    const updateResponse = await client.plans[":id"].$post({
      param: { id: createdPlans[0].id },
      query: {},
      json: {
        planName: "Standard Plan v2",
        planDescription: "Updated version of our standard plan",
        featureIds: [maxUsersFeature.id, storageFeature.id, premiumFeature.id],
        priceIds: [priceId],
        commitMessage: "Updated plan with modified features and cloned price",
      },
    });

    const updateBody = await updateResponse.json();
    if ("error" in updateBody) {
      throw new Error(`Failed to update plan: ${updateBody.error}`);
    }

    expect(updateResponse.status).toBe(200);
    expect(updateBody.plans).toBeDefined();
    expect(updateBody.plans).toHaveLength(1);

    const updatedPlan = updateBody.plans[0] as APIPlanWithFeatures;
    expect(updatedPlan.versionNumber).toBe(2);
    expect(updatedPlan.stablePlanId).toBe(createdPlans[0].stablePlanId);

    // Get the updated plan to verify features
    const getNewVersionResponse = await client.plans[":id"].$get({
      param: { id: updatedPlan.id },
      query: { includeFeatures: "true" },
    });

    const getNewVersionBody = await getNewVersionResponse.json();
    if ("error" in getNewVersionBody) {
      throw new Error(`Failed to get updated plan: ${getNewVersionBody.error}`);
    }

    const newVersionPlan = getNewVersionBody.plans[0] as APIPlanWithFeatures;
    expect(newVersionPlan.features).toHaveLength(3);

    // Find and check the updated features
    const maxUsers = newVersionPlan.features.find(
      (f) => f.slug === "max-users-1"
    );
    const storage = newVersionPlan.features.find((f) => f.slug === "storage-1");
    const premium = newVersionPlan.features.find((f) => f.slug === "premium-1");

    expect(maxUsers).toBeDefined();
    expect(storage).toBeDefined();
    expect(premium).toBeDefined();

    // Verify feature values are preserved
    expect(maxUsers?.featureValue).toBe(5);
    expect(storage?.featureValue).toBe(10);
    expect(premium?.featureValue).toBe(false);

    // Get all plans with the same stable ID to verify versioning
    const listResponse = await client.plans[":id"].$get({
      param: { id: updatedPlan.stablePlanId },
      query: {
        includeFeatures: "true",
        isStableId: "true",
      },
    });

    const listBody = await listResponse.json();
    if ("error" in listBody) {
      throw new Error(`Failed to list plans: ${listBody.error}`);
    }

    // Should have both versions
    const plans = listBody.plans as APIPlanWithFeatures[];
    expect(plans).toHaveLength(2);
    expect(plans[0].versionNumber).toBe(1);
    expect(plans[1].versionNumber).toBe(2);
  });

  it("should delete a plan", async () => {
    const client = createTestApiClient(sessionToken);

    // We'll use the first plan created in beforeEach
    const planToDelete = createdPlans[0];

    // Call the API to delete the plan
    const response = await client.plans[":id"].$delete({
      param: { id: planToDelete.id },
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    // Try to get the deleted plan
    const getResponse = await client.plans[":id"].$get({
      param: { id: planToDelete.id },
      query: { includeFeatures: "false" },
    });

    // Should return 404
    expect(getResponse.status).toBe(404);
  });

  it("should update plan metadata without creating a new version", async () => {
    const client = createTestApiClient(sessionToken);

    // We'll use the first plan created in beforeEach
    const planToUpdate = createdPlans[0];

    // Get the current plan to verify version number
    const initialPlanResponse = await client.plans[":id"].$get({
      param: { id: planToUpdate.id },
      query: { includeFeatures: "true" },
    });
    const initialPlanBody = await initialPlanResponse.json();
    if ("error" in initialPlanBody) {
      throw new Error(`Failed to get initial plan: ${initialPlanBody.error}`);
    }
    const initialPlan = initialPlanBody.plans[0] as APIPlanWithFeatures;
    const initialVersion = initialPlan.versionNumber;

    // Update only metadata (no features or prices)
    const updateData = {
      planName: "Renamed Standard Plan",
      planDescription: "Updated description without changing features",
      commitMessage: "Updated plan metadata only",
    };

    // Call the API to update the plan
    const response = await client.plans[":id"].$post({
      param: { id: planToUpdate.id },
      query: {},
      json: updateData,
    });
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Unexpected error: ${body.error}`);
    }

    // Verify the response
    expect(response.status).toBe(200);
    expect(body.plans).toBeDefined();
    expect(body.plans).toHaveLength(1);

    const updatedPlan = body.plans[0] as APIPlanWithFeatures;
    expect(updatedPlan.planName).toBe("Renamed Standard Plan");
    expect(updatedPlan.planDescription).toBe(
      "Updated description without changing features"
    );
    expect(updatedPlan.versionNumber).toBe(initialVersion); // Version should not change
    expect(updatedPlan.id).toBe(planToUpdate.id); // Should be the same plan ID

    // Get all plans with the same stable ID to verify no new version was created
    const listResponse = await client.plans[":id"].$get({
      param: { id: updatedPlan.stablePlanId },
      query: {
        includeFeatures: "true",
        isStableId: "true",
      },
    });

    const listBody = await listResponse.json();
    if ("error" in listBody) {
      throw new Error(`Failed to list plans: ${listBody.error}`);
    }

    // Should still have just one version
    const plans = listBody.plans as APIPlanWithFeatures[];
    expect(plans).toHaveLength(1);
    expect(plans[0].versionNumber).toBe(initialVersion);
    expect(plans[0].planName).toBe("Renamed Standard Plan");
  });

  it("should edit a plan in place with multiple changes when no subscribers are present", async () => {
    const client = createTestApiClient(sessionToken);

    const planToEdit = createdPlans[0];

    // Fetch the current plan (including features) to establish baseline
    const getResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const getBody = await getResponse.json();
    if ("error" in getBody) {
      throw new Error(`Failed to get current plan: ${getBody.error}`);
    }
    const originalPlan = getBody.plans[0] as APIPlanWithFeatures;
    const originalVersion = originalPlan.versionNumber;

    // We will modify an existing feature, remove one feature and add a new one
    const modifiedFeature = originalPlan.features.find(
      (f) => f.slug === "max-users-1"
    )!;

    // Create a brand-new feature that will be added to the plan
    const newFeatureResp = await client.features.$post({
      json: {
        slug: "new-boolean-feat",
        displayName: "New Boolean Feature",
        description: "A new feature added in place",
        featureValue: true,
      },
    });
    const newFeatureBody = await newFeatureResp.json();
    if ("error" in newFeatureBody) {
      throw new Error(`Failed to create new feature: ${newFeatureBody.error}`);
    }
    const newFeature = newFeatureBody.feature;

    // Prepare edit payload
    const newMonthly = 2000;
    const newYearly = 22000;

    const editPayload: EditPlanInput = {
      planDescription: "In-place edited description",
      features: [
        {
          existingFeatureId: modifiedFeature.id,
          slug: modifiedFeature.slug,
          featureName: modifiedFeature.displayName,
          isUsageBased: false,
          hasCreditAllowance: false,
        },
        {
          slug: newFeature.slug,
          featureName: newFeature.displayName,
          isUsageBased: false,
          hasCreditAllowance: false,
        },
      ],
      monthlyPrice: newMonthly,
      hasYearlyPrice: true,
      yearlyPrice: newYearly,
    };

    // Hit the intelligent edit endpoint (which performs in-place edit because there are no subscribers)
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: planToEdit.id },
      json: editPayload,
    });
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Unexpected error: ${editBody.error}`);
    }

    expect(editResponse.status).toBe(200);
    expect(editBody.success).toBe(true);

    // Fetch the updated plan (including features) to verify changes
    const updatedPlanResp = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const updatedPlanBody = await updatedPlanResp.json();
    if ("error" in updatedPlanBody) {
      throw new Error(`Failed to fetch updated plan: ${updatedPlanBody.error}`);
    }
    const updatedPlan = updatedPlanBody.plans[0] as APIPlanWithFeatures;

    // Identity & metadata should remain intact (no new version, same id)
    expect(updatedPlan.id).toBe(planToEdit.id);
    expect(updatedPlan.versionNumber).toBe(originalVersion);
    expect(updatedPlan.planName).toBe(originalPlan.planName);
    expect(updatedPlan.planDescription).toBe("In-place edited description");
    expect(updatedPlan.stablePlanId).toBe(originalPlan.stablePlanId);
    expect((updatedPlan as any).isEnterprisePlan).toBe(
      (originalPlan as any).isEnterprisePlan
    );
    expect((updatedPlan as any).isVisibleInPricingTable).toBe(
      (originalPlan as any).isVisibleInPricingTable
    );

    // Feature assertions – one removed, one modified (kept), one added
    expect(updatedPlan.features).toHaveLength(2);
    const updatedSlugs = updatedPlan.features.map((f) => f.slug).sort();
    expect(updatedSlugs).toEqual(["max-users-1", "new-boolean-feat"].sort());

    const feat1 = updatedPlan.features.find((f) => f.slug === "max-users-1")!;
    // Numeric constant feature value should be preserved
    expect(feat1.featureValue).toBe(modifiedFeature.featureValue);

    const feat2 = updatedPlan.features.find((f) => f.slug === newFeature.slug)!;
    expect(feat2.displayName).toBe(newFeature.displayName);
    expect(feat2.featureValue).toBe(newFeature.featureValue);

    // Verify price changes
    const priceRes = await client.prices.$get({
      query: { planId: planToEdit.id },
    });
    const priceBody = await priceRes.json();
    if ("error" in priceBody) {
      throw new Error(`Failed to list prices: ${priceBody.error}`);
    }
    const prices = priceBody.prices;
    const components = prices.flatMap(
      (p: any) => p.pricingData.components ?? []
    );
    const monthlyComp = components.find(
      (c: any) => c.component_name === "monthly"
    );
    const annualComp = components.find(
      (c: any) => c.component_name === "annual"
    );
    expect(monthlyComp?.amount_cents).toBe(newMonthly);
    expect(annualComp?.amount_cents).toBe(newYearly * 12);
  });

  it("should edit plan metadata only when no subscribers are present", async () => {
    const client = createTestApiClient(sessionToken);
    const planToEdit = createdPlans[0];

    // Get original plan state
    const originalResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const originalBody = await originalResponse.json();
    if ("error" in originalBody) {
      throw new Error(`Failed to get original plan: ${originalBody.error}`);
    }
    const originalPlan = originalBody.plans[0] as APIPlanWithFeatures;

    // Edit only metadata (plan name and description)
    const editPayload: EditPlanInput = {
      planName: "Updated Standard Plan Name",
      planDescription: "Updated plan description only",
    };

    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: planToEdit.id },
      json: editPayload,
    });
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    expect(editResponse.status).toBe(200);
    expect(editBody.success).toBe(true);
    expect(editBody.changeAnalysis.isNewVersion).toBe(false);

    // Verify the plan was updated in place
    const updatedResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const updatedBody = await updatedResponse.json();
    if ("error" in updatedBody) {
      throw new Error(`Failed to get updated plan: ${updatedBody.error}`);
    }
    const updatedPlan = updatedBody.plans[0] as APIPlanWithFeatures;

    // Verify metadata changes
    expect(updatedPlan.id).toBe(originalPlan.id);
    expect(updatedPlan.versionNumber).toBe(originalPlan.versionNumber);
    expect(updatedPlan.planName).toBe("Updated Standard Plan Name");
    expect(updatedPlan.planDescription).toBe("Updated plan description only");

    // Verify features remain unchanged
    expect(updatedPlan.features).toHaveLength(originalPlan.features.length);
    expect(updatedPlan.features.map((f) => f.slug).sort()).toEqual(
      originalPlan.features.map((f) => f.slug).sort()
    );
  });

  it("should edit features only without changing prices when no subscribers are present", async () => {
    const client = createTestApiClient(sessionToken);
    const planToEdit = createdPlans[0];

    // Get original plan
    const originalResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const originalBody = await originalResponse.json();
    if ("error" in originalBody) {
      throw new Error(`Failed to get original plan: ${originalBody.error}`);
    }
    const originalPlan = originalBody.plans[0] as APIPlanWithFeatures;

    // Create a new feature to add
    const newFeatureResponse = await client.features.$post({
      json: {
        slug: "analytics-feature",
        displayName: "Analytics Dashboard",
        description: "Advanced analytics and reporting",
        featureValue: true,
      },
    });
    const newFeatureBody = await newFeatureResponse.json();
    if ("error" in newFeatureBody) {
      throw new Error(`Failed to create feature: ${newFeatureBody.error}`);
    }

    // Keep one original feature and add the new one (removing the other two)
    const keepFeature = originalPlan.features.find(
      (f) => f.slug === "max-users-1"
    )!;

    const editPayload: EditPlanInput = {
      features: [
        {
          existingFeatureId: keepFeature.id,
          slug: keepFeature.slug,
          featureName: keepFeature.displayName,
          isUsageBased: false,
          hasCreditAllowance: false,
        },
        {
          slug: "analytics-feature",
          featureName: "Analytics Dashboard",
          isUsageBased: false,
          hasCreditAllowance: false,
        },
      ],
    };

    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: planToEdit.id },
      json: editPayload,
    });
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    expect(editResponse.status).toBe(200);
    expect(editBody.success).toBe(true);
    expect(editBody.changeAnalysis.hasFeatureChanges).toBe(true);
    expect(editBody.changeAnalysis.hasPriceChanges).toBe(false);

    // Verify features changed correctly
    const updatedResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const updatedBody = await updatedResponse.json();
    if ("error" in updatedBody) {
      throw new Error(`Failed to get updated plan: ${updatedBody.error}`);
    }
    const updatedPlan = updatedBody.plans[0] as APIPlanWithFeatures;

    expect(updatedPlan.features).toHaveLength(2);
    const featureSlugs = updatedPlan.features.map((f) => f.slug).sort();
    expect(featureSlugs).toEqual(["analytics-feature", "max-users-1"]);
  });

  it("should edit prices only without changing features when no subscribers are present", async () => {
    const client = createTestApiClient(sessionToken);
    const planToEdit = createdPlans[0];

    // Get original plan
    const originalResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const originalBody = await originalResponse.json();
    if ("error" in originalBody) {
      throw new Error(`Failed to get original plan: ${originalBody.error}`);
    }
    const originalPlan = originalBody.plans[0] as APIPlanWithFeatures;

    // Create initial pricing if none exists
    const initialPriceResponse = await client.prices.$post({
      json: {
        planId: planToEdit.id,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "Monthly Base Fee",
              amount_cents: 1000,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      },
    });
    await initialPriceResponse.json();

    // Edit only prices
    const editPayload: EditPlanInput = {
      monthlyPrice: 1500,
      hasYearlyPrice: true,
      yearlyPrice: 15000,
    };

    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: planToEdit.id },
      json: editPayload,
    });
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    expect(editResponse.status).toBe(200);
    expect(editBody.success).toBe(true);
    expect(editBody.changeAnalysis.hasFeatureChanges).toBe(false);
    expect(editBody.changeAnalysis.hasPriceChanges).toBe(true);

    // Verify features remain unchanged but prices updated
    const updatedResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const updatedBody = await updatedResponse.json();
    if ("error" in updatedBody) {
      throw new Error(`Failed to get updated plan: ${updatedBody.error}`);
    }
    const updatedPlan = updatedBody.plans[0] as APIPlanWithFeatures;

    // Features should be unchanged
    expect(updatedPlan.features).toHaveLength(originalPlan.features.length);

    // Check price updates
    const pricesResponse = await client.prices.$get({
      query: { planId: planToEdit.id },
    });
    const pricesBody = await pricesResponse.json();
    if ("error" in pricesBody) {
      throw new Error(`Failed to get prices: ${pricesBody.error}`);
    }

    const components = pricesBody.prices.flatMap(
      (p: any) => p.pricingData.components ?? []
    );
    const monthlyComp = components.find(
      (c: any) => c.component_name === "monthly"
    );
    const annualComp = components.find(
      (c: any) => c.component_name === "annual"
    );

    expect(monthlyComp?.amount_cents).toBe(1500);
    expect(annualComp?.amount_cents).toBe(15000 * 12);
  });

  it("should handle usage-based features with metrics when no subscribers are present", async () => {
    const client = createTestApiClient(sessionToken);
    const planToEdit = createdPlans[0];

    // First, create an initial price record to modify
    const initialPriceResponse = await client.prices.$post({
      json: {
        planId: planToEdit.id,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "Monthly Base Fee",
              amount_cents: 1000,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      },
    });
    await initialPriceResponse.json();

    const editPayload: EditPlanInput = {
      features: [
        {
          slug: "api-calls-usage",
          featureName: "API Calls",
          eventName: "api_call",
          isUsageBased: true,
          usagePricePerUnit: 5,
          hasCreditAllowance: false,
        },
      ],
      monthlyPrice: 2000, // This will trigger price changes and usage component creation
    };

    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: planToEdit.id },
      json: editPayload,
    });
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    expect(editResponse.status).toBe(200);
    expect(editBody.success).toBe(true);
    expect(editBody.changeAnalysis.hasNumericFeatureChanges).toBe(true);

    // Verify the usage-based feature was created correctly
    const updatedResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const updatedBody = await updatedResponse.json();
    if ("error" in updatedBody) {
      throw new Error(`Failed to get updated plan: ${updatedBody.error}`);
    }
    const updatedPlan = updatedBody.plans[0] as APIPlanWithFeatures;

    const usageFeature = updatedPlan.features.find(
      (f) => f.slug === "api-calls-usage"
    );
    expect(usageFeature).toBeDefined();
    expect(usageFeature?.featureType).toBe("number");
    expect(usageFeature?.featureValue).toBe("usage_based");

    // Check that usage pricing component was created
    const pricesResponse = await client.prices.$get({
      query: { planId: planToEdit.id },
    });
    const pricesBody = await pricesResponse.json();
    if ("error" in pricesBody) {
      throw new Error(`Failed to get prices: ${pricesBody.error}`);
    }

    const components = pricesBody.prices.flatMap(
      (p: any) => p.pricingData.components ?? []
    );
    const usageComp = components.find(
      (c: any) => c.component_name === "usage_api-calls-usage"
    );
    expect(usageComp).toBeDefined();
    expect(usageComp?.type).toBe("usage");
    expect(usageComp?.unit_cost_cents).toBe(5);
  });

  it("should handle features with credit allowances when no subscribers are present", async () => {
    const client = createTestApiClient(sessionToken);
    const planToEdit = createdPlans[0];

    const editPayload: EditPlanInput = {
      features: [
        {
          slug: "storage-with-credits",
          featureName: "Storage with Credits",
          isUsageBased: false,
          hasCreditAllowance: true,
          creditAllowanceAmount: 100,
          creditAllowanceRenewal: "monthly",
        },
      ],
    };

    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: planToEdit.id },
      json: editPayload,
    });
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    expect(editResponse.status).toBe(200);
    expect(editBody.success).toBe(true);

    // Verify the feature with credit allowance was created
    const updatedResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const updatedBody = await updatedResponse.json();
    if ("error" in updatedBody) {
      throw new Error(`Failed to get updated plan: ${updatedBody.error}`);
    }
    const updatedPlan = updatedBody.plans[0] as APIPlanWithFeatures;

    const creditFeature = updatedPlan.features.find(
      (f) => f.slug === "storage-with-credits"
    );
    expect(creditFeature).toBeDefined();
    expect(creditFeature?.displayName).toBe("Storage with Credits");
    expect(creditFeature?.featureType).toBe("boolean");
  });

  it("should handle empty features array correctly when no subscribers are present", async () => {
    const client = createTestApiClient(sessionToken);
    const planToEdit = createdPlans[0];

    // Edit to remove all features
    const editPayload: EditPlanInput = {
      features: [],
    };

    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: planToEdit.id },
      json: editPayload,
    });
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    expect(editResponse.status).toBe(200);
    expect(editBody.success).toBe(true);
    expect(editBody.changeAnalysis.hasFeatureChanges).toBe(true);

    // Verify all features were removed
    const updatedResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const updatedBody = await updatedResponse.json();
    if ("error" in updatedBody) {
      throw new Error(`Failed to get updated plan: ${updatedBody.error}`);
    }
    const updatedPlan = updatedBody.plans[0] as APIPlanWithFeatures;

    expect(updatedPlan.features).toHaveLength(0);
  });

  it("should handle invalid plan ID for editing", async () => {
    const client = createTestApiClient(sessionToken);

    const editPayload: EditPlanInput = {
      planName: "Should not work",
    };

    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: "invalid-plan-id" },
      json: editPayload,
    });

    expect(editResponse.status).toBe(404);
  });

  it("should edit plan to add usage feature with credit allowance and usage pricing", async () => {
    const client = createTestApiClient(sessionToken);
    const planToEdit = createdPlans[0];

    // Create initial pricing to ensure we have a base price to modify
    const initialPriceResponse = await client.prices.$post({
      json: {
        planId: planToEdit.id,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "Monthly Base Fee",
              amount_cents: 2000,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      },
    });
    await initialPriceResponse.json();

    // Get the original plan state
    const originalResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const originalBody = await originalResponse.json();
    if ("error" in originalBody) {
      throw new Error(`Failed to get original plan: ${originalBody.error}`);
    }
    const originalPlan = originalBody.plans[0] as APIPlanWithFeatures;

    // Prepare edit payload with a new usage feature that has both credit allowance and usage pricing
    const editPayload: EditPlanInput = {
      planDescription: "Updated plan with usage feature",
      features: [
        // Keep one existing feature
        {
          existingFeatureId: originalPlan.features[0].id,
          slug: originalPlan.features[0].slug,
          featureName: originalPlan.features[0].displayName,
          isUsageBased: false,
          hasCreditAllowance: false,
        },
        // Add new usage feature with both credit allowance and usage pricing
        {
          slug: "sms-messages",
          featureName: "SMS Messages",
          eventName: "sms_sent",
          isUsageBased: true,
          usagePricePerUnit: 15, // 15 cents per SMS
          hasCreditAllowance: true,
          creditAllowanceAmount: 100, // 100 free SMS per month
          creditAllowanceRenewal: "monthly",
        },
      ],
      monthlyPrice: 2500, // Update monthly price to trigger price component changes
    };

    // Execute the edit
    const editResponse = await client.plans[":id"]["edit"].$post({
      param: { id: planToEdit.id },
      json: editPayload,
    });
    const editBody = await editResponse.json();
    if ("error" in editBody) {
      throw new Error(`Edit failed: ${editBody.error}`);
    }

    expect(editResponse.status).toBe(200);
    expect(editBody.success).toBe(true);
    expect(editBody.changeAnalysis.hasFeatureChanges).toBe(true);
    expect(editBody.changeAnalysis.hasNumericFeatureChanges).toBe(true);
    expect(editBody.changeAnalysis.hasPriceChanges).toBe(true);

    // Verify the updated plan
    const updatedResponse = await client.plans[":id"].$get({
      param: { id: planToEdit.id },
      query: { includeFeatures: "true" },
    });
    const updatedBody = await updatedResponse.json();
    if ("error" in updatedBody) {
      throw new Error(`Failed to get updated plan: ${updatedBody.error}`);
    }
    const updatedPlan = updatedBody.plans[0] as APIPlanWithFeatures;

    // Verify plan metadata
    expect(updatedPlan.planDescription).toBe("Updated plan with usage feature");
    expect(updatedPlan.features).toHaveLength(2);

    // Verify the new SMS usage feature
    const smsFeature = updatedPlan.features.find(
      (f) => f.slug === "sms-messages"
    );
    expect(smsFeature).toBeDefined();
    expect(smsFeature?.displayName).toBe("SMS Messages");
    expect(smsFeature?.featureType).toBe("number");
    expect(smsFeature?.featureValue).toBe("usage_based");

    // Verify the usage pricing component was created
    const pricesResponse = await client.prices.$get({
      query: { planId: planToEdit.id },
    });
    const pricesBody = await pricesResponse.json();
    if ("error" in pricesBody) {
      throw new Error(`Failed to get prices: ${pricesBody.error}`);
    }

    const components = pricesBody.prices.flatMap(
      (p: any) => p.pricingData.components ?? []
    );

    // Check monthly base price was updated
    const monthlyComp = components.find(
      (c: any) => c.component_name === "monthly"
    );
    expect(monthlyComp?.amount_cents).toBe(2500);

    // Check usage component was created for SMS
    const smsUsageComp = components.find(
      (c: any) => c.component_name === "usage_sms-messages"
    );
    expect(smsUsageComp).toBeDefined();
    expect(smsUsageComp?.type).toBe("usage");
    expect(smsUsageComp?.unit_cost_cents).toBe(15);
    expect(smsUsageComp?.unit_label).toBe("unit"); // System hardcodes unit_label to "unit"

    // ---------------------------
    // Direct DB verifications
    // ---------------------------
    const {
      features: featuresTable,
      planFeatures,
      creditDefinitions,
      prices: pricesTable,
    } = await import("@lumen/common/schema");
    const { db } = await import("../../../src/db/client");
    const { and, eq, isNull } = await import("drizzle-orm");

    // 1. Feature exists in features table
    const smsFeatureRow = await db.query.features.findFirst({
      where: and(
        eq(featuresTable.merchantId, merchantId),
        eq(featuresTable.slug, "sms-messages"),
        isNull(featuresTable.deletedAt)
      ),
    });
    expect(smsFeatureRow).toBeDefined();
    expect(smsFeatureRow!.featureType).toBe("number");

    // 2. Feature is attached to the plan in plan_features junction table
    const smsPlanFeature = await db.query.planFeatures.findFirst({
      where: and(
        eq(planFeatures.planId, planToEdit.id),
        eq(planFeatures.featureId, smsFeatureRow!.id),
        isNull(planFeatures.deletedAt)
      ),
    });
    expect(smsPlanFeature).toBeDefined();

    // 3. Credit definition was created for the usage feature
    const smsCreditDef = await db.query.creditDefinitions.findFirst({
      where: and(
        eq(creditDefinitions.planId, planToEdit.id),
        eq(creditDefinitions.featureSlug, "sms-messages"),
        eq(creditDefinitions.applicationType, "usage"),
        isNull(creditDefinitions.deletedAt)
      ),
    });
    expect(smsCreditDef).toBeDefined();
    expect(smsCreditDef!.defaultAmount).toBe(100);
    // Since this feature has usage-based pricing (usagePricePerUnit: 15),
    // it should use billing-based renewal instead of RRULE-based renewal
    expect(smsCreditDef!.renewOnBilling).toBe(true);
    expect(smsCreditDef!.refillRrule).toBeNull();
    expect(smsCreditDef!.expiryDays).toBe(-1); // Expire with billing cycle

    // 4. Price component exists with correct unit cost
    const priceRow = await db.query.prices.findFirst({
      where: and(
        eq(pricesTable.planId, planToEdit.id),
        isNull(pricesTable.deletedAt)
      ),
    });
    expect(priceRow).toBeDefined();
    const smsUsageCompDb = priceRow!.pricingData.components.find(
      (c: any) => c.component_name === "usage_sms-messages"
    );
    expect(smsUsageCompDb).toBeDefined();
    expect(smsUsageCompDb!.type).toBe("usage");
    if (smsUsageCompDb!.type === "usage") {
      expect(smsUsageCompDb!.unit_cost_cents).toBe(15);
    }

    // Verify change analysis reflects in-place edit (no new version)
    expect(editBody.changeAnalysis.isNewVersion).toBe(false);
  });
});

describe("Plans with Multiple Price Components", () => {
  let merchantId: string;
  let sessionToken: string;
  let testPlan: PlanSelect;

  beforeEach(async () => {
    // Set up a test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;

    // Create a test plan with features
    const planResult = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: `api-calls-multi-${Date.now()}`,
          displayName: "API Calls",
          description: "Number of API calls allowed",
          featureValue: 10000 as FeatureValue,
        },
        {
          slug: `storage-multi-${Date.now()}`,
          displayName: "Storage (GB)",
          description: "Storage capacity in gigabytes",
          featureValue: 500 as FeatureValue,
        },
      ],
      {
        planName: "Multi-Component Test Plan",
        planDescription: "Plan for testing multiple price components",
        stablePlanId: `multi-comp-plan-${Date.now()}`,
      }
    );
    testPlan = planResult.plan;
  });

  afterEach(async () => {
    await cleanupDataFull();
  });

  it("should create a plan with multiple price components having different billing cycles", async () => {
    const client = createTestApiClient(sessionToken);

    // Create a price with multiple components and different billing cycles
    const createPriceResponse = await client.prices.$post({
      json: {
        planId: testPlan.id,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "base-subscription",
              type: "fixed",
              label: "Monthly Base Subscription",
              amount_cents: 4999,
              recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
              bill_immediately: true,
            },
            {
              component_name: "api-usage",
              type: "usage",
              label: "API Usage",
              unit_label: "API Call",
              metric_id: "met_" + Date.now(),
              unit_cost_cents: 1,
              recurrence_rule: "RRULE:FREQ=WEEKLY;BYDAY=MO", // Weekly on Mondays
              bill_immediately: false,
            },
            {
              component_name: "storage-fee",
              type: "per_unit",
              label: "Storage Fee",
              unit_label: "GB",
              amount_cents: 999,
              recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15", // Monthly on the 15th
              bill_immediately: false,
            },
          ],
        },
      },
    });

    expect(createPriceResponse.status).toBe(200);
    const priceData = await createPriceResponse.json();
    if ("error" in priceData) {
      throw new Error(`Failed to create price: ${priceData.error}`);
    }

    // Verify that the price was created with all components
    expect(priceData.price.pricingData.components.length).toBe(3);

    // Check all components have different recurrence rules
    const components = priceData.price.pricingData.components;
    const recurrenceRules = components.map((c) => c.recurrence_rule);

    // Verify each component has the expected recurrence rule type
    expect(recurrenceRules[0]).toContain("FREQ=MONTHLY;BYMONTHDAY=1");
    expect(recurrenceRules[1]).toContain("FREQ=WEEKLY;BYDAY=MO");
    expect(recurrenceRules[2]).toContain("FREQ=MONTHLY;BYMONTHDAY=15");

    // Verify component types
    expect(components[0].type).toBe("fixed");
    expect(components[1].type).toBe("usage");
    expect(components[2].type).toBe("per_unit");

    // Get the plan with the price to verify everything is connected
    const getPlanResponse = await client.plans[":id"].$get({
      param: { id: testPlan.id },
      query: { includeFeatures: "true" },
    });

    expect(getPlanResponse.status).toBe(200);
    const planData = await getPlanResponse.json();
    if ("error" in planData) {
      throw new Error(`Failed to get plan: ${planData.error}`);
    }

    // Now verify that the price can be retrieved for this plan
    const listPricesResponse = await client.prices.$get({
      query: { planId: testPlan.id },
    });

    expect(listPricesResponse.status).toBe(200);
    const pricesData = await listPricesResponse.json();
    if ("error" in pricesData) {
      throw new Error(`Failed to list prices: ${pricesData.error}`);
    }

    // Should find our price in the list
    expect(pricesData.prices.length).toBeGreaterThan(0);

    // Find our price in the list
    const ourPrice = pricesData.prices.find((p) => p.id === priceData.price.id);
    expect(ourPrice).toBeDefined();
    if (!ourPrice) {
      throw new Error("Price not found");
    }

    // Verify the components in the retrieved price
    expect(ourPrice.pricingData.components.length).toBe(3);
    expect(ourPrice.pricingData.components[0].recurrence_rule).toContain(
      "FREQ=MONTHLY"
    );
    expect(ourPrice.pricingData.components[1].recurrence_rule).toContain(
      "FREQ=WEEKLY"
    );
  });

  it("should create a zero price plan (free plan)", async () => {
    const client = createTestApiClient(sessionToken);

    // Create a price with zero amount components
    const createPriceResponse = await client.prices.$post({
      json: {
        planId: testPlan.id,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "free-tier-base",
              type: "fixed",
              label: "Free Tier Base",
              amount_cents: 0,
              recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
              bill_immediately: true,
            },
          ],
        },
      },
    });

    expect(createPriceResponse.status).toBe(200);
    const priceData = await createPriceResponse.json();
    if ("error" in priceData) {
      throw new Error(`Failed to create zero price: ${priceData.error}`);
    }

    // Verify that the zero price was created successfully
    if (!("amount_cents" in priceData.price.pricingData.components[0])) {
      throw new Error("Amount cents not found");
    }
    expect(priceData.price.pricingData.components[0].amount_cents).toBe(0);
    expect(priceData.price.pricingData.components[0].type).toBe("fixed");

    // Verify we can retrieve the plan with the zero price
    const getPlanResponse = await client.plans[":id"].$get({
      param: { id: testPlan.id },
      query: { includeFeatures: "true" },
    });

    expect(getPlanResponse.status).toBe(200);
  });

  it("should handle plan creation with mixed zero and non-zero price components", async () => {
    const client = createTestApiClient(sessionToken);

    // Create a price with mixed zero and non-zero components
    const createPriceResponse = await client.prices.$post({
      json: {
        planId: testPlan.id,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "free-base",
              type: "fixed",
              label: "Free Base Service",
              amount_cents: 0,
              recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
              bill_immediately: true,
            },
            {
              component_name: "premium-addon",
              type: "fixed",
              label: "Premium Add-on",
              amount_cents: 999,
              recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
              bill_immediately: false,
            },
          ],
        },
      },
    });

    expect(createPriceResponse.status).toBe(200);
    const priceData = await createPriceResponse.json();
    if ("error" in priceData) {
      throw new Error(`Failed to create mixed price: ${priceData.error}`);
    }

    // Verify components were created correctly
    const components = priceData.price.pricingData.components;
    expect(components.length).toBe(2);

    const freeComponent = components.find(
      (c) => c.component_name === "free-base"
    );
    const paidComponent = components.find(
      (c) => c.component_name === "premium-addon"
    );

    if (
      !freeComponent ||
      !paidComponent ||
      !("amount_cents" in freeComponent!) ||
      !("amount_cents" in paidComponent!)
    ) {
      throw new Error("Amount cents not found");
    }

    expect(freeComponent.amount_cents).toBe(0);
    expect(paidComponent.amount_cents).toBe(999);
  });
});

describe("Basic Plan Operations", () => {
  let merchantId: string;
  let sessionToken: string;

  beforeEach(async () => {
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
  });

  afterEach(async () => {
    await cleanupDataFull();
  });

  it("should create a simple plan without features", async () => {
    const client = createTestApiClient(sessionToken);

    const planData = {
      planName: "Simple Test Plan",
      planDescription: "A basic plan without features",
      stablePlanId: `simple-plan-${Date.now()}`,
      versionNumber: 1,
    };

    const response = await client.plans.$post({
      json: planData,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    if ("error" in body) {
      throw new Error(`Failed to create plan: ${body.error}`);
    }

    expect(body.plans[0].planName).toBe("Simple Test Plan");
    expect(body.plans[0].merchantId).toBe(merchantId);
    expect(body.plans[0].versionNumber).toBe(1);
  });

  it("should validate plan fields correctly", async () => {
    const client = createTestApiClient(sessionToken);

    // Test with missing required fields
    const invalidPlanData = {
      planDescription: "Missing plan name",
    };

    const response = await client.plans.$post({
      json: invalidPlanData as any,
    });

    expect(response.status).toBe(400);
  });

  it("should handle invalid plan ID retrieval", async () => {
    const client = createTestApiClient(sessionToken);

    const response = await client.plans[":id"].$get({
      param: { id: "plan_invalid_id_123" },
      query: { includeFeatures: "false" },
    });

    expect(response.status).toBe(404);
  });

  // Tests for editPlan function (when there are subscribers)
  describe("editPlan with subscribers", () => {
    afterEach(async () => {
      await cleanupDataFull();
    });

    it("should delegate to editPlanInPlace when no subscribers exist", async () => {
      // Create a plan without any subscribers
      const testPlan = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "test-feature",
            displayName: "Test Feature",
            description: "A test feature",
            featureValue: true as FeatureValue,
          },
        ],
        {
          stablePlanId: "delegation-test-plan",
          versionNumber: 1,
          planName: "Delegation Test Plan",
          planDescription: "Testing delegation behavior",
        }
      );

      // Call editPlan on a plan with no subscribers - should delegate to editPlanInPlace
      const { editPlan } = await import("../../../src/helpers/plans");
      const result = await editPlan(testPlan.plan.id, merchantId, {
        planName: "Updated Delegation Test Plan",
        planDescription: "Updated via delegation",
      });

      expect(result).toHaveProperty("success", true);
      if ("success" in result) {
        expect(result.changeAnalysis.isNewVersion).toBe(false); // editPlanInPlace behavior
        expect(result.migrationInfo.activeSubscriptionCount).toBe(0);
        expect(result.migrationInfo.requiresMigration).toBe(false);
      }
    });

    it("should create new plan version when active subscribers exist", async () => {
      // Create a plan with features and prices
      const testPlan = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "basic-feature",
            displayName: "Basic Feature",
            description: "A basic feature",
            featureValue: true as FeatureValue,
          },
        ],
        {
          stablePlanId: "subscriber-test-plan",
          versionNumber: 1,
          planName: "Subscriber Test Plan",
          planDescription: "Plan with subscribers",
        }
      );

      // Create a price for this plan
      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");
      const testPrice = await createTestPrice({
        planId: testPlan.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$29.99 per month",
              amount_cents: 2999,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      });

      // Create a customer and subscription for this plan
      const testCustomer = await createTestCustomer({
        merchantId,
        email: "test@example.com",
        name: "Test Customer",
      });

      // Create a subscription using the plan's price
      await createBasicSubscription(
        merchantId,
        testCustomer.id,
        testPlan.plan.id,
        testPrice.id
      );

      // Call editPlan with structural changes - should create new version due to active subscribers
      const { editPlan } = await import("../../../src/helpers/plans");
      const result = await editPlan(testPlan.plan.id, merchantId, {
        planName: "Updated Subscriber Test Plan",
        planDescription: "Updated plan with new version",
        features: [
          {
            slug: "basic-feature",
            featureName: "Basic Feature",
            isUsageBased: false,
          },
          {
            slug: "new-feature",
            featureName: "New Feature",
            isUsageBased: false,
          },
        ],
      });

      expect(result).toHaveProperty("success", true);
      if ("success" in result) {
        expect(result.changeAnalysis.isNewVersion).toBe(true); // New version created due to feature changes
        expect(result.changeAnalysis.hasFeatureChanges).toBe(true); // Feature changes detected
        expect(result.migrationInfo.activeSubscriptionCount).toBe(1);
        expect(result.migrationInfo.requiresMigration).toBe(true);
        expect(result.migrationInfo.affectedSubscriptions).toBe(1);

        // Verify the new plan has incremented version number
        expect(result.plan.versionNumber).toBe(2);
        expect(result.plan.stablePlanId).toBe(testPlan.plan.stablePlanId);
        expect(result.plan.planName).toBe("Updated Subscriber Test Plan");
        expect(result.plan.planDescription).toBe(
          "Updated plan with new version"
        );

        // Verify feature changes are tracked
        expect(result.resourceActions.featuresCreated.length).toBeGreaterThan(
          0
        ); // New feature added
      }
    });

    it("should correctly reuse identical features and create new ones", async () => {
      // Create a plan with existing features
      const testPlan = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "feature-to-reuse",
            displayName: "Feature To Reuse",
            description: "This feature will be reused",
            featureValue: true as FeatureValue,
          },
          {
            slug: "feature-to-remove",
            displayName: "Feature To Remove",
            description: "This feature will be removed",
            featureValue: false as FeatureValue,
          },
        ],
        {
          stablePlanId: "feature-reuse-test-plan",
          versionNumber: 1,
          planName: "Feature Reuse Test Plan",
          planDescription: "Testing feature reuse logic",
        }
      );

      // Create subscription to ensure new version is created
      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");
      const testPrice = await createTestPrice({
        planId: testPlan.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$19.99 per month",
              amount_cents: 1999,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      });

      const testCustomer = await createTestCustomer({
        merchantId,
        email: "reuse-test@example.com",
        name: "Reuse Test Customer",
      });

      await createBasicSubscription(
        merchantId,
        testCustomer.id,
        testPlan.plan.id,
        testPrice.id
      );

      // Call editPlan - reuse one feature, remove one, add one new
      const { editPlan } = await import("../../../src/helpers/plans");
      const result = await editPlan(testPlan.plan.id, merchantId, {
        planName: "Updated Feature Reuse Test Plan",
        features: [
          {
            slug: "feature-to-reuse", // Identical to existing - should be reused
            featureName: "Feature To Reuse", // Same name as before
            isUsageBased: false,
          },
          {
            slug: "completely-new-feature", // New slug - should create new
            featureName: "Completely New Feature",
            isUsageBased: false,
          },
        ],
        // Note: feature-to-remove is omitted, so it's considered removed
      });

      expect(result).toHaveProperty("success", true);
      if ("success" in result) {
        expect(result.changeAnalysis.isNewVersion).toBe(true);
        expect(result.changeAnalysis.hasFeatureChanges).toBe(true);

        // Check resource actions tracking
        expect(result.resourceActions.featuresReused).toHaveLength(1); // feature-to-reuse
        expect(result.resourceActions.featuresCreated).toHaveLength(1); // completely-new-feature
        expect(result.resourceActions.featuresModified).toHaveLength(0); // none modified, only added/removed

        // Verify the new plan version
        expect(result.plan.versionNumber).toBe(2);
        expect(result.plan.planName).toBe("Updated Feature Reuse Test Plan");

        // Verify migration requirements
        expect(result.migrationInfo.requiresMigration).toBe(true);
      }
    });

    it("should edit metadata in-place even when subscribers exist (fixed behavior)", async () => {
      // Create a plan
      const testPlan = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "demo-feature",
            displayName: "Demo Feature",
            description: "A demo feature",
            featureValue: true as FeatureValue,
          },
        ],
        {
          stablePlanId: "behavior-demo-plan",
          versionNumber: 1,
          planName: "Original Plan Name",
          planDescription: "Original description",
        }
      );

      // Add subscriber
      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");
      const testPrice = await createTestPrice({
        planId: testPlan.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$10.00 per month",
              amount_cents: 1000,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      });

      const testCustomer = await createTestCustomer({
        merchantId,
        email: "behavior-demo@example.com",
        name: "Behavior Demo Customer",
      });

      await createBasicSubscription(
        merchantId,
        testCustomer.id,
        testPlan.plan.id,
        testPrice.id
      );

      // Make ONLY a description change (metadata only)
      const { editPlan } = await import("../../../src/helpers/plans");
      const result = await editPlan(testPlan.plan.id, merchantId, {
        planDescription: "Updated description - just metadata change",
        // No feature changes, no price changes, just description
      });

      expect(result).toHaveProperty("success", true);
      if ("success" in result) {
        // New fixed behavior: Metadata-only changes are edited in-place even with subscribers
        expect(result.changeAnalysis.isNewVersion).toBe(false);
        expect(result.plan.versionNumber).toBe(1); // Version NOT incremented for metadata-only
        expect(result.plan.id).toBe(testPlan.plan.id); // Same plan ID (in-place edit)
        expect(result.plan.planDescription).toBe(
          "Updated description - just metadata change"
        );

        // Migration info shows no migration needed for metadata-only changes
        expect(result.migrationInfo.activeSubscriptionCount).toBe(0); // editPlanInPlace doesn't track active subs
        expect(result.migrationInfo.requiresMigration).toBe(false);

        // No actual feature or price changes detected
        expect(result.changeAnalysis.hasFeatureChanges).toBe(false);
        expect(result.changeAnalysis.hasPriceChanges).toBe(false);
      }
    });

    it("should edit feature names in-place even when subscribers exist (rename-only)", async () => {
      // Create a plan with features
      const testPlan = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "feature-one",
            displayName: "Original Feature One",
            description: "First feature",
            featureValue: true as FeatureValue,
          },
          {
            slug: "feature-two",
            displayName: "Original Feature Two",
            description: "Second feature",
            featureValue: false as FeatureValue,
          },
        ],
        {
          stablePlanId: "rename-test-plan",
          versionNumber: 1,
          planName: "Feature Rename Test Plan",
          planDescription: "Plan for testing feature renames",
        }
      );

      // Add subscriber
      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");
      const testPrice = await createTestPrice({
        planId: testPlan.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$15.00 per month",
              amount_cents: 1500,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      });

      const testCustomer = await createTestCustomer({
        merchantId,
        email: "rename-test@example.com",
        name: "Rename Test Customer",
      });

      await createBasicSubscription(
        merchantId,
        testCustomer.id,
        testPlan.plan.id,
        testPrice.id
      );

      // Make ONLY feature name changes (same slugs, only featureName changed)
      const { editPlan } = await import("../../../src/helpers/plans");
      const result = await editPlan(testPlan.plan.id, merchantId, {
        features: [
          {
            slug: "feature-one", // Same slug
            featureName: "Renamed Feature One", // Only name changed
            isUsageBased: false,
          },
          {
            slug: "feature-two", // Same slug
            featureName: "Renamed Feature Two", // Only name changed
            isUsageBased: false,
          },
        ],
      });

      expect(result).toHaveProperty("success", true);
      if ("success" in result) {
        // Feature rename-only changes should be edited in-place even with subscribers
        expect(result.changeAnalysis.isNewVersion).toBe(false);
        expect(result.plan.versionNumber).toBe(1); // Version NOT incremented for rename-only
        expect(result.plan.id).toBe(testPlan.plan.id); // Same plan ID (in-place edit)

        // Verify the feature names were actually updated
        const updatedFeatureOne = result.plan.features.find(
          (f: any) => f.slug === "feature-one"
        );
        const updatedFeatureTwo = result.plan.features.find(
          (f: any) => f.slug === "feature-two"
        );
        expect(updatedFeatureOne?.displayName).toBe("Renamed Feature One");
        expect(updatedFeatureTwo?.displayName).toBe("Renamed Feature Two");

        // Migration info shows no migration needed for rename-only changes
        expect(result.migrationInfo.activeSubscriptionCount).toBe(0); // editPlanInPlace doesn't track active subs
        expect(result.migrationInfo.requiresMigration).toBe(false);

        // Should detect feature changes but handle them in-place
        expect(result.changeAnalysis.hasFeatureChanges).toBe(true); // Names changed
        expect(result.changeAnalysis.hasPriceChanges).toBe(false);
      }
    });

    it("should handle credit allowance changes with subscribers", async () => {
      // Create a plan with a usage-based feature that has the proper infrastructure
      const testPlan = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "api-calls",
            displayName: "API Calls",
            description: "Monthly API call allowance",
            featureValue: "usage_based" as FeatureValue,
            featureType: "number" as FeatureType,
          },
        ],
        {
          stablePlanId: "credit-change-plan",
          versionNumber: 1,
          planName: "Credit Test Plan",
          planDescription: "Plan with credit allowances",
        }
      );

      // Create a metric for tracking API call usage
      const client = createTestApiClient(sessionToken);
      const metricResponse = await client.metrics.$post({
        json: {
          name: "API Call Usage Metric",
          eventName: "api_call",
          aggregationType: "SUM" as const,
          valueType: "NUMERIC" as const,
          description: "Tracks total API call usage",
          queryType: "simple" as const,
        },
      });
      expect(metricResponse.status).toBe(201);
      const metricData = await metricResponse.json();
      if ("error" in metricData) {
        throw new Error(`Failed to create metric: ${metricData.error}`);
      }

      // Link the feature to the metric
      const featureUpdateResponse = await client.features[":featureId"].$put({
        param: { featureId: testPlan.features[0].id },
        json: { metricIds: [metricData.id] },
      });
      expect(featureUpdateResponse.status).toBe(200);

      // Add subscriber with proper pricing infrastructure
      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");
      const { createTestUsageCreditDefinition } = await import(
        "../../test-helpers/data/credits"
      );
      const testPrice = await createTestPrice({
        planId: testPlan.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$25.00 per month",
              amount_cents: 2500,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
            {
              component_name: "api_usage",
              type: "usage",
              label: "API Call Usage",
              unit_label: "API call",
              metric_id: metricData.id,
              unit_cost_cents: 10, // 10 cents per API call
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: false,
            },
          ],
        },
      });

      // Create initial credit definition for the existing plan
      const usageComponent = testPrice.pricingData.components.find(
        (c) => c.type === "usage" && c.metric_id === metricData.id
      );
      expect(usageComponent).toBeDefined();

      const initialCreditDef = await createTestUsageCreditDefinition({
        merchantId,
        planId: testPlan.plan.id,
        featureId: testPlan.features[0].id,
        featureSlug: testPlan.features[0].slug,
        priceId: testPrice.id,
        priceComponentId: usageComponent!.component_id!,
        currency: "USD",
        creditAmount: 500, // 500 free API calls initially
        name: "Initial API Credits",
        description: "Initial API call credits",
        applicationType: "usage",
      });

      const testCustomer = await createTestCustomer({
        merchantId,
        email: "credit-test@example.com",
        name: "Credit Test Customer",
      });

      await createBasicSubscription(
        merchantId,
        testCustomer.id,
        testPlan.plan.id,
        testPrice.id
      );

      // Make changes that include credit allowances
      const { editPlan } = await import("../../../src/helpers/plans");
      const result = await editPlan(testPlan.plan.id, merchantId, {
        planName: "Updated Credit Test Plan",
        features: [
          {
            slug: "api-calls",
            featureName: "API Calls",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 10, // 10 cents per API call
            hasCreditAllowance: true,
            creditAllowanceAmount: 1000, // 1000 free API calls per month
            creditAllowanceRenewal: "monthly",
          },
        ],
      });

      expect(result).toHaveProperty("success", true);
      if ("success" in result) {
        // Credit allowance changes should create new version
        expect(result.changeAnalysis.isNewVersion).toBe(true);
        expect(result.changeAnalysis.hasFeatureChanges).toBe(false); // only the Credit Def changed, not the feature
        expect(result.plan.versionNumber).toBe(2);

        // Should track credit creation
        expect(result.resourceActions.creditsCreated.length).toBeGreaterThan(0);

        // Requires migration due to feature changes
        expect(result.migrationInfo.requiresMigration).toBe(true);
      }
    });
  });

  it("should create new plan version with updated prices and mark migration required when subscribers exist", async () => {
    // 1. Create a base plan with an initial price so that we have a known starting point
    const initialPlan = await createTestPlanWithFeatures(
      merchantId,
      [
        {
          slug: "price-update-feature",
          displayName: "Price Update Feature",
          description: "Feature for price update test",
          featureValue: true as FeatureValue,
        },
      ],
      {
        stablePlanId: "price-update-test-plan",
        versionNumber: 1,
        planName: "Price Update Test Plan",
        planDescription: "Plan used to test price updates with subscribers",
      }
    );

    // 2. Attach an initial price record (monthly only)
    const { createTestPrice, createTestCustomer, createBasicSubscription } =
      await import("../../test-helpers");

    const startingMonthlyAmount = 3000; // $30.00

    const initialPrice = await createTestPrice({
      planId: initialPlan.plan.id,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly",
            type: "fixed",
            label: "$30.00 per month",
            amount_cents: startingMonthlyAmount,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
            bill_immediately: true,
          },
        ],
      },
    });

    it("should create a new version even for a no-op edit but report no changes", async () => {
      // Setup: create plan with subscriber
      const basePlan = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "noop-feature",
            displayName: "NoOp Feature",
            description: "Feature for noop test",
            featureValue: true as FeatureValue,
          },
        ],
        {
          stablePlanId: "noop-test-plan",
          versionNumber: 1,
          planName: "NoOp Test Plan",
          planDescription: "Plan to test noop edit",
        }
      );

      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");

      // Attach a basic price
      const price = await createTestPrice({
        planId: basePlan.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$20.00 per month",
              amount_cents: 2000,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      });

      // Make it active by adding subscriber
      const cust = await createTestCustomer({
        merchantId,
        email: "noop@example.com",
        name: "NoOp Customer",
      });
      await createBasicSubscription(
        merchantId,
        cust.id,
        basePlan.plan.id,
        price.id
      );

      // --- Call editPlan with EMPTY input (no-op) ---
      const { editPlan } = await import("../../../src/helpers/plans");
      const result = await editPlan(basePlan.plan.id, merchantId, {});

      expect(result).toHaveProperty("success", true);
      if ("success" in result) {
        const {
          changeAnalysis,
          plan: newPlan,
          migrationInfo,
          resourceActions,
        } = result;

        expect(changeAnalysis.isNewVersion).toBe(true);
        expect(changeAnalysis.hasFeatureChanges).toBe(false);
        expect(changeAnalysis.hasPriceChanges).toBe(false);
        expect(changeAnalysis.hasNumericFeatureChanges).toBe(false);
        expect(changeAnalysis.canUseImmediate).toBe(true);

        expect(resourceActions.featuresCreated.length).toBe(0);
        expect(resourceActions.pricesCreated.length).toBe(0);

        expect(newPlan.versionNumber).toBe(2);

        // Old plan remains unchanged
        const apiClient = createTestApiClient(sessionToken);
        const oldPlanResp = await apiClient.plans[":id"].$get({
          param: { id: basePlan.plan.id },
          query: { includeFeatures: "true" },
        });
        const oldBody = await oldPlanResp.json();
        if ("error" in oldBody) {
          throw new Error(`Failed to fetch old plan: ${oldBody.error}`);
        }
        expect(oldBody.plans[0].versionNumber).toBe(1);

        // Migration required because subscriber exists even though no changes
        expect(migrationInfo.activeSubscriptionCount).toBe(1);
        expect(migrationInfo.requiresMigration).toBe(true);
      }
    });

    it("should detect yearly price removal as a price change", async () => {
      // Plan with monthly + yearly price, plus subscriber
      const planRes = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "yr-feature",
            displayName: "Yearly Feature",
            description: "Feature for yearly removal test",
            featureValue: true as FeatureValue,
          },
        ],
        {
          stablePlanId: "yearly-removal-plan",
          versionNumber: 1,
          planName: "Yearly Removal Plan",
          planDescription: "Testing yearly price removal",
        }
      );

      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");

      // Monthly + Annual components
      const startMonthly = 4000;
      const startYearly = 44000;

      await createTestPrice({
        planId: planRes.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$40 per month",
              amount_cents: startMonthly,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
            {
              component_name: "annual",
              type: "fixed",
              label: "$440 per year",
              amount_cents: startYearly * 12,
              recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      });

      const cust = await createTestCustomer({
        merchantId,
        email: "yearly@example.com",
        name: "Yearly Customer",
      });
      // Need a price id – just fetch one via helper
      const { createTestApiClient } = await import("../../test-helpers/api");
      // But easier: list prices after creation to grab first price
      const apiClientForPrice = createTestApiClient(sessionToken);
      const priceListResp = await apiClientForPrice.prices.$get({
        query: { planId: planRes.plan.id },
      });
      const priceListBody = await priceListResp.json();
      if ("error" in priceListBody) {
        throw new Error(`Failed to list prices: ${priceListBody.error}`);
      }
      const firstPriceId = priceListBody.prices[0].id;

      await createBasicSubscription(
        merchantId,
        cust.id,
        planRes.plan.id,
        firstPriceId
      );

      // Edit: remove yearly price by setting hasYearlyPrice false
      const { editPlan } = await import("../../../src/helpers/plans");
      const res = await editPlan(planRes.plan.id, merchantId, {
        hasYearlyPrice: false,
      });

      expect(res).toHaveProperty("success", true);
      if ("success" in res) {
        expect(res.changeAnalysis.hasPriceChanges).toBe(true);
        expect(res.plan.versionNumber).toBe(2);

        // Fetch new plan prices ensure annual component absent
        const apiClient = createTestApiClient(sessionToken);
        const priceResp = await apiClient.prices.$get({
          query: { planId: res.plan.id },
        });
        const body = await priceResp.json();
        if ("error" in body) {
          throw new Error(`Failed to fetch prices: ${body.error}`);
        }
        const components = body.prices.flatMap(
          (p: any) => p.pricingData.components
        );
        const annual = components.find(
          (c: any) => c.component_name === "annual"
        );
        expect(annual).toBeUndefined();
      }
    });

    it("should flag numeric feature changes without price impact and allow immediate migration", async () => {
      // Base plan with subscriber
      const planRes = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "views",
            displayName: "Views",
            description: "Usage based views",
            featureValue: "usage_based" as FeatureValue,
            featureType: "number" as FeatureType,
          },
        ],
        {
          stablePlanId: "numeric-change-plan",
          versionNumber: 1,
          planName: "Numeric Change Plan",
          planDescription: "Plan for numeric feature test",
        }
      );

      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");

      // Attach a simple price so subscriptions possible
      const price = await createTestPrice({
        planId: planRes.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$15 per month",
              amount_cents: 1500,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
          ],
        },
      });

      const cust = await createTestCustomer({
        merchantId,
        email: "numeric@example.com",
        name: "Numeric Customer",
      });

      await createBasicSubscription(
        merchantId,
        cust.id,
        planRes.plan.id,
        price.id
      );

      // Edit: add another usage feature WITHOUT price per unit
      const { editPlan } = await import("../../../src/helpers/plans");
      const res = await editPlan(planRes.plan.id, merchantId, {
        features: [
          {
            slug: "downloads",
            featureName: "Downloads",
            eventName: "download",
            isUsageBased: true,
            // usagePricePerUnit omitted
            hasCreditAllowance: false,
          },
        ],
      });

      expect(res).toHaveProperty("success", true);
      if ("success" in res) {
        expect(res.changeAnalysis.hasNumericFeatureChanges).toBe(true);
        expect(res.changeAnalysis.hasPriceChanges).toBe(false);
        expect(res.changeAnalysis.canUseImmediate).toBe(true);
        expect(res.plan.versionNumber).toBe(2);
      }
    });

    it("should treat usage price change as price change even when features identical", async () => {
      // Base plan with usage feature price 5 cents, subscriber
      const planRes = await createTestPlanWithFeatures(
        merchantId,
        [
          {
            slug: "api-usage",
            displayName: "API Usage",
            description: "API calls",
            featureValue: "usage_based" as FeatureValue,
            featureType: "number" as FeatureType,
          },
        ],
        {
          stablePlanId: "usage-price-change-plan",
          versionNumber: 1,
          planName: "Usage Price Change Plan",
          planDescription: "Plan for usage price change test",
        }
      );

      const { createTestPrice, createTestCustomer, createBasicSubscription } =
        await import("../../test-helpers");

      // Initial price includes usage component cost 5
      const initialPrice = await createTestPrice({
        planId: planRes.plan.id,
        merchantId,
        currency: "USD",
        pricingData: {
          dsl_version: 1,
          components: [
            {
              component_name: "monthly",
              type: "fixed",
              label: "$10 per month",
              amount_cents: 1000,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: true,
            },
            {
              component_name: "usage_api-usage",
              type: "usage",
              label: "API Usage",
              unit_label: "call",
              metric_id: "dummy_metric_id",
              unit_cost_cents: 5,
              recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
              bill_immediately: false,
            },
          ],
        },
      });

      const cust = await createTestCustomer({
        merchantId,
        email: "usageprice@example.com",
        name: "Usage Price Customer",
      });

      await createBasicSubscription(
        merchantId,
        cust.id,
        planRes.plan.id,
        initialPrice.id
      );

      // Edit: same feature but new usage price 7
      const { editPlan } = await import("../../../src/helpers/plans");
      const res = await editPlan(planRes.plan.id, merchantId, {
        features: [
          {
            slug: "api-usage",
            featureName: "API Usage",
            eventName: "api_call",
            isUsageBased: true,
            usagePricePerUnit: 7,
            hasCreditAllowance: false,
          },
        ],
      });

      expect(res).toHaveProperty("success", true);
      if ("success" in res) {
        expect(res.changeAnalysis.hasPriceChanges).toBe(true);
        expect(res.changeAnalysis.hasFeatureChanges).toBe(false); // identical feature
        expect(res.plan.versionNumber).toBe(2);

        // Verify usage component cost updated
        const apiClient = createTestApiClient(sessionToken);
        const priceResp = await apiClient.prices.$get({
          query: { planId: res.plan.id },
        });
        const body = await priceResp.json();
        if ("error" in body) {
          throw new Error(`Failed to fetch prices: ${body.error}`);
        }
        const comps = body.prices.flatMap((p: any) => p.pricingData.components);
        const usageComp = comps.find(
          (c: any) => c.component_name === "usage_api-usage"
        );
        expect(usageComp).toBeDefined();
        expect((usageComp as any).unit_cost_cents).toBe(7);
      }
    });

    // 3. Create a customer and subscribe them to the plan so that active subscriptions exist
    const testCustomer = await createTestCustomer({
      merchantId,
      email: "price-update@example.com",
      name: "Price Update Customer",
    });

    await createBasicSubscription(
      merchantId,
      testCustomer.id,
      initialPlan.plan.id,
      initialPrice.id
    );

    // 4. Perform the edit with new monthly and yearly prices
    const { editPlan } = await import("../../../src/helpers/plans");

    const updatedMonthlyAmount = 5000; // $50.00
    const updatedYearlyAmount = 55000; // $550.00 yearly (billed annually)

    const editResult = await editPlan(initialPlan.plan.id, merchantId, {
      monthlyPrice: updatedMonthlyAmount,
      hasYearlyPrice: true,
      yearlyPrice: updatedYearlyAmount,
    });

    expect(editResult).toHaveProperty("success", true);

    if ("success" in editResult) {
      const {
        changeAnalysis,
        plan: newPlan,
        resourceActions,
        migrationInfo,
      } = editResult;

      // 4.a A brand-new version must have been created
      expect(changeAnalysis.isNewVersion).toBe(true);
      expect(newPlan.versionNumber).toBe(2);
      expect(newPlan.stablePlanId).toBe(initialPlan.plan.stablePlanId);

      // 4.b Price changes should be detected and immediate migration not possible
      expect(changeAnalysis.hasPriceChanges).toBe(true);
      expect(changeAnalysis.canUseImmediate).toBe(false);

      // 4.c At least one new price record should have been created
      expect(resourceActions.pricesCreated.length).toBeGreaterThan(0);

      // 4.d Migration should be required because active subscribers exist
      expect(migrationInfo.activeSubscriptionCount).toBe(1);
      expect(migrationInfo.requiresMigration).toBe(true);

      // 4.e Fetch prices for the NEW plan and verify updated amounts
      const client = createTestApiClient(sessionToken);
      const priceResp = await client.prices.$get({
        query: { planId: newPlan.id },
      });
      const priceBody = await priceResp.json();
      if ("error" in priceBody) {
        throw new Error(
          `Failed to fetch prices for new plan: ${priceBody.error}`
        );
      }

      // Flatten components for easy lookup
      const components = priceBody.prices.flatMap(
        (p: any) => p.pricingData.components ?? []
      );
      const monthlyComp = components.find(
        (c: any) => c.component_name === "monthly" && c.type === "fixed"
      );
      const annualComp = components.find(
        (c: any) => c.component_name === "annual" && c.type === "fixed"
      );

      expect(monthlyComp).toBeDefined();
      expect((monthlyComp as any).amount_cents).toBe(updatedMonthlyAmount);

      expect(annualComp).toBeDefined();
      expect((annualComp as any).amount_cents).toBe(updatedYearlyAmount * 12);
    }
  });
});
