import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/client";
import {
  pricingTables,
  pricingTablePlans,
  plans,
  prices,
  pricingTablesInsertSchemaReq,
  pricingTablePlansInsertSchemaReq,
  planFeatures,
  apiKeys,
  creditDefinitions,
} from "@lumen/common/schema";
import { eq, and, isNull, desc, asc } from "drizzle-orm";
import { ID_PREFIXES, createPrefixValidator } from "@lumen/common";
import { getPaymentProvider } from "../helpers/paymentprovider";

// Validation schemas for requests
const pricingTableIdParam = z.object({
  id: createPrefixValidator(
    ID_PREFIXES.pricingTable,
    "Invalid pricing table ID format"
  )(z.string()),
});

const pricingTablePlanIdParam = z.object({
  id: createPrefixValidator(
    ID_PREFIXES.pricingTablePlan,
    "Invalid pricing table plan ID format"
  )(z.string()),
});

const pricingTableSlugParam = z.object({
  slug: z.string().min(1, "Slug is required"),
});

// Enhanced schema for creating a pricing table with plans
const createPricingTableWithPlansSchema = pricingTablesInsertSchemaReq.extend({
  planIds: z.array(z.string()).min(1, "At least one plan ID is required"),
  planConfigs: z
    .array(
      z.object({
        planId: z.string(),
        displayOrder: z.number().optional(),
        isPopular: z.boolean().optional(),
        popularText: z.string().optional(),
        buttonText: z.string().optional(),
        buttonOutline: z.boolean().optional(),
      })
    )
    .optional(),
});

const pricingTableUpdateSchema = pricingTablesInsertSchemaReq.partial();
const pricingTablePlanUpdateSchema = pricingTablePlansInsertSchemaReq.partial();

// Router for pricing tables management
export const pricingTablesRouter = new Hono()
  .get("payment-provider", async (c) => {
    const merchantId = c.get("merchant")!.id;
    const { name } = await getPaymentProvider(merchantId);
    return c.json({ paymentProvider: name });
  })
  // List all pricing tables for the merchant
  .get("/", async (c) => {
    const merchantId = c.get("merchant")!.id;

    try {
      const pricingTablesList = await db.query.pricingTables.findMany({
        where: and(
          eq(pricingTables.merchantId, merchantId),
          isNull(pricingTables.deletedAt)
        ),
        orderBy: [asc(pricingTables.name)],
        columns: {
          merchantId: false,
        },
        with: {
          pricingTablePlans: {
            where: isNull(pricingTablePlans.deletedAt),
            columns: {
              id: true,
              planId: true,
              displayOrder: true,
              isPopular: true,
              popularText: true,
              buttonText: true,
              buttonOutline: true,
              isEnterprisePlan: true,
              enterpriseRedirectUrl: true,
            },
            orderBy: asc(pricingTablePlans.displayOrder),
          },
        },
      });

      return c.json({ pricingTables: pricingTablesList });
    } catch (error) {
      console.error("Error fetching pricing tables:", error);
      return c.json({ error: "Failed to fetch pricing tables" }, 500);
    }
  })

  // Get a specific pricing table by ID
  .get("/:id", zValidator("param", pricingTableIdParam), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const pricingTableId = c.req.valid("param").id;

    try {
      const pricingTable = await db.query.pricingTables.findFirst({
        where: and(
          eq(pricingTables.id, pricingTableId),
          eq(pricingTables.merchantId, merchantId),
          isNull(pricingTables.deletedAt)
        ),
        columns: {
          merchantId: false,
        },
        with: {
          pricingTablePlans: {
            where: isNull(pricingTablePlans.deletedAt),
            orderBy: asc(pricingTablePlans.displayOrder),
            columns: {
              displayOrder: true,
              isPopular: true,
              popularText: true,
              buttonText: true,
              buttonOutline: true,
              isEnterprisePlan: true,
              enterpriseRedirectUrl: true,
            },
            with: {
              plan: {
                columns: {
                  id: true,
                  pspPlanId: true,
                  planName: true,
                  planDescription: true,
                },
                with: {
                  planFeatures: {
                    where: isNull(planFeatures.deletedAt),
                    with: {
                      feature: true,
                    },
                  },
                  prices: {
                    where: isNull(prices.deletedAt),
                    orderBy: desc(prices.createdAt),
                    limit: 1,
                  },
                  creditDefinitions: {
                    where: and(
                      eq(creditDefinitions.scope, "plan"),
                      eq(creditDefinitions.applicationType, "usage"), // TODO: When we allow other types, change this
                      isNull(creditDefinitions.deletedAt)
                    ),
                    with: {
                      feature: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!pricingTable) {
        return c.json(
          { error: "Pricing table not found or access denied" },
          404
        );
      }

      const formattedPricingTable = {
        ...pricingTable,
        plans: pricingTable.pricingTablePlans.map((ptp) => {
          const planData = ptp.plan;
          const latestPrice = planData.prices[0];

          return {
            id: planData.id,
            name: planData.planName,
            description: planData.planDescription,
            features: planData.planFeatures.map((pf) => {
              let featureText = pf.feature.displayName;

              // Add credit allowance information from plan's credit definitions
              const creditDef = planData.creditDefinitions?.find(
                (cd) => cd.featureId === pf.feature.id
              );
              if (creditDef && creditDef.defaultAmount > 0) {
                let renewal: "monthly" | "yearly" | "none" = "none";
                if (creditDef.refillRrule?.includes("MONTHLY")) {
                  renewal = "monthly";
                } else if (creditDef.refillRrule?.includes("YEARLY")) {
                  renewal = "yearly";
                }

                if (renewal === "monthly") {
                  featureText += ` (${creditDef.defaultAmount} per month)`;
                } else if (renewal === "yearly") {
                  featureText += ` (${creditDef.defaultAmount} per year)`;
                } else {
                  featureText += ` (${creditDef.defaultAmount} included)`;
                }
              }

              return {
                id: pf.feature.id,
                name: featureText,
                description: pf.feature.description,
                featureValue: pf.featureValue,
              };
            }),
            price: latestPrice
              ? {
                  id: latestPrice.id,
                  currency: latestPrice.currency,
                  pricingData: latestPrice.pricingData,
                }
              : null,
            display: {
              order: ptp.displayOrder,
              isPopular: ptp.isPopular,
              popularText: ptp.popularText,
              buttonText: ptp.buttonText,
              buttonOutline: ptp.buttonOutline,
              isEnterprisePlan: ptp.isEnterprisePlan,
              enterpriseRedirectUrl: ptp.enterpriseRedirectUrl,
            },
          };
        }),
      };

      // Create a new object without the pricingTablePlans property
      const { pricingTablePlans: _, ...result } = formattedPricingTable;

      return c.json({ pricingTable: result });
    } catch (error) {
      console.error("Error fetching pricing table:", error);
      return c.json({ error: "Failed to fetch pricing table" }, 500);
    }
  })

  // Create a new pricing table
  .post(
    "/",
    zValidator("json", createPricingTableWithPlansSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const data = c.req.valid("json");

      try {
        // Check if slug is already in use
        const existingWithSlug = await db.query.pricingTables.findFirst({
          where: and(
            eq(pricingTables.merchantId, merchantId),
            eq(pricingTables.slug, data.slug),
            isNull(pricingTables.deletedAt)
          ),
        });

        if (existingWithSlug) {
          return c.json(
            { error: "A pricing table with this slug already exists" },
            409
          );
        }

        // Extract plan IDs and config information
        const { planIds, planConfigs, ...pricingTableData } = data;

        // Verify all plans exist and belong to this merchant
        const merchantPlans = await db.query.plans.findMany({
          where: and(eq(plans.merchantId, merchantId), isNull(plans.deletedAt)),
        });

        const merchantPlanIds = merchantPlans.map((plan) => plan.id);
        const invalidPlanIds = planIds.filter(
          (id) => !merchantPlanIds.includes(id)
        );

        if (invalidPlanIds.length > 0) {
          return c.json(
            {
              error: "Invalid plan IDs",
              details: `The following plan IDs do not exist or don't belong to this merchant: ${invalidPlanIds.join(", ")}`,
            },
            400
          );
        }

        // Map plan IDs to configs if configs are provided
        const planConfigMap = new Map();
        if (planConfigs) {
          planConfigs.forEach((config) => {
            planConfigMap.set(config.planId, config);
          });
        }

        // Create pricing table and plan associations in a transaction
        let newPricingTable;
        let pricingTablePlanAssociations: (typeof pricingTablePlans.$inferInsert)[] =
          [];

        await db.transaction(async (tx) => {
          // Create the pricing table
          const [createdPricingTable] = await tx
            .insert(pricingTables)
            .values({
              ...pricingTableData,
              merchantId,
            })
            .returning();

          newPricingTable = createdPricingTable;

          // Create plan associations
          for (let i = 0; i < planIds.length; i++) {
            const planId = planIds[i];
            const config = planConfigMap.get(planId) || {};

            // Get the display order from config, or use the index + 1
            const displayOrder =
              config.displayOrder !== undefined ? config.displayOrder : i + 1;

            const [association] = await tx
              .insert(pricingTablePlans)
              .values({
                pricingTableId: createdPricingTable.id,
                planId,
                merchantId,
                displayOrder,
                isPopular:
                  config.isPopular !== undefined ? config.isPopular : false,
                popularText: config.popularText || "Popular",
                buttonText: config.buttonText || "Get Started",
                buttonOutline:
                  config.buttonOutline !== undefined
                    ? config.buttonOutline
                    : false,
              })
              .returning();

            pricingTablePlanAssociations.push(association);
          }
        });

        // Return the created pricing table with its plan associations
        return c.json(
          {
            pricingTable: newPricingTable,
            planAssociations: pricingTablePlanAssociations,
            message: `Successfully created pricing table with ${pricingTablePlanAssociations.length} plan associations`,
          },
          201
        );
      } catch (error) {
        console.error("Error creating pricing table:", error);
        return c.json({ error: "Failed to create pricing table" }, 500);
      }
    }
  )

  // Update an existing pricing table
  .post(
    "/:id",
    zValidator("param", pricingTableIdParam),
    zValidator("json", pricingTableUpdateSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const pricingTableId = c.req.valid("param").id;
      const data = c.req.valid("json");

      try {
        // Check if the pricing table exists
        const existingPricingTable = await db.query.pricingTables.findFirst({
          where: and(
            eq(pricingTables.id, pricingTableId),
            eq(pricingTables.merchantId, merchantId),
            isNull(pricingTables.deletedAt)
          ),
        });

        if (!existingPricingTable) {
          return c.json(
            { error: "Pricing table not found or access denied" },
            404
          );
        }

        // If slug is being updated, check if it's already in use
        if (data.slug && data.slug !== existingPricingTable.slug) {
          const existingWithSlug = await db.query.pricingTables.findFirst({
            where: and(
              eq(pricingTables.merchantId, merchantId),
              eq(pricingTables.slug, data.slug),
              isNull(pricingTables.deletedAt)
            ),
          });

          if (existingWithSlug) {
            return c.json(
              { error: "A pricing table with this slug already exists" },
              409
            );
          }
        }

        // Update the pricing table
        const [updatedPricingTable] = await db
          .update(pricingTables)
          .set({
            ...data,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pricingTables.id, pricingTableId),
              eq(pricingTables.merchantId, merchantId)
            )
          )
          .returning();

        return c.json({ pricingTable: updatedPricingTable });
      } catch (error) {
        console.error("Error updating pricing table:", error);
        return c.json({ error: "Failed to update pricing table" }, 500);
      }
    }
  )

  // Delete a pricing table
  .delete("/:id", zValidator("param", pricingTableIdParam), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const pricingTableId = c.req.valid("param").id;

    try {
      // Check if the pricing table exists
      const existingPricingTable = await db.query.pricingTables.findFirst({
        where: and(
          eq(pricingTables.id, pricingTableId),
          eq(pricingTables.merchantId, merchantId),
          isNull(pricingTables.deletedAt)
        ),
      });

      if (!existingPricingTable) {
        return c.json(
          { error: "Pricing table not found or access denied" },
          404
        );
      }

      // Soft delete the pricing table and its associations (NOT the underlying plans)
      await db.transaction(async (tx) => {
        // Soft delete the pricing table
        await tx
          .update(pricingTables)
          .set({
            deletedAt: new Date(),
          })
          .where(
            and(
              eq(pricingTables.id, pricingTableId),
              eq(pricingTables.merchantId, merchantId)
            )
          );

        // Soft delete the pricing table plan associations (junction table entries)
        // This only removes the association records, not the plans themselves
        await tx
          .update(pricingTablePlans)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(pricingTablePlans.pricingTableId, pricingTableId),
              eq(pricingTablePlans.merchantId, merchantId),
              isNull(pricingTablePlans.deletedAt)
            )
          );
      });

      return c.json({ success: true });
    } catch (error) {
      console.error("Error deleting pricing table:", error);
      return c.json({ error: "Failed to delete pricing table" }, 500);
    }
  })

  // Add a plan to a pricing table
  .post(
    "/:id/plans",
    zValidator("param", pricingTableIdParam),
    zValidator("json", pricingTablePlansInsertSchemaReq),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const pricingTableId = c.req.valid("param").id;
      const data = c.req.valid("json");

      try {
        // Check if the pricing table exists
        const existingPricingTable = await db.query.pricingTables.findFirst({
          where: and(
            eq(pricingTables.id, pricingTableId),
            eq(pricingTables.merchantId, merchantId),
            isNull(pricingTables.deletedAt)
          ),
        });

        if (!existingPricingTable) {
          return c.json(
            { error: "Pricing table not found or access denied" },
            404
          );
        }

        // Check if the plan exists
        const existingPlan = await db.query.plans.findFirst({
          where: and(
            eq(plans.id, data.planId),
            eq(plans.merchantId, merchantId),
            isNull(plans.deletedAt)
          ),
        });

        if (!existingPlan) {
          return c.json({ error: "Plan not found or access denied" }, 404);
        }

        // Check if the plan is already in the pricing table
        const existingAssociation = await db.query.pricingTablePlans.findFirst({
          where: and(
            eq(pricingTablePlans.pricingTableId, pricingTableId),
            eq(pricingTablePlans.planId, data.planId),
            eq(pricingTablePlans.merchantId, merchantId),
            isNull(pricingTablePlans.deletedAt)
          ),
        });

        if (existingAssociation) {
          return c.json(
            { error: "This plan is already in the pricing table" },
            409
          );
        }

        // Add the plan to the pricing table
        const [newPricingTablePlan] = await db
          .insert(pricingTablePlans)
          .values({
            ...data,
            pricingTableId,
            merchantId,
          })
          .returning();

        return c.json({ pricingTablePlan: newPricingTablePlan }, 201);
      } catch (error) {
        console.error("Error adding plan to pricing table:", error);
        return c.json({ error: "Failed to add plan to pricing table" }, 500);
      }
    }
  )

  // Update a plan in a pricing table
  .post(
    "/plans/:id",
    zValidator("param", pricingTablePlanIdParam),
    zValidator("json", pricingTablePlanUpdateSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const pricingTablePlanId = c.req.valid("param").id;
      const data = c.req.valid("json");

      try {
        // Check if the pricing table plan exists
        const existingPricingTablePlan =
          await db.query.pricingTablePlans.findFirst({
            where: and(
              eq(pricingTablePlans.id, pricingTablePlanId),
              eq(pricingTablePlans.merchantId, merchantId),
              isNull(pricingTablePlans.deletedAt)
            ),
          });

        if (!existingPricingTablePlan) {
          return c.json(
            { error: "Pricing table plan not found or access denied" },
            404
          );
        }

        // If planId is being updated, check if it's valid and not already in the pricing table
        if (data.planId && data.planId !== existingPricingTablePlan.planId) {
          // Check if the new plan exists
          const newPlan = await db.query.plans.findFirst({
            where: and(
              eq(plans.id, data.planId),
              eq(plans.merchantId, merchantId),
              isNull(plans.deletedAt)
            ),
          });

          if (!newPlan) {
            return c.json(
              { error: "New plan not found or access denied" },
              404
            );
          }

          // Check if the new plan is already in the pricing table
          const existingAssociation =
            await db.query.pricingTablePlans.findFirst({
              where: and(
                eq(
                  pricingTablePlans.pricingTableId,
                  existingPricingTablePlan.pricingTableId
                ),
                eq(pricingTablePlans.planId, data.planId),
                eq(pricingTablePlans.merchantId, merchantId),
                isNull(pricingTablePlans.deletedAt)
              ),
            });

          if (existingAssociation) {
            return c.json(
              { error: "This plan is already in the pricing table" },
              409
            );
          }
        }

        // Update the pricing table plan
        const [updatedPricingTablePlan] = await db
          .update(pricingTablePlans)
          .set({
            ...data,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pricingTablePlans.id, pricingTablePlanId),
              eq(pricingTablePlans.merchantId, merchantId)
            )
          )
          .returning();

        return c.json({ pricingTablePlan: updatedPricingTablePlan });
      } catch (error) {
        console.error("Error updating pricing table plan:", error);
        return c.json({ error: "Failed to update pricing table plan" }, 500);
      }
    }
  )

  // Remove a plan from a pricing table
  .delete(
    "/plans/:id",
    zValidator("param", pricingTablePlanIdParam),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const pricingTablePlanId = c.req.valid("param").id;

      try {
        // Check if the pricing table plan exists
        const existingPricingTablePlan =
          await db.query.pricingTablePlans.findFirst({
            where: and(
              eq(pricingTablePlans.id, pricingTablePlanId),
              eq(pricingTablePlans.merchantId, merchantId),
              isNull(pricingTablePlans.deletedAt)
            ),
          });

        if (!existingPricingTablePlan) {
          return c.json(
            { error: "Pricing table plan not found or access denied" },
            404
          );
        }

        // Soft delete the pricing table plan
        await db
          .update(pricingTablePlans)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(pricingTablePlans.id, pricingTablePlanId),
              eq(pricingTablePlans.merchantId, merchantId)
            )
          );

        return c.json({ success: true });
      } catch (error) {
        console.error("Error removing plan from pricing table:", error);
        return c.json(
          { error: "Failed to remove plan from pricing table" },
          500
        );
      }
    }
  );

// Public routes for accessing pricing tables
export const publicPricingTablesRouter = new Hono()
  // Get the first public pricing table
  .get("/", async (c) => {
    const apiKey = c.req.header("X-Lumen-Key");

    if (!apiKey) {
      return c.json({ error: "X-Lumen-Key header is required" }, 400);
    }

    // Find the merchant ID using the public key
    const apiKeyData = await db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.keyValue, apiKey),
        eq(apiKeys.keyType, "publishable"),
        isNull(apiKeys.revokedAt)
      ),
    });

    if (!apiKeyData) {
      return c.json({ error: "Invalid publishable key" }, 401);
    }

    const merchantId = apiKeyData.merchantId;

    try {
      // Find the first pricing table
      let pricingTable = await db.query.pricingTables.findFirst({
        where: and(
          eq(pricingTables.merchantId, merchantId),
          eq(pricingTables.isActive, true),
          isNull(pricingTables.deletedAt)
        ),
        columns: {
          id: true,
          name: true,
          slug: true,
          description: true,
          heading: true,
          subheading: true,
        },
        with: {
          pricingTablePlans: {
            where: isNull(pricingTablePlans.deletedAt),
            orderBy: asc(pricingTablePlans.displayOrder),
            columns: {
              buttonText: true,
              buttonOutline: true,
              isPopular: true,
              popularText: true,
              isEnterprisePlan: true,
              enterpriseRedirectUrl: true,
            },
            with: {
              plan: {
                columns: {
                  id: true,
                  pspPlanId: true,
                  planName: true,
                  planDescription: true,
                  isTrialPlan: true,
                },
                with: {
                  planFeatures: {
                    where: isNull(planFeatures.deletedAt),
                    with: {
                      feature: true,
                    },
                  },
                  prices: {
                    where: isNull(prices.deletedAt),
                    orderBy: desc(prices.createdAt),
                  },
                  creditDefinitions: {
                    where: and(
                      eq(creditDefinitions.scope, "plan"),
                      eq(creditDefinitions.applicationType, "usage"),
                      isNull(creditDefinitions.deletedAt)
                    ),
                    with: {
                      feature: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!pricingTable) {
        return c.json({ error: "No pricing table found" }, 404);
      }

      // Validate that the pricing table has at least one plan
      if (
        !pricingTable.pricingTablePlans ||
        pricingTable.pricingTablePlans.length === 0
      ) {
        return c.json(
          {
            error: "Invalid pricing table: At least one plan is required",
            details:
              'ZodError: [{ "code": "too_small", "minimum": 1, "type": "array", "inclusive": true, "exact": false, "message": "At least one plan is required", "path": ["plans"] }]',
          },
          400
        );
      }

      // Filter out trial plans from pricing table plans
      const nonTrialPlans = pricingTable.pricingTablePlans.filter(
        (ptp) => ptp.plan && !ptp.plan.isTrialPlan
      );

      // Get trial plans for each main plan
      const mainPlanIds = nonTrialPlans
        .map((ptp) => ptp.plan?.id)
        .filter(Boolean);
      const trialPlans =
        mainPlanIds.length > 0
          ? await db.query.plans.findMany({
              where: and(
                eq(plans.merchantId, merchantId),
                eq(plans.isTrialPlan, true),
                isNull(plans.deletedAt)
              ),
              columns: {
                id: true,
                trialParentPlanId: true,
                trialDays: true,
              },
              with: {
                creditDefinitions: {
                  where: and(
                    eq(creditDefinitions.scope, "plan"),
                    eq(creditDefinitions.applicationType, "usage"),
                    isNull(creditDefinitions.deletedAt)
                  ),
                  with: {
                    feature: true,
                  },
                },
              },
            })
          : [];

      // Create a map of main plan ID to trial info
      const trialMap = new Map();
      const trialCreditMap = new Map(); // Map of parent plan ID to trial credit definitions
      trialPlans.forEach((trialPlan) => {
        if (trialPlan.trialParentPlanId) {
          trialMap.set(trialPlan.trialParentPlanId, {
            available: true,
            days: trialPlan.trialDays || 7,
            trialPlanId: trialPlan.id,
          });

          // Create credit definition map for this trial plan
          const trialCredits = new Map();
          trialPlan.creditDefinitions?.forEach((cd) => {
            trialCredits.set(cd.featureId, cd.defaultAmount);
          });
          trialCreditMap.set(trialPlan.trialParentPlanId, trialCredits);
        }
      });

      // Format the response for the PricingTable component
      const pricingData = {
        heading: pricingTable.heading || pricingTable.name,
        description: pricingTable.subheading || pricingTable.description,
        plans: nonTrialPlans.map((ptp) => {
          const planData = ptp.plan;

          // Get price amounts from pricing data components
          let priceMonthly = 0;
          let priceYearly = 0;
          let priceAmount = 0;
          let priceInterval = "month";
          let priceIdMonthly: string | undefined;
          let priceIdYearly: string | undefined;
          let foundMonthly = false;
          let foundYearly = false;

          // Process all prices for this plan to find monthly and yearly pricing
          if (
            !ptp.isEnterprisePlan &&
            planData.prices &&
            planData.prices.length > 0
          ) {
            planData.prices.forEach((price) => {
              if (
                price &&
                price.pricingData &&
                price.pricingData.components &&
                price.pricingData.components.length > 0
              ) {
                // Look for fixed or per_unit components in this price to determine if it's monthly or yearly
                for (const component of price.pricingData.components) {
                  if (
                    (component.type === "fixed" ||
                      component.type === "per_unit") &&
                    "amount_cents" in component &&
                    typeof (component as any).amount_cents === "number"
                  ) {
                    let recurrence = "";

                    // Handle different components having different recurrence fields
                    if (
                      "recurrence_rule" in component &&
                      typeof component.recurrence_rule === "string"
                    ) {
                      recurrence = component.recurrence_rule.toLowerCase();
                    } else if (
                      "billing_cycle" in component &&
                      typeof component.billing_cycle === "string"
                    ) {
                      recurrence = component.billing_cycle.toLowerCase();
                    }

                    // Assign price based on recurrence - each price object typically has one billing frequency
                    const amountCents = (component as any)
                      .amount_cents as number;
                    if (recurrence.includes("month") && !foundMonthly) {
                      priceMonthly = amountCents;
                      priceIdMonthly = price.id;
                      foundMonthly = true;
                    } else if (recurrence.includes("year") && !foundYearly) {
                      priceYearly = amountCents;
                      priceIdYearly = price.id;
                      foundYearly = true;
                    } else if (priceAmount === 0) {
                      // Use the first component as fallback
                      priceAmount = amountCents;
                      priceInterval = recurrence || "month";
                    }

                    // Break after finding the first fixed/per_unit component in this price
                    break;
                  }
                }
              }
            });
          }

          const latestPrice = planData.prices[0];
          // If no specific monthly/yearly pricing found, use the first component
          if (
            latestPrice &&
            !foundMonthly &&
            !foundYearly &&
            priceAmount === 0
          ) {
            const firstComponent = latestPrice.pricingData.components[0];
            if ("amount_cents" in firstComponent) {
              priceAmount = (firstComponent as any).amount_cents as number;

              if (
                "recurrence_rule" in firstComponent &&
                typeof firstComponent.recurrence_rule === "string"
              ) {
                priceInterval = firstComponent.recurrence_rule.toLowerCase();
              } else if (
                "billing_cycle" in firstComponent &&
                typeof firstComponent.billing_cycle === "string"
              ) {
                priceInterval = firstComponent.billing_cycle.toLowerCase();
              }
            }
          }

          // Check if this plan has per_unit components (seat-based pricing)
          const hasPerUnitComponents = planData.prices?.some((price) =>
            price.pricingData?.components?.some(
              (component) => component.type === "per_unit"
            )
          );

          // Detect minimum seats for per-unit components
          let minSeats: number | undefined;
          if (planData.prices && planData.prices.length > 0) {
            for (const price of planData.prices) {
              const comp = price.pricingData?.components?.find(
                (c: any) =>
                  c.type === "per_unit" &&
                  c.num_seats != null &&
                  c.num_seats > 0
              );
              if (comp) {
                minSeats = (comp as any).num_seats;
                break;
              }
            }
          }

          return {
            title: planData.planName,
            description: planData.planDescription || "",
            pspPlanId: planData.pspPlanId,
            price: priceAmount / 100, // Convert cents to dollars/euros
            priceMonthly: priceMonthly / 100, // Convert cents to dollars/euros
            priceYearly: foundYearly
              ? priceYearly / 100
              : foundMonthly
                ? (priceMonthly * 12) / 100
                : 0, // Convert cents to dollars/euros
            currency: latestPrice ? latestPrice.currency.toLowerCase() : "usd",
            interval: hasPerUnitComponents
              ? "month per seat"
              : priceInterval.toLowerCase(),
            ...(minSeats ? { minSeats } : {}),
            // Include full pricing data for detailed component display
            pricingData: latestPrice ? latestPrice.pricingData : undefined,
            features: planData.planFeatures.map((pf) => {
              let featureText = pf.feature.displayName;

              // Add credit allowance information from plan's credit definitions
              const creditDef = planData.creditDefinitions?.find(
                (cd) => cd.featureId === pf.feature.id
              );
              if (creditDef && creditDef.defaultAmount > 0) {
                let renewal: "monthly" | "yearly" | "none" = "none";
                if (creditDef.refillRrule?.includes("MONTHLY")) {
                  renewal = "monthly";
                } else if (creditDef.refillRrule?.includes("YEARLY")) {
                  renewal = "yearly";
                }

                if (renewal === "monthly") {
                  featureText += ` (${creditDef.defaultAmount} per month)`;
                } else if (renewal === "yearly") {
                  featureText += ` (${creditDef.defaultAmount} per year)`;
                } else {
                  featureText += ` (${creditDef.defaultAmount} included)`;
                }
              }

              // Add trial credit allowance information if trial is available
              const trialInfo = trialMap.get(planData.id);
              if (trialInfo?.available) {
                const trialCredits = trialCreditMap.get(planData.id);
                const trialCreditAmount = trialCredits?.get(pf.feature.id);
                if (trialCreditAmount && trialCreditAmount > 0) {
                  featureText += ` • Trial: ${trialCreditAmount} during trial period`;
                }
              }

              return {
                text: featureText,
              };
            }),
            buttonText: ptp.buttonText || "Get Started",
            buttonOutline: ptp.buttonOutline || false,
            isPopular: ptp.isPopular || false,
            popularText: ptp.popularText || "Popular",
            planId: planData.id,
            priceId: latestPrice ? latestPrice.id : undefined,
            priceIdMonthly: priceIdMonthly,
            priceIdYearly: priceIdYearly,
            isEnterprisePlan: ptp.isEnterprisePlan || false,
            enterpriseRedirectUrl: ptp.enterpriseRedirectUrl || undefined,
            // Add trial information if available
            ...(trialMap.has(planData.id) && {
              trial: trialMap.get(planData.id),
            }),
          };
        }),
      };

      return c.json({ pricingTable: pricingData });
    } catch (error) {
      console.error("Error fetching first pricing table:", error);
      return c.json({ error: "Failed to fetch pricing table" }, 500);
    }
  })

  // Get a public pricing table by slug
  .get("/:slug", zValidator("param", pricingTableSlugParam), async (c) => {
    const slug = c.req.valid("param").slug;
    const apiKey = c.req.header("X-Lumen-Key");

    if (!apiKey) {
      return c.json({ error: "X-Lumen-Key header is required" }, 400);
    }

    // Find the merchant ID using the public key
    const apiKeyData = await db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.keyValue, apiKey),
        eq(apiKeys.keyType, "publishable"),
        isNull(apiKeys.revokedAt)
      ),
    });

    if (!apiKeyData) {
      return c.json({ error: "Invalid publishable key" }, 401);
    }

    const merchantId = apiKeyData.merchantId;

    try {
      // Find the pricing table
      let pricingTable = await db.query.pricingTables.findFirst({
        where: and(
          eq(pricingTables.slug, slug),
          eq(pricingTables.merchantId, merchantId),
          eq(pricingTables.isActive, true),
          isNull(pricingTables.deletedAt)
        ),
        columns: {
          id: true,
          name: true,
          slug: true,
          description: true,
          heading: true,
          subheading: true,
        },
        with: {
          pricingTablePlans: {
            where: isNull(pricingTablePlans.deletedAt),
            orderBy: asc(pricingTablePlans.displayOrder),
            columns: {
              buttonText: true,
              buttonOutline: true,
              isPopular: true,
              popularText: true,
              isEnterprisePlan: true,
              enterpriseRedirectUrl: true,
            },
            with: {
              plan: {
                columns: {
                  id: true,
                  pspPlanId: true,
                  planName: true,
                  planDescription: true,
                  isTrialPlan: true,
                },
                with: {
                  planFeatures: {
                    where: isNull(planFeatures.deletedAt),
                    with: {
                      feature: true,
                    },
                  },
                  prices: {
                    where: isNull(prices.deletedAt),
                    orderBy: desc(prices.createdAt),
                  },
                  creditDefinitions: {
                    where: and(
                      eq(creditDefinitions.scope, "plan"),
                      eq(creditDefinitions.applicationType, "usage"),
                      isNull(creditDefinitions.deletedAt)
                    ),
                    with: {
                      feature: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!pricingTable) {
        return c.json({ error: "Pricing table not found" }, 404);
      }

      // Validate that the pricing table has at least one plan
      if (
        !pricingTable.pricingTablePlans ||
        pricingTable.pricingTablePlans.length === 0
      ) {
        return c.json(
          {
            error: "Invalid pricing table: At least one plan is required",
            details:
              'ZodError: [{ "code": "too_small", "minimum": 1, "type": "array", "inclusive": true, "exact": false, "message": "At least one plan is required", "path": ["plans"] }]',
          },
          400
        );
      }

      // Filter out trial plans from pricing table plans
      const nonTrialPlans = pricingTable.pricingTablePlans.filter(
        (ptp) => ptp.plan && !ptp.plan.isTrialPlan
      );

      // Get trial plans for each main plan
      const mainPlanIds = nonTrialPlans
        .map((ptp) => ptp.plan?.id)
        .filter(Boolean);
      const trialPlans =
        mainPlanIds.length > 0
          ? await db.query.plans.findMany({
              where: and(
                eq(plans.merchantId, merchantId),
                eq(plans.isTrialPlan, true),
                isNull(plans.deletedAt)
              ),
              columns: {
                id: true,
                trialParentPlanId: true,
                trialDays: true,
              },
              with: {
                creditDefinitions: {
                  where: and(
                    eq(creditDefinitions.scope, "plan"),
                    eq(creditDefinitions.applicationType, "usage"),
                    isNull(creditDefinitions.deletedAt)
                  ),
                  with: {
                    feature: true,
                  },
                },
              },
            })
          : [];

      // Create a map of main plan ID to trial info
      const trialMap = new Map();
      const trialCreditMap = new Map(); // Map of parent plan ID to trial credit definitions
      trialPlans.forEach((trialPlan) => {
        if (trialPlan.trialParentPlanId) {
          trialMap.set(trialPlan.trialParentPlanId, {
            available: true,
            days: trialPlan.trialDays || 7,
            trialPlanId: trialPlan.id,
          });

          // Create credit definition map for this trial plan
          const trialCredits = new Map();
          trialPlan.creditDefinitions?.forEach((cd) => {
            trialCredits.set(cd.featureId, cd.defaultAmount);
          });
          trialCreditMap.set(trialPlan.trialParentPlanId, trialCredits);
        }
      });

      // Format the response for the PricingTable component
      const pricingData = {
        heading: pricingTable.heading || pricingTable.name,
        description: pricingTable.subheading || pricingTable.description,
        plans: nonTrialPlans.map((ptp) => {
          const planData = ptp.plan;

          // Get price amounts from pricing data components
          let priceMonthly = 0;
          let priceYearly = 0;
          let priceAmount = 0;
          let priceInterval = "month";
          let priceIdMonthly: string | undefined;
          let priceIdYearly: string | undefined;
          let foundMonthly = false;
          let foundYearly = false;

          // Process all prices for this plan to find monthly and yearly pricing
          if (
            !ptp.isEnterprisePlan &&
            planData.prices &&
            planData.prices.length > 0
          ) {
            planData.prices.forEach((price) => {
              if (
                price &&
                price.pricingData &&
                price.pricingData.components &&
                price.pricingData.components.length > 0
              ) {
                // Look for fixed or per_unit components in this price to determine if it's monthly or yearly
                for (const component of price.pricingData.components) {
                  if (
                    (component.type === "fixed" ||
                      component.type === "per_unit") &&
                    "amount_cents" in component &&
                    typeof (component as any).amount_cents === "number"
                  ) {
                    let recurrence = "";

                    // Handle different components having different recurrence fields
                    if (
                      "recurrence_rule" in component &&
                      typeof component.recurrence_rule === "string"
                    ) {
                      recurrence = component.recurrence_rule.toLowerCase();
                    } else if (
                      "billing_cycle" in component &&
                      typeof component.billing_cycle === "string"
                    ) {
                      recurrence = component.billing_cycle.toLowerCase();
                    }

                    // Assign price based on recurrence - each price object typically has one billing frequency
                    const amountCents = (component as any)
                      .amount_cents as number;
                    if (recurrence.includes("month") && !foundMonthly) {
                      priceMonthly = amountCents;
                      priceIdMonthly = price.id;
                      foundMonthly = true;
                    } else if (recurrence.includes("year") && !foundYearly) {
                      priceYearly = amountCents;
                      priceIdYearly = price.id;
                      foundYearly = true;
                    } else if (priceAmount === 0) {
                      // Use the first component as fallback
                      priceAmount = amountCents;
                      priceInterval = recurrence || "month";
                    }

                    // Break after finding the first fixed/per_unit component in this price
                    break;
                  }
                }
              }
            });
          }

          const latestPrice = planData.prices[0];
          // If no specific monthly/yearly pricing found, use the first component
          if (
            latestPrice &&
            !foundMonthly &&
            !foundYearly &&
            priceAmount === 0
          ) {
            const firstComponent = latestPrice.pricingData.components[0];
            if ("amount_cents" in firstComponent) {
              priceAmount = (firstComponent as any).amount_cents as number;

              if (
                "recurrence_rule" in firstComponent &&
                typeof firstComponent.recurrence_rule === "string"
              ) {
                priceInterval = firstComponent.recurrence_rule.toLowerCase();
              } else if (
                "billing_cycle" in firstComponent &&
                typeof firstComponent.billing_cycle === "string"
              ) {
                priceInterval = firstComponent.billing_cycle.toLowerCase();
              }
            }
          }

          // Check if this plan has per_unit components (seat-based pricing)
          const hasPerUnitComponents = planData.prices?.some((price) =>
            price.pricingData?.components?.some(
              (component) => component.type === "per_unit"
            )
          );

          // Detect minimum seats for per-unit components
          let minSeats: number | undefined;
          if (planData.prices && planData.prices.length > 0) {
            for (const price of planData.prices) {
              const comp = price.pricingData?.components?.find(
                (c: any) =>
                  c.type === "per_unit" &&
                  c.num_seats != null &&
                  c.num_seats > 0
              );
              if (comp) {
                minSeats = (comp as any).num_seats;
                break;
              }
            }
          }

          return {
            title: planData.planName,
            description: planData.planDescription || "",
            price: ptp.isEnterprisePlan ? 0 : priceAmount / 100, // Convert cents to dollars/euros
            priceMonthly: ptp.isEnterprisePlan ? 0 : priceMonthly / 100, // Convert cents to dollars/euros
            priceYearly: ptp.isEnterprisePlan
              ? 0
              : foundYearly
                ? priceYearly / 100
                : foundMonthly
                  ? (priceMonthly * 12) / 100
                  : 0, // Convert cents to dollars/euros
            currency: latestPrice ? latestPrice.currency.toLowerCase() : "usd",
            interval: hasPerUnitComponents
              ? "month per seat"
              : priceInterval.toLowerCase(),
            ...(minSeats ? { minSeats } : {}),
            // Include full pricing data for detailed component display
            pricingData: latestPrice ? latestPrice.pricingData : undefined,
            features: planData.planFeatures.map((pf) => {
              let featureText = pf.feature.displayName;

              // Add credit allowance information from plan's credit definitions
              const creditDef = planData.creditDefinitions?.find(
                (cd) => cd.featureId === pf.feature.id
              );
              if (creditDef && creditDef.defaultAmount > 0) {
                let renewal: "monthly" | "yearly" | "none" = "none";
                if (creditDef.refillRrule?.includes("MONTHLY")) {
                  renewal = "monthly";
                } else if (creditDef.refillRrule?.includes("YEARLY")) {
                  renewal = "yearly";
                }

                if (renewal === "monthly") {
                  featureText += ` (${creditDef.defaultAmount} per month)`;
                } else if (renewal === "yearly") {
                  featureText += ` (${creditDef.defaultAmount} per year)`;
                } else {
                  featureText += ` (${creditDef.defaultAmount} included)`;
                }
              }

              // Add trial credit allowance information if trial is available
              const trialInfo = trialMap.get(planData.id);
              if (trialInfo?.available) {
                const trialCredits = trialCreditMap.get(planData.id);
                const trialCreditAmount = trialCredits?.get(pf.feature.id);
                if (trialCreditAmount && trialCreditAmount > 0) {
                  featureText += ` • Trial: ${trialCreditAmount} during trial period`;
                }
              }

              return {
                text: featureText,
              };
            }),
            buttonText: ptp.buttonText || "Get Started",
            buttonOutline: ptp.buttonOutline || false,
            isPopular: ptp.isPopular || false,
            popularText: ptp.popularText || "Popular",
            planId: planData.id,
            priceId: latestPrice ? latestPrice.id : undefined,
            priceIdMonthly: ptp.isEnterprisePlan ? undefined : priceIdMonthly,
            priceIdYearly: ptp.isEnterprisePlan ? undefined : priceIdYearly,
            isEnterprisePlan: ptp.isEnterprisePlan || false,
            enterpriseRedirectUrl: ptp.enterpriseRedirectUrl || undefined,
            // Add trial information if available
            ...(trialMap.has(planData.id) && {
              trial: trialMap.get(planData.id),
            }),
          };
        }),
      };

      return c.json({ pricingTable: pricingData });
    } catch (error) {
      console.error("Error fetching public pricing table:", error);
      return c.json({ error: "Failed to fetch pricing table" }, 500);
    }
  });
