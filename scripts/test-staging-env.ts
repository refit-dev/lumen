#!/usr/bin/env bun

/**
 * Usage Instructions:
 * ------------------
 * 1. Login to your staging account at https://lumen-ui.vercel.app
 *
 * 2. Create an API key by making the following curl request:
 *    (You need to get the better-auth.session_token from your browser cookies)

    curl --request POST \
      --url https://lumen-staging.pretzelai.app/v1/api-keys \
      --header 'content-type: application/json' \
      --header 'cookie: better-auth.session_token=<SESSION TOKEN FROM BROWSER>' \
      --data '{
        "name": "Staging API Key",
        "keyType": "secret"
    }'

 * 3. Update the .env file in the root directory with the following content:
 *    API_BASE_URL=https://lumen-staging.pretzelai.app
 *    LUMEN_API_KEY=<YOUR API KEY>
 *
 * 4. Run the script:
 *    $ bun test-staging-env.ts
 */

// No need to import fetch as it's built into Bun

// Define interfaces for the API responses
interface Feature {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  featureValue: boolean | number | string;
  merchantId: string;
  featureType: string;
  isOverrideFeature: boolean | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  metricId?: string;
}

interface Metric {
  id: string;
  merchantId: string;
  name: string;
  description?: string;
  eventName: string;
  aggregationType: "COUNT" | "SUM" | "MAX" | "MIN" | "UNIQUE_COUNT";
  valueType: "NUMERIC" | "STRING" | "BOOLEAN";
  queryType: "simple" | "indexed" | "complex";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface Plan {
  id: string;
  merchantId: string;
  planName: string;
  planDescription: string;
  stablePlanId: string;
  versionNumber: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface Price {
  id: string;
  planId: string;
  merchantId: string;
  currency: string;
  pricingData: any;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface Customer {
  id: string;
  merchantId: string;
  email: string;
  name: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface SubscriptionDetails {
  id: string;
  subscriptionId: string;
  nextBillingDate: string;
  cyclesBilled: number;
  createdAt: string;
  updatedAt: string;
}

interface Subscription {
  id: string;
  customerId: string;
  planId: string;
  effectivePriceId: string;
  merchantId: string;
  stableSubscriptionId: string;
  versionNumber: number;
  createdAt: string;
  deletedAt: string | null;
  priceOverrideId: string | null;
  featureOverrideId: string | null;
  startTimestamp: string;
  endTimestamp: string | null;
  subscriptionDetails?: SubscriptionDetails;
}

interface FeatureResponse {
  feature: Feature;
}

interface MetricResponse {
  id: string;
  merchantId: string;
  name: string;
  description: string | null;
  eventName: string;
  aggregationType: "COUNT" | "SUM" | "MAX" | "MIN" | "UNIQUE_COUNT";
  valueType: "NUMERIC" | "STRING" | "BOOLEAN";
  queryType: "simple" | "indexed" | "complex";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface PlanResponse {
  plans: Plan[];
}

interface PriceResponse {
  price: Price;
}

interface CustomerResponse {
  customer: Customer;
}

interface SubscriptionResponse {
  subscription: Subscription;
}

interface SubscriptionDetailsResponse {
  subscription: Subscription;
}

// Add interfaces for events and entitlements
interface EventInput {
  eventName: string;
  customerId: string;
  idempotencyKey: string;
  eventTimestamp?: string;
  eventValue?: number;
  eventString?: string;
  properties?: Record<string, any>;
}

interface BatchEventInput {
  events: EventInput[];
}

interface FeatureEntitlement {
  entitled: boolean | null;
  feature: { slug: string; value: boolean | string | number | null } | null;
  source: string | null;
  usages?: { metricId: string; usage: number }[];
}

interface EntitlementResponse {
  entitlements: FeatureEntitlement[];
}

// Get API key from environment variable
const API_KEY = process.env.LUMEN_API_KEY;
if (!API_KEY) {
  console.error("Error: LUMEN_API_KEY environment variable is not set");
  process.exit(1);
}

// Base URL for the API
const BASE_URL =
  process.env.API_BASE_URL || "https://lumen-staging.pretzelai.app";

// Headers for all requests
const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

console.log(`Using API at: ${BASE_URL}`);

// Parse command line arguments
const args = process.argv.slice(2);
const isStepwise = !args.includes("--run-all");
let startStep = 1;

// Output information about the running mode
if (isStepwise) {
  console.log(
    "Running in stepwise mode (default). Pass --run-all to run all steps without pausing."
  );
} else {
  console.log(
    "Running all steps without pausing. Remove --run-all flag to run in stepwise mode."
  );
}

// Define all steps for reference
const STEPS = [
  "Clean up existing data",
  "Create metrics for usage-based features",
  "Create features for both plans",
  "Create Starter plan",
  "Create Pro plan",
  "Create price for Starter plan",
  "Create price for Pro plan",
  "Create a customer",
  "Create a subscription to the Pro plan",
  "Get subscription details",
  "Send events for metrics",
  "Check feature entitlements",
];

// Helper function to prompt for user input
async function prompt(message: string): Promise<string> {
  // Use process.stdin directly since Bun.prompt isn't available
  process.stdout.write(message);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");

    // Create a named function that we can later remove as a listener
    function dataHandler(data: string) {
      resolve(data.toString().trim());
      stdin.pause();
      // Explicitly remove this listener after it's used
      stdin.removeListener("data", dataHandler);
    }

    // Add the listener with our named function instead of an anonymous one
    stdin.once("data", dataHandler);
  });
}

// Helper function to wait for user confirmation before proceeding to the next step
async function waitForNextStep(
  stepNumber: number,
  stepDescription: string
): Promise<void> {
  if (isStepwise) {
    console.log(`\n[Step ${stepNumber}/${STEPS.length}] ${stepDescription}`);
    await prompt("Press Enter to continue...");
  }
}

// Function to display all steps and let user choose where to start
async function chooseStartingStep(): Promise<number> {
  if (!isStepwise) return 1;

  console.log("\nAvailable steps:");
  STEPS.forEach((step, index) => {
    console.log(`${index + 1}. ${step}`);
  });

  let selectedStep = 1;
  try {
    const input = await prompt(
      "\nEnter the step number to start from (default: 1): "
    );
    if (input && input.trim() !== "") {
      const parsedStep = parseInt(input.trim(), 10);
      if (!isNaN(parsedStep) && parsedStep >= 1 && parsedStep <= STEPS.length) {
        selectedStep = parsedStep;
      } else {
        console.log(`Invalid step number. Starting from step 1.`);
      }
    }
  } catch (error) {
    console.log("Error reading input. Starting from step 1.");
  }

  return selectedStep;
}

// Helper function to make API requests
async function makeRequest<T = any>(
  endpoint: string,
  method: string,
  body?: any
): Promise<T> {
  // Ensure endpoint starts with a slash and has the correct v1 path
  const formattedEndpoint = endpoint.startsWith("/")
    ? endpoint
    : `/${endpoint}`;
  const url = `${BASE_URL}${formattedEndpoint}`;
  console.log(`Making ${method} request to ${url}`);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `API request failed with status ${response.status}: ${errorText}`
      );
    }

    return response.json();
  } catch (error) {
    console.error(`Error making ${method} request to ${url}:`, error);
    throw error;
  }
}

// Function to fetch existing metrics
async function fetchExistingMetrics(): Promise<Metric[]> {
  try {
    console.log("Fetching existing metrics from API...");
    const response = await makeRequest<{ metrics: Metric[] }>(
      "/v1/metrics",
      "GET"
    );

    if (!response.metrics || response.metrics.length === 0) {
      console.log("No existing metrics found");
      return [];
    }

    console.log(`Found ${response.metrics.length} existing metrics`);
    return response.metrics;
  } catch (error) {
    console.error("Error fetching existing metrics:", error);
    return [];
  }
}

// Function to fetch existing subscriptions
async function fetchExistingSubscriptions(
  customerId?: string
): Promise<Subscription[]> {
  try {
    let endpoint = "/v1/subscriptions";
    if (customerId) {
      endpoint = `/v1/subscriptions/customer/${customerId}`;
    }

    console.log("Fetching existing subscriptions...");
    const response = await makeRequest<{ subscriptions: Subscription[] }>(
      endpoint,
      "GET"
    );

    if (!response.subscriptions || response.subscriptions.length === 0) {
      console.log("No existing subscriptions found");
      return [];
    }

    console.log(
      `Found ${response.subscriptions.length} existing subscriptions`
    );
    return response.subscriptions;
  } catch (error) {
    console.error("Error fetching subscriptions:", error);
    return [];
  }
}

// Function to clean up existing data
async function cleanupExistingData(): Promise<void> {
  console.log("Starting cleanup process...");

  // First, fetch all resources we need to delete
  try {
    // 1. Fetch existing subscriptions and delete them
    console.log("Fetching existing subscriptions...");
    const subsResponse = await makeRequest<{ subscriptions: Subscription[] }>(
      "/v1/subscriptions",
      "GET"
    );

    if (subsResponse.subscriptions && subsResponse.subscriptions.length > 0) {
      console.log(
        `Found ${subsResponse.subscriptions.length} subscriptions to delete`
      );

      for (const sub of subsResponse.subscriptions) {
        console.log(`Deleting subscription: ${sub.stableSubscriptionId}`);
        try {
          await makeRequest(
            `/v1/subscriptions/${sub.stableSubscriptionId}`,
            "DELETE"
          );
          console.log(`Deleted subscription: ${sub.stableSubscriptionId}`);
        } catch (error) {
          console.error(
            `Failed to delete subscription ${sub.stableSubscriptionId}:`,
            error
          );
        }
      }
    } else {
      console.log("No existing subscriptions found");
    }

    // 2. Fetch and delete customers
    console.log("Fetching existing customers...");
    const custResponse = await makeRequest<{ customers: Customer[] }>(
      "/v1/customers",
      "GET"
    );

    if (custResponse.customers && custResponse.customers.length > 0) {
      console.log(`Found ${custResponse.customers.length} customers to delete`);

      for (const cust of custResponse.customers) {
        console.log(`Deleting customer: ${cust.name} (${cust.id})`);
        try {
          await makeRequest(`/v1/customers/${cust.id}`, "DELETE");
          console.log(`Deleted customer: ${cust.id}`);
        } catch (error) {
          console.error(`Failed to delete customer ${cust.id}:`, error);
        }
      }
    } else {
      console.log("No existing customers found");
    }

    // 3. Fetch plans first, then delete prices for each plan
    console.log("Fetching existing plans...");
    const planResponse = await makeRequest<{ plans: Plan[] }>(
      "/v1/plans",
      "GET"
    );

    if (planResponse.plans && planResponse.plans.length > 0) {
      console.log(
        `Found ${planResponse.plans.length} plans. Checking for prices...`
      );

      // Delete prices for each plan
      let totalPricesDeleted = 0;
      for (const plan of planResponse.plans) {
        try {
          console.log(
            `Fetching prices for plan: ${plan.planName} (${plan.id})`
          );
          const priceResponse = await makeRequest<{ prices: Price[] }>(
            `/v1/prices?planId=${plan.id}`,
            "GET"
          );

          if (priceResponse.prices && priceResponse.prices.length > 0) {
            console.log(
              `Found ${priceResponse.prices.length} prices for plan ${plan.id}`
            );

            for (const price of priceResponse.prices) {
              console.log(`Deleting price: ${price.id}`);
              try {
                await makeRequest(`/v1/prices/${price.id}`, "DELETE");
                console.log(`Deleted price: ${price.id}`);
                totalPricesDeleted++;
              } catch (error) {
                console.error(`Failed to delete price ${price.id}:`, error);
              }
            }
          } else {
            console.log(`No prices found for plan ${plan.id}`);
          }
        } catch (error) {
          console.error(`Error fetching prices for plan ${plan.id}:`, error);
        }
      }

      console.log(`Total prices deleted: ${totalPricesDeleted}`);

      // 4. Now delete the plans
      for (const plan of planResponse.plans) {
        console.log(`Deleting plan: ${plan.planName} (${plan.id})`);
        try {
          await makeRequest(`/v1/plans/${plan.id}`, "DELETE");
          console.log(`Deleted plan: ${plan.id}`);
        } catch (error) {
          console.error(`Failed to delete plan ${plan.id}:`, error);
        }
      }
    } else {
      console.log("No existing plans found");
    }

    // 5. Fetch and delete features
    console.log("Fetching existing features...");
    const featureResponse = await makeRequest<{ features: Feature[] }>(
      "/v1/features",
      "GET"
    );

    if (featureResponse.features && featureResponse.features.length > 0) {
      console.log(
        `Found ${featureResponse.features.length} features to delete`
      );

      for (const feature of featureResponse.features) {
        console.log(`Deleting feature: ${feature.slug} (${feature.id})`);
        try {
          await makeRequest(`/v1/features/${feature.id}`, "DELETE");
          console.log(`Deleted feature: ${feature.id}`);
        } catch (error) {
          console.error(`Failed to delete feature ${feature.id}:`, error);
        }
      }
    } else {
      console.log("No existing features found");
    }

    // 6. Fetch and delete metrics
    console.log("Fetching existing metrics...");
    const metricResponse = await makeRequest<{ metrics: Metric[] }>(
      "/v1/metrics",
      "GET"
    );

    if (metricResponse.metrics && metricResponse.metrics.length > 0) {
      console.log(`Found ${metricResponse.metrics.length} metrics to delete`);

      for (const metric of metricResponse.metrics) {
        console.log(`Deleting metric: ${metric.name} (${metric.id})`);
        try {
          await makeRequest(`/v1/metrics/${metric.id}`, "DELETE");
          console.log(`Deleted metric: ${metric.id}`);
        } catch (error) {
          console.error(`Failed to delete metric ${metric.id}:`, error);
        }
      }
    } else {
      console.log("No existing metrics found");
    }

    // 7. Clear all events if endpoint exists (optional)
    // Note: Events don't have a clear/delete endpoint, so we'll skip this
    console.log("Note: Events are preserved as there is no API to clear them");

    console.log("Cleanup completed successfully");
  } catch (error) {
    console.error("Error during cleanup:", error);
    throw error;
  }
}

// Main function to orchestrate the setup
async function setupStagingEnvironment() {
  console.log("Setting up staging environment...");

  // Get the starting step if in stepwise mode
  if (isStepwise) {
    startStep = await chooseStartingStep();
    console.log(`Starting from step ${startStep}: ${STEPS[startStep - 1]}`);
  }

  // Initialize variables to hold created resources
  let metrics: Metric[] = [];
  let starterFeatures: Feature[] = [];
  let proFeatures: Feature[] = [];
  let starterPlan!: Plan; // Using definite assignment assertion
  let proPlan!: Plan;
  let starterPrice!: Price;
  let proPrice!: Price;
  let customer!: Customer;
  let subscription!: Subscription;
  let subscriptionDetails!: SubscriptionDetailsResponse;
  let entitlementResponse!: EntitlementResponse;

  // Step 0: Clean up existing data
  if (startStep <= 1) {
    await waitForNextStep(1, STEPS[0]);
    console.log("\n--- Cleaning Up Existing Data ---");
    await cleanupExistingData();
  }

  // If starting from events or entitlements steps, fetch real resources
  if (startStep === 11 || startStep === 12) {
    console.log(
      `Starting from ${startStep === 11 ? "events" : "entitlements"} step, fetching actual resources from API...`
    );
    metrics = await fetchExistingMetrics();

    // Also need to fetch a customer to use for events
    try {
      const customerResponse = await makeRequest<{ customers: Customer[] }>(
        "/v1/customers",
        "GET"
      );
      if (customerResponse.customers && customerResponse.customers.length > 0) {
        customer = customerResponse.customers[0];
        console.log(
          `Using existing customer: ${customer.name} (${customer.id})`
        );

        // Now fetch this customer's subscriptions
        const subscriptions = await fetchExistingSubscriptions(customer.id);
        if (subscriptions.length > 0) {
          subscription = subscriptions[0];
          console.log(
            `Using existing subscription: ${subscription.stableSubscriptionId}`
          );

          // Fetch subscription details
          try {
            subscriptionDetails = await getSubscriptionDetails(
              subscription.stableSubscriptionId
            );
            console.log(
              `Retrieved subscription details for ${subscription.stableSubscriptionId}`
            );
          } catch (error) {
            console.error("Error fetching subscription details:", error);
          }
        }
      } else {
        console.log("No existing customers found, will create a placeholder");
      }
    } catch (error) {
      console.error("Error fetching customers:", error);
    }
  }

  // Create dummy values for variables when starting from a later step
  if (startStep > 2 && startStep < 11) {
    console.log(
      "Starting from step > 2, creating placeholder objects for skipped steps"
    );

    // Create basic placeholder objects for skipped resources
    const placeholderId = `placeholder-${Date.now()}`;

    if (startStep > 2) {
      metrics = [
        {
          id: placeholderId,
          merchantId: placeholderId,
          name: "Placeholder Metric",
          eventName: "placeholder.event",
          aggregationType: "COUNT",
          valueType: "NUMERIC",
          queryType: "simple",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        },
      ];
    }

    if (startStep > 3) {
      const placeholderFeature = {
        id: placeholderId,
        slug: "placeholder-feature",
        displayName: "Placeholder Feature",
        description: "Placeholder description",
        featureValue: true,
        merchantId: placeholderId,
        featureType: "boolean",
        isOverrideFeature: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };

      starterFeatures = [placeholderFeature];
      proFeatures = [placeholderFeature];
    }

    if (startStep > 4) {
      starterPlan = {
        id: placeholderId,
        merchantId: placeholderId,
        planName: "Placeholder Starter Plan",
        planDescription: "Placeholder description",
        stablePlanId: placeholderId,
        versionNumber: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
    }

    if (startStep > 5) {
      proPlan = {
        id: placeholderId,
        merchantId: placeholderId,
        planName: "Placeholder Pro Plan",
        planDescription: "Placeholder description",
        stablePlanId: placeholderId,
        versionNumber: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
    }

    if (startStep > 6) {
      starterPrice = {
        id: placeholderId,
        planId: placeholderId,
        merchantId: placeholderId,
        currency: "USD",
        pricingData: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
    }

    if (startStep > 7) {
      proPrice = {
        id: placeholderId,
        planId: placeholderId,
        merchantId: placeholderId,
        currency: "USD",
        pricingData: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
    }

    if (startStep > 8) {
      customer = {
        id: placeholderId,
        merchantId: placeholderId,
        email: "placeholder@example.com",
        name: "Placeholder Customer",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
    }

    if (startStep > 9) {
      subscription = {
        id: placeholderId,
        customerId: placeholderId,
        planId: placeholderId,
        effectivePriceId: placeholderId,
        merchantId: placeholderId,
        stableSubscriptionId: placeholderId,
        versionNumber: 1,
        createdAt: new Date().toISOString(),
        deletedAt: null,
        priceOverrideId: null,
        featureOverrideId: null,
        startTimestamp: new Date().toISOString(),
        endTimestamp: null,
      };
    }
  }

  // Step 1: Create metrics for usage-based features
  if (startStep <= 2) {
    await waitForNextStep(2, STEPS[1]);
    console.log("\n--- Creating Metrics ---");
    metrics = await createMetrics();
    console.log(`Created ${metrics.length} metrics`);
  }

  // Step 2: Create features for both plans
  if (startStep <= 3) {
    await waitForNextStep(3, STEPS[2]);
    console.log("\n--- Creating Features ---");
    const features = await createFeaturesForPlans(metrics);
    starterFeatures = features.starterFeatures;
    proFeatures = features.proFeatures;
    console.log(`Created ${starterFeatures.length} features for Starter plan`);
    console.log(`Created ${proFeatures.length} features for Pro plan`);
  }

  // Step 3: Create Starter plan
  if (startStep <= 4) {
    await waitForNextStep(4, STEPS[3]);
    console.log("\n--- Creating Starter Plan ---");
    starterPlan = await createPlan(
      starterFeatures.map((f) => f.id),
      "Starter Plan",
      "Essential features for small businesses"
    );
    console.log(
      `Created Starter plan: ${starterPlan.planName} (${starterPlan.id})`
    );
  }

  // Step 4: Create Pro plan
  if (startStep <= 5) {
    await waitForNextStep(5, STEPS[4]);
    console.log("\n--- Creating Pro Plan ---");
    proPlan = await createPlan(
      proFeatures.map((f) => f.id),
      "Pro Plan",
      "Advanced features for growing businesses"
    );
    console.log(`Created Pro plan: ${proPlan.planName} (${proPlan.id})`);
  }

  // Step 5: Create price for Starter plan
  if (startStep <= 6) {
    await waitForNextStep(6, STEPS[5]);
    console.log("\n--- Creating Price for Starter Plan ---");
    starterPrice = await createPrice(starterPlan.id, 1999);
    console.log(
      `Created price for Starter plan: ${starterPrice.id} (${starterPrice.currency})`
    );
  }

  // Step 6: Create price for Pro plan
  if (startStep <= 7) {
    await waitForNextStep(7, STEPS[6]);
    console.log("\n--- Creating Price for Pro Plan ---");
    proPrice = await createPrice(proPlan.id, 4999);
    console.log(
      `Created price for Pro plan: ${proPrice.id} (${proPrice.currency})`
    );
  }

  // Step 7: Create a customer
  if (startStep <= 8) {
    await waitForNextStep(8, STEPS[7]);
    console.log("\n--- Creating Customer ---");
    customer = await createCustomer();
    console.log(`Created customer: ${customer.name} (${customer.id})`);
  }

  // Step 8: Create a subscription to the Pro plan
  if (startStep <= 9) {
    await waitForNextStep(9, STEPS[8]);
    console.log("\n--- Creating Subscription ---");
    subscription = await createSubscription(
      customer.id,
      proPlan.id,
      proPrice.id
    );
    console.log(`Created subscription: ${subscription.id}`);
    console.log(`Stable Subscription ID: ${subscription.stableSubscriptionId}`);
  }

  // Step 9: Get subscription details
  if (startStep <= 10) {
    await waitForNextStep(10, STEPS[9]);
    console.log("\n--- Getting Subscription Details ---");
    subscriptionDetails = await getSubscriptionDetails(
      subscription.stableSubscriptionId
    );
    console.log("Subscription details retrieved successfully");
    console.log(
      `Next billing date: ${subscriptionDetails.subscription.subscriptionDetails?.nextBillingDate}`
    );
  }

  // Step 10: Send events for metrics
  if (startStep <= 11) {
    await waitForNextStep(11, STEPS[10]);
    console.log("\n--- Sending Events for Metrics ---");

    // Log all available metrics to debug
    console.log(`Available metrics (${metrics.length}):`);
    metrics.forEach((m) =>
      console.log(`- ${m.name} (${m.id}): ${m.eventName}`)
    );

    const apiRequestMetric = metrics.find((m) =>
      m.name.includes("API Request")
    );
    const storageMetric = metrics.find((m) => m.name.includes("Storage Usage"));
    const activeUsersMetric = metrics.find((m) =>
      m.name.includes("Active Users")
    );
    const sessionsMetric = metrics.find(
      (m) =>
        m.name.includes("Concurrent Sessions") ||
        m.name.includes("Max Concurrent")
    );

    // Check which metrics were found
    const foundMetrics: string[] = [];
    const missingMetrics: string[] = [];

    if (apiRequestMetric) {
      foundMetrics.push(`API Request (${apiRequestMetric.eventName})`);
    } else {
      missingMetrics.push("API Request");
    }

    if (storageMetric) {
      foundMetrics.push(`Storage (${storageMetric.eventName})`);
    } else {
      missingMetrics.push("Storage Usage");
    }

    if (activeUsersMetric) {
      foundMetrics.push(`Active Users (${activeUsersMetric.eventName})`);
    } else {
      missingMetrics.push("Active Users");
    }

    if (sessionsMetric) {
      foundMetrics.push(`Sessions (${sessionsMetric.eventName})`);
    } else {
      missingMetrics.push("Concurrent Sessions");
    }

    // Report found and missing metrics
    if (foundMetrics.length > 0) {
      console.log("\nFound metrics:");
      foundMetrics.forEach((m) => console.log(`- ${m}`));
    }

    if (missingMetrics.length > 0) {
      console.log("\nMissing metrics:");
      missingMetrics.forEach((m) => console.log(`- ${m}`));
    }

    // Only proceed if we found all metrics
    if (
      apiRequestMetric &&
      storageMetric &&
      activeUsersMetric &&
      sessionsMetric
    ) {
      if (!customer || !customer.id) {
        console.error("No customer found. Cannot send events.");
      } else {
        await sendMetricEvents(customer.id, {
          apiRequestMetric,
          storageMetric,
          activeUsersMetric,
          sessionsMetric,
        });
        console.log("Events sent successfully");
      }
    } else {
      console.log(
        "\nCould not find all required metrics. Try running from step 1 to create metrics first."
      );

      if (isStepwise) {
        const createNewMetrics = await prompt(
          "Would you like to create new metrics now? (y/n): "
        );
        if (createNewMetrics?.toLowerCase() === "y") {
          console.log("Creating new metrics...");
          metrics = await createMetrics();

          // Now retry with the new metrics
          const apiRequestMetric = metrics.find((m) =>
            m.name.includes("API Request")
          );
          const storageMetric = metrics.find((m) =>
            m.name.includes("Storage Usage")
          );
          const activeUsersMetric = metrics.find((m) =>
            m.name.includes("Active Users")
          );
          const sessionsMetric = metrics.find(
            (m) =>
              m.name.includes("Concurrent Sessions") ||
              m.name.includes("Max Concurrent")
          );

          if (
            apiRequestMetric &&
            storageMetric &&
            activeUsersMetric &&
            sessionsMetric
          ) {
            if (!customer || !customer.id) {
              console.error("No customer found. Cannot send events.");
            } else {
              await sendMetricEvents(customer.id, {
                apiRequestMetric,
                storageMetric,
                activeUsersMetric,
                sessionsMetric,
              });
              console.log("Events sent successfully");
            }
          } else {
            console.error(
              "Still missing some metrics after creation. Cannot proceed."
            );
          }
        }
      }
    }
  }

  // Step 11: Check feature entitlements
  if (startStep <= 12) {
    await waitForNextStep(12, STEPS[11]);
    console.log("\n--- Checking Feature Entitlements ---");
    entitlementResponse = await checkFeatureEntitlements(customer.id);
    console.log("Feature entitlements retrieved successfully");

    // Display entitlements with usage
    const entitlementsWithUsage = entitlementResponse.entitlements.filter(
      (e) => e.usages && e.usages.length > 0
    );
    if (entitlementsWithUsage.length > 0) {
      console.log("\nUsage-based entitlements:");
      entitlementsWithUsage.forEach((entitlement) => {
        console.log(`\nFeature: ${entitlement.feature?.slug}`);
        console.log(`Entitled: ${entitlement.entitled}`);
        console.log(`Limit: ${entitlement.feature?.value}`);
        console.log("Current usage:");
        entitlement.usages?.forEach((usage) => {
          const metricName =
            metrics.find((m) => m.id === usage.metricId)?.name ||
            usage.metricId;
          console.log(`  ${metricName}: ${usage.usage}`);
        });
      });

      // Validate expected usage against actual usage
      console.log("\n--- Validating Usage Values ---");

      // Expected usage values from the events we sent
      const expectedUsage = {
        apiRequests: 10,
        storage: 2000,
        activeUsers: 5,
        concurrentSessions: 4,
      };

      // Find the entitlements for each feature type
      const apiRequestsEntitlement = entitlementsWithUsage.find((e) =>
        e.feature?.slug.includes("api-requests")
      );
      const storageEntitlement = entitlementsWithUsage.find((e) =>
        e.feature?.slug.includes("storage")
      );
      const activeUsersEntitlement = entitlementsWithUsage.find((e) =>
        e.feature?.slug.includes("active-users")
      );
      const sessionsEntitlement = entitlementsWithUsage.find((e) =>
        e.feature?.slug.includes("concurrent-sessions")
      );

      // Validate API Requests
      if (
        apiRequestsEntitlement &&
        apiRequestsEntitlement.usages &&
        apiRequestsEntitlement.usages.length > 0
      ) {
        const actualUsage = apiRequestsEntitlement.usages[0].usage;
        console.log(
          `API Requests - Expected: ${expectedUsage.apiRequests}, Actual: ${actualUsage}`
        );
        console.log(
          `  Match: ${actualUsage === expectedUsage.apiRequests ? "✅ YES" : "❌ NO"}`
        );
      } else {
        console.log("API Requests - Not found in entitlements");
      }

      // Validate Storage Usage
      if (
        storageEntitlement &&
        storageEntitlement.usages &&
        storageEntitlement.usages.length > 0
      ) {
        const actualUsage = storageEntitlement.usages[0].usage;
        console.log(
          `Storage Usage - Expected: ${expectedUsage.storage}, Actual: ${actualUsage}`
        );
        console.log(
          `  Match: ${actualUsage === expectedUsage.storage ? "✅ YES" : "❌ NO"}`
        );
      } else {
        console.log("Storage Usage - Not found in entitlements");
      }

      // Validate Active Users
      if (
        activeUsersEntitlement &&
        activeUsersEntitlement.usages &&
        activeUsersEntitlement.usages.length > 0
      ) {
        const actualUsage = activeUsersEntitlement.usages[0].usage;
        console.log(
          `Active Users - Expected: ${expectedUsage.activeUsers}, Actual: ${actualUsage}`
        );
        console.log(
          `  Match: ${actualUsage === expectedUsage.activeUsers ? "✅ YES" : "❌ NO"}`
        );
      } else {
        console.log("Active Users - Not found in entitlements");
      }

      // Validate Concurrent Sessions
      if (
        sessionsEntitlement &&
        sessionsEntitlement.usages &&
        sessionsEntitlement.usages.length > 0
      ) {
        const actualUsage = sessionsEntitlement.usages[0].usage;
        console.log(
          `Concurrent Sessions - Expected: ${expectedUsage.concurrentSessions}, Actual: ${actualUsage}`
        );
        console.log(
          `  Match: ${actualUsage === expectedUsage.concurrentSessions ? "✅ YES" : "❌ NO"}`
        );
      } else {
        console.log("Concurrent Sessions - Not found in entitlements");
      }

      // Calculate overall match percentage
      let matchCount = 0;
      let totalChecks = 0;

      if (apiRequestsEntitlement?.usages) {
        totalChecks++;
        if (
          apiRequestsEntitlement.usages[0].usage === expectedUsage.apiRequests
        )
          matchCount++;
      }

      if (storageEntitlement?.usages) {
        totalChecks++;
        if (storageEntitlement.usages[0].usage === expectedUsage.storage)
          matchCount++;
      }

      if (activeUsersEntitlement?.usages) {
        totalChecks++;
        if (
          activeUsersEntitlement.usages[0].usage === expectedUsage.activeUsers
        )
          matchCount++;
      }

      if (sessionsEntitlement?.usages) {
        totalChecks++;
        if (
          sessionsEntitlement.usages[0].usage ===
          expectedUsage.concurrentSessions
        )
          matchCount++;
      }

      const matchPercentage =
        totalChecks > 0 ? (matchCount / totalChecks) * 100 : 0;
      console.log(
        `\nOverall Usage Validation: ${matchCount}/${totalChecks} (${matchPercentage.toFixed(2)}%)`
      );
    }
  }

  // Log success message with all created resources
  console.log("\n=== Setup Complete ===");
  console.log("Created Resources:");

  if (metrics && metrics.length > 0) {
    console.log(
      "Metrics:",
      metrics.map((m) => ({ id: m.id, name: m.name }))
    );
  }

  if (starterFeatures && starterFeatures.length > 0) {
    console.log(
      "Starter Features:",
      starterFeatures.map((f) => ({
        id: f.id,
        slug: f.slug,
        value: f.featureValue,
      }))
    );
  }

  if (proFeatures && proFeatures.length > 0) {
    console.log(
      "Pro Features:",
      proFeatures.map((f) => ({
        id: f.id,
        slug: f.slug,
        value: f.featureValue,
      }))
    );
  }

  if (starterPlan && proPlan) {
    console.log("Plans:", [
      { id: starterPlan.id, name: starterPlan.planName },
      { id: proPlan.id, name: proPlan.planName },
    ]);
  }

  if (starterPrice && proPrice) {
    console.log("Prices:", [
      { id: starterPrice.id, plan: "Starter", currency: starterPrice.currency },
      { id: proPrice.id, plan: "Pro", currency: proPrice.currency },
    ]);
  }

  if (customer) {
    console.log("Customer:", { id: customer.id, email: customer.email });
  }

  if (subscription) {
    console.log("Subscription:", {
      id: subscription.id,
      stableId: subscription.stableSubscriptionId,
      plan: "Pro",
    });
  }

  return {
    metrics,
    starterFeatures,
    proFeatures,
    starterPlan,
    proPlan,
    starterPrice,
    proPrice,
    customer,
    subscription,
    subscriptionDetails,
    entitlementResponse,
  };
}

// Function to create metrics
async function createMetrics(): Promise<Metric[]> {
  const timestamp = Date.now();
  const metricData = [
    {
      name: `API Request Count Metric ${timestamp}`,
      eventName: `api.request.count.${timestamp}`,
      aggregationType: "COUNT" as const,
      valueType: "NUMERIC" as const,
      description: "Counts the number of API requests",
      queryType: "simple" as const,
    },
    {
      name: `Storage Usage Metric ${timestamp}`,
      eventName: `storage.usage.${timestamp}`,
      aggregationType: "SUM" as const,
      valueType: "NUMERIC" as const,
      description: "Measures total storage usage in MB",
      queryType: "simple" as const,
    },
    {
      name: `Active Users Metric ${timestamp}`,
      eventName: `user.active.${timestamp}`,
      aggregationType: "UNIQUE_COUNT" as const,
      valueType: "STRING" as const,
      description: "Tracks number of unique active users",
      queryType: "simple" as const,
    },
    {
      name: `Max Concurrent Sessions Metric ${timestamp}`,
      eventName: `session.concurrent.${timestamp}`,
      aggregationType: "MAX" as const,
      valueType: "NUMERIC" as const,
      description: "Tracks maximum concurrent user sessions",
      queryType: "simple" as const,
    },
  ];

  const createdMetrics: Metric[] = [];
  for (const data of metricData) {
    try {
      // The API returns the metric directly, not wrapped in a 'metric' field
      const response = await makeRequest<Metric>("/v1/metrics", "POST", data);

      if (response && response.id) {
        console.log(`Created metric: ${response.name} (${response.id})`);
        createdMetrics.push(response);
      } else {
        console.error(
          `Failed to create metric: ${data.name} - Invalid response format`,
          response
        );
      }
    } catch (error) {
      console.error(`Error creating metric ${data.name}:`, error);
    }
  }

  console.log(`Successfully created ${createdMetrics.length} metrics`);
  return createdMetrics;
}

// Function to create features for both plans
async function createFeaturesForPlans(
  metrics: Metric[]
): Promise<{ starterFeatures: Feature[]; proFeatures: Feature[] }> {
  // Find metrics by name pattern
  const apiRequestMetric = metrics.find((m) => m.name.includes("API Request"));
  const storageMetric = metrics.find((m) => m.name.includes("Storage Usage"));
  const activeUsersMetric = metrics.find((m) =>
    m.name.includes("Active Users")
  );
  const concurrentSessionsMetric = metrics.find((m) =>
    m.name.includes("Concurrent Sessions")
  );

  // Common features for both plans
  const commonFeatures = [
    {
      slug: "dashboard-access",
      displayName: "Dashboard Access",
      description: "Access to the main dashboard",
      featureValue: true,
    },
  ];

  // Starter plan specific features
  const starterOnlyFeatures = [
    {
      slug: "api-requests",
      displayName: "API Requests",
      description: "Number of API requests allowed per month",
      featureValue: 5000,
      metricId: apiRequestMetric?.id,
    },
    {
      slug: "storage",
      displayName: "Storage",
      description: "Storage capacity in MB",
      featureValue: 500,
      metricId: storageMetric?.id,
    },
    {
      slug: "active-users",
      displayName: "Active Users",
      description: "Number of active users allowed",
      featureValue: 3,
      metricId: activeUsersMetric?.id,
    },
    {
      slug: "concurrent-sessions",
      displayName: "Concurrent Sessions",
      description: "Maximum concurrent user sessions",
      featureValue: 2,
      metricId: concurrentSessionsMetric?.id,
    },
    {
      slug: "email-support",
      displayName: "Email Support",
      description: "Email support during business hours",
      featureValue: true,
    },
    {
      slug: "phone-support",
      displayName: "Phone Support",
      description: "Phone support with dedicated agent",
      featureValue: false,
    },
  ];

  // Pro plan specific features
  const proOnlyFeatures = [
    {
      slug: "api-requests",
      displayName: "API Requests",
      description: "Number of API requests allowed per month",
      featureValue: 50000,
      metricId: apiRequestMetric?.id,
    },
    {
      slug: "storage",
      displayName: "Storage",
      description: "Storage capacity in MB",
      featureValue: 5000,
      metricId: storageMetric?.id,
    },
    {
      slug: "active-users",
      displayName: "Active Users",
      description: "Number of active users allowed",
      featureValue: 10,
      metricId: activeUsersMetric?.id,
    },
    {
      slug: "concurrent-sessions",
      displayName: "Concurrent Sessions",
      description: "Maximum concurrent user sessions",
      featureValue: 5,
      metricId: concurrentSessionsMetric?.id,
    },
    {
      slug: "email-support",
      displayName: "Email Support",
      description: "Email support during business hours",
      featureValue: true,
    },
    {
      slug: "phone-support",
      displayName: "Phone Support",
      description: "Phone support with dedicated agent",
      featureValue: true,
    },
    {
      slug: "priority-support",
      displayName: "Priority Support",
      description: "Priority support with SLA guarantees",
      featureValue: true,
    },
    {
      slug: "advanced-analytics",
      displayName: "Advanced Analytics",
      description: "Access to advanced analytics features",
      featureValue: true,
    },
  ];

  // Create all unique features (we'll have different values for the same feature slugs)
  const timestamp = Date.now();

  // Add timestamp to make features unique across plans
  const starterFeatures = await createFeaturesWithTimestamp(
    [...commonFeatures, ...starterOnlyFeatures],
    `starter-${timestamp}`
  );

  const proFeatures = await createFeaturesWithTimestamp(
    [...commonFeatures, ...proOnlyFeatures],
    `pro-${timestamp}`
  );

  return { starterFeatures, proFeatures };
}

// Helper to create features with unique slugs
async function createFeaturesWithTimestamp(
  features: any[],
  prefix: string
): Promise<Feature[]> {
  const createdFeatures: Feature[] = [];

  for (const feature of features) {
    // Create a unique slug by adding the prefix
    const uniqueSlug = `${feature.slug}-${prefix}`;

    // Prepare feature data for the API call
    const { metricId, ...restOfFeature } = feature; // Extract metricId
    const featureData: any = {
      ...restOfFeature,
      slug: uniqueSlug,
    };

    // If a metricId was present, add it to the 'metricIds' array
    if (metricId) {
      featureData.metricIds = [metricId];
    }

    const response = await makeRequest<FeatureResponse>(
      "/v1/features",
      "POST",
      featureData
    );
    console.log(`Created feature: ${uniqueSlug}`);
    createdFeatures.push(response.feature);
  }

  return createdFeatures;
}

// Function to create a plan with features
async function createPlan(
  featureIds: string[],
  planName: string,
  planDescription: string
): Promise<Plan> {
  const timestamp = Date.now();
  const planData = {
    planName,
    planDescription,
    stablePlanId: `${planName.toLowerCase().replace(/\s+/g, "-")}-${timestamp}`,
    versionNumber: 1,
    featureIds,
  };

  const response = await makeRequest<PlanResponse>(
    "/v1/plans",
    "POST",
    planData
  );
  return response.plans[0];
}

// Function to create a price for the plan
async function createPrice(
  planId: string,
  basePriceCents: number
): Promise<Price> {
  const timestamp = Date.now();
  const priceData = {
    planId,
    currency: "USD",
    pricingData: {
      dsl_version: 1,
      components: [
        {
          component_name: `monthly_base_fee_${timestamp}`,
          type: "fixed",
          label: "Monthly Base Fee",
          amount_cents: basePriceCents,
          recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
          bill_immediately: false,
        },
        {
          component_name: `per_user_fee_${timestamp}`,
          type: "per_unit",
          unit_label: "User",
          label: "Per User Fee (Monthly)",
          amount_cents: 999,
          recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
          bill_immediately: false,
        },
      ],
    },
  };

  const response = await makeRequest<PriceResponse>(
    "/v1/prices",
    "POST",
    priceData
  );
  return response.price;
}

// Function to create a customer
async function createCustomer(): Promise<Customer> {
  const timestamp = Date.now();
  const customerData = {
    email: `test-customer-${timestamp}@example.com`,
    name: `Test Customer ${timestamp}`,
    timezone: "America/Los_Angeles",
  };

  const response = await makeRequest<CustomerResponse>(
    "/v1/customers",
    "POST",
    customerData
  );
  return response.customer;
}

// Function to create a subscription
async function createSubscription(
  customerId: string,
  planId: string,
  priceId: string
): Promise<Subscription> {
  const subscriptionData = {
    customerId,
    planId,
    effectivePriceId: priceId,
  };

  const response = await makeRequest<SubscriptionResponse>(
    "/v1/subscriptions",
    "POST",
    subscriptionData
  );
  return response.subscription;
}

// Function to get subscription details
async function getSubscriptionDetails(
  stableSubscriptionId: string
): Promise<SubscriptionDetailsResponse> {
  return makeRequest<SubscriptionDetailsResponse>(
    `/v1/subscriptions/${stableSubscriptionId}?includeFeatures=true`,
    "GET"
  );
}

// Function to send events for the metrics
async function sendMetricEvents(
  customerId: string,
  metrics: {
    apiRequestMetric: Metric;
    storageMetric: Metric;
    activeUsersMetric: Metric;
    sessionsMetric: Metric;
  }
): Promise<void> {
  const timestamp = Date.now();

  // Prepare event batches (we'll split them to avoid timeouts)
  const allEvents: EventInput[] = [
    // API Request Count events - 40 requests (but we'll send only 10 to avoid timeouts)
    ...Array(10)
      .fill(null)
      .map((_, i) => ({
        eventName: metrics.apiRequestMetric.eventName,
        customerId,
        idempotencyKey: `api-request-${timestamp}-${i}`,
        eventTimestamp: new Date().toISOString(),
        eventValue: 1,
        properties: { endpoint: `/api/resource/${i}` },
      })),

    // Storage Usage events - 2000 MB total
    {
      eventName: metrics.storageMetric.eventName,
      customerId,
      idempotencyKey: `storage-${timestamp}-1`,
      eventTimestamp: new Date().toISOString(),
      eventValue: 1000,
      properties: { type: "documents" },
    },
    {
      eventName: metrics.storageMetric.eventName,
      customerId,
      idempotencyKey: `storage-${timestamp}-2`,
      eventTimestamp: new Date().toISOString(),
      eventValue: 1000,
      properties: { type: "media" },
    },

    // Active Users events - 5 unique users
    ...["user1", "user2", "user3", "user4", "user5"].map((userId, i) => ({
      eventName: metrics.activeUsersMetric.eventName,
      customerId,
      idempotencyKey: `active-user-${timestamp}-${i}`,
      eventTimestamp: new Date().toISOString(),
      eventString: userId,
      properties: { action: "login" },
    })),

    // Concurrent Sessions events - max of 4
    {
      eventName: metrics.sessionsMetric.eventName,
      customerId,
      idempotencyKey: `sessions-${timestamp}-1`,
      eventTimestamp: new Date().toISOString(),
      eventValue: 2,
      properties: { time: "morning" },
    },
    {
      eventName: metrics.sessionsMetric.eventName,
      customerId,
      idempotencyKey: `sessions-${timestamp}-2`,
      eventTimestamp: new Date().toISOString(),
      eventValue: 4,
      properties: { time: "afternoon" },
    },
    {
      eventName: metrics.sessionsMetric.eventName,
      customerId,
      idempotencyKey: `sessions-${timestamp}-3`,
      eventTimestamp: new Date().toISOString(),
      eventValue: 3,
      properties: { time: "evening" },
    },
  ];

  // Split events into smaller batches of 10 to avoid timeouts
  const MAX_BATCH_SIZE = 10;
  const batches: EventInput[][] = [];

  for (let i = 0; i < allEvents.length; i += MAX_BATCH_SIZE) {
    batches.push(allEvents.slice(i, i + MAX_BATCH_SIZE));
  }

  console.log(
    `Split ${allEvents.length} events into ${batches.length} batches of max size ${MAX_BATCH_SIZE}`
  );

  // Function to send a batch with retries
  async function sendBatchWithRetry(
    events: EventInput[],
    maxRetries = 3
  ): Promise<boolean> {
    const batchPayload: BatchEventInput = { events };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `Sending batch of ${events.length} events (attempt ${attempt}/${maxRetries})...`
        );
        await makeRequest("/v1/events/batch", "POST", batchPayload);
        return true;
      } catch (error) {
        if (attempt === maxRetries) {
          console.error(
            `Failed to send batch after ${maxRetries} attempts:`,
            error
          );
          return false;
        } else {
          const delayMs = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(
            `Attempt ${attempt} failed. Retrying in ${delayMs / 1000} seconds...`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    return false;
  }

  // Send all batches
  let successCount = 0;
  for (const [index, batch] of batches.entries()) {
    console.log(
      `Sending batch ${index + 1}/${batches.length} (${batch.length} events)...`
    );
    const success = await sendBatchWithRetry(batch);
    if (success) {
      successCount++;
    }
  }

  // Log summary statistics
  console.log(`\nEvent sending summary:`);
  console.log(`- Total events: ${allEvents.length}`);
  console.log(`- Batches sent successfully: ${successCount}/${batches.length}`);
  console.log(`- Events by type:`);
  console.log(
    `  - API requests: ${allEvents.filter((e) => e.eventName === metrics.apiRequestMetric.eventName).length}`
  );
  console.log(
    `  - Storage usage: ${allEvents.filter((e) => e.eventName === metrics.storageMetric.eventName).length}`
  );
  console.log(
    `  - Active users: ${allEvents.filter((e) => e.eventName === metrics.activeUsersMetric.eventName).length}`
  );
  console.log(
    `  - Concurrent sessions: ${allEvents.filter((e) => e.eventName === metrics.sessionsMetric.eventName).length}`
  );

  // Wait a bit for event processing to complete
  console.log("\nWaiting 5 seconds for events to be processed...");
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

// Function to check feature entitlements
async function checkFeatureEntitlements(
  customerId: string
): Promise<EntitlementResponse> {
  return makeRequest(`/v1/entitlements/${customerId}`, "GET");
}

// Run the setup function
setupStagingEnvironment()
  .then((result) => {
    console.log("Setup completed successfully!");
  })
  .catch((error) => {
    console.error("Error during setup:", error);
    process.exit(1);
  });
