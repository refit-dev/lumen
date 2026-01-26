import { db } from "../db/client";
import { eq, and, isNull, inArray, like, sql } from "drizzle-orm";

/**
 * Escape SQL LIKE wildcards to prevent unintended pattern matching
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}
import {
  creditDefinitions,
  creditGrants,
  customers,
  subscriptions,
  TopupExpiryBehavior,
  type CreditGrantStatus,
  invoices,
  invoiceLineItems,
  payments,
  subscriptionDetails,
  customerInvoiceCounters,
} from "@lumen/common/schema";
import { createCreditGrant, createCreditTransaction } from "./credits";
import { chargeCustomerWithAmount } from "./paymentprovider";
import { getFeatureEntitlement } from "../routes/entitlements";
import { TransactionType } from "./index";

export interface AvailableTopup {
  creditDefinitionId: string;
  featureName: string;
  featureSlug: string;
  currentUsage: number;
  creditsRemaining: number;
  creditAllowance: number;
  topupPricePerCreditCents: number;
  minQuantity: number;
  maxQuantity: number | null;
  currency: string;
  expiryBehavior: TopupExpiryBehavior;
  estimatedExpiryDate: string | null;
}

export interface TopupPurchaseResult {
  success: true;
  payment: {
    id: string;
    status: string;
  };
  // These are pending until webhook confirms payment
  expectedCredits: {
    quantity: number;
    expiryDate: string | null;
  };
  totalAmountCents: number;
  currency: string;
}

/**
 * Get available top-ups for a customer based on their active subscription
 */
export async function getAvailableTopups(
  merchantId: string,
  externalCustomerId: string
): Promise<AvailableTopup[]> {
  // 1. Find customer by externalCustomerId
  const customer = await db.query.customers.findFirst({
    where: and(
      eq(customers.merchantId, merchantId),
      eq(customers.externalCustomerId, externalCustomerId),
      isNull(customers.deletedAt)
    ),
  });

  if (!customer) {
    throw new Error(
      `Customer with external ID ${externalCustomerId} not found`
    );
  }

  // 2. Get customer's active subscription with plan details
  const activeSubscription = await db.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.merchantId, merchantId),
      eq(subscriptions.customerId, customer.id),
      isNull(subscriptions.deletedAt),
      isNull(subscriptions.endTimestamp),
      inArray(subscriptions.status, ["active", "trialing", "past_due"])
    ),
    with: {
      plan: true,
      price: true,
    },
  });

  if (!activeSubscription) {
    return []; // No active subscription, no top-ups available
  }

  // Get subscription details for billing cycle info
  const subDetails = await db.query.subscriptionDetails.findFirst({
    where: and(
      eq(subscriptionDetails.subscriptionId, activeSubscription.id),
      isNull(subscriptionDetails.deletedAt)
    ),
  });

  // 3. Query credit definitions where enableTopups is true and planId matches
  const topupDefinitions = await db.query.creditDefinitions.findMany({
    where: and(
      eq(creditDefinitions.merchantId, merchantId),
      eq(creditDefinitions.enableTopups, true),
      eq(creditDefinitions.planId, activeSubscription.planId),
      eq(creditDefinitions.isActive, true),
      isNull(creditDefinitions.deletedAt)
    ),
    with: {
      feature: true,
    },
  });

  if (topupDefinitions.length === 0) {
    return [];
  }

  // 4. For each definition, get live entitlement data (real-time usage)
  const availableTopups: AvailableTopup[] = [];

  for (const definition of topupDefinitions) {
    if (
      definition.topupExpiryBehavior === "billing_cycle" &&
      !subDetails?.nextBillingDate
    ) {
      console.warn(
        "Skipping top-up option; missing next billing date for billing_cycle expiry",
        {
          creditDefinitionId: definition.id,
          customerId: customer.id,
        }
      );
      continue;
    }

    const featureSlug =
      definition.featureSlug || definition.feature?.slug || "";

    if (!featureSlug) {
      console.warn("Skipping top-up option; no feature slug", {
        creditDefinitionId: definition.id,
      });
      continue;
    }

    // Use the entitlements system to get live usage data
    const entitlement = await getFeatureEntitlement(
      merchantId,
      customer.id,
      featureSlug,
      false // using internal customer ID
    );

    const creditAllowance = entitlement.creditInfo?.creditAllowance ?? 0;
    const creditsRemaining = entitlement.creditInfo?.creditsRemaining ?? 0;
    const currentUsage = entitlement.usages?.[0]?.usage ?? 0;

    // Calculate estimated expiry date based on expiry behavior
    let estimatedExpiryDate: string | null = null;
    if (
      definition.topupExpiryBehavior === "billing_cycle" &&
      subDetails?.nextBillingDate
    ) {
      estimatedExpiryDate = subDetails.nextBillingDate.toISOString();
    } else if (
      definition.topupExpiryBehavior === "custom_days" &&
      definition.topupCustomExpiryDays
    ) {
      const expiryDate = new Date();
      expiryDate.setDate(
        expiryDate.getDate() + definition.topupCustomExpiryDays
      );
      estimatedExpiryDate = expiryDate.toISOString();
    }
    // For "never" expiry behavior, estimatedExpiryDate stays null

    // Get the feature name from linked feature or definition name
    const featureName = definition.feature?.displayName || definition.name;

    // Currency from definition or subscription price
    const currency =
      definition.currency || activeSubscription.price?.currency || "usd";

    availableTopups.push({
      creditDefinitionId: definition.id,
      featureName,
      featureSlug,
      currentUsage,
      creditsRemaining,
      creditAllowance,
      topupPricePerCreditCents: definition.topupPricePerCreditCents || 0,
      minQuantity: definition.topupMinQuantity || 1,
      maxQuantity: definition.topupMaxQuantity,
      currency,
      expiryBehavior: definition.topupExpiryBehavior || "billing_cycle",
      estimatedExpiryDate,
    });
  }

  return availableTopups;
}

/**
 * Calculate the expiry date for a top-up based on configuration
 */
function calculateTopupExpiry(
  definition: typeof creditDefinitions.$inferSelect,
  subscriptionDetailsRecord: typeof subscriptionDetails.$inferSelect | null
): Date | null {
  switch (definition.topupExpiryBehavior) {
    case "billing_cycle":
      if (!subscriptionDetailsRecord?.nextBillingDate) {
        throw new Error("Billing cycle expiry requires next billing date");
      }
      return subscriptionDetailsRecord.nextBillingDate;
    case "custom_days":
      if (definition.topupCustomExpiryDays) {
        const expiryDate = new Date();
        expiryDate.setDate(
          expiryDate.getDate() + definition.topupCustomExpiryDays
        );
        return expiryDate;
      }
      return null;
    case "never":
      return null;
    default:
      return subscriptionDetailsRecord?.nextBillingDate || null;
  }
}

/**
 * Purchase a credit top-up for a customer
 * PAYMENT-FIRST FLOW: Initiates payment, webhook creates invoice and grants credits on success
 *
 * Flow:
 * 1. Validate customer, credit definition, quantity, and subscription
 * 2. Initiate payment with topup metadata (NO invoice created yet)
 * 3. On success webhook: create invoice (status: "paid"), grant credits, send email
 * 4. On failure webhook: just log failure (no invoice litter, no dunning)
 *
 * This mirrors the first-time subscription payment flow.
 */
const IDEMPOTENT_GRANT_STATUSES: CreditGrantStatus[] = [
  "ACTIVE",
  "DEPLETED",
  "EXPIRED",
];

export async function purchaseCreditTopup(params: {
  merchantId: string;
  externalCustomerId: string;
  creditDefinitionId: string;
  quantity: number;
  idempotencyKey?: string;
}): Promise<TopupPurchaseResult> {
  const { merchantId, externalCustomerId, creditDefinitionId, quantity } =
    params;

  // 1. Find customer
  const customer = await db.query.customers.findFirst({
    where: and(
      eq(customers.merchantId, merchantId),
      eq(customers.externalCustomerId, externalCustomerId),
      isNull(customers.deletedAt)
    ),
  });

  if (!customer) {
    throw new Error(
      `Customer with external ID ${externalCustomerId} not found`
    );
  }

  // Idempotency check: Look for existing successful topup (completed via webhook)
  if (params.idempotencyKey) {
    const existingGrant = await db.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.referenceCode, params.idempotencyKey),
        eq(creditGrants.merchantId, merchantId),
        eq(creditGrants.customerId, customer.id),
        eq(creditGrants.source, "topup"),
        inArray(creditGrants.status, IDEMPOTENT_GRANT_STATUSES),
        isNull(creditGrants.deletedAt)
      ),
    });

    if (existingGrant) {
      // Find the associated invoice and payment
      const existingInvoice = await db.query.invoices.findFirst({
        where: and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.customerId, customer.id),
          sql`${invoices.notes} LIKE ${"%" + escapeLikePattern(params.idempotencyKey) + "%"} ESCAPE '\\'`
        ),
      });

      const existingPayment = existingInvoice
        ? await db.query.payments.findFirst({
            where: and(
              eq(payments.invoiceId, existingInvoice.id),
              eq(payments.merchantId, merchantId)
            ),
          })
        : null;

      // Return idempotent response - topup already completed
      return {
        success: true,
        payment: {
          id: existingPayment?.id || "completed",
          status: existingPayment?.status || "succeeded",
        },
        expectedCredits: {
          quantity: existingGrant.initialAmount,
          expiryDate: existingGrant.expiryDate?.toISOString() || null,
        },
        totalAmountCents: existingInvoice?.totalAmountCents || 0,
        currency: existingInvoice?.currency || "usd",
      };
    }
  }

  // 2. Validate credit definition has topups enabled
  const definition = await db.query.creditDefinitions.findFirst({
    where: and(
      eq(creditDefinitions.id, creditDefinitionId),
      eq(creditDefinitions.merchantId, merchantId),
      eq(creditDefinitions.enableTopups, true),
      eq(creditDefinitions.isActive, true),
      isNull(creditDefinitions.deletedAt)
    ),
    with: {
      feature: true,
    },
  });

  if (!definition) {
    throw new Error("Top-ups not enabled for this credit definition");
  }

  if (!definition.topupPricePerCreditCents) {
    throw new Error("Top-up price not configured for this credit definition");
  }

  if (
    definition.topupExpiryBehavior === "custom_days" &&
    !definition.topupCustomExpiryDays
  ) {
    throw new Error("Top-up custom expiry requires number of days");
  }

  // 3. Validate quantity against min/max
  const minQuantity = definition.topupMinQuantity || 1;
  if (quantity < minQuantity) {
    throw new Error(`Minimum purchase is ${minQuantity} credits`);
  }
  if (definition.topupMaxQuantity && quantity > definition.topupMaxQuantity) {
    throw new Error(
      `Maximum purchase is ${definition.topupMaxQuantity} credits`
    );
  }

  // 4. Get customer's active subscription and verify it matches the plan
  const activeSubscription = await db.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.merchantId, merchantId),
      eq(subscriptions.customerId, customer.id),
      isNull(subscriptions.deletedAt),
      isNull(subscriptions.endTimestamp),
      inArray(subscriptions.status, ["active", "trialing", "past_due"])
    ),
    with: {
      plan: true,
      price: true,
    },
  });

  if (!activeSubscription) {
    throw new Error("Customer does not have an active subscription");
  }

  if (activeSubscription.planId !== definition.planId) {
    throw new Error(
      "Customer's subscription plan does not match the credit definition"
    );
  }

  // Get subscription details for expiry calculation
  const subDetails = await db.query.subscriptionDetails.findFirst({
    where: and(
      eq(subscriptionDetails.subscriptionId, activeSubscription.id),
      isNull(subscriptionDetails.deletedAt)
    ),
  });

  // 5. Calculate total cost and expiry date
  const totalCents = quantity * definition.topupPricePerCreditCents;
  const expiryDate = calculateTopupExpiry(definition, subDetails || null);
  const featureName = definition.feature?.displayName || definition.name;
  const currency =
    definition.currency || activeSubscription.price?.currency || "usd";

  // 6. Initiate payment WITHOUT creating invoice
  // Invoice will be created by webhook handler when payment succeeds
  const chargeResult = await chargeCustomerWithAmount({
    customerId: customer.id,
    merchantId,
    amountCents: totalCents,
    currency,
    description: `Credit top-up: ${quantity} ${featureName}`,
    targetPlan: activeSubscription.plan,
    metadata: {
      is_topup: "true",
      topup_credit_definition_id: definition.id,
      topup_customer_id: customer.id,
      topup_subscription_id: activeSubscription.id,
      topup_quantity: String(quantity),
      topup_unit_price_cents: String(definition.topupPricePerCreditCents),
      topup_expiry_date: expiryDate?.toISOString() || "",
      topup_reference_code: params.idempotencyKey || "",
      topup_feature_name: featureName,
    },
  });

  // Check for pre-payment errors (missing payment method, customer not found, etc.)
  // These are errors that happen BEFORE the payment is even initiated
  const prePaymentErrors = [
    "customer_not_found",
    "missing_payment_method",
    "plan_not_configured_for_dodo",
  ];
  if (chargeResult.error && prePaymentErrors.includes(chargeResult.error)) {
    throw new Error(chargeResult.message);
  }

  // Check for synchronous payment failures (not requires_action which is handled by webhook)
  // These indicate immediate payment rejection
  const pendingStatuses = [
    "requires_action",
    "requires_confirmation",
    "processing",
    "pending",
  ];
  if (
    !chargeResult.success &&
    chargeResult.status &&
    !pendingStatuses.includes(chargeResult.status)
  ) {
    throw new Error(chargeResult.message || "Payment failed");
  }

  console.log(
    `Topup payment initiated: ${chargeResult.pspPaymentId}, invoice and credits will be created via webhook`
  );

  // Return success - invoice and credits will be created by webhook when payment confirms
  return {
    success: true,
    payment: {
      id: chargeResult.pspPaymentId || "",
      status: chargeResult.status || "pending",
    },
    expectedCredits: {
      quantity,
      expiryDate: expiryDate?.toISOString() || null,
    },
    totalAmountCents: totalCents,
    currency,
  };
}

/**
 * Process a successful topup payment (called by webhook handler)
 * Creates invoice (status: "paid"), updates payment, and grants credits
 *
 * This is the complete handler for payment_intent.succeeded webhook for topups.
 */
export async function processTopupPayment(
  payment: typeof payments.$inferSelect
): Promise<{
  success: boolean;
  invoiceId?: string;
  creditGrantId?: string;
  message?: string;
}> {
  if (!payment.metadata) {
    return { success: false, message: "Payment has no metadata" };
  }

  if (payment.metadata.is_topup !== "true") {
    return { success: false, message: "Not a topup payment" };
  }

  const {
    topup_credit_definition_id,
    topup_customer_id,
    topup_subscription_id,
    topup_quantity,
    topup_unit_price_cents,
    topup_expiry_date,
    topup_reference_code,
    topup_feature_name,
  } = payment.metadata as Record<string, string>;

  if (!topup_credit_definition_id || !topup_customer_id || !topup_quantity) {
    return { success: false, message: "Missing required topup metadata" };
  }

  const quantity = parseInt(topup_quantity, 10);
  const unitPriceCents = parseInt(topup_unit_price_cents || "0", 10);
  const totalCents = quantity * unitPriceCents;
  const expiryDate = topup_expiry_date ? new Date(topup_expiry_date) : null;
  const referenceCode = topup_reference_code || `payment_${payment.id}`;

  // Idempotency check: Look for existing grant
  const existingGrant = await db.query.creditGrants.findFirst({
    where: and(
      eq(creditGrants.referenceCode, referenceCode),
      eq(creditGrants.merchantId, payment.merchantId),
      eq(creditGrants.customerId, topup_customer_id),
      eq(creditGrants.source, "topup"),
      inArray(creditGrants.status, IDEMPOTENT_GRANT_STATUSES),
      isNull(creditGrants.deletedAt)
    ),
  });

  if (existingGrant) {
    console.log(
      `Topup already processed for reference ${referenceCode} (grant: ${existingGrant.id})`
    );
    // Find the invoice for completeness
    const existingInvoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.merchantId, payment.merchantId),
        sql`${invoices.notes} LIKE ${"%" + escapeLikePattern(referenceCode) + "%"} ESCAPE '\\'`
      ),
    });
    return {
      success: true,
      invoiceId: existingInvoice?.id,
      creditGrantId: existingGrant.id,
    };
  }

  // Get customer for invoice generation
  const customer = await db.query.customers.findFirst({
    where: and(
      eq(customers.id, topup_customer_id),
      eq(customers.merchantId, payment.merchantId),
      isNull(customers.deletedAt)
    ),
  });

  if (!customer) {
    return { success: false, message: "Customer not found" };
  }

  // Process everything in a transaction
  return await db.transaction(async (tx) => {
    // 1. Create invoice with status: "paid"
    const sequenceNumber = await getAndIncrementInvoiceCounter(
      tx,
      payment.merchantId,
      topup_customer_id
    );
    const customerInvoiceNumber = formatCustomerInvoiceNumber(
      customer.invoicePrefix || customer.id.slice(4, 10),
      sequenceNumber
    );

    const now = new Date();
    const [newInvoice] = await tx
      .insert(invoices)
      .values({
        merchantId: payment.merchantId,
        customerId: topup_customer_id,
        subscriptionId: topup_subscription_id || null,
        status: "paid",
        paidDate: now,
        totalAmountCents: totalCents,
        subtotalCents: totalCents,
        taxAmountCents: 0,
        effectiveTaxRate: "0",
        currency: payment.currency,
        customerInvoiceNumber,
        dueDate: now,
        issueDate: now,
        billingPeriodStart: now,
        billingPeriodEnd: expiryDate,
        notes: `Credit top-up | Reference: ${referenceCode}`,
      })
      .returning();

    if (!newInvoice) {
      throw new Error("Failed to create invoice");
    }

    // 2. Create invoice line item
    await tx.insert(invoiceLineItems).values({
      invoiceId: newInvoice.id,
      type: "credit_topup",
      description: `Top-up: ${quantity} ${topup_feature_name || "credits"}`,
      quantity,
      unitAmountCents: unitPriceCents,
      subtotalCents: totalCents,
      billingPeriodStart: now,
      billingPeriodEnd: expiryDate,
    });

    // 3. Update payment record with invoice link and succeeded status
    await tx
      .update(payments)
      .set({
        invoiceId: newInvoice.id,
        status: "succeeded",
        updatedAt: now,
      })
      .where(eq(payments.id, payment.id));

    // 4. Grant credits
    const creditGrant = await createCreditGrant({
      merchantId: payment.merchantId,
      customerId: topup_customer_id,
      creditDefinitionId: topup_credit_definition_id,
      initialAmount: quantity,
      expiryDate: expiryDate || undefined,
      source: "topup",
      referenceCode,
      notes: `Top-up purchase of ${quantity} credits (payment ${payment.id})`,
    });

    console.log(
      `Topup processed: invoice ${newInvoice.id}, grant ${creditGrant.id}, ${quantity} credits`
    );

    return {
      success: true,
      invoiceId: newInvoice.id,
      creditGrantId: creditGrant.id,
    };
  });
}

// Helper functions for invoice creation
async function getAndIncrementInvoiceCounter(
  tx: TransactionType,
  merchantId: string,
  customerId: string
): Promise<number> {
  const existing = await tx.query.customerInvoiceCounters.findFirst({
    where: and(
      eq(customerInvoiceCounters.merchantId, merchantId),
      eq(customerInvoiceCounters.customerId, customerId)
    ),
  });

  if (existing) {
    const newCounter = existing.lastInvoiceNumber + 1;
    await tx
      .update(customerInvoiceCounters)
      .set({ lastInvoiceNumber: newCounter, updatedAt: new Date() })
      .where(
        and(
          eq(customerInvoiceCounters.merchantId, merchantId),
          eq(customerInvoiceCounters.customerId, customerId)
        )
      );
    return newCounter;
  } else {
    await tx.insert(customerInvoiceCounters).values({
      merchantId,
      customerId,
      lastInvoiceNumber: 1,
    });
    return 1;
  }
}

function formatCustomerInvoiceNumber(
  prefix: string,
  sequenceNumber: number
): string {
  return `${prefix.toUpperCase()}-${String(sequenceNumber).padStart(4, "0")}`;
}
