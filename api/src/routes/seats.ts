import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { env } from "../env";
import { db } from "../db/client";
import {
  customers,
  subscriptions,
  metrics,
  subscriptionDetails,
  prices,
  invoiceLineItems,
  invoices,
  customerOrganizations,
  creditDefinitions,
  creditGrants,
  subscriptionFeatures,
} from "@lumen/common/schema";
import { eq, and, isNull, desc, gte, lte, or, asc } from "drizzle-orm";
import { logger } from "../helpers/logging";
import { eventProcessingService } from "./events";
import questDbService from "../db/questDbService";
import { nanoid } from "nanoid";
import {
  calculateUsageForComponent,
  associateFeaturesWithSubscription,
} from "../helpers/billing";
import { getPlanFeatures } from "../helpers/index";
import { createCreditGrant, createCreditTransaction } from "../helpers/credits";
import {
  PriceComponentSchemaType,
  PerUnitPriceComponentSchemaType,
} from "@lumen/common/validators";
import { prorateAmountCents } from "../helpers/proration";
import { getSecretOrEnvVar } from "../helpers/secrets";
import { createOrMergeIntoInvoice } from "../helpers/billing";
import { chargeInvoice } from "../helpers/paymentprovider";

// Verify if a user exists and is currently active (has seat_added without subsequent seat_removed)
async function verifyUserExistsInSeats(
  merchantId: string,
  customerId: string,
  userIdToRemove: string
): Promise<boolean> {
  try {
    const result = await questDbService.queryMetrics({
      merchantId,
      metricType: "complex",
      timeframe: { type: "ALL" },
      rawSql: `
        WITH user_events AS (
          SELECT
            event_name,
            event_timestamp,
            row_number() OVER (ORDER BY event_timestamp DESC) as rn
          FROM events
          WHERE merchant_id = $1
            AND customer_id = $2
            AND event_name IN ('seat_added', 'seat_removed')
            AND event_string = $3
        )
        SELECT event_name as latest_event
        FROM user_events
        WHERE rn = 1
      `,
      rawValues: [merchantId, customerId, userIdToRemove],
    });

    if (result.error) {
      console.error(
        `Failed to verify user existence in QuestDB: ${result.error}`
      );
      return false;
    }

    // User exists and is active if their latest event is 'seat_added'
    const latestEvent = result.rows?.[0]?.latest_event;
    return latestEvent === "seat_added";
  } catch (error) {
    console.error(`Error verifying user existence in QuestDB:`, error);
    return false;
  }
}

// Validation schemas for seat management
const addSeatSchema = z
  .object({
    user_id: z.string().min(1, "External user ID is required").optional(), // External user ID of the main org (fallback)
    organization_id: z.string().optional(), // Preferred organization identifier
    created_user_id: z
      .string()
      .min(1, "External user ID of the new seat being added is required"), // External user ID which is being added to the seat
    created_user_info: z
      .object({
        name: z.string().optional(),
        email: z.string().email().optional(),
      })
      .optional(), // Optional info about the user being added
    metadata: z.record(z.any()).optional(),
    idempotency_key: z.string().optional(),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .refine((val) => val.endsWith("Z"), {
        message: "Timestamp must be in UTC format and end with 'Z'",
      })
      .optional(),
  })
  .refine((data) => data.organization_id || data.user_id, {
    message: "Either organization_id or user_id must be provided",
  });

const removeSeatSchema = z
  .object({
    user_id: z.string().min(1, "External user ID is required").optional(), // External user ID (fallback)
    organization_id: z.string().optional(), // Preferred organization identifier
    removed_user_id: z
      .string()
      .min(1, "External user ID of the seat being removed is required"), // External user ID being removed from the seat
    metadata: z.record(z.any()).optional(),
    idempotency_key: z.string().optional(),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .refine((val) => val.endsWith("Z"), {
        message: "Timestamp must be in UTC format and end with 'Z'",
      })
      .optional(),
  })
  .refine((data) => data.organization_id || data.user_id, {
    message: "Either organization_id or user_id must be provided",
  });

// Helper function to resolve billing customer from organization_id or user_id
async function resolveBillingCustomer(
  merchantId: string,
  organizationId?: string,
  userId?: string
): Promise<{ externalCustomerId: string; customerId: string } | null> {
  if (organizationId) {
    // Look up organization by external ID and get its billing customer
    const organization = await db.query.customerOrganizations.findFirst({
      where: and(
        eq(customerOrganizations.externalOrgId, organizationId),
        eq(customerOrganizations.merchantId, merchantId),
        isNull(customerOrganizations.deletedAt)
      ),
    });

    if (!organization || !organization.billingCustomerId) {
      return null;
    }

    const billingCustomer = await db.query.customers.findFirst({
      where: and(
        eq(customers.id, organization.billingCustomerId),
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt)
      ),
    });

    if (!billingCustomer || !billingCustomer.externalCustomerId) {
      return null;
    }

    return {
      externalCustomerId: billingCustomer.externalCustomerId,
      customerId: billingCustomer.id,
    };
  } else if (userId) {
    // Fallback to user_id lookup
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.externalCustomerId, userId),
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt)
      ),
    });

    if (!customer || !customer.externalCustomerId) {
      return null;
    }

    return {
      externalCustomerId: customer.externalCustomerId,
      customerId: customer.id,
    };
  }

  return null;
}

export const seatsRoute = new Hono()
  // Add a seat for a customer/subscription
  .post("/add", zValidator("json", addSeatSchema), async (c) => {
    console.info("[POST /seats/add] Request received");
    const merchantId = c.get("merchant")!.id;
    const seatData = c.req.valid("json");
    console.debug("[POST /seats/add] seatData:", seatData);
    const {
      user_id,
      organization_id,
      created_user_id,
      created_user_info,
      metadata,
      timestamp,
    } = seatData;

    // Resolve billing customer from organization_id (preferred) or user_id (fallback)
    const billingCustomer = await resolveBillingCustomer(
      merchantId,
      organization_id,
      user_id
    );
    if (!billingCustomer) {
      return c.json(
        {
          error: organization_id
            ? `Organization not found: ${organization_id}`
            : `Customer not found: ${user_id}`,
        },
        404
      );
    }

    const subsResult = await db
      .select({
        subscriptionId: subscriptions.id,
        customerId: subscriptions.customerId,
      })
      .from(subscriptions)
      .innerJoin(customers, eq(subscriptions.customerId, customers.id))
      .where(
        and(
          eq(customers.externalCustomerId, billingCustomer.externalCustomerId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt),
          isNull(subscriptions.endTimestamp),
          isNull(customers.deletedAt)
        )
      )
      .limit(1);

    console.debug("[POST /seats/add] subsResult:", subsResult);

    if (subsResult.length === 0) {
      console.warn(
        "[POST /seats/add] Subscription not found or access denied",
        {
          user_id,
          organization_id,
          billingCustomerExtId: billingCustomer.externalCustomerId,
          merchantId,
        }
      );
      return c.json({ error: "Subscription not found or access denied" }, 404);
    }

    const { subscriptionId, customerId } = subsResult[0];

    // Generate idempotency key if not provided
    const idempotencyKey =
      seatData.idempotency_key ||
      `seat_add_${subscriptionId}_${customerId}_${nanoid()}`;

    try {
      // Use the new event processing service
      const eventData = {
        eventName: "seat_added",
        customerId: customerId,
        extCustomerId: billingCustomer.externalCustomerId,
        eventString: created_user_id, // The external user ID being added
        properties: {
          subscription_id: subscriptionId,
          ...metadata,
        },
        idempotencyKey,
        eventTimestamp: seatData.timestamp
          ? new Date(seatData.timestamp)
          : undefined,
      };

      console.debug("[POST /seats/add] eventData:", eventData);

      const result = await eventProcessingService.processEvent(
        eventData,
        merchantId
      );

      console.debug("[POST /seats/add] eventProcessingService result:", result);

      if (result.success) {
        console.info(
          `Seat addition accepted and processed: merchant=${merchantId}, subscription=${subscriptionId}, user=${created_user_id}`
        );

        // ---------------- Create/ensure seat customer + entitlements + seat credits ----------------
        try {
          // Load subscription with plan/price/customer context
          const subscriptionFull = await db.query.subscriptions.findFirst({
            where: eq(subscriptions.id, subscriptionId),
            with: { plan: true, price: true, customer: true },
          });

          if (
            subscriptionFull?.customer &&
            subscriptionFull.plan &&
            subscriptionFull.price
          ) {
            const primary = subscriptionFull.customer;

            // Ensure org exists for primary customer
            let orgId = primary.customerOrganizationId || null;
            if (!orgId) {
              const [createdOrg] = await db
                .insert(customerOrganizations)
                .values({
                  merchantId,
                  billingCustomerId: primary.id, // Set the primary customer as the billing customer
                })
                .returning();
              orgId = createdOrg.id;
              await db
                .update(customers)
                .set({ customerOrganizationId: orgId, orgRole: "primary" })
                .where(eq(customers.id, primary.id));
            }

            // Upsert seat customer by externalCustomerId
            let seatCustomer = await db.query.customers.findFirst({
              where: and(
                eq(customers.merchantId, merchantId),
                eq(customers.externalCustomerId, created_user_id),
                isNull(customers.deletedAt)
              ),
            });

            if (!seatCustomer) {
              const [createdSeat] = await db
                .insert(customers)
                .values({
                  merchantId,
                  externalCustomerId: created_user_id,
                  name: created_user_info?.name || null,
                  email: created_user_info?.email || null,
                  customerOrganizationId: orgId!,
                  orgRole: "member",
                  timezone: primary.timezone || "UTC",
                  preferredLanguage: primary.preferredLanguage || "en",
                  preferredCurrency:
                    primary.preferredCurrency ||
                    subscriptionFull.price.currency,
                })
                .returning();
              seatCustomer = createdSeat;
            } else if (!seatCustomer.customerOrganizationId) {
              // Update existing customer with org info and optionally update name/email if provided
              const updateData: any = {
                customerOrganizationId: orgId!,
                orgRole: "member",
              };
              if (created_user_info?.name)
                updateData.name = created_user_info.name;
              if (created_user_info?.email)
                updateData.email = created_user_info.email;

              await db
                .update(customers)
                .set(updateData)
                .where(eq(customers.id, seatCustomer.id));
            }

            // Copy plan features to seat customer entitlements (pointing to primary subscription)
            const planFeaturesList = await getPlanFeatures(
              subscriptionFull.plan.id,
              db
            );
            if (planFeaturesList.length > 0) {
              const featuresToAssociate = planFeaturesList.map((pf) => ({
                id: pf.id,
                slug: pf.slug,
                featureValue: pf.featureValue as any,
                source: "plan" as const,
              }));
              await associateFeaturesWithSubscription(
                subscriptionId,
                seatCustomer.id,
                merchantId,
                featuresToAssociate
              );
            }

            // Create seat credit grants from plan-scoped definitions (like initial subscription grants)
            const price = subscriptionFull.price;
            const allComponents = price.pricingData?.components || [];
            const componentIdSet = new Set(
              allComponents.map((c: any) => c.component_id)
            );

            const definitions = await db.query.creditDefinitions.findMany({
              where: and(
                eq(creditDefinitions.merchantId, merchantId),
                eq(creditDefinitions.scope, "plan"),
                eq(creditDefinitions.planId, subscriptionFull.plan.id),
                eq(creditDefinitions.isActive, true),
                isNull(creditDefinitions.deletedAt),
                or(
                  isNull(creditDefinitions.priceId),
                  eq(creditDefinitions.priceId, price.id)
                )
              ),
              orderBy: [
                asc(creditDefinitions.priority),
                asc(creditDefinitions.createdAt),
              ],
            });

            for (const def of definitions) {
              // If definition targets a specific component, ensure it exists in current price
              if (
                def.priceComponentId &&
                !componentIdSet.has(def.priceComponentId)
              ) {
                continue;
              }

              try {
                await createCreditGrant({
                  merchantId,
                  customerId: seatCustomer.id,
                  creditDefinitionId: def.id,
                  source: "subscription",
                  notes: `Seat grant for ${created_user_id} under subscription ${subscriptionId}`,
                });
              } catch (e) {
                console.error("Failed creating seat credit grant", e);
              }
            }
          }
        } catch (seatSetupErr) {
          console.error(
            "Seat setup (customer/entitlements/credits) failed",
            seatSetupErr
          );
        }

        // ---------------- Overage billing for pre-pay seat plans ----------------
        try {
          // 1. Find the active per-unit component with bill_immediately=true
          const price = await db.query.prices.findFirst({
            where: and(
              eq(prices.planId, subscriptions.planId),
              eq(prices.merchantId, merchantId),
              isNull(prices.deletedAt)
            ),
            orderBy: desc(prices.createdAt),
          });

          console.debug("[POST /seats/add] price:", price);

          if (price) {
            const seatComponent = price.pricingData.components.find(
              (c: any) => c.type === "per_unit" && c.bill_immediately !== false
            ) as any;

            console.debug("[POST /seats/add] seatComponent:", seatComponent);

            if (
              seatComponent &&
              seatComponent.num_seats &&
              seatComponent.num_seats > 0
            ) {
              // Get subscription detail row for this component
              const subDetail = await db.query.subscriptionDetails.findFirst({
                where: and(
                  eq(subscriptionDetails.subscriptionId, subscriptionId),
                  eq(
                    subscriptionDetails.componentId,
                    seatComponent.component_id
                  ),
                  isNull(subscriptionDetails.deletedAt)
                ),
              });

              console.debug("[POST /seats/add] subDetail:", subDetail);

              if (subDetail) {
                const { previousBillingDate, nextBillingDate } = subDetail;
                const periodStart =
                  previousBillingDate || subDetail.subscriptionStartDate;
                const periodEnd = nextBillingDate;

                // Current usage (unique seats) in period till now
                const metric = await db.query.metrics.findFirst({
                  where: eq(metrics.id, seatComponent.metric_id),
                });

                console.debug("[POST /seats/add] metric:", metric);

                let currentUsage = 0;
                if (metric) {
                  currentUsage = await calculateUsageForComponent(
                    merchantId,
                    customerId,
                    metric,
                    "per_unit",
                    periodStart,
                    periodEnd,
                    subscriptionId
                  );
                }

                console.debug("[POST /seats/add] currentUsage:", currentUsage);

                // Already billed quantity in this period
                const alreadyBilledRes = await db
                  .select({
                    id: invoiceLineItems.id,
                    quantity: invoiceLineItems.quantity,
                    invoiceId: invoiceLineItems.invoiceId,
                  })
                  .from(invoiceLineItems)
                  .innerJoin(
                    invoices,
                    eq(invoiceLineItems.invoiceId, invoices.id)
                  )
                  .where(
                    and(
                      eq(
                        invoiceLineItems.componentId,
                        seatComponent.component_id
                      ),
                      gte(invoiceLineItems.billingPeriodStart, periodStart),
                      lte(invoiceLineItems.billingPeriodStart, periodEnd),
                      eq(invoices.subscriptionId, subscriptionId)
                    )
                  );

                console.debug(
                  "[POST /seats/add] alreadyBilledRes:",
                  alreadyBilledRes
                );

                const alreadyQty = alreadyBilledRes.reduce(
                  (sum, li) => sum + (li.quantity || 0),
                  0
                );

                const remainingQty = Math.max(currentUsage - alreadyQty, 0);

                console.debug("[POST /seats/add] remainingQty:", remainingQty);

                if (remainingQty > 0) {
                  // Prorate
                  const unitProrated = prorateAmountCents(
                    seatComponent.amount_cents,
                    periodStart,
                    periodEnd,
                    timestamp ? new Date(timestamp) : new Date()
                  );

                  console.debug(
                    "[POST /seats/add] unitProrated:",
                    unitProrated
                  );

                  // Create line item for seat overage
                  const lineItem = {
                    type: "per_unit",
                    description: seatComponent.label,
                    quantity: remainingQty,
                    unitAmountCents: unitProrated,
                    subtotalCents: unitProrated * remainingQty,
                    componentId: seatComponent.component_id,
                    priceId: price.id,
                    metricId: seatComponent.metric_id,
                    billingPeriodStart: periodStart,
                    billingPeriodEnd: periodEnd,
                  };

                  const subscription = await db.query.subscriptions.findFirst({
                    where: eq(subscriptions.id, subscriptionId),
                    with: { price: true },
                  });

                  // Determine if this should be billed immediately or added to next cycle
                  const billImmediately =
                    seatComponent.bill_immediately !== false;
                  const invoiceStatus = billImmediately ? "issued" : "draft"; // when "issued", new invoice is created and charged
                  // Use email if available, otherwise use external customer ID
                  const userIdentifier =
                    created_user_info?.email || created_user_id;
                  const description = `Seat overage charge for ${userIdentifier}`;

                  console.info(
                    `[POST /seats/add] Creating ${invoiceStatus} invoice for overage: remainingQty=${remainingQty}, billImmediately=${billImmediately}`
                  );

                  // Create invoice or merge into existing draft
                  const invoiceResult = await createOrMergeIntoInvoice({
                    merchantId,
                    customerId,
                    subscriptionId,
                    lineItems: [lineItem],
                    currency: subscription?.price?.currency || "usd",
                    description,
                    status: invoiceStatus,
                  });

                  if (invoiceResult.success && invoiceResult.invoice) {
                    if (invoiceResult.merged) {
                      console.info(
                        `[POST /seats/add] Seat overage line item merged into existing draft invoice: ${invoiceResult.invoice.id}`
                      );
                    } else {
                      console.info(
                        `[POST /seats/add] ${invoiceStatus} invoice created: ${invoiceResult.invoice.id}`
                      );
                    }

                    // If immediate billing, charge the invoice now
                    if (billImmediately) {
                      try {
                        const chargeResult = await chargeInvoice({
                          invoiceId: invoiceResult.invoice.id,
                        });

                        if (chargeResult.success) {
                          console.info(
                            `[POST /seats/add] Seat overage charged successfully: ${chargeResult.message}`
                          );
                        } else {
                          console.error(
                            `[POST /seats/add] Failed to charge seat overage: ${chargeResult.message}`
                          );
                        }
                      } catch (chargeErr) {
                        console.error(
                          `[POST /seats/add] Error charging invoice:`,
                          chargeErr
                        );
                      }
                    } else {
                      console.info(
                        `[POST /seats/add] Draft invoice created for next billing cycle: ${invoiceResult.invoice.id}`
                      );
                    }
                  } else {
                    console.error(
                      `[POST /seats/add] Failed to create invoice: ${invoiceResult.message}`
                    );
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error("Failed to bill overage seat immediately", err);
        }

        console.info("[POST /seats/add] Seat added successfully");
        return c.json(
          {
            message: "Seat added successfully",
            user_id,
            organization_id,
            created_user_id,
            subscription_id: subscriptionId,
            idempotency_key: idempotencyKey,
          },
          result.statusCode as any
        );
      } else {
        console.warn("[POST /seats/add] Event processing failed", result);
        return c.json({ error: result.message }, result.statusCode as any);
      }
    } catch (error) {
      console.error("Error adding seat:", error);
      return c.json({ error: "Failed to add seat" }, 500);
    }
  })

  // Remove a seat for a customer/subscription
  .post("/remove", zValidator("json", removeSeatSchema), async (c) => {
    console.info("[POST /seats/remove] Request received");
    const merchantId = c.get("merchant")!.id;
    const seatData = c.req.valid("json");
    console.debug("[POST /seats/remove] seatData:", seatData);
    const { user_id, organization_id, removed_user_id, metadata } = seatData;

    // Resolve billing customer from organization_id (preferred) or user_id (fallback)
    const billingCustomer = await resolveBillingCustomer(
      merchantId,
      organization_id,
      user_id
    );
    if (!billingCustomer) {
      return c.json(
        {
          error: organization_id
            ? `Organization not found: ${organization_id}`
            : `Customer not found: ${user_id}`,
        },
        404
      );
    }

    const subsResult = await db
      .select({
        subscriptionId: subscriptions.id,
        customerId: subscriptions.customerId,
      })
      .from(subscriptions)
      .innerJoin(customers, eq(subscriptions.customerId, customers.id))
      .where(
        and(
          eq(customers.externalCustomerId, billingCustomer.externalCustomerId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt),
          isNull(subscriptions.endTimestamp),
          isNull(customers.deletedAt)
        )
      )
      .limit(1);

    console.debug("[POST /seats/remove] subsResult:", subsResult);

    if (subsResult.length === 0) {
      console.warn(
        "[POST /seats/remove] Subscription not found or access denied",
        {
          user_id,
          organization_id,
          billingCustomerExtId: billingCustomer.externalCustomerId,
          merchantId,
        }
      );
      return c.json({ error: "Subscription not found or access denied" }, 404);
    }

    const { subscriptionId, customerId } = subsResult[0];

    try {
      // Verify user exists and is currently active in seat events
      console.info(
        `[POST /seats/remove] Verifying user exists in seats: removed_user_id=${removed_user_id}`
      );
      const userExists = await verifyUserExistsInSeats(
        merchantId,
        customerId,
        removed_user_id
      );

      console.debug(`[POST /seats/remove] userExists:`, userExists);

      if (!userExists) {
        console.warn(
          "[POST /seats/remove] User not found in active seats or already removed",
          { removed_user_id }
        );
        return c.json(
          { error: "User not found in active seats or already removed" },
          400
        );
      }

      // Find the seat customer by external id
      const seatCustomer = await db.query.customers.findFirst({
        where: and(
          eq(customers.merchantId, merchantId),
          eq(customers.externalCustomerId, removed_user_id),
          isNull(customers.deletedAt)
        ),
      });

      if (seatCustomer) {
        // Load subscription context
        const subscription = await db.query.subscriptions.findFirst({
          where: eq(subscriptions.id, subscriptionId),
          with: { price: true },
        });

        // Immediately revoke ACTIVE grants for this seat customer for this plan
        const activeSeatGrants = await db.query.creditGrants.findMany({
          where: and(
            eq(creditGrants.merchantId, merchantId),
            eq(creditGrants.customerId, seatCustomer.id),
            eq(creditGrants.status, "ACTIVE"),
            isNull(creditGrants.deletedAt),
            // if subscription known, scope grants to its plan to avoid cross-plan revokes
            subscription?.planId
              ? eq(creditGrants.planId, subscription.planId)
              : eq(creditGrants.planId, creditGrants.planId)
          ),
        });

        for (const grant of activeSeatGrants) {
          if (grant.remainingAmount > 0) {
            await createCreditTransaction(
              {
                merchantId,
                customerId: seatCustomer.id,
                creditGrantId: grant.id,
                amount: grant.remainingAmount,
                applicationType: grant.applicationType,
                eventName: "revoked",
                eventTimestamp: new Date(),
                featureId: grant.featureId || undefined,
                featureSlug: grant.featureSlug || undefined,
                priceId: grant.priceId || undefined,
                priceComponentId: grant.priceComponentId || undefined,
                currency: grant.currency || undefined,
                notes: "Seat removed - immediate revocation",
              },
              undefined
            );
          }

          await db
            .update(creditGrants)
            .set({
              status: "REVOKED",
              remainingAmount: 0,
              updatedAt: new Date(),
            })
            .where(eq(creditGrants.id, grant.id));
        }

        const now = new Date();
        // Soft-delete entitlements for this seat customer mapped to this subscription
        await db
          .update(subscriptionFeatures)
          .set({ deletedAt: now })
          .where(
            and(
              eq(subscriptionFeatures.subscriptionId, subscriptionId),
              eq(subscriptionFeatures.customerId, seatCustomer.id),
              isNull(subscriptionFeatures.deletedAt)
            )
          );

        // Soft-delete the seat customer
        await db
          .update(customers)
          .set({ deletedAt: now })
          .where(eq(customers.id, seatCustomer.id));
      }

      // Generate idempotency key if not provided
      const idempotencyKey =
        seatData.idempotency_key ||
        `seat_remove_${subscriptionId}_${customerId}_${nanoid()}`;

      // Use the new event processing service
      const eventData = {
        eventName: "seat_removed",
        extCustomerId: billingCustomer.externalCustomerId,
        customerId: customerId,
        eventString: removed_user_id, // The external user ID being removed
        properties: {
          subscription_id: subscriptionId,
          ...metadata,
        },
        idempotencyKey,
        eventTimestamp: seatData.timestamp
          ? new Date(seatData.timestamp)
          : undefined,
      };

      console.debug("[POST /seats/remove] eventData:", eventData);

      const result = await eventProcessingService.processEvent(
        eventData,
        merchantId
      );

      console.debug(
        "[POST /seats/remove] eventProcessingService result:",
        result
      );

      if (result.success) {
        console.info(
          `Seat removal accepted and processed: merchant=${merchantId}, subscription=${subscriptionId}, user=${removed_user_id}`
        );
        console.info("[POST /seats/remove] Seat removed successfully");
        return c.json(
          {
            message: "Seat removed successfully",
            user_id,
            organization_id,
            removed_user_id,
            subscription_id: subscriptionId,
            idempotency_key: idempotencyKey,
          },
          result.statusCode as any
        );
      } else {
        console.warn("[POST /seats/remove] Event processing failed", result);
        return c.json({ error: result.message }, result.statusCode as any);
      }
    } catch (error) {
      console.error("Error removing seat:", error);
      return c.json({ error: "Failed to remove seat" }, 500);
    }
  })

  // Get current seat usage for a customer/subscription
  .get("/usage/:customerId", async (c) => {
    console.info("[GET /seats/usage/:customerId] Request received");
    const merchantId = c.get("merchant")!.id;
    const customerId = c.req.param("customerId");

    try {
      console.debug(
        `[GET /seats/usage/:customerId] Getting seat usage for customer: ${customerId}, merchant: ${merchantId}`
      );

      // Get the customer's active subscription
      const customerData = await db.query.customers.findFirst({
        where: and(
          eq(customers.id, customerId),
          eq(customers.merchantId, merchantId),
          isNull(customers.deletedAt)
        ),
      });

      console.debug(
        "[GET /seats/usage/:customerId] customerData:",
        customerData
      );

      if (!customerData) {
        console.warn("[GET /seats/usage/:customerId] Customer not found", {
          customerId,
        });
        return c.json({ error: "Customer not found" }, 404);
      }

      const activeSubscription = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.customerId, customerId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt),
          isNull(subscriptions.endTimestamp)
        ),
        with: {
          plan: true,
          price: true,
          subscriptionDetails: true,
        },
      });

      console.debug(
        "[GET /seats/usage/:customerId] activeSubscription:",
        activeSubscription
      );

      if (!activeSubscription) {
        console.warn(
          "[GET /seats/usage/:customerId] No active subscription found",
          { customerId }
        );
        return c.json({ error: "No active subscription found" }, 404);
      }

      // Get price components from the price data
      const priceComponents =
        activeSubscription.price?.pricingData?.components || [];
      console.debug(
        "[GET /seats/usage/:customerId] priceComponents:",
        priceComponents
      );

      // Find seat-based components (per_unit components)
      const seatBasedComponents = priceComponents.filter(
        (
          component: PriceComponentSchemaType
        ): component is PerUnitPriceComponentSchemaType =>
          component.type === "per_unit"
      );

      console.debug(
        "[GET /seats/usage/:customerId] seatBasedComponents:",
        seatBasedComponents
      );

      if (seatBasedComponents.length === 0) {
        console.warn(
          "[GET /seats/usage/:customerId] No seat-based components found",
          { customerId }
        );
        return c.json({ error: "No seat-based components found" }, 404);
      }

      // Calculate current seat usage for each seat-based component
      const seatUsages = [];
      const now = new Date();

      for (const component of seatBasedComponents) {
        if (!component.metric_id) {
          console.warn(
            `[GET /seats/usage/:customerId] Component ${component.component_id} has no metric_id`
          );
          continue;
        }

        console.debug(
          `[GET /seats/usage/:customerId] Processing component ${component.component_id} with metric ${component.metric_id}`
        );

        // Get the metric definition
        const metric = await db.query.metrics.findFirst({
          where: and(
            eq(metrics.id, component.metric_id),
            eq(metrics.merchantId, merchantId),
            isNull(metrics.deletedAt)
          ),
        });

        console.debug(`[GET /seats/usage/:customerId] Found metric:`, metric);

        if (!metric) {
          console.warn(
            `[GET /seats/usage/:customerId] Metric not found for component ${component.component_id}`
          );
          continue;
        }

        // Calculate usage using the same logic as billing
        // For current usage, we use a wide time range to get all seat events
        const startDate = new Date(activeSubscription.startTimestamp);
        const endDate = now;

        const currentUsage = await calculateUsageForComponent(
          merchantId,
          customerId,
          {
            id: metric.id,
            queryType: metric.queryType,
            eventName: metric.eventName,
            aggregationType: metric.aggregationType,
            valueType: metric.valueType,
            sqlDefinition: metric.sqlDefinition,
          },
          "per_unit",
          startDate,
          endDate,
          activeSubscription.id
        );

        console.debug(
          `[GET /seats/usage/:customerId] Current usage for component ${component.component_id}: ${currentUsage}`
        );

        // Get pending removals - seats removed in current period but will take effect next period
        // This requires querying QuestDB for seat_removed events since last billing date
        let pendingRemovals = 0;

        // Get the last billing date from subscription details
        const subscriptionDetail = await db.query.subscriptionDetails.findFirst(
          {
            where: and(
              eq(subscriptionDetails.subscriptionId, activeSubscription.id),
              eq(subscriptionDetails.componentId, component.component_id),
              isNull(subscriptionDetails.deletedAt)
            ),
          }
        );

        console.debug(
          `[GET /seats/usage/:customerId] subscriptionDetail:`,
          subscriptionDetail
        );

        if (subscriptionDetail?.previousBillingDate) {
          try {
            const result = await questDbService.queryMetrics({
              merchantId,
              metricType: "complex",
              timeframe: { type: "ALL" },
              rawSql: `
                SELECT COUNT(*) as removal_count
                FROM events
                WHERE merchant_id = $1
                  AND customer_id = $2
                  AND event_name = 'seat_removed'
                  AND event_timestamp > $3
                  AND event_timestamp <= $4
              `,
              rawValues: [
                merchantId,
                customerId,
                subscriptionDetail.previousBillingDate.toISOString(),
                now.toISOString(),
              ],
            });

            console.debug(
              `[GET /seats/usage/:customerId] pendingRemovals result:`,
              result
            );

            if (!result.error && result.rows && result.rows.length > 0) {
              pendingRemovals = parseInt(
                result.rows[0].removal_count?.toString() || "0",
                10
              );
            }
          } catch (error) {
            console.error(
              `Failed to fetch pending removals for component ${component.component_id}:`,
              error
            );
          }
        }

        console.debug(
          `[GET /seats/usage/:customerId] Pending removals for component ${component.component_id}: ${pendingRemovals}`
        );

        seatUsages.push({
          componentId: component.component_id,
          componentName: component.component_name,
          unitLabel: component.unit_label,
          metricId: component.metric_id,
          currentUsage,
          pendingRemovals,
          unitAmountCents: component.amount_cents,
        });
      }

      // Get subscription details for next billing calculation
      const subscriptionDetailsForBilling =
        await db.query.subscriptionDetails.findMany({
          where: and(
            eq(subscriptionDetails.subscriptionId, activeSubscription.id),
            isNull(subscriptionDetails.deletedAt)
          ),
        });

      console.debug("[GET /seats/usage/:customerId] seatUsages:", seatUsages);

      return c.json({
        customerId,
        subscriptionId: activeSubscription.id,
        seatUsages,
        subscriptionDetails: subscriptionDetailsForBilling,
        priceComponents: priceComponents,
      });
    } catch (error) {
      console.error("Error getting seat usage:", error);
      return c.json({ error: "Failed to get seat usage" }, 500);
    }
  });
