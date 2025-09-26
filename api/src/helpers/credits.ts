import { RRule } from "rrule";
import { db } from "../db/client";
import {
  eq,
  and,
  isNull,
  lte,
  desc,
  asc,
  sql,
  sum,
  or,
  isNotNull,
  gte,
  inArray,
  ne,
  notInArray,
} from "drizzle-orm";
import {
  creditDefinitions,
  creditGrants,
  creditUsageTransactions,
  features,
  customers,
  prices,
  plans,
  subscriptions,
  CreditGrantSource,
  CreditApplicationType,
  creditDefinitionsInsertSchema,
  creditDefinitionsUpdateSchema,
} from "@lumen/common/schema";
import { TransactionType } from "./index";
import { z } from "zod";
import { calculateNextBillingDate } from "./billing-dates";
import { PriceComponentSchemaType } from "@lumen/common";

/**
 * Utility function to remove undefined values from an object
 */
function removeUndefinedValues<T extends Record<string, any>>(
  obj: T
): Partial<T> {
  return Object.entries(obj).reduce((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key as keyof T] = value;
    }
    return acc;
  }, {} as Partial<T>);
}

/**
 * Creates a credit transaction record for audit trail
 * This function should be called whenever credit grants are created, modified, or consumed
 */
export async function createCreditTransaction(
  params: {
    merchantId: string;
    customerId: string;
    creditGrantId: string;
    amount: number;
    applicationType: CreditApplicationType;
    eventName: "granted" | "revoked" | "expired" | "billing";
    eventTimestamp?: Date;
    featureId?: string;
    featureSlug?: string;
    priceId?: string;
    priceComponentId?: string;
    currency?: string;
    invoiceId?: string;
    billingSessionId?: string;
    notes?: string;
  },
  tx?: TransactionType
): Promise<typeof creditUsageTransactions.$inferSelect> {
  const db_tx = tx || db;

  console.log("Creating credit transaction", {
    merchantId: params.merchantId,
    customerId: params.customerId,
    creditGrantId: params.creditGrantId,
    amount: params.amount,
    eventName: params.eventName,
    applicationType: params.applicationType,
    inTransaction: !!tx,
  });

  const [transaction] = await db_tx
    .insert(creditUsageTransactions)
    .values({
      merchantId: params.merchantId,
      customerId: params.customerId,
      creditGrantId: params.creditGrantId,
      amount: params.amount,
      applicationType: params.applicationType,
      eventName: params.eventName,
      eventTimestamp: params.eventTimestamp || new Date(),
      featureId: params.featureId,
      featureSlug: params.featureSlug,
      priceId: params.priceId,
      priceComponentId: params.priceComponentId,
      currency: params.currency,
      invoiceId: params.invoiceId,
      billingSessionId: params.billingSessionId,
      transactionDate: new Date(),
    })
    .returning();

  console.log("Credit transaction created successfully", {
    transactionId: transaction.id,
    eventName: params.eventName,
    amount: params.amount,
    creditGrantId: params.creditGrantId,
  });

  return transaction;
}

/**
 * Validation schema for credit definitions
 */
const creditDefinitionValidationSchema = z
  .object({
    scope: z.enum(["plan", "merchant"]),
    applicationType: z.enum(["usage", "component", "monetary", "account"]),
    planId: z.string().nullable().optional(),
    featureId: z.string().nullable().optional(),
    featureSlug: z.string().nullable().optional(),
    priceId: z.string().nullable().optional(),
    priceComponentId: z.string().nullable().optional(),
    componentId: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    billingVisible: z.boolean().optional(),
  })
  .refine((data) => {
    // Scope validation
    if (data.scope === "plan" && !data.planId) {
      throw new Error("Plan-scoped credits require planId");
    }

    // Application type validation
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
          throw new Error(
            "Usage credits require either price linkage (priceId/priceComponentId) or feature linkage (featureId/featureSlug)"
          );
        }
        break;
      case "monetary":
        // All monetary credits need currency and must be billing visible
        if (!data.currency) {
          throw new Error("Monetary credits require currency");
        }
        if (data.billingVisible !== true) {
          throw new Error("Monetary credits must be billing visible");
        }

        // For plan-scoped monetary credits:
        // - If priceId is provided, this is a price-specific credit
        // - If priceId is null/undefined, this is a plan-level credit (applies to any price in the plan)
        // Both are valid for plan scope

        // Merchant-scoped monetary credits (account credits) should NOT have priceId
        if (data.scope === "merchant" && data.priceId) {
          throw new Error(
            "Merchant-scoped monetary credits should not have priceId (they are account-level credits)"
          );
        }
        break;
    }

    return true;
  });

/**
 * Enhanced credit definition creation with validation
 */
export async function createCreditDefinition(
  params: z.infer<typeof creditDefinitionsInsertSchema> & {
    merchantId: string;
  },
  tx?: TransactionType
) {
  console.log("Creating credit definition", {
    merchantId: params.merchantId,
    scope: params.scope,
    applicationType: params.applicationType,
    name: params.name,
    planId: params.planId,
    featureId: params.featureId,
    priceId: params.priceId,
  });

  // Validate the definition
  console.log("Validating credit definition schema");
  creditDefinitionValidationSchema.parse(params);
  console.log("Credit definition schema validation passed");

  const {
    merchantId,
    scope,
    applicationType,
    name,
    description,
    planId,
    featureId,
    featureSlug,
    priceId,
    priceComponentId,
    billingVisible = false,
    billingDescription,
    currency,
    defaultAmount,
    refillAmount,
    expiryDays,
    refillRrule,
    renewOnBilling = false,
    priority = 100,
  } = params;

  const db_tx = tx || db;

  // Validate referenced entities exist
  console.log("Validating referenced entities");
  if (planId) {
    console.log("Validating plan exists", { planId, merchantId });
    const planExists = await db_tx.query.plans.findFirst({
      where: and(
        eq(plans.id, planId),
        eq(plans.merchantId, merchantId),
        isNull(plans.deletedAt)
      ),
    });
    if (!planExists) {
      console.error("Plan not found", { planId, merchantId });
      throw new Error(
        `Plan with ID ${planId} not found for merchant ${merchantId}`
      );
    }
    console.log("Plan validation passed", { planId });
  }

  if (featureId) {
    console.log("Validating feature exists", { featureId, merchantId });
    const featureExists = await db_tx.query.features.findFirst({
      where: and(
        eq(features.id, featureId),
        eq(features.merchantId, merchantId),
        isNull(features.deletedAt)
      ),
    });
    if (!featureExists) {
      console.error("Feature not found", { featureId, merchantId });
      throw new Error(
        `Feature with ID ${featureId} not found for merchant ${merchantId}`
      );
    }
    console.log("Feature validation passed", { featureId });
  }

  if (priceId) {
    console.log("Validating price exists", { priceId, merchantId });
    const priceExists = await db_tx.query.prices.findFirst({
      where: and(
        eq(prices.id, priceId),
        eq(prices.merchantId, merchantId),
        isNull(prices.deletedAt)
      ),
    });
    if (!priceExists) {
      console.error("Price not found", { priceId, merchantId });
      throw new Error(
        `Price with ID ${priceId} not found for merchant ${merchantId}`
      );
    }
    console.log("Price validation passed", { priceId });
  }

  // Validate RRULE if provided
  if (refillRrule) {
    console.log("Validating RRULE", { refillRrule });
    try {
      // Check if RRULE contains TZID
      if (refillRrule.includes("TZID=")) {
        throw new Error("RRULE cannot contain TZID parameter");
      }
      RRule.parseString(refillRrule);
      console.log("RRULE validation passed");
    } catch (error) {
      console.error("RRULE validation failed", { refillRrule, error });
      throw new Error(`Invalid RRULE format: ${error}`);
    }
  }

  // Create the credit definition
  console.log("Creating credit definition in database", {
    merchantId,
    scope,
    applicationType,
    name,
    defaultAmount,
    refillAmount,
    priority,
  });

  const [creditDefinition] = await db_tx
    .insert(creditDefinitions)
    .values({
      merchantId,
      scope,
      applicationType,
      planId,
      featureId,
      featureSlug,
      priceId,
      priceComponentId,
      billingVisible,
      billingDescription,
      currency,
      name,
      description,
      defaultAmount,
      refillAmount,
      expiryDays,
      refillRrule,
      renewOnBilling,
      priority,
      isActive: true,
    })
    .returning();

  console.log("Credit definition created successfully", {
    id: creditDefinition.id,
    merchantId: creditDefinition.merchantId,
    name: creditDefinition.name,
    scope: creditDefinition.scope,
    applicationType: creditDefinition.applicationType,
  });

  return creditDefinition;
}

/**
 * Updates an existing credit definition
 */
export async function updateCreditDefinition(
  params: z.infer<typeof creditDefinitionsUpdateSchema> & {
    id: string;
    merchantId: string;
  }
) {
  const { id, merchantId, refillRrule, ...updateFields } = params;

  console.log("Updating credit definition", {
    id,
    merchantId,
    updateFields: Object.keys(updateFields),
    hasRefillRrule: !!refillRrule,
  });

  // Validate that the credit definition exists and belongs to the merchant
  console.log("Validating credit definition exists", { id, merchantId });
  const existingDefinition = await db.query.creditDefinitions.findFirst({
    where: and(
      eq(creditDefinitions.id, id),
      eq(creditDefinitions.merchantId, merchantId),
      isNull(creditDefinitions.deletedAt)
    ),
  });

  if (!existingDefinition) {
    console.error("Credit definition not found for update", { id, merchantId });
    throw new Error(
      `Credit definition with ID ${id} not found for merchant ${merchantId}`
    );
  }

  console.log("Credit definition found for update", {
    id: existingDefinition.id,
    name: existingDefinition.name,
    scope: existingDefinition.scope,
    applicationType: existingDefinition.applicationType,
  });

  // Validate RRULE if provided
  if (refillRrule) {
    console.log("Validating updated RRULE", { refillRrule });
    try {
      // Check if RRULE contains TZID
      if (refillRrule.includes("TZID=")) {
        throw new Error("RRULE cannot contain TZID parameter");
      }
      RRule.parseString(refillRrule);
      console.log("Updated RRULE validation passed");
    } catch (error) {
      console.error("Updated RRULE validation failed", { refillRrule, error });
      throw new Error(`Invalid RRULE format: ${error}`);
    }
  }

  // Filter out core fields that should not be updatable
  const {
    applicationType,
    scope,
    planId,
    featureId,
    featureSlug,
    priceId,
    priceComponentId: componentId,
    currency,
    ...allowedFields
  } = updateFields;

  console.log("Filtered out core fields from update", {
    filteredOutFields: [
      "applicationType",
      "scope",
      "planId",
      "featureId",
      "featureSlug",
      "priceId",
      "priceComponentId",
      "currency",
    ],
    allowedFields: Object.keys(allowedFields),
  });

  // Build update object with only allowed fields
  const updateValues = removeUndefinedValues({
    ...allowedFields,
    refillRrule,
    updatedAt: new Date(),
  });

  console.log("Updating credit definition in database", {
    id,
    updateValues: Object.keys(updateValues),
  });

  // Update the credit definition
  const [updatedDefinition] = await db
    .update(creditDefinitions)
    .set(updateValues)
    .where(
      and(
        eq(creditDefinitions.id, id),
        eq(creditDefinitions.merchantId, merchantId),
        isNull(creditDefinitions.deletedAt)
      )
    )
    .returning();

  console.log("Credit definition updated successfully", {
    id: updatedDefinition.id,
    name: updatedDefinition.name,
    updatedAt: updatedDefinition.updatedAt,
  });

  return updatedDefinition;
}

/**
 * Soft-deletes a credit definition
 */
export async function deleteCreditDefinition(id: string, merchantId: string) {
  console.log("Deleting credit definition", { id, merchantId });

  // Validate that the credit definition exists and belongs to the merchant
  console.log("Validating credit definition exists for deletion", {
    id,
    merchantId,
  });
  const existingDefinition = await db.query.creditDefinitions.findFirst({
    where: and(
      eq(creditDefinitions.id, id),
      eq(creditDefinitions.merchantId, merchantId),
      isNull(creditDefinitions.deletedAt)
    ),
  });

  if (!existingDefinition) {
    console.error("Credit definition not found for deletion", {
      id,
      merchantId,
    });
    throw new Error(
      `Credit definition with ID ${id} not found for merchant ${merchantId}`
    );
  }

  console.log("Credit definition found for deletion", {
    id: existingDefinition.id,
    name: existingDefinition.name,
    scope: existingDefinition.scope,
    applicationType: existingDefinition.applicationType,
  });

  // Soft delete the credit definition
  console.log("Performing soft delete on credit definition", { id });
  const [deletedDefinition] = await db
    .update(creditDefinitions)
    .set({
      deletedAt: new Date(),
      isActive: false,
    })
    .where(
      and(
        eq(creditDefinitions.id, id),
        eq(creditDefinitions.merchantId, merchantId),
        isNull(creditDefinitions.deletedAt)
      )
    )
    .returning();

  console.log("Credit definition deleted successfully", {
    id: deletedDefinition.id,
    name: deletedDefinition.name,
    deletedAt: deletedDefinition.deletedAt,
    isActive: deletedDefinition.isActive,
  });

  return deletedDefinition;
}

/**
 * Enhanced credit grant creation with inherited configuration
 */
export async function createCreditGrant(
  params: {
    merchantId: string;
    customerId: string;
    creditDefinitionId: string;
    initialAmount?: number;
    startDate?: Date;
    expiryDate?: Date;
    priority?: number;
    source: CreditGrantSource;
    referenceCode?: string;
    notes?: string;
  },
  tx?: TransactionType
) {
  const {
    merchantId,
    customerId,
    creditDefinitionId,
    initialAmount,
    startDate = new Date(),
    expiryDate,
    priority,
    source,
    referenceCode,
    notes,
  } = params;

  console.log("Creating credit grant", {
    merchantId,
    customerId,
    creditDefinitionId,
    initialAmount,
    source,
    hasExpiryDate: !!expiryDate,
    referenceCode,
    inTransaction: !!tx,
  });

  const db_tx = tx || db;

  // Get the credit definition to inherit configuration
  console.log("Fetching credit definition for grant", {
    creditDefinitionId,
    merchantId,
  });
  const definition = await db_tx.query.creditDefinitions.findFirst({
    where: and(
      eq(creditDefinitions.id, creditDefinitionId),
      eq(creditDefinitions.merchantId, merchantId),
      isNull(creditDefinitions.deletedAt)
    ),
  });

  if (!definition) {
    console.error("Credit definition not found for grant", {
      creditDefinitionId,
      merchantId,
    });
    throw new Error(
      `Credit definition with ID ${creditDefinitionId} not found for merchant ${merchantId}`
    );
  }

  console.log("Credit definition found for grant", {
    id: definition.id,
    name: definition.name,
    applicationType: definition.applicationType,
    scope: definition.scope,
    defaultAmount: definition.defaultAmount,
    expiryDays: definition.expiryDays,
  });

  // Validate customer exists
  console.log("Validating customer exists for grant", {
    customerId,
    merchantId,
  });
  const customerExists = await db_tx.query.customers.findFirst({
    where: and(
      eq(customers.id, customerId),
      eq(customers.merchantId, merchantId),
      isNull(customers.deletedAt)
    ),
  });

  if (!customerExists) {
    console.error("Customer not found for grant", { customerId, merchantId });
    throw new Error(
      `Customer with ID ${customerId} not found for merchant ${merchantId}`
    );
  }

  console.log("Customer validation passed for grant", { customerId });

  // Calculate final values
  const finalAmount = initialAmount ?? definition.defaultAmount;
  let finalExpiryDate = expiryDate;
  if (!finalExpiryDate && definition.expiryDays && definition.expiryDays > 0) {
    // expiryDays == -1 and renewOnBilling true means expire credits at billing
    // this is not used with the Grant, but with the CreditDefinition at Billing Time
    finalExpiryDate = new Date();
    finalExpiryDate.setDate(finalExpiryDate.getDate() + definition.expiryDays);
  }

  console.log("Calculated final grant values", {
    finalAmount,
    finalExpiryDate,
    usedDefaultAmount: initialAmount === undefined,
    calculatedExpiry: !expiryDate && !!definition.expiryDays,
  });

  // Create the credit grant with inherited configuration
  console.log("Creating credit grant in database", {
    merchantId,
    customerId,
    creditDefinitionId,
    applicationType: definition.applicationType,
    finalAmount,
    priority: priority ?? definition.priority,
    source,
  });

  // Calculate renewal scheduling if definition has RRULE and renewOnBilling is false
  // All grants get renewal scheduling - this enables "baton passing" between grants
  let nextRenewalDate: Date | null = null;
  let renewalRrule: string | null = null;

  if (
    definition.refillRrule &&
    !definition.renewOnBilling &&
    definition.refillAmount
  ) {
    console.log("Setting up renewal scheduling for grant", {
      creditDefinitionId,
      refillRrule: definition.refillRrule,
      renewOnBilling: definition.renewOnBilling,
      refillAmount: definition.refillAmount,
      source,
    });

    // Store the RRULE on the grant for efficient processing
    renewalRrule = definition.refillRrule;

    // Calculate the next renewal date based on the grant start date
    nextRenewalDate = calculateNextRenewalDate(
      definition.refillRrule,
      startDate, // Use start date as base for renewal calculation
      startDate,
      "UTC"
    );

    console.log("Calculated renewal date", {
      creditDefinitionId,
      startDate,
      nextRenewalDate,
      renewalRrule,
      refillAmount: definition.refillAmount,
      source,
    });
  } else if (definition.renewOnBilling) {
    console.log("Grant will use billing-based renewals", {
      creditDefinitionId,
      renewOnBilling: definition.renewOnBilling,
      source,
    });
  } else {
    console.log("No renewal schedule configured for grant", {
      creditDefinitionId,
      hasRefillRrule: !!definition.refillRrule,
      hasRefillAmount: !!definition.refillAmount,
      renewOnBilling: definition.renewOnBilling,
      source,
      reason: !definition.refillRrule
        ? "No RRULE defined"
        : definition.renewOnBilling
          ? "Uses billing-based renewals"
          : !definition.refillAmount
            ? "No refill amount defined"
            : "Unknown",
    });
  }

  const [creditGrant] = await db_tx
    .insert(creditGrants)
    .values({
      merchantId,
      customerId,
      creditDefinitionId,
      applicationType: definition.applicationType,
      featureId: definition.featureId,
      featureSlug: definition.featureSlug,
      priceId: definition.priceId,
      priceComponentId: definition.priceComponentId,
      currency: definition.currency,
      billingVisible: definition.billingVisible,
      initialAmount: finalAmount,
      remainingAmount: finalAmount,
      startDate,
      expiryDate: finalExpiryDate,
      // Renewal scheduling fields
      nextRenewalDate,
      renewalRrule,
      lastRenewalDate: null,
      priority: priority ?? definition.priority,
      status: "ACTIVE" as const,
      source,
      referenceCode,
      notes,
      scope: definition.scope,
      planId: definition.planId,
    })
    .returning();

  console.log("Credit grant created successfully", {
    id: creditGrant.id,
    merchantId: creditGrant.merchantId,
    customerId: creditGrant.customerId,
    applicationType: creditGrant.applicationType,
    initialAmount: creditGrant.initialAmount,
    remainingAmount: creditGrant.remainingAmount,
    source: creditGrant.source,
  });

  // Create credit transaction for audit trail (granted event)
  console.log("Creating credit transaction for granted event", {
    creditGrantId: creditGrant.id,
    amount: finalAmount,
    applicationType: definition.applicationType,
  });

  await createCreditTransaction(
    {
      merchantId,
      customerId,
      creditGrantId: creditGrant.id,
      amount: finalAmount,
      applicationType: definition.applicationType,
      eventName: "granted",
      eventTimestamp: startDate,
      featureId: definition.featureId || undefined,
      featureSlug: definition.featureSlug || undefined,
      priceId: definition.priceId || undefined,
      priceComponentId: definition.priceComponentId || undefined,
      currency: definition.currency || undefined,
    },
    tx
  );

  return creditGrant;
}

/**
 * Gets active monetary credits for billing application
 * These are price-level monetary credits (no component ID specified)
 */
export async function getActiveMonetaryCredits(
  customerId: string,
  priceId: string,
  tx?: TransactionType
) {
  const db_tx = tx || db;

  return await db_tx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.customerId, customerId),
      eq(creditGrants.applicationType, "monetary"),
      eq(creditGrants.priceId, priceId),
      isNull(creditGrants.priceComponentId), // Price-only monetary credits
      or(
        gte(creditGrants.expiryDate, new Date()),
        isNull(creditGrants.expiryDate)
      ),
      lte(creditGrants.startDate, new Date()),
      isNull(creditGrants.deletedAt)
    ),
    orderBy: [asc(creditGrants.priority), asc(creditGrants.startDate)],
    with: {
      creditDefinition: true,
    },
  });
}

/**
 * Gets active component-specific monetary credits for billing application
 * These are monetary credits tied to a specific price and component
 */
export async function getActiveComponentMonetaryCredits(
  customerId: string,
  priceId: string,
  componentId: string,
  tx: TransactionType
) {
  return await tx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.customerId, customerId),
      eq(creditGrants.applicationType, "monetary"),
      eq(creditGrants.priceId, priceId),
      eq(creditGrants.priceComponentId, componentId),
      or(
        gte(creditGrants.expiryDate, new Date()),
        isNull(creditGrants.expiryDate)
      ),
      lte(creditGrants.startDate, new Date()),
      isNull(creditGrants.deletedAt)
    ),
    orderBy: [asc(creditGrants.priority), asc(creditGrants.startDate)],
    with: {
      creditDefinition: true,
    },
  });
}

/**
 * Gets active plan-level monetary credits for billing application
 * These are monetary credits that apply to any component within a specific plan
 */
export async function getActivePlanLevelCredits(
  customerId: string,
  planId: string,
  tx: TransactionType
) {
  return await tx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.customerId, customerId),
      eq(creditGrants.applicationType, "monetary"),
      eq(creditGrants.planId, planId),
      eq(creditGrants.scope, "plan"),
      isNull(creditGrants.priceId), // Not tied to specific price
      isNull(creditGrants.priceComponentId), // Not tied to specific component
      or(
        gte(creditGrants.expiryDate, new Date()),
        isNull(creditGrants.expiryDate)
      ),
      lte(creditGrants.startDate, new Date()),
      isNull(creditGrants.deletedAt)
    ),
    orderBy: [asc(creditGrants.priority), asc(creditGrants.startDate)],
    with: {
      creditDefinition: true,
    },
  });
}

/**
 * Gets active merchant-level account credits for billing application
 * These are monetary credits that can be used on any billing (scope == "merchant")
 */
export async function getActiveMerchantLevelCredits(
  customerId: string,
  merchantId: string,
  tx: TransactionType
) {
  return await tx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.customerId, customerId),
      eq(creditGrants.merchantId, merchantId),
      eq(creditGrants.applicationType, "monetary"),
      eq(creditGrants.scope, "merchant"),
      isNull(creditGrants.priceId), // Not tied to specific price
      isNull(creditGrants.priceComponentId), // Not tied to specific component
      or(
        gte(creditGrants.expiryDate, new Date()),
        isNull(creditGrants.expiryDate)
      ),
      lte(creditGrants.startDate, new Date()),
      isNull(creditGrants.deletedAt)
    ),
    orderBy: [asc(creditGrants.priority), asc(creditGrants.startDate)],
    with: {
      creditDefinition: true,
    },
  });
}

/**
 * Applies monetary credits to remaining amount for a price
 * Updates grants and creates audit trail transactions
 */
export async function applyMonetaryCredits(
  grants: (typeof creditGrants.$inferSelect)[],
  remainingAmountCents: number,
  context: {
    merchantId: string;
    customerId: string;
    invoiceId?: string;
    billingSessionId?: string;
  },
  tx: TransactionType
): Promise<number> {
  let remainingAmount = remainingAmountCents;
  let totalApplied = 0;
  const usageTransactions = [];
  const grantsToUpdate = [];

  for (const grant of grants) {
    if (remainingAmount <= 0) break;
    if (grant.remainingAmount <= 0) continue;

    // Calculate how much credit can be applied
    const creditAmountCentsDeducted = Math.min(
      remainingAmount,
      grant.remainingAmount
    );

    // Record usage transaction for audit trail
    usageTransactions.push({
      merchantId: context.merchantId,
      customerId: context.customerId,
      creditGrantId: grant.id,
      amount: creditAmountCentsDeducted,
      applicationType: "monetary" as const,
      eventName: "billing",
      eventTimestamp: new Date(),
      priceId: grant.priceId,
      priceComponentId: grant.priceComponentId, // May be null for price-level credits
      invoiceId: context.invoiceId,
      billingSessionId: context.billingSessionId,
      currency: grant.currency,
      transactionDate: new Date(),
    });

    // Prepare grant update
    const newRemainingAmount =
      grant.remainingAmount - creditAmountCentsDeducted;
    grantsToUpdate.push({
      grantId: grant.id,
      newRemainingAmount,
      newStatus: newRemainingAmount <= 0 ? "DEPLETED" : grant.status,
    });

    remainingAmount -= creditAmountCentsDeducted;
    totalApplied += creditAmountCentsDeducted;
  }

  // Insert usage transactions for audit trail
  if (usageTransactions.length > 0) {
    await tx.insert(creditUsageTransactions).values(usageTransactions);
  }

  // Update credit grants with new remaining amounts
  for (const update of grantsToUpdate) {
    await tx
      .update(creditGrants)
      .set({
        remainingAmount: update.newRemainingAmount,
        status: update.newStatus,
        updatedAt: new Date(),
      })
      .where(eq(creditGrants.id, update.grantId));
  }

  return totalApplied;
}

/**
 * Applies plan-level credits to remaining amount for an invoice
 * Updates grants and creates audit trail transactions
 */
export async function applyPlanLevelCredits(
  grants: (typeof creditGrants.$inferSelect)[],
  remainingAmountCents: number,
  context: {
    merchantId: string;
    customerId: string;
    invoiceId?: string;
    billingSessionId?: string;
  },
  tx: TransactionType
): Promise<number> {
  let remainingAmount = remainingAmountCents;
  let totalApplied = 0;
  const usageTransactions = [];
  const grantsToUpdate = [];

  for (const grant of grants) {
    if (remainingAmount <= 0) break;
    if (grant.remainingAmount <= 0) continue;

    // Calculate how much credit can be applied
    const creditAmountCents = Math.min(remainingAmount, grant.remainingAmount);
    const newRemainingAmount = grant.remainingAmount - creditAmountCents;

    // Record usage transaction for audit trail
    usageTransactions.push({
      merchantId: context.merchantId,
      customerId: context.customerId,
      creditGrantId: grant.id,
      amount: creditAmountCents,
      applicationType: "monetary" as const,
      eventName: "billing",
      eventTimestamp: new Date(),
      priceId: null, // Plan-level credits don't target specific prices
      priceComponentId: null, // Plan-level credits don't target specific components
      invoiceId: context.invoiceId,
      billingSessionId: context.billingSessionId,
      currency: grant.currency,
      transactionDate: new Date(),
    });

    // Prepare grant update
    grantsToUpdate.push({
      grantId: grant.id,
      newRemainingAmount,
      newStatus: newRemainingAmount <= 0 ? "DEPLETED" : grant.status,
    });

    remainingAmount -= creditAmountCents;
    totalApplied += creditAmountCents;
  }

  // Insert usage transactions for audit trail
  if (usageTransactions.length > 0) {
    await tx.insert(creditUsageTransactions).values(usageTransactions);
  }

  // Update credit grants with new remaining amounts
  for (const update of grantsToUpdate) {
    await tx
      .update(creditGrants)
      .set({
        remainingAmount: update.newRemainingAmount,
        status: update.newStatus,
        updatedAt: new Date(),
      })
      .where(eq(creditGrants.id, update.grantId));
  }

  return totalApplied;
}

/**
 * Applies merchant-level account credits as final fallback
 * Updates grants and creates audit trail transactions
 */
export async function applyMerchantLevelCredits(
  grants: (typeof creditGrants.$inferSelect)[],
  totalAmountCents: number,
  context: {
    merchantId: string;
    customerId: string;
    invoiceId?: string;
    billingSessionId?: string;
  },
  tx: TransactionType
): Promise<number> {
  let remainingAmount = totalAmountCents;
  let totalApplied = 0;
  const usageTransactions = [];
  const grantsToUpdate = [];

  for (const grant of grants) {
    if (remainingAmount <= 0) break;
    if (grant.remainingAmount <= 0) continue;

    // Calculate how much credit can be applied
    const creditAmountCents = Math.min(remainingAmount, grant.remainingAmount);
    const newRemainingAmount = grant.remainingAmount - creditAmountCents;

    // Record usage transaction for audit trail
    usageTransactions.push({
      merchantId: context.merchantId,
      customerId: context.customerId,
      creditGrantId: grant.id,
      amount: creditAmountCents,
      applicationType: "monetary" as const,
      eventName: "billing",
      eventTimestamp: new Date(),
      priceId: null, // Merchant-level credits don't target specific prices
      priceComponentId: null, // Merchant-level credits don't target specific components
      invoiceId: context.invoiceId,
      billingSessionId: context.billingSessionId,
      currency: grant.currency,
      transactionDate: new Date(),
    });

    // Prepare grant update
    grantsToUpdate.push({
      grantId: grant.id,
      newRemainingAmount,
      newStatus: newRemainingAmount <= 0 ? "DEPLETED" : grant.status,
    });

    remainingAmount -= creditAmountCents;
    totalApplied += creditAmountCents;
  }

  // Insert usage transactions for audit trail
  if (usageTransactions.length > 0) {
    await tx.insert(creditUsageTransactions).values(usageTransactions);
  }

  // Update credit grants with new remaining amounts
  for (const update of grantsToUpdate) {
    await tx
      .update(creditGrants)
      .set({
        remainingAmount: update.newRemainingAmount,
        status: update.newStatus,
        updatedAt: new Date(),
      })
      .where(eq(creditGrants.id, update.grantId));
  }

  return totalApplied;
}

/**
 * Background job function for processing expirations
 */
export async function processExpirations(timestamp: Date = new Date()) {
  console.log("Starting credit expiration processing", { timestamp });

  try {
    // Find all grants that have expired
    const expiredGrants = await db.query.creditGrants.findMany({
      where: and(
        lte(creditGrants.expiryDate, timestamp),
        isNull(creditGrants.deletedAt),
        // Avoid re-processing grants already marked as expired or revoked
        notInArray(creditGrants.status, ["EXPIRED", "REVOKED"])
      ),
    });

    let expiredCount = 0;
    const featuresToUpdate = new Set<string>();

    // Process expired grants
    for (const grant of expiredGrants) {
      console.log("Expiring credit grant", {
        grantId: grant.id,
        remainingAmount: grant.remainingAmount,
        merchantId: grant.merchantId,
        customerId: grant.customerId,
        applicationType: grant.applicationType,
      });

      await db
        .update(creditGrants)
        .set({
          status: "EXPIRED",
          updatedAt: new Date(),
        })
        .where(eq(creditGrants.id, grant.id));

      // Create credit transaction for audit trail (expired event)
      if (grant.remainingAmount > 0) {
        console.log("Creating credit transaction for expired event", {
          grantId: grant.id,
          remainingAmount: grant.remainingAmount,
        });

        await createCreditTransaction({
          merchantId: grant.merchantId,
          customerId: grant.customerId,
          creditGrantId: grant.id,
          amount: grant.remainingAmount,
          applicationType: grant.applicationType,
          eventName: "expired",
          eventTimestamp: timestamp,
          featureId: grant.featureId || undefined,
          featureSlug: grant.featureSlug || undefined,
          priceId: grant.priceId || undefined,
          priceComponentId: grant.priceComponentId || undefined,
          currency: grant.currency || undefined,
        });
      }

      // Track features that need balance updates
      if (grant.applicationType === "usage" && grant.featureId) {
        featuresToUpdate.add(
          `${grant.merchantId}:${grant.customerId}:${grant.featureId}`
        );
      }

      expiredCount++;
    }

    console.log("Completed credit expiration processing", {
      expiredCount,
      balanceUpdates: featuresToUpdate.size,
      timestamp,
    });

    return { expiredCount, timestamp };
  } catch (error) {
    console.error("Error in processExpirations", error);
    throw error;
  }
}

/**
 * Process initial credit grants when a subscription is created
 * This creates grants for all active credit definitions associated with the plan
 */
export async function processInitialCreditsForSubscription(
  merchantId: string,
  customerId: string,
  planId: string,
  subscriptionId: string,
  tx?: TransactionType,
  isRenewal: boolean = false
) {
  const db_tx = tx || db;
  console.log("Processing initial credits for subscription", {
    merchantId,
    customerId,
    planId,
    subscriptionId,
    isRenewal,
  });

  // Fetch subscription to determine which price is actually in effect
  const subscriptionRecord = await db_tx.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.id, subscriptionId),
      eq(subscriptions.merchantId, merchantId),
      isNull(subscriptions.deletedAt)
    ),
    columns: {
      effectivePriceId: true,
    },
  });

  console.log("Subscription record", subscriptionRecord);

  const effectivePriceId = subscriptionRecord?.effectivePriceId || null;

  // Get all active credit definitions scoped to this plan that either:
  // – have no priceId (plan-level credits)
  // – or match the subscription's effective priceId
  console.log("Querying credit definitions with values", {
    merchantId,
    planId,
    effectivePriceId,
    scope: "plan",
    isActive: true,
    deletedAt: null,
    priceIdFilter: effectivePriceId ? { or: [null, effectivePriceId] } : null,
  });
  const creditDefs = await db_tx.query.creditDefinitions.findMany({
    where: and(
      eq(creditDefinitions.merchantId, merchantId),
      eq(creditDefinitions.scope, "plan"),
      eq(creditDefinitions.planId, planId),
      eq(creditDefinitions.isActive, true),
      isNull(creditDefinitions.deletedAt),
      effectivePriceId
        ? or(
            isNull(creditDefinitions.priceId),
            eq(creditDefinitions.priceId, effectivePriceId)
          )
        : isNull(creditDefinitions.priceId)
    ),
  });

  console.log(
    `Found ${creditDefs.length} credit definitions for plan ${planId}`
  );

  let grantCount = 0;
  const errors: string[] = [];

  for (const definition of creditDefs) {
    try {
      // Use refillAmount for renewals (migrations), defaultAmount for new subscriptions
      const grantAmount = isRenewal
        ? definition.refillAmount || definition.defaultAmount
        : definition.defaultAmount;

      const grantSource = isRenewal ? "refill" : "subscription";
      const grantNotes = isRenewal
        ? `Renewal grant for subscription ${subscriptionId} (migration)`
        : `Initial grant for subscription ${subscriptionId}`;

      await createCreditGrant(
        {
          merchantId,
          customerId,
          creditDefinitionId: definition.id,
          initialAmount: grantAmount,
          source: grantSource,
          notes: grantNotes,
        },
        tx
      );
      grantCount++;

      console.log(
        `Created ${isRenewal ? "renewal" : "initial"} credit grant for definition ${definition.id} (${definition.name}) with amount ${grantAmount}`
      );
    } catch (error) {
      const errorMsg = `Failed to create grant for definition ${definition.id}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }
  }

  console.log(
    `Created ${grantCount} initial credit grants for subscription ${subscriptionId}`,
    errors.length > 0 ? { errors } : {}
  );

  return { grantCount, errors };
}

/**
 * Process renewal after invoice generation for billing-triggered renewals
 */
export async function processRenewalAfterInvoice(
  merchantId: string,
  customerId: string,
  tx?: TransactionType
) {
  console.log(`[processRenewalAfterInvoice] Starting renewal process`, {
    merchantId,
    customerId,
  });

  const db_tx = tx || db;

  // Get customer and their active subscriptions separately to avoid relation issues
  const customer = await db_tx.query.customers.findFirst({
    where: and(
      eq(customers.id, customerId),
      eq(customers.merchantId, merchantId)
    ),
  });

  if (!customer) {
    console.log(`[processRenewalAfterInvoice] Customer not found`, {
      merchantId,
      customerId,
    });
    return { renewalCount: 0 };
  }

  // Get customer's active subscriptions (those without endTimestamp)
  const eligibleSubscriptions = await db_tx.query.subscriptions.findMany({
    where: and(
      eq(subscriptions.customerId, customerId),
      eq(subscriptions.merchantId, merchantId),
      isNull(subscriptions.endTimestamp), // Active subscriptions have no end timestamp
      isNull(subscriptions.deletedAt)
    ),
  });

  console.log(`[processRenewalAfterInvoice] Found eligible subscriptions`, {
    customerId,
    subscriptionCount: eligibleSubscriptions.length,
    planIds: eligibleSubscriptions.map((sub) => sub.planId),
  });

  const planIds = eligibleSubscriptions.map((sub) => sub.planId);
  if (planIds.length === 0) {
    console.log(`[processRenewalAfterInvoice] No eligible plans found`, {
      customerId,
    });
    return { renewalCount: 0 };
  }

  // Get billing-triggered definitions for customer's subscriptions (filtered by effective price)
  let renewalDefinitions: (typeof creditDefinitions.$inferSelect)[] = [];
  const processedDefinitionIds = new Set<string>(); // Avoid duplicates

  if (eligibleSubscriptions.length > 0) {
    // Query definitions for each subscription separately to filter by effectivePriceId
    for (const subscription of eligibleSubscriptions) {
      // First get ALL credit definitions for this plan to see filtering in action
      const allPlanDefs = await db_tx.query.creditDefinitions.findMany({
        where: and(
          eq(creditDefinitions.merchantId, merchantId),
          eq(creditDefinitions.renewOnBilling, true),
          eq(creditDefinitions.isActive, true),
          eq(creditDefinitions.planId, subscription.planId),
          isNull(creditDefinitions.deletedAt)
        ),
      });

      // Then filter by price matching logic
      const defs = await db_tx.query.creditDefinitions.findMany({
        where: and(
          eq(creditDefinitions.merchantId, merchantId),
          eq(creditDefinitions.renewOnBilling, true),
          eq(creditDefinitions.isActive, true),
          eq(creditDefinitions.planId, subscription.planId),
          or(
            isNull(creditDefinitions.priceId),
            eq(creditDefinitions.priceId, subscription.effectivePriceId)
          ),
          isNull(creditDefinitions.deletedAt)
        ),
      });

      console.log(
        `[processRenewalAfterInvoice] Credit definition filtering for subscription ${subscription.id}:`,
        {
          allPlanDefs: allPlanDefs.map((d) => ({
            id: d.id,
            name: d.name,
            priceId: d.priceId || "NULL",
          })),
          afterPriceFilter: defs.map((d) => ({
            id: d.id,
            name: d.name,
            priceId: d.priceId || "NULL",
          })),
          subscriptionEffectivePrice: subscription.effectivePriceId,
        }
      );

      // Only add definitions we haven't processed yet
      const newDefs = defs.filter((d) => !processedDefinitionIds.has(d.id));
      renewalDefinitions.push(...newDefs);
      newDefs.forEach((d) => processedDefinitionIds.add(d.id));

      console.log(
        `[processRenewalAfterInvoice] Found credit definitions for subscription`,
        {
          subscriptionId: subscription.id,
          planId: subscription.planId,
          effectivePriceId: subscription.effectivePriceId,
          definitionCount: newDefs.length,
          definitionIds: newDefs.map((d) => d.id),
          skippedDuplicates: defs.length - newDefs.length,
        }
      );
    }
  }

  // Create renewal grants
  let renewalCount = 0;
  let expiredCount = 0;

  // Detect if any active subscription for this customer is on a seat-based plan
  const seatBasedPlanIds = new Set<string>();
  console.log(
    `[processRenewalAfterInvoice] Detecting seat-based plans for ${eligibleSubscriptions.length} subscriptions`
  );

  for (const sub of eligibleSubscriptions) {
    const plan = await db_tx.query.plans.findFirst({
      where: eq(plans.id, sub.planId),
    });
    const price = await db_tx.query.prices.findFirst({
      where: eq(prices.id, sub.effectivePriceId),
    });

    console.log(
      `[processRenewalAfterInvoice] Checking subscription ${sub.id}:`,
      {
        planId: sub.planId,
        effectivePriceId: sub.effectivePriceId,
        priceComponents: price?.pricingData?.components?.map((c: any) => ({
          type: c.type,
          num_seats: c.num_seats,
        })),
      }
    );

    const hasSeatPerUnit = Array.isArray(price?.pricingData?.components)
      ? price!.pricingData.components.some((c: any) => c.type === "per_unit")
      : false;

    console.log(
      `[processRenewalAfterInvoice] Plan ${sub.planId} is seat-based: ${hasSeatPerUnit}`
    );

    if (hasSeatPerUnit) seatBasedPlanIds.add(sub.planId);
  }

  console.log(
    `[processRenewalAfterInvoice] Detected ${seatBasedPlanIds.size} seat-based plans:`,
    Array.from(seatBasedPlanIds)
  );
  console.log(
    `[processRenewalAfterInvoice] Processing ${renewalDefinitions.length} renewal definitions:`,
    renewalDefinitions.map((d) => ({
      id: d.id,
      name: d.name,
      planId: d.planId,
      expiryDays: d.expiryDays,
    }))
  );

  for (const definition of renewalDefinitions) {
    console.log(
      `[processRenewalAfterInvoice] ===== Processing definition ${definition.id} (${definition.name}) for plan ${definition.planId} =====`
    );
    // Check if this definition should expire old credits with billing cycle
    if (definition.expiryDays === -1) {
      console.log(
        `[processRenewalAfterInvoice] Expiring old credits before renewal`,
        {
          customerId,
          creditDefinitionId: definition.id,
          definitionName: definition.name,
        }
      );

      // Find and expire all existing active grants for this definition and customer (primary)
      const existingGrants = await db_tx.query.creditGrants.findMany({
        where: and(
          eq(creditGrants.merchantId, merchantId),
          eq(creditGrants.customerId, customerId),
          eq(creditGrants.creditDefinitionId, definition.id),
          isNull(creditGrants.deletedAt),
          isNull(creditGrants.expiryDate), // Only expire grants with no fixed expiry
          eq(creditGrants.status, "ACTIVE")
        ),
      });

      console.log(
        `[processRenewalAfterInvoice] Found existing grants to expire`,
        {
          customerId,
          creditDefinitionId: definition.id,
          existingGrantCount: existingGrants.length,
          existingGrantIds: existingGrants.map((g) => g.id),
        }
      );

      // Expire each existing grant
      for (const grant of existingGrants) {
        if (grant.remainingAmount > 0) {
          // Create expiry transaction for audit trail
          await createCreditTransaction(
            {
              merchantId,
              customerId,
              creditGrantId: grant.id,
              amount: grant.remainingAmount,
              applicationType: grant.applicationType,
              eventName: "expired",
              eventTimestamp: new Date(),
              featureId: grant.featureId || undefined,
              featureSlug: grant.featureSlug || undefined,
              priceId: grant.priceId || undefined,
              priceComponentId: grant.priceComponentId || undefined,
              currency: grant.currency || undefined,
              notes: "Expired with billing cycle",
            },
            tx
          );
        }

        // Mark grant as expired
        await db_tx
          .update(creditGrants)
          .set({
            status: "EXPIRED",
            updatedAt: new Date(),
          })
          .where(eq(creditGrants.id, grant.id));

        expiredCount++;
      }

      // If seat-based: also expire existing active grants for all org members
      if (seatBasedPlanIds.has(definition.planId!)) {
        console.log(
          `[processRenewalAfterInvoice] Processing seat-based expiry for definition ${definition.id}`
        );

        const primary = await db_tx.query.customers.findFirst({
          where: and(
            eq(customers.id, customerId),
            eq(customers.merchantId, merchantId)
          ),
        });

        console.log(`[processRenewalAfterInvoice] Primary customer org info:`, {
          customerId: primary?.id,
          customerOrganizationId: primary?.customerOrganizationId,
          orgRole: primary?.orgRole,
        });

        const orgId = primary?.customerOrganizationId || null;
        if (orgId) {
          const members = await db_tx.query.customers.findMany({
            where: and(
              eq(customers.merchantId, merchantId),
              eq(customers.customerOrganizationId, orgId),
              isNull(customers.deletedAt)
            ),
          });

          console.log(
            `[processRenewalAfterInvoice] Found ${members.length} org members for expiry:`,
            members.map((m) => ({
              id: m.id,
              role: m.orgRole,
              externalId: m.externalCustomerId,
            }))
          );

          for (const member of members) {
            if (member.id === customerId) {
              console.log(
                `[processRenewalAfterInvoice] Skipping primary customer ${member.id} in member expiry (already handled)`
              );
              continue; // already handled primary above
            }

            const memberGrants = await db_tx.query.creditGrants.findMany({
              where: and(
                eq(creditGrants.merchantId, merchantId),
                eq(creditGrants.customerId, member.id),
                eq(creditGrants.creditDefinitionId, definition.id),
                isNull(creditGrants.deletedAt),
                isNull(creditGrants.expiryDate),
                eq(creditGrants.status, "ACTIVE")
              ),
            });

            console.log(
              `[processRenewalAfterInvoice] Found ${memberGrants.length} grants to expire for member ${member.id}`,
              memberGrants.map((g) => ({
                id: g.id,
                remaining: g.remainingAmount,
              }))
            );

            for (const mGrant of memberGrants) {
              if (mGrant.remainingAmount > 0) {
                await createCreditTransaction(
                  {
                    merchantId,
                    customerId: member.id,
                    creditGrantId: mGrant.id,
                    amount: mGrant.remainingAmount,
                    applicationType: mGrant.applicationType,
                    eventName: "expired",
                    eventTimestamp: new Date(),
                    featureId: mGrant.featureId || undefined,
                    featureSlug: mGrant.featureSlug || undefined,
                    priceId: mGrant.priceId || undefined,
                    priceComponentId: mGrant.priceComponentId || undefined,
                    currency: mGrant.currency || undefined,
                    notes: "Expired with billing cycle (seat member)",
                  },
                  tx
                );
              }
              await db_tx
                .update(creditGrants)
                .set({ status: "EXPIRED", updatedAt: new Date() })
                .where(eq(creditGrants.id, mGrant.id));
              expiredCount++;

              console.log(
                `[processRenewalAfterInvoice] Expired grant ${mGrant.id} for member ${member.id}`
              );
            }
          }
        } else {
          console.log(
            `[processRenewalAfterInvoice] No organization ID found for primary customer ${customerId}`
          );
        }
      }
    }

    // Create new grant(s)
    const isSeatBasedForThisDef = seatBasedPlanIds.has(definition.planId!);
    console.log(
      `[processRenewalAfterInvoice] Creating renewal grants for definition ${definition.id} (${definition.name}), seat-based: ${isSeatBasedForThisDef}`
    );

    if (isSeatBasedForThisDef) {
      // Fan out to all organization members
      const primary = await db_tx.query.customers.findFirst({
        where: and(
          eq(customers.id, customerId),
          eq(customers.merchantId, merchantId)
        ),
      });

      console.log(
        `[processRenewalAfterInvoice] Primary customer for renewal:`,
        {
          customerId: primary?.id,
          customerOrganizationId: primary?.customerOrganizationId,
          orgRole: primary?.orgRole,
        }
      );

      const orgId = primary?.customerOrganizationId || null;
      if (orgId) {
        const members = await db_tx.query.customers.findMany({
          where: and(
            eq(customers.merchantId, merchantId),
            eq(customers.customerOrganizationId, orgId),
            isNull(customers.deletedAt)
          ),
        });

        console.log(
          `[processRenewalAfterInvoice] Found ${members.length} org members for renewal:`,
          members.map((m) => ({
            id: m.id,
            role: m.orgRole,
            externalId: m.externalCustomerId,
          }))
        );

        for (const member of members) {
          console.log(
            `[processRenewalAfterInvoice] Creating renewal grant for member ${member.id} (role: ${member.orgRole})`
          );

          await createCreditGrant(
            {
              merchantId,
              customerId: member.id,
              creditDefinitionId: definition.id,
              initialAmount:
                definition.refillAmount || definition.defaultAmount,
              source: "refill",
              notes: `Billing cycle renewal for ${member.orgRole === "primary" ? "primary customer" : "seat member"} ${member.id}`,
            },
            tx
          );
          renewalCount++;

          console.log(
            `[processRenewalAfterInvoice] Created renewal grant for member ${member.id}`
          );
        }
      } else {
        console.log(
          `[processRenewalAfterInvoice] No org ID found, falling back to primary customer only`
        );

        // Fallback to just the primary
        await createCreditGrant(
          {
            merchantId,
            customerId,
            creditDefinitionId: definition.id,
            initialAmount: definition.refillAmount || definition.defaultAmount,
            source: "refill",
            notes: "Billing cycle renewal (no org)",
          },
          tx
        );
        renewalCount++;
      }
    } else {
      console.log(
        `[processRenewalAfterInvoice] Creating single renewal grant for non-seat plan, customer ${customerId}`
      );

      await createCreditGrant(
        {
          merchantId,
          customerId,
          creditDefinitionId: definition.id,
          initialAmount: definition.refillAmount || definition.defaultAmount,
          source: "refill",
          notes: "Billing cycle renewal",
        },
        tx
      );
      renewalCount++;
    }
  }

  console.log(`[processRenewalAfterInvoice] Completed renewal process`, {
    customerId,
    renewalCount,
    expiredCount,
    totalDefinitions: renewalDefinitions.length,
  });

  return { renewalCount, expiredCount };
}

/**
 * Apply usage credits during billing to create audit trail transactions
 * This function creates usage transaction records for audit purposes only
 * Credits remain static - grants are NOT modified
 * Returns the amount of credits applied as offset
 */
export async function applyUsageCreditsForBilling(
  params: {
    merchantId: string;
    customerId: string;
    priceId: string;
    componentId: string;
    amount: number;
    invoiceId?: string | null;
    billingSessionId?: string;
    billingPeriodStart: Date;
    billingPeriodEnd: Date;
  },
  tx: TransactionType
): Promise<number> {
  const {
    merchantId,
    customerId,
    priceId,
    componentId,
    amount,
    invoiceId,
    billingSessionId,
    billingPeriodStart,
    billingPeriodEnd,
  } = params;

  console.log("Applying usage credits for billing", {
    merchantId,
    customerId,
    priceId,
    componentId,
    amount,
    invoiceId,
    billingSessionId,
    billingPeriodStart,
    billingPeriodEnd,
  });

  if (amount <= 0) {
    console.log("No amount to consume, returning 0", { amount });
    return 0; // Nothing to consume
  }

  // Get active usage credit grants for this price component, ordered by priority and age
  console.log("Fetching active usage credit grants", {
    merchantId,
    customerId,
    priceId,
    componentId,
  });

  const activeGrants = await tx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.merchantId, merchantId),
      eq(creditGrants.customerId, customerId),
      eq(creditGrants.priceId, priceId),
      eq(creditGrants.priceComponentId, componentId),
      eq(creditGrants.applicationType, "usage"),
      or(
        gte(creditGrants.expiryDate, new Date()),
        isNull(creditGrants.expiryDate)
      ),
      lte(creditGrants.startDate, new Date()),
      isNull(creditGrants.deletedAt)
    ),
    orderBy: [
      asc(creditGrants.priority), // Lower priority number = higher priority
      asc(creditGrants.createdAt), // Older grants consumed first
    ],
  });

  console.log("Found active usage credit grants", {
    grantCount: activeGrants.length,
    grantIds: activeGrants.map((g) => g.id),
    totalRemainingAmount: activeGrants.reduce(
      (sum, g) => sum + g.remainingAmount,
      0
    ),
  });

  if (activeGrants.length === 0) {
    console.log("No active usage credit grants found, returning 0");
    return 0; // No credits to consume
  }

  let remainingToConsume = amount;
  let totalConsumed = 0;
  const usageTransactions = [];
  const grantsToUpdate = [];

  console.log("Starting usage credit consumption loop", {
    remainingToConsume,
    grantCount: activeGrants.length,
  });

  // Calculate how much can be consumed from each grant and prepare updates
  for (const grant of activeGrants) {
    if (remainingToConsume <= 0) {
      console.log("No remaining amount to consume, breaking loop", {
        grantId: grant.id,
        totalConsumed,
      });
      break;
    }

    const availableInGrant = grant.remainingAmount; // Use remaining grant amount
    if (availableInGrant <= 0) {
      console.log("Grant has no available amount, skipping", {
        grantId: grant.id,
        availableInGrant,
      });
      continue;
    }

    const consumeFromGrant = Math.min(remainingToConsume, availableInGrant);
    const newRemainingAmount = availableInGrant - consumeFromGrant;

    console.log("Consuming usage credits from grant", {
      grantId: grant.id,
      availableInGrant,
      remainingToConsume,
      consumeFromGrant,
      newRemainingAmount,
    });

    // Create usage transaction record (for audit trail)
    usageTransactions.push({
      merchantId,
      customerId,
      creditGrantId: grant.id,
      amount: consumeFromGrant,
      applicationType: "usage" as const,
      eventName: "billing",
      eventTimestamp: billingPeriodEnd,
      featureId: grant.featureId,
      featureSlug: grant.featureSlug,
      priceId: grant.priceId,
      priceComponentId: grant.priceComponentId,
      invoiceId: invoiceId || null,
      billingSessionId,
      currency: null, // Usage credits don't have currency
      transactionDate: new Date(),
    });

    // Prepare grant update
    grantsToUpdate.push({
      grantId: grant.id,
      newRemainingAmount,
      newStatus: newRemainingAmount <= 0 ? "DEPLETED" : grant.status,
    });

    totalConsumed += consumeFromGrant;
    remainingToConsume -= consumeFromGrant;
  }

  console.log("Completed usage credit consumption loop", {
    totalConsumed,
    remainingToConsume,
    usageTransactions: usageTransactions.length,
    grantsToUpdate: grantsToUpdate.length,
  });

  // Insert usage transactions for audit trail
  if (usageTransactions.length > 0) {
    await tx.insert(creditUsageTransactions).values(usageTransactions);
  }

  // Update credit grants with new remaining amounts
  for (const update of grantsToUpdate) {
    await tx
      .update(creditGrants)
      .set({
        remainingAmount: update.newRemainingAmount,
        status: update.newStatus,
        updatedAt: new Date(),
      })
      .where(eq(creditGrants.id, update.grantId));
  }

  console.log(
    `Applied ${totalConsumed} usage credits during billing for price component ${componentId}`,
    {
      merchantId,
      customerId,
      priceId,
      componentId,
      invoiceId,
      requestedAmount: amount,
      appliedAmount: totalConsumed,
      remainingUnconsumed: amount - totalConsumed,
      grantsProcessed: activeGrants.length,
      grantsUpdated: grantsToUpdate.length,
      transactionsCreated: usageTransactions.length,
    }
  );

  return totalConsumed;
}

/**
 * Update all credit transactions with the actual invoice ID using billing session ID
 * Called after invoice creation to complete the audit trail
 */
export async function updateCreditTransactionsWithInvoiceId(
  billingSessionId: string,
  invoiceId: string,
  tx: TransactionType
) {
  // Update all credit transactions for this billing session that don't have invoice IDs
  const result = await tx
    .update(creditUsageTransactions)
    .set({
      invoiceId: invoiceId,
    })
    .where(
      and(
        eq(creditUsageTransactions.billingSessionId, billingSessionId),
        isNull(creditUsageTransactions.invoiceId)
      )
    )
    .returning({ id: creditUsageTransactions.id });

  console.log(
    `Updated ${result.length} credit transactions with invoice ID ${invoiceId}`,
    {
      billingSessionId,
      invoiceId,
      transactionCount: result.length,
    }
  );
}

/**
 * Get credit allowance summary for a specific feature and customer
 * This function aggregates all active usage credits for the feature using efficient database aggregation
 */
export async function getCreditAllowanceForFeature(
  merchantId: string,
  customerId: string,
  featureSlug: string,
  tx?: TransactionType
): Promise<{
  activeCredits: number;
  nextExpiryDate: Date | null;
  nextExpiryAmount: number;
}> {
  const db_tx = tx || db;

  console.log("Getting credit allowance for feature", {
    merchantId,
    customerId,
    featureSlug,
  });

  try {
    const now = new Date();

    // Use database aggregation for better performance
    const creditSummary = await db_tx
      .select({
        totalCredits: sum(creditGrants.remainingAmount),
        minExpiryDate: sql<Date | null>`MIN(${creditGrants.expiryDate})`,
      })
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.merchantId, merchantId),
          eq(creditGrants.customerId, customerId),
          eq(creditGrants.featureSlug, featureSlug),
          eq(creditGrants.applicationType, "usage"),
          eq(creditGrants.status, "ACTIVE"), // Only count active grants
          or(
            gte(creditGrants.expiryDate, now),
            isNull(creditGrants.expiryDate)
          ),
          lte(creditGrants.startDate, now),
          isNull(creditGrants.deletedAt)
        )
      );

    const result = creditSummary[0];
    const totalActiveCredits = result?.totalCredits
      ? Number(result.totalCredits)
      : 0;
    const nextExpiryDate = result?.minExpiryDate || null;

    // For now, set nextExpiryAmount to 0 since calculating it requires a second query
    // This can be enhanced later if needed
    let nextExpiryAmount = 0;

    console.log("Credit allowance calculation complete", {
      featureSlug,
      totalActiveCredits,
      nextExpiryDate,
      nextExpiryAmount,
    });

    return {
      activeCredits: totalActiveCredits,
      nextExpiryDate,
      nextExpiryAmount,
    };
  } catch (error) {
    console.error("Error fetching credit allowance:", error);
    // Return safe defaults on error
    return {
      activeCredits: 0,
      nextExpiryDate: null,
      nextExpiryAmount: 0,
    };
  }
}

/**
 * Calculate next renewal date for a credit grant using the same logic as billing
 * This reuses the sophisticated date calculation from calculateNextBillingDate
 */
export function calculateNextRenewalDate(
  refillRrule: string,
  lastRenewalDate: Date,
  grantStartDate: Date,
  timezone: string = "UTC"
): Date | null {
  try {
    // Create a mock component object with the RRULE for calculateNextBillingDate
    const mockComponent = {
      recurrence_rule: refillRrule,
    } as PriceComponentSchemaType;

    // Use the same logic as billing: last renewal date as current timestamp,
    // grant start date as subscription start for anniversary calculations
    const nextDate = calculateNextBillingDate(
      mockComponent,
      lastRenewalDate, // Current timestamp (when we last renewed or started)
      grantStartDate, // Subscription start (grant start for anniversary logic)
      timezone
    );

    return nextDate;
  } catch (error) {
    console.error("Error calculating next renewal date", {
      refillRrule,
      lastRenewalDate,
      grantStartDate,
      timezone,
      error,
    });
    return null;
  }
}

/**
 * New grant-centric renewal processing - processes individual grants due for renewal
 */
export async function processGrantRenewals(timestamp: Date = new Date()) {
  console.log("Starting grant-centric credit renewals", { timestamp });

  let renewalCount = 0;
  let errorCount = 0;

  try {
    // Query grants that are due for renewal using the efficient index
    // Only pick up grants that haven't been renewed yet (baton passing logic)
    console.log("Fetching credit grants due for renewal");
    const grantsForRenewal = await db.query.creditGrants.findMany({
      where: and(
        lte(creditGrants.nextRenewalDate, timestamp),
        isNull(creditGrants.deletedAt),
        // Only process grants that have renewal schedules and haven't been renewed yet
        isNotNull(creditGrants.nextRenewalDate),
        isNotNull(creditGrants.renewalRrule),
        isNull(creditGrants.lastRenewalDate) // Key: only pick up grants that haven't been renewed
      ),
      with: {
        creditDefinition: true,
        customer: true,
      },
    });

    console.log("Found grants due for renewal", {
      grantCount: grantsForRenewal.length,
      grantIds: grantsForRenewal.map((g) => g.id),
    });

    // Process each grant individually
    for (const grant of grantsForRenewal) {
      try {
        console.log("Processing renewal for grant", {
          grantId: grant.id,
          customerId: grant.customerId,
          creditDefinitionId: grant.creditDefinitionId,
          nextRenewalDate: grant.nextRenewalDate,
        });

        await processIndividualGrantRenewal(grant, timestamp);
        renewalCount++;
      } catch (error) {
        console.error("Error processing renewal for individual grant", {
          grantId: grant.id,
          customerId: grant.customerId,
          error,
        });
        errorCount++;
      }
    }

    console.log("Completed grant-centric credit renewals", {
      renewalCount,
      errorCount,
      timestamp,
    });

    return { renewalCount, errorCount, timestamp };
  } catch (error) {
    console.error("Error in processGrantRenewals", error);
    throw error;
  }
}

/**
 * Process renewal for a single credit grant
 */
async function processIndividualGrantRenewal(
  grant: typeof creditGrants.$inferSelect & {
    creditDefinition: typeof creditDefinitions.$inferSelect;
    customer: typeof customers.$inferSelect;
  },
  timestamp: Date
) {
  console.log("Processing individual grant renewal", {
    grantId: grant.id,
    customerId: grant.customerId,
    definitionId: grant.creditDefinitionId,
    renewalRrule: grant.renewalRrule,
  });

  // Verify the credit definition is still active
  if (
    !grant.creditDefinition ||
    !grant.creditDefinition.isActive ||
    grant.creditDefinition.deletedAt
  ) {
    console.log("Skipping renewal - credit definition inactive or deleted", {
      grantId: grant.id,
      definitionId: grant.creditDefinitionId,
    });
    return;
  }

  // For plan-scoped credits, verify customer still has active subscription
  if (grant.scope === "plan" && grant.planId) {
    const activeSubscription = await db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.customerId, grant.customerId),
        eq(subscriptions.planId, grant.planId),
        isNull(subscriptions.endTimestamp), // Active subscriptions have no end timestamp
        isNull(subscriptions.deletedAt)
      ),
    });

    if (!activeSubscription) {
      console.log(
        "Skipping renewal - customer no longer has active subscription to plan",
        {
          grantId: grant.id,
          customerId: grant.customerId,
          planId: grant.planId,
        }
      );

      // Clear the next renewal date since customer is no longer eligible
      await db
        .update(creditGrants)
        .set({
          nextRenewalDate: null,
          updatedAt: new Date(),
        })
        .where(eq(creditGrants.id, grant.id));

      return;
    }
  }

  if (!grant.creditDefinition.refillAmount) {
    console.log("Skipping renewal - credit definition has no refill amount", {
      grantId: grant.id,
      definitionId: grant.creditDefinitionId,
    });
    return;
  }

  // Check if this definition should expire old credits before renewal (like billing-based expiry)
  if (grant.creditDefinition.expiryDays === -1) {
    console.log(
      `[processIndividualGrantRenewal] Expiring old credits before renewal`,
      {
        customerId: grant.customerId,
        creditDefinitionId: grant.creditDefinitionId,
        definitionName: grant.creditDefinition.name,
      }
    );

    // Find and expire all existing active grants for this definition and customer (excluding the current one)
    const existingGrants = await db.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.merchantId, grant.merchantId),
        eq(creditGrants.customerId, grant.customerId),
        eq(creditGrants.creditDefinitionId, grant.creditDefinitionId),
        isNull(creditGrants.deletedAt),
        isNull(creditGrants.expiryDate), // Only expire grants with no fixed expiry
        eq(creditGrants.status, "ACTIVE"),
        ne(creditGrants.id, grant.id) // Don't expire the current grant that's triggering renewal
      ),
    });

    console.log(
      `[processIndividualGrantRenewal] Found existing grants to expire`,
      {
        customerId: grant.customerId,
        creditDefinitionId: grant.creditDefinitionId,
        existingGrantCount: existingGrants.length,
        existingGrantIds: existingGrants.map((g) => g.id),
      }
    );

    // Expire each existing grant
    for (const existingGrant of existingGrants) {
      if (existingGrant.remainingAmount > 0) {
        // Create expiry transaction for audit trail
        await createCreditTransaction({
          merchantId: grant.merchantId,
          customerId: grant.customerId,
          creditGrantId: existingGrant.id,
          amount: existingGrant.remainingAmount,
          applicationType: existingGrant.applicationType,
          eventName: "expired",
          eventTimestamp: timestamp,
          featureId: existingGrant.featureId || undefined,
          featureSlug: existingGrant.featureSlug || undefined,
          priceId: existingGrant.priceId || undefined,
          priceComponentId: existingGrant.priceComponentId || undefined,
          currency: existingGrant.currency || undefined,
          notes: "Expired with RRULE renewal cycle",
        });
      }

      // Mark grant as expired
      await db
        .update(creditGrants)
        .set({
          status: "EXPIRED",
          updatedAt: new Date(),
        })
        .where(eq(creditGrants.id, existingGrant.id));

      console.log(`[processIndividualGrantRenewal] Expired grant`, {
        expiredGrantId: existingGrant.id,
        remainingAmount: existingGrant.remainingAmount,
      });
    }
  }

  // Create the renewal grant
  const renewalAmount = grant.creditDefinition.refillAmount;

  console.log("Creating renewal grant", {
    grantId: grant.id,
    customerId: grant.customerId,
    renewalAmount,
  });

  await createCreditGrant({
    merchantId: grant.merchantId,
    customerId: grant.customerId,
    creditDefinitionId: grant.creditDefinitionId,
    initialAmount: renewalAmount,
    source: "refill",
    notes: `Scheduled renewal from grant ${grant.id} at ${timestamp.toISOString()}`,
  });

  // BATON PASSING: Mark the original grant as "done" - it has triggered its one renewal
  // The newly created grant (which has its own nextRenewalDate) will be the next one to renew
  console.log("Implementing baton passing - marking original grant as done", {
    grantId: grant.id,
    currentRenewalDate: grant.nextRenewalDate,
  });

  // Update the original grant: mark as renewed and clear nextRenewalDate so it's never picked up again
  await db
    .update(creditGrants)
    .set({
      lastRenewalDate: timestamp, // Mark when this grant triggered its renewal
      nextRenewalDate: null, // Clear so it's never picked up for renewal again
      updatedAt: new Date(),
    })
    .where(eq(creditGrants.id, grant.id));

  console.log("Processed individual grant renewal successfully", {
    grantId: grant.id,
    customerId: grant.customerId,
    originalGrantMarkedAsDone: true,
    newGrantWillHandleNextRenewal: true,
  });
}

/**
 * Get credit usage transactions for a customer with optional date filtering
 * Returns transactions ordered by most recent first
 */
export async function getCustomerCreditUsage(
  merchantId: string,
  customerId: string,
  fromDate?: Date,
  toDate?: Date,
  limit: number = 100
): Promise<any[]> {
  console.log("Getting customer credit usage", {
    merchantId,
    customerId,
    fromDate,
    toDate,
    limit,
  });

  const conditions = [
    eq(creditUsageTransactions.merchantId, merchantId),
    eq(creditUsageTransactions.customerId, customerId),
  ];

  if (fromDate) {
    conditions.push(gte(creditUsageTransactions.createdAt, fromDate));
  }

  if (toDate) {
    conditions.push(lte(creditUsageTransactions.createdAt, toDate));
  }

  const transactions = await db.query.creditUsageTransactions.findMany({
    where: and(...conditions),
    orderBy: [desc(creditUsageTransactions.createdAt)],
    limit,
    with: {
      creditGrant: {
        with: {
          creditDefinition: true,
        },
      },
    },
  });

  console.log("Found credit usage transactions", {
    merchantId,
    customerId,
    transactionCount: transactions.length,
  });

  return transactions;
}

/**
 * Manual Credit Granting System
 * Implementation of manual credit granting as per RFC: rfc/credit-ui.md
 */

// Types for manual credit granting
export interface AvailableCreditDefinition {
  id: string;
  name: string;
  description: string | null;
  applicationType: CreditApplicationType;
  featureSlug: string | null;
  source: "plan" | "manual";
  currency: string | null;
  currentGrants: Array<{
    id: string;
    remainingAmount: number;
    initialAmount: number;
    expiryDate: string | null;
    status: string;
  }>;
}

export interface NewCreditConfig {
  applicationType: CreditApplicationType;
  scope: "component" | "price" | "plan" | "merchant";
  featureId?: string;
  planId?: string;
  priceId?: string;
  priceComponentId?: string;
  currency?: string;
  billingVisible?: boolean;
  billingDescription?: string;
  name: string;
  description?: string;
}

// Validation limits for manual credit granting
export const MANUAL_CREDIT_LIMITS = {
  MIN_USAGE_AMOUNT: 1,
  MAX_USAGE_AMOUNT: 1_000_000, // 1 million units
  MIN_MONETARY_AMOUNT_CENTS: 100, // $1.00
  MAX_MONETARY_AMOUNT_CENTS: 100_000_00, // $100,000.00
} as const;

/**
 * Validates credit amount based on application type
 */
export function validateCreditAmount(
  applicationType: CreditApplicationType,
  amount: number
): void {
  if (applicationType === "usage") {
    if (
      amount < MANUAL_CREDIT_LIMITS.MIN_USAGE_AMOUNT ||
      amount > MANUAL_CREDIT_LIMITS.MAX_USAGE_AMOUNT
    ) {
      throw new Error(
        `Usage credit amount must be between ${MANUAL_CREDIT_LIMITS.MIN_USAGE_AMOUNT} and ${MANUAL_CREDIT_LIMITS.MAX_USAGE_AMOUNT}`
      );
    }
  } else if (applicationType === "monetary") {
    if (
      amount < MANUAL_CREDIT_LIMITS.MIN_MONETARY_AMOUNT_CENTS ||
      amount > MANUAL_CREDIT_LIMITS.MAX_MONETARY_AMOUNT_CENTS
    ) {
      throw new Error(
        `Monetary credit amount must be between $${MANUAL_CREDIT_LIMITS.MIN_MONETARY_AMOUNT_CENTS / 100} and $${MANUAL_CREDIT_LIMITS.MAX_MONETARY_AMOUNT_CENTS / 100}`
      );
    }
  }
}

/**
 * Get available credit definitions for a customer to extend existing credits
 * Returns credit definitions from customer's active subscription plans with current grant status
 */
export async function getAvailableCreditDefinitionsForCustomer(
  merchantId: string,
  customerId: string,
  tx?: TransactionType
): Promise<AvailableCreditDefinition[]> {
  const db_tx = tx || db;

  console.log("Getting available credit definitions for customer", {
    merchantId,
    customerId,
  });

  try {
    // 1. Get customer's active subscriptions
    const activeSubscriptions = await db_tx.query.subscriptions.findMany({
      where: and(
        eq(subscriptions.customerId, customerId),
        eq(subscriptions.merchantId, merchantId),
        isNull(subscriptions.endTimestamp), // Active subscriptions have no end timestamp
        isNull(subscriptions.deletedAt)
      ),
      with: {
        plan: true,
      },
    });

    console.log("Found active subscriptions", {
      customerId,
      subscriptionCount: activeSubscriptions.length,
      planIds: activeSubscriptions.map((sub) => sub.planId),
    });

    if (activeSubscriptions.length === 0) {
      console.log("No active subscriptions found for customer", { customerId });
      return [];
    }

    // 2. Get credit definitions for customer's plans
    const planIds = activeSubscriptions.map((sub) => sub.planId);
    const planCreditDefinitions = await db_tx.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.merchantId, merchantId),
        eq(creditDefinitions.scope, "plan"),
        inArray(creditDefinitions.planId, planIds),
        eq(creditDefinitions.isActive, true),
        isNull(creditDefinitions.deletedAt)
      ),
      orderBy: [asc(creditDefinitions.name)],
    });

    console.log("Found credit definitions for customer's plans", {
      customerId,
      definitionCount: planCreditDefinitions.length,
      definitionIds: planCreditDefinitions.map((def) => def.id),
    });

    // 3. Get manual credit definitions that were previously created for this customer
    // These are definitions with source="manual" from existing grants
    const existingManualGrants = await db_tx.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.merchantId, merchantId),
        eq(creditGrants.source, "manual"),
        isNull(creditGrants.deletedAt)
      ),
      with: {
        creditDefinition: true,
      },
    });

    // Extract unique manual credit definitions
    const manualCreditDefinitions = existingManualGrants
      .map((grant) => grant.creditDefinition)
      .filter(
        (def, index, self) =>
          def &&
          def.isActive &&
          !def.deletedAt &&
          self.findIndex((d) => d && d.id === def.id) === index
      );

    console.log("Found manual credit definitions for customer", {
      customerId,
      manualDefinitionCount: manualCreditDefinitions.length,
      manualDefinitionIds: manualCreditDefinitions.map((def) => def?.id),
    });

    // 4. Combine both plan and manual credit definitions
    const creditDefinitionsList = [
      ...planCreditDefinitions,
      ...(manualCreditDefinitions.filter(
        (def) => def
      ) as (typeof creditDefinitions.$inferSelect)[]),
    ];

    console.log("Combined credit definitions", {
      customerId,
      totalDefinitionCount: creditDefinitionsList.length,
      planDefinitions: planCreditDefinitions.length,
      manualDefinitions: manualCreditDefinitions.length,
    });

    if (creditDefinitionsList.length === 0) {
      console.log("No credit definitions found for customer", {
        customerId,
        planIds,
      });
      return [];
    }

    // 5. Get existing grants for these definitions
    const existingGrants = await db_tx.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.merchantId, merchantId),
        inArray(
          creditGrants.creditDefinitionId,
          creditDefinitionsList.map((def) => def.id)
        ),
        isNull(creditGrants.deletedAt)
      ),
      orderBy: [desc(creditGrants.createdAt)],
    });

    console.log("Found existing grants for definitions", {
      customerId,
      grantsCount: existingGrants.length,
    });

    // 6. Combine and return available definitions with current grant status
    const availableDefinitions: AvailableCreditDefinition[] =
      creditDefinitionsList.map((def) => {
        // Determine source type based on whether it's from plan or manual
        const isManual = manualCreditDefinitions.some(
          (manualDef) => manualDef?.id === def.id
        );

        return {
          id: def.id,
          name: def.name,
          description: def.description,
          applicationType: def.applicationType,
          featureSlug: def.featureSlug,
          source: isManual ? "manual" : "plan",
          currency: def.currency,
          currentGrants: existingGrants
            .filter((grant) => grant.creditDefinitionId === def.id)
            .map((grant) => ({
              id: grant.id,
              remainingAmount: grant.remainingAmount,
              initialAmount: grant.initialAmount,
              expiryDate: grant.expiryDate?.toISOString() || null,
              status: grant.status,
            })),
        };
      });

    console.log("Returning available credit definitions", {
      customerId,
      availableDefinitionsCount: availableDefinitions.length,
    });

    return availableDefinitions;
  } catch (error) {
    console.error("Error getting available credit definitions for customer", {
      merchantId,
      customerId,
      error,
    });
    throw error;
  }
}

/**
 * Create a manual credit definition for new credits not tied to existing plans
 * These definitions are created on-the-fly and don't have renewal configuration
 */
export async function createManualCreditDefinition(
  params: {
    merchantId: string;
    applicationType: CreditApplicationType;
    scope: "component" | "price" | "plan" | "merchant";
    name: string;
    description?: string;
    planId?: string;
    featureId?: string;
    featureSlug?: string;
    priceId?: string;
    priceComponentId?: string;
    currency?: string;
    billingVisible?: boolean;
    billingDescription?: string;
    defaultAmount: number;
  },
  tx?: TransactionType
): Promise<typeof creditDefinitions.$inferSelect> {
  console.log("Creating manual credit definition", {
    merchantId: params.merchantId,
    applicationType: params.applicationType,
    scope: params.scope,
    name: params.name,
    defaultAmount: params.defaultAmount,
  });

  // Validate scope-specific requirements
  if (params.scope === "plan" && !params.planId) {
    throw new Error("Plan ID required for plan-scoped credits");
  }

  if (params.applicationType === "monetary") {
    if (!params.currency) {
      throw new Error("Currency required for monetary credits");
    }
    // Monetary credits must be billing visible
    if (params.billingVisible !== true) {
      console.log("Setting billing visible to true for monetary credits");
      params.billingVisible = true;
    }
  }

  // Convert scope to match schema enum
  const creditScope: "plan" | "merchant" =
    params.scope === "plan" ? "plan" : "merchant";

  // Create credit definition without renewal configuration (key difference from automatic credits)
  const creditDefinition = await createCreditDefinition(
    {
      merchantId: params.merchantId,
      scope: creditScope,
      applicationType: params.applicationType,
      name: params.name,
      description: params.description,
      planId: params.planId,
      featureId: params.featureId,
      featureSlug: params.featureSlug,
      priceId: params.priceId,
      priceComponentId: params.priceComponentId,
      currency: params.currency,
      billingVisible: params.billingVisible || false,
      billingDescription: params.billingDescription,
      defaultAmount: params.defaultAmount,
      // Critical: No renewal configuration for manual credits
      renewOnBilling: false,
      refillRrule: undefined,
      refillAmount: undefined,
      expiryDays: undefined,
    },
    tx
  );

  console.log("Created manual credit definition successfully", {
    id: creditDefinition.id,
    name: creditDefinition.name,
    applicationType: creditDefinition.applicationType,
    scope: creditDefinition.scope,
  });

  return creditDefinition;
}

/**
 * Create a manual credit grant - main function for manual credit granting
 * Supports both extending existing credits and creating entirely new credits
 */
export async function createManualCreditGrant(params: {
  merchantId: string;
  customerId: string;
  creditType: "extend" | "new";

  // For extending existing credits
  existingCreditDefinitionId?: string;

  // For new credits
  newCreditConfig?: NewCreditConfig;

  // Common fields
  amount: number;
  expiryDate?: Date;
  notes?: string;
}): Promise<{
  creditGrant: typeof creditGrants.$inferSelect;
  creditDefinition: typeof creditDefinitions.$inferSelect;
}> {
  console.log("=== createManualCreditGrant Debug ===");
  console.log("Full params:", JSON.stringify(params, null, 2));
  console.log("Creating manual credit grant", {
    merchantId: params.merchantId,
    customerId: params.customerId,
    creditType: params.creditType,
    amount: params.amount,
    hasExpiryDate: !!params.expiryDate,
    hasNotes: !!params.notes,
    hasNewCreditConfig: !!params.newCreditConfig,
    hasExistingCreditDefinitionId: !!params.existingCreditDefinitionId,
  });

  // Validate customer exists and belongs to merchant
  const customer = await db.query.customers.findFirst({
    where: and(
      eq(customers.id, params.customerId),
      eq(customers.merchantId, params.merchantId),
      isNull(customers.deletedAt)
    ),
  });

  if (!customer) {
    throw new Error(
      `Customer ${params.customerId} not found for merchant ${params.merchantId}`
    );
  }

  return await db.transaction(async (tx) => {
    let creditDefinitionId: string;
    let creditDefinition: typeof creditDefinitions.$inferSelect;

    if (params.creditType === "extend") {
      // Use existing credit definition
      if (!params.existingCreditDefinitionId) {
        throw new Error("Credit definition ID required for extending credits");
      }

      creditDefinitionId = params.existingCreditDefinitionId;

      // Verify definition exists and belongs to merchant
      const existingDefinition = await tx.query.creditDefinitions.findFirst({
        where: and(
          eq(creditDefinitions.id, creditDefinitionId),
          eq(creditDefinitions.merchantId, params.merchantId),
          isNull(creditDefinitions.deletedAt)
        ),
      });

      if (!existingDefinition) {
        throw new Error(
          `Credit definition ${creditDefinitionId} not found for merchant ${params.merchantId}`
        );
      }

      creditDefinition = existingDefinition;

      console.log("Using existing credit definition for extension", {
        definitionId: creditDefinition.id,
        definitionName: creditDefinition.name,
        applicationType: creditDefinition.applicationType,
      });

      // Validate amount for the application type
      validateCreditAmount(creditDefinition.applicationType, params.amount);
    } else {
      // Create new credit definition for this manual grant
      if (!params.newCreditConfig) {
        throw new Error("New credit configuration required for new credits");
      }

      console.log("Creating new credit definition for manual grant", {
        newCreditConfig: params.newCreditConfig,
      });

      // Validate amount for the new credit type
      validateCreditAmount(
        params.newCreditConfig.applicationType,
        params.amount
      );

      creditDefinition = await createManualCreditDefinition(
        {
          merchantId: params.merchantId,
          ...params.newCreditConfig,
          defaultAmount: params.amount,
        },
        tx
      );

      creditDefinitionId = creditDefinition.id;
    }

    // Create the credit grant
    console.log("Creating credit grant", {
      merchantId: params.merchantId,
      customerId: params.customerId,
      creditDefinitionId,
      amount: params.amount,
      source: "manual",
    });

    const creditGrant = await createCreditGrant(
      {
        merchantId: params.merchantId,
        customerId: params.customerId,
        creditDefinitionId,
        initialAmount: params.amount,
        expiryDate: params.expiryDate,
        source: "manual", // Important: Mark as manual source
        notes: params.notes,
      },
      tx
    );

    console.log("Manual credit grant created successfully", {
      grantId: creditGrant.id,
      definitionId: creditDefinition.id,
      customerId: params.customerId,
      amount: params.amount,
      applicationType: creditDefinition.applicationType,
      source: creditGrant.source,
    });

    return {
      creditGrant,
      creditDefinition,
    };
  });
}
