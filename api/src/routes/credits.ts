import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  createCreditDefinition,
  updateCreditDefinition,
  deleteCreditDefinition,
  createCreditGrant,
  processGrantRenewals,
  processExpirations,
  processRenewalAfterInvoice,
  createCreditTransaction,
  getCustomerCreditUsage,
  getAvailableCreditDefinitionsForCustomer,
  createManualCreditGrant,
  validateCreditAmount,
  MANUAL_CREDIT_LIMITS,
  AvailableCreditDefinition,
  NewCreditConfig,
} from "../helpers/credits";
import { db } from "../db/client";
import {
  creditDefinitions,
  creditGrants,
  creditGrantSources,
  creditApplicationTypes,
  creditScopes,
  creditGrantStatuses,
} from "@lumen/common/schema";
import { eq, and, isNull, desc, sql } from "drizzle-orm";

// Enhanced Zod schemas for validation using imported type definitions

// Base validation for credit application types - reusing schema constants
const creditApplicationTypeSchema = z.enum(creditApplicationTypes);
const creditScopeSchema = z.enum(creditScopes);
const creditGrantSourceSchema = z.enum(creditGrantSources);
const creditGrantStatusSchema = z.enum(creditGrantStatuses);

// Enhanced credit definition creation schema with conditional validation
const creditDefinitionCreateSchema = z
  .object({
    // Required fields
    scope: creditScopeSchema,
    applicationType: creditApplicationTypeSchema,
    name: z.string().min(1, "Name is required"),
    defaultAmount: z.number().int().positive("Default amount must be positive"),

    // Conditional fields
    planId: z.string().nullable().optional(),
    featureId: z.string().nullable().optional(),
    featureSlug: z.string().nullable().optional(),
    priceId: z.string().nullable().optional(),
    priceComponentId: z.string().nullable().optional(),

    // Billing configuration
    billingVisible: z.boolean().optional(),
    billingDescription: z.string().optional(),
    currency: z.string().nullable().optional(),

    // Amount configuration
    refillAmount: z
      .number()
      .int()
      .positive("Refill amount must be positive")
      .optional(),

    // Renewal configuration
    expiryDays: z
      .number()
      .int()
      .positive("Expiry days must be positive")
      .optional(),
    refillRrule: z.string().optional(),
    renewOnBilling: z.boolean().optional(),
    priority: z.number().int().optional(),

    // Metadata
    description: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // Conditional validation based on scope
    if (data.scope === "plan" && !data.planId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Plan-scoped credits require planId",
        path: ["planId"],
      });
    }

    // Conditional validation based on application type
    switch (data.applicationType) {
      case "usage":
        // For usage credits, we need either:
        // 1. Price/component linkage (for paid plans with specific pricing)
        // 2. Feature linkage only (for free plans where credits aren't tied to pricing)
        if (
          !data.priceId &&
          !data.priceComponentId &&
          !data.featureId &&
          !data.featureSlug
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Usage credits require either price linkage (priceId/priceComponentId) or feature linkage (featureId/featureSlug)",
            path: ["priceId", "priceComponentId", "featureId", "featureSlug"],
          });
        }
        break;

      case "monetary":
        // For monetary credits:
        // - Price-specific credits (scope: plan, priceId provided): target specific price
        // - Plan-level credits (scope: plan, priceId: null): apply to any price in the plan
        // - Account credits (scope: merchant, priceId: null): merchant-wide

        if (data.scope === "merchant" && data.priceId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Merchant-scoped monetary credits should not have priceId",
            path: ["priceId"],
          });
        }
        if (!data.currency) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Monetary credits require currency",
            path: ["currency"],
          });
        }
        if (data.billingVisible !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Monetary credits must be billing visible",
            path: ["billingVisible"],
          });
        }
        break;
    }
  });

const creditDefinitionUpdateSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  description: z.string().optional(),
  billingDescription: z.string().optional(),
  applicationType: creditApplicationTypeSchema.optional(),
  scope: creditScopeSchema.optional(),
  planId: z.string().nullable().optional(),
  featureId: z.string().nullable().optional(),
  featureSlug: z.string().nullable().optional(),
  priceId: z.string().nullable().optional(),
  priceComponentId: z.string().nullable().optional(),
  defaultAmount: z
    .number()
    .int()
    .positive("Default amount must be positive")
    .optional(),
  refillAmount: z
    .number()
    .int()
    .positive("Refill amount must be positive")
    .optional(),
  expiryDays: z
    .number()
    .int()
    .positive("Expiry days must be positive")
    .optional(),
  refillRrule: z.string().optional(),
  renewOnBilling: z.boolean().optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const creditGrantCreateSchema = z.object({
  customerId: z.string().min(1, "Customer ID is required"),
  creditDefinitionId: z.string().min(1, "Credit definition ID is required"),
  initialAmount: z
    .number()
    .int()
    .positive("Initial amount must be positive")
    .optional(),
  startDate: z.coerce.date().optional(),
  expiryDate: z.coerce.date().optional(),
  priority: z.number().int().optional(),
  source: creditGrantSourceSchema,
  referenceCode: z.string().optional(),
  notes: z.string().optional(),
});

const creditGrantRevokeSchema = z.object({
  notes: z.string().optional(),
});

// Parameter schemas
const idParamSchema = z.object({
  id: z.string(),
});

const customerIdParamSchema = z.object({
  customerId: z.string(),
});

const planIdParamSchema = z.object({
  planId: z.string(),
});

const featureIdParamSchema = z.object({
  featureId: z.string(),
});

// Query schemas
const statusQuerySchema = z.object({
  status: creditGrantStatusSchema.optional(),
});

const applicationTypeQuerySchema = z.object({
  applicationType: creditApplicationTypeSchema.optional(),
});

const limitQuerySchema = z.object({
  limit: z.coerce.number().int().positive().default(100),
});

const scopeQuerySchema = z.object({
  scope: creditScopeSchema.optional(),
});

export const creditsRouter = new Hono()
  // Credit Definitions endpoints
  .get(
    "/definitions",
    zValidator(
      "query",
      z.object({
        scope: creditScopeSchema.optional(),
        applicationType: creditApplicationTypeSchema.optional(),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { scope, applicationType } = c.req.valid("query");

      try {
        // Build filter conditions
        const conditions = [
          eq(creditDefinitions.merchantId, merchantId),
          isNull(creditDefinitions.deletedAt),
        ];

        if (scope) {
          conditions.push(eq(creditDefinitions.scope, scope));
        }

        if (applicationType) {
          conditions.push(
            eq(creditDefinitions.applicationType, applicationType)
          );
        }

        const definitions = await db.query.creditDefinitions.findMany({
          where: and(...conditions),
          orderBy: desc(creditDefinitions.createdAt),
        });

        return c.json({ definitions });
      } catch (error) {
        console.error("Error fetching credit definitions:", error);
        return c.json({ error: "Failed to fetch credit definitions" }, 500);
      }
    }
  )

  .get("/definitions/:id", zValidator("param", idParamSchema), async (c) => {
    const merchantId = c.get("merchant")!.id;
    const { id } = c.req.valid("param");

    try {
      const definition = await db.query.creditDefinitions.findFirst({
        where: and(
          eq(creditDefinitions.id, id),
          eq(creditDefinitions.merchantId, merchantId),
          isNull(creditDefinitions.deletedAt)
        ),
      });

      if (!definition) {
        return c.json({ error: "Credit definition not found" }, 404);
      }

      return c.json({ definition });
    } catch (error) {
      console.error("Error fetching credit definition:", error);
      return c.json({ error: "Failed to fetch credit definition" }, 500);
    }
  })

  .post(
    "/definitions",
    zValidator("json", creditDefinitionCreateSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const definitionData = c.req.valid("json");

      try {
        const definition = await createCreditDefinition({
          merchantId,
          ...definitionData,
        });

        return c.json({ definition }, 201);
      } catch (error) {
        console.error("Error creating credit definition:", error);
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to create credit definition",
          },
          500
        );
      }
    }
  )

  .post(
    "/definitions/:id/update",
    zValidator("param", idParamSchema),
    zValidator("json", creditDefinitionUpdateSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const { id } = c.req.valid("param");
      const updateData = c.req.valid("json");

      try {
        const updatedDefinition = await updateCreditDefinition({
          id,
          merchantId,
          ...updateData,
        });

        return c.json({ definition: updatedDefinition });
      } catch (error) {
        console.error("Error updating credit definition:", error);
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to update credit definition",
          },
          500
        );
      }
    }
  )

  .post(
    "/definitions/:id/delete",
    zValidator("param", idParamSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const { id } = c.req.valid("param");

      try {
        const deletedDefinition = await deleteCreditDefinition(id, merchantId);
        return c.json({ definition: deletedDefinition });
      } catch (error) {
        console.error("Error deleting credit definition:", error);
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to delete credit definition",
          },
          500
        );
      }
    }
  )

  // Plan-specific credit definitions
  .get(
    "/plans/:planId/definitions",
    zValidator("param", planIdParamSchema),
    zValidator("query", applicationTypeQuerySchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const { planId } = c.req.valid("param");
      const { applicationType } = c.req.valid("query");

      try {
        const conditions = [
          eq(creditDefinitions.merchantId, merchantId),
          eq(creditDefinitions.scope, "plan"),
          eq(creditDefinitions.planId, planId),
          isNull(creditDefinitions.deletedAt),
        ];

        if (applicationType) {
          conditions.push(
            eq(creditDefinitions.applicationType, applicationType)
          );
        }

        const definitions = await db.query.creditDefinitions.findMany({
          where: and(...conditions),
          orderBy: desc(creditDefinitions.createdAt),
        });

        return c.json({ definitions });
      } catch (error) {
        console.error("Error fetching plan credit definitions:", error);
        return c.json(
          { error: "Failed to fetch plan credit definitions" },
          500
        );
      }
    }
  )

  // Credit Grants endpoints
  .get(
    "/customers/:customerId/grants",
    zValidator("param", customerIdParamSchema),
    zValidator(
      "query",
      z.object({
        status: creditGrantStatusSchema.optional(),
        applicationType: creditApplicationTypeSchema.optional(),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const { customerId } = c.req.valid("param");
      const { status, applicationType } = c.req.valid("query");

      try {
        // Build query conditions
        const conditions = [
          eq(creditGrants.merchantId, merchantId),
          eq(creditGrants.customerId, customerId),
          isNull(creditGrants.deletedAt),
        ];

        if (status) {
          conditions.push(eq(creditGrants.status, status));
        }

        if (applicationType) {
          conditions.push(eq(creditGrants.applicationType, applicationType));
        }

        const grants = await db.query.creditGrants.findMany({
          where: and(...conditions),
          orderBy: [desc(creditGrants.createdAt)],
          with: {
            creditDefinition: true,
          },
        });

        return c.json({ grants });
      } catch (error) {
        console.error("Error fetching customer credit grants:", error);
        return c.json({ error: "Failed to fetch customer credit grants" }, 500);
      }
    }
  )

  .get(
    "/customers/:customerId/transactions",
    zValidator("param", customerIdParamSchema),
    zValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().positive().default(100),
        fromDate: z.string().datetime().optional(),
        toDate: z.string().datetime().optional(),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const { customerId } = c.req.valid("param");
      const { limit, fromDate, toDate } = c.req.valid("query");

      if (limit > 1000) {
        return c.json({ error: "Limit must be less than 1000" }, 400);
      }
      if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) {
        return c.json({ error: "From date must be before to date" }, 400);
      }

      try {
        const transactions = await getCustomerCreditUsage(
          merchantId,
          customerId,
          fromDate ? new Date(fromDate) : undefined,
          toDate ? new Date(toDate) : undefined,
          limit
        );
        return c.json({ transactions });
      } catch (error) {
        console.error("Error fetching customer credit usage:", error);
        return c.json({ error: "Failed to fetch customer credit usage" }, 500);
      }
    }
  )

  .post("/grants", zValidator("json", creditGrantCreateSchema), async (c) => {
    const merchantId = c.get("merchant")!.id;

    const grantData = c.req.valid("json");

    try {
      const grant = await createCreditGrant({
        merchantId,
        ...grantData,
      });

      return c.json({ grant }, 201);
    } catch (error) {
      console.error("Error creating credit grant:", error);
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to create credit grant",
        },
        500
      );
    }
  })

  .post(
    "/grants/:id/revoke",
    zValidator("param", idParamSchema),
    zValidator("json", creditGrantRevokeSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const { id } = c.req.valid("param");
      const { notes } = c.req.valid("json");

      try {
        // Find the grant first
        const grant = await db.query.creditGrants.findFirst({
          where: and(
            eq(creditGrants.id, id),
            eq(creditGrants.merchantId, merchantId),
            isNull(creditGrants.deletedAt)
          ),
        });

        if (!grant) {
          return c.json({ error: "Credit grant not found" }, 404);
        }

        // Update grant status to revoked
        const [revokedGrant] = await db
          .update(creditGrants)
          .set({
            status: "REVOKED",
            remainingAmount: 0,
            notes: notes
              ? `${grant.notes || ""} | Revoked: ${notes}`.trim()
              : grant.notes,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(creditGrants.id, id),
              eq(creditGrants.merchantId, merchantId),
              isNull(creditGrants.deletedAt)
            )
          )
          .returning();

        // Create credit transaction for audit trail (revoked event)
        if (grant.remainingAmount > 0) {
          console.log("Creating credit transaction for revoked event", {
            grantId: grant.id,
            remainingAmount: grant.remainingAmount,
          });

          await createCreditTransaction({
            merchantId,
            customerId: grant.customerId,
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
          });
        }

        return c.json({ grant: revokedGrant });
      } catch (error) {
        console.error("Error revoking credit grant:", error);
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to revoke credit grant",
          },
          500
        );
      }
    }
  )

  // Credit grants for a specific definition
  .get(
    "/definitions/:definitionId/grants",
    zValidator("param", z.object({ definitionId: z.string() })),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { definitionId } = c.req.valid("param");

      try {
        // Validate the definition exists and belongs to the merchant
        const definition = await db.query.creditDefinitions.findFirst({
          where: and(
            eq(creditDefinitions.id, definitionId),
            eq(creditDefinitions.merchantId, merchantId),
            isNull(creditDefinitions.deletedAt)
          ),
        });

        if (!definition) {
          return c.json({ error: "Credit definition not found" }, 404);
        }

        // Get grants for this definition
        const grants = await db.query.creditGrants.findMany({
          where: and(
            eq(creditGrants.merchantId, merchantId),
            eq(creditGrants.creditDefinitionId, definitionId),
            isNull(creditGrants.deletedAt)
          ),
          orderBy: desc(creditGrants.createdAt),
        });

        return c.json({ grants });
      } catch (error) {
        console.error("Error fetching grants for definition:", error);
        return c.json({ error: "Failed to fetch grants for definition" }, 500);
      }
    }
  )

  // Manual Credit Granting Endpoints
  // Get available credit definitions for a customer to extend existing credits
  .get(
    "/customers/:customerId/available-credit-definitions",
    zValidator("param", customerIdParamSchema),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { customerId } = c.req.valid("param");

      try {
        const availableDefinitions =
          await getAvailableCreditDefinitionsForCustomer(
            merchantId,
            customerId
          );

        return c.json({ availableDefinitions });
      } catch (error) {
        console.error("Error fetching available credit definitions:", error);
        return c.json(
          { error: "Failed to fetch available credit definitions" },
          500
        );
      }
    }
  )

  // Create manual credit grant
  .post(
    "/manual-grant",
    zValidator(
      "json",
      z
        .object({
          customerId: z.string().min(1, "Customer ID is required"),
          creditType: z.enum(["extend", "new"]),

          // For extending existing credits
          existingCreditDefinitionId: z.string().optional(),

          // For new credits
          newCreditConfig: z
            .object({
              applicationType: z.enum(["usage", "monetary"]),
              scope: z.enum(["component", "price", "plan", "merchant"]),
              featureId: z.string().optional(),
              planId: z.string().optional(),
              priceId: z.string().optional(),
              priceComponentId: z.string().optional(),
              currency: z.string().optional(),
              billingVisible: z.boolean().optional(),
              billingDescription: z.string().optional(),
              name: z.string().min(1, "Name is required"),
              description: z.string().optional(),
            })
            .optional(),

          // Common fields
          amount: z.number().int().positive("Amount must be positive"),
          expiryDate: z.coerce.date().optional(),
          notes: z.string().optional(),
        })
        .superRefine((data, ctx) => {
          console.log("=== Zod Validation Debug ===");
          console.log("Data being validated:", JSON.stringify(data, null, 2));

          // Validate credit type specific requirements
          if (
            data.creditType === "extend" &&
            !data.existingCreditDefinitionId
          ) {
            console.log(
              "Validation error: Credit definition ID required for extending credits"
            );
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Credit definition ID required for extending credits",
              path: ["existingCreditDefinitionId"],
            });
          }

          if (data.creditType === "new" && !data.newCreditConfig) {
            console.log(
              "Validation error: New credit configuration required for new credits"
            );
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "New credit configuration required for new credits",
              path: ["newCreditConfig"],
            });
          }

          // Validate amount limits if we have the credit type
          if (data.newCreditConfig) {
            try {
              console.log(
                "Validating credit amount:",
                data.newCreditConfig.applicationType,
                data.amount
              );
              validateCreditAmount(
                data.newCreditConfig.applicationType,
                data.amount
              );
            } catch (error) {
              console.log(
                "Validation error: Invalid amount",
                error instanceof Error ? error.message : error
              );
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  error instanceof Error ? error.message : "Invalid amount",
                path: ["amount"],
              });
            }
          }

          // For new monetary credits, require currency
          if (
            data.newCreditConfig?.applicationType === "monetary" &&
            !data.newCreditConfig.currency
          ) {
            console.log(
              "Validation error: Currency required for monetary credits"
            );
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Currency required for monetary credits",
              path: ["newCreditConfig", "currency"],
            });
          }

          // For plan-scoped credits, require plan ID
          if (
            data.newCreditConfig?.scope === "plan" &&
            !data.newCreditConfig.planId
          ) {
            console.log(
              "Validation error: Plan ID required for plan-scoped credits"
            );
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Plan ID required for plan-scoped credits",
              path: ["newCreditConfig", "planId"],
            });
          }

          console.log("=== End Zod Validation Debug ===");
        }),
      (result, c) => {
        console.log("=== Zod Validator Result Debug ===");
        if (!result.success) {
          console.log(
            "Validation failed. Errors:",
            JSON.stringify(result.error.errors, null, 2)
          );
          return c.json(
            {
              error: "Validation failed",
              details: result.error.errors.map((err) => ({
                path: err.path.join(" -> "),
                message: err.message,
                code: err.code,
              })),
            },
            400
          );
        }
        console.log(
          "Validation successful:",
          JSON.stringify(result.data, null, 2)
        );
        console.log("=== End Zod Validator Result Debug ===");
        return;
      }
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      console.log("=== Manual Credit Grant Request Debug ===");
      console.log("Merchant ID:", merchantId);

      // Get validated data
      const grantData = c.req.valid("json");
      console.log("Validated data:", JSON.stringify(grantData, null, 2));

      try {
        const { creditGrant, creditDefinition } = await createManualCreditGrant(
          {
            merchantId,
            ...grantData,
          }
        );

        return c.json(
          {
            creditGrant,
            creditDefinition,
            message: "Manual credit grant created successfully",
          },
          201
        );
      } catch (error) {
        console.error("Error creating manual credit grant:", error);
        console.error(
          "Error stack:",
          error instanceof Error ? error.stack : "No stack trace"
        );
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to create manual credit grant",
            details:
              error instanceof Error ? error.stack : "No additional details",
          },
          500
        );
      }
    }
  )

  // List manual credit grants for merchant
  .get(
    "/manual-grants",
    zValidator(
      "query",
      z.object({
        customerId: z.string().optional(),
        status: z.enum(["ACTIVE", "DEPLETED", "EXPIRED", "REVOKED"]).optional(),
        limit: z.coerce.number().int().positive().default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const { customerId, status, limit, offset } = c.req.valid("query");

      if (limit > 1000) {
        return c.json({ error: "Limit must be less than 1000" }, 400);
      }

      try {
        // Build filter conditions
        const conditions = [
          eq(creditGrants.merchantId, merchantId),
          eq(creditGrants.source, "manual"), // Only manual grants
          isNull(creditGrants.deletedAt),
        ];

        if (customerId) {
          conditions.push(eq(creditGrants.customerId, customerId));
        }

        if (status) {
          conditions.push(eq(creditGrants.status, status));
        }

        const manualGrants = await db.query.creditGrants.findMany({
          where: and(...conditions),
          orderBy: desc(creditGrants.createdAt),
          limit,
          offset,
          with: {
            creditDefinition: true,
            customer: true,
          },
        });

        // Get total count for pagination
        const totalCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(creditGrants)
          .where(and(...conditions));

        return c.json({
          manualGrants,
          pagination: {
            total: totalCount[0]?.count || 0,
            limit,
            offset,
            hasMore: (totalCount[0]?.count || 0) > offset + limit,
          },
        });
      } catch (error) {
        console.error("Error fetching manual credit grants:", error);
        return c.json({ error: "Failed to fetch manual credit grants" }, 500);
      }
    }
  )

  // Get credit limits for validation
  .get("/limits", async (c) => {
    return c.json({
      limits: MANUAL_CREDIT_LIMITS,
    });
  });

// Trigger-related endpoints for background jobs
export const triggerCreditsRouter = new Hono()
  // Process scheduled renewals based on RRULE configurations
  // Process grant-centric renewals (new efficient approach)
  .post(
    "/process-grant-renewals",
    zValidator(
      "json",
      z.object({
        timestamp: z.string().datetime(),
      })
    ),
    async (c) => {
      try {
        const { timestamp } = c.req.valid("json");
        const date = new Date(timestamp);

        console.info(
          `Processing grant-centric credit renewals as of ${date.toISOString()}`
        );
        const { renewalCount, errorCount } = await processGrantRenewals(date);

        return c.json({
          success: true,
          renewalCount,
          errorCount,
          timestamp: date.toISOString(),
        });
      } catch (error) {
        console.error("Error processing grant renewals:", error);
        return c.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to process grant renewals",
          },
          500
        );
      }
    }
  )

  // Process credit expirations
  .post(
    "/process-expirations",
    zValidator(
      "json",
      z.object({
        timestamp: z.string().datetime(),
      })
    ),
    async (c) => {
      try {
        const { timestamp } = c.req.valid("json");
        const date = new Date(timestamp);

        console.info(
          `Processing credit expirations as of ${date.toISOString()}`
        );
        const { expiredCount } = await processExpirations(date);

        return c.json({
          success: true,
          expiredCount,
          timestamp: date.toISOString(),
        });
      } catch (error) {
        console.error("Error processing credit expirations:", error);
        return c.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to process credit expirations",
          },
          500
        );
      }
    }
  )

  // Process renewals after invoice generation
  .post(
    "/renewal-after-invoice",
    zValidator(
      "json",
      z.object({
        merchantId: z.string(),
        customerId: z.string(),
      })
    ),
    async (c) => {
      try {
        const { merchantId, customerId } = c.req.valid("json");

        console.info(
          `Processing credit renewals after invoice for merchant ${merchantId}, customer ${customerId}`
        );

        const result = await processRenewalAfterInvoice(merchantId, customerId);

        return c.json({
          success: true,
          renewalCount: result.renewalCount,
          merchantId,
          customerId,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error("Error processing renewals after invoice:", error);
        return c.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to process renewals after invoice",
          },
          500
        );
      }
    }
  );
