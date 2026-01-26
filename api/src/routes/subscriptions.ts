import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { subscriptions, subscriptionsInsertSchema } from "@lumen/common/schema";
import { and, eq, isNull, desc, inArray, or, gte } from "drizzle-orm";
import { prices } from "@lumen/common/schema";
import { customers } from "@lumen/common/schema";
import {
  subscriptionFeatures,
  features as featuresTable,
  subscriptionDetails as subscriptionDetailsTable,
  creditGrants,
  subscriptionsScheduledChanges,
} from "@lumen/common/schema";
import {
  associateFeaturesWithSubscription,
  SubscriptionFeatureEntryInput,
  createSubscriptionCore,
  triggerImmediateBillingIfNeeded,
  getOrCreateDunningConfig,
  resumeSubscriptionAndResetCycle,
} from "../helpers/billing";
import { enforceDunningEndAction } from "../helpers/dunning";
import { FeatureValue } from "../helpers/index";
import {
  createFreeSubscriptionForUser,
  freeSubscriptionSchema,
} from "../helpers/create-free-subscription";
import { mapStableSubIdToId } from "../helpers/utils";
import { ContentfulStatusCode } from "hono/utils/http-status";
import {
  payments as paymentsTable,
  refunds as refundsTable,
  invoices as invoicesTable,
} from "@lumen/common/schema";
import { issuePspRefund } from "../helpers/paymentprovider";
import { createRefundAdjustmentInvoice } from "../helpers/refund-documents";

const subscriptionApiSchema = subscriptionsInsertSchema
  .omit({
    merchantId: true,
    stableSubscriptionId: true,
    id: true,
    versionNumber: true,
  })
  .extend({
    startTimestamp: z.string().datetime().optional(),
    endTimestamp: z.string().datetime().optional(),
    triggerImmediateBilling: z.boolean().optional(),
    dangerouslyAllowMultipleSubscriptions: z.boolean().optional(),
  });

const subscriptionFeatureOverridesSchema = z.object({
  featureIds: z.array(z.string()).optional(),
});

export const deleteSubscription = async (
  merchantId: string,
  stableSubscriptionId: string
) => {
  // Get the subscription
  const subscription = await db.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.stableSubscriptionId, stableSubscriptionId),
      eq(subscriptions.merchantId, merchantId),
      isNull(subscriptions.deletedAt), // subscription is not deleted
      isNull(subscriptions.endTimestamp) // subscription is not ended
    ),
  });

  if (!subscription) {
    return {
      body: { error: "Subscription not found or already ended" },
      status: 404,
    };
  }

  try {
    const currentTimestamp = new Date();

    // End the subscription
    await db
      .update(subscriptions)
      .set({
        endTimestamp: currentTimestamp,
        status: "canceled", // Set proper dunning status
      })
      .where(eq(subscriptions.id, subscription.id));

    // Soft delete all subscription details linked to this subscription
    await db
      .update(subscriptionDetailsTable)
      .set({ deletedAt: currentTimestamp })
      .where(
        and(
          eq(subscriptionDetailsTable.subscriptionId, subscription.id),
          isNull(subscriptionDetailsTable.deletedAt)
        )
      );

    // Soft delete all associated subscription features
    await db
      .update(subscriptionFeatures)
      .set({ deletedAt: currentTimestamp })
      .where(
        and(
          eq(subscriptionFeatures.subscriptionId, subscription.id),
          isNull(subscriptionFeatures.deletedAt)
        )
      );

    // Soft delete all associated subscription details
    await db
      .update(subscriptionDetailsTable)
      .set({ deletedAt: currentTimestamp })
      .where(
        and(
          eq(subscriptionDetailsTable.subscriptionId, subscription.id),
          isNull(subscriptionDetailsTable.deletedAt)
        )
      );

    // Expire existing credit grants linked to the plan
    await db
      .update(creditGrants)
      .set({
        expiryDate: currentTimestamp,
        status: "EXPIRED",
        nextRenewalDate: null,
        updatedAt: currentTimestamp,
      })
      .where(
        and(
          eq(creditGrants.customerId, subscription.customerId),
          eq(creditGrants.planId, subscription.planId),
          eq(creditGrants.scope, "plan"),
          or(
            eq(creditGrants.status, "ACTIVE"),
            gte(creditGrants.expiryDate, currentTimestamp)
          ),
          isNull(creditGrants.deletedAt)
        )
      );

    return {
      body: {
        success: true,
        message:
          "Subscription, associated features, details, and credit grants expired successfully",
      },
      status: 200,
    };
  } catch (error) {
    console.error("Error canceling subscription:", error);
    return {
      body: { error: "Failed to cancel subscription" },
      status: 500,
    };
  }
};

export const subscriptionsRouter = new Hono()
  /**
   * Get all subscriptions for merchant
   * GET /subscriptions
   */
  .get(
    "/",
    zValidator(
      "query",
      z.object({ includeFeatures: z.string().optional() }).optional()
    ), // TODO: using boolean was causing 400 error
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const includeFeatures = c.req.valid("query")?.includeFeatures === "true";

      // Get all active subscriptions for this merchant with features included in a single query if requested
      const allSubscriptions = await db.query.subscriptions.findMany({
        where: and(
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
        with: {
          customer: true,
          plan: true,
          price: true,
          // Conditionally include subscription features based on the query param
          ...(includeFeatures
            ? {
                subscriptionFeatures: {
                  where: isNull(subscriptionFeatures.deletedAt),
                  with: {
                    feature: true,
                  },
                },
              }
            : {}),
        },
      });

      // Map id to stableSubscriptionId and remove stableSubscriptionId
      const subscriptionsWithIds = allSubscriptions.map(mapStableSubIdToId);

      return c.json({ subscriptions: subscriptionsWithIds });
    }
  )

  /**
   * Get subscriptions by customer ID
   * GET /subscriptions/customer/:customerId
   */
  .get(
    "/customer/:customerId",
    zValidator("param", z.object({ customerId: z.string() })),
    zValidator("query", z.object({ includeFeatures: z.string().optional() })), // TODO: using boolean was causing 400 error
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const customerId = c.req.valid("param").customerId;
      const includeFeatures = c.req.valid("query").includeFeatures === "true";

      // Verify customer belongs to merchant
      const customer = await db.query.customers.findFirst({
        where: and(
          eq(customers.id, customerId),
          eq(customers.merchantId, merchantId),
          isNull(customers.deletedAt)
        ),
      });

      if (!customer) {
        return c.json({ error: "Customer not found or access denied" }, 404);
      }

      const customerSubscriptions = await db.query.subscriptions.findMany({
        where: and(
          eq(subscriptions.customerId, customerId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
        with: {
          plan: true,
          price: true,
          // Conditionally include subscription features based on the query param
          ...(includeFeatures
            ? {
                subscriptionFeatures: {
                  where: isNull(subscriptionFeatures.deletedAt),
                  with: {
                    feature: true,
                  },
                },
              }
            : {}),
        },
        orderBy: desc(subscriptions.createdAt),
      });

      // Map id to stableSubscriptionId and remove stableSubscriptionId
      const subscriptionsWithIds =
        customerSubscriptions.map(mapStableSubIdToId);

      return c.json({ subscriptions: subscriptionsWithIds });
    }
  )

  /**
   * Calculate Monthly Recurring Revenue (MRR) for the merchant
   * GET /subscriptions/mrr
   */
  .get("/mrr", async (c) => {
    const merchantId = c.get("merchant")!.id;

    try {
      const activeSubscriptions = await db.query.subscriptions.findMany({
        where: and(
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt),
          isNull(subscriptions.endTimestamp)
        ),
        with: {
          price: true,
        },
      });

      let totalMrrCents = 0;

      for (const subscription of activeSubscriptions) {
        if (!subscription.price || !subscription.price.pricingData) {
          continue;
        }

        const { components } = subscription.price.pricingData;
        console.log("🚀 ~ .get ~ components:", components);

        for (const component of components) {
          // Only process "fixed" type components for MRR calculation
          if (component.type !== "fixed" || !component.amount_cents) {
            continue;
          }

          const recurrenceRule = component.recurrence_rule;

          // Parse the RRULE to determine billing frequency
          if (recurrenceRule.includes("FREQ=MONTHLY")) {
            // Monthly billing - add directly to MRR
            totalMrrCents += component.amount_cents;
          } else if (recurrenceRule.includes("FREQ=YEARLY")) {
            // Yearly billing - divide by 12 to get monthly equivalent
            totalMrrCents += Math.round(component.amount_cents / 12);
          }
          // TODO: Other frequencies (weekly, quarterly, etc.) are not included in MRR calculation
        }
      }

      // TODO: handle other currencies, now it assumes EUR/USD/GBP
      const totalMrr = totalMrrCents / 100;

      return c.json({
        mrr: {
          amount_cents: totalMrrCents,
          amount: totalMrr,
          active_subscriptions_count: activeSubscriptions.length,
          calculated_at: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error("Error calculating MRR:", error);
      return c.json({ error: "Failed to calculate MRR" }, 500);
    }
  })

  /**
   * Get subscription details for a specific subscription (for billing calculations)
   * GET /subscriptions/:id/details
   */
  .get(
    "/:id/details",
    zValidator("param", z.object({ id: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableId = c.req.valid("param").id;

      // Get the subscription first
      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt),
          isNull(subscriptions.endTimestamp)
        ),
      });

      if (!subscription) {
        return c.json(
          { error: "Subscription not found or already ended" },
          404
        );
      }

      // Get subscription details with related data
      const subDetails = await db.query.subscriptionDetails.findMany({
        where: and(
          eq(subscriptionDetailsTable.subscriptionId, subscription.id),
          isNull(subscriptionDetailsTable.deletedAt)
        ),
        with: {
          subscription: {
            with: {
              price: true,
            },
          },
        },
      });

      // Transform the data to include component information
      const detailsWithComponents = subDetails.map((detail) => {
        const component = detail.subscription.price.pricingData.components.find(
          (c: any) => c.component_id === detail.componentId
        );

        return {
          id: detail.id,
          componentId: detail.componentId,
          nextBillingDate: detail.nextBillingDate.toISOString(),
          subscriptionStartDate: detail.subscriptionStartDate.toISOString(),
          previousBillingDate:
            detail.previousBillingDate?.toISOString() || null,
          cyclesBilled: detail.cyclesBilled,
          recurrenceRule: detail.recurrenceRule,
          component: component || null,
        };
      });

      return c.json({ subscriptionDetails: detailsWithComponents });
    }
  )

  /**
   * Get scheduled changes for a specific subscription
   * GET /subscriptions/:id/scheduled-changes
   */
  .get(
    "/:id/scheduled-changes",
    zValidator("param", z.object({ id: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableId = c.req.valid("param").id;

      // First get the subscription to verify access
      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
      });

      if (!subscription) {
        return c.json(
          { error: "Subscription not found or access denied" },
          404
        );
      }

      // Get scheduled changes for this subscription
      const scheduledChanges =
        await db.query.subscriptionsScheduledChanges.findMany({
          where: and(
            eq(subscriptionsScheduledChanges.subscriptionId, subscription.id),
            isNull(subscriptionsScheduledChanges.processedAt)
          ),
          with: {
            newPlan: true,
            newPrice: true,
          },
          orderBy: subscriptionsScheduledChanges.effectiveDate,
        });

      return c.json({ scheduledChanges });
    }
  )

  /**
   * Get a specific subscription by stableSubscriptionId
   * GET /subscriptions/:id
   */
  .get(
    "/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator(
      "query",
      z.object({ includeFeatures: z.string().optional() }).optional()
    ), // TODO: using boolean was causing 400 error
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableId = c.req.valid("param").id; // user facing id is stableSubscriptionId
      const includeFeatures = c.req.valid("query")?.includeFeatures === "true";

      // Get the subscription with relations, including features in a single query if requested
      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
        with: {
          customer: true,
          plan: true,
          price: true,
          // Conditionally include subscription features based on the query param
          ...(includeFeatures
            ? {
                subscriptionFeatures: {
                  where: isNull(subscriptionFeatures.deletedAt),
                  with: {
                    feature: true,
                  },
                },
              }
            : {}),
        },
      });

      if (!subscription) {
        return c.json(
          { error: "Subscription not found or access denied" },
          404
        );
      }

      // Map id to stableSubscriptionId and remove stableSubscriptionId
      const subscriptionWithIds = mapStableSubIdToId(subscription);

      return c.json({ subscription: subscriptionWithIds });
    }
  )

  /**
   * Get comprehensive trial information for a subscription
   * GET /subscriptions/:id/trial-info
   */
  .get(
    "/:id/trial-info",
    zValidator("param", z.object({ id: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableId = c.req.valid("param").id;

      // Get the subscription with plan details
      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
        with: {
          plan: true,
          price: true,
        },
      });

      if (!subscription) {
        return c.json(
          { error: "Subscription not found or access denied" },
          404
        );
      }

      // Check if this is a trial subscription
      const isTrialSubscription = subscription.plan.isTrialPlan === true;

      if (!isTrialSubscription) {
        return c.json({
          isOnTrial: false,
          message: "Subscription is not on a trial plan",
        });
      }

      // Get scheduled changes for trial transition
      const scheduledChanges =
        await db.query.subscriptionsScheduledChanges.findMany({
          where: and(
            eq(subscriptionsScheduledChanges.subscriptionId, subscription.id),
            isNull(subscriptionsScheduledChanges.processedAt)
          ),
          with: {
            newPlan: true,
            newPrice: true,
          },
          orderBy: subscriptionsScheduledChanges.effectiveDate,
        });

      const trialEndChange = scheduledChanges.find(
        (change) => change.newPlan && !change.newPlan.isTrialPlan
      );

      let trialInfo = {
        isOnTrial: true,
        trialStartDate: subscription.startTimestamp,
        trialDays: subscription.plan.trialDays,
        trialEndDate: null as string | null,
        daysRemaining: null as number | null,
        nextBillingDate: null as string | null,
        upcomingPlan: null as any,
        upcomingPrice: null as any,
      };

      if (trialEndChange && trialEndChange.effectiveDate) {
        const trialEndDate = new Date(trialEndChange.effectiveDate);
        const now = new Date();
        const daysRemaining = Math.ceil(
          (trialEndDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );

        trialInfo.trialEndDate = trialEndChange.effectiveDate.toISOString();
        trialInfo.daysRemaining = Math.max(0, daysRemaining);
        trialInfo.nextBillingDate = trialEndChange.effectiveDate.toISOString(); // First billing happens when trial ends
        trialInfo.upcomingPlan = trialEndChange.newPlan;
        trialInfo.upcomingPrice = trialEndChange.newPrice;
      }

      return c.json({ trialInfo });
    }
  )

  /**
   * Create a new subscription (without overrides)
   * POST /subscriptions
   */
  .post("/", zValidator("json", subscriptionApiSchema), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const data = c.req.valid("json");

    console.log("data", data);
    try {
      const { subscription: newSubscription, wasExistingSubscription } =
        await createSubscriptionCore({
          merchantId,
          customerId: data.customerId,
          planId: data.planId,
          effectivePriceId: data.effectivePriceId,
          startTimestamp: data.startTimestamp
            ? new Date(data.startTimestamp)
            : new Date(),
          dangerouslyAllowMultipleSubscriptions:
            data.dangerouslyAllowMultipleSubscriptions ?? false,
        });

      // If an existing active subscription was found, return an error
      if (wasExistingSubscription) {
        return c.json<{
          error: string;
          existingSubscriptionId: string;
        }>(
          {
            error: "Customer already has an active subscription.",
            existingSubscriptionId: newSubscription.stableSubscriptionId,
          },
          409
        );
      }

      // Check if we need to trigger immediate billing for bill_immediately components
      await triggerImmediateBillingIfNeeded({
        subscriptionId: newSubscription.id,
        merchantId,
        effectivePriceId: data.effectivePriceId,
        triggerImmediateBilling: data.triggerImmediateBilling ?? false,
      });

      const subWithFeatures = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, newSubscription.id),
        with: {
          subscriptionFeatures: {
            where: isNull(subscriptionFeatures.deletedAt),
          },
        },
      });

      return c.json({ subscription: subWithFeatures }, 201);
    } catch (error) {
      console.error("Error creating subscription:", error);
      if (error instanceof Error) {
        // Provide more specific error messages from the helper
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: "Failed to create subscription" }, 500);
    }
  })

  /**
   * Add feature overrides to an existing subscription (creates a new version)
   * Expects ALL featureIds to be provided
   * id provided is the stableSubscriptionId
   * POST /subscriptions/feature-overrides/:id
   */
  .post(
    "/feature-overrides/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("json", subscriptionFeatureOverridesSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableSubscriptionId = c.req.valid("param").id;
      const { featureIds } = c.req.valid("json");

      if (!featureIds || featureIds.length === 0) {
        return c.json({ error: "No featureIds provided" }, 400);
      }

      // Get the existing subscription
      const existingSubscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableSubscriptionId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
      });

      if (!existingSubscription) {
        return c.json({ error: "Subscription not found" }, 404);
      }

      try {
        // 1. Soft Delete the current subscription object
        await db
          .update(subscriptions)
          .set({ deletedAt: new Date() })
          .where(eq(subscriptions.id, existingSubscription.id));

        // 2. Create a new version of the subscription
        const [newSubscription] = await db
          .insert(subscriptions)
          .values({
            merchantId,
            customerId: existingSubscription.customerId,
            planId: existingSubscription.planId,
            stableSubscriptionId: existingSubscription.stableSubscriptionId,
            versionNumber: existingSubscription.versionNumber + 1,
            effectivePriceId: existingSubscription.effectivePriceId,
            startTimestamp: new Date(),
          })
          .returning();

        // 3. Process simple featureIds - just add the features as-is
        const featuresFromDb = await db.query.features.findMany({
          where: and(
            eq(featuresTable.merchantId, merchantId),
            isNull(featuresTable.deletedAt),
            inArray(featuresTable.id, featureIds)
          ),
        });

        if (featuresFromDb.length === 0) {
          return c.json(
            { error: "No features found for provided featureIds" },
            404
          );
        }

        // Prepare features for association with the new input type
        const featuresToAssociate: SubscriptionFeatureEntryInput[] =
          featuresFromDb.map((feature) => ({
            id: feature.id,
            slug: feature.slug,
            featureValue: feature.featureValue as FeatureValue,
            source: "override",
          }));

        // 4. Associate features with the subscription as overrides
        await associateFeaturesWithSubscription(
          newSubscription.id,
          newSubscription.customerId,
          merchantId,
          featuresToAssociate
        );

        // 5. Get the complete new subscription with features in a single query
        const updatedSubscription = await db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.id, newSubscription.id),
            eq(subscriptions.merchantId, merchantId),
            isNull(subscriptions.deletedAt)
          ),
          with: {
            customer: true,
            plan: true,
            price: true,
            subscriptionFeatures: {
              where: isNull(subscriptionFeatures.deletedAt),
              with: {
                feature: true,
              },
            },
          },
        });

        // 6. Map id to stableSubscriptionId and remove stableSubscriptionId
        const subscriptionWithIds = mapStableSubIdToId(updatedSubscription!);

        return c.json({ subscription: subscriptionWithIds });
      } catch (error) {
        console.error("Error applying feature overrides:", error);
        return c.json({ error: "Failed to apply feature overrides" }, 500);
      }
    }
  )

  /**
   * Add a price override to an existing subscription (creates a new version)
   * POST /subscriptions/price-override/:id
   * id provided is the stableSubscriptionId
   */
  .post(
    "/price-override/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("json", z.object({ priceId: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableSubscriptionId = c.req.valid("param").id;
      const { priceId } = c.req.valid("json");

      // Get the existing subscription
      const existingSubscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableSubscriptionId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
        with: {
          subscriptionFeatures: {
            where: isNull(subscriptionFeatures.deletedAt),
            with: {
              feature: true,
            },
          },
        },
      });

      if (!existingSubscription) {
        return c.json({ error: "Subscription not found" }, 404);
      }

      // Verify price exists and belongs to the merchant
      const price = await db.query.prices.findFirst({
        where: and(
          eq(prices.id, priceId),
          eq(prices.merchantId, merchantId),
          isNull(prices.deletedAt)
        ),
      });

      if (!price) {
        return c.json({ error: "Price not found" }, 404);
      }

      try {
        // 1. End the current subscription
        await db
          .update(subscriptions)
          .set({ deletedAt: new Date() })
          .where(eq(subscriptions.id, existingSubscription.id));

        // Soft delete associated subscription details so they are not picked up for billing
        await db
          .update(subscriptionDetailsTable)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(
                subscriptionDetailsTable.subscriptionId,
                existingSubscription.id
              ),
              isNull(subscriptionDetailsTable.deletedAt)
            )
          );

        // 2. Create a new version of the subscription with the new price
        const [newSubscription] = await db
          .insert(subscriptions)
          .values({
            merchantId,
            customerId: existingSubscription.customerId,
            planId: existingSubscription.planId,
            stableSubscriptionId: existingSubscription.stableSubscriptionId,
            versionNumber: existingSubscription.versionNumber + 1,
            effectivePriceId: priceId,
            startTimestamp: new Date(),
          })
          .returning();

        // 3. Copy all features from the existing subscription to the new one
        if (existingSubscription.subscriptionFeatures.length > 0) {
          const featuresToAssociate: SubscriptionFeatureEntryInput[] =
            existingSubscription.subscriptionFeatures
              .filter((entry) => entry.feature) // Ensure feature exists
              .map((entry) => ({
                id: entry.feature!.id,
                slug: entry.feature!.slug,
                featureValue: (entry.featureValue ??
                  entry.feature!.featureValue) as FeatureValue,
                source: entry.source as "plan" | "override",
              }));

          if (featuresToAssociate.length > 0) {
            await associateFeaturesWithSubscription(
              newSubscription.id,
              newSubscription.customerId,
              merchantId,
              featuresToAssociate
            );
          }
        }

        // Get the complete new subscription with features in a single query
        const updatedSubscription = await db.query.subscriptions.findFirst({
          where: eq(subscriptions.id, newSubscription.id),
          with: {
            customer: true,
            plan: true,
            price: true,
            subscriptionFeatures: {
              where: isNull(subscriptionFeatures.deletedAt),
              with: {
                feature: true,
              },
            },
          },
        });

        // 4. Map id to stableSubscriptionId and remove stableSubscriptionId
        const subscriptionWithIds = mapStableSubIdToId(updatedSubscription!);

        return c.json({ subscription: subscriptionWithIds });
      } catch (error) {
        console.error("Error applying price override:", error);
        return c.json({ error: "Failed to apply price override" }, 500);
      }
    }
  )

  /**
   * Cancel a subscription
   * DELETE /subscriptions/:id
   * id provided is the stableSubscriptionId
   */
  .delete(
    "/:id",
    zValidator("param", z.object({ id: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableSubscriptionId = c.req.valid("param").id;
      const { body, status } = await deleteSubscription(
        merchantId,
        stableSubscriptionId
      );
      return c.json(body, status as ContentfulStatusCode);
    }
  )

  /**
   * Issue a refund for the latest payment of a subscription or by paymentId
   * POST /subscriptions/:id/refunds
   * Body: { paymentId?: string, amountCents?: number, reason?: string }
   */
  .post(
    "/:id/refunds",
    zValidator("param", z.object({ id: z.string() })),
    zValidator(
      "json",
      z.object({
        paymentId: z.string().optional(),
        amountCents: z.number().int().positive().optional(),
        reason: z.string().optional(),
        terminateSubscription: z.boolean().optional(),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableSubscriptionId = c.req.valid("param").id;
      const { paymentId, amountCents, reason, terminateSubscription } =
        c.req.valid("json");

      // Resolve subscription to ensure access and get customer context
      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableSubscriptionId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
      });

      if (!subscription) {
        const errorMessage = "Subscription not found or access denied";
        console.error(errorMessage);
        return c.json({ error: errorMessage }, 404);
      }

      let payment: typeof paymentsTable.$inferSelect | undefined;

      if (paymentId) {
        payment = await db.query.payments.findFirst({
          where: and(
            eq(paymentsTable.id, paymentId),
            eq(paymentsTable.merchantId, merchantId)
          ),
        });
      }

      if (!payment) {
        const errorMessage = "Payment not found for refund";
        console.error(errorMessage);
        return c.json({ error: errorMessage }, 404);
      }

      try {
        const refundResult = await issuePspRefund({
          merchantId,
          payment,
          amountCents,
        });

        // Persist refund record and update payment aggregation
        let createdAdjustmentInvoiceId: string | undefined = undefined;
        await db.transaction(async (tx) => {
          // Generate adjustment document (cancellation for full first refund; credit note otherwise)
          let adjustmentInvoiceId: string | undefined = undefined;

          const originalInvoice = payment!.invoiceId
            ? await tx.query.invoices.findFirst({
                where: eq(invoicesTable.id, payment!.invoiceId),
                with: {
                  lineItems: true,
                  customer: true,
                  merchant: true,
                },
              })
            : null;

          if (originalInvoice) {
            const prevRefunded = payment!.refundedAmountCents || 0;
            const refundableRemaining =
              (payment!.amountCents || 0) - prevRefunded;
            const isFirstRefund = prevRefunded === 0;
            const isFullThisRefund =
              refundResult.amountCents >= refundableRemaining && isFirstRefund;

            const created = await createRefundAdjustmentInvoice({
              tx,
              merchantId,
              originalInvoiceId: originalInvoice.id,
              documentType: isFullThisRefund ? "cancellation" : "credit_note",
              amountCents: isFullThisRefund
                ? undefined
                : refundResult.amountCents,
              reason: reason || null,
            });
            adjustmentInvoiceId = created?.id;
            createdAdjustmentInvoiceId = created?.id;
          }

          await tx.insert(refundsTable).values({
            merchantId,
            paymentId: payment!.id,
            externalRefundId: refundResult.id,
            amountCents: refundResult.amountCents,
            currency: payment!.currency,
            status: refundResult.status,
            reason: reason || null,
            adjustmentInvoiceId: adjustmentInvoiceId || null,
          });

          const newRefunded =
            (payment!.refundedAmountCents || 0) + refundResult.amountCents;
          const refundStatus =
            newRefunded >= payment!.amountCents ? "full" : "partial";
          await tx
            .update(paymentsTable)
            .set({
              refundedAmountCents: newRefunded,
              refundStatus,
            })
            .where(eq(paymentsTable.id, payment!.id));

          if (terminateSubscription) {
            const { body, status } = await deleteSubscription(
              merchantId,
              stableSubscriptionId
            );
            if (status !== 200) {
              c.json(body, status as ContentfulStatusCode);
            }
          }
        });

        return c.json({
          success: true,
          refund: {
            id: refundResult.id,
            status: refundResult.status,
            amountCents: refundResult.amountCents,
          },
          terminated: !!terminateSubscription,
          adjustmentInvoiceId: createdAdjustmentInvoiceId || null,
        });
      } catch (error) {
        const errorMessage: string =
          error instanceof Error ? error.message : "Failed to issue refund";
        console.error(errorMessage);
        return c.json(
          {
            success: false,
            error: errorMessage,
          },
          400
        );
      }
    }
  )

  /**
   * Create a free subscription for a customer
   * This endpoint finds the latest plan with a free price and creates a subscription for it
   * POST /subscriptions/create-free-subscription
   */
  .post(
    "/create-free-subscription",
    zValidator("json", freeSubscriptionSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const data = c.req.valid("json");

      const [response, status] = await createFreeSubscriptionForUser({
        ...data,
        merchantId,
      });

      return c.json(response, status);
    }
  )
  // Pause a subscription (manual control)
  .post(
    "/:id/pause",
    zValidator("param", z.object({ id: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableId = c.req.valid("param").id;

      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
      });

      if (!subscription) {
        return c.json(
          { error: "Subscription not found or access denied" },
          404
        );
      }

      await db
        .update(subscriptions)
        .set({ status: "paused", gracePeriodEndsAt: null })
        .where(eq(subscriptions.id, subscription.id));

      return c.json({ success: true, status: "paused" });
    }
  )
  // Resume a subscription (from paused)
  .post(
    "/:id/resume",
    zValidator("param", z.object({ id: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableId = c.req.valid("param").id;

      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
      });

      if (!subscription) {
        return c.json(
          { error: "Subscription not found or access denied" },
          404
        );
      }

      // Reset billing cycle and credits on resume
      await resumeSubscriptionAndResetCycle({
        subscriptionId: subscription.id,
        resumedAt: new Date(),
      });

      return c.json({ success: true, status: "active" });
    }
  )
  // Reactivate a subscription from unpaid (resume billing)
  .post(
    "/:id/reactivate",
    zValidator("param", z.object({ id: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableId = c.req.valid("param").id;

      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
      });

      if (!subscription) {
        return c.json(
          { error: "Subscription not found or access denied" },
          404
        );
      }

      if (subscription.status !== "unpaid") {
        return c.json(
          { error: "Reactivate is allowed only for unpaid subscriptions" },
          400
        );
      }

      await db
        .update(subscriptions)
        .set({ status: "active", gracePeriodEndsAt: null, endTimestamp: null })
        .where(eq(subscriptions.id, subscription.id));

      return c.json({ success: true, status: "active" });
    }
  )
  // Enforce dunning action immediately for a subscription
  .post(
    "/:id/enforce-dunning-now",
    zValidator("param", z.object({ id: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const stableId = c.req.valid("param").id;

      const subscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.stableSubscriptionId, stableId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt)
        ),
      });

      if (!subscription) {
        return c.json(
          { error: "Subscription not found or access denied" },
          404
        );
      }

      const dunningConfig = await getOrCreateDunningConfig(
        merchantId,
        subscription.planId
      );

      await db.transaction(async (tx) => {
        await enforceDunningEndAction({
          tx,
          subscriptionId: subscription.id,
          action: (dunningConfig.endOfDunningAction === "pause_subscription"
            ? "pause_subscription"
            : dunningConfig.endOfDunningAction === "cancel_subscription"
              ? "cancel_subscription"
              : "mark_as_unpaid") as any,
          currentTimestamp: new Date(),
        });
      });

      return c.json({ success: true });
    }
  );
