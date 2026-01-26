import { RRule, Options as RRuleOptions } from "rrule";
import { db } from "../db/client";
import {
  plans,
  prices,
  invoices,
  invoiceLineItems,
  payments,
  events,
  metrics,
  creditGrants,
  dunningConfigs,
  subscriptionChanges,
  pricingTables,
  pricingTablePlans,
} from "@lumen/common/schema";
import {
  eq,
  and,
  isNull,
  lte,
  count,
  sum,
  avg,
  gte,
  or,
  inArray,
  desc,
  like,
  sql,
} from "drizzle-orm";
import { customers } from "@lumen/common/schema";
import { subscriptions } from "@lumen/common/schema";
import {
  PriceComponentSchemaType,
  PriceDSLSchemaCreate,
  priceDSLSchemaZod,
} from "@lumen/common";
import {
  getPlanFeatures,
  FeatureValue,
  DatabaseType,
  TransactionType,
  Plan,
  Price,
} from "./index";
import {
  subscriptionFeatures,
  subscriptionDetails,
  customerInvoiceCounters,
  customerOrganizations,
} from "@lumen/common/schema";
import {} from "@lumen/common/schema";
import {
  convertToTimezoneFromUTC as convertToTimezoneStrippedFromUTC,
  convertToUTCFromServerTz,
  getEffectiveTimezone,
  isSameDay,
} from "./utils";
import { logger } from "./logging";
import questDbService from "../db/questDbService";
import { ID_PREFIXES, createPrefixedId } from "@lumen/common";
import type { InvoiceCompleteAPI } from "./invoices";
import { formatInvoiceWithDetailsToCompleteAPI } from "./invoices";
import { tasks } from "@trigger.dev/sdk/v3";
import type { generateInvoicePdfJob } from "../../trigger/jobs/generateInvoicePdf";
import type { CollectPaymentPayload } from "../../trigger/helpers/collectPayment";
import { getSecretOrEnvVar } from "./secrets";
import { configure } from "@trigger.dev/sdk/v3";
import {
  applyUsageCreditsForBilling,
  processInitialCreditsForSubscription,
  createCreditTransaction,
} from "./credits";
import Dinero, { Currency } from "dinero.js";
import { uploadFile, getObjectStorageUrl } from "./s3";
import { processInvoicePdfGeneration } from "./invoices";
import { env } from "../env";
import { calculateTaxes } from "./tax-engine";
import {
  chargeCustomerWithAmount,
  getPaymentProvider,
} from "./paymentprovider";
import { calculateNextBillingDate } from "./billing-dates";
import { eventProcessingService } from "../routes/events";

configure({
  secretKey: (await getSecretOrEnvVar({
    secretNameTemplate: "lumen/*/trigger-secret-key",
    envVariableName: "TRIGGER_SECRET_KEY",
    throwOnDevError: true,
    throwOnStagingOrProdError: true,
  })) as string, // always returns or throws
});

/**
 * Core subscription creation logic that handles both new subscriptions and subscription upgrades
 * This function validates inputs, checks for existing active subscriptions, creates the subscription record if needed, associates features, and processes initial credits
 *
 * @returns Object containing subscription info and a flag indicating if an existing subscription was found
 */
export async function createSubscriptionCore({
  merchantId,
  customerId,
  planId,
  effectivePriceId,
  startTimestamp,
  paymentMethodId,
  stableSubscriptionId,
  versionNumberOverride,
  isRenewal,
  isImmediatePayment,
  dangerouslyAllowMultipleSubscriptions,
  primarySeatEventTimestamp,
  tx,
}: {
  merchantId: string;
  customerId: string;
  planId: string;
  effectivePriceId: string;
  startTimestamp: Date;
  paymentMethodId?: string;
  stableSubscriptionId?: string;
  versionNumberOverride?: number;
  isRenewal?: boolean;
  isImmediatePayment?: boolean;
  dangerouslyAllowMultipleSubscriptions?: boolean;
  primarySeatEventTimestamp?: Date;
  tx?: TransactionType;
}): Promise<{
  subscription: typeof subscriptions.$inferSelect;
  subscriptionDetailsRecords: (typeof subscriptionDetails.$inferSelect)[];
  creditGrants: { grantCount: number; errors: string[] };
  price: typeof prices.$inferSelect;
  wasExistingSubscription: boolean;
}> {
  console.info("createSubscriptionCore: Starting subscription creation", {
    merchantId,
    customerId,
    planId,
    effectivePriceId,
    startTimestamp,
    stableSubscriptionId,
    isRenewal,
    isImmediatePayment,
    dangerouslyAllowMultipleSubscriptions,
  });

  // --- Validation ---
  // Use transaction for validation if provided, otherwise use db
  const dbInstance = tx || db;

  // 1. Check Customer
  console.info("createSubscriptionCore: Validating customer", {
    customerId,
    merchantId,
  });
  const customer = await dbInstance.query.customers.findFirst({
    where: and(
      eq(customers.id, customerId),
      eq(customers.merchantId, merchantId),
      isNull(customers.deletedAt)
    ),
  });
  if (!customer) {
    console.error("createSubscriptionCore: Customer validation failed", {
      customerId,
      merchantId,
    });
    throw new Error("Customer not found or does not belong to this merchant.");
  }
  console.info("createSubscriptionCore: Customer validated successfully", {
    customerId,
    customerOrganizationId: customer.customerOrganizationId,
    orgRole: customer.orgRole,
  });

  // 2. Check Plan
  console.info("createSubscriptionCore: Validating plan", {
    planId,
    merchantId,
  });
  const plan = await dbInstance.query.plans.findFirst({
    where: and(
      eq(plans.id, planId),
      eq(plans.merchantId, merchantId),
      isNull(plans.deletedAt)
    ),
  });
  if (!plan) {
    console.error("createSubscriptionCore: Plan validation failed", {
      planId,
      merchantId,
    });
    throw new Error("Plan not found or does not belong to this merchant.");
  }
  console.info("createSubscriptionCore: Plan validated successfully", {
    planId,
    planName: plan.planName,
  });

  // 3. Check Price
  console.info("createSubscriptionCore: Validating price", {
    effectivePriceId,
    planId,
    merchantId,
  });
  const price = await dbInstance.query.prices.findFirst({
    where: and(
      eq(prices.id, effectivePriceId),
      eq(prices.planId, planId),
      eq(prices.merchantId, merchantId),
      isNull(prices.deletedAt)
    ),
  });
  if (!price) {
    console.error("createSubscriptionCore: Price validation failed", {
      effectivePriceId,
      planId,
      merchantId,
    });
    throw new Error(
      "Price not found, does not belong to this plan, or does not belong to this merchant."
    );
  }
  console.info("createSubscriptionCore: Price validated successfully", {
    effectivePriceId,
    currency: price.currency,
    componentsCount: price.pricingData?.components?.length || 0,
  });

  // 3a. Seats-as-customers: ensure organization exists and customer linked as primary when seat plan detected
  const hasSeatPerUnit = Array.isArray(price.pricingData?.components)
    ? price.pricingData.components.some((c: any) => c.type === "per_unit")
    : false;

  if (hasSeatPerUnit) {
    console.info(
      "createSubscriptionCore: Detected seat-based plan, setting up organization",
      {
        customerId,
        hasSeatPerUnit,
        existingOrgId: customer.customerOrganizationId,
        existingOrgRole: customer.orgRole,
      }
    );

    // If customer is not part of any organization, create one and mark as primary
    if (!customer.customerOrganizationId) {
      console.info(
        "createSubscriptionCore: Creating new organization for customer",
        { customerId }
      );
      const [org] = await dbInstance
        .insert(customerOrganizations)
        .values({
          merchantId,
          billingCustomerId: customerId, // Set the primary customer as the billing customer
        })
        .returning();

      await dbInstance
        .update(customers)
        .set({ customerOrganizationId: org.id, orgRole: "primary" })
        .where(
          and(
            eq(customers.id, customerId),
            eq(customers.merchantId, merchantId)
          )
        );

      console.info(
        "createSubscriptionCore: Organization created and customer set as primary",
        {
          customerId,
          organizationId: org.id,
        }
      );
    } else if (!customer.orgRole) {
      console.info(
        "createSubscriptionCore: Setting customer as primary in existing organization",
        {
          customerId,
          organizationId: customer.customerOrganizationId,
        }
      );
      // If linked but role is null, set primary by default for the billing customer
      await dbInstance
        .update(customers)
        .set({ orgRole: "primary" })
        .where(
          and(
            eq(customers.id, customerId),
            eq(customers.merchantId, merchantId)
          )
        );
    }

    // No primary usage credit grants here. Initial plan/price grants are handled
    // by processInitialCreditsForSubscription during invoice/subscription flows.
  }

  // 4. Check for existing active subscription
  // Skip this check if we're renewing or this is explicitly an upgrade/migration
  console.info("createSubscriptionCore: Checking for existing subscriptions", {
    isRenewal,
    stableSubscriptionId,
    dangerouslyAllowMultipleSubscriptions,
    willCheckExisting:
      !isRenewal &&
      !stableSubscriptionId &&
      !dangerouslyAllowMultipleSubscriptions,
  });

  if (
    !isRenewal &&
    !stableSubscriptionId &&
    !dangerouslyAllowMultipleSubscriptions
  ) {
    const existingActiveSubscription =
      await dbInstance.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.customerId, customerId),
          eq(subscriptions.merchantId, merchantId),
          isNull(subscriptions.deletedAt),
          isNull(subscriptions.endTimestamp)
        ),
        with: {
          subscriptionDetails: true,
        },
      });

    if (existingActiveSubscription) {
      // Return existing subscription info instead of creating a new one
      console.info(
        "createSubscriptionCore: Found existing active subscription, returning existing",
        {
          customerId,
          existingSubscriptionId: existingActiveSubscription.id,
          stableSubscriptionId: existingActiveSubscription.stableSubscriptionId,
        }
      );

      return {
        subscription: existingActiveSubscription,
        subscriptionDetailsRecords:
          existingActiveSubscription.subscriptionDetails || [],
        creditGrants: { grantCount: 0, errors: [] }, // No new credits for existing subscription
        price,
        wasExistingSubscription: true,
      };
    }
    console.info(
      "createSubscriptionCore: No existing active subscription found, proceeding with creation"
    );
  }

  // --- Creation ---
  console.info(
    "createSubscriptionCore: Starting subscription creation transaction"
  );

  const transaction = async (tx: TransactionType) => {
    const actualStartTimestamp = startTimestamp;

    // Create the subscription record
    const subscriptionValues = {
      merchantId,
      customerId,
      planId,
      versionNumber: versionNumberOverride || 1,
      effectivePriceId: effectivePriceId,
      startTimestamp: actualStartTimestamp,
      stableSubscriptionId: stableSubscriptionId || undefined,
    };

    console.info("createSubscriptionCore: Creating subscription record", {
      subscriptionValues: {
        ...subscriptionValues,
        startTimestamp: actualStartTimestamp.toISOString(),
      },
    });

    const [subscription] = await tx
      .insert(subscriptions)
      .values(subscriptionValues)
      .returning();

    console.info("createSubscriptionCore: Subscription record created", {
      subscriptionId: subscription.id,
      stableSubscriptionId: subscription.stableSubscriptionId,
    });

    // Get the features associated with the plan
    console.info("createSubscriptionCore: Fetching plan features", { planId });
    const planFeaturesList = await getPlanFeatures(planId, tx);

    // Associate the plan features with the subscription
    if (planFeaturesList.length > 0) {
      console.info(
        "createSubscriptionCore: Associating plan features with subscription",
        {
          subscriptionId: subscription.id,
          featuresCount: planFeaturesList.length,
          features: planFeaturesList.map((pf) => ({
            id: pf.id,
            slug: pf.slug,
          })),
        }
      );

      await associateFeaturesWithSubscription(
        subscription.id,
        customerId,
        merchantId,
        planFeaturesList.map((pf) => ({
          id: pf.id,
          slug: pf.slug,
          featureValue: pf.featureValue as FeatureValue,
          source: "plan",
        })),
        tx
      );
      console.info(
        "createSubscriptionCore: Plan features associated successfully"
      );
    } else {
      console.info("createSubscriptionCore: No plan features to associate");
    }

    const effectiveTimezone = await getEffectiveTimezone(
      customerId,
      merchantId
    );

    console.info("createSubscriptionCore: Creating subscription details", {
      subscriptionId: subscription.id,
      effectiveTimezone,
      componentsCount: price.pricingData.components.length,
    });

    const components = price.pricingData.components;
    const subscriptionDetailsRecords: SubscriptionDetails[] = [];

    for (const component of components) {
      const nextBillingDate = calculateNextBillingDate(
        component,
        actualStartTimestamp,
        actualStartTimestamp,
        effectiveTimezone
      );
      const billImmediately = component.bill_immediately;

      // Set cyclesBilled to 1 if this is an immediate payment for a component that bills immediately
      // Otherwise set to 0 (e.g., for trials, manual subscription creation, or components that don't bill immediately)
      const initialCyclesBilled =
        isImmediatePayment && billImmediately !== false ? 1 : 0;

      console.info(
        "createSubscriptionCore: Processing subscription component",
        {
          subscriptionId: subscription.id,
          componentId: component.component_id,
          componentType: component.type,
          nextBillingDate: nextBillingDate.toISOString(),
          actualStartTimestamp: actualStartTimestamp.toISOString(),
          billImmediately,
          initialCyclesBilled,
          isImmediatePayment,
        }
      );

      const [detailsRecord] = await tx
        .insert(subscriptionDetails)
        .values({
          subscriptionId: subscription.id,
          componentId: component.component_id,
          paymentMethodId,
          nextBillingDate,
          subscriptionStartDate: actualStartTimestamp,
          previousBillingDate: billImmediately ? null : actualStartTimestamp,
          cyclesBilled: initialCyclesBilled,
          recurrenceRule: component.recurrence_rule,
        })
        .returning();

      subscriptionDetailsRecords.push(detailsRecord);
    }

    console.info(
      "createSubscriptionCore: All subscription detail records created",
      {
        subscriptionId: subscription.id,
        detailsRecordCount: subscriptionDetailsRecords.length,
      }
    );

    // Process initial credit grants for the new subscription
    let creditGrants: { grantCount: number; errors: string[] } = {
      grantCount: 0,
      errors: [],
    };
    try {
      creditGrants = await processInitialCreditsForSubscription(
        merchantId,
        customerId,
        planId,
        subscription.id,
        tx,
        isRenewal || false
      );
      console.info(
        `Created ${creditGrants.grantCount} initial credit grants for subscription ${subscription.id}`,
        creditGrants.errors.length > 0 ? { errors: creditGrants.errors } : ""
      );
    } catch (creditError) {
      // Log but don't fail the subscription creation
      console.error("Error creating initial credit grants:", creditError);
      creditGrants = {
        grantCount: 0,
        errors: [
          creditError instanceof Error
            ? creditError.message
            : String(creditError),
        ],
      };
    }

    // Add seat_added event for the primary customer when subscribing to a seat-based plan
    // This ensures the primary customer counts as the first seat in the metrics/events system
    if (hasSeatPerUnit && customer.externalCustomerId) {
      try {
        await eventProcessingService.processEvent(
          {
            eventName: "seat_added",
            customerId: customerId,
            extCustomerId: customer.externalCustomerId,
            eventString: customer.externalCustomerId,
            properties: {
              subscription_id: subscription.id,
              source: "subscription_creation",
            },
            idempotencyKey: `seat_add_primary_${customerId}_${subscription.id}_${Date.now()}`,
            eventTimestamp: primarySeatEventTimestamp || startTimestamp,
          },
          merchantId
        );
        console.info(
          `Added seat_added event for primary customer ${customer.externalCustomerId} on seat-based subscription ${subscription.id}`
        );
      } catch (eventError) {
        console.error(
          "Failed to add seat_added event for primary customer:",
          eventError
        );
      }
    }

    console.info("createSubscriptionCore: Transaction completed successfully", {
      subscriptionId: subscription.id,
      subscriptionDetailsCount: subscriptionDetailsRecords.length,
      creditGrantsCount: creditGrants.grantCount,
      creditGrantsErrors: creditGrants.errors.length,
      wasExistingSubscription: false,
    });

    return {
      subscription,
      subscriptionDetailsRecords: subscriptionDetailsRecords,
      creditGrants,
      price,
      wasExistingSubscription: false,
    };
  };

  const result = tx ? await transaction(tx) : await db.transaction(transaction);

  console.info("createSubscriptionCore: Subscription creation completed", {
    subscriptionId: result.subscription.id,
    stableSubscriptionId: result.subscription.stableSubscriptionId,
    customerId: result.subscription.customerId,
    planId: result.subscription.planId,
    wasExistingSubscription: result.wasExistingSubscription,
  });

  return result;
}

type SubscriptionDetails = typeof subscriptionDetails.$inferSelect;

/**
 * Generate an immediate invoice for subscription components that should be billed immediately
 * This handles line item generation, invoice creation, and PDF triggering
 */
export async function generateImmediateInvoice({
  merchantId,
  customerId,
  subscription,
  price,
  subscriptionDetailsRecords,
  firstBillingPeriodStart,
  tx,
  taxInfo,
}: {
  merchantId: string;
  customerId: string;
  subscription: typeof subscriptions.$inferSelect;
  price: typeof prices.$inferSelect;
  subscriptionDetailsRecords: (typeof subscriptionDetails.$inferSelect)[];
  firstBillingPeriodStart: Date;
  tx: TransactionType;
  taxInfo?: {
    taxAmountCents: number;
    taxJurisdiction: string | null;
    taxCalculationMethod: string | null;
    effectiveTaxRate: string;
    taxLineItems?: Array<{
      type: "tax";
      description: string;
      subtotalCents: number;
      taxMetadata?: {
        taxAuthority?: string;
        taxType?: string;
        jurisdiction?: string;
        taxRate?: number;
        rateSource?: string;
        exemptionReason?: string;
        reasonCode?: number;
        fullDescription?: string;
      };
    }>;
  };
}): Promise<typeof invoices.$inferSelect | null> {
  // Get the customer to check for invoice prefix
  const customer = await tx.query.customers.findFirst({
    where: and(eq(customers.id, customerId), isNull(customers.deletedAt)),
  });

  // Find components that should be billed immediately
  const immediateComponents = price.pricingData.components.filter(
    (component) => component.bill_immediately !== false
  );

  console.info(
    `Found ${immediateComponents.length} components for immediate billing`
  );

  if (immediateComponents.length === 0) {
    console.info(
      "No components marked for immediate billing - no invoice created"
    );
    return null;
  }

  console.log("immediateComponents", immediateComponents);
  console.log("subscriptionDetailsRecords", subscriptionDetailsRecords);

  // Generate line items for immediate billing components
  const lineItemPromises = immediateComponents.map((component) => {
    const subPriceComponent = subscriptionDetailsRecords.find(
      (sd) => sd.componentId === component.component_id
    );
    if (!subPriceComponent) {
      throw new Error(
        `Subscription price component ${component.component_id} not found`
      );
    }
    return generateLineItemObjectForComponent(
      component,
      merchantId,
      customerId,
      firstBillingPeriodStart, // Billing period start = subscription start
      subPriceComponent.nextBillingDate,
      price.id,
      subscription.id
    );
  });

  const lineItems = await Promise.all(lineItemPromises);

  // Calculate subtotal amount from line items
  const subtotalAmountCents = lineItems.reduce(
    (total, item) => total + item.subtotalCents,
    0
  );

  // Calculate total amount including tax
  const totalAmountCents = subtotalAmountCents + (taxInfo?.taxAmountCents || 0);

  // Create invoice (even if $0.00)
  const sequenceNumber = await getAndIncrementInvoiceCounter(
    tx,
    merchantId,
    customerId
  );

  const customerInvoiceNumber = formatCustomerInvoiceNumber(
    customer?.invoicePrefix || customer?.id.slice(4, 10),
    sequenceNumber
  );

  const [newInvoice] = await tx
    .insert(invoices)
    .values({
      merchantId,
      customerId,
      subscriptionId: subscription.id,
      status: "paid",
      totalAmountCents,
      subtotalCents: subtotalAmountCents,
      taxAmountCents: taxInfo?.taxAmountCents || 0,
      effectiveTaxRate: taxInfo?.effectiveTaxRate || "0",
      taxJurisdiction: taxInfo?.taxJurisdiction || null,
      taxCalculationMethod: taxInfo?.taxCalculationMethod || null,
      currency: price.currency,
      customerInvoiceNumber,
      dueDate: firstBillingPeriodStart,
      issueDate: firstBillingPeriodStart,
      billingPeriodStart: subscription.startTimestamp,
      billingPeriodEnd: (() => {
        const immediateIds = new Set(
          immediateComponents.map((c) => c.component_id)
        );
        const ends = subscriptionDetailsRecords
          .filter((sd) => immediateIds.has(sd.componentId))
          .map((sd) => new Date(sd.nextBillingDate).getTime());
        if (ends.length === 0) return null;
        return new Date(Math.max(...ends));
      })(),
    })
    .returning();

  if (!newInvoice) {
    throw new Error("Failed to create invoice");
  }

  // Create invoice line items (including tax line items if present)
  const lineItemsToInsert: Array<{
    invoiceId: string;
    type: string;
    componentId: string | null;
    description: string;
    quantity: number | undefined;
    unitAmountCents: number | undefined;
    subtotalCents: number;
    billingPeriodStart: Date;
    billingPeriodEnd: Date;
    metricId: string | undefined;
    taxMetadata?: any;
  }> = lineItems.map((item) => ({
    invoiceId: newInvoice.id,
    type: item.type,
    componentId: item.componentId,
    description: item.description,
    quantity: item.quantity,
    unitAmountCents: item.unitAmountCents,
    subtotalCents: item.subtotalCents,
    billingPeriodStart: item.billingPeriodStart,
    billingPeriodEnd: item.billingPeriodEnd,
    metricId: item.metricId,
    taxMetadata: undefined,
  }));

  // Add tax line items if they exist
  if (taxInfo?.taxLineItems) {
    for (const taxLineItem of taxInfo.taxLineItems) {
      lineItemsToInsert.push({
        invoiceId: newInvoice.id,
        type: taxLineItem.type,
        componentId: null,
        description: taxLineItem.description,
        quantity: 1,
        unitAmountCents: taxLineItem.subtotalCents,
        subtotalCents: taxLineItem.subtotalCents,
        billingPeriodStart: firstBillingPeriodStart,
        billingPeriodEnd: firstBillingPeriodStart,
        metricId: undefined,
        taxMetadata: taxLineItem.taxMetadata,
      });
    }
  }

  await tx.insert(invoiceLineItems).values(lineItemsToInsert);

  // Update subscription details records to mark as billed
  for (const component of immediateComponents) {
    const subDetails = subscriptionDetailsRecords.find(
      (record) => record.componentId === component.component_id
    );

    if (subDetails) {
      await tx
        .update(subscriptionDetails)
        .set({
          previousBillingDate: subscription.startTimestamp,
          cyclesBilled: 1, // Mark as having been billed once
        })
        .where(
          and(
            eq(subscriptionDetails.id, subDetails.id),
            isNull(subscriptionDetails.deletedAt)
          )
        );
    }
  }

  // Trigger PDF generation for the invoice
  try {
    const invoiceWithDetails = await tx.query.invoices.findFirst({
      where: eq(invoices.id, newInvoice.id),
      with: {
        merchant: true,
        customer: true,
        subscription: {
          with: {
            price: true,
          },
        },
        lineItems: true,
      },
    });

    if (invoiceWithDetails) {
      await triggerInvoicePdfGeneration(invoiceWithDetails, tx);
    }
  } catch (pdfError) {
    console.error(
      `Failed to trigger PDF generation: ${pdfError instanceof Error ? pdfError.message : String(pdfError)}`
    );
    // Continue execution - PDF generation failure shouldn't block the flow
  }

  console.info(
    `Created initial invoice with ${lineItems.length} line items (${totalAmountCents === 0 ? "free" : "paid"})`
  );

  return newInvoice;
}

/**
 * Migrate feature overrides from a previous subscription version to a new subscription
 * Only copies boolean overrides that are not already provided by the new plan
 */
export async function migrateFeatureOverrides({
  previousSubscriptionId,
  newSubscriptionId,
  newPlanFeatureSlugs,
  customerId,
  merchantId,
  tx,
}: {
  previousSubscriptionId: string;
  newSubscriptionId: string;
  newPlanFeatureSlugs: Set<string>;
  customerId: string;
  merchantId: string;
  tx: TransactionType;
}): Promise<void> {
  // Get existing subscription features before soft-deleting
  const existingSubscriptionOverrideFeatures =
    await tx.query.subscriptionFeatures.findMany({
      where: and(
        eq(subscriptionFeatures.subscriptionId, previousSubscriptionId),
        eq(subscriptionFeatures.source, "override"),
        isNull(subscriptionFeatures.deletedAt)
      ),
      with: {
        feature: true,
      },
    });

  // Copy feature overrides that are NOT already provided by the new plan
  // Only copy boolean overrides for now (ignore numeric/usage-based until credit-grant system is formalized)
  const featureOverridesToCopy = existingSubscriptionOverrideFeatures.filter(
    (sf) => {
      if (!sf.feature) return false;

      // Skip if the feature is already in the new plan (override would be redundant)
      if (newPlanFeatureSlugs.has(sf.feature.slug)) return false;

      // Only copy boolean overrides for now
      const featureValue = sf.featureValue || sf.feature.featureValue;
      return typeof featureValue === "boolean";
    }
  );

  if (featureOverridesToCopy.length > 0) {
    await associateFeaturesWithSubscription(
      newSubscriptionId,
      customerId,
      merchantId,
      featureOverridesToCopy.map((sf) => ({
        id: sf.feature!.id,
        slug: sf.feature!.slug,
        featureValue: (sf.featureValue ||
          sf.feature!.featureValue) as FeatureValue,
        source: "override",
      })),
      tx
    );
  }
}

/**
 * Get active subscription for a customer and merchant
 * Returns null if no active subscription exists
 */
export async function getActiveSubscriptionForCustomer(
  merchantId: string,
  customerId: string,
  tx?: TransactionType
): Promise<typeof subscriptions.$inferSelect | null> {
  const dbInstance = tx || db;

  const activeSubscription = await dbInstance.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.merchantId, merchantId),
      eq(subscriptions.customerId, customerId),
      isNull(subscriptions.deletedAt),
      isNull(subscriptions.endTimestamp),
      // Consider subscription active if status is active, trialing, or past_due (grace period)
      inArray(subscriptions.status, ["active", "trialing", "past_due"])
    ),
  });

  return activeSubscription || null;
}

/**
 * Upgrade an existing subscription to a new plan/price (free → paid upgrade)
 * This handles the subscription versioning and feature override copying
 */
export async function upgradeSubscriptionAndInvoice({
  merchantId,
  customerId,
  planId,
  priceId,
  startTimestamp,
  paymentMethodId,
  existingSubscription,
  tx,
  taxInfo,
}: {
  merchantId: string;
  customerId: string;
  planId: string;
  priceId: string;
  startTimestamp: Date;
  paymentMethodId?: string | null;
  existingSubscription: typeof subscriptions.$inferSelect;
  tx: TransactionType;
  taxInfo?: {
    taxAmountCents: number;
    taxJurisdiction: string | null;
    taxCalculationMethod: string | null;
    effectiveTaxRate: string;
  };
}): Promise<{
  subscription: typeof subscriptions.$inferSelect;
  invoice: typeof invoices.$inferSelect | null;
  creditGrants: { grantCount: number; errors: string[] };
}> {
  console.log("Starting upgradeSubscriptionAndInvoice", {
    merchantId,
    customerId,
    planId,
    priceId,
    startTimestamp,
    paymentMethodId,
    existingSubscriptionId: existingSubscription.id,
    taxInfo,
  });

  const newPlanFeatures = await getPlanFeatures(planId, tx);
  const newPlanFeatureSlugs = new Set(newPlanFeatures.map((f) => f.slug));
  console.log("Fetched new plan features", {
    count: newPlanFeatures.length,
    featureSlugs: Array.from(newPlanFeatureSlugs),
  });

  // Soft-delete the existing subscription and its features
  const currentTimestamp = new Date();

  console.log("Soft-deleting existing subscription and features", {
    subscriptionId: existingSubscription.id,
    timestamp: currentTimestamp,
  });

  await tx
    .update(subscriptions)
    .set({
      deletedAt: currentTimestamp,
      endTimestamp: currentTimestamp,
      status: "canceled", // Set proper dunning status when upgrading
    })
    .where(eq(subscriptions.id, existingSubscription.id));

  await tx
    .update(subscriptionFeatures)
    .set({ deletedAt: currentTimestamp })
    .where(
      and(
        eq(subscriptionFeatures.subscriptionId, existingSubscription.id),
        isNull(subscriptionFeatures.deletedAt)
      )
    );

  // Also soft-delete all subscription details linked to the old version so they are not billed again
  await tx
    .update(subscriptionDetails)
    .set({ deletedAt: currentTimestamp })
    .where(
      and(
        eq(subscriptionDetails.subscriptionId, existingSubscription.id),
        isNull(subscriptionDetails.deletedAt)
      )
    );

  // 2b. Properly expire credit grants linked to the old (trial) plan
  const oldPlanGrants = await tx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.customerId, customerId),
      eq(creditGrants.planId, existingSubscription.planId),
      eq(creditGrants.scope, "plan"),
      eq(creditGrants.status, "ACTIVE"),
      isNull(creditGrants.deletedAt)
    ),
    with: {
      creditDefinition: true,
    },
  });

  if (oldPlanGrants.length > 0) {
    const allGrantIds = oldPlanGrants.map((g) => g.id);

    // 1. Disable future renewals on all old grants
    await tx
      .update(creditGrants)
      .set({ nextRenewalDate: null, updatedAt: new Date() })
      .where(inArray(creditGrants.id, allGrantIds));

    // 2. Expire trial grants (those with expiryDays === -1 or trial grants that should expire immediately)
    const expireGrantIds = oldPlanGrants
      .filter(
        (g) =>
          g.creditDefinition?.expiryDays === -1 || g.source === "subscription"
      )
      .map((g) => g.id);

    if (expireGrantIds.length > 0) {
      await tx
        .update(creditGrants)
        .set({
          expiryDate: currentTimestamp,
          status: "EXPIRED" as const,
          updatedAt: new Date(),
        })
        .where(inArray(creditGrants.id, expireGrantIds));

      console.log(
        `Expired ${expireGrantIds.length} trial credit grants during upgrade`
      );
    }
  }

  console.log("Creating new subscription version", {
    merchantId,
    customerId,
    planId,
    priceId,
    versionNumber: existingSubscription.versionNumber + 1,
    isImmediatePayment: true, // This is for upgrade flow, so immediate payment occurred
  });

  const {
    subscription,
    subscriptionDetailsRecords,
    creditGrants: initialCreditGrants,
    price,
  } = await createSubscriptionCore({
    merchantId,
    customerId,
    planId,
    effectivePriceId: priceId,
    startTimestamp,
    paymentMethodId: paymentMethodId || undefined,
    stableSubscriptionId: existingSubscription.stableSubscriptionId,
    versionNumberOverride: existingSubscription.versionNumber + 1,
    isImmediatePayment: true, // This is for upgrade flow, so immediate payment occurred
    dangerouslyAllowMultipleSubscriptions: false,
    tx,
  });

  console.log("Migrating feature overrides", {
    previousSubscriptionId: existingSubscription.id,
    newSubscriptionId: subscription.id,
  });

  await migrateFeatureOverrides({
    previousSubscriptionId: existingSubscription.id,
    newSubscriptionId: subscription.id,
    newPlanFeatureSlugs,
    customerId,
    merchantId,
    tx,
  });

  console.log("Generating immediate invoice if needed", {
    subscriptionId: subscription.id,
    priceId: price.id,
    subscriptionDetailsCount: subscriptionDetailsRecords.length,
  });

  const invoice = await generateImmediateInvoice({
    merchantId,
    customerId,
    subscription,
    price,
    subscriptionDetailsRecords,
    firstBillingPeriodStart: startTimestamp,
    tx,
    taxInfo,
  });

  console.log("Upgrade complete", {
    newSubscriptionId: subscription.id,
    invoiceId: invoice ? invoice.id : null,
    creditGrantCount: initialCreditGrants.grantCount,
    creditGrantErrors: initialCreditGrants.errors,
  });

  return {
    subscription,
    invoice,
    creditGrants: initialCreditGrants,
  };
}

/**
 * Downgrade an existing subscription version to the merchant's latest free plan (if available).
 * Creates a new subscription version on the free plan, preserving stableSubscriptionId and versioning.
 * Falls back to throwing if no free price is available (caller should decide fallback behavior).
 */
export async function downgradeSubscriptionToFreeAndInvoice({
  merchantId,
  customerId,
  existingSubscription,
  tx,
}: {
  merchantId: string;
  customerId: string;
  existingSubscription: typeof subscriptions.$inferSelect;
  tx: TransactionType;
}): Promise<{
  subscription: typeof subscriptions.$inferSelect;
  invoice: typeof invoices.$inferSelect | null;
  creditGrants: { grantCount: number; errors: string[] };
}> {
  console.log("Starting downgradeSubscriptionToFreeAndInvoice", {
    merchantId,
    customerId,
    existingSubscriptionId: existingSubscription.id,
  });

  // 1. Locate latest free price from active pricing tables
  const activePricingTables = await tx.query.pricingTables.findMany({
    where: and(
      eq(pricingTables.merchantId, merchantId),
      eq(pricingTables.isActive, true),
      isNull(pricingTables.deletedAt)
    ),
  });

  if (activePricingTables.length === 0) {
    throw new Error("No active pricing tables found for this merchant");
  }

  const pricingTableIds = activePricingTables.map((pt) => pt.id);

  const pricingTablePlanEntries = await tx.query.pricingTablePlans.findMany({
    where: and(
      eq(pricingTablePlans.merchantId, merchantId),
      inArray(pricingTablePlans.pricingTableId, pricingTableIds),
      isNull(pricingTablePlans.deletedAt)
    ),
  });

  if (pricingTablePlanEntries.length === 0) {
    throw new Error("No plans found in active pricing tables");
  }

  const planIdsInPricingTables = pricingTablePlanEntries.map(
    (ptp) => ptp.planId
  );

  const pricesForPricingTablePlans = await tx.query.prices.findMany({
    where: and(
      eq(prices.merchantId, merchantId),
      inArray(prices.planId, planIdsInPricingTables),
      isNull(prices.deletedAt)
    ),
    with: { plan: true },
    orderBy: desc(prices.createdAt),
  });

  const freePrices = pricesForPricingTablePlans.filter((price) => {
    if (!price.pricingData || !price.pricingData.components) {
      return false;
    }

    let immediateAmountToBill = 0;
    let totalPlanValueExcludingUsage = 0;
    let hasUsageComponentWithNonZeroPrice = false;

    for (const component of price.pricingData.components) {
      if (component.type !== "usage") {
        totalPlanValueExcludingUsage += component.amount_cents || 0;
        if (component.bill_immediately) {
          immediateAmountToBill += component.amount_cents || 0;
        }
      } else {
        if (component.unit_cost_cents > 0) {
          hasUsageComponentWithNonZeroPrice = true;
        }
      }
    }

    return (
      immediateAmountToBill === 0 &&
      totalPlanValueExcludingUsage === 0 &&
      !hasUsageComponentWithNonZeroPrice
    );
  });

  if (freePrices.length === 0) {
    throw new Error("No free plans available for this merchant");
  }

  const latestFreePlanPrice = freePrices[0];
  if (!latestFreePlanPrice.plan) {
    throw new Error("Plan not found for the selected free price");
  }

  const newPlanId = latestFreePlanPrice.plan.id;
  const newPriceId = latestFreePlanPrice.id;

  // 2. Prepare new plan features for override migration
  const newPlanFeatures = await getPlanFeatures(newPlanId, tx);
  const newPlanFeatureSlugs = new Set(newPlanFeatures.map((f) => f.slug));

  // 3. Soft-delete existing subscription and related entities
  const currentTimestamp = new Date();

  await tx
    .update(subscriptions)
    .set({
      deletedAt: currentTimestamp,
      endTimestamp: currentTimestamp,
      status: "canceled",
      gracePeriodEndsAt: null,
    })
    .where(eq(subscriptions.id, existingSubscription.id));

  await tx
    .update(subscriptionFeatures)
    .set({ deletedAt: currentTimestamp })
    .where(
      and(
        eq(subscriptionFeatures.subscriptionId, existingSubscription.id),
        isNull(subscriptionFeatures.deletedAt)
      )
    );

  await tx
    .update(subscriptionDetails)
    .set({ deletedAt: currentTimestamp })
    .where(
      and(
        eq(subscriptionDetails.subscriptionId, existingSubscription.id),
        isNull(subscriptionDetails.deletedAt)
      )
    );

  // 4. Expire plan-scoped credit grants for the old plan
  const oldPlanGrants = await tx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.customerId, customerId),
      eq(creditGrants.planId, existingSubscription.planId),
      eq(creditGrants.scope, "plan"),
      eq(creditGrants.status, "ACTIVE"),
      isNull(creditGrants.deletedAt)
    ),
    with: { creditDefinition: true },
  });

  if (oldPlanGrants.length > 0) {
    const allGrantIds = oldPlanGrants.map((g) => g.id);

    await tx
      .update(creditGrants)
      .set({ nextRenewalDate: null, updatedAt: new Date() })
      .where(inArray(creditGrants.id, allGrantIds));

    const expireGrantIds = oldPlanGrants
      .filter(
        (g) =>
          g.creditDefinition?.expiryDays === -1 || g.source === "subscription"
      )
      .map((g) => g.id);

    if (expireGrantIds.length > 0) {
      await tx
        .update(creditGrants)
        .set({
          expiryDate: currentTimestamp,
          status: "EXPIRED" as const,
          updatedAt: new Date(),
        })
        .where(inArray(creditGrants.id, expireGrantIds));
    }
  }

  // 5. Create the new free version of the subscription
  const startTimestamp = currentTimestamp;
  const {
    subscription,
    subscriptionDetailsRecords,
    creditGrants: initialCreditGrants,
    price,
  } = await createSubscriptionCore({
    merchantId,
    customerId,
    planId: newPlanId,
    effectivePriceId: newPriceId,
    startTimestamp,
    paymentMethodId: undefined,
    stableSubscriptionId: existingSubscription.stableSubscriptionId,
    versionNumberOverride: existingSubscription.versionNumber + 1,
    isImmediatePayment: false,
    dangerouslyAllowMultipleSubscriptions: false,
    tx,
  });

  // 6. Migrate feature overrides, excluding features provided by the free plan
  await migrateFeatureOverrides({
    previousSubscriptionId: existingSubscription.id,
    newSubscriptionId: subscription.id,
    newPlanFeatureSlugs,
    customerId,
    merchantId,
    tx,
  });

  // 7. Generate a $0 invoice for bookkeeping
  const invoice = await generateImmediateInvoice({
    merchantId,
    customerId,
    subscription,
    price,
    subscriptionDetailsRecords,
    firstBillingPeriodStart: startTimestamp,
    tx,
    taxInfo: undefined,
  });

  console.log("Downgrade to free complete", {
    newSubscriptionId: subscription.id,
    invoiceId: invoice ? invoice.id : null,
    creditGrantCount: initialCreditGrants.grantCount,
  });

  return { subscription, invoice, creditGrants: initialCreditGrants };
}

/**
 * @deprecated Use createSubscriptionCore instead. This function is kept for backward compatibility.
 * Core subscription creation logic that handles both new subscriptions and subscription upgrades
 */
export async function createSubscription({
  merchantId,
  customerId,
  planId,
  effectivePriceId,
  startTimestamp,
  paymentMethodId,
  tx,
}: {
  merchantId: string;
  customerId: string;
  planId: string;
  effectivePriceId: string;
  startTimestamp: Date;
  paymentMethodId?: string;
  tx?: TransactionType;
}): Promise<{
  subscription: typeof subscriptions.$inferSelect;
  subscriptionDetailsRecords: (typeof subscriptionDetails.$inferSelect)[];
  creditGrants: { grantCount: number; errors: string[] };
}> {
  const result = await createSubscriptionCore({
    merchantId,
    customerId,
    planId,
    effectivePriceId,
    startTimestamp,
    paymentMethodId,
    dangerouslyAllowMultipleSubscriptions: false,
    tx,
  });

  // Return without the price field for backward compatibility
  return {
    subscription: result.subscription,
    subscriptionDetailsRecords: result.subscriptionDetailsRecords,
    creditGrants: result.creditGrants,
  };
}

/**
 * Calculate the next billing date for a specific price component
 *
 * @param component The price component to calculate billing date for
 * @param currentTimestamp The timestamp to calculate from (usually current date or previous billing date)
 * @param subscriptionStartTimestamp The original subscription start timestamp
 * @param timezone The timezone to use for calculation
 * @returns The next billing date as a UTC Date
 */

/**
 * Updates the subscription details record for a specific component after a billing cycle completes.
 * Calculates the next billing date (TZ aware) and increments the cycles billed.
 *
 * @param tx The database transaction instance.
 * @param subscriptionDetailsId The ID of the subscription details record to update.
 * @param currentNextBillingDate The date the current billing cycle ended (and the invoice was generated for).
 * @param component The specific price component to update billing for.
 * @param timezone The timezone to use for the calculation (IANA format), defaults to UTC.
 * @returns The newly calculated next billing date.
 */
export async function updateSubscriptionBillingCycle(
  subscriptionDetailsId: string,
  currentNextBillingDate: Date,
  component: PriceComponentSchemaType,
  timezone: string = "UTC",
  tx?: TransactionType
): Promise<Date> {
  // Get the subscription details, including subscription and customer information to determine the timezone
  const dbInstance = tx || db;
  const subDetails = await dbInstance.query.subscriptionDetails.findFirst({
    where: eq(subscriptionDetails.id, subscriptionDetailsId),
    with: {
      subscription: {
        with: {
          customer: true,
        },
      },
    },
  });

  if (!subDetails) {
    // This should ideally not happen if called within the invoice transaction
    throw new Error(
      `Subscription details not found for ID during billing cycle update: ${subscriptionDetailsId}`
    );
  }

  // Determine the effective timezone to use
  let effectiveTimezone = timezone;
  if (timezone === "UTC" && subDetails.subscription?.customer?.timezone) {
    effectiveTimezone = subDetails.subscription.customer.timezone;
  }

  // Ensure we have the original subscription start timestamp
  if (!subDetails.subscription?.startTimestamp) {
    throw new Error(
      `Original start timestamp not found for subscription during billing cycle update: ${subDetails.subscriptionId}`
    );
  }

  // Calculate the next billing date using the timezone-aware helper function
  const nextBillingDateNew = calculateNextBillingDate(
    component, // Use the specific component passed in
    currentNextBillingDate, // The date the current cycle ended
    subDetails.subscription.startTimestamp, // The original start timestamp
    effectiveTimezone
  );

  // Update subscription details for this component with new next billing date and increment cycles_billed
  await dbInstance
    .update(subscriptionDetails)
    .set({
      nextBillingDate: nextBillingDateNew,
      previousBillingDate: currentNextBillingDate,
      cyclesBilled: subDetails.cyclesBilled + 1,
    })
    .where(eq(subscriptionDetails.id, subscriptionDetailsId));

  return nextBillingDateNew;
}

/**
 * Generates a component ID based on its type and optional name
 * @param type The component type ('fixed', 'per_unit', 'usage')
 * @param componentName Optional human-readable name to incorporate into the ID
 * @returns A unique component ID with the appropriate prefix
 */
export function generateComponentId(
  type: "fixed" | "per_unit" | "usage"
): string {
  // Get the appropriate prefix based on component type
  let prefix: string;
  switch (type) {
    case "fixed":
      prefix = ID_PREFIXES.fixedComponent;
      break;
    case "per_unit":
      prefix = ID_PREFIXES.perUnitComponent;
      break;
    case "usage":
      prefix = ID_PREFIXES.usageComponent;
      break;
    default:
      // This shouldn't happen due to TypeScript type checking
      throw new Error(`Invalid component type: ${type}`);
  }

  // Generate the unique ID using the standard createPrefixedId function
  return createPrefixedId(prefix);
}

/**
 * Resume a paused/past_due subscription by resetting its billing cycle to start at `resumedAt`
 * and regenerating initial credits for the plan. This keeps the same subscription object
 * but logically starts a fresh cycle.
 */
export async function resumeSubscriptionAndResetCycle({
  subscriptionId,
  resumedAt = new Date(),
  tx,
}: {
  subscriptionId: string;
  resumedAt?: Date;
  tx?: TransactionType;
}): Promise<{
  updatedSubscriptionId: string;
  updatedDetailsCount: number;
  credits: { revokedCount: number; expiredCount: number; newGrants: number };
}> {
  const dbx = tx || db;

  const subscription = await dbx.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscriptionId),
    with: {
      price: true,
      customer: true,
      subscriptionDetails: {
        where: isNull(subscriptionDetails.deletedAt),
      },
    },
  });

  if (!subscription) {
    throw new Error(`Subscription not found: ${subscriptionId}`);
  }

  if (
    subscription.status !== "paused" &&
    subscription.status !== "past_due" &&
    subscription.status !== "unpaid"
  ) {
    // Allow resume semantics for paused/past_due; reactivate can optionally use this for unpaid
    // Skip if already active/canceled etc.
    return {
      updatedSubscriptionId: subscription.id,
      updatedDetailsCount: 0,
      credits: { revokedCount: 0, expiredCount: 0, newGrants: 0 },
    };
  }

  const effectiveTimezone = await getEffectiveTimezone(
    subscription.customerId,
    subscription.merchantId
  );

  // Update subscription core fields: set as active, clear grace, reset start timestamp
  await dbx
    .update(subscriptions)
    .set({
      status: "active",
      gracePeriodEndsAt: null,
      endTimestamp: null,
      startTimestamp: resumedAt,
    })
    .where(eq(subscriptions.id, subscription.id));

  // Recompute next billing dates for all active subscription details aligning to the new start
  const priceComponents: PriceComponentSchemaType[] =
    (subscription.price?.pricingData
      ?.components as PriceComponentSchemaType[]) || [];

  let updatedDetailsCount = 0;
  for (const detail of subscription.subscriptionDetails) {
    // Find matching component by ID; fallback to using stored recurrence rule if component not found
    const component =
      priceComponents.find((c) => c.component_id === detail.componentId) ||
      ({
        recurrence_rule: detail.recurrenceRule,
      } as unknown as PriceComponentSchemaType);

    const nextDate = calculateNextBillingDate(
      component,
      resumedAt,
      resumedAt,
      effectiveTimezone
    );

    await dbx
      .update(subscriptionDetails)
      .set({
        nextBillingDate: nextDate,
        subscriptionStartDate: resumedAt,
        previousBillingDate: null,
        cyclesBilled: 0,
      })
      .where(eq(subscriptionDetails.id, detail.id));
    updatedDetailsCount++;
  }

  // Revoke/expire existing active plan-scoped credit grants for this plan/customer
  const activeGrants = await dbx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.merchantId, subscription.merchantId),
      eq(creditGrants.customerId, subscription.customerId),
      eq(creditGrants.planId, subscription.planId),
      eq(creditGrants.status, "ACTIVE"),
      isNull(creditGrants.deletedAt)
    ),
  });

  let revokedCount = 0;
  let expiredCount = 0;
  for (const grant of activeGrants) {
    if (grant.expiryDate) {
      // Mark as expired and record transaction
      await dbx
        .update(creditGrants)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(eq(creditGrants.id, grant.id));

      if (grant.remainingAmount > 0) {
        await createCreditTransaction({
          merchantId: grant.merchantId,
          customerId: grant.customerId,
          creditGrantId: grant.id,
          amount: grant.remainingAmount,
          applicationType: grant.applicationType,
          eventName: "expired",
          eventTimestamp: resumedAt,
          featureId: grant.featureId || undefined,
          featureSlug: grant.featureSlug || undefined,
          priceId: grant.priceId || undefined,
          priceComponentId: grant.priceComponentId || undefined,
          currency: grant.currency || undefined,
        });
      }
      expiredCount++;
    } else {
      // No fixed expiry: revoke remaining balance and record transaction
      await dbx
        .update(creditGrants)
        .set({ status: "REVOKED", remainingAmount: 0, updatedAt: new Date() })
        .where(eq(creditGrants.id, grant.id));

      if (grant.remainingAmount > 0) {
        await createCreditTransaction({
          merchantId: grant.merchantId,
          customerId: grant.customerId,
          creditGrantId: grant.id,
          amount: grant.remainingAmount,
          applicationType: grant.applicationType,
          eventName: "revoked",
          eventTimestamp: resumedAt,
          featureId: grant.featureId || undefined,
          featureSlug: grant.featureSlug || undefined,
          priceId: grant.priceId || undefined,
          priceComponentId: grant.priceComponentId || undefined,
          currency: grant.currency || undefined,
        });
      }
      revokedCount++;
    }
  }

  // Grant fresh credits for the plan as if this were a renewal
  const { grantCount } = await processInitialCreditsForSubscription(
    subscription.merchantId,
    subscription.customerId,
    subscription.planId,
    subscription.id,
    tx,
    true
  );

  // Log subscription change for auditability
  await dbx.insert(subscriptionChanges).values({
    subscriptionId: subscription.id,
    type: "resume",
    previousState: {
      status: subscription.status,
    },
    newState: {
      status: "active",
      resumedAt: resumedAt.toISOString(),
    },
    effectiveDate: resumedAt,
    createdBy: "system",
  });

  return {
    updatedSubscriptionId: subscription.id,
    updatedDetailsCount,
    credits: { revokedCount, expiredCount, newGrants: grantCount },
  };
}

/**
 * Core price creation logic extracted from routes
 * Validates and creates a new price record
 * Automatically generates component IDs for components that don't have them
 */
export async function createPrice({
  id,
  planId,
  merchantId,
  currency,
  pricingData,
  isOverridePrice = false,
  tx,
}: {
  id?: string;
  planId: string;
  merchantId: string;
  currency: string;
  pricingData: PriceDSLSchemaCreate;
  isOverridePrice?: boolean;
  tx?: TransactionType;
}) {
  const dbInstance = tx || db;

  // Check if the plan exists and belongs to this merchant
  const plan = await dbInstance.query.plans.findFirst({
    where: and(
      eq(plans.id, planId),
      eq(plans.merchantId, merchantId),
      isNull(plans.deletedAt)
    ),
  });

  if (!plan) {
    throw new Error("Plan not found or access denied");
  }

  // Validate the pricing data using Zod schema
  const validationResult = priceDSLSchemaZod.safeParse(pricingData);
  if (!validationResult.success) {
    const errorMessages = validationResult.error.errors
      .map((err) =>
        err.path.length > 0
          ? `${err.path.join(".")}: ${err.message}`
          : err.message
      )
      .join("; ");
    throw new Error(`Invalid pricing data: ${errorMessages}`);
  }

  // Generate new component IDs for all components
  const updatedComponents = pricingData.components.map((component) => {
    // Generate a new component ID based on type and optional component_name
    const generatedId = generateComponentId(component.type);

    // Return component with the auto-generated ID
    return {
      ...component,
      component_id: generatedId,
    };
  });

  const updatedPricingData = {
    ...pricingData,
    components: updatedComponents,
  };

  const [newPrice] = await dbInstance
    .insert(prices)
    .values({
      id,
      planId,
      merchantId,
      currency,
      pricingData: updatedPricingData,
      isOverridePrice,
    })
    .returning();

  return newPrice;
}

// Define the new input type for associating features
export interface SubscriptionFeatureEntryInput {
  id: string; // feature.id
  slug: string; // feature.slug
  featureValue: FeatureValue;
  source: "plan" | "override";
}

export async function associateFeaturesWithSubscription(
  subscriptionId: string,
  customerId: string,
  merchantId: string,
  featuresWithSource: SubscriptionFeatureEntryInput[], // New parameter, expecting correct featureValue type
  dbInstance: DatabaseType | TransactionType = db
) {
  const subscriptionFeatureEntries = featuresWithSource.map(
    (featureDetails) => ({
      subscriptionId,
      customerId,
      merchantId,
      featureId: featureDetails.id,
      featureSlug: featureDetails.slug,
      featureValue: featureDetails.featureValue as FeatureValue,
      source: featureDetails.source,
    })
  );

  const createdEntries = await dbInstance
    .insert(subscriptionFeatures)
    .values(subscriptionFeatureEntries)
    .returning();

  return createdEntries;
}

/**
 * Gets and increments the invoice number for a specific merchant and customer.
 * Creates the counter record if it doesn't exist.
 * Should be called within a transaction to ensure atomicity.
 * Uses database row locking to prevent race conditions with concurrent invoice generation.
 *
 * @param tx The database transaction instance
 * @param merchantId The merchant ID
 * @param customerId The customer ID
 * @returns The next invoice number for this merchant-customer pair
 */
export async function getAndIncrementInvoiceCounter(
  tx: TransactionType,
  merchantId: string,
  customerId: string
): Promise<number> {
  // Validate IDs
  if (!merchantId || !customerId) {
    throw new Error("Merchant ID and Customer ID are required");
  }

  // Atomic upsert to avoid race conditions and duplicate key errors under concurrency
  const [row] = await tx
    .insert(customerInvoiceCounters)
    .values({
      merchantId,
      customerId,
      lastInvoiceNumber: 1,
    })
    .onConflictDoUpdate({
      target: [
        customerInvoiceCounters.merchantId,
        customerInvoiceCounters.customerId,
      ],
      set: {
        lastInvoiceNumber: sql`${customerInvoiceCounters.lastInvoiceNumber} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      lastInvoiceNumber: customerInvoiceCounters.lastInvoiceNumber,
    });

  if (!row) {
    throw new Error("Failed to reserve next invoice number");
  }
  return row.lastInvoiceNumber;
}

/**
 * Formats a customer-specific invoice number using the customer's prefix and sequence number
 * @param prefix The customer's invoice prefix (can be null/undefined)
 * @param sequenceNumber The sequence number for this customer
 * @returns A formatted customer invoice number with dash separator (e.g., "CUST-0001")
 */
export function formatCustomerInvoiceNumber(
  prefix: string | null | undefined,
  sequenceNumber: number
): string {
  // Format the sequence number with leading zeros (4 digits)
  const formattedSequence = sequenceNumber.toString().padStart(4, "0");

  // Combine with the prefix and add a dash separator
  return prefix ? `${prefix}-${formattedSequence}` : formattedSequence;
}

/**
 * Checks if two dates are on the same day WITH TIMEZONE
 * @param nowDate The current date
 * @param nextBillingDate The next billing date
 * @param timezone The timezone to use for comparison (IANA timezone format)
 * @returns True if the dates are on the same day in the specified timezone, false otherwise
 * @deprecated Use the isSameDay function from utils.ts instead
 */
export const isDateMatching = (
  nowDate: Date,
  nextBillingDate: Date,
  timezone: string = "UTC"
) => {
  // Use the isSameDay function from utils.ts if timezone is provided
  if (timezone !== "UTC") {
    return isSameDay(nowDate, nextBillingDate, timezone);
  }

  // Legacy implementation for backwards compatibility
  const billingTimezone = nextBillingDate.getTimezoneOffset();
  const now = new Date(nowDate); // Create a copy to avoid modifying the original
  now.setMinutes(now.getMinutes() + billingTimezone);

  return (
    now.getFullYear() === nextBillingDate.getFullYear() &&
    now.getMonth() === nextBillingDate.getMonth() &&
    now.getDate() === nextBillingDate.getDate()
  );
};

/**
 * Calculate usage value for a specific component and billing period
 * Handles QuestDB service failures gracefully with PostgreSQL fallback
 *
 * @param merchantId The merchant ID
 * @param customerId The customer ID
 * @param metric The metric object containing all necessary information
 * @param componentType The type of price component (per_unit, usage, fixed)
 * @param startDate The start of the billing period
 * @param endDate The end of the billing period
 * @param subscriptionId The subscription ID (needed for seat-based metrics)
 * @returns The calculated usage value
 */
export async function calculateUsageForComponent(
  merchantId: string,
  customerId: string,
  metric: {
    id: string;
    queryType: "simple" | "indexed" | "complex";
    eventName?: string | null;
    aggregationType?:
      | "COUNT"
      | "SUM"
      | "MAX"
      | "MIN"
      | "AVG"
      | "UNIQUE_COUNT"
      | null;
    valueType?: "NUMERIC" | "STRING" | null;
    sqlDefinition?: string | null;
  },
  componentType: "per_unit" | "usage" | "fixed",
  startDate: Date,
  endDate: Date,
  subscriptionId?: string
): Promise<number> {
  let externalCustomerId: string | undefined;
  try {
    // Resolve external customer id to ensure we match events recorded with either internal or external id
    const customerRecord = await db.query.customers.findFirst({
      where: and(
        eq(customers.id, customerId),
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt)
      ),
    });
    externalCustomerId = customerRecord?.externalCustomerId || undefined;

    // Try QuestDB first
    // Import DB client and events schema - needed for both paths

    try {
      // Build request parameters based on the metric type
      switch (metric.queryType) {
        case "simple":
          if (
            !metric.eventName ||
            !metric.aggregationType ||
            !metric.valueType
          ) {
            throw new Error(
              `Simple metric ${metric.id} missing required fields`
            );
          }

          // Query the metric with the correct parameters
          const simpleResult = await questDbService.queryMetrics({
            merchantId,
            customerId,
            externalCustomerId,
            metricType: "simple",
            eventName: metric.eventName,
            aggregation: metric.aggregationType,
            valueType: metric.valueType,
            timeframe: {
              type: "ABSOLUTE",
              start: startDate,
              end: endDate,
            },
          });

          // If successful, return the calculated value or 0 if null
          if (simpleResult.value !== null && simpleResult.value !== undefined) {
            logger.info(
              `Successfully retrieved usage from QuestDB for metric ${metric.id}`
            );
            return simpleResult.value;
          }

          if (simpleResult.error) {
            throw new Error(`QuestDB query error: ${simpleResult.error}`);
          }

          // If we got here, result.value is null but no error
          logger.warn(`QuestDB returned null value for metric ${metric.id}`);
          return 0;

        case "indexed":
        case "complex":
          if (!metric.sqlDefinition) {
            throw new Error(
              `${metric.queryType} metric ${metric.id} missing sqlDefinition`
            );
          }

          // For seat-based metrics (per_unit components), inject subscription_id and billing period parameters
          if (componentType === "per_unit" && subscriptionId) {
            // This is a seat-based metric that needs subscription_id injection
            const seatResult = await questDbService.queryMetrics({
              merchantId,
              customerId,
              metricType: metric.queryType,
              rawSql: metric.sqlDefinition,
              rawValues: [
                merchantId, // $1
                customerId, // $2
                subscriptionId, // $3
                startDate.toISOString(), // $4 (billing period start)
                endDate.toISOString(), // $5 (billing period end)
              ],
              timeframe: {
                // ignored when rawSql is provided
                type: "ABSOLUTE",
                start: startDate,
                end: endDate,
              },
            });

            if (seatResult.value !== null && seatResult.value !== undefined) {
              logger.info(
                `Successfully retrieved seat count from QuestDB for metric ${metric.id}: ${seatResult.value}`
              );
              return seatResult.value;
            }

            if (seatResult.error) {
              throw new Error(
                `QuestDB seat metric query error: ${seatResult.error}`
              );
            }

            logger.warn(
              `QuestDB returned null value for seat metric ${metric.id}`
            );
            return 0;
          } else {
            // Standard complex metric handling (existing logic)
            const complexResult = await questDbService.queryMetrics({
              merchantId,
              customerId,
              externalCustomerId,
              metricType: metric.queryType,
              sqlQuery: metric.sqlDefinition,
              timeframe: {
                type: "ABSOLUTE",
                start: startDate,
                end: endDate,
              },
            });

            if (
              complexResult.value !== null &&
              complexResult.value !== undefined
            ) {
              logger.info(
                `Successfully retrieved usage from QuestDB for ${metric.queryType} metric ${metric.id}`
              );
              return complexResult.value;
            }

            if (complexResult.error) {
              throw new Error(`QuestDB query error: ${complexResult.error}`);
            }

            logger.warn(`QuestDB returned null value for metric ${metric.id}`);
            return 0;
          }

        default:
          throw new Error(`Unknown metric type: ${metric.queryType}`);
      }
    } catch (questDbError) {
      // QuestDB query failed, log and try PostgreSQL fallback
      logger.warn(
        `QuestDB query failed, falling back to PostgreSQL events`,
        JSON.stringify({
          error:
            questDbError instanceof Error
              ? questDbError.message
              : String(questDbError),
          metricId: metric.id,
          merchantId,
          customerId,
        })
      );

      // Fall through to PostgreSQL fallback
      throw questDbError;
    }
  } catch (error) {
    // At this point, QuestDB has failed, try PostgreSQL fallback
    try {
      logger.info(`Attempting PostgreSQL fallback for metric ${metric.id}`);

      // Special case for seat-based metrics (per_unit components)
      if (componentType === "per_unit" && subscriptionId) {
        logger.info(
          `Using PostgreSQL fallback for seat-based metric ${metric.id}`
        );

        const customerMatch = externalCustomerId
          ? or(
              eq(events.customerId, customerId),
              eq(events.extCustomerId, externalCustomerId)
            )
          : eq(events.customerId, customerId);

        // PostgreSQL equivalent of the seat-based query
        // Step 1: Get users active at billing period start
        const usersBeforePeriod = await db
          .select({
            user_id: events.eventString,
            event_name: events.eventName,
            event_timestamp: events.eventTimestamp,
          })
          .from(events)
          .where(
            and(
              eq(events.merchantId, merchantId),
              customerMatch,
              inArray(events.eventName, ["seat_added", "seat_removed"]),
              lte(events.eventTimestamp, startDate),
              isNull(events.deletedAt)
            )
          )
          .orderBy(events.eventTimestamp);

        // Get latest event for each user before the billing period
        const userEventsBeforePeriod = new Map<
          string,
          { eventName: string; timestamp: Date }
        >();
        for (const row of usersBeforePeriod) {
          const userId = row.user_id;
          if (!userId) continue;

          const current = userEventsBeforePeriod.get(userId);
          if (!current || row.event_timestamp > current.timestamp) {
            userEventsBeforePeriod.set(userId, {
              eventName: row.event_name,
              timestamp: row.event_timestamp,
            });
          }
        }

        // Users active at period start
        const usersActiveAtPeriodStart = new Set<string>();
        for (const [userId, latestEvent] of userEventsBeforePeriod) {
          if (latestEvent.eventName === "seat_added") {
            usersActiveAtPeriodStart.add(userId);
          }
        }

        // Step 2: Get users added during the billing period
        const usersAddedDuringPeriod = await db
          .select({
            user_id: events.eventString,
          })
          .from(events)
          .where(
            and(
              eq(events.merchantId, merchantId),
              customerMatch,
              eq(events.eventName, "seat_added"),
              gte(events.eventTimestamp, startDate),
              lte(events.eventTimestamp, endDate),
              isNull(events.deletedAt)
            )
          );

        const usersAddedDuringPeriodSet = new Set<string>();
        for (const row of usersAddedDuringPeriod) {
          if (row.user_id) {
            usersAddedDuringPeriodSet.add(row.user_id);
          }
        }

        // Step 3: Combine both sets (union)
        const allBillableUsers = new Set([
          ...usersActiveAtPeriodStart,
          ...usersAddedDuringPeriodSet,
        ]);

        const activeUserCount = allBillableUsers.size;

        logger.info(
          `Successfully retrieved seat count from PostgreSQL fallback for metric ${metric.id}: ${activeUserCount}`
        );
        return activeUserCount;
      }

      // Standard fallback for simple metrics
      const eventName = metric.eventName;

      if (!eventName) {
        logger.warn(`No event name found for metric ${metric.id}`);
        return 0;
      }

      // Query PostgreSQL events table as fallback
      const result = await db
        .select({
          // Based on the metric, we want different aggregations
          count: count(),
          sum: sum(events.eventValue),
          avg: avg(events.eventValue),
        })
        .from(events)
        .where(
          and(
            eq(events.merchantId, merchantId),
            externalCustomerId
              ? or(
                  eq(events.customerId, customerId),
                  eq(events.extCustomerId, externalCustomerId)
                )
              : eq(events.customerId, customerId),
            eq(events.eventName, eventName),
            gte(events.eventTimestamp, startDate),
            lte(events.eventTimestamp, endDate),
            isNull(events.deletedAt)
          )
        );

      // Determine the right aggregation to use based on the metric
      let value = 0;
      if (result.length > 0) {
        // Use the appropriate aggregation based on the metric type
        if (metric.aggregationType === "SUM" && result[0].sum !== null) {
          value = Number(result[0].sum);
          logger.info(`Using sum aggregation from PostgreSQL: ${value}`);
        } else if (metric.aggregationType === "AVG" && result[0].avg !== null) {
          value = Number(result[0].avg);
          logger.info(`Using avg aggregation from PostgreSQL: ${value}`);
        } else {
          // Default to COUNT if no matching aggregation or for COUNT metrics
          value = Number(result[0].count);
          logger.info(`Using count aggregation from PostgreSQL: ${value}`);
        }
      }

      logger.info(
        `Successfully retrieved usage from PostgreSQL fallback for metric ${metric.id}`,
        JSON.stringify({
          metricId: metric.id,
          usage: value,
        })
      );

      return value;
    } catch (pgError) {
      // Both QuestDB and PostgreSQL failed
      logger.error(
        `Both QuestDB and PostgreSQL fallback failed for metric ${metric.id}`,
        {
          originalError: error instanceof Error ? error.message : String(error),
          fallbackError:
            pgError instanceof Error ? pgError.message : String(pgError),
          metricId: metric.id,
          merchantId,
          customerId,
        }
      );

      // Return 0 as last resort to avoid blocking billing
      // In a production system, we might want to add monitoring alerts for this case
      return 0;
    }
  }
}

/**
 * Generate line items for a specific component, calculating usage if needed
 * @param component The price component to generate line items for
 * @param merchantId The merchant ID
 * @param customerId The customer ID
 * @param billingPeriodStart The start of the billing period
 * @param billingPeriodEnd The end of the billing period
 * @param priceId The price ID
 * @param subscriptionId The subscription ID (needed for seat-based metrics)
 * @returns The line item data for the component
 */
export async function generateLineItemObjectForComponent(
  component: PriceComponentSchemaType,
  merchantId: string,
  customerId: string,
  billingPeriodStart: Date,
  billingPeriodEnd: Date,
  priceId: string,
  subscriptionId?: string
): Promise<{
  type: string;
  description: string;
  subtotalCents: number;
  componentId: string;
  priceId: string;
  quantity?: number;
  unitAmountCents?: number;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  metricId?: string;
}> {
  let subtotalCents = 0;
  let quantity: number | undefined;
  let unitAmountCents: number | undefined;
  let metricId: string | undefined;

  switch (component.type) {
    case "fixed":
      // Fixed price components have a simple amount
      // For now, we only support buying one unit at a time
      quantity = 1;
      unitAmountCents = component.amount_cents;
      subtotalCents = component.amount_cents;
      break;

    case "per_unit":
      // Per-unit pricing requires calculating quantity from metrics (e.g., seat count)
      if (component.metric_id) {
        // Fetch metric information
        const metric = await db.query.metrics.findFirst({
          where: and(
            eq(metrics.id, component.metric_id),
            eq(metrics.merchantId, merchantId),
            isNull(metrics.deletedAt)
          ),
        });

        if (!metric) {
          throw new Error(`Metric ${component.metric_id} not found`);
        }

        // Use metric to calculate quantity (e.g., unique seat count)
        metricId = component.metric_id;
        quantity = await calculateUsageForComponent(
          merchantId,
          customerId,
          metric,
          "per_unit",
          billingPeriodStart,
          billingPeriodEnd,
          subscriptionId
        );
      } else {
        // Fallback to quantity=1 if no metric specified
        quantity = 1;
      }
      // ---------------------------------------------
      // Apply minimum-seat logic (num_seats)
      // ---------------------------------------------
      const minSeats =
        typeof component.num_seats === "number" ? component.num_seats || 0 : 0;

      if (minSeats > 0) {
        quantity = Math.max(quantity || 0, minSeats);
      }

      unitAmountCents = component.amount_cents;
      subtotalCents = unitAmountCents * quantity;
      break;

    case "usage":
      // Usage-based pricing requires calculating actual usage from metrics
      // NOTE: No credit deductions here - credits are handled separately
      console.log("calculateUsageForComponent", component.metric_id);

      // Fetch metric information
      const usageMetric = await db.query.metrics.findFirst({
        where: and(
          eq(metrics.id, component.metric_id),
          eq(metrics.merchantId, merchantId),
          isNull(metrics.deletedAt)
        ),
      });

      if (!usageMetric) {
        throw new Error(`Metric ${component.metric_id} not found`);
      }

      metricId = component.metric_id;
      quantity = await calculateUsageForComponent(
        merchantId,
        customerId,
        usageMetric,
        "usage",
        billingPeriodStart,
        billingPeriodEnd,
        subscriptionId
      );

      unitAmountCents = component.unit_cost_cents;
      subtotalCents = unitAmountCents * quantity;
      break;

    default:
      // should never get here
      throw new Error(`Unsupported component type`);
  }

  return {
    type: component.type,
    description: component.label,
    subtotalCents,
    componentId: component.component_id,
    priceId,
    quantity,
    unitAmountCents,
    billingPeriodStart,
    billingPeriodEnd,
    metricId,
  };
}

interface ProcessedSubscriptionDetail {
  subDetail: typeof subscriptionDetails.$inferSelect & {
    subscription: typeof subscriptions.$inferSelect & {
      price: typeof prices.$inferSelect;
    };
  };
  component: PriceComponentSchemaType;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
}

/**
 * Generate usage credit line items with monetary conversion
 * This function converts usage credits to their monetary equivalent based on the component's unit price
 */
export async function generateUsageCreditLineItems(
  context: {
    merchantId: string;
    customerId: string;
    customersToBill?: (typeof customers.$inferSelect)[]; // All customers to check for credits
    processedDetails: ProcessedSubscriptionDetail[];
    billingSessionId?: string;
  },
  tx: TransactionType
): Promise<
  {
    type: string;
    description: string;
    subtotalCents: number;
    componentId: string;
    priceId: string;
    quantity: number;
    unitAmountCents: number;
    billingPeriodStart: Date;
    billingPeriodEnd: Date;
    metricId?: string;
  }[]
> {
  console.log("Starting generateUsageCreditLineItems", {
    merchantId: context.merchantId,
    customerId: context.customerId,
    customersToBill: context.customersToBill?.length || 1,
    processedDetailsCount: context.processedDetails.length,
    billingSessionId: context.billingSessionId,
  });

  const usageCreditLineItems = [];

  // Determine which customers to check for credits
  const customersToCheck = context.customersToBill || [
    { id: context.customerId } as typeof customers.$inferSelect,
  ];

  for (const data of context.processedDetails) {
    const { component, billingPeriodStart, billingPeriodEnd } = data;
    const priceId = data.subDetail.subscription.price.id;

    console.log("Processing component", {
      componentId: component.component_id,
      componentType: component.type,
      priceId,
      billingPeriodStart,
      billingPeriodEnd,
    });

    // Only process usage components
    if (component.type !== "usage") {
      console.log("Skipping non-usage component", {
        componentId: component.component_id,
      });
      continue;
    }

    // Fetch metric information once for this component
    const creditMetric = await tx.query.metrics.findFirst({
      where: and(
        eq(metrics.id, component.metric_id),
        eq(metrics.merchantId, context.merchantId),
        isNull(metrics.deletedAt)
      ),
    });

    if (!creditMetric) {
      console.log("Metric not found for credits calculation", {
        componentId: component.component_id,
        metricId: component.metric_id,
      });
      continue;
    }

    // Process credits for each customer
    for (const customerToCheck of customersToCheck) {
      const customerIdToCheck = customerToCheck.id;

      // Check for billing-visible usage credits for this customer
      const billingVisibleCredits = await tx.query.creditGrants.findMany({
        where: and(
          eq(creditGrants.merchantId, context.merchantId),
          eq(creditGrants.customerId, customerIdToCheck),
          eq(creditGrants.priceId, priceId),
          eq(creditGrants.priceComponentId, component.component_id),
          eq(creditGrants.applicationType, "usage"),
          or(
            gte(creditGrants.expiryDate, new Date()),
            isNull(creditGrants.expiryDate)
          ),
          lte(creditGrants.startDate, new Date()),
          eq(creditGrants.billingVisible, true),
          isNull(creditGrants.deletedAt)
        ),
        with: {
          creditDefinition: true,
        },
      });

      console.log("Found billing visible credits", {
        componentId: component.component_id,
        customerId: customerIdToCheck,
        creditCount: billingVisibleCredits.length,
      });

      if (billingVisibleCredits.length === 0) {
        console.log("No billing visible credits found for customer", {
          componentId: component.component_id,
          customerId: customerIdToCheck,
        });
        continue;
      }

      // Calculate actual usage for this customer
      const rawUsage = await calculateUsageForComponent(
        context.merchantId,
        customerIdToCheck,
        creditMetric,
        component.type as "per_unit" | "usage" | "fixed",
        billingPeriodStart,
        billingPeriodEnd,
        data.subDetail.subscription.id
      );

      console.log("Calculated raw usage", {
        componentId: component.component_id,
        customerId: customerIdToCheck,
        rawUsage,
        metricId: component.metric_id,
      });

      if (rawUsage === 0) {
        continue; // No usage for this customer
      }

      // Apply usage credits and record transactions
      const creditsApplied = await applyUsageCreditsForBilling(
        {
          merchantId: context.merchantId,
          customerId: customerIdToCheck,
          priceId: priceId,
          componentId: component.component_id,
          amount: rawUsage,
          invoiceId: null, // Will be updated later
          billingSessionId: context.billingSessionId,
          billingPeriodStart,
          billingPeriodEnd,
        },
        tx
      );

      console.log("Applied usage credits", {
        componentId: component.component_id,
        customerId: customerIdToCheck,
        creditsApplied,
      });

      if (creditsApplied > 0) {
        // Convert usage credits to monetary value using the component's unit price
        const creditValueCents = creditsApplied * component.unit_cost_cents;

        // Get currency from the subscription price
        const currency = data.subDetail.subscription.price.currency;

        // Format the unit cost properly using Dinero.js
        const unitCostFormatted = Dinero({
          amount: component.unit_cost_cents,
          currency: currency as Currency,
        }).toFormat();

        // Generate description that respects the credit definition's billingDescription
        let description: string;
        if (
          billingVisibleCredits.length === 1 &&
          billingVisibleCredits[0].creditDefinition
        ) {
          // Single credit - use its billing description with usage details
          const creditDef = billingVisibleCredits[0].creditDefinition;
          const creditName = creditDef.billingDescription || creditDef.name;
          description = `${creditName} (${creditsApplied} units × ${unitCostFormatted})`;
        } else {
          // Multiple credits or fallback - use generic description
          description = `Usage credits applied (${creditsApplied} units × ${unitCostFormatted})`;
        }

        // Add customer identifier for seat-based plans
        if (customersToCheck.length > 1) {
          // Use email if available, otherwise use external customer ID
          const customerIdentifier =
            (customerToCheck as any).email ||
            (customerToCheck as any).externalCustomerId ||
            customerToCheck.id;
          description = `${description} (${customerIdentifier})`;
        }

        usageCreditLineItems.push({
          type: "credit",
          description,
          subtotalCents: -creditValueCents, // Negative because it's a credit
          componentId: component.component_id,
          priceId,
          quantity: creditsApplied,
          unitAmountCents: -component.unit_cost_cents, // Negative unit amount for credits
          billingPeriodStart,
          billingPeriodEnd,
          metricId: component.metric_id,
        });

        console.log(
          `Generated usage credit line item for component ${component.component_id}`,
          {
            creditsApplied,
            creditValueCents,
            merchantId: context.merchantId,
            customerId: customerIdToCheck,
            priceId,
            componentId: component.component_id,
            unitCostFormatted,
          }
        );
      }
    }
  }

  console.log("Completed generateUsageCreditLineItems", {
    lineItemsGenerated: usageCreditLineItems.length,
  });

  return usageCreditLineItems;
}

/**
 * @deprecated This function is no longer used. Tests should be updated to use the webhook instead.
 * Creates a subscription with an associated invoice and payment
 * This function handles the entire flow of:
 * 1. Creating a subscription
 * 2. Generating a single invoice with line items for all components that need immediate billing
 * 3. Creating a payment record
 *
 * @param merchantId The ID of the merchant
 * @param customerId The ID of the customer
 * @param planId The ID of the plan
 * @param effectivePriceId The ID of the price to use
 * @param startTimestamp The timestamp when the subscription should start
 * @param paymentMethodId The ID of the payment method to use
 * @returns The created subscription, invoice, and payment
 */
export async function createSubscriptionWithInvoiceAndPayment({
  merchantId,
  customerId,
  planId,
  effectivePriceId,
  startTimestamp,
  paymentMethodId,
}: {
  merchantId: string;
  customerId: string;
  planId: string;
  effectivePriceId: string;
  startTimestamp: Date;
  paymentMethodId?: string;
}) {
  return await db.transaction(async (tx) => {
    // 1. Create the subscription
    const { subscription, subscriptionDetailsRecords } =
      await createSubscriptionCore({
        merchantId,
        customerId,
        planId,
        effectivePriceId,
        startTimestamp,
        paymentMethodId,
        isImmediatePayment: true, // This function creates subscription with immediate payment
        dangerouslyAllowMultipleSubscriptions: false,
        tx,
      });

    if (!subscription) {
      throw new Error("Failed to create subscription");
    }

    // Get the price details to calculate the amount
    const price = await tx.query.prices.findFirst({
      where: and(
        eq(prices.id, effectivePriceId),
        eq(prices.merchantId, merchantId),
        isNull(prices.deletedAt)
      ),
    });

    if (!price) {
      throw new Error("Price not found");
    }

    // Get the customer to check for invoice prefix
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, customerId),
    });

    // 2. Find components that should be billed immediately
    const immediateComponents = price.pricingData.components.filter(
      (component) => component.bill_immediately !== false
    );

    logger.info(
      `Found ${immediateComponents.length} components for immediate billing`
    );

    // Generate line items for immediate billing components
    const lineItemPromises = immediateComponents.map((component) =>
      generateLineItemObjectForComponent(
        component,
        merchantId,
        customerId,
        startTimestamp, // Billing period start = subscription start
        subscriptionDetailsRecords.find(
          (sd) => sd.componentId === component.component_id
        )?.nextBillingDate || startTimestamp,
        price.id,
        subscription.id
      )
    );

    const lineItems = await Promise.all(lineItemPromises);

    // Calculate total amount
    const totalAmountCents = lineItems.reduce(
      (total, item) => total + item.subtotalCents,
      0
    );

    if (lineItems.length > 0) {
      // Create a single invoice for all components
      const [invoice] = await tx
        .insert(invoices)
        .values({
          merchantId,
          customerId,
          subscriptionId: subscription.id,
          status: "draft",
          totalAmountCents,
          currency: price.currency,
          dueDate: startTimestamp, // Due immediately
          issueDate: new Date(),
          billingPeriodStart: startTimestamp,
          billingPeriodEnd: (() => {
            const immediateIds = new Set(
              immediateComponents.map((c) => c.component_id)
            );
            const ends = subscriptionDetailsRecords
              .filter((sd) => immediateIds.has(sd.componentId))
              .map((sd) => new Date(sd.nextBillingDate).getTime());
            if (ends.length === 0) return null;
            return new Date(Math.max(...ends));
          })(),
        })
        .returning();

      // Get the next invoice number
      const sequenceNumber = await getAndIncrementInvoiceCounter(
        tx,
        merchantId,
        customerId
      );

      // Format the customer invoice number
      const customerInvoiceNumber = formatCustomerInvoiceNumber(
        customer?.invoicePrefix,
        sequenceNumber
      );

      // Update the invoice with the customer invoice number
      await tx
        .update(invoices)
        .set({
          customerInvoiceNumber,
          status: "paid", // Change status to paid
        })
        .where(eq(invoices.id, invoice.id));

      const lineItemsToInsert = lineItems.map((item) => ({
        invoiceId: invoice.id,
        type: item.type,
        componentId: item.componentId,
        description: item.description,
        quantity: item.quantity,
        unitAmountCents: item.unitAmountCents,
        subtotalCents: item.subtotalCents,
        billingPeriodStart: item.billingPeriodStart,
        billingPeriodEnd: item.billingPeriodEnd,
        metricId: item.metricId,
      }));

      // Create invoice line items (all in a single invoice)
      const createdLineItems = await tx
        .insert(invoiceLineItems)
        .values(lineItemsToInsert)
        .returning();

      // Update all corresponding subscription details records to mark as billed
      for (const component of immediateComponents) {
        const subDetails = subscriptionDetailsRecords.find(
          (record) => record.componentId === component.component_id
        );

        if (subDetails) {
          await tx
            .update(subscriptionDetails)
            .set({
              previousBillingDate: startTimestamp,
              cyclesBilled: 1, // Mark as having been billed once
            })
            .where(
              and(
                eq(subscriptionDetails.id, subDetails.id),
                isNull(subscriptionDetails.deletedAt)
              )
            );
        }
      }

      // Create a payment record
      const [payment] = await tx
        .insert(payments)
        .values({
          merchantId,
          invoiceId: invoice.id,
          paymentMethodId,
          amountCents: totalAmountCents,
          currency: price.currency,
          status: "pending", // Initial status before processing
        })
        .returning();

      logger.info(
        `Created initial invoice with ${lineItems.length} line items for immediate billing`
      );

      return {
        subscription,
        invoice: {
          ...invoice,
          customerInvoiceNumber,
          lineItems: createdLineItems,
        },
        payment,
      };
    } else {
      logger.info(
        "No components marked for immediate billing - no invoice created"
      );

      // Return subscription only, no invoice or payment created
      return {
        subscription,
        invoice: null,
        payment: null,
      };
    }
  });
}

/**
 * Generates PDF locally for development environment
 * @param invoiceWithDetails The invoice object with related data
 * @returns Promise that resolves when the PDF is generated and uploaded
 */
async function generateInvoicePdfLocally(
  invoiceWithDetails: any,
  tx?: TransactionType
): Promise<void> {
  try {
    logger.info(`Generating PDF locally for invoice ${invoiceWithDetails.id}`);

    // Format the invoice data as expected by the PDF generation function
    const pdfInvoice: InvoiceCompleteAPI =
      formatInvoiceWithDetailsToCompleteAPI(invoiceWithDetails);

    // Generate PDF using the same logic as the trigger job
    const pdfResults = await processInvoicePdfGeneration([pdfInvoice]);

    const pdfResult = pdfResults.generatedPdfs[0];
    if (pdfResult.status === "failed" || !pdfResult.pdfBuffer) {
      throw new Error(
        `PDF generation failed: ${pdfResult.error || "Unknown error"}`
      );
    }

    // Upload PDF to storage
    logger.info(
      `Uploading PDF to storage for invoice ${invoiceWithDetails.id}`
    );
    await uploadFile(
      pdfResult.fileName,
      pdfResult.pdfBuffer,
      "application/pdf"
    );
    const pdfUrl = getObjectStorageUrl(pdfResult.fileName);

    // Update invoice record in database
    const dbInstance = tx || db;
    await dbInstance
      .update(invoices)
      .set({
        pdfUrl,
      })
      .where(eq(invoices.id, invoiceWithDetails.id));

    logger.info(
      `Successfully generated PDF locally for invoice ${invoiceWithDetails.id}: ${pdfUrl}`
    );
  } catch (error) {
    logger.error(
      `Failed to generate PDF locally for invoice ${invoiceWithDetails.id}`,
      error
    );
    throw error;
  }
}

/**
 * Formats invoice data and triggers the PDF generation job
 * @param invoice The invoice object with related data (customer, subscription, line items)
 * @returns Promise that resolves when the job is triggered
 */
export async function triggerInvoicePdfGeneration(
  invoiceWithDetails: any,
  tx?: TransactionType
): Promise<void> {
  try {
    const { name: paymentProviderName } = await getPaymentProvider(
      invoiceWithDetails.merchant.id
    );

    if (paymentProviderName === "dodo") {
      console.log(
        `Dodo is enabled for invoice ${invoiceWithDetails.id}, skipping PDF generation`
      );
      return;
    }

    if (!invoiceWithDetails) {
      throw new Error("No invoice data provided for PDF generation");
    }

    // Format the invoice data as expected by the PDF generation job
    const pdfInvoice: InvoiceCompleteAPI = {
      id: invoiceWithDetails.id,
      customerInvoiceNumber: invoiceWithDetails.customerInvoiceNumber,
      currency: invoiceWithDetails.currency,
      issueDate:
        invoiceWithDetails.issueDate instanceof Date
          ? invoiceWithDetails.issueDate
          : new Date(invoiceWithDetails.issueDate),
      dueDate:
        invoiceWithDetails.dueDate instanceof Date
          ? invoiceWithDetails.dueDate
          : new Date(invoiceWithDetails.dueDate),
      billingPeriodStartDate: invoiceWithDetails.billingPeriodStart,
      billingPeriodEndDate: invoiceWithDetails.billingPeriodEnd,
      // Add the critical tax-related fields so PDF shows correct breakdown
      subtotalCents: invoiceWithDetails.subtotalCents,
      taxAmountCents: invoiceWithDetails.taxAmountCents,
      totalAmountCents: invoiceWithDetails.totalAmountCents,
      effectiveTaxRate: invoiceWithDetails.effectiveTaxRate,
      taxJurisdiction: invoiceWithDetails.taxJurisdiction,
      taxCalculationMethod: invoiceWithDetails.taxCalculationMethod,
      notes: invoiceWithDetails.notes, // Add notes field for payment links
      documentType: invoiceWithDetails.documentType,
      originalInvoiceId: invoiceWithDetails.originalInvoiceId,
      cancellationOrCreditReason: invoiceWithDetails.cancellationOrCreditReason,
      originalInvoiceNumber:
        (invoiceWithDetails.originalInvoice &&
          (invoiceWithDetails.originalInvoice.customerInvoiceNumber ||
            invoiceWithDetails.originalInvoice.id)) ||
        undefined,
      originalIssueDate:
        (invoiceWithDetails.originalInvoice &&
          (invoiceWithDetails.originalInvoice.issueDate || undefined)) ||
        undefined,
      lineItems: (invoiceWithDetails.lineItems || []).map((item: any) => ({
        id: item.id,
        description: item.description,
        type: item.type, // Add the missing type field so tax items are properly identified
        quantity: item.quantity ?? undefined,
        unitAmountCents: item.unitAmountCents ?? undefined,
        subtotalCents: item.subtotalCents,
        taxMetadata: item.taxMetadata, // Include tax metadata for tax line items
      })),
      customer: invoiceWithDetails.customer && {
        id: invoiceWithDetails.customer.id,
        name: invoiceWithDetails.customer.name ?? "",
        email: invoiceWithDetails.customer.email ?? "",
        billingAddressLine1: invoiceWithDetails.customer.billingAddressLine1,
        billingAddressLine2: invoiceWithDetails.customer.billingAddressLine2,
        billingCity: invoiceWithDetails.customer.billingCity,
        billingStateProvince: invoiceWithDetails.customer.billingStateProvince,
        billingPostalCode: invoiceWithDetails.customer.billingPostalCode,
        billingCountry: invoiceWithDetails.customer.billingCountry,
        taxId: invoiceWithDetails.customer.taxId,
        invoicePrefix: invoiceWithDetails.customer.invoicePrefix,
        createdAt:
          invoiceWithDetails.customer.createdAt instanceof Date
            ? invoiceWithDetails.customer.createdAt
            : new Date(invoiceWithDetails.customer.createdAt),
        timezone: invoiceWithDetails.customer.timezone,
      },
      merchant: invoiceWithDetails.merchant && {
        id: invoiceWithDetails.merchant.id,
        legalName: invoiceWithDetails.merchant.legalName,
        displayName: invoiceWithDetails.merchant.displayName,
        taxId: invoiceWithDetails.merchant.taxId,
        addressLine1: invoiceWithDetails.merchant.addressLine1,
        addressLine2: invoiceWithDetails.merchant.addressLine2,
        city: invoiceWithDetails.merchant.city,
        stateProvince: invoiceWithDetails.merchant.stateProvince,
        postalCode: invoiceWithDetails.merchant.postalCode,
        country: invoiceWithDetails.merchant.country,
        billingEmail: invoiceWithDetails.merchant.billingEmail,
        timezone: invoiceWithDetails.merchant.timezone,
      },
    };

    // Trigger the PDF generation job
    await tasks.trigger<typeof generateInvoicePdfJob>("generate-invoice-pdf", {
      invoice: pdfInvoice,
    });

    logger.info(
      `Successfully triggered PDF generation for invoice ${invoiceWithDetails.id}`
    );
  } catch (error) {
    logger.error(
      `Failed to trigger PDF generation: ${error instanceof Error ? error.message : String(error)}`
    );

    // In development, fall back to local PDF generation
    if (env.NODE_ENV === "development") {
      logger.info(
        `Falling back to local PDF generation for invoice ${invoiceWithDetails.id}`
      );
      try {
        await generateInvoicePdfLocally(invoiceWithDetails, tx);
        logger.info(
          `Successfully generated PDF locally as fallback for invoice ${invoiceWithDetails.id}`
        );

        // Simulate email sending like in generateInvoicePdfJob
        const invoiceNumber =
          invoiceWithDetails.customerInvoiceNumber || invoiceWithDetails.id;
        console.info(
          `[DEV] Simulating invoice email job for invoice ${invoiceWithDetails.id}`,
          {
            invoiceId: invoiceWithDetails.id,
            customerEmail: invoiceWithDetails.customer?.email,
            invoiceNumber,
            emailJobId: "dev-local-email-job",
          }
        );

        return; // Success, don't throw the original error
      } catch (localError) {
        logger.error(
          `Local PDF generation also failed for invoice ${invoiceWithDetails.id}: ${localError instanceof Error ? localError.message : String(localError)}`
        );
        // Continue to throw the original error
      }
    }

    throw error;
  }
}

/**
 * Migrates a subscription from one plan/price to another
 * Handles soft-deletion of old subscription, creation of new subscription, and feature override migration
 */
export async function migrateSubscription({
  oldSubscription,
  targetPlan,
  targetPrice,
  merchantId,
}: {
  oldSubscription: typeof subscriptions.$inferSelect;
  targetPlan: Plan;
  targetPrice: Price;
  merchantId: string;
}): Promise<typeof subscriptions.$inferSelect> {
  const result = await db.transaction(async (tx) => {
    const currentTimestamp = new Date();

    // 1. Soft-delete the old subscription and its dependencies
    await tx
      .update(subscriptions)
      .set({
        deletedAt: currentTimestamp,
        endTimestamp: currentTimestamp,
      })
      .where(eq(subscriptions.id, oldSubscription.id));

    // Soft-delete associated subscription features
    await tx
      .update(subscriptionFeatures)
      .set({ deletedAt: currentTimestamp })
      .where(
        and(
          eq(subscriptionFeatures.subscriptionId, oldSubscription.id),
          isNull(subscriptionFeatures.deletedAt)
        )
      );

    // Soft-delete associated subscription details
    await tx
      .update(subscriptionDetails)
      .set({ deletedAt: currentTimestamp })
      .where(
        and(
          eq(subscriptionDetails.subscriptionId, oldSubscription.id),
          isNull(subscriptionDetails.deletedAt)
        )
      );

    // 1A. Detect and clone price override if necessary
    const oldPriceRecord = await tx.query.prices.findFirst({
      where: eq(prices.id, oldSubscription.effectivePriceId),
    });
    let effectivePriceIdToUse = targetPrice.id;
    if (oldPriceRecord && oldPriceRecord.isOverridePrice) {
      const [clonedPrice] = await tx
        .insert(prices)
        .values({
          merchantId,
          planId: targetPlan.id,
          currency: oldPriceRecord.currency,
          pricingData: oldPriceRecord.pricingData,
          isOverridePrice: true,
        })
        .returning();
      effectivePriceIdToUse = clonedPrice.id;
    }

    // 2. Create new subscription version (using shared helper which creates details & grants)
    const { subscription: newSubscription } = await createSubscriptionCore({
      merchantId,
      customerId: oldSubscription.customerId,
      planId: targetPlan.id,
      effectivePriceId: effectivePriceIdToUse,
      startTimestamp: oldSubscription.startTimestamp,
      stableSubscriptionId: oldSubscription.stableSubscriptionId,
      versionNumberOverride: oldSubscription.versionNumber + 1,
      isRenewal: true, // This is a migration, so use renewal amounts for credits
      dangerouslyAllowMultipleSubscriptions: false,
      tx,
    });

    // 3. Load plan features (for override migration)
    const newPlanFeatures = await getPlanFeatures(targetPlan.id, tx);

    // 3A. Migrate feature overrides from previous subscription
    await migrateFeatureOverrides({
      previousSubscriptionId: oldSubscription.id,
      newSubscriptionId: newSubscription.id,
      newPlanFeatureSlugs: new Set(newPlanFeatures.map((f) => f.slug)),
      customerId: oldSubscription.customerId,
      merchantId,
      tx,
    });

    // 3B. Disable old plan-scoped credit grants and expire if needed
    const oldPlanGrants = await tx.query.creditGrants.findMany({
      where: and(
        eq(creditGrants.customerId, oldSubscription.customerId),
        eq(creditGrants.planId, oldSubscription.planId),
        eq(creditGrants.scope, "plan"),
        isNull(creditGrants.deletedAt)
      ),
      with: {
        creditDefinition: true,
      },
    });

    if (oldPlanGrants.length > 0) {
      const allGrantIds = oldPlanGrants.map((g) => g.id);

      // 1. Disable future renewals on **all** old grants in one statement
      await tx
        .update(creditGrants)
        .set({ nextRenewalDate: null, updatedAt: new Date() })
        .where(inArray(creditGrants.id, allGrantIds));

      // 2. Immediately expire those whose definition has `expiryDays === -1`
      const expireGrantIds = oldPlanGrants
        .filter((g) => g.creditDefinition?.expiryDays === -1)
        .map((g) => g.id);

      if (expireGrantIds.length > 0) {
        await tx
          .update(creditGrants)
          .set({
            expiryDate: new Date(),
            status: "EXPIRED" as const,
            updatedAt: new Date(),
          })
          .where(inArray(creditGrants.id, expireGrantIds));
      }
    }

    return newSubscription;
  });

  return result;
}

/**
 * Creates an invoice or merges line items into an existing draft invoice
 * If a draft invoice exists for the customer/subscription, adds line items to it
 * Otherwise, creates a new invoice using the createInvoice function
 */
export async function createOrMergeIntoInvoice({
  merchantId,
  customerId,
  subscriptionId,
  lineItems,
  currency = "usd",
  description = "Invoice",
  status = "issued", // "issued" for immediate billing, "draft" for next cycle
}: {
  merchantId: string;
  customerId: string;
  subscriptionId?: string;
  lineItems: Array<{
    type: string;
    description: string;
    quantity?: number;
    unitAmountCents: number;
    subtotalCents: number;
    componentId?: string;
    priceId?: string;
    metricId?: string;
    billingPeriodStart: Date;
    billingPeriodEnd?: Date | null;
  }>;
  currency?: string;
  description?: string;
  status?: "issued" | "draft";
}): Promise<{
  success: boolean;
  invoice?: typeof invoices.$inferSelect;
  message: string;
  merged?: boolean; // Indicates if line items were merged into existing draft
}> {
  try {
    // If we're creating an issued invoice, always create a new one
    if (status === "issued") {
      const result = await createInvoice({
        merchantId,
        customerId,
        subscriptionId,
        lineItems,
        currency,
        description,
        status,
      });
      return {
        ...result,
        merged: false,
      };
    }

    // For draft invoices, check if there's an existing draft to merge into
    return await db.transaction(async (tx) => {
      // Find existing draft invoice for this customer/subscription
      const existingDraftInvoice = await tx.query.invoices.findFirst({
        where: and(
          eq(invoices.customerId, customerId),
          eq(invoices.merchantId, merchantId),
          subscriptionId
            ? eq(invoices.subscriptionId, subscriptionId)
            : isNull(invoices.subscriptionId),
          eq(invoices.status, "draft")
        ),
        with: {
          lineItems: true,
        },
      });

      // If no existing draft invoice, create a new one
      if (!existingDraftInvoice) {
        const result = await createInvoice({
          merchantId,
          customerId,
          subscriptionId,
          lineItems,
          currency,
          description,
          status,
        });
        return {
          ...result,
          merged: false,
        };
      }

      console.log(
        `Found existing draft invoice ${existingDraftInvoice.id} for customer ${customerId}, merging ${lineItems.length} new line items`
      );

      // Get customer for tax calculations
      const customer = await tx.query.customers.findFirst({
        where: and(eq(customers.id, customerId), isNull(customers.deletedAt)),
      });

      if (!customer) {
        return {
          success: false,
          message: "Customer not found",
          merged: false,
        };
      }

      // Calculate new totals including existing line items
      const existingSubtotal = existingDraftInvoice.subtotalCents || 0;
      const newLineItemsSubtotal = lineItems.reduce(
        (sum, item) => sum + item.subtotalCents,
        0
      );
      const totalSubtotal = existingSubtotal + newLineItemsSubtotal;

      // Apply taxes to the new total
      const allLineItemsForTax = [
        // Existing line items
        ...existingDraftInvoice.lineItems.map((item) => ({
          type: item.type || "charge",
          description: item.description,
          subtotalCents: item.subtotalCents,
          componentId: item.componentId || undefined,
          billingPeriodStart: item.billingPeriodStart || new Date(),
          billingPeriodEnd:
            item.billingPeriodEnd ||
            item.billingPeriodStart ||
            item.createdAt ||
            new Date(),
        })),
        // New line items
        ...lineItems.map((item) => ({
          type: item.type,
          description: item.description,
          subtotalCents: item.subtotalCents,
          componentId: item.componentId,
          priceId: item.priceId,
          billingPeriodStart: item.billingPeriodStart,
          billingPeriodEnd: item.billingPeriodEnd ?? item.billingPeriodStart,
        })),
      ];

      const taxData = await calculateTaxes({
        merchantId,
        customerId,
        subtotalAfterCredits: totalSubtotal,
        lineItems: allLineItemsForTax,
        currency,
        billingDate: new Date(),
      });

      const newTotalAmountCents = totalSubtotal + taxData.totalTaxCents;

      // Update the existing invoice with new totals
      await tx
        .update(invoices)
        .set({
          totalAmountCents: newTotalAmountCents,
          subtotalCents: totalSubtotal,
          taxAmountCents: taxData.totalTaxCents,
          effectiveTaxRate: taxData.effectiveTaxRate.toString(),
          taxJurisdiction: taxData.jurisdiction,
          taxCalculationMethod: taxData.calculationMethod,
          notes: description, // Update description
        })
        .where(eq(invoices.id, existingDraftInvoice.id));

      // Add new line items to the invoice
      const newLineItemsToInsert = lineItems.map((item) => ({
        invoiceId: existingDraftInvoice.id,
        type: item.type,
        componentId: item.componentId || null,
        description: item.description,
        quantity: item.quantity || 1,
        unitAmountCents: item.unitAmountCents,
        subtotalCents: item.subtotalCents,
        billingPeriodStart: item.billingPeriodStart,
        billingPeriodEnd: item.billingPeriodEnd ?? null,
        metricId: item.metricId || null,
      }));

      await tx.insert(invoiceLineItems).values(newLineItemsToInsert);

      // Add new tax line items if any
      if (taxData.taxLineItems.length > 0) {
        // First, remove existing tax line items
        await tx
          .delete(invoiceLineItems)
          .where(
            and(
              eq(invoiceLineItems.invoiceId, existingDraftInvoice.id),
              like(invoiceLineItems.type, "tax%")
            )
          );

        // Then add new tax line items
        const taxLineItemsToInsert = taxData.taxLineItems.map(
          (taxLineItem) => ({
            invoiceId: existingDraftInvoice.id,
            type: taxLineItem.type,
            componentId: null,
            description: taxLineItem.description,
            quantity: 1,
            unitAmountCents: taxLineItem.subtotalCents,
            subtotalCents: taxLineItem.subtotalCents,
            billingPeriodStart: taxLineItem.billingPeriodStart,
            billingPeriodEnd: taxLineItem.billingPeriodEnd,
            metricId: null,
            taxMetadata: taxLineItem.taxMetadata,
          })
        );

        await tx.insert(invoiceLineItems).values(taxLineItemsToInsert);
      }

      // Get the updated invoice to return
      // The updates invoices stays draft state, no PDF has been generated yet
      const updatedInvoice = await tx.query.invoices.findFirst({
        where: eq(invoices.id, existingDraftInvoice.id),
      });

      console.log(
        `Successfully merged ${lineItems.length} line items into existing draft invoice ${existingDraftInvoice.id}`
      );

      return {
        success: true,
        invoice: updatedInvoice!,
        message: `Line items merged into existing draft invoice`,
        merged: true,
      };
    });
  } catch (error) {
    console.error("Error creating or merging into invoice:", error);
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
      merged: false,
    };
  }
}

/**
 * Creates an invoice (either issued for immediate billing or draft for next cycle)
 * This is a clean invoice creation function without payment processing
 */
export async function createInvoice({
  merchantId,
  customerId,
  subscriptionId,
  lineItems,
  currency = "usd",
  description = "Invoice",
  status = "issued", // "issued" for immediate billing, "draft" for next cycle
}: {
  merchantId: string;
  customerId: string;
  subscriptionId?: string;
  lineItems: Array<{
    type: string;
    description: string;
    quantity?: number;
    unitAmountCents: number;
    subtotalCents: number;
    componentId?: string;
    priceId?: string;
    metricId?: string;
    billingPeriodStart: Date;
    billingPeriodEnd?: Date | null;
  }>;
  currency?: string;
  description?: string;
  status?: "issued" | "draft";
}): Promise<{
  success: boolean;
  invoice?: typeof invoices.$inferSelect;
  message: string;
}> {
  try {
    return await db.transaction(async (tx) => {
      // Get customer
      const customer = await tx.query.customers.findFirst({
        where: and(eq(customers.id, customerId), isNull(customers.deletedAt)),
      });

      if (!customer) {
        return {
          success: false,
          message: "Customer not found",
        };
      }

      // Calculate totals
      const subtotalCents = lineItems.reduce(
        (sum, item) => sum + item.subtotalCents,
        0
      );

      // Apply taxes
      const taxableLineItems = lineItems.map((item) => ({
        type: item.type,
        description: item.description,
        subtotalCents: item.subtotalCents,
        componentId: item.componentId,
        priceId: item.priceId,
        billingPeriodStart: item.billingPeriodStart,
        billingPeriodEnd: item.billingPeriodEnd ?? item.billingPeriodStart,
      }));

      const taxData = await calculateTaxes({
        merchantId,
        customerId,
        subtotalAfterCredits: subtotalCents,
        lineItems: taxableLineItems,
        currency,
        billingDate: new Date(),
      });

      const totalAmountCents = subtotalCents + taxData.totalTaxCents;

      // Generate invoice number only for issued invoices
      let customerInvoiceNumber = null;
      if (status === "issued") {
        const sequenceNumber = await getAndIncrementInvoiceCounter(
          tx,
          merchantId,
          customerId
        );
        customerInvoiceNumber = formatCustomerInvoiceNumber(
          customer.invoicePrefix || customer.id.slice(4, 10),
          sequenceNumber
        );
      }

      // Create invoice
      const [invoice] = await tx
        .insert(invoices)
        .values({
          merchantId,
          customerId,
          subscriptionId: subscriptionId || null,
          status:
            totalAmountCents === 0 && status === "issued" ? "paid" : status,
          totalAmountCents,
          subtotalCents,
          taxAmountCents: taxData.totalTaxCents,
          effectiveTaxRate: taxData.effectiveTaxRate.toString(),
          taxJurisdiction: taxData.jurisdiction,
          taxCalculationMethod: taxData.calculationMethod,
          currency,
          customerInvoiceNumber,
          dueDate: status === "issued" ? new Date() : null,
          issueDate: status === "issued" ? new Date() : null,
          billingPeriodStart: lineItems[0]?.billingPeriodStart || new Date(),
          billingPeriodEnd: lineItems[0]?.billingPeriodEnd ?? null,
          notes: description,
        })
        .returning();

      // Create line items (including tax line items)
      const allLineItems = [...lineItems];
      if (taxData.taxLineItems.length > 0) {
        for (const taxLineItem of taxData.taxLineItems) {
          allLineItems.push({
            type: taxLineItem.type,
            description: taxLineItem.description,
            quantity: 1,
            unitAmountCents: taxLineItem.subtotalCents,
            subtotalCents: taxLineItem.subtotalCents,
            billingPeriodStart: taxLineItem.billingPeriodStart,
            billingPeriodEnd: taxLineItem.billingPeriodEnd,
          });
        }
      }

      await tx.insert(invoiceLineItems).values(
        allLineItems.map((item, index) => ({
          invoiceId: invoice.id,
          type: item.type,
          componentId: item.componentId || null,
          description: item.description,
          quantity: item.quantity || 1,
          unitAmountCents: item.unitAmountCents,
          subtotalCents: item.subtotalCents,
          billingPeriodStart: item.billingPeriodStart,
          billingPeriodEnd: item.billingPeriodEnd ?? null,
          metricId: item.metricId || null,
          taxMetadata:
            index >= lineItems.length
              ? taxData.taxLineItems[index - lineItems.length]?.taxMetadata
              : null,
        }))
      );

      // Generate PDF only for issued invoices
      if (status === "issued") {
        // PDF generation skipped for Dodo but invoice has the correct amounts
        await triggerInvoicePdfGeneration(
          {
            ...invoice,
            merchant: { id: merchantId } as any,
            customer: customer as any,
            subscription: null,
            lineItems: allLineItems as any,
          },
          tx
        );
      }

      return {
        success: true,
        invoice,
        message:
          status === "issued"
            ? "Invoice created and issued"
            : "Draft invoice created",
      };
    });
  } catch (error) {
    console.error("Error creating invoice:", error);
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * Initiate trial-to-paid upgrade using PaymentIntent and webhook flow
 * This creates a PaymentIntent and lets the existing webhook handle the upgrade
 */
export async function initiateTrialToPaymentUpgrade({
  oldSubscription,
  targetPlan,
  targetPrice,
  merchantId,
}: {
  oldSubscription: typeof subscriptions.$inferSelect;
  targetPlan: Plan;
  targetPrice: Price;
  merchantId: string;
}): Promise<{
  success: boolean;
  paymentIntentId?: string;
  message: string;
  error?: string;
}> {
  try {
    // 1. Get customer timezone for proper billing date calculations
    const effectiveTimezone = await getEffectiveTimezone(
      oldSubscription.customerId,
      merchantId
    );

    // 2. Calculate line items for billing using the same RRULE engine
    const currentBillingPeriodStart = new Date();
    const lineItems = [];

    for (const component of targetPrice.pricingData.components) {
      // Skip usage-based components for the initial invoice
      if (component.type === "usage") continue;

      // Use the same billing engine as the rest of the system
      const billingPeriodEnd = calculateNextBillingDate(
        component,
        currentBillingPeriodStart,
        currentBillingPeriodStart, // For first period, start and subscription start are the same
        effectiveTimezone
      );

      lineItems.push({
        type: "subscription",
        description: `${targetPlan.planName} - ${component.label || "subscription"}`,
        subtotalCents: component.amount_cents || 0,
        componentId: component.component_id,
        billingPeriodStart: currentBillingPeriodStart,
        billingPeriodEnd,
      });
    }

    // 3. Calculate subtotal
    const subtotalCents = lineItems.reduce(
      (sum, item) => sum + item.subtotalCents,
      0
    );

    // 4. Calculate taxes directly using the tax engine
    const taxResult = await calculateTaxes({
      merchantId,
      customerId: oldSubscription.customerId,
      subtotalAfterCredits: subtotalCents,
      lineItems: lineItems.map((item) => ({
        type: item.type,
        description: item.description,
        subtotalCents: item.subtotalCents,
        componentId: item.componentId,
        billingPeriodStart: item.billingPeriodStart,
        billingPeriodEnd: item.billingPeriodEnd,
      })),
      currency: targetPrice.currency,
      billingDate: currentBillingPeriodStart,
    });

    const totalAmountCents = subtotalCents + taxResult.totalTaxCents;

    // 5. Charge the customer using the new abstraction
    const paymentResult = await chargeCustomerWithAmount({
      customerId: oldSubscription.customerId,
      merchantId,
      amountCents: totalAmountCents,
      currency: targetPrice.currency,
      description: `Trial-to-paid upgrade: ${targetPlan.planName}`,
      targetPlan,
      metadata: {
        plan_id: targetPlan.id,
        price_id: targetPrice.id,
        trial_subscription_id: oldSubscription.id, // The trial subscription to upgrade
        is_trial_upgrade: "true", // Flag to identify this as trial upgrade
        is_first_payment: "true", // Still first payment for the paid plan
        // Tax metadata for webhook processing
        tax_amount_cents: taxResult.totalTaxCents.toString(),
        tax_jurisdiction: taxResult.jurisdiction,
        tax_calculation_method: taxResult.calculationMethod,
        effective_tax_rate: taxResult.effectiveTaxRate.toString(),
        tax_line_items: JSON.stringify(taxResult.taxLineItems),
      },
    });

    return {
      success: paymentResult.success,
      paymentIntentId: paymentResult.pspPaymentId,
      message: paymentResult.message,
      error: paymentResult.error,
    };
  } catch (error) {
    console.error("Error initiating trial to payment upgrade:", error);
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
      error: "internal_error",
    };
  }
}

/**
 * Triggers immediate billing for bill_immediately components by directly calling the collect payment endpoint
 * This bypasses the normal billing cycle and attempts immediate synchronous payment collection
 */
export async function triggerImmediateBillingIfNeeded({
  subscriptionId,
  merchantId,
  effectivePriceId,
  triggerImmediateBilling,
}: {
  subscriptionId: string;
  merchantId: string;
  effectivePriceId: string;
  triggerImmediateBilling: boolean;
}): Promise<void> {
  try {
    if (!triggerImmediateBilling) {
      console.info(
        `[triggerImmediateBillingIfNeeded] Skipping immediate billing for subscription ${subscriptionId} because triggerImmediateBilling is false`
      );
      return;
    }

    console.info(
      `[triggerImmediateBillingIfNeeded] Checking subscription ${subscriptionId} for immediate billing components`
    );

    // Get the subscription to find the customer ID
    const subscription = await db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.merchantId, merchantId),
        isNull(subscriptions.deletedAt)
      ),
    });

    if (!subscription) {
      console.warn(
        `[triggerImmediateBillingIfNeeded] Subscription ${subscriptionId} not found`
      );
      return;
    }

    // Get the price to check for bill_immediately components
    const price = await db.query.prices.findFirst({
      where: and(
        eq(prices.id, effectivePriceId),
        eq(prices.merchantId, merchantId),
        isNull(prices.deletedAt)
      ),
    });

    if (!price) {
      console.warn(
        `[triggerImmediateBillingIfNeeded] Price ${effectivePriceId} not found`
      );
      return;
    }

    // Find components that should be billed immediately
    const immediateComponents = price.pricingData.components.filter(
      (component) =>
        "bill_immediately" in component && component.bill_immediately === true
    );

    if (immediateComponents.length === 0) {
      console.info(
        `[triggerImmediateBillingIfNeeded] No bill_immediately components found for subscription ${subscriptionId}`
      );
      return;
    }

    console.info(
      `[triggerImmediateBillingIfNeeded] Found ${immediateComponents.length} bill_immediately components, preparing collect payment job`
    );

    // Update nextBillingDate to now for bill_immediately components and collect them
    const now = new Date();
    const subDetailsToProcess: CollectPaymentPayload["subDetails"] = [];

    await db.transaction(async (tx) => {
      for (const component of immediateComponents) {
        const updated = await tx
          .update(subscriptionDetails)
          .set({
            nextBillingDate: now,
          })
          .where(
            and(
              eq(subscriptionDetails.subscriptionId, subscriptionId),
              eq(subscriptionDetails.componentId, component.component_id),
              isNull(subscriptionDetails.deletedAt)
            )
          )
          .returning();

        if (updated.length > 0) {
          const subDetail = updated[0];
          subDetailsToProcess.push({
            subscriptionId: subscriptionId,
            subscriptionDetailsId: subDetail.id,
            nextBillingDate: now.toISOString(),
          });

          console.info(
            `[triggerImmediateBillingIfNeeded] Updated nextBillingDate for component ${component.component_id} to ${now.toISOString()} and added to payment collection (${updated.length} records updated)`
          );
        } else {
          console.warn(
            `[triggerImmediateBillingIfNeeded] No subscription detail found to update for component ${component.component_id}`
          );
        }
      }
    });

    if (subDetailsToProcess.length === 0) {
      console.warn(
        `[triggerImmediateBillingIfNeeded] No subscription details found for immediate billing components`
      );
      return;
    }

    // Prepare payload for collect payment job
    const collectPaymentPayload: CollectPaymentPayload = {
      customerId: subscription.customerId,
      subDetails: subDetailsToProcess,
    };

    console.info(
      `[triggerImmediateBillingIfNeeded] Calling collect payment endpoint for ${subDetailsToProcess.length} subscription details`
    );

    // Get API credentials for the collect payment call
    const triggerApiAccessKey = await getSecretOrEnvVar({
      secretNameTemplate: "lumen/*/trigger-api-access-key",
      envVariableName: "TRIGGER_API_ACCESS_KEY",
      throwOnDevError: true,
      throwOnStagingOrProdError: true,
    });

    // Make direct HTTP call to collect-payment endpoint
    const apiUrl = env.API_URL;
    const collectPaymentUrl = `${apiUrl}/trigger/billing/collect-payment`;

    const response = await fetch(collectPaymentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${triggerApiAccessKey}`,
      },
      body: JSON.stringify(collectPaymentPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Collect payment endpoint returned ${response.status}: ${errorText}`
      );
    }

    const result = await response.json();
    console.info(
      `[triggerImmediateBillingIfNeeded] Successfully called collect payment endpoint for subscription ${subscriptionId}:`,
      result
    );
  } catch (error) {
    console.error(
      `[triggerImmediateBillingIfNeeded] Error triggering immediate billing for subscription ${subscriptionId}:`,
      error
    );
    // Don't throw - immediate billing failure shouldn't block subscription creation
  }
}

// Helper function to get dunning config with hierarchical fallback (plan-specific -> merchant default)
export async function getOrCreateDunningConfig(
  merchantId: string,
  planId: string
): Promise<typeof dunningConfigs.$inferSelect> {
  // 1. First try to find plan-specific config
  let config = await db.query.dunningConfigs.findFirst({
    where: and(
      eq(dunningConfigs.planId, planId),
      eq(dunningConfigs.merchantId, merchantId),
      isNull(dunningConfigs.deletedAt)
    ),
  });

  if (config) {
    console.log(`Using plan-specific dunning config for plan ${planId}`);
    return config;
  }

  // 2. Fall back to merchant-level default config
  config = await db.query.dunningConfigs.findFirst({
    where: and(
      eq(dunningConfigs.merchantId, merchantId),
      isNull(dunningConfigs.planId), // Merchant-level default has null planId
      isNull(dunningConfigs.deletedAt)
    ),
  });

  if (config) {
    console.log(`Using merchant-level dunning config for plan ${planId}`);
    return config;
  }

  // 3. Create merchant-level default if none exists
  console.log(
    `Creating default merchant-level dunning config for merchant ${merchantId}`
  );
  const [newConfig] = await db
    .insert(dunningConfigs)
    .values({
      merchantId,
      planId: null, // Merchant-level default
      gracePeriodDays: 7,
      retrySchedule: [1, 3, 7],
      endOfDunningAction: "pause_subscription",
    })
    .returning();

  return newConfig;
}
