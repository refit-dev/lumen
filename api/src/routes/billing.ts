import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { PriceComponentSchemaType } from "@lumen/common/validators";
import { db } from "../db/client";
import {
  paymentMethods,
  customers,
  merchants,
  subscriptionDetails,
  invoiceLineItems,
  subscriptions,
  prices,
  creditDefinitions,
  creditGrants,
  payments,
  customerOrganizations,
} from "@lumen/common/schema";
import { paymentRetries } from "@lumen/common/schema";
import { invoices } from "@lumen/common/schema";
import { metrics } from "@lumen/common/schema";
import { and, eq, gt, gte, isNull, lte, ne, or, lt } from "drizzle-orm";
import { uploadFile, getObjectStorageUrl } from "../helpers/s3";
import {
  generateLineItemObjectForComponent,
  generateUsageCreditLineItems,
  getAndIncrementInvoiceCounter,
  formatCustomerInvoiceNumber,
  triggerInvoicePdfGeneration,
  updateSubscriptionBillingCycle,
  getOrCreateDunningConfig,
  calculateUsageForComponent,
} from "../helpers/billing";
import {
  getActiveMonetaryCredits,
  getActiveComponentMonetaryCredits,
  getActivePlanLevelCredits,
  getActiveMerchantLevelCredits,
  applyMonetaryCredits,
  applyPlanLevelCredits,
  applyMerchantLevelCredits,
  processRenewalAfterInvoice,
  updateCreditTransactionsWithInvoiceId,
} from "../helpers/credits";
import { subscriptionsScheduledChanges, plans } from "@lumen/common/schema";
import {
  migrateSubscription,
  initiateTrialToPaymentUpgrade,
} from "../helpers/billing";
import Stripe from "stripe";
import { forceReconciliation } from "../lib/cacheSynchronizer";
import { createPrefixedId, ID_PREFIXES } from "@lumen/common";
import { TransactionType } from "../helpers/index";
import { getEffectiveTimezone } from "../helpers/utils";
import { calculateTaxes, TaxCalculationResult } from "../helpers/tax-engine";
import {
  getPaymentProvider,
  processPayment,
  createOneTimePaymentLink,
  chargeInvoice,
  retryInvoicePayment,
} from "../helpers/paymentprovider";
import { enforceDunningEndAction } from "../helpers/dunning";
import { createNotificationProvider } from "../helpers/notificationProvider";

type Invoice = typeof invoices.$inferSelect;
type Payment = typeof payments.$inferSelect;
type Merchant = typeof merchants.$inferSelect;
type Customer = typeof customers.$inferSelect;
type SubscriptionDetailsWithPaymentMethod =
  typeof subscriptionDetails.$inferSelect & {
    paymentMethod: typeof paymentMethods.$inferSelect | null;
  };

type InvoiceWithRelations = Invoice & {
  merchant: Merchant;
  customer: Customer;
  subscriptionDetails?: SubscriptionDetailsWithPaymentMethod | null;
};

// Type for line items that we work with internally (before saving to DB)
interface InternalLineItem {
  type: string;
  description: string;
  subtotalCents: number;
  componentId?: string;
  priceId?: string;
  quantity?: number;
  unitAmountCents?: number;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  metricId?: string;
  // Optional metadata for tax line items. Will be persisted to invoice_line_items.taxMetadata
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
}

// Helper function to build credit line item descriptions
function buildCreditDescription(
  creditDefinition: typeof creditDefinitions.$inferSelect,
  context?: {
    type: "component" | "price" | "plan" | "merchant";
    componentDescription?: string;
  }
): string {
  // Use billingDescription if available, otherwise fall back to name
  const creditName =
    creditDefinition.billingDescription || creditDefinition.name;

  if (context?.type === "component" && context.componentDescription) {
    // For component credits, show both the credit name and what it applies to
    return `${creditName}: ${context.componentDescription}`;
  }

  // For other credit types, just use the credit name/description
  return creditName;
}

// Type for subscription details from the API request
interface SubDetailsInput {
  subscriptionId: string;
  subscriptionDetailsId: string;
  nextBillingDate: string;
}

// Input schemas
const checkDueSchema = z.object({
  // ISO string date UTC, optional
  // Susbcription before this time will be checked for due if provided
  // If not provided, we use current UTC time
  checkUptoDueDate: z.string().optional(),
});

// Schema for the collect-payment endpoint
const collectPaymentSchema = z.object({
  customerId: z.string(),
  subDetails: z
    .array(
      z.object({
        subscriptionId: z.string(),
        subscriptionDetailsId: z.string(),
        nextBillingDate: z.string(),
      })
    )
    .default([]),
});

// Helper types for better organization
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

interface PaymentContext {
  customer: typeof customers.$inferSelect;
  paymentMethod: typeof paymentMethods.$inferSelect | null;
  processedDetails: ProcessedSubscriptionDetail[];
  merchantId: string;
  currency: string;
  seatAwareUsage?: boolean;
}

interface TransactionResult {
  type: "skip" | "success";
  response: {
    success: boolean;
    status?: string;
    message: string;
    paymentIntentId?: string;
    invoiceId?: string;
    paymentId?: string;
    paymentLinkUrl?: string; // Now used for Stripe checkout session URL
  };
}

// Internal type for database operation results
interface DbOperationResult {
  type:
    | "skip"
    | "existing"
    | "created"
    | "zero_amount_no_payment"
    | "payment_link_created";
  result?: TransactionResult;
  invoice?: Invoice;
  invoiceId?: string;
  payment?: Payment | null;
  paymentLinkUrl?: string;
}

// Helper function to validate subscription consistency
function validateSubscriptionConsistency(
  subDetails: SubDetailsInput[]
): { subscriptionId: string } | { error: any } {
  const subscriptionId = subDetails[0].subscriptionId;
  if (subDetails.some((d) => d.subscriptionId !== subscriptionId)) {
    return {
      error: {
        success: false,
        status: "failed",
        message: `We only support one subscription per customer for now. Found more than one subscription for customer`,
        statusCode: 400,
      },
    };
  }
  return { subscriptionId };
}

// Helper function to fetch customer
async function fetchCustomer(
  customerId: string
): Promise<typeof customers.$inferSelect | null> {
  const customer = await db.query.customers.findFirst({
    where: and(eq(customers.id, customerId), isNull(customers.deletedAt)),
  });
  return customer || null;
}

// Helper function to process subscription details
async function processSubscriptionDetails(
  subDetails: SubDetailsInput[]
): Promise<ProcessedSubscriptionDetail[] | { error: any }> {
  const processedDetails: ProcessedSubscriptionDetail[] = [];

  for (const detail of subDetails) {
    console.log("Processing subscription detail", detail);
    const subDetailDbRecord = await db.query.subscriptionDetails.findFirst({
      where: and(
        eq(subscriptionDetails.id, detail.subscriptionDetailsId),
        isNull(subscriptionDetails.deletedAt)
      ),
      with: {
        subscription: {
          with: {
            price: true,
          },
        },
      },
    });

    if (!subDetailDbRecord || !subDetailDbRecord.subscription) {
      return {
        error: {
          success: false,
          status: "failed",
          message: `Subscription detail not found: ${detail.subscriptionDetailsId}`,
          statusCode: 404,
        },
      };
    }

    // Find component in the price DSL
    const componentId = subDetailDbRecord.componentId;
    const component =
      subDetailDbRecord.subscription.price.pricingData.components.find(
        (c) => c.component_id === componentId
      );

    if (!component) {
      return {
        error: {
          success: false,
          status: "failed",
          message: `Component ${componentId} not found in price DSL for subscription: ${subDetailDbRecord.subscriptionId}`,
          statusCode: 400,
        },
      };
    }

    // Skip paused/unpaid/canceled subscriptions from billing
    const subStatus = subDetailDbRecord.subscription.status as
      | string
      | undefined;
    if (subStatus && ["paused", "unpaid", "canceled"].includes(subStatus)) {
      console.log(
        `Skipping billing for subscription ${subDetailDbRecord.subscriptionId} with status ${subStatus}`
      );
      continue;
    }

    // Calculate billing period
    const billingPeriodStart =
      subDetailDbRecord.previousBillingDate ||
      subDetailDbRecord.subscriptionStartDate;
    const billingPeriodEnd = new Date(detail.nextBillingDate);

    processedDetails.push({
      subDetail: subDetailDbRecord,
      component,
      billingPeriodStart,
      billingPeriodEnd,
    });
  }

  if (processedDetails.length === 0) {
    return {
      error: {
        success: false,
        status: "failed",
        message: `No valid components found for subscription details`,
        statusCode: 400,
      },
    };
  }

  return processedDetails;
}

// Helper function to fetch payment dependencies
async function fetchPaymentDependencies(
  customerId: string,
  merchantId: string,
  preferredPaymentMethodId?: string | null
): Promise<{
  paymentMethod: typeof paymentMethods.$inferSelect | null;
}> {
  // Prefer the explicitly set payment method on subscription details when available
  if (preferredPaymentMethodId) {
    const pm = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.id, preferredPaymentMethodId),
        isNull(paymentMethods.deletedAt)
      ),
    });
    if (pm) {
      return { paymentMethod: pm };
    }
  }

  // Fallback: most recently used active method for the customer
  const paymentMethodResult = await db.query.paymentMethods.findFirst({
    where: and(
      eq(paymentMethods.customerId, customerId),
      isNull(paymentMethods.deletedAt)
    ),
    orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
  });

  return {
    paymentMethod: paymentMethodResult || null,
  };
}

// Helper function to validate payment context
async function validatePaymentContext(
  customer: typeof customers.$inferSelect | null,
  paymentMethod: typeof paymentMethods.$inferSelect | null,
  requiresPayment: boolean = true
) {
  if (!customer) {
    return {
      error: {
        success: false,
        status: "failed",
        message: `Customer not found`,
        statusCode: 404,
      },
    };
  }

  // For free plans or zero-amount invoices, we don't require payment setup
  if (!requiresPayment) {
    return {
      success: true,
    };
  }

  const { isPaymentProviderReady, statusMessage } = await getPaymentProvider(
    customer.merchantId
  );

  // For paid plans, require Payment Provider integration and payment methods
  if (!isPaymentProviderReady) {
    return {
      error: {
        success: false,
        status: "failed",
        message: statusMessage,
        statusCode: 400,
      },
    };
  }

  if (!paymentMethod) {
    return {
      error: {
        success: false,
        status: "failed",
        message: "No payment method found for customer",
        statusCode: 400,
      },
    };
  }

  return {
    success: true,
  };
}

// Helper function to process payment in transaction
async function processPaymentTransaction(
  context: PaymentContext,
  subDetails: SubDetailsInput[],
  subscriptionId: string
): Promise<TransactionResult | undefined> {
  // First transaction: Create invoice and optionally payment records
  const dbResult = await db.transaction(async (tx) => {
    // Check for existing invoice (idempotency)
    const existingInvoice = await tx.query.invoices.findFirst({
      where: and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.customerId, context.customer.id),
        eq(
          invoices.billingPeriodStart,
          context.processedDetails[0].billingPeriodStart
        ),
        ne(invoices.status, "deleted")
      ),
    });

    let invoice;
    let invoiceId;
    let existingPayment = null;

    if (existingInvoice) {
      console.info(
        `Idempotency check: Invoice already exists for subscription ${subscriptionId}`
      );
      invoice = existingInvoice;
      invoiceId = existingInvoice.id;

      // Check if there's already a payment for this invoice
      existingPayment = await tx.query.payments.findFirst({
        where: and(eq(payments.invoiceId, invoiceId)),
      });

      if (existingPayment && existingPayment.status !== "failed") {
        console.info(
          `Payment already exists for invoice ${invoiceId} with status ${existingPayment.status}`
        );
        return {
          type: "existing",
          invoice,
          invoiceId,
          payment: existingPayment,
        };
      }
    } else {
      const invoiceResult = await createInvoiceWithLineItems(tx, context);
      if ("type" in invoiceResult && invoiceResult.type === "skip") {
        return { type: "skip", result: invoiceResult };
      }
      const successResult = invoiceResult as {
        invoice: Invoice;
        invoiceId: string;
      };
      invoice = successResult.invoice;
      invoiceId = successResult.invoiceId;
    }

    // For zero amount invoices without payment methods, skip payment creation
    if (invoice.totalAmountCents === 0 && !context.paymentMethod) {
      console.info(
        `Invoice ${invoiceId} has zero amount and no payment method, creating invoice-only transaction`
      );

      // Mark invoice as paid immediately since no payment is needed
      await tx
        .update(invoices)
        .set({
          status: "paid",
        })
        .where(eq(invoices.id, invoiceId));

      return {
        type: "zero_amount_no_payment",
        invoice,
        invoiceId,
        payment: null,
      };
    }

    // For non-zero invoices without payment methods, create payment link
    if (!context.paymentMethod && invoice.totalAmountCents > 0) {
      console.info(
        `Invoice ${invoiceId} has no payment method, creating checkout session`
      );

      // fetch the full subscription with plan
      const subscriptionWithPlan = await tx.query.subscriptions.findFirst({
        where: eq(subscriptions.id, invoice.subscriptionId!),
        with: {
          plan: true,
        },
      });

      try {
        const [paymentLinkPayment] = await tx
          .insert(payments)
          .values({
            merchantId: context.merchantId,
            invoiceId: invoiceId,
            paymentMethodId: null, // No payment method for payment links - will be created in the success webhook
            amountCents: invoice.totalAmountCents,
            currency: context.currency,
            status: "pending",
            externalPaymentId: "", // Store checkout session ID for webhook matching
            metadata: {
              source: "manual_subscription_billing",
              invoice_id: invoice.id,
              customer_id: context.customer.id,
              merchant_id: context.merchantId,
              ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
            },
          })
          .returning();

        if (!paymentLinkPayment) {
          throw new Error("Failed to create payment link payment");
        }

        // Use the refactored payment provider function to create checkout session
        // for Dodo,checkoutSessionId is the Dodo subscription ID, checkoutSessionUrl is the Dodo payment link URL
        const { checkoutSessionId, checkoutSessionUrl } =
          await createOneTimePaymentLink({
            invoice: {
              ...invoice,
              subscription: subscriptionWithPlan!,
            },
            currency: context.currency,
            merchantId: context.merchantId,
            customerId: context.customer.id,
            lumenPaymentId: paymentLinkPayment.id,
          });

        // update the payment record with the checkout session ID and checkout session URL in metadata
        await tx
          .update(payments)
          .set({
            externalPaymentId: checkoutSessionId,
            metadata: {
              ...paymentLinkPayment.metadata,
              checkoutSessionId,
              checkoutSessionUrl,
            },
          })
          .where(eq(payments.id, paymentLinkPayment.id));

        // Update invoice with checkout session URL in notes and set status to awaiting payment
        await tx
          .update(invoices)
          .set({
            status: "issued",
            notes: `Payment required: Please complete your payment online at ${checkoutSessionUrl}`,
          })
          .where(eq(invoices.id, invoiceId));

        // Now that the invoice has the checkout link, generate the PDF so the link appears in the document
        // Won't be generated for Dodo but we already send the email in createOneTimePaymentLink function
        await triggerPdfGeneration(tx, invoiceId);

        // Create a pending payment record for tracking and webhook reconciliation

        console.info(
          `Created checkout session for invoice ${invoiceId}: ${checkoutSessionUrl}`
        );

        return {
          type: "payment_link_created",
          invoice: {
            ...invoice,
            status: "issued",
            notes: `Payment required: Please complete your payment online at ${checkoutSessionUrl}`,
          },
          invoiceId,
          payment: paymentLinkPayment,
          paymentLinkUrl: checkoutSessionUrl,
        };
      } catch (paymentLinkError) {
        console.error(
          `Failed to create payment link for invoice ${invoiceId}:`,
          paymentLinkError
        );
        throw new Error(
          `Failed to create payment link: ${paymentLinkError instanceof Error ? paymentLinkError.message : "Unknown payment provider error"}`
        );
      }
    }

    // For all other cases (zero amount with payment method, non-zero with payment method), create payment record
    if (!context.paymentMethod) {
      throw new Error(
        "Unexpected state: no payment method but should have one"
      );
    }

    const [payment] = await tx
      .insert(payments)
      .values({
        merchantId: context.merchantId,
        invoiceId: invoiceId,
        paymentMethodId: context.paymentMethod.id,
        amountCents: invoice.totalAmountCents,
        currency: context.currency,
        status: "pending",
        // externalPaymentId will be updated after payment intent is created
      })
      .returning();

    console.info(
      `Created pending payment ${payment.id} for invoice ${invoiceId}`
    );

    return {
      type: "created",
      invoice,
      invoiceId,
      payment,
    };
  });

  // Handle skip or existing payment cases
  if (dbResult.type === "skip") {
    return dbResult.result as TransactionResult;
  }

  if (dbResult.type === "existing") {
    return {
      type: "success",
      response: {
        success: true,
        paymentIntentId: dbResult.payment?.externalPaymentId || undefined,
        invoiceId: dbResult.invoiceId!,
        paymentId: dbResult.payment!.id,
        status: dbResult.payment!.status,
        message: "Payment already processed or in progress",
      },
    };
  }

  // Handle zero amount invoices without payment methods
  if (dbResult.type === "zero_amount_no_payment") {
    // Process post-invoice operations
    await processPostInvoiceOperations(context, dbResult.invoiceId!);

    return {
      type: "success",
      response: {
        success: true,
        paymentIntentId: undefined,
        invoiceId: dbResult.invoiceId!,
        paymentId: undefined, // No payment record created
        status: "no_payment_required",
        message: "Free plan - no payment required",
      },
    };
  }

  // Handle payment link created cases
  if (dbResult.type === "payment_link_created") {
    // Process post-invoice operations
    await processPostInvoiceOperations(context, dbResult.invoiceId!);

    return {
      type: "success",
      response: {
        success: true,
        paymentIntentId: undefined, // No payment intent for payment links
        invoiceId: dbResult.invoiceId!,
        paymentId: dbResult.payment?.id, // Payment record created for tracking
        status: "payment_link_created",
        message: `Payment link created - customer can pay at: ${dbResult.paymentLinkUrl}`,
        paymentLinkUrl: dbResult.paymentLinkUrl,
      },
    };
  }

  // Now we have committed invoice and payment records
  const { invoice, invoiceId, payment } = dbResult;

  // These should always be defined for "created" type
  if (!invoice || !invoiceId || !payment) {
    throw new Error("Unexpected state: invoice or payment not created");
  }

  // Process post-invoice operations (update subscription billing cycle, grant renewals)
  await processPostInvoiceOperations(context, invoiceId);

  // Handle zero amount invoices with payment methods (credits applied to paid plan)
  if (invoice.totalAmountCents === 0) {
    console.log(
      `Invoice ${invoiceId} has zero amount, skipping processing payment`,
      {
        customerId: context.customer.id,
        invoiceId,
        paymentId: payment.id,
      }
    );

    // Update payment status to succeeded and invoice to paid in a new transaction
    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          status: "succeeded",
          externalPaymentId: null, // No external payment for zero amounts
        })
        .where(eq(payments.id, payment.id));

      await tx
        .update(invoices)
        .set({
          status: "paid",
        })
        .where(eq(invoices.id, invoiceId));

      // Update payment method's last used timestamp if it exists
      if (context.paymentMethod) {
        await tx
          .update(paymentMethods)
          .set({ lastUsedAt: new Date() })
          .where(eq(paymentMethods.id, context.paymentMethod.id));
      }
    });

    return {
      type: "success",
      response: {
        success: true,
        paymentIntentId: undefined, // No payment intent for zero amounts
        invoiceId: invoiceId,
        paymentId: payment.id,
        status: "no_payment_required",
        message: "Invoice fully covered by credits",
      },
    };
  }

  // Process payment (outside of transaction)
  const paymentResult = await processPayment({
    context,
    subDetails,
    subscriptionId,
    invoice,
    invoiceId,
    payment,
  });

  return paymentResult as TransactionResult;
}

// Enhanced helper function to create invoice with line items and credit waterfall
async function createInvoiceWithLineItems(
  tx: TransactionType,
  context: PaymentContext
): Promise<
  { invoice: Invoice; invoiceId: string } | { type: "skip"; response: any }
> {
  console.log(`[createInvoiceWithLineItems] Starting invoice creation`, {
    customerId: context.customer.id,
    merchantId: context.merchantId,
    currency: context.currency,
    componentCount: context.processedDetails.length,
  });

  // Generate a unique billing session ID to track all credit transactions for this invoice
  const billingSessionId = createPrefixedId(ID_PREFIXES.billingSession);
  console.log(
    `[createInvoiceWithLineItems] Generated billing session ID: ${billingSessionId}`
  );

  // Step 1: Generate charge line items for pricing components
  const chargeResult = await generateChargeLineItems(context);
  if ("type" in chargeResult && chargeResult.type === "skip") {
    return chargeResult;
  }

  // TypeScript now knows chargeResult is the success type
  let chargeLineItems = (
    chargeResult as {
      lineItems: InternalLineItem[];
      totalAmountCents: number;
    }
  ).lineItems;
  let initialAmount = (
    chargeResult as {
      lineItems: InternalLineItem[];
      totalAmountCents: number;
    }
  ).totalAmountCents;

  // Draft invoice line items are now handled separately via createOrMergeIntoInvoice

  // ------------------------------------------------------------------
  // Merge any existing draft invoice for this subscription into the upcoming
  // issued invoice by taking all NON-tax line items from the draft, deleting
  // the draft invoice, and adding those items to chargeLineItems.
  // ------------------------------------------------------------------

  const subscriptionId = context.processedDetails[0].subDetail.subscriptionId;

  const existingDraft = await tx.query.invoices.findFirst({
    where: and(
      eq(invoices.customerId, context.customer.id),
      eq(invoices.merchantId, context.merchantId),
      eq(invoices.subscriptionId, subscriptionId),
      eq(invoices.status, "draft")
    ),
    with: {
      lineItems: true,
    },
  });

  if (existingDraft) {
    console.log(
      `[createInvoiceWithLineItems] Found existing draft invoice ${existingDraft.id}. Merging its non-tax line items`
    );

    const existingNonTaxLineItems = existingDraft.lineItems.filter(
      (li) => li.type !== "tax"
    );

    if (existingNonTaxLineItems.length > 0) {
      const existingInternalItems: InternalLineItem[] =
        existingNonTaxLineItems.map((li) => ({
          type: li.type || "charge",
          description: li.description,
          quantity: li.quantity ?? undefined,
          unitAmountCents: li.unitAmountCents ?? undefined,
          subtotalCents: li.subtotalCents,
          componentId: li.componentId ?? undefined,
          // priceId intentionally omitted for draft line items
          metricId: li.metricId ?? undefined,
          billingPeriodStart: li.billingPeriodStart ?? new Date(),
          billingPeriodEnd: li.billingPeriodEnd ?? new Date(),
        }));

      chargeLineItems = [...existingInternalItems, ...chargeLineItems];

      const existingSubtotal = existingInternalItems.reduce(
        (s, li) => s + li.subtotalCents,
        0
      );

      initialAmount += existingSubtotal;

      console.log(
        `[createInvoiceWithLineItems] Added ${existingInternalItems.length} existing draft line items (subtotal cents: ${existingSubtotal})`
      );
    }

    // Soft-delete the old draft invoice so it isn't charged separately
    await tx
      .update(invoices)
      .set({ status: "deleted" })
      .where(eq(invoices.id, existingDraft.id));
  }

  // Step 2: Check if we should apply credits (if there are any active credit grants)
  const shouldApplyCredits = await checkIfShouldApplyCredits(context, tx);

  let allLineItems: InternalLineItem[];
  let finalAmountCents: number;
  let totalCreditApplied: number;
  let taxData: TaxCalculationResult;

  if (shouldApplyCredits) {
    console.log(
      `[createInvoiceWithLineItems] Applying credits (active credit grants found)`
    );

    // Apply credit waterfall and generate credit line items
    const creditResult = await applyCreditWaterfall(
      context,
      chargeLineItems,
      initialAmount,
      billingSessionId,
      tx
    );

    allLineItems = creditResult.allLineItems;
    finalAmountCents = creditResult.finalAmountCents;
    totalCreditApplied = creditResult.totalCreditApplied;
    taxData = creditResult.taxData;
  } else {
    console.log(
      `[createInvoiceWithLineItems] Skipping credits (no active credit grants found)`
    );

    // Calculate taxes on original amount (no credits applied)
    taxData = await calculateTaxes({
      merchantId: context.merchantId,
      customerId: context.customer.id,
      subtotalAfterCredits: initialAmount,
      lineItems: chargeLineItems.map((item) => ({
        type: item.type,
        description: item.description,
        subtotalCents: item.subtotalCents,
        componentId: item.componentId,
        priceId: item.priceId,
        billingPeriodStart: item.billingPeriodStart,
        billingPeriodEnd: item.billingPeriodEnd,
      })),
      currency: context.currency,
      billingDate: context.processedDetails[0].billingPeriodStart,
    });

    // Add tax line items if applicable
    allLineItems = [...chargeLineItems];
    if (taxData.taxLineItems.length > 0) {
      for (const taxLineItem of taxData.taxLineItems) {
        allLineItems.push({
          type: taxLineItem.type,
          description: taxLineItem.description,
          subtotalCents: taxLineItem.subtotalCents,
          quantity: 1,
          unitAmountCents: taxLineItem.subtotalCents,
          billingPeriodStart: taxLineItem.billingPeriodStart,
          billingPeriodEnd: taxLineItem.billingPeriodEnd,
          metricId: undefined,
          componentId: undefined,
          priceId: undefined,
          taxMetadata: taxLineItem.taxMetadata,
        });
      }
    }

    finalAmountCents = initialAmount + taxData.totalTaxCents;
    totalCreditApplied = 0;
  }

  console.log(
    `[createInvoiceWithLineItems] Final billing amount after credits (cents): ${finalAmountCents}`,
    {
      customerId: context.customer.id,
      totalCreditsApplied: totalCreditApplied,
      finalLineItemCount: allLineItems.length,
      creditsAppliedDollars: totalCreditApplied / 100,
      finalAmountDollars: finalAmountCents / 100,
      creditsWereApplied: shouldApplyCredits,
    }
  );

  // Step 3: Create the invoice and line items in database
  const invoiceResult = await createInvoiceAndLineItemsInDb(
    tx,
    context,
    allLineItems,
    finalAmountCents,
    billingSessionId,
    taxData
  );

  return invoiceResult;
}

// Helper function to check if credits should be applied based on existing active credit grants
async function checkIfShouldApplyCredits(
  context: PaymentContext,
  tx: TransactionType
): Promise<boolean> {
  console.log(
    `[checkIfShouldApplyCredits] Checking for existing active credit grants`
  );

  // Check for any active credit grants for this customer
  const activeGrants = await tx.query.creditGrants.findMany({
    where: and(
      eq(creditGrants.customerId, context.customer.id),
      eq(creditGrants.merchantId, context.merchantId),
      gt(creditGrants.remainingAmount, 0),
      or(
        gte(creditGrants.expiryDate, new Date()),
        isNull(creditGrants.expiryDate)
      ),
      lte(creditGrants.startDate, new Date()),
      isNull(creditGrants.deletedAt)
    ),
    limit: 1, // We only need to know if any exist
  });

  const hasActiveCredits = activeGrants.length > 0;

  console.log(`[checkIfShouldApplyCredits] Found active credit grants:`, {
    customerId: context.customer.id,
    merchantId: context.merchantId,
    activeGrantsCount: activeGrants.length,
    shouldApplyCredits: hasActiveCredits,
  });

  return hasActiveCredits;
}

// Helper function to check if credit renewal should be processed based on renewOnBilling definitions
async function checkIfShouldProcessRenewal(
  context: PaymentContext
): Promise<boolean> {
  console.log(
    `[checkIfShouldProcessRenewal] Checking for renewOnBilling credit definitions`
  );

  // Get plan IDs from processed subscription details
  const planIds = [
    ...new Set(
      context.processedDetails.map(
        (detail) => detail.subDetail.subscription.planId
      )
    ),
  ];

  console.log(`[checkIfShouldProcessRenewal] Checking plans:`, { planIds });

  if (planIds.length === 0) {
    console.log(`[checkIfShouldProcessRenewal] No plans found`);
    return false;
  }

  // Check for plan-scoped credit definitions with renewOnBilling = true
  let renewOnBillingDefinitions: (typeof creditDefinitions.$inferSelect)[] = [];

  for (const planId of planIds) {
    const defs = await db.query.creditDefinitions.findMany({
      where: and(
        eq(creditDefinitions.merchantId, context.merchantId),
        eq(creditDefinitions.renewOnBilling, true),
        eq(creditDefinitions.isActive, true),
        eq(creditDefinitions.planId, planId),
        isNull(creditDefinitions.deletedAt)
      ),
      limit: 1, // We only need to know if any exist for this plan
    });
    renewOnBillingDefinitions.push(...defs);

    // If we found any, we can return early
    if (defs.length > 0) {
      break;
    }
  }

  const hasRenewOnBillingDefinitions = renewOnBillingDefinitions.length > 0;

  console.log(`[checkIfShouldProcessRenewal] renewOnBilling definitions:`, {
    merchantId: context.merchantId,
    planIds,
    renewOnBillingDefinitionsCount: renewOnBillingDefinitions.length,
    shouldProcessRenewal: hasRenewOnBillingDefinitions,
  });

  return hasRenewOnBillingDefinitions;
}

// Helper function to process operations that should happen after invoice creation
async function processPostInvoiceOperations(
  context: PaymentContext,
  invoiceId: string
): Promise<void> {
  console.log(
    `[processPostInvoiceOperations] Starting post-invoice operations`,
    {
      customerId: context.customer.id,
      merchantId: context.merchantId,
      invoiceId,
    }
  );

  try {
    // Check if any renewOnBilling definitions exist first
    const shouldProcessRenewal = await checkIfShouldProcessRenewal(context);

    if (shouldProcessRenewal) {
      console.log(`[processPostInvoiceOperations] Processing credit renewals`);

      // Process credit renewals in a separate transaction
      await db.transaction(async (tx) => {
        const renewalResult = await processRenewalAfterInvoice(
          context.merchantId,
          context.customer.id,
          tx
        );

        console.log(
          `[processPostInvoiceOperations] Credit renewals completed`,
          {
            customerId: context.customer.id,
            renewalCount: renewalResult.renewalCount,
            invoiceId,
          }
        );
      });
    } else {
      console.log(
        `[processPostInvoiceOperations] Skipping credit renewals (no renewOnBilling definitions found)`
      );
    }

    // Update subscription billing cycle
    // Update the subscription billing cycle for each component
    const effectiveTimezone = await getEffectiveTimezone(
      context.customer.id,
      context.merchantId
    );

    for (const data of context.processedDetails) {
      await updateSubscriptionBillingCycle(
        data.subDetail.id,
        data.billingPeriodEnd,
        data.component,
        effectiveTimezone
      );
    }

    // Future: Other post-invoice operations can be added here
    // - Webhook notifications
    // - Analytics events
    // - Custom business logic
  } catch (error) {
    // Log error but don't fail the entire payment process
    console.error(
      `[processPostInvoiceOperations] Error in post-invoice operations: ${error}`,
      {
        customerId: context.customer.id,
        merchantId: context.merchantId,
        invoiceId,
        error,
      }
    );

    // Don't throw - post-invoice operations are supplementary
    // The core invoice creation and payment should not fail if renewals fail
  }
}

// Helper function to get all customers that should be billed
async function getCustomersToBill(
  context: PaymentContext
): Promise<(typeof customers.$inferSelect)[]> {
  // For non-seat-aware plans, just return the primary customer
  if (!context.seatAwareUsage) {
    return [context.customer];
  }

  // For seat-aware plans, get all organization members
  if (!context.customer.customerOrganizationId) {
    console.log(
      `[getCustomersToBill] Seat-aware plan but customer ${context.customer.id} has no organization, treating as single customer`
    );
    return [context.customer];
  }

  // Get all customers in the organization
  const orgCustomers = await db.query.customers.findMany({
    where: and(
      eq(
        customers.customerOrganizationId,
        context.customer.customerOrganizationId
      ),
      eq(customers.merchantId, context.merchantId),
      isNull(customers.deletedAt)
    ),
  });

  console.log(
    `[getCustomersToBill] Found ${orgCustomers.length} customers in organization ${context.customer.customerOrganizationId}`
  );

  return orgCustomers;
}

// Helper function to generate charge line items for pricing components
async function generateChargeLineItems(
  context: PaymentContext
): Promise<
  | { type: "skip"; response: any }
  | { lineItems: InternalLineItem[]; totalAmountCents: number }
> {
  console.log(
    `[generateChargeLineItems] Generating line items for ${context.processedDetails.length} components`
  );

  // Determine all customers to bill (for seat-based plans, this includes all org members)
  const customersToBill = await getCustomersToBill(context);
  console.log(
    `[generateChargeLineItems] Will generate line items for ${customersToBill.length} customer(s)`,
    {
      isSeatAware: context.seatAwareUsage,
      customerIds: customersToBill.map((c) => c.id),
    }
  );

  // Check for pending scheduled changes that would affect pricing
  const subscriptionId = context.processedDetails[0]?.subDetail.subscription.id;
  let pendingChange: { newPriceId: string; newPlanId: string } | null = null;

  if (!subscriptionId) {
    console.warn(
      `[generateChargeLineItems] No subscription ID found in processed details, skipping price override logic`
    );
  } else {
    try {
      pendingChange = await fetchPendingScheduledChange(subscriptionId);
    } catch (error) {
      console.error(
        `[generateChargeLineItems] Error fetching pending scheduled change for subscription ${subscriptionId}:`,
        error
      );
      // Continue without price overrides rather than failing the entire billing
    }
  }

  // Build component mapping for price overrides if there's a pending change
  let targetComponentMap: Map<string, PriceComponentSchemaType> | null = null;
  let targetPriceCurrency: string | null = null;

  if (pendingChange) {
    console.log(
      `[generateChargeLineItems] Found pending scheduled change for subscription ${subscriptionId}`,
      {
        newPriceId: pendingChange.newPriceId,
        newPlanId: pendingChange.newPlanId,
      }
    );

    try {
      // Fetch the target price
      const targetPrice = await db.query.prices.findFirst({
        where: and(
          eq(prices.id, pendingChange.newPriceId),
          eq(prices.merchantId, context.merchantId),
          isNull(prices.deletedAt)
        ),
      });

      if (targetPrice) {
        // Validate currency compatibility
        const currentPriceCurrency =
          context.processedDetails[0]?.subDetail.subscription.price.currency;
        targetPriceCurrency = targetPrice.currency;

        if (currentPriceCurrency !== targetPriceCurrency) {
          console.warn(
            `[generateChargeLineItems] Currency mismatch detected - current: ${currentPriceCurrency}, target: ${targetPriceCurrency}. Skipping price overrides for safety.`
          );
        } else {
          console.log(
            `[generateChargeLineItems] Building component mapping from target price with ${targetPrice.pricingData.components.length} components`
          );

          targetComponentMap = new Map();
          for (const component of targetPrice.pricingData.components) {
            const key = buildComponentKey(component);
            if (targetComponentMap.has(key)) {
              console.warn(
                `[generateChargeLineItems] Duplicate component key detected: ${key}. Using first occurrence.`
              );
            } else {
              targetComponentMap.set(key, component);
            }
          }

          console.log(
            `[generateChargeLineItems] Component mapping built successfully with ${targetComponentMap.size} unique components`
          );
        }
      } else {
        console.warn(
          `[generateChargeLineItems] Target price ${pendingChange.newPriceId} not found or deleted, proceeding without overrides`
        );
      }
    } catch (error) {
      console.error(
        `[generateChargeLineItems] Error fetching target price ${pendingChange.newPriceId}:`,
        error
      );
      // Continue without price overrides rather than failing the entire billing
    }
  } else {
    console.log(
      `[generateChargeLineItems] No pending scheduled changes found for subscription ${subscriptionId}, proceeding with current pricing`
    );
  }

  let totalAmountCents = 0;
  const lineItems: InternalLineItem[] = [];

  for (const data of context.processedDetails) {
    console.log(`[generateChargeLineItems] Processing component`, {
      componentId: data.component.component_id,
      billingPeriodStart: data.billingPeriodStart.toISOString(),
      billingPeriodEnd: data.billingPeriodEnd.toISOString(),
    });

    // Determine which component to use for line item generation
    let componentToUse = data.component;

    // Apply price override if there's a pending change and component should be billed immediately
    if (targetComponentMap && data.component.bill_immediately !== false) {
      try {
        const componentKey = buildComponentKey(data.component);
        const targetComponent = targetComponentMap.get(componentKey);

        if (targetComponent) {
          // Validate component type compatibility before applying override
          if (data.component.type !== targetComponent.type) {
            console.warn(
              `[generateChargeLineItems] Component type mismatch for ${data.component.component_id} - current: ${data.component.type}, target: ${targetComponent.type}. Skipping override.`
            );
          } else {
            try {
              componentToUse = overrideComponentAmounts(
                data.component,
                targetComponent
              );

              // Extract amounts for logging with proper type checking
              const getComponentAmount = (comp: PriceComponentSchemaType) => {
                if (comp.type === "usage") return (comp as any).unit_cost_cents;
                return (comp as any).amount_cents;
              };

              const oldAmount = getComponentAmount(data.component);
              const newAmount = getComponentAmount(targetComponent);

              // Log metric_id changes for usage components
              const metricIdInfo =
                data.component.type === "usage" &&
                targetComponent.type === "usage"
                  ? {
                      oldMetricId: (data.component as any).metric_id,
                      newMetricId: (targetComponent as any).metric_id,
                      metricIdChanged:
                        (data.component as any).metric_id !==
                        (targetComponent as any).metric_id,
                    }
                  : {};

              console.log(
                `[generateChargeLineItems] Applied price override for component ${data.component.component_id}`,
                {
                  componentKey,
                  componentType: data.component.type,
                  oldAmount,
                  newAmount,
                  amountChange: newAmount - oldAmount,
                  billImmediately: data.component.bill_immediately,
                  ...metricIdInfo,
                }
              );
            } catch (overrideError) {
              console.error(
                `[generateChargeLineItems] Error applying price override for component ${data.component.component_id}:`,
                overrideError
              );
              // Use original component if override fails
            }
          }
        } else {
          console.log(
            `[generateChargeLineItems] No matching target component found for key: ${componentKey}, using original pricing`,
            {
              componentId: data.component.component_id,
              componentType: data.component.type,
              availableKeys: Array.from(targetComponentMap.keys()),
            }
          );
        }
      } catch (keyError) {
        console.error(
          `[generateChargeLineItems] Error building component key for ${data.component.component_id}:`,
          keyError
        );
        // Continue with original component if key building fails
      }
    } else if (
      targetComponentMap &&
      data.component.bill_immediately === false
    ) {
      console.log(
        `[generateChargeLineItems] Component ${data.component.component_id} has bill_immediately=false, skipping price override (using past period pricing)`,
        {
          componentType: data.component.type,
          reason: "preserving_past_period_pricing",
        }
      );
    } else if (targetComponentMap) {
      console.log(
        `[generateChargeLineItems] Component ${data.component.component_id} bill_immediately is undefined, treating as true and applying override if available`
      );
      // Note: bill_immediately defaults to true, so undefined should be treated as true
    }

    // For usage components, generate line items for each customer in the organization
    if (componentToUse.type === "usage" && customersToBill.length > 1) {
      console.log(
        `[generateChargeLineItems] Generating usage line items for ${customersToBill.length} customers`
      );

      for (const customerToBill of customersToBill) {
        const lineItem = await generateLineItemObjectForComponent(
          componentToUse,
          context.merchantId,
          customerToBill.id,
          data.billingPeriodStart,
          data.billingPeriodEnd,
          data.subDetail.subscription.price.id,
          data.subDetail.subscription.id
        );

        // Add customer identifier to description for seat-based plans
        if (lineItem.quantity && lineItem.quantity > 0) {
          // Use email if available, otherwise use external customer ID
          const customerIdentifier =
            customerToBill.email ||
            customerToBill.externalCustomerId ||
            customerToBill.id;
          lineItem.description = `${lineItem.description} (${customerIdentifier})`;

          console.log(`[generateChargeLineItems] Generated usage line item`, {
            componentId: data.component.component_id,
            customerId: customerToBill.id,
            customerEmail: customerToBill.email,
            customerExternalId: customerToBill.externalCustomerId,
            quantity: lineItem.quantity,
            subtotalCents: lineItem.subtotalCents,
            description: lineItem.description,
          });

          totalAmountCents += lineItem.subtotalCents;
          lineItems.push(lineItem);
        }
      }
    } else {
      // For non-usage components or single customer, generate one line item
      const lineItem = await generateLineItemObjectForComponent(
        componentToUse,
        context.merchantId,
        context.customer.id,
        data.billingPeriodStart,
        data.billingPeriodEnd,
        data.subDetail.subscription.price.id,
        data.subDetail.subscription.id
      );

      console.log(`[generateChargeLineItems] Generated line item`, {
        componentId: data.component.component_id,
        subtotalCents: lineItem.subtotalCents,
        description: lineItem.description,
        priceOverrideApplied: componentToUse !== data.component,
      });

      totalAmountCents += lineItem.subtotalCents;
      lineItems.push(lineItem);
    }
  }

  console.log(
    `[generateChargeLineItems] Initial billing amount before credits (cents): ${totalAmountCents}`,
    {
      customerId: context.customer.id,
      lineItemCount: lineItems.length,
      amountDollars: totalAmountCents / 100,
      isZeroAmount: totalAmountCents === 0,
    }
  );

  // Note: We proceed with invoice creation even for zero amounts to ensure
  // post-invoice operations (credit renewals, billing cycle updates, etc.) are processed
  return { lineItems, totalAmountCents };
}

// Helper function to apply credit waterfall and generate credit line items
async function applyCreditWaterfall(
  context: PaymentContext,
  chargeLineItems: InternalLineItem[],
  initialAmountCents: number,
  billingSessionId: string,
  tx: TransactionType
): Promise<{
  allLineItems: InternalLineItem[];
  finalAmountCents: number;
  totalCreditApplied: number;
  taxData: TaxCalculationResult;
}> {
  console.log(`[applyCreditWaterfall] Starting credit application process`);

  const allLineItems: InternalLineItem[] = [...chargeLineItems];
  let totalAmountCents = initialAmountCents;
  let totalCreditApplied = 0;

  // Step 1: Add usage credit line items (converted to monetary values)
  console.log(`[applyCreditWaterfall] Checking for usage credits`);

  // Get all customers to check for credits (for seat-based plans)
  const customersToBill = await getCustomersToBill(context);

  const usageCreditLineItems = await generateUsageCreditLineItems(
    {
      merchantId: context.merchantId,
      customerId: context.customer.id,
      customersToBill,
      processedDetails: context.processedDetails,
      billingSessionId,
    },
    tx
  );

  console.log(
    `[applyCreditWaterfall] Found ${usageCreditLineItems.length} usage credit line items`
  );

  for (const creditLineItem of usageCreditLineItems) {
    console.log(`[applyCreditWaterfall] Adding usage credit line item`, {
      description: creditLineItem.description,
      creditAmount: Math.abs(creditLineItem.subtotalCents),
    });
    allLineItems.push(creditLineItem);
    totalAmountCents += creditLineItem.subtotalCents; // subtotalCents is negative for credits
    totalCreditApplied += Math.abs(creditLineItem.subtotalCents);
  }

  // Step 2: Apply component-specific monetary credits (price_id + component_id)
  console.log(
    `[applyCreditWaterfall] Checking price component-specific monetary credits`
  );

  for (const lineItem of chargeLineItems) {
    if (lineItem.componentId && lineItem.priceId) {
      console.log(`[applyCreditWaterfall] Checking credits for component`, {
        componentId: lineItem.componentId,
        priceId: lineItem.priceId,
      });

      const componentMonetaryCredits = await getActiveComponentMonetaryCredits(
        context.customer.id,
        lineItem.priceId,
        lineItem.componentId,
        tx
      );

      console.log(
        `[applyCreditWaterfall] Found ${componentMonetaryCredits.length} component monetary credits`
      );

      if (componentMonetaryCredits.length > 0) {
        const creditAmount = await applyMonetaryCredits(
          componentMonetaryCredits,
          lineItem.subtotalCents, // Use original line item amount
          {
            merchantId: context.merchantId,
            customerId: context.customer.id,
            billingSessionId,
          },
          tx
        );

        if (creditAmount > 0) {
          console.log(
            `[applyCreditWaterfall] Applied component credits: $${creditAmount / 100}`,
            {
              customerId: context.customer.id,
              componentId: lineItem.componentId,
              priceId: lineItem.priceId,
              lineItemAmount: `$${lineItem.subtotalCents / 100}`,
              monetaryCreditsCount: componentMonetaryCredits.length,
            }
          );

          // Create description based on number of credits applied
          let description: string;
          if (componentMonetaryCredits.length === 1) {
            description = buildCreditDescription(
              componentMonetaryCredits[0].creditDefinition,
              {
                type: "component",
                componentDescription: lineItem.description,
              }
            );
          } else {
            // Multiple credits - use a general description with count
            const creditNames = componentMonetaryCredits
              .map(
                (c) =>
                  c.creditDefinition.billingDescription ||
                  c.creditDefinition.name
              )
              .join(", ");
            description = `Component credits (${componentMonetaryCredits.length}): ${lineItem.description}`;
          }

          // Add credit line item for billing visibility
          allLineItems.push({
            type: "credit",
            description,
            quantity: 1,
            unitAmountCents: -creditAmount,
            subtotalCents: -creditAmount,
            componentId: lineItem.componentId,
            priceId: lineItem.priceId,
            billingPeriodStart: lineItem.billingPeriodStart,
            billingPeriodEnd: lineItem.billingPeriodEnd,
            metricId: undefined, // Credit line items don't have metrics
            taxMetadata: undefined,
          });

          totalAmountCents -= creditAmount;
          totalCreditApplied += creditAmount;
        }
      }
    }
  }

  // Step 3: Apply price-level monetary credits (price_id only, no component_id)
  const uniquePriceIds = [
    ...new Set(
      chargeLineItems
        .filter((item) => item.priceId) // Filter out items without priceId
        .map((item) => item.priceId!) // Non-null assertion since we filtered above
    ),
  ];

  console.log(
    `[applyCreditWaterfall] Checking price-level monetary credits for ${uniquePriceIds.length} unique prices`
  );

  for (const priceId of uniquePriceIds) {
    if (totalAmountCents <= 0) {
      console.log(
        `[applyCreditWaterfall] Total amount already zero, skipping remaining price-level credits`
      );
      continue;
    }

    console.log(
      `[applyCreditWaterfall] Checking price-level credits for price ${priceId}`
    );

    const monetaryCredits = await getActiveMonetaryCredits(
      context.customer.id,
      priceId,
      tx
    );

    console.log(
      `[applyCreditWaterfall] Found ${monetaryCredits.length} price-level monetary credits`
    );

    if (monetaryCredits.length > 0) {
      const creditAmount = await applyMonetaryCredits(
        monetaryCredits,
        totalAmountCents, // Use current total remaining amount
        {
          merchantId: context.merchantId,
          customerId: context.customer.id,
          billingSessionId,
        },
        tx
      );

      if (creditAmount > 0) {
        console.log(
          `[applyCreditWaterfall] Applied price-level monetary credits: $${creditAmount / 100}`,
          {
            customerId: context.customer.id,
            priceId: priceId,
            totalRemainingAmount: `$${(totalAmountCents + creditAmount) / 100}`,
          }
        );

        // Create description based on number of credits applied
        let description: string;
        if (monetaryCredits.length === 1) {
          description = buildCreditDescription(
            monetaryCredits[0].creditDefinition,
            {
              type: "price",
            }
          );
        } else {
          // Multiple credits - use a general description
          description = `Price credits applied (${monetaryCredits.length})`;
        }

        // Add credit line item for billing visibility
        allLineItems.push({
          type: "credit",
          description,
          quantity: 1,
          unitAmountCents: -creditAmount,
          subtotalCents: -creditAmount,
          componentId: undefined, // Price-level credits don't target specific components
          priceId: priceId,
          billingPeriodStart: context.processedDetails[0].billingPeriodStart,
          billingPeriodEnd: context.processedDetails[0].billingPeriodEnd,
          metricId: undefined, // Credit line items don't have metrics
          taxMetadata: undefined,
        });

        totalAmountCents -= creditAmount;
        totalCreditApplied += creditAmount;
      }
    }
  }

  // Step 4: Apply plan-level credits
  if (totalAmountCents > 0) {
    const planId = context.processedDetails[0].subDetail.subscription.planId;

    console.log(
      `[applyCreditWaterfall] Checking plan-level credits for plan ${planId}`
    );

    const planLevelCredits = await getActivePlanLevelCredits(
      context.customer.id,
      planId,
      tx
    );

    console.log(
      `[applyCreditWaterfall] Found ${planLevelCredits.length} plan-level credits`
    );

    if (planLevelCredits.length > 0) {
      const creditAmount = await applyPlanLevelCredits(
        planLevelCredits,
        totalAmountCents,
        {
          merchantId: context.merchantId,
          customerId: context.customer.id,
          billingSessionId,
        },
        tx
      );

      if (creditAmount > 0) {
        console.log(
          `[applyCreditWaterfall] Applied plan-level credits: $${creditAmount / 100}`,
          {
            customerId: context.customer.id,
            planId: planId,
            creditsCount: planLevelCredits.length,
          }
        );

        // Create description based on number of credits applied
        let description: string;
        if (planLevelCredits.length === 1) {
          description = buildCreditDescription(
            planLevelCredits[0].creditDefinition,
            {
              type: "plan",
            }
          );
        } else {
          // Multiple credits - use a general description
          description = `Plan credits applied (${planLevelCredits.length})`;
        }

        // Add credit line item for billing visibility
        allLineItems.push({
          type: "credit",
          description,
          quantity: 1,
          unitAmountCents: -creditAmount,
          subtotalCents: -creditAmount,
          componentId: undefined,
          priceId: undefined,
          billingPeriodStart: context.processedDetails[0].billingPeriodStart,
          billingPeriodEnd: context.processedDetails[0].billingPeriodEnd,
          metricId: undefined,
          taxMetadata: undefined,
        });

        totalAmountCents -= creditAmount;
        totalCreditApplied += creditAmount;
      }
    }
  } else {
    console.log(
      `[applyCreditWaterfall] Total amount already zero, skipping plan-level credits`
    );
  }

  // Step 5: Apply merchant-level account credits
  if (totalAmountCents > 0) {
    console.log(
      `[applyCreditWaterfall] Checking merchant-level account credits`
    );

    const merchantLevelCredits = await getActiveMerchantLevelCredits(
      context.customer.id,
      context.merchantId,
      tx
    );

    console.log(
      `[applyCreditWaterfall] Found ${merchantLevelCredits.length} merchant-level credits`
    );

    if (merchantLevelCredits.length > 0) {
      const creditAmount = await applyMerchantLevelCredits(
        merchantLevelCredits,
        totalAmountCents,
        {
          merchantId: context.merchantId,
          customerId: context.customer.id,
          billingSessionId,
        },
        tx
      );

      if (creditAmount > 0) {
        console.log(
          `[applyCreditWaterfall] Applied merchant-level account credits: $${creditAmount / 100}`,
          {
            customerId: context.customer.id,
            merchantId: context.merchantId,
            creditsCount: merchantLevelCredits.length,
          }
        );

        // Create description based on number of credits applied
        let description: string;
        if (merchantLevelCredits.length === 1) {
          description = buildCreditDescription(
            merchantLevelCredits[0].creditDefinition,
            {
              type: "merchant",
            }
          );
        } else {
          // Multiple credits - use a general description
          description = `Account credits applied (${merchantLevelCredits.length})`;
        }

        // Add credit line item for billing visibility
        allLineItems.push({
          type: "credit",
          description,
          quantity: 1,
          unitAmountCents: -creditAmount,
          subtotalCents: -creditAmount,
          componentId: undefined,
          priceId: undefined,
          billingPeriodStart: context.processedDetails[0].billingPeriodStart,
          billingPeriodEnd: context.processedDetails[0].billingPeriodEnd,
          metricId: undefined,
          taxMetadata: undefined,
        });

        totalAmountCents -= creditAmount;
        totalCreditApplied += creditAmount;
      }
    }
  } else {
    console.log(
      `[applyCreditWaterfall] Total amount already zero, skipping merchant-level credits`
    );
  }

  // Ensure total amount is not negative before tax calculation
  totalAmountCents = Math.max(0, totalAmountCents);

  // Step 6: Calculate taxes on the post-credit amount
  console.log(
    `[applyCreditWaterfall] Calculating taxes on amount after credits: $${totalAmountCents / 100}`
  );

  const taxCalculationResult = await calculateTaxes({
    merchantId: context.merchantId,
    customerId: context.customer.id,
    subtotalAfterCredits: totalAmountCents,
    lineItems: chargeLineItems.map((item) => ({
      type: item.type,
      description: item.description,
      subtotalCents: item.subtotalCents,
      componentId: item.componentId,
      priceId: item.priceId,
      billingPeriodStart: item.billingPeriodStart,
      billingPeriodEnd: item.billingPeriodEnd,
    })),
    currency: context.currency,
    billingDate: context.processedDetails[0].billingPeriodStart,
  });

  console.log(`[applyCreditWaterfall] Tax calculation completed`, {
    taxAmount: taxCalculationResult.totalTaxCents,
    effectiveRate: taxCalculationResult.effectiveTaxRate,
    jurisdiction: taxCalculationResult.jurisdiction,
    method: taxCalculationResult.calculationMethod,
  });

  // Add tax line items if applicable
  if (taxCalculationResult.taxLineItems.length > 0) {
    for (const taxLineItem of taxCalculationResult.taxLineItems) {
      allLineItems.push({
        type: taxLineItem.type,
        description: taxLineItem.description,
        subtotalCents: taxLineItem.subtotalCents,
        quantity: 1,
        unitAmountCents: taxLineItem.subtotalCents,
        billingPeriodStart: taxLineItem.billingPeriodStart,
        billingPeriodEnd: taxLineItem.billingPeriodEnd,
        metricId: undefined,
        componentId: undefined,
        priceId: undefined,
        taxMetadata: taxLineItem.taxMetadata,
      });
    }
    totalAmountCents += taxCalculationResult.totalTaxCents;
  }

  const finalAmountCents = Math.max(0, totalAmountCents);

  // If total amount is zero after credits, log it
  if (finalAmountCents === 0 && taxCalculationResult.totalTaxCents === 0) {
    console.log(
      `[applyCreditWaterfall] Invoice fully covered by credits for customer ${context.customer.id}, creating zero-amount invoice`
    );
  }

  return {
    allLineItems,
    finalAmountCents,
    totalCreditApplied,
    taxData: taxCalculationResult,
  };
}

// Helper function to create invoice and line items in database
async function createInvoiceAndLineItemsInDb(
  tx: TransactionType,
  context: PaymentContext,
  lineItems: InternalLineItem[],
  totalAmountCents: number,
  billingSessionId: string,
  taxData: TaxCalculationResult
): Promise<{ invoice: Invoice; invoiceId: string }> {
  // Generate a customer invoice number
  const sequenceNumber = await getAndIncrementInvoiceCounter(
    tx,
    context.merchantId,
    context.customer.id
  );

  const customerInvoiceNumber = formatCustomerInvoiceNumber(
    context.customer.invoicePrefix || context.customer.id.slice(4, 10),
    sequenceNumber
  );

  console.log(
    `[createInvoiceAndLineItemsInDb] Generated invoice number: ${customerInvoiceNumber}`
  );

  const billingDate = new Date();

  // Create the invoice with the final amount after credit application
  console.log(
    `[createInvoiceAndLineItemsInDb] Creating invoice record in database`
  );

  const [newInvoice] = await tx
    .insert(invoices)
    .values({
      merchantId: context.merchantId,
      customerId: context.customer.id,
      subscriptionId: context.processedDetails[0].subDetail.subscriptionId,
      status: "issued",
      totalAmountCents,
      subtotalCents: taxData.taxableAmount,
      taxAmountCents: taxData.totalTaxCents,
      effectiveTaxRate: taxData.effectiveTaxRate.toString(),
      taxJurisdiction: taxData.jurisdiction,
      taxCalculationMethod: taxData.calculationMethod,
      currency: context.currency,
      customerInvoiceNumber,
      dueDate: billingDate,
      issueDate: billingDate,
      billingPeriodStart: context.processedDetails[0].billingPeriodStart,
      billingPeriodEnd: context.processedDetails[0].billingPeriodEnd,
    })
    .returning();

  console.log(
    `[createInvoiceAndLineItemsInDb] Created invoice ${newInvoice.id}`
  );

  // Create all invoice line items (including credit line items)
  console.log(
    `[createInvoiceAndLineItemsInDb] Creating ${lineItems.length} line items in database`
  );

  console.log(
    "[createInvoiceAndLineItemsInDb] Line items to create:",
    lineItems.map((item) => ({
      type: item.type,
      description: item.description,
      subtotalCents: item.subtotalCents,
      taxMetadata: item.taxMetadata,
    }))
  );

  console.log("[createInvoiceAndLineItemsInDb] Tax calculation result:", {
    taxLineItemsCount: taxData.taxLineItems.length,
    taxLineItems: taxData.taxLineItems.map((item) => ({
      type: item.type,
      description: item.description,
      subtotalCents: item.subtotalCents,
      taxMetadata: item.taxMetadata,
    })),
  });

  await tx.insert(invoiceLineItems).values(
    lineItems.map((item) => {
      // Prefer taxMetadata directly present on the internal line item; fall back to lookup by description/type
      const taxLineItem =
        item.taxMetadata && item.type === "tax"
          ? { taxMetadata: item.taxMetadata }
          : taxData.taxLineItems.find(
              (taxItem) =>
                taxItem.description === item.description && item.type === "tax"
            );

      const lineItemToCreate = {
        invoiceId: newInvoice.id,
        type: item.type || "charge",
        componentId: item.componentId || null,
        description: item.description,
        quantity: item.quantity ?? 1,
        unitAmountCents: item.unitAmountCents || item.subtotalCents,
        subtotalCents: item.subtotalCents,
        billingPeriodStart: item.billingPeriodStart,
        billingPeriodEnd: item.billingPeriodEnd,
        metricId: item.metricId || null,
        taxMetadata: taxLineItem ? taxLineItem.taxMetadata : null,
      };

      if (item.type === "tax") {
        console.log("[createInvoiceAndLineItemsInDb] Creating tax line item:", {
          description: lineItemToCreate.description,
          subtotalCents: lineItemToCreate.subtotalCents,
          taxMetadata: lineItemToCreate.taxMetadata,
          foundTaxLineItem: !!taxLineItem,
        });
      }

      return lineItemToCreate;
    })
  );

  console.log(
    `[createInvoiceAndLineItemsInDb] Created line items for invoice ${newInvoice.id}`
  );

  // Update all credit transactions with the actual invoice ID
  console.log(
    `[createInvoiceAndLineItemsInDb] Updating credit transactions with invoice ID`
  );
  await updateCreditTransactionsWithInvoiceId(
    billingSessionId,
    newInvoice.id,
    tx
  );

  // Trigger PDF generation only if the customer already has a payment method
  if (context.paymentMethod) {
    console.log(
      `[createInvoiceAndLineItemsInDb] Triggering PDF generation for invoice ${newInvoice.id}`
    );
    await triggerPdfGeneration(tx, newInvoice.id);
  } else {
    console.log(
      `[createInvoiceAndLineItemsInDb] Skipping initial PDF generation for invoice ${newInvoice.id} because no payment method is on file. It will be generated after the checkout link is attached.`
    );
  }

  console.log(
    `[createInvoiceAndLineItemsInDb] Invoice creation completed successfully`,
    {
      invoiceId: newInvoice.id,
      totalAmountCents,
      lineItemCount: lineItems.length,
    }
  );

  return { invoice: newInvoice, invoiceId: newInvoice.id };
}

// Helper function to trigger PDF generation
async function triggerPdfGeneration(
  tx: TransactionType,
  invoiceId: string
): Promise<void> {
  try {
    const invoiceWithDetails = await tx.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
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
      console.info(
        `[triggerPdfGeneration] Called triggerInvoicePdfGeneration for invoice ${invoiceId}`
      );
    }
  } catch (pdfError) {
    console.error(
      `Failed to trigger PDF generation: ${pdfError instanceof Error ? pdfError.message : String(pdfError)}`
    );
  }
}

// Helper function to check for and apply scheduled changes during billing
async function checkAndApplyScheduledChanges(
  subscriptionId: string,
  merchantId: string
): Promise<string> {
  // Check if subscription has pending migration scheduled for next billing
  const pendingChange = await db.query.subscriptionsScheduledChanges.findFirst({
    where: and(
      eq(subscriptionsScheduledChanges.subscriptionId, subscriptionId),
      eq(subscriptionsScheduledChanges.effectiveOnNextBilling, true),
      isNull(subscriptionsScheduledChanges.processedAt)
    ),
  });

  if (!pendingChange) {
    // No pending changes, return original subscription ID
    return subscriptionId;
  }

  console.log(`Found pending migration for subscription ${subscriptionId}`, {
    changeId: pendingChange.id,
    newPlanId: pendingChange.newPlanId,
    newPriceId: pendingChange.newPriceId,
  });

  try {
    // Get the current subscription
    const currentSubscription = await db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.merchantId, merchantId),
        isNull(subscriptions.deletedAt),
        isNull(subscriptions.endTimestamp)
      ),
    });

    if (!currentSubscription) {
      throw new Error(`Subscription ${subscriptionId} not found`);
    }

    // Get target plan and price
    const targetPlan = await db.query.plans.findFirst({
      where: and(
        eq(plans.id, pendingChange.newPlanId!),
        isNull(plans.deletedAt)
      ),
    });

    const targetPrice = await db.query.prices.findFirst({
      where: and(
        eq(prices.id, pendingChange.newPriceId!),
        isNull(prices.deletedAt)
      ),
    });

    if (!targetPlan || !targetPrice) {
      console.warn(
        `Target plan ${pendingChange.newPlanId} or price ${pendingChange.newPriceId} not found - marking scheduled change as processed to prevent retry`
      );

      // Mark the scheduled change as processed to prevent infinite retries
      await db
        .update(subscriptionsScheduledChanges)
        .set({ processedAt: new Date() })
        .where(eq(subscriptionsScheduledChanges.id, pendingChange.id));

      // Continue with original subscription
      return subscriptionId;
    }

    // Perform the migration
    const newSubscription = await migrateSubscription({
      oldSubscription: currentSubscription,
      targetPlan,
      targetPrice,
      merchantId,
    });

    // Mark scheduled change as processed
    await db
      .update(subscriptionsScheduledChanges)
      .set({ processedAt: new Date() })
      .where(eq(subscriptionsScheduledChanges.id, pendingChange.id));

    console.log(`Successfully migrated subscription during billing`, {
      oldSubscriptionId: subscriptionId,
      newSubscriptionId: newSubscription.id,
      changeId: pendingChange.id,
    });

    // Return new subscription ID for continued billing
    return newSubscription.id;
  } catch (error) {
    console.error(`Failed to apply scheduled change during billing:`, error);
    // On error, continue with original subscription
    return subscriptionId;
  }
}

// Helper function to handle payment failures
async function handlePaymentFailure(
  error: any,
  customerId: string,
  paymentMethod: typeof paymentMethods.$inferSelect
): Promise<any> {
  if (error instanceof Stripe.errors.StripeCardError) {
    console.warn(`Card declined for customer ${customerId}: ${error.message}`);

    try {
      await db
        .update(paymentMethods)
        .set({
          lastFailedAt: new Date(),
          failureReason: error.message,
        })
        .where(eq(paymentMethods.id, paymentMethod.id));
    } catch (updateError) {
      console.error(
        "Failed to update payment method failure info:",
        updateError
      );
    }

    return {
      success: false,
      status: "card_declined",
      message: error.message,
    };
  } else if (error instanceof Stripe.errors.StripeError) {
    console.error(`Stripe error for customer ${customerId}: ${error}`, {
      error,
    });
    return {
      success: false,
      status: "stripe_error",
      message: error.message,
    };
  } else {
    console.error("Error processing payment:", error);
    return {
      success: false,
      status: "error",
      message:
        error instanceof Error
          ? `Error: ${error.message}`
          : "Unknown error occurred",
    };
  }
}

// Helper function to fetch pending scheduled change for a subscription
async function fetchPendingScheduledChange(
  subscriptionId: string
): Promise<{ newPriceId: string; newPlanId: string } | null> {
  const pendingChange = await db.query.subscriptionsScheduledChanges.findFirst({
    where: and(
      eq(subscriptionsScheduledChanges.subscriptionId, subscriptionId),
      eq(subscriptionsScheduledChanges.effectiveOnNextBilling, true),
      isNull(subscriptionsScheduledChanges.processedAt)
    ),
  });

  if (!pendingChange || !pendingChange.newPriceId || !pendingChange.newPlanId) {
    return null;
  }

  return {
    newPriceId: pendingChange.newPriceId,
    newPlanId: pendingChange.newPlanId,
  };
}

// Helper function to build a unique key for component matching
function buildComponentKey(component: PriceComponentSchemaType): string {
  const type = component.type;

  // Use component_name if available, otherwise fall back to label
  const name = component.component_name || component.label;

  // Normalize the name: lowercase and trim whitespace
  const normalizedName = name.toLowerCase().trim();

  return `${type}::${normalizedName}`;
}

// Helper function to create a component with overridden amounts from target component
function overrideComponentAmounts(
  oldComponent: PriceComponentSchemaType,
  newComponent: PriceComponentSchemaType
): PriceComponentSchemaType {
  // Override amounts based on component type with proper type guards
  if (oldComponent.type === "fixed" && newComponent.type === "fixed") {
    return {
      ...oldComponent,
      amount_cents: newComponent.amount_cents,
    };
  }

  if (oldComponent.type === "per_unit" && newComponent.type === "per_unit") {
    return {
      ...oldComponent,
      amount_cents: newComponent.amount_cents,
    };
  }

  if (oldComponent.type === "usage" && newComponent.type === "usage") {
    return {
      ...oldComponent,
      unit_cost_cents: newComponent.unit_cost_cents,
      metric_id: newComponent.metric_id, // CRITICAL: Also override metric_id for usage components
    };
  }

  // If types don't match or aren't supported, return original component
  return oldComponent;
}

// Helper function to get the next attempt number for payment retries
// NOTE: This is not concurrency-safe if invoked in parallel for the same invoice.
// For the MVP we run a single scheduled job daily, so the risk of duplicate
// attempt numbers is acceptable. If we later introduce parallelism, we should
// move this to a DB-side atomic increment or enforce uniqueness at write time.
async function getNextAttemptNumber(invoiceId: string): Promise<number> {
  const lastRetry = await db.query.paymentRetries.findFirst({
    where: eq(paymentRetries.invoiceId, invoiceId),
    orderBy: (paymentRetries, { desc }) => [desc(paymentRetries.attemptNumber)],
  });

  return (lastRetry?.attemptNumber || 0) + 1;
}

export const billingRouter = new Hono()
  // Route to check for subscriptions due for billing
  .post("/check-due", zValidator("json", checkDueSchema), async (c) => {
    // Get current date in UTC
    const checkUptoDueDate = c.req.valid("json").checkUptoDueDate
      ? new Date(c.req.valid("json").checkUptoDueDate!)
      : new Date();

    // The nextBillingDate in the database is already stored in UTC with timezone
    // consideration done during initial calculation and updates. This means
    // we can use a direct database query to find due subscriptions efficiently.
    // TODO: Maybe we should get ALL the invoices for the CURRENT day (ie, we set the
    // time in the currentDateUTC to be 23:59:59) and manually distribute the workload
    // (by random selection maybe?). How would TZ affect the timing of invoices in that case?
    const subDetails = await db.query.subscriptionDetails.findMany({
      where: and(
        lte(subscriptionDetails.nextBillingDate, checkUptoDueDate),
        isNull(subscriptionDetails.deletedAt)
      ),
      with: {
        subscription: {
          with: {
            price: true,
            customer: true,
          },
        },
      },
    });

    // Check if any subscriptions are more than 1 day overdue (for logging purposes)
    const oneDayAgo = new Date(checkUptoDueDate);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const overdueSubs = subDetails.filter(
      (sub) => sub.nextBillingDate < oneDayAgo
    );

    if (overdueSubs.length > 0) {
      console.warn(
        `Found ${overdueSubs.length} subscriptions with next billing date more than 1 day overdue`
      );
    }

    const subscriptionsDue = subDetails.map((sub) => ({
      subscriptionId: sub.subscription.id,
      subscriptionDetailsId: sub.id,
      customerId: sub.subscription.customerId,
      nextBillingDate: sub.nextBillingDate.toISOString(),
    }));

    console.log(
      `Found ${subscriptionsDue.length} subscriptions due for billing`
    );

    return c.json({
      subscriptionsDue,
    });
  })
  // Route to upload invoice PDF and update DB
  .post(
    "/upload-invoice-pdf",
    zValidator(
      "json",
      z.object({
        invoiceId: z.string(),
        fileName: z.string(),
        pdfBase64: z.string(),
        invoiceNumber: z.string().optional(),
      })
    ),
    async (c) => {
      const { invoiceId, fileName, pdfBase64, invoiceNumber } =
        c.req.valid("json");
      try {
        // Decode base64 PDF
        const pdfBuffer = Buffer.from(pdfBase64, "base64");
        // Upload to S3/MinIO
        await uploadFile(fileName, pdfBuffer, "application/pdf");
        const pdfUrl = getObjectStorageUrl(fileName);
        // Update invoice record in DB
        await db
          .update(invoices)
          .set({
            pdfUrl,
          })
          .where(eq(invoices.id, invoiceId));
        return c.json({ success: true, pdfUrl });
      } catch (error) {
        console.error("Failed to upload invoice PDF or update DB:", error);
        return c.json(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    }
  )
  // Route to reconcile metrics cache - only accessible with Trigger.dev API key
  .post("/reconcile-metrics-cache", async (c) => {
    try {
      console.info(
        "[Trigger.dev] Cache reconciliation requested via billing API"
      );
      await forceReconciliation();
      return c.json({
        message: "Metrics cache reconciliation completed successfully",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        `[Trigger.dev] Error during forced cache reconciliation: ${error}`
      );
      return c.json(
        {
          error: "Failed to reconcile cache",
          timestamp: new Date().toISOString(),
        },
        500
      );
    }
  })

  // New route to collect payment for scheduled billing
  .post(
    "/collect-payment",
    zValidator("json", collectPaymentSchema),
    async (c) => {
      try {
        const { customerId, subDetails } = c.req.valid("json");

        console.info(
          `Attempting payment collection for customer ${customerId} with ${subDetails.length} subscription components`
        );

        // ------------ subscription-based billing ---------------
        // Step 1: Validate subscription consistency
        const subscriptionValidation =
          validateSubscriptionConsistency(subDetails);
        if ("error" in subscriptionValidation) {
          return c.json(
            subscriptionValidation.error,
            subscriptionValidation.error.statusCode
          );
        }
        const { subscriptionId } = subscriptionValidation;

        // Step 2: Fetch customer
        const customer = await fetchCustomer(customerId);
        if (!customer) {
          return c.json(
            {
              success: false,
              status: "failed",
              message: `Customer not found: ${customerId}`,
            },
            404
          );
        }

        // Step 3: Process subscription details
        const processedDetailsResult =
          await processSubscriptionDetails(subDetails);
        if ("error" in processedDetailsResult) {
          return c.json(
            processedDetailsResult.error,
            processedDetailsResult.error.statusCode
          );
        }
        const processedDetails = processedDetailsResult;

        // Step 4: Extract merchant and currency info
        const merchantId =
          processedDetails[0].subDetail.subscription.merchantId;
        const currency =
          processedDetails[0].subDetail.subscription.price.currency;

        // Step 5: Fetch payment dependencies
        // Prefer payment method set on subscription details, if any
        const preferredPaymentMethodId = processedDetails
          .map((d) => d.subDetail.paymentMethodId)
          .find((id) => !!id) as string | undefined;
        const { paymentMethod } = await fetchPaymentDependencies(
          customerId,
          customer.merchantId,
          preferredPaymentMethodId
        );

        // Step 6: Build payment context
        // Check if this is a seat-based plan
        let isSeatBasedPlan = false;
        if (processedDetails.length > 0) {
          const price = processedDetails[0].subDetail.subscription.price;
          isSeatBasedPlan = Array.isArray(price.pricingData?.components)
            ? price.pricingData.components.some(
                (c: any) => c.type === "per_unit"
              )
            : false;
        }

        const paymentContext: PaymentContext = {
          customer,
          paymentMethod: paymentMethod, // May be null for free plans
          processedDetails,
          merchantId,
          currency,
          seatAwareUsage: isSeatBasedPlan,
        };

        // Draft invoices are now handled separately and not merged into regular billing

        // Step 7: Validate payment context - allow missing payment setup for potential free plans
        const contextValidation = await validatePaymentContext(
          customer,
          paymentMethod,
          false // Don't require payment setup initially - let the transaction logic handle it
        );
        if ("error" in contextValidation) {
          return c.json(contextValidation.error, 400);
        }

        // Step 8: Process payment transaction using the **current** subscription
        // We intentionally postpone any plan migrations until *after* billing so that
        // existing credits tied to the current plan can be applied correctly.
        const paymentResult = await processPaymentTransaction(
          paymentContext,
          subDetails,
          subscriptionId
        );

        // Step 9: After the invoice has been created and post-invoice operations have
        // completed, apply any pending scheduled migration to move the customer to
        // the new plan version. This may expire old grants and create new ones, but
        // it happens *after* billing, so credit application for the just-completed
        // cycle is unaffected.
        await checkAndApplyScheduledChanges(subscriptionId, merchantId);

        return c.json(paymentResult?.response);
      } catch (error: unknown) {
        // Handle any unexpected errors
        if (error instanceof Stripe.errors.StripeError) {
          // TODO: this should go in a webhook handler instead
          const paymentMethod = await db.query.paymentMethods.findFirst({
            where: and(
              eq(paymentMethods.customerId, c.req.valid("json").customerId),
              isNull(paymentMethods.deletedAt)
            ),
            orderBy: (paymentMethods, { desc }) => [
              desc(paymentMethods.lastUsedAt),
            ],
          });

          if (paymentMethod) {
            const errorResponse = await handlePaymentFailure(
              error,
              c.req.valid("json").customerId,
              paymentMethod
            );
            return c.json(
              errorResponse,
              error instanceof Stripe.errors.StripeCardError ? 400 : 500
            );
          }
        }

        console.error("Error in collect-payment endpoint:", error);
        return c.json(
          {
            success: false,
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to process payment",
          },
          500
        );
      }
    }
  )
  .post(
    "/migrations/migrate-subscription",
    zValidator(
      "json",
      z.object({
        subscriptionId: z.string(),
        targetPlanId: z.string(),
        targetPriceId: z.string(), // Resolved price ID (no mapping needed)
        strategy: z.enum(["immediate", "next_billing_cycle"]),
        merchantId: z.string(),
      })
    ),
    async (c) => {
      const {
        subscriptionId,
        targetPlanId,
        targetPriceId,
        strategy,
        merchantId,
      } = c.req.valid("json");

      try {
        // Get the subscription to migrate
        const subscription = await db.query.subscriptions.findFirst({
          where: and(
            eq(subscriptions.id, subscriptionId),
            eq(subscriptions.merchantId, merchantId),
            isNull(subscriptions.deletedAt),
            isNull(subscriptions.endTimestamp)
          ),
        });

        if (!subscription) {
          return c.json({ error: "Subscription not found" }, 404);
        }

        // Get the target plan
        const targetPlan = await db.query.plans.findFirst({
          where: and(
            eq(plans.id, targetPlanId),
            eq(plans.merchantId, merchantId),
            isNull(plans.deletedAt)
          ),
        });

        if (!targetPlan) {
          return c.json({ error: "Target plan not found" }, 404);
        }

        // Get the target price (pre-resolved)
        const targetPrice = await db.query.prices.findFirst({
          where: and(
            eq(prices.id, targetPriceId),
            eq(prices.planId, targetPlanId),
            eq(prices.merchantId, merchantId),
            isNull(prices.deletedAt)
          ),
        });

        if (!targetPrice) {
          return c.json(
            {
              error: "Target price not found or does not belong to target plan",
            },
            400
          );
        }

        // Perform the migration
        const newSubscription = await migrateSubscription({
          oldSubscription: subscription,
          targetPlan,
          targetPrice,
          merchantId,
        });

        return c.json({
          success: true,
          oldSubscriptionId: subscription.id,
          newSubscriptionId: newSubscription.id,
          stableSubscriptionId: subscription.stableSubscriptionId,
        });
      } catch (error) {
        console.error("Error migrating subscription:", error);
        return c.json({ error: "Failed to migrate subscription" }, 500);
      }
    }
  )
  // Added route to process due trial migrations (immediate, not next billing)
  .post("/migrations/upgrade-trial-subscriptions", async (c) => {
    const now = new Date();
    const changes = await db.query.subscriptionsScheduledChanges.findMany({
      where: and(
        eq(subscriptionsScheduledChanges.effectiveOnNextBilling, false),
        lte(subscriptionsScheduledChanges.effectiveDate, now),
        isNull(subscriptionsScheduledChanges.processedAt)
      ),
    });

    let processedCount = 0;
    const results = [];

    for (const change of changes) {
      try {
        const result = await db.transaction(async (tx) => {
          const subscription = await tx.query.subscriptions.findFirst({
            where: and(
              eq(subscriptions.id, change.subscriptionId),
              isNull(subscriptions.deletedAt),
              isNull(subscriptions.endTimestamp)
            ),
          });
          if (!subscription) {
            await tx
              .update(subscriptionsScheduledChanges)
              .set({ processedAt: now })
              .where(eq(subscriptionsScheduledChanges.id, change.id));
            return null;
          }

          const targetPlan = await tx.query.plans.findFirst({
            where: eq(plans.id, change.newPlanId!),
          });
          const targetPrice = await tx.query.prices.findFirst({
            where: eq(prices.id, change.newPriceId!),
          });

          if (!targetPlan || !targetPrice) {
            await tx
              .update(subscriptionsScheduledChanges)
              .set({ processedAt: now })
              .where(eq(subscriptionsScheduledChanges.id, change.id));
            return null;
          }

          // Mark scheduled change as processed
          await tx
            .update(subscriptionsScheduledChanges)
            .set({ processedAt: now })
            .where(eq(subscriptionsScheduledChanges.id, change.id));

          return { subscription, targetPlan, targetPrice };
        });

        if (result) {
          // Use the new PaymentIntent approach - webhook will handle the upgrade
          const upgradeResult = await initiateTrialToPaymentUpgrade({
            oldSubscription: result.subscription,
            targetPlan: result.targetPlan,
            targetPrice: result.targetPrice,
            merchantId: result.subscription.merchantId,
          });

          processedCount++;
          results.push({
            subscriptionId: result.subscription.id,
            paymentIntentId: upgradeResult.paymentIntentId,
            success: upgradeResult.success,
            message: upgradeResult.message,
            error: upgradeResult.error,
          });

          if (upgradeResult.success) {
            console.info(
              `Successfully initiated trial-to-paid upgrade for subscription ${result.subscription.id}`,
              {
                paymentIntentId: upgradeResult.paymentIntentId,
              }
            );
          } else {
            console.error(
              `Failed to initiate trial-to-paid upgrade for subscription ${result.subscription.id}: ${upgradeResult.message}`,
              { error: upgradeResult.error }
            );
          }
        }
      } catch (error) {
        console.error(
          `Failed to process trial migration for change ${change.id}`,
          error
        );
        results.push({
          changeId: change.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.info(
      `Processed ${processedCount} trial upgrade attempts using PaymentIntent approach`
    );

    return c.json({
      success: true,
      processed: processedCount,
      results,
    });
  })
  // Route to fetch invoice data for PDF regeneration
  .post(
    "/get-invoice-for-pdf",
    zValidator(
      "json",
      z.object({
        invoiceId: z.string(),
      })
    ),
    async (c) => {
      const { invoiceId } = c.req.valid("json");

      try {
        const invoiceWithDetails = await db.query.invoices.findFirst({
          where: eq(invoices.id, invoiceId),
          with: {
            merchant: true,
            customer: true,
            lineItems: true,
          },
        });

        if (!invoiceWithDetails) {
          return c.json({ error: "Invoice not found" }, 404);
        }

        return c.json({
          success: true,
          invoice: invoiceWithDetails,
        });
      } catch (error) {
        console.error("Failed to fetch invoice for PDF generation:", error);
        return c.json(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    }
  )

  // Dunning Management Endpoints
  .post("/dunning/enforce-grace-periods", async (c) => {
    const requestBody = await c.req.json();
    const currentTimestamp = new Date(requestBody.timestamp || new Date());

    console.log("Starting dunning grace period enforcement", {
      timestamp: currentTimestamp,
    });

    try {
      // Find subscriptions with expired grace periods
      const expiredSubscriptions = await db.query.subscriptions.findMany({
        where: and(
          eq(subscriptions.status, "past_due"),
          lte(subscriptions.gracePeriodEndsAt, currentTimestamp),
          isNull(subscriptions.deletedAt)
        ),
      });

      let processed = 0;

      for (const subscription of expiredSubscriptions) {
        // Get dunning config using hierarchical lookup
        const dunningConfig = await getOrCreateDunningConfig(
          subscription.merchantId,
          subscription.planId
        );

        console.log(
          `Enforcing dunning action for subscription ${subscription.id}`,
          {
            action: dunningConfig.endOfDunningAction,
            gracePeriodEnded: subscription.gracePeriodEndsAt,
          }
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
            currentTimestamp,
          });
        });
        processed++;
      }

      console.log(
        `Dunning grace period enforcement completed: ${processed} subscriptions processed`
      );

      return c.json({
        success: true,
        processed,
        timestamp: currentTimestamp.toISOString(),
      });
    } catch (error) {
      console.error("Error enforcing dunning grace periods:", error);
      return c.json(
        {
          error: "Failed to enforce dunning grace periods",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  })

  .post("/dunning/retry-payments", async (c) => {
    const requestBody = await c.req.json();
    const currentTimestamp = new Date(requestBody.timestamp || new Date());

    console.log("Starting dunning payment retry process", {
      timestamp: currentTimestamp,
    });

    try {
      // Find subscriptions in dunning that are still within grace period
      const pastDueSubscriptions = await db.query.subscriptions.findMany({
        where: and(
          eq(subscriptions.status, "past_due"),
          gt(subscriptions.gracePeriodEndsAt, currentTimestamp),
          isNull(subscriptions.deletedAt)
        ),
        with: {
          customer: true,
        },
      });

      let attempted = 0;
      // For reporting back to the scheduled job:
      // "succeeded" and "failed" here reflect queueing success, not payment results
      let succeeded = 0;
      let failed = 0;

      for (const subscription of pastDueSubscriptions) {
        try {
          // Find the latest unpaid invoice for this subscription
          const unpaidInvoice = await db.query.invoices.findFirst({
            where: and(
              eq(invoices.subscriptionId, subscription.id),
              eq(invoices.status, "issued")
            ),
            orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
          });

          if (!unpaidInvoice) {
            console.log(
              `No unpaid invoice found for subscription ${subscription.id}`
            );
            continue;
          }

          // Get customer's payment method
          const paymentMethod = await db.query.paymentMethods.findFirst({
            where: and(
              eq(paymentMethods.customerId, subscription.customerId),
              isNull(paymentMethods.deletedAt)
            ),
            orderBy: (paymentMethods, { desc }) => [
              desc(paymentMethods.lastUsedAt),
            ],
          });

          if (!paymentMethod) {
            console.log(
              `No payment method found for customer ${subscription.customerId}`
            );
            continue;
          }

          attempted++;

          console.log(`Retrying payment for subscription ${subscription.id}`, {
            invoiceId: unpaidInvoice.id,
            amountCents: unpaidInvoice.totalAmountCents,
          });

          let existingPayment = await db.query.payments.findFirst({
            where: eq(payments.invoiceId, unpaidInvoice.id),
            orderBy: (payments, { desc }) => [desc(payments.createdAt)],
          });

          if (!existingPayment) {
            // this should never happen - we create the payment object with the invoice
            // but just in case, we'll create it here
            console.log(
              `No payment found for invoice ${unpaidInvoice.id}, creating one`
            );
            const created = await db
              .insert(payments)
              .values({
                merchantId: subscription.merchantId,
                invoiceId: unpaidInvoice.id,
                paymentMethodId: paymentMethod.id,
                amountCents: unpaidInvoice.totalAmountCents,
                currency: unpaidInvoice.currency,
                status: "pending",
              })
              .returning();
            existingPayment = created[0];
          }

          const attemptNumber = await getNextAttemptNumber(unpaidInvoice.id);

          const [retryRecord] = await db
            .insert(paymentRetries)
            .values({
              paymentId: existingPayment.id,
              invoiceId: unpaidInvoice.id,
              attemptNumber,
              status: "pending",
            })
            .returning();

          const queueResult = await retryInvoicePayment({
            invoiceId: unpaidInvoice.id,
            paymentRetryId: retryRecord.id,
            attemptNumber,
          });

          if (queueResult.queued) {
            succeeded++;
          } else {
            failed++;
          }

          console.log(
            `Queued payment retry for subscription ${subscription.id}, invoice ${unpaidInvoice.id}, attempt #${attemptNumber}`
          );
        } catch (retryError) {
          console.error(
            `Error retrying payment for subscription ${subscription.id}:`,
            retryError
          );
        }
      }

      console.log(
        `Dunning payment retry queued: ${attempted} attempts scheduled`
      );

      return c.json({
        success: true,
        attempted,
        succeeded,
        failed,
        timestamp: currentTimestamp.toISOString(),
      });
    } catch (error) {
      console.error("Error during dunning payment retry:", error);
      return c.json(
        {
          error: "Failed to retry dunning payments",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  })
  .post("/dunning/notify-grace-ending-soon", async (c) => {
    try {
      const requestBody = await c.req.json().catch(() => ({}));
      const currentTimestamp = new Date(requestBody.timestamp || new Date());

      const windowStart = new Date(
        currentTimestamp.getTime() + 23 * 60 * 60 * 1000
      );
      const windowEnd = new Date(
        currentTimestamp.getTime() + 24 * 60 * 60 * 1000
      );

      console.log("Starting grace-ending-soon notifications", {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });

      const candidates = await db.query.subscriptions.findMany({
        where: and(
          eq(subscriptions.status, "past_due"),
          gte(subscriptions.gracePeriodEndsAt, windowStart),
          lt(subscriptions.gracePeriodEndsAt, windowEnd),
          isNull(subscriptions.deletedAt)
        ),
        with: {
          customer: true,
        },
      });

      const notify = createNotificationProvider();
      let notified = 0;

      for (const sub of candidates) {
        try {
          const merchantRecord = await db.query.merchants.findFirst({
            where: eq(merchants.id, sub.merchantId),
          });

          const merchantName =
            merchantRecord?.displayName ||
            merchantRecord?.legalName ||
            "Your Service Provider";
          const customerEmail = sub.customer?.email || null;
          const merchantNotifyEmail =
            merchantRecord?.billingEmail ||
            merchantRecord?.supportEmail ||
            null;

          if (customerEmail) {
            await notify.sendEmail({
              to: customerEmail,
              subject: `Action needed: Grace period ending soon`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Update your payment method to avoid interruption</h2>
                  <p>We couldn't collect your last payment. Your grace period ends on <strong>${sub.gracePeriodEndsAt?.toISOString()}</strong>.</p>
                  <p>Please update your payment method to keep your subscription active.</p>
                  <p>Best regards,<br>${merchantName}</p>
                </div>
              `,
              from: "noreply@getlumen.dev",
            });
          }

          if (merchantNotifyEmail) {
            await notify.sendEmail({
              to: merchantNotifyEmail,
              subject: `Grace ending soon for subscription ${sub.id}`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Grace period ends soon</h2>
                  <p>Subscription ${sub.id} (customer: ${sub.customer?.email || "unknown"}) is approaching grace period end.</p>
                  <p>Grace period end: <strong>${sub.gracePeriodEndsAt?.toISOString()}</strong></p>
                </div>
              `,
              from: "noreply@getlumen.dev",
            });
          }

          notified++;
        } catch (e) {
          console.error(
            `Failed to send grace-ending-soon notifications for subscription ${sub.id}`,
            e
          );
        }
      }

      console.log(
        `Grace-ending-soon notifications completed for ${notified} subscriptions`
      );

      return c.json({
        success: true,
        notified,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });
    } catch (error) {
      console.error("Error during grace-ending-soon notifications:", error);
      return c.json(
        {
          error: "Failed to send grace-ending-soon notifications",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  });
