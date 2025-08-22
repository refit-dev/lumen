import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import {
  subscriptionFeatures,
  QueryType,
  AggregationType,
  ValueType,
  subscriptionDetails,
  customers,
} from "@lumen/common/schema";
import { getMetricsForFeature } from "../lib/featureMetrics";
import questDbService from "../db/questDbService";
import { TimeFrame } from "@lumen/common/validators";
import { getCreditAllowanceForFeature } from "../helpers/credits";

export type EntitlementSource = "plan" | "override" | "default" | "credits";

export interface FeatureEntitlement {
  entitled: boolean | null;
  feature: { slug: string; value: boolean | string | number | null } | null;
  source: EntitlementSource | null;
  usages?: { metricId: string; usage: number }[];
  creditInfo?: {
    creditAllowance: number;
    creditsRemaining: number;
    nextExpiryDate: Date | null;
  };
}

interface FeatureWithTimeframe {
  featureId: string;
  featureSlug: string;
  featureValue: string | number | boolean | null;
  source: "plan" | "override";
  customerId: string;
  nextBillingDate: Date | null;
  subscriptionStartDate: Date | null;
  previousBillingDate: Date | null;
}

/**
 * Get active features with their metric timeframe information
 * When isExtCustId is true, customerId is treated as externalCustomerId
 *
 * @param merchantId - Merchant ID
 * @param customerId - Customer ID (internal ID or externalCustomerId)
 * @param featureId - Optional feature ID to filter by
 * @param featureSlug - Optional feature slug to filter by
 * @param isExtCustId - When true, customerId is interpreted as externalCustomerId (external ID)
 */
async function getActiveFeaturesWithMetricTimeFrame(
  merchantId: string,
  customerId: string,
  featureId?: string,
  featureSlug?: string,
  isExtCustId: boolean = false
): Promise<FeatureWithTimeframe[]> {
  // Base query structure is different based on whether we're using
  // direct customerId or externalCustomerId lookup
  if (isExtCustId) {
    // When using externalCustomerId, we need to join with the customers table
    const conditions = [
      eq(subscriptionFeatures.merchantId, merchantId),
      eq(customers.externalCustomerId, customerId), // externalCustomerId is the same as extCustomerId
      isNull(subscriptionFeatures.deletedAt),
      isNull(subscriptionDetails.deletedAt),
      isNull(customers.deletedAt),
    ];

    if (featureId)
      conditions.push(eq(subscriptionFeatures.featureId, featureId));
    if (featureSlug)
      conditions.push(eq(subscriptionFeatures.featureSlug, featureSlug));

    return await db
      .select({
        featureId: subscriptionFeatures.featureId,
        featureSlug: subscriptionFeatures.featureSlug,
        featureValue: subscriptionFeatures.featureValue,
        source: subscriptionFeatures.source,
        customerId: subscriptionFeatures.customerId,
        nextBillingDate: subscriptionDetails.nextBillingDate,
        subscriptionStartDate: subscriptionDetails.subscriptionStartDate,
        previousBillingDate: subscriptionDetails.previousBillingDate,
      })
      .from(subscriptionFeatures)
      .leftJoin(
        subscriptionDetails,
        eq(
          subscriptionFeatures.subscriptionId,
          subscriptionDetails.subscriptionId
        )
      )
      .leftJoin(customers, eq(subscriptionFeatures.customerId, customers.id))
      .where(and(...conditions))
      .orderBy(subscriptionFeatures.source); // needed for override to work
  } else {
    // Original implementation using direct customerId
    const conditions = [
      eq(subscriptionFeatures.merchantId, merchantId),
      eq(subscriptionFeatures.customerId, customerId),
      isNull(subscriptionFeatures.deletedAt),
      isNull(subscriptionDetails.deletedAt),
    ];

    if (featureId)
      conditions.push(eq(subscriptionFeatures.featureId, featureId));
    if (featureSlug)
      conditions.push(eq(subscriptionFeatures.featureSlug, featureSlug));

    // this will be extremely fast because of the indexes and the small subsets
    // of data that we filter to
    return await db
      .select({
        featureId: subscriptionFeatures.featureId,
        featureSlug: subscriptionFeatures.featureSlug,
        featureValue: subscriptionFeatures.featureValue,
        source: subscriptionFeatures.source,
        customerId: subscriptionFeatures.customerId,
        nextBillingDate: subscriptionDetails.nextBillingDate,
        subscriptionStartDate: subscriptionDetails.subscriptionStartDate,
        previousBillingDate: subscriptionDetails.previousBillingDate,
      })
      .from(subscriptionFeatures)
      .leftJoin(
        subscriptionDetails,
        eq(
          subscriptionFeatures.subscriptionId,
          subscriptionDetails.subscriptionId
        )
      )
      .where(and(...conditions))
      .orderBy(subscriptionFeatures.source); // needed for override to work
  }
}

/**
 * Check if a customer is entitled to a feature based on credit grants
 * Credits ARE the entitlement limits, not offsets to subscription limits
 * For numeric features: entitled = actual_usage < total_credit_allowance
 *
 * @param merchantId - Merchant ID
 * @param customerId - Customer ID (internal ID or externalCustomerId)
 * @param featureSlug - Feature slug to check
 * @param isExtCustId - When true, customerId is interpreted as externalCustomerId (external ID)
 */
// Helper function to create credit info object
function createCreditInfo(
  creditAllowance: number,
  creditsRemaining: number,
  nextExpiryDate: Date | null
) {
  return {
    creditAllowance,
    creditsRemaining,
    nextExpiryDate,
  };
}

// Helper function to resolve both internal and external customer IDs
async function resolveCustomerIds(
  merchantId: string,
  customerIdentifier: string,
  isExtCustId: boolean
): Promise<{ internalId: string; externalId: string | null } | null> {
  try {
    let customer;

    if (isExtCustId) {
      // Looking up by external customer ID
      customer = await db
        .select({
          id: customers.id,
          externalCustomerId: customers.externalCustomerId,
        })
        .from(customers)
        .where(
          and(
            eq(customers.merchantId, merchantId),
            eq(customers.externalCustomerId, customerIdentifier),
            isNull(customers.deletedAt)
          )
        )
        .limit(1);
    } else {
      // Looking up by internal customer ID
      customer = await db
        .select({
          id: customers.id,
          externalCustomerId: customers.externalCustomerId,
        })
        .from(customers)
        .where(
          and(
            eq(customers.merchantId, merchantId),
            eq(customers.id, customerIdentifier),
            isNull(customers.deletedAt)
          )
        )
        .limit(1);
    }

    if (customer.length === 0) {
      return null; // Customer not found
    }

    return {
      internalId: customer[0].id,
      externalId: customer[0].externalCustomerId,
    };
  } catch (error) {
    console.error(
      `Failed to resolve customer IDs for ${customerIdentifier}:`,
      error
    );
    return null;
  }
}

// Helper function to resolve internal customer ID from external ID (backwards compatibility)
async function resolveInternalCustomerId(
  merchantId: string,
  customerId: string,
  isExtCustId: boolean,
  activeFeature?: FeatureWithTimeframe
): Promise<string> {
  if (!isExtCustId) {
    return customerId;
  }

  // If we already have an active feature, use its customer ID
  if (activeFeature) {
    return activeFeature.customerId;
  }

  // Otherwise, resolve using the new function
  const resolved = await resolveCustomerIds(
    merchantId,
    customerId,
    isExtCustId
  );
  return resolved?.internalId || customerId;
}

export async function getFeatureEntitlement(
  merchantId: string,
  customerId: string,
  featureSlug: string,
  isExtCustId: boolean = false
): Promise<FeatureEntitlement> {
  try {
    // Fetch feature definition first - we need this regardless
    const activeFeatureWithTimeFrame =
      await getActiveFeaturesWithMetricTimeFrame(
        merchantId,
        customerId,
        undefined,
        featureSlug,
        isExtCustId
      );

    const activeFeature = activeFeatureWithTimeFrame[0];

    // Resolve both internal and external customer IDs for comprehensive usage queries
    const resolvedIds = await resolveCustomerIds(
      merchantId,
      customerId,
      isExtCustId
    );

    // Use resolved IDs or fallback to provided ID if resolution fails
    const internalCustomerId =
      resolvedIds?.internalId ||
      (isExtCustId ? activeFeature?.customerId || customerId : customerId);
    const externalCustomerId =
      resolvedIds?.externalId || (isExtCustId ? customerId : undefined);

    // Get credit allowance for this feature - this is the primary entitlement source
    const creditAllowance = await getCreditAllowanceForFeature(
      merchantId,
      internalCustomerId,
      featureSlug
    );

    const hasCredits = creditAllowance.activeCredits > 0;
    const hasFeature = activeFeatureWithTimeFrame.length > 0;
    const isNumericFeature =
      hasFeature &&
      (typeof activeFeature.featureValue === "number" ||
        activeFeature.featureValue === "usage_based");

    // For numeric features, we always need to fetch usage data
    let usages: { metricId: string; usage: number }[] = [];
    if (isNumericFeature) {
      usages = await getFeatureUsages({
        merchantId,
        featureId: activeFeature.featureId,
        customerId: internalCustomerId,
        externalCustomerId: externalCustomerId,
        timeframeInfo: {
          subscriptionStartDate: activeFeature.subscriptionStartDate,
          previousBillingDate: activeFeature.previousBillingDate,
          nextBillingDate: activeFeature.nextBillingDate,
        },
      });
    }

    // Case 1: No credits but has plan feature - use plan feature
    if (!hasCredits && hasFeature) {
      return {
        entitled: true,
        feature: { slug: featureSlug, value: activeFeature.featureValue },
        source: activeFeature.source as EntitlementSource,
        ...(isNumericFeature && { usages }),
        creditInfo: createCreditInfo(0, 0, creditAllowance.nextExpiryDate),
      };
    }

    // Case 2: No credits and no plan feature - customer not entitled
    if (!hasCredits && !hasFeature) {
      return {
        entitled: false,
        feature: null,
        source: null,
        creditInfo: createCreditInfo(0, 0, creditAllowance.nextExpiryDate),
      };
    }

    // Case 3: Has credits and numeric feature - check usage against allowance
    if (hasCredits && isNumericFeature) {
      let entitled: boolean | null = null;

      if (usages.length === 0) {
        entitled = true; // No usage, customer is entitled
      } else if (usages.length === 1) {
        entitled = usages[0].usage < creditAllowance.activeCredits;
      } else {
        entitled = null; // Multiple metrics - let client decide
      }

      return {
        entitled,
        feature: { slug: featureSlug, value: creditAllowance.activeCredits },
        source: "credits", // Source is credits for numeric features with credit grants
        usages,
        creditInfo: createCreditInfo(
          creditAllowance.activeCredits,
          Math.max(0, creditAllowance.activeCredits - (usages[0]?.usage || 0)),
          creditAllowance.nextExpiryDate
        ),
      };
    }

    // Case 4: Has credits and boolean feature - use plan feature value but entitled due to credits
    if (hasCredits && hasFeature) {
      return {
        entitled: true,
        feature: { slug: featureSlug, value: activeFeature.featureValue },
        source: activeFeature.source as EntitlementSource, // Source is plan for boolean features
        creditInfo: createCreditInfo(
          creditAllowance.activeCredits,
          creditAllowance.activeCredits,
          creditAllowance.nextExpiryDate
        ),
      };
    }

    // Case 5: Has credits but no plan feature - credits-only entitlement
    if (hasCredits && !hasFeature) {
      return {
        entitled: true,
        feature: { slug: featureSlug, value: creditAllowance.activeCredits },
        source: "credits",
        creditInfo: createCreditInfo(
          creditAllowance.activeCredits,
          creditAllowance.activeCredits,
          creditAllowance.nextExpiryDate
        ),
      };
    }

    // Fallback case - should not happen but ensures function always returns
    return {
      entitled: false,
      feature: null,
      source: null,
      creditInfo: createCreditInfo(0, 0, null),
    };
  } catch (error) {
    console.error("Error checking entitlement:", error);
    throw error;
  }
}

/**
 * Get all feature entitlements for a customer (with credit integration)
 * This implementation uses the optimized indexes on subscriptionFeatures and includes credit allowances
 *
 * @param merchantId - Merchant ID
 * @param customerId - Customer ID (internal ID or externalCustomerId)
 * @param isExtCustId - When true, customerId is interpreted as externalCustomerId (external ID)
 */
export async function getAllFeatureEntitlements(
  merchantId: string,
  customerId: string,
  isExtCustId: boolean = false
): Promise<FeatureEntitlement[]> {
  try {
    const activeFeaturesWithTimeFrame =
      await getActiveFeaturesWithMetricTimeFrame(
        merchantId,
        customerId,
        undefined,
        undefined,
        isExtCustId
      );

    // If there are active features, compute entitlements.
    // Deduplicate by feature slug to avoid returning the same feature twice
    // when both plan and override rows exist for a subscription.
    if (activeFeaturesWithTimeFrame.length > 0) {
      const uniqueFeatureSlugs = Array.from(
        new Set(activeFeaturesWithTimeFrame.map((f) => f.featureSlug))
      );

      const entitlements = await Promise.all(
        uniqueFeatureSlugs.map(async (featureSlug) => {
          // Use the unified entitlement function for each feature to get credit integration
          return await getFeatureEntitlement(
            merchantId,
            customerId,
            featureSlug,
            isExtCustId
          );
        })
      );
      return entitlements;
    }

    return [];
  } catch (error) {
    console.error("Error fetching all entitlements:", error);
    throw error;
  }
}

/**
 * Check multiple feature entitlements with credit integration
 * This is optimized for batch checking multiple features for a single customer
 *
 * @param merchantId - Merchant ID
 * @param customerId - Customer ID (internal ID or externalCustomerId)
 * @param featureSlugs - Array of feature slugs to check
 * @param isExtCustId - When true, customerId is interpreted as externalCustomerId (external ID)
 */
export async function getBatchFeatureEntitlements(
  merchantId: string,
  customerId: string,
  featureSlugs: string[],
  isExtCustId: boolean = false
): Promise<FeatureEntitlement[]> {
  try {
    // Use the unified entitlement function for each requested feature
    const entitlements = await Promise.all(
      featureSlugs.map(async (featureSlug) => {
        return await getFeatureEntitlement(
          merchantId,
          customerId,
          featureSlug,
          isExtCustId
        );
      })
    );

    // Filter out features that weren't found (entitled: false, feature: null)
    return entitlements.filter(
      (entitlement) => entitlement.feature !== null || entitlement.creditInfo
    );
  } catch (error) {
    console.error("Error checking batch entitlements:", error);
    throw error;
  }
}

// Retrieve usages for all metrics associated with a feature, for a given customer
async function getFeatureUsages(params: {
  merchantId: string;
  featureId: string;
  customerId?: string;
  externalCustomerId?: string;
  timeframeInfo?: {
    subscriptionStartDate: Date | null;
    previousBillingDate: Date | null;
    nextBillingDate: Date | null;
  };
}): Promise<{ metricId: string; usage: number }[]> {
  const {
    merchantId,
    featureId,
    customerId,
    externalCustomerId,
    timeframeInfo,
  } = params;
  try {
    // Get metric IDs and definitions in a single call
    const metricDefinitions = await getMetricsForFeature(merchantId, featureId);

    if (!metricDefinitions.length) {
      return []; // No metrics to process
    }

    // Set up the timeframe based on billing dates if provided
    let timeframe: TimeFrame;
    if (timeframeInfo?.nextBillingDate) {
      const startDate =
        timeframeInfo.previousBillingDate ||
        timeframeInfo.subscriptionStartDate;
      if (startDate) {
        timeframe = {
          type: "ABSOLUTE",
          start: startDate,
          end: timeframeInfo.nextBillingDate,
        };
      } else {
        // Fallback to ALL if we don't have valid start date
        timeframe = { type: "ALL" };
      }
    } else {
      // Fallback to ALL if we don't have billing dates
      timeframe = { type: "ALL" };
    }

    // Query metric values in parallel and ensure the correct return type
    const results: { metricId: string; usage: number }[] = await Promise.all(
      metricDefinitions.map(
        async (metric): Promise<{ metricId: string; usage: number }> => {
          try {
            if (metric.queryType === "simple") {
              if (
                !metric.eventName ||
                !metric.aggregationType ||
                !metric.valueType
              ) {
                console.error(
                  `Simple metric ${metric.id} missing required fields`
                );
                return { metricId: metric.id, usage: 0 };
              }

              const result = await questDbService.queryMetrics({
                merchantId,
                customerId,
                externalCustomerId,
                eventName: metric.eventName,
                metricType: metric.queryType as QueryType,
                aggregation: metric.aggregationType as AggregationType,
                valueType: metric.valueType as ValueType,
                timeframe,
              });

              return {
                metricId: metric.id,
                usage: result.value !== null ? result.value : 0,
              };
            } else if (
              metric.queryType === "indexed" ||
              metric.queryType === "complex"
            ) {
              if (!metric.sqlDefinition) {
                console.error(
                  `${metric.queryType} metric ${metric.id} missing sqlDefinition`
                );
                return { metricId: metric.id, usage: 0 };
              }

              const result = await questDbService.queryMetrics({
                merchantId,
                customerId,
                externalCustomerId,
                metricType: metric.queryType as QueryType,
                sqlQuery: metric.sqlDefinition,
                timeframe,
              });

              return {
                metricId: metric.id,
                usage: result.value !== null ? result.value : 0,
              };
            } else {
              console.error(`Unknown metric type: ${metric.queryType}`);
              return { metricId: metric.id, usage: 0 };
            }
          } catch (error) {
            console.error(`Error querying metric ${metric.id}:`, error);
            return { metricId: metric.id, usage: 0 };
          }
        }
      )
    );

    return results;
  } catch (error) {
    console.error("Error in getFeatureUsages:", error);
    return []; // Return empty array on catastrophic failure
  }
}

// Zod schemas for validation
const customerIdParamSchema = z.object({
  customerId: z.string(),
});

const featureSlugParamSchema = z.object({
  customerId: z.string(),
  featureSlug: z.string(),
});

/**
 * Schema for the isExtCustId query parameter
 * When true, the customerId is interpreted as a externalCustomerId (external ID)
 * When false (default), the customerId is interpreted as our internal customer ID
 */
const isExtCustIdQuerySchema = z.object({
  isExtCustId: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((val) => val === "true"),
});

const batchCheckBodySchema = z.object({
  featureSlugs: z
    .array(z.string())
    .min(1, { message: "featureSlugs array cannot be empty" }),
});

// Create the entitlements router
export const entitlementsRouter = new Hono()
  /**
   * Get all entitlements for a customer
   * @param customerId - Customer ID (internal ID or externalCustomerId based on isExtCustId)
   * @param isExtCustId - When true (default), customerId is interpreted as externalCustomerId (external ID)
   */
  .get(
    "/:customerId",
    zValidator("param", customerIdParamSchema),
    zValidator("query", isExtCustIdQuerySchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { customerId } = c.req.valid("param");
      const { isExtCustId } = c.req.valid("query");

      try {
        const entitlements = await getAllFeatureEntitlements(
          merchantId,
          customerId,
          isExtCustId
        );
        return c.json({ entitlements });
      } catch (error) {
        console.error("Error fetching entitlements:", error);
        return c.json({ error: "Failed to fetch entitlements" }, 500);
      }
    }
  )

  /**
   * Check a specific feature entitlement
   * @param customerId - Customer ID (internal ID or externalCustomerId based on isExtCustId)
   * @param featureSlug - Slug of the feature to check
   * @param isExtCustId - When true (default), customerId is interpreted as externalCustomerId (external ID)
   */
  .get(
    "/:customerId/feature/:featureSlug",
    zValidator("param", featureSlugParamSchema),
    zValidator("query", isExtCustIdQuerySchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { customerId, featureSlug } = c.req.valid("param");
      const { isExtCustId } = c.req.valid("query");

      try {
        const entitlement = await getFeatureEntitlement(
          merchantId,
          customerId,
          featureSlug,
          isExtCustId
        );
        return c.json(entitlement);
      } catch (error) {
        console.error("Error checking entitlement:", error);
        return c.json({ error: "Failed to check entitlement" }, 500);
      }
    }
  )

  /**
   * Batch check multiple feature entitlements
   * @param customerId - Customer ID (internal ID or externalCustomerId based on isExtCustId)
   * @param featureSlugs - Array of feature slugs to check
   * @param isExtCustId - When true (default), customerId is interpreted as externalCustomerId (external ID)
   */
  .post(
    "/:customerId/features",
    zValidator("param", customerIdParamSchema),
    zValidator("query", isExtCustIdQuerySchema),
    zValidator("json", batchCheckBodySchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { customerId } = c.req.valid("param");
      const { isExtCustId } = c.req.valid("query");

      try {
        const body = c.req.valid("json");

        const entitlements = await getBatchFeatureEntitlements(
          merchantId,
          customerId,
          body.featureSlugs,
          isExtCustId
        );

        return c.json({ entitlements });
      } catch (error) {
        console.error("Error checking batch entitlements:", error);
        return c.json({ error: "Failed to check entitlements" }, 500);
      }
    }
  );
