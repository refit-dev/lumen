import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import {
  subscriptions,
  invitation,
  organization,
  user,
  member,
} from "@lumen/common/schema";
import { apiKeys } from "@lumen/common/schema";
import { eq, and, isNull, ne, inArray } from "drizzle-orm";
import { z } from "zod";
import Stripe from "stripe";
import DodoPayments from "dodopayments";
import {
  prices,
  customers,
  payments,
  paymentMethods,
  subscriptionDetails,
  invoices,
  plans,
  subscriptionsScheduledChanges,
  paymentRetries,
  customerOrganizations,
  subscriptionFeatures,
} from "@lumen/common/schema";
import { enforceDunningEndAction } from "../helpers/dunning";
import { dunningConfigs } from "@lumen/common/schema";
import {
  createSubscriptionCore,
  generateImmediateInvoice,
  getActiveSubscriptionForCustomer,
  getOrCreateDunningConfig,
  upgradeSubscriptionAndInvoice,
  resumeSubscriptionAndResetCycle,
} from "../helpers/billing";

import {
  createPrefixValidator,
  PerUnitPriceComponentSchemaType,
} from "@lumen/common";
import { ID_PREFIXES } from "@lumen/common";
import { upsertCustomer } from "../helpers/customers";
import { streamSSE, SSEStreamingApi } from "hono/streaming";
import { env } from "../env";

import { TransactionType } from "../helpers";
import { createNotificationProvider } from "../helpers/notificationProvider";
import { merchants } from "@lumen/common/schema";
import { calculateTaxesForPaymentFlow } from "../helpers/tax-engine";
import {
  getPaymentProvider,
  verifyPaymentProviderWebhook,
  createStripeClient,
  getPspPaymentMethodDetailsFromPayment,
  createPspCustomer,
  createPspPaymentAuthorization,
  generateReturnObject,
  postProcessDodoPayment,
  createCheckoutSessionForPayment,
} from "../helpers/paymentprovider";
import { retryInvoicePayment } from "../helpers/paymentprovider";
import { processPayment } from "../helpers/paymentprovider";
import { ContentfulStatusCode } from "hono/utils/http-status";
import {
  registerSSEClient,
  unregisterSSEClient,
  publishSSEEvent,
  getPaymentStatus,
  sseClients as redisBackedSseClients,
  clearSseClientsForTesting,
} from "../lib/sse-manager";

import { attemptAutoRecreateStripeWebhook } from "../helpers/paymentprovider";
import { processTopupPayment } from "../helpers/topups";
const taxCalculationSchema = z.object({
  lumenPublishableKey: z
    .string()
    .startsWith("pk_", { message: "Invalid public key format" }),
  planId: createPrefixValidator(
    ID_PREFIXES.plan,
    "Invalid plan ID"
  )(z.string()),
  priceId: createPrefixValidator(
    ID_PREFIXES.price,
    "Invalid price ID"
  )(z.string()),
  subtotalCents: z.number().int().min(0),
  currency: z.string().length(3),
  customerCountry: z.string().optional(),
  customerStateProvince: z.string().optional(),
  taxId: z.string().optional(),
  businessName: z.string().optional(),
});

const paymentIntentUpdateSchema = z.object({
  lumenPublishableKey: z
    .string()
    .startsWith("pk_", { message: "Invalid public key format" }),
  intentId: z.string(),
  newAmountCents: z.number().int().min(0),
  taxAmountCents: z.number().int().min(0),
  taxData: z.object({
    taxableAmount: z.number(),
    totalTaxCents: z.number(),
    effectiveTaxRate: z.number(),
    jurisdiction: z.string(),
    calculationMethod: z.enum(["auto", "manual", "exempt"]),
    taxLineItems: z.array(
      z.object({
        type: z.literal("tax"),
        description: z.string(),
        subtotalCents: z.number(),
        taxMetadata: z
          .object({
            taxAuthority: z.string().optional(),
            taxType: z.string().optional(),
            jurisdiction: z.string().optional(),
            taxRate: z.number().optional(),
            rateSource: z.string().optional(),
            exemptionReason: z.string().optional(),
            reasonCode: z.number().optional(),
            fullDescription: z.string().optional(),
          })
          .optional(),
      })
    ),
  }),
});

const paymentInitSchema = z.object({
  lumenPublishableKey: z
    .string()
    .startsWith("pk_", { message: "Invalid public key format" }),
  userId: z.string(),
  organizationId: z.string().optional(), // External organization identifier
  planId: createPrefixValidator(
    ID_PREFIXES.plan,
    "Invalid plan ID"
  )(z.string()),
  priceId: createPrefixValidator(
    ID_PREFIXES.price,
    "Invalid price ID"
  )(z.string()),
  priceIdMonthly: z.string().optional(),
  priceIdYearly: z.string().optional(),
  customerEmail: z.string().email(),
  customerName: z.string(),
  businessName: z.string().optional(),
  taxId: z.string().optional(),
  customerAddress: z.string().optional(),
  customerAddressLine2: z.string().optional(),
  customerZip: z.string().optional(),
  customerCity: z.string().optional(),
  customerCountry: z.string().optional(),
  customerStateProvince: z.string().optional(),
  taxData: z
    .object({
      taxableAmount: z.number(),
      totalTaxCents: z.number(),
      effectiveTaxRate: z.number(),
      jurisdiction: z.string(),
      calculationMethod: z.enum(["auto", "manual", "exempt"]),
      taxLineItems: z.array(
        z.object({
          type: z.literal("tax"),
          description: z.string(),
          subtotalCents: z.number(),
          taxMetadata: z
            .object({
              taxAuthority: z.string().optional(),
              taxType: z.string().optional(),
              jurisdiction: z.string().optional(),
              taxRate: z.number().optional(),
              rateSource: z.string().optional(),
              exemptionReason: z.string().optional(),
              reasonCode: z.number().optional(),
              fullDescription: z.string().optional(),
            })
            .optional(),
        })
      ),
    })
    .optional(),
  startTrial: z.boolean().optional(),
  primarySeatEventTimestamp: z.string().optional(),
});

const createPaymentSchema = z.object({
  lumenPublishableKey: z
    .string()
    .startsWith("pk_", { message: "Invalid public key format" }),
  customerEmail: z.string().email(),
  customerName: z.string(),
  planId: z.string().optional(),
  pspPlanId: z.string(),
  priceId: z.string().optional(),
  price: z.number(),
  currency: z.string().default("USD"),
  productName: z.string(),
  businessName: z.string().optional(),
  taxId: z.string().optional(),
  customerAddress: z.string(),
  customerAddressLine2: z.string().optional(),
  customerZip: z.string(),
  customerCity: z.string(),
  customerCountry: z.string(),
  customerStateProvince: z.string(),
  startTrial: z.boolean().optional(),
  trialDays: z.number().optional(),
});

// Expose SSE client registry for tests (actual implementation in sse-manager)
export const sseClients = redisBackedSseClients;
let id = 0;

// Export for testing purposes
export const exposeForTesting = {
  clearSseClients: () => clearSseClientsForTesting(),
};

async function getOrCreateLumenPaymentMethodFromPspPayment({
  tx,
  merchantId,
  customerId,
  pspPaymentId,
  datetimeAtTransactionStart,
}: {
  tx: TransactionType;
  merchantId: string;
  customerId: string;
  pspPaymentId: string;
  datetimeAtTransactionStart: Date;
}) {
  const paymentProvider = await getPaymentProvider(merchantId);

  const pspPaymentMethodDetails = await getPspPaymentMethodDetailsFromPayment({
    paymentProvider,
    pspPaymentId,
  });
  if (!pspPaymentMethodDetails) {
    throw new Error(
      "Failed to process payment method. No PSP payment method details found."
    );
  }
  if (
    pspPaymentMethodDetails.type === "card" &&
    pspPaymentMethodDetails.customerId &&
    pspPaymentMethodDetails.cardLastFour
  ) {
    // Check if this payment method already exists in our DB
    const existingPaymentMethod = await tx.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.merchantId, merchantId),
        eq(paymentMethods.customerId, customerId),
        eq(
          paymentMethods.externalPspPaymentMethodId,
          pspPaymentMethodDetails.id
        ),
        isNull(paymentMethods.deletedAt)
      ),
    });

    if (!existingPaymentMethod) {
      // Create new payment method record
      const [paymentMethodInserted] = await tx
        .insert(paymentMethods)
        .values({
          merchantId: merchantId,
          customerId: customerId,
          provider: paymentProvider.name!,
          paymentType: "card",
          status: "active", // Active as it was just used successfully
          lastUsedAt: datetimeAtTransactionStart,
          cardLastFour: pspPaymentMethodDetails.cardLastFour,
          cardBrand: pspPaymentMethodDetails.cardBrand,
          cardExpiryMonth: pspPaymentMethodDetails.cardExpiryMonth,
          cardExpiryYear: pspPaymentMethodDetails.cardExpiryYear,
          cardIssuerCountry: pspPaymentMethodDetails.cardIssuerCountry,
          cardNetwork: pspPaymentMethodDetails.cardNetwork,
          externalPspPaymentMethodId: pspPaymentMethodDetails.id,
          externalPspCustomerId: pspPaymentMethodDetails.customerId,
          externalPspMetadata: pspPaymentMethodDetails.metadata,
        })
        .returning();

      console.log(
        `New payment_method for ${paymentProvider.name}: PSP payment method ${pspPaymentMethodDetails.id} (card) created for internal customer ${customerId}`
      );
      return paymentMethodInserted.id;
    } else {
      console.log(
        `Payment method ${pspPaymentMethodDetails.id} (card) already exists for internal customer ${customerId}`
      );
      return existingPaymentMethod.id;
    }
  } else if (
    pspPaymentMethodDetails &&
    pspPaymentMethodDetails.type !== "card"
  ) {
    const message = `[Admin Action Required] Customer: ${customerId}. Merchant: ${merchantId}. ${paymentProvider.name} payment method ${pspPaymentMethodDetails.id} is of type ${pspPaymentMethodDetails.type}, not 'card'. Skipping save.`;
    const notify = createNotificationProvider();
    await notify.sendSlack({
      text: message,
    });
    console.log(message);
    return null;
  } else {
    throw new Error(
      "Cannot get PSP payment method details for payment method type: " +
        pspPaymentMethodDetails.type
    );
  }
}

// Helper function to validate intent metadata
// TODO: Validate metadata for failure cases
function validateIntentMetadata(
  intentType: "payment" | "setup",
  metadata: Record<string, any> | null,
  status: string
): { isValid: boolean; error?: string } {
  if (!metadata) {
    return { isValid: false, error: "Metadata is null" };
  }

  const isSucceeded = status === "succeeded";
  const isFailed = status === "failed" || status === "requires_payment_method";

  const customerId = metadata.customer_id as string | undefined;
  const planId = metadata.plan_id as string | undefined;
  const priceId = metadata.price_id as string | undefined;
  const isFirstPayment = metadata.is_first_payment as string | undefined;
  const subscriptionId = metadata.subscription_id as string | undefined;
  const paymentMethodId = metadata.payment_method_id as string | undefined;
  const subscriptionDetailsIds = metadata.subscription_details_ids_string as
    | string
    | undefined;
  const invoiceId = metadata.invoice_id as string | undefined;

  if (intentType === "payment") {
    if (isSucceeded) {
      // Credit topup payments
      if (metadata.is_topup === "true") {
        const topupCustomerId = metadata.topup_customer_id as
          | string
          | undefined;
        const topupCreditDefinitionId = metadata.topup_credit_definition_id as
          | string
          | undefined;
        const topupQuantity = metadata.topup_quantity as string | undefined;
        const topupUnitPriceCents = metadata.topup_unit_price_cents as
          | string
          | undefined;
        if (
          !topupCustomerId ||
          !topupCreditDefinitionId ||
          !topupQuantity ||
          !topupUnitPriceCents
        ) {
          return {
            isValid: false,
            error:
              "Missing required metadata for topup payment: topup_customer_id, topup_credit_definition_id, topup_quantity, topup_unit_price_cents",
          };
        }
        return { isValid: true };
      }

      // Trial upgrade path uses trial_subscription_id
      if (metadata.is_trial_upgrade === "true") {
        const trialSubId = metadata.trial_subscription_id as string | undefined;
        if (!trialSubId || !planId || !priceId) {
          return {
            isValid: false,
            error:
              "Missing required metadata for trial upgrade payment: trial_subscription_id, plan_id, price_id",
          };
        }
        return { isValid: true };
      }

      // Recurring cycle (explicitly marked)
      if (isFirstPayment === "false") {
        if (
          !customerId ||
          !subscriptionId ||
          !paymentMethodId ||
          !subscriptionDetailsIds ||
          !invoiceId
        ) {
          return {
            isValid: false,
            error:
              "Missing some required metadata for recurring payment: customer_id, subscription_id, payment_method_id, subscription_details_ids_string, invoice_id",
          };
        }
        return { isValid: true };
      }

      // First-time payment (default if not explicitly false)
      if (!customerId || !planId || !priceId) {
        return {
          isValid: false,
          error:
            "Missing required metadata for first-time payment: customer_id, plan_id, price_id",
        };
      }
      return { isValid: true };
    }

    if (isFailed) {
      // For failed recurring payments, we expect invoice_id and payment_method_id to update failure info
      if (isFirstPayment === "false") {
        if (!invoiceId || !paymentMethodId) {
          return {
            isValid: false,
            error:
              "Missing required metadata for failed recurring payment: invoice_id, payment_method_id",
          };
        }
      }
      return { isValid: true };
    }
  } else if (intentType === "setup") {
    if (isSucceeded) {
      // Portal add-payment-method flow: allow minimal metadata
      if (metadata.portal_pm_add === "true") {
        if (!customerId) {
          return {
            isValid: false,
            error:
              "Missing required metadata for portal payment method add: customer_id",
          };
        }
        return { isValid: true };
      }

      if (metadata.is_trial === "true") {
        const trialParentPlanId = metadata.trial_parent_plan_id as
          | string
          | undefined;
        const trialParentPriceId = metadata.trial_parent_price_id as
          | string
          | undefined;
        if (!customerId || !trialParentPlanId || !trialParentPriceId) {
          return {
            isValid: false,
            error:
              "Missing required metadata for trial setup: customer_id, trial_parent_plan_id, trial_parent_price_id",
          };
        }
        return { isValid: true };
      }

      if (isFirstPayment === "false" && subscriptionId) {
        if (!customerId || !paymentMethodId) {
          return {
            isValid: false,
            error:
              "Missing required metadata for setup on existing subscription: customer_id, payment_method_id",
          };
        }
        return { isValid: true };
      }

      // First-time setup
      if (!customerId || !planId || !priceId) {
        return {
          isValid: false,
          error:
            "Missing required metadata for first-time setup: customer_id, plan_id, price_id",
        };
      }
      return { isValid: true };
    }

    if (isFailed) {
      // No strict requirements for setup failures beyond having some metadata
      return { isValid: true };
    }
  }

  return { isValid: true };
}

// Prepare event broadcast data for SSE clients
function prepareEventBroadcastData(event: Stripe.Event, merchantId: string) {
  return {
    type: event.type,
    merchantId,
    timestamp: new Date().toISOString(),
    data: event.data,
  };
}

// Get the ID to use for SSE client lookup
function getSSELookupIdFromEvent(event: Stripe.Event): string | undefined {
  if (event.type.startsWith("payment_intent.")) {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    return paymentIntent.id;
  } else if (event.type.startsWith("setup_intent.")) {
    const setupIntent = event.data.object as Stripe.SetupIntent;
    return setupIntent.id;
  }
  return undefined;
}

/**
 * Check if a webhook has already been processed using Redis for idempotency
 * Returns true if webhook should be processed, false if it's a duplicate
 */
async function checkWebhookIdempotency(
  provider: "stripe" | "dodo",
  merchantId: string,
  eventId: string
): Promise<boolean> {
  const idempotencyKey = `webhook:${provider}:${merchantId}:${eventId}`;

  try {
    const { getRedisClient } = await import("../lib/redis");
    const redis = await getRedisClient();

    // Try to set the key only if it doesn't exist (NX = not exists)
    // If it already exists, this webhook was already processed
    const wasSet = await redis.set(idempotencyKey, "1", {
      NX: true,
      EX: 86400, // Expire after 24 hours
    });

    if (!wasSet) {
      console.log(
        `${provider.toUpperCase()} webhook ${eventId} already processed for merchant ${merchantId}, ignoring duplicate`
      );
      return false; // Skip processing
    }

    console.log(
      `Processing ${provider.toUpperCase()} webhook ${eventId} for merchant ${merchantId}`
    );
    return true; // Process webhook
  } catch (redisError) {
    // Redis failure should not block webhook processing
    // Log and continue (risk: duplicate processing if Redis is down)
    console.error(
      `Redis idempotency check failed for ${provider} webhook ${eventId}:`,
      redisError
    );
    console.warn("Continuing without idempotency protection");
    return true; // Process anyway when Redis is unavailable
  }
}

// Process recurring payment from webhook
async function processRecurringPayment(
  payment: typeof payments.$inferSelect & {
    metadata: Record<string, string>;
  }
): Promise<void> {
  const {
    customer_id,
    subscription_id,
    payment_method_id,
    subscription_details_ids_string,
    invoice_id,
  } = payment.metadata;

  console.log(
    "Processing recurring payment with paymentIntent",
    payment.externalPaymentId
  );
  const subscriptionDetailsIds = subscription_details_ids_string
    ? subscription_details_ids_string.split(",")
    : [];

  await db.transaction(async (tx) => {
    // 1. Get stored payment method from DB
    const paymentMethod = await tx.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.id, payment_method_id),
        isNull(paymentMethods.deletedAt)
      ),
    });

    if (!paymentMethod) {
      throw new Error(
        `Payment method not found for payment_method_id ${payment_method_id}`
      );
    }

    // 2. Find the existing invoice that was created during payment intent creation
    if (!invoice_id) {
      throw new Error("No invoice_id found in payment intent metadata");
    }

    const invoice = await tx.query.invoices.findFirst({
      where: and(
        eq(invoices.id, invoice_id),
        eq(invoices.merchantId, payment.merchantId),
        eq(invoices.customerId, customer_id),
        ne(invoices.status, "deleted")
      ),
      with: {
        subscription: {
          with: {
            price: true,
          },
        },
      },
    });

    if (!invoice) {
      throw new Error(`Invoice not found with ID: ${invoice_id}`);
    }

    // Update invoice status to "paid"
    await tx
      .update(invoices)
      .set({
        status: "paid",
        paidDate: new Date(),
      })
      .where(eq(invoices.id, invoice_id));

    // Update the payment record status to "succeeded"
    await tx
      .update(payments)
      .set({
        status: "succeeded",
        externalPaymentId: payment.externalPaymentId, // In case it wasn't set before
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    // Update payment method on all subscription details
    // We're not using this at the moment, but it will be needed when we support multiple payment methods
    // We'll initally set the payment method on the subscription details when we create the subscription
    // and then update it here if the customer has changed their payment method\
    // We'll also have to be careful when migrating - these are the OLD subscription details
    // Do we need to set this on the NEW subscription details?
    await tx
      .update(subscriptionDetails)
      .set({
        paymentMethodId: payment_method_id,
      })
      .where(
        and(
          inArray(subscriptionDetails.id, subscriptionDetailsIds)
          // Not checking NULL because at migration time, the old sub details are soft deleted
          // isNull(subscriptionDetails.deletedAt)
        )
      );

    console.info(
      `Successfully processed recurring payment for subscription ${subscription_id}, invoice ${invoice_id}, payment ${payment.id}`
    );
  });
}

// Process trial-to-paid upgrade from webhook
async function processTrialUpgrade(
  payment: typeof payments.$inferSelect
): Promise<void> {
  if (!payment.metadata) {
    // should have been validated already by the validateIntentMetadata function
    // but just for making TS happy
    throw new Error("Missing metadata for trial upgrade");
  }

  const { customer_id, plan_id, price_id, trial_subscription_id } =
    payment.metadata;

  if (!trial_subscription_id) {
    const errorMessage = "Missing trial_subscription_id for trial upgrade";
    console.error(errorMessage, payment.metadata);
    throw new Error(errorMessage);
  }

  // Extract tax information from Payment Intent metadata
  let taxLineItems: Array<{
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
  }> = [];

  // Deserialize tax line items if present
  if (payment.metadata.tax_line_items) {
    try {
      taxLineItems = JSON.parse(payment.metadata.tax_line_items);
    } catch (error) {
      console.error("Failed to parse tax line items from metadata:", error);
    }
  }

  const taxInfo = {
    taxAmountCents: payment.metadata.tax_amount_cents
      ? parseInt(payment.metadata.tax_amount_cents, 10)
      : 0,
    taxJurisdiction: payment.metadata.tax_jurisdiction || null,
    taxCalculationMethod: payment.metadata.tax_calculation_method || null,
    effectiveTaxRate: payment.metadata.effective_tax_rate || "0",
    taxLineItems,
  };

  console.log("Processing trial-to-paid upgrade", {
    customerId: customer_id,
    trialSubscriptionId: trial_subscription_id,
    targetPlanId: plan_id,
    targetPriceId: price_id,
    taxInfo,
  });

  await db.transaction(async (tx) => {
    const datetimeAtTransactionStart = new Date();

    const internalPaymentMethodId =
      await getOrCreateLumenPaymentMethodFromPspPayment({
        tx,
        merchantId: payment.merchantId,
        customerId: customer_id as string,
        pspPaymentId: payment.externalPaymentId!,
        datetimeAtTransactionStart,
      });

    // Get the trial subscription
    const trialSubscription = await tx.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.id, trial_subscription_id as string),
        eq(subscriptions.merchantId, payment.merchantId),
        isNull(subscriptions.deletedAt),
        isNull(subscriptions.endTimestamp)
      ),
    });

    if (!trialSubscription) {
      throw new Error(`Trial subscription ${trial_subscription_id} not found`);
    }

    // Get target plan and price
    const targetPlan = await tx.query.plans.findFirst({
      where: and(
        eq(plans.id, plan_id),
        eq(plans.merchantId, payment.merchantId),
        isNull(plans.deletedAt)
      ),
    });

    const targetPrice = await tx.query.prices.findFirst({
      where: and(
        eq(prices.id, price_id),
        eq(prices.merchantId, payment.merchantId),
        isNull(prices.deletedAt)
      ),
    });

    if (!targetPlan || !targetPrice) {
      throw new Error("Target plan or price not found");
    }

    // Perform the trial-to-paid upgrade
    const upgradeResult = await upgradeSubscriptionAndInvoice({
      merchantId: payment.merchantId,
      customerId: customer_id as string,
      planId: plan_id as string,
      priceId: price_id as string,
      startTimestamp: datetimeAtTransactionStart,
      paymentMethodId: internalPaymentMethodId,
      existingSubscription: trialSubscription,
      tx,
      taxInfo,
    });

    // Mark the scheduled change as processed
    await tx
      .update(subscriptionsScheduledChanges)
      .set({ processedAt: datetimeAtTransactionStart })
      .where(
        and(
          eq(
            subscriptionsScheduledChanges.subscriptionId,
            trial_subscription_id
          ),
          isNull(subscriptionsScheduledChanges.processedAt)
        )
      );

    // Get subscription details IDs for metadata
    const subscriptionDetailsRows = await tx.query.subscriptionDetails.findMany(
      {
        where: and(
          eq(subscriptionDetails.subscriptionId, upgradeResult.subscription.id),
          isNull(subscriptionDetails.deletedAt)
        ),
      }
    );
    const subscriptionDetailsIds = subscriptionDetailsRows.map((sd) => sd.id);

    if (upgradeResult.invoice && upgradeResult.invoice.totalAmountCents > 0) {
      await tx
        .update(payments)
        .set({
          merchantId: payment.merchantId,
          invoiceId: upgradeResult.invoice.id,
          paymentMethodId: internalPaymentMethodId,
          amountCents: upgradeResult.invoice.totalAmountCents,
          currency: upgradeResult.invoice.currency,
          status: "succeeded",
          metadata: {
            ...payment.metadata,
            subscription_id: upgradeResult.subscription.id,
            invoice_id: upgradeResult.invoice.id,
            payment_method_id: internalPaymentMethodId,
            subscription_details_ids_string: subscriptionDetailsIds.join(","),
          },
        })
        .where(eq(payments.id, payment.id));
    } else {
      await tx
        .update(payments)
        .set({
          metadata: {
            ...payment.metadata,
            subscription_id: upgradeResult.subscription.id,
            invoice_id: upgradeResult.invoice?.id || "",
            payment_method_id: internalPaymentMethodId,
            subscription_details_ids_string: subscriptionDetailsIds.join(","),
          },
        })
        .where(eq(payments.id, payment.id));
    }

    // Update payment method's last used timestamp
    await tx
      .update(paymentMethods)
      .set({ lastUsedAt: datetimeAtTransactionStart })
      .where(eq(paymentMethods.id, internalPaymentMethodId!));

    console.log("Successfully processed trial-to-paid upgrade", {
      oldSubscriptionId: trial_subscription_id,
      newSubscriptionId: upgradeResult.subscription.id,
      invoiceId: upgradeResult.invoice?.id,
      paymentId: payment?.id,
    });

    return {
      subscription: upgradeResult.subscription,
      invoice: upgradeResult.invoice,
      payment,
    };
  });
}

// Core subscription and invoice creation logic (payment-agnostic)
async function createSubscriptionAndInvoice({
  merchantId,
  customerId,
  planId,
  priceId,
  startTimestamp,
  paymentMethodId,
  tx,
  isImmediatePayment = false,
  taxInfo,
  primarySeatEventTimestamp,
}: {
  merchantId: string;
  customerId: string;
  planId: string;
  priceId: string;
  startTimestamp: Date;
  paymentMethodId?: string | null;
  tx: TransactionType;
  isImmediatePayment?: boolean;
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
  primarySeatEventTimestamp?: Date;
}): Promise<{
  subscription: typeof subscriptions.$inferSelect;
  invoice: typeof invoices.$inferSelect | null;
  creditGrants: { grantCount: number; errors: string[] };
}> {
  const transaction = async (tx: TransactionType) => {
    // 1. Create subscription using core logic
    const {
      subscription,
      subscriptionDetailsRecords,
      creditGrants,
      price,
      wasExistingSubscription,
    } = await createSubscriptionCore({
      merchantId,
      customerId,
      planId,
      effectivePriceId: priceId,
      startTimestamp,
      paymentMethodId: paymentMethodId || undefined,
      isImmediatePayment, // used to set cyclesBilled to 1 for immediate payments
      dangerouslyAllowMultipleSubscriptions: false,
      tx,
      primarySeatEventTimestamp,
    });

    if (!subscription) {
      throw new Error("Failed to create subscription");
    }

    // If the subscription already existed, skip invoice generation
    if (wasExistingSubscription) {
      return {
        subscription,
        invoice: null,
        creditGrants,
      };
    }

    if (creditGrants.grantCount > 0) {
      console.info(
        `Created ${creditGrants.grantCount} initial credit grants for subscription ${subscription.id}`
      );
    }

    // 2. Generate immediate invoice if needed
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

    return {
      subscription,
      invoice,
      creditGrants,
    };
  };

  return tx ? await transaction(tx) : await db.transaction(transaction);
}

// Process first-time payment from webhook
async function processFirstTimePayment(
  payment: typeof payments.$inferSelect & {
    metadata: Record<string, string>;
  }
): Promise<void> {
  const { customer_id, plan_id, price_id } = payment.metadata;
  const primarySeatEventTimestamp = payment.metadata.primary_seat_event_ts
    ? new Date(payment.metadata.primary_seat_event_ts)
    : undefined;

  // Extract tax information from Payment Intent metadata
  let taxLineItems: Array<{
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
  }> = [];

  // Deserialize tax line items if present
  if (payment.metadata.tax_line_items) {
    try {
      taxLineItems = JSON.parse(payment.metadata.tax_line_items);
    } catch (error) {
      console.error("Failed to parse tax line items from metadata:", error);
    }
  }

  const taxInfo = {
    taxAmountCents: payment.metadata.tax_amount_cents
      ? parseInt(payment.metadata.tax_amount_cents, 10)
      : 0,
    taxJurisdiction: payment.metadata.tax_jurisdiction || null,
    taxCalculationMethod: payment.metadata.tax_calculation_method || null,
    effectiveTaxRate: payment.metadata.effective_tax_rate || "0",
    taxLineItems,
  };

  console.log("Extracted tax information from Payment Intent:", taxInfo);

  const paymentProvider = await getPaymentProvider(payment.merchantId);

  await db.transaction(async (tx) => {
    // 1. Insert Payment Method
    let paymentMethodId: string | null = null;
    let datetimeAtTransactionStart = new Date();
    try {
      // get or create internal payment method
      paymentMethodId = await getOrCreateLumenPaymentMethodFromPspPayment({
        tx,
        merchantId: payment.merchantId,
        customerId: customer_id as string,
        pspPaymentId: payment.externalPaymentId!,
        datetimeAtTransactionStart,
      });
    } catch (pmError) {
      console.error(
        `Error processing ${paymentProvider.name} payment method for Payment Intent ${payment.externalPaymentId}`,
        pmError
      );
      // TODO: How _should_ we handle this case?
    }

    // 2. Check if customer has an active subscription (free → paid upgrade)
    const activeSubscription = await getActiveSubscriptionForCustomer(
      payment.merchantId,
      customer_id,
      tx
    );

    let subscription, invoice, creditGrants;

    if (activeSubscription) {
      // Upgrade existing subscription to paid plan
      console.log(
        `Upgrading existing subscription ${activeSubscription.stableSubscriptionId} from free to paid plan`
      );
      const upgradeResult = await upgradeSubscriptionAndInvoice({
        merchantId: payment.merchantId,
        customerId: customer_id,
        planId: plan_id,
        priceId: price_id,
        startTimestamp: datetimeAtTransactionStart,
        paymentMethodId,
        existingSubscription: activeSubscription,
        tx,
        taxInfo,
      });

      subscription = upgradeResult.subscription;
      invoice = upgradeResult.invoice;
      creditGrants = upgradeResult.creditGrants;
    } else {
      // Create new subscription (first-time paid signup)
      console.log(`Creating new subscription for first-time customer`);
      const createResult = await createSubscriptionAndInvoice({
        merchantId: payment.merchantId,
        customerId: customer_id,
        planId: plan_id,
        priceId: price_id,
        startTimestamp: datetimeAtTransactionStart,
        paymentMethodId,
        tx,
        taxInfo,
        primarySeatEventTimestamp,
      });

      subscription = createResult.subscription;
      invoice = createResult.invoice;
      creditGrants = createResult.creditGrants;
    }

    // 3. Create payment record if there's an invoice with amount > 0
    if (invoice && invoice.totalAmountCents > 0) {
      await tx
        .update(payments)
        .set({
          invoiceId: invoice.id,
          paymentMethodId,
          amountCents: invoice.totalAmountCents,
          currency: invoice.currency,
          status: "succeeded",
          metadata: {
            ...payment.metadata,
            subscription_id: subscription.id,
            invoice_id: invoice.id,
          },
        })
        .where(eq(payments.id, payment.id))
        .returning();
    } else {
      await tx
        .update(payments)
        .set({
          metadata: {
            ...payment.metadata,
            subscription_id: subscription.id,
            invoice_id: invoice?.id || "",
          },
        })
        .where(eq(payments.id, payment.id));
    }

    return {
      subscription,
      invoice,
      payment,
    };
  });
}

// Process setup intent from webhook
async function processSetupIntent(
  payment: typeof payments.$inferSelect & {
    metadata: Record<string, string>;
  }
) {
  // Type assertion for metadata to avoid TypeScript errors
  const metadata = payment.metadata as Record<string, string>;
  const customer_id = metadata.customer_id;
  const plan_id = metadata.plan_id;
  const price_id = metadata.price_id;
  const subscription_id = metadata.subscription_id;
  const is_first_payment = metadata.is_first_payment;
  const is_trial = metadata.is_trial;
  const primarySeatEventTimestamp = metadata.primary_seat_event_ts
    ? new Date(metadata.primary_seat_event_ts)
    : undefined;

  // Trial-specific metadata
  const trial_parent_plan_id = metadata.trial_parent_plan_id;
  const trial_parent_price_id = metadata.trial_parent_price_id;

  const result = await db.transaction(async (tx) => {
    let paymentMethodId: string | null = null;
    let datetimeAtTransactionStart = new Date();

    try {
      // Portal add-payment-method: just save the method and link it to the customer
      if (metadata.portal_pm_add === "true") {
        paymentMethodId = await getOrCreateLumenPaymentMethodFromPspPayment({
          tx,
          merchantId: payment.merchantId,
          customerId: metadata.customer_id as string,
          pspPaymentId: payment.externalPaymentId!,
          datetimeAtTransactionStart,
        });

        if (!paymentMethodId) {
          throw new Error("Failed to process payment method for portal add");
        }

        await tx
          .update(payments)
          .set({
            paymentMethodId,
            metadata: { ...payment.metadata, payment_method_updated: "true" },
          })
          .where(eq(payments.id, payment.id));

        // Opportunistically set this payment method on the most recent dunning subscription
        try {
          const sub = await tx.query.subscriptions.findFirst({
            where: and(
              eq(subscriptions.customerId, metadata.customer_id as string),
              inArray(subscriptions.status, ["past_due", "paused"])
            ),
            orderBy: (subscriptions, { desc }) => [
              desc(subscriptions.createdAt),
            ],
          });
          if (sub) {
            await tx
              .update(subscriptionDetails)
              .set({ paymentMethodId })
              .where(
                and(
                  eq(subscriptionDetails.subscriptionId, sub.id),
                  isNull(subscriptionDetails.deletedAt)
                )
              );
          }
        } catch (e) {
          console.warn(
            "Failed to set PM on recent subscription during portal add",
            e
          );
        }

        return { paymentMethodUpdated: true };
      }

      paymentMethodId = await getOrCreateLumenPaymentMethodFromPspPayment({
        tx,
        merchantId: payment.merchantId,
        customerId: customer_id as string,
        pspPaymentId: payment.externalPaymentId!,
        datetimeAtTransactionStart,
      });
    } catch (pmError) {
      console.error(
        `Error processing payment method for setup intent ${payment.externalPaymentId}`,
        pmError
      );
    }

    if (!paymentMethodId) {
      throw new Error("Failed to process payment method");
    }

    // Handle trial flow
    if (is_trial === "true") {
      // Look up the corresponding trial plan
      const trialPlan = await tx.query.plans.findFirst({
        where: and(
          eq(plans.trialParentPlanId, trial_parent_plan_id),
          eq(plans.merchantId, payment.merchantId),
          eq(plans.isTrialPlan, true),
          isNull(plans.deletedAt)
        ),
      });

      if (!trialPlan) {
        throw new Error("Trial plan not found for the given parent plan.");
      }

      const trialPrice = await tx.query.prices.findFirst({
        where: and(eq(prices.planId, trialPlan.id), isNull(prices.deletedAt)),
      });

      if (!trialPrice) {
        throw new Error("Trial price not found for the trial plan.");
      }

      // Create subscription on the trial plan
      const { subscription, creditGrants, wasExistingSubscription } =
        await createSubscriptionCore({
          merchantId: payment.merchantId,
          customerId: customer_id,
          planId: trialPlan.id,
          effectivePriceId: trialPrice.id,
          startTimestamp: datetimeAtTransactionStart,
          paymentMethodId: paymentMethodId,
          dangerouslyAllowMultipleSubscriptions: false,
          tx,
          primarySeatEventTimestamp,
        });

      if (!subscription) {
        throw new Error("Failed to create trial subscription");
      }

      // Update subscription status to "trialing" for trial subscriptions
      await tx
        .update(subscriptions)
        .set({ status: "trialing" })
        .where(eq(subscriptions.id, subscription.id));

      // Calculate trial end date
      const trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + (trialPlan.trialDays || 0));

      // Create scheduled change to migrate to paid plan at trial end
      await tx.insert(subscriptionsScheduledChanges).values({
        subscriptionId: subscription.id,
        effectiveDate: trialEndDate,
        effectiveOnNextBilling: false,
        newPlanId: trial_parent_plan_id,
        newPriceId: trial_parent_price_id,
        newVersionNumber: "1",
      });

      console.log(
        `Trial subscription created from setup intent: ${subscription.id}`
      );

      await tx
        .update(payments)
        .set({
          metadata: {
            ...payment.metadata,
            subscription_id: subscription.id,
          },
        })
        .where(eq(payments.id, payment.id));

      return {
        subscription_id: subscription.id,
        is_trial: true,
        credit_grants_created: creditGrants.grantCount,
      };
    }

    // Handle differently for recurring billing vs initial setup
    if (is_first_payment === "false" && subscription_id) {
      // For recurring billing: update payment method on existing subscription
      if (paymentMethodId) {
        await tx
          .update(subscriptionDetails)
          .set({
            paymentMethodId,
          })
          .where(
            and(
              eq(subscriptionDetails.subscriptionId, subscription_id),
              isNull(subscriptionDetails.deletedAt)
            )
          );

        console.log(
          `Updated payment method for subscription ${subscription_id} from setup intent: ${payment.externalPaymentId}`
        );

        await tx
          .update(payments)
          .set({
            metadata: {
              ...payment.metadata,
              payment_method_updated: "true",
            },
          })
          .where(eq(payments.id, payment.id));

        return { paymentMethodUpdated: true };
      }
    } else if (
      is_first_payment === "true" ||
      is_first_payment === undefined ||
      is_first_payment === null
    ) {
      // Create subscription without immediate billing for initial setup
      const { subscription, creditGrants, wasExistingSubscription } =
        await createSubscriptionCore({
          merchantId: payment.merchantId,
          customerId: customer_id,
          planId: plan_id,
          effectivePriceId: price_id,
          startTimestamp: datetimeAtTransactionStart,
          paymentMethodId: paymentMethodId,
          dangerouslyAllowMultipleSubscriptions: false,
          tx,
          primarySeatEventTimestamp,
        });

      if (wasExistingSubscription) {
        console.log(
          `Setup intent saw existing subscription ${subscription.id}`
        );
        await tx
          .update(payments)
          .set({
            metadata: {
              ...payment.metadata,
              subscription_id: subscription.id,
              existing_subscription: "true",
            },
          })
          .where(eq(payments.id, payment.id));

        return {
          subscription_id: subscription.id,
          existing_subscription: true,
        };
      }

      if (!subscription) {
        throw new Error("Failed to create subscription");
      }

      if (creditGrants.grantCount > 0) {
        console.info(
          `Created ${creditGrants.grantCount} initial credit grants for subscription ${subscription.id}`
        );
      }

      console.log(`Subscription created from setup intent: ${subscription.id}`);

      await tx
        .update(payments)
        .set({
          metadata: {
            ...payment.metadata,
            subscription_id: subscription.id,
          },
        })
        .where(eq(payments.id, payment.id));

      return {
        subscription_id: subscription.id,
        credit_grants_created: creditGrants.grantCount,
      };
    }
  });

  // After saving PM for portal adds, try to recover subscription by retrying latest unpaid invoice
  try {
    if (payment.metadata?.portal_pm_add === "true") {
      const latestUnpaid = await db.query.invoices.findFirst({
        where: and(
          eq(invoices.customerId, payment.metadata.customer_id as string),
          eq(invoices.merchantId, payment.merchantId),
          eq(invoices.status, "issued")
        ),
        orderBy: (invoices, { desc }) => [desc(invoices.createdAt)],
      });

      if (latestUnpaid) {
        // Compute next attempt number
        const lastRetry = await db.query.paymentRetries.findFirst({
          where: eq(paymentRetries.invoiceId, latestUnpaid.id),
          orderBy: (paymentRetries, { desc }) => [
            desc(paymentRetries.attemptNumber),
          ],
        });
        const attemptNumber = (lastRetry?.attemptNumber || 0) + 1;

        // Ensure there's a payment object; create retry record as pending
        let existingPayment = await db.query.payments.findFirst({
          where: eq(payments.invoiceId, latestUnpaid.id),
          orderBy: (payments, { desc }) => [desc(payments.createdAt)],
        });

        if (!existingPayment) {
          const [created] = await db
            .insert(payments)
            .values({
              merchantId: payment.merchantId,
              invoiceId: latestUnpaid.id,
              amountCents: latestUnpaid.totalAmountCents || 0,
              currency: latestUnpaid.currency,
              status: "pending",
            })
            .returning();
          existingPayment = created;
        }

        const [retryRecord] = await db
          .insert(paymentRetries)
          .values({
            paymentId: existingPayment.id,
            invoiceId: latestUnpaid.id,
            attemptNumber,
            status: "pending",
          })
          .returning();

        await retryInvoicePayment({
          invoiceId: latestUnpaid.id,
          paymentRetryId: retryRecord.id,
          attemptNumber,
        });
      }
    }
  } catch (e) {
    console.error("Failed to queue retry after PM update:", e);
  }

  return result;
}

// Handle payment intent failure events directly from webhook (top-level handler)
async function handlePaymentFailureEvent(
  payment: typeof payments.$inferSelect
) {
  console.log("Processing payment failure event:", {
    paymentId: payment.id,
    status: payment.status,
    externalPaymentId: payment.externalPaymentId,
  });

  // Validate required metadata
  const metadataValidation = validateIntentMetadata(
    "payment",
    payment.metadata,
    payment.status
  );

  if (!metadataValidation.isValid) {
    console.error("Payment failure metadata validation failed:", {
      paymentId: payment.id,
      error: metadataValidation.error,
    });
    throw new Error(metadataValidation.error);
  }

  const payment_method_id = payment.metadata?.payment_method_id as string;
  const invoice_id =
    (payment.metadata?.invoice_id as string) ?? payment.invoiceId ?? null;
  const is_first_payment = payment.metadata?.is_first_payment as string;
  const failureMessage = payment.errorMessage || "Payment failed";

  console.log(
    "Processing payment failure for paymentIntent",
    payment.externalPaymentId
  );

  const result = await db.transaction(async (tx) => {
    if (
      is_first_payment === "true" ||
      is_first_payment === undefined ||
      is_first_payment === null
    ) {
      console.log(
        "First-time payment failed, no subscription to put in dunning"
      );
      return { status: "failed", firstTimePayment: true };
    }

    // This is a recurring payment failure - initiate dunning process
    console.log("Recurring payment failed, initiating dunning process");
    if (payment_method_id) {
      await tx
        .update(paymentMethods)
        .set({
          lastFailedAt: new Date(),
          failureReason: failureMessage,
        })
        .where(eq(paymentMethods.id, payment_method_id));
    }

    // Update invoice status back to "issued" (not paid) just in the unlikely case some other flow has changed it
    if (invoice_id) {
      await tx
        .update(invoices)
        .set({
          status: "issued",
        })
        .where(eq(invoices.id, invoice_id));
    }

    if (invoice_id) {
      const invoice = await tx.query.invoices.findFirst({
        where: eq(invoices.id, invoice_id),
        with: {
          subscription: true,
          customer: true,
        },
      });

      // Attempt immediate fallback to other payment methods before dunning
      if (invoice && invoice.customer) {
        const customerId = invoice.customerId;
        const attemptedIds: string[] = Array.isArray(
          (payment.metadata as any)?.attempted_payment_method_ids
        )
          ? ([
              ...new Set(
                (payment.metadata as any)
                  ?.attempted_payment_method_ids as string[]
              ),
            ] as string[])
          : ([payment.metadata?.payment_method_id as string | undefined].filter(
              Boolean
            ) as string[]);

        // Fetch candidate methods ordered by recency
        const candidateMethods = await tx.query.paymentMethods.findMany({
          where: and(
            eq(paymentMethods.customerId, customerId),
            isNull(paymentMethods.deletedAt)
          ),
          orderBy: (paymentMethods, { desc }) => [
            desc(paymentMethods.lastUsedAt),
          ],
        });

        // Prefer method on subscription details first (if set and not tried)
        let preferredId: string | null = null;
        if (invoice.subscriptionId) {
          const sd = await tx.query.subscriptionDetails.findFirst({
            where: and(
              eq(subscriptionDetails.subscriptionId, invoice.subscriptionId),
              isNull(subscriptionDetails.deletedAt)
            ),
          });
          preferredId = sd?.paymentMethodId || null;
        }

        const tried = new Set(attemptedIds);
        const ordered = [
          ...(preferredId && !tried.has(preferredId)
            ? candidateMethods.filter((m) => m.id === preferredId)
            : []),
          ...candidateMethods.filter((m) => m.id !== preferredId),
        ];
        const nextMethod = ordered.find((m) => !tried.has(m.id));

        if (nextMethod) {
          // Update payment record to reflect next attempt
          const newAttempted = Array.from(
            new Set([...attemptedIds, nextMethod.id])
          );
          await tx
            .update(payments)
            .set({
              paymentMethodId: nextMethod.id,
              metadata: {
                ...(payment.metadata || {}),
                attempted_payment_method_ids: newAttempted,
                payment_method_id: nextMethod.id,
                retry_reason: "webhook_failover",
              },
              updatedAt: new Date(),
            })
            .where(eq(payments.id, payment.id));

          // Short-circuit dunning; we'll retry immediately after transaction
          return { status: "retry_queued", nextPaymentMethodId: nextMethod.id };
        }
      }

      if (invoice?.subscription && invoice.subscription.status !== "canceled") {
        const dunningConfig = await getOrCreateDunningConfig(
          invoice.subscription.merchantId,
          invoice.subscription.planId
        );

        if (dunningConfig.gracePeriodDays > 0) {
          const now = new Date();
          const existingGraceEnd = invoice.subscription.gracePeriodEndsAt;
          if (invoice.subscription.status === "past_due" && existingGraceEnd) {
            if (existingGraceEnd <= now) {
              console.log(
                `Grace period already expired for subscription ${invoice.subscription.id}; enforcing end-of-dunning action now`
              );
              await enforceDunningEndAction({
                tx,
                subscriptionId: invoice.subscription.id,
                action: dunningConfig.endOfDunningAction,
                currentTimestamp: now,
              });
            } else {
              console.log(
                `Subscription ${invoice.subscription.id} already in past_due; keeping existing gracePeriodEndsAt ${existingGraceEnd.toISOString()}`
              );
            }
          } else {
            const gracePeriodEndsAt = new Date();
            gracePeriodEndsAt.setDate(
              gracePeriodEndsAt.getDate() + dunningConfig.gracePeriodDays
            );

            await tx
              .update(subscriptions)
              .set({
                status: "past_due",
                gracePeriodEndsAt,
              })
              .where(eq(subscriptions.id, invoice.subscription.id));

            console.log(
              `Subscription ${invoice.subscription.id} moved to past_due status with grace period until ${gracePeriodEndsAt.toISOString()}`
            );

            try {
              const invFull = await tx.query.invoices.findFirst({
                where: eq(invoices.id, invoice.id),
                with: { customer: true, merchant: true },
              });
              const notify = createNotificationProvider();
              const customerEmail = invFull?.customer?.email;
              const merchantName =
                invFull?.merchant?.displayName ||
                invFull?.merchant?.legalName ||
                "Your Service Provider";
              if (customerEmail) {
                await notify.sendEmail({
                  to: customerEmail,
                  subject: `Payment issue – action needed (${merchantName})`,
                  html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                      <h2>We couldn't process your payment</h2>
                      <p>Your subscription has entered a grace period. Please update your payment method to avoid interruption.</p>
                      <p>Grace period ends on <strong>${gracePeriodEndsAt.toDateString()}</strong>.</p>
                      <p>Best regards,<br>${merchantName}</p>
                    </div>
                  `,
                  from: "noreply@getlumen.dev",
                });
              }
            } catch (e) {
              console.error("Failed to send entered-dunning email:", e);
            }
          }
        } else {
          // merchant has ZERO grace period - immediate action needed
          console.log(
            "No grace period configured, executing immediate action:",
            dunningConfig.endOfDunningAction
          );
          await enforceDunningEndAction({
            tx,
            subscriptionId: invoice.subscription.id,
            action: (dunningConfig.endOfDunningAction === "pause_subscription"
              ? "pause_subscription"
              : dunningConfig.endOfDunningAction === "cancel_subscription"
                ? "cancel_subscription"
                : "mark_as_unpaid") as any,
            currentTimestamp: new Date(),
          });
        }
      }
    }

    console.info(
      `Processed payment failure with dunning for payment ${payment.id}, invoice ${invoice_id || "N/A"}`
    );

    return { status: "failed", payment };
  });

  // If we queued a retry with a different payment method, immediately attempt it now
  if (result && "status" in result && result.status === "retry_queued") {
    const invoiceId =
      (payment.metadata?.invoice_id as string) ?? payment.invoiceId;
    if (!invoiceId) {
      return { status: "failed", payment };
    }

    // Refresh payment (to ensure we have the latest metadata/PM assignment)
    const refreshedPayment = await db.query.payments.findFirst({
      where: eq(payments.id, payment.id),
    });

    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
      with: {
        customer: true,
        merchant: true,
        subscription: true,
      },
    });

    if (!refreshedPayment || !invoice || !invoice.customer) {
      return { status: "failed", payment };
    }

    // Build subscription details list for metadata (if any)
    let subDetails: { subscriptionDetailsId: string }[] = [];
    if (invoice.subscriptionId) {
      const subId = invoice.subscriptionId as string;
      try {
        subDetails = await db
          .select({ subscriptionDetailsId: subscriptionDetails.id })
          .from(subscriptionDetails)
          .where(eq(subscriptionDetails.subscriptionId, subId));
      } catch (err) {
        console.error(
          `Failed to fetch subscription details for invoice ${invoice.id}:`,
          err
        );
      }
    }

    // Fetch the explicitly selected next PM (stored on the payment record)
    const nextPaymentMethod = refreshedPayment.paymentMethodId
      ? await db.query.paymentMethods.findFirst({
          where: and(
            eq(paymentMethods.id, refreshedPayment.paymentMethodId as string),
            isNull(paymentMethods.deletedAt)
          ),
        })
      : null;

    if (!nextPaymentMethod) {
      return { status: "failed", payment };
    }

    const inv = invoice;
    const rp = refreshedPayment;

    const context = {
      customer: inv.customer,
      paymentMethod: nextPaymentMethod,
      merchantId: inv.merchantId,
      currency: inv.currency,
    } as const;

    await processPayment({
      context,
      subscriptionId: inv.subscriptionId || "",
      subDetails,
      invoice: inv,
      invoiceId,
      payment: rp,
    });

    return { status: "retry_queued", payment: refreshedPayment };
  }

  return result;
}

// Handle setup intent failure events directly from webhook (top-level handler)
async function handleSetupFailureEvent(payment: typeof payments.$inferSelect) {
  console.log("Processing setup failure event:", {
    paymentId: payment.id,
    status: payment.status,
    externalPaymentId: payment.externalPaymentId,
  });

  // Validate required metadata
  const metadataValidation = validateIntentMetadata(
    "setup",
    payment.metadata,
    payment.status
  );

  if (!metadataValidation.isValid) {
    console.error("Setup failure metadata validation failed:", {
      paymentId: payment.id,
      error: metadataValidation.error,
    });
    throw new Error(metadataValidation.error);
  }

  const { customer_id, last_setup_error } = payment.metadata as Record<
    string,
    any
  >;

  console.log(
    "Processing setup failure for setupIntent",
    payment.externalPaymentId
  );

  return await db.transaction(async (tx) => {
    // Update the payment record status to "failed"
    await tx
      .update(payments)
      .set({
        status: "failed",
        errorMessage: last_setup_error?.message || "Setup failed",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    console.info(`Processed setup failure for payment ${payment.id}`);

    try {
      const notify = createNotificationProvider();
      const cust = await tx.query.customers.findFirst({
        where: eq(customers.id, customer_id),
      });
      const merch = await tx.query.merchants.findFirst({
        where: eq(merchants.id, payment.merchantId),
      });
      const customerEmail = cust?.email;
      const merchantName =
        merch?.displayName || merch?.legalName || "Your Service Provider";
      if (customerEmail) {
        await notify.sendEmail({
          to: customerEmail,
          subject: `We couldn't set up your payment method`,
          html: `
            <div style=\"font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;\">
              <h2>Action needed to complete setup</h2>
              <p>We couldn't set up your payment method. Please try again or use a different method.</p>
              <p>If you continue to have trouble, contact support.</p>
              <p>Best regards,<br>${merchantName}</p>
            </div>
          `,
          from: "noreply@getlumen.dev",
        });
      }
    } catch (e) {
      console.error("Failed to send setup failure email:", e);
    }

    return { status: "failed", payment };
  });
}

// Handle payment intent events from stripe AND dodo payments
async function handlePaymentEvent(payment: typeof payments.$inferSelect) {
  console.log("Processing payment event:", {
    paymentId: payment.id,
    status: payment.status,
    externalPaymentId: payment.externalPaymentId,
  });

  if (!payment.metadata) {
    // should have been validated already by the validateIntentMetadata function
    // but just for making TS happy
    throw new Error("Missing metadata for payment");
  }

  const is_first_payment = payment.metadata?.is_first_payment;

  // Validate required metadata
  const metadataValidation = validateIntentMetadata(
    "payment",
    payment.metadata,
    payment.status
  );

  if (!metadataValidation.isValid) {
    console.error("Payment metadata validation failed:", {
      paymentId: payment.id,
      error: metadataValidation.error,
    });
    throw new Error(metadataValidation.error);
  }

  // This handler now only processes successful payments
  if (payment.status === "succeeded") {
    console.log("Payment succeeded, determining payment type:", {
      paymentId: payment.id,
      isTrialUpgrade: payment.metadata.is_trial_upgrade,
      isFirstPayment: is_first_payment,
    });

    // First, check if this successful payment can recover a subscription from dunning
    const invoiceId = payment.invoiceId as string;
    if (invoiceId) {
      try {
        const invoice = await db.query.invoices.findFirst({
          where: eq(invoices.id, invoiceId),
          with: {
            subscription: true,
            customer: true,
            merchant: true,
          },
        });

        if (
          invoice?.subscription &&
          (invoice.subscription.status === "past_due" ||
            invoice.subscription.status === "paused")
        ) {
          console.log(
            `Recovering subscription ${invoice.subscription.id} from ${invoice.subscription.status} state`
          );

          await resumeSubscriptionAndResetCycle({
            subscriptionId: invoice.subscription.id,
            resumedAt: new Date(),
          });

          console.log(
            `Subscription ${invoice.subscription.id} unpaused and set to active`
          );

          try {
            const notify = createNotificationProvider();
            const customerEmail = invoice.customer?.email;
            const merchantName =
              invoice.merchant?.displayName ||
              invoice.merchant?.legalName ||
              "Your Service Provider";
            if (customerEmail) {
              await notify.sendEmail({
                to: customerEmail,
                subject: `Payment received – your subscription is active`,
                html: `
                  <div style=\"font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;\">
                    <h2>You're back on track!</h2>
                    <p>Your recent payment succeeded and your subscription has resumed.</p>
                    <p>Best regards,<br>${merchantName}</p>
                  </div>
                `,
                from: "noreply@getlumen.dev",
              });
            }
          } catch (e) {
            console.error("Failed to send recovery email:", e);
          }
        }
      } catch (error) {
        // Don't fail the entire payment processing if dunning recovery fails
        console.error("Failed to recover subscription from dunning:", error);
      }
    }

    // Check for credit topup payments - creates invoice, grants credits
    if (payment.metadata.is_topup === "true") {
      console.log("Processing credit topup payment:", payment.id);

      // CRITICAL: We must throw an error if processing fails
      // This tells the PSP to retry the webhook, preventing customer from being charged without receiving credits
      const topupResult = await processTopupPayment(payment);

      if (!topupResult.success) {
        console.error(
          `Failed to process topup payment: ${topupResult.message}`,
          {
            paymentId: payment.id,
            message: topupResult.message,
          }
        );
        // Throw error to trigger webhook retry
        throw new Error(
          `Topup processing failed: ${topupResult.message || "Unknown error"}`
        );
      }

      console.log(
        `Topup processed: invoice ${topupResult.invoiceId}, credits ${topupResult.creditGrantId}`
      );

      // Topup payments don't need further processing (no subscription creation/updates)
      return { status: "topup_processed", payment };
    }

    // Check for trial upgrades first
    if (payment.metadata.is_trial_upgrade === "true") {
      console.log("Processing trial upgrade payment:", payment.id);
      return await processTrialUpgrade(payment);
    }

    // Check if this is the first payment in a recurring billing cycle
    if (is_first_payment === "false") {
      console.log("Processing recurring payment:", payment.id);
      return await processRecurringPayment(
        payment as typeof payments.$inferSelect & {
          metadata: Record<string, string>;
        }
      );
    } else if (
      is_first_payment === undefined ||
      is_first_payment === null ||
      is_first_payment === "true"
    ) {
      console.log("Processing first-time payment:", payment.id);
      return await processFirstTimePayment(
        payment as typeof payments.$inferSelect & {
          metadata: Record<string, string>;
        }
      );
    } else {
      console.error("Invalid is_first_payment value:", {
        paymentId: payment.id,
        isFirstPayment: is_first_payment,
      });
      throw new Error("Invalid is_first_payment value");
    }
  }

  // This function should only be called for succeeded payments
  // All failure cases are now handled by dedicated failure handlers
  console.log("Unexpected payment status in success handler:", {
    paymentId: payment.id,
    status: payment.status,
  });
  throw new Error(`Unexpected payment status: ${payment.status}`);
}

// Handle setup intent events from webhook
async function handleSetupEvent(
  payment: typeof payments.$inferSelect & {
    metadata: Record<string, string>;
  }
) {
  console.log("Processing setup event:", {
    paymentId: payment.id,
    status: payment.status,
    externalPaymentId: payment.externalPaymentId,
  });

  // Validate required metadata
  const metadataValidation = validateIntentMetadata(
    "setup",
    payment.metadata as Record<string, string>,
    payment.status
  );

  if (!metadataValidation.isValid) {
    console.error("Setup event metadata validation failed:", {
      paymentId: payment.id,
      error: metadataValidation.error,
    });
    throw new Error(metadataValidation.error);
  }

  // This handler now only processes successful setup intents
  if (payment.status === "succeeded") {
    console.log("Setup intent succeeded, processing:", payment.id);
    return await processSetupIntent(payment);
  }

  // This function should only be called for succeeded setup intents
  // All failure cases are now handled by dedicated failure handlers
  console.log("Unexpected setup status in success handler:", {
    paymentId: payment.id,
    status: payment.status,
  });
  throw new Error(`Unexpected setup status: ${payment.status}`);
}

// Handle payment link completion - payment provider agnostic
async function handlePaymentLinkEvent({
  payment,
  merchantId,
  externalPaymentId,
  paymentStatus,
  paymentNotes,
}: {
  payment: typeof payments.$inferSelect;
  merchantId: string;
  externalPaymentId: string;
  paymentStatus: string;
  paymentNotes: string;
}) {
  // Validate required metadata for checkout sessions
  if (
    !payment.metadata?.invoice_id ||
    !payment.metadata?.customer_id ||
    !payment.metadata?.merchant_id
  ) {
    throw new Error("Missing required metadata in checkout session");
  }

  if (payment.metadata.merchant_id !== merchantId) {
    throw new Error("Merchant ID mismatch in checkout session metadata");
  }

  if (paymentStatus !== "succeeded" && paymentStatus !== "paid") {
    console.error(
      `Payment status ${paymentStatus} is not valid, skipping payment link event`
    );
    return { status: paymentStatus };
  }

  console.log("Processing payment link completion", {
    paymentId: payment.id,
    externalPaymentId,
    invoiceId: payment.metadata.invoice_id,
    customerId: payment.metadata.customer_id,
  });

  const paymentProvider = await getPaymentProvider(merchantId);

  await db.transaction(async (tx) => {
    // 1. Find the invoice that was paid
    const invoice = await tx.query.invoices.findFirst({
      where: and(
        eq(invoices.id, payment.metadata!.invoice_id),
        eq(invoices.merchantId, merchantId),
        eq(invoices.customerId, payment.metadata!.customer_id),
        ne(invoices.status, "deleted")
      ),
    });

    if (!invoice) {
      throw new Error(
        `Invoice not found with ID: ${payment.metadata!.invoice_id}`
      );
    }

    if (invoice.status === "paid") {
      console.log(
        `Invoice ${payment.metadata!.invoice_id} is already marked as paid, skipping`
      );
      return;
    }

    // 2. Process Payment Method
    let paymentMethodId: string | null = null;
    let datetimeAtTransactionStart = new Date();
    try {
      paymentMethodId = await getOrCreateLumenPaymentMethodFromPspPayment({
        tx,
        merchantId: merchantId,
        customerId: payment.metadata!.customer_id,
        pspPaymentId: externalPaymentId,
        datetimeAtTransactionStart,
      });
    } catch (pmError) {
      console.error(
        `Error processing ${paymentProvider.name} payment method for payment ${externalPaymentId}`,
        pmError
      );
      // TODO: How _should_ we handle this case?
    }

    console.log("Updating payment record with external payment ID", {
      paymentId: payment.id,
      externalPaymentId,
      paymentMethodId,
    });

    // Update the payment record with the external payment ID and mark as succeeded
    await tx
      .update(payments)
      .set({
        externalPaymentId,
        paymentMethodId,
        status: "succeeded",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    // 3. Update invoice status to "paid" and add payment date
    await tx
      .update(invoices)
      .set({
        status: "paid",
        paidDate: new Date(),
        notes: paymentNotes,
      })
      .where(eq(invoices.id, payment.metadata!.invoice_id));

    // 4. Update subscription details with payment method if we have one and the subscription exists
    if (paymentMethodId && invoice.subscriptionId) {
      console.log("Updating subscription details with payment method", {
        subscriptionId: invoice.subscriptionId,
        paymentMethodId,
      });

      await tx
        .update(subscriptionDetails)
        .set({
          paymentMethodId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(subscriptionDetails.subscriptionId, invoice.subscriptionId),
            isNull(subscriptionDetails.deletedAt)
          )
        );
    }

    console.log(
      `Successfully processed payment link for invoice ${payment.metadata!.invoice_id}`
    );
  });

  return;
}

// Handle webhook errors
function handleWebhookError(c: any, error: any) {
  console.error("Webhook error:", error);
  return c.json(
    {
      error: "Webhook processing failed: " + (error.message || "Unknown error"),
    },
    400
  );
}

// WARNING: This routes are not protected by auth middleware
export const publicRoute: Hono = new Hono()
  .get("/events/:paymentIntentId", (c) => {
    // SSE CORS: allow any origin
    c.header("Access-Control-Allow-Origin", "*");
    console.log("SSE connection request");
    const paymentIntentId = c.req.param("paymentIntentId");
    return streamSSE(c, async (stream) => {
      console.log(
        `SSE client connected for paymentIntentId: ${paymentIntentId}`
      );
      const { cachedEvents } = await registerSSEClient(paymentIntentId, stream);

      // Send initial connection-established event
      await stream.writeSSE({
        data: JSON.stringify({
          type: "connection_established",
          paymentIntentId,
        }),
        event: "message",
        id: crypto.randomUUID(),
      });

      // Send any cached events that arrived before SSE connected
      if (cachedEvents.length > 0) {
        console.log(
          `Replaying ${cachedEvents.length} cached events for ${paymentIntentId}`
        );
        for (const event of cachedEvents) {
          try {
            await stream.writeSSE({
              data: JSON.stringify(event),
              event: "stripe_event",
              id: crypto.randomUUID(),
            });
          } catch (error) {
            console.error(
              `Failed to replay cached SSE event for ${paymentIntentId}:`,
              error
            );
            break;
          }
        }
      }

      // Periodic ping to keep connection alive
      const intervalId = setInterval(() => {
        void stream
          .writeSSE({
            data: "ping",
            event: "ping",
            id: crypto.randomUUID(),
          })
          .catch((error) => {
            console.error(`Failed to send ping to ${paymentIntentId}:`, error);
            clearInterval(intervalId);
          });
      }, 5000); // CRITICAL: NEEDS TO BE LESS THAN 10 SECONDS (BUN has 10 sec timeout)

      // Cleanup on client disconnect
      stream.onAbort(() => {
        console.log(
          `SSE client disconnected for paymentIntentId: ${paymentIntentId}`
        );
        unregisterSSEClient(paymentIntentId);
        clearInterval(intervalId);
      });

      // Prevent handler from completing—await client disconnect
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  })
  .get("/payment-status/:intentId", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    const intentId = c.req.param("intentId");

    console.log(`Payment status polling request for intentId: ${intentId}`);

    try {
      const status = await getPaymentStatus(intentId);

      if (!status) {
        return c.json(
          {
            status: "pending",
            message: "Payment not found or still processing",
          },
          202
        );
      }

      return c.json(status, 200);
    } catch (error) {
      console.error(`Failed to get payment status for ${intentId}:`, error);
      return c.json(
        {
          error: "Failed to retrieve payment status",
          message:
            error instanceof Error ? error.message : "Unknown server error",
        },
        500
      );
    }
  })
  .get(
    "/invitation/:invitationId",
    zValidator(
      "param",
      z.object({
        invitationId: z.string().min(1),
      })
    ),
    async (c) => {
      try {
        const { invitationId } = c.req.valid("param");

        const invitationData = await db
          .select({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            status: invitation.status,
            organizationId: invitation.organizationId,
            organizationName: organization.name,
            inviterName: user.name,
            inviterEmail: user.email,
          })
          .from(invitation)
          .innerJoin(
            organization,
            eq(invitation.organizationId, organization.id)
          )
          .innerJoin(user, eq(invitation.inviterId, user.id))
          .where(eq(invitation.id, invitationId))
          .limit(1);

        if (!invitationData || invitationData.length === 0) {
          return c.json({ error: "Invitation not found" }, 404);
        }

        const invite = invitationData[0];

        if (invite.status !== "pending") {
          return c.json({ error: "Invitation is no longer pending" }, 400);
        }

        const roleDisplay = Array.isArray(invite.role)
          ? invite.role
              .map((r) => r.charAt(0).toUpperCase() + r.slice(1))
              .join(", ")
          : typeof invite.role === "string"
            ? invite.role
                .split(",")
                .map((r) => r.charAt(0).toUpperCase() + r.slice(1))
                .join(", ")
            : "Member";

        return c.json({
          organizationName: invite.organizationName,
          role: roleDisplay,
          inviterName: invite.inviterName || invite.inviterEmail,
          email: invite.email,
        });
      } catch (error) {
        console.error("Error fetching invitation info:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  .post("/webhook-dodo/:merchant_id", async (c) => {
    const merchantId = c.req.param("merchant_id");
    console.log("Received Dodo webhook for merchant", merchantId);

    try {
      // Get the raw body for signature verification
      const rawBody = await c.req.text();

      // Verify webhook signature using Dodo's webhook verification
      if (env.NODE_ENV !== "development") {
        await verifyPaymentProviderWebhook({
          c,
          paymentProvider: await getPaymentProvider(merchantId),
          client: undefined,
          rawBody,
        });
      }

      // Parse the webhook payload
      const webhookPayload = JSON.parse(rawBody);

      console.log("Processing Dodo webhook event:", {
        type: webhookPayload.type,
        subscriptionId: webhookPayload.data?.subscription_id,
        status: webhookPayload.data?.status,
      });

      // IDEMPOTENCY CHECK: Prevent duplicate webhook processing
      const dodoPaymentId = webhookPayload.data?.payment_id;
      if (dodoPaymentId) {
        const shouldProcess = await checkWebhookIdempotency(
          "dodo",
          merchantId,
          dodoPaymentId
        );
        if (!shouldProcess) {
          return c.json({ received: true, duplicate: true }, 200);
        }
      }

      if (
        webhookPayload.type !== "payment.succeeded" &&
        webhookPayload.type !== "payment.failed"
      ) {
        console.log(
          `Unhandled Dodo webhook event type: ${webhookPayload.type}`
        );
        return c.json({ received: true });
      }

      // Process different event types
      const dodoPayment = webhookPayload.data as DodoPayments.Payment;
      if (!dodoPayment.subscription_id) {
        throw new Error(
          `No subscription ID found for Dodo payment: ${dodoPayment.payment_id}`
        );
      }
      // this works fine for both first time payment and subsequent payments
      const lumenPaymentId = webhookPayload.data.metadata.lumen_payment_id;
      console.log("lumenPaymentId", lumenPaymentId);
      let payment = await db.query.payments.findFirst({
        where: eq(payments.id, lumenPaymentId),
      });

      if (!payment) {
        console.error(
          `No Lumen payment ID found for Dodo payment metadata. Dodo payment ID: ${dodoPayment.payment_id}`
        );
        return c.json({ received: true });
      }

      // Verify this webhook is for the correct merchant
      // This prevents processing webhooks sent to stale/incorrect endpoints
      if (payment.merchantId !== merchantId) {
        console.log(
          `Dodo webhook merchant mismatch: payment belongs to ${payment.merchantId}, but webhook was sent to ${merchantId}. Ignoring.`
        );
        return c.json({ received: true });
      }

      if (!payment.metadata) {
        console.error(
          `No metadata found for Lumen payment ID: ${lumenPaymentId}`
        );
        return c.json({ received: true });
      }

      console.log("Found matching payment object");

      if (webhookPayload.type === "payment.succeeded") {
        console.log("Updating payment record with Dodo payment ID", {
          paymentId: payment.id,
          dodoPaymentId: dodoPayment.payment_id,
        });

        // update payment record with successful status
        [payment] = await db
          .update(payments)
          .set({
            status: "succeeded",
            // for first time payment, this is the Dodo Subscription ID so we update it to the Dodo Payment ID
            externalPaymentId: dodoPayment.payment_id,
          })
          .where(eq(payments.id, payment.id))
          .returning();

        // Determine the correct handler based on payment metadata (similar to Stripe branching)
        const metadata = payment.metadata!; // We already checked this above
        const isCheckoutSession = "checkoutSessionId" in metadata;
        const isTrial = metadata.is_trial === "true";
        const amountCents = payment.amountCents || 0;

        console.log("Dodo payment routing decision:", {
          paymentId: payment.id,
          isCheckoutSession,
          isTrial,
          amountCents,
          metadata: metadata,
        });

        if (isCheckoutSession) {
          // Handle Dodo payment link - extract details and call generic handler
          await handlePaymentLinkEvent({
            payment,
            merchantId,
            externalPaymentId: dodoPayment.payment_id,
            paymentStatus: "succeeded",
            paymentNotes: `Paid online via Dodo payment ${dodoPayment.payment_id}`,
          });
        } else if (isTrial || amountCents === 0) {
          // Handle trials and zero-amount payments (setup intents equivalent)
          // This mirrors Stripe's setup_intent handling for trials
          console.log(
            "Routing Dodo payment to setup event handler (trial/setup)"
          );
          await handleSetupEvent(
            payment as typeof payments.$inferSelect & {
              metadata: Record<string, string>;
            }
          );
        } else {
          // Handle regular payments (payment intent equivalent)
          console.log(
            "Routing Dodo payment to payment event handler (regular payment)"
          );
          await handlePaymentEvent(
            payment as typeof payments.$inferSelect & {
              metadata: Record<string, string>;
            }
          );
        }

        // Mark retry record as succeeded if applicable
        try {
          const retryId = payment.metadata?.payment_retry_id as
            | string
            | undefined;
          if (retryId) {
            await db
              .update(paymentRetries)
              .set({ status: "succeeded" })
              .where(eq(paymentRetries.id, retryId));
          }
        } catch (e) {
          console.warn(
            "Failed to update Dodo payment retry status (succeeded)",
            e
          );
        }

        // Post-process Dodo payments to fetch invoice PDF and update tax info
        // This applies to all paid invoices except trials and zero-amount payments
        const shouldPostProcess = !isTrial && amountCents > 0;
        if (shouldPostProcess) {
          // Get the updated payment record to ensure we have the invoice ID
          payment = await db.query.payments.findFirst({
            where: eq(payments.id, payment.id),
          });

          if (!payment) {
            console.warn(
              "Dodo payment record not found during post-processing"
            );
            return c.json({ received: true });
          }

          // For checkout sessions, invoice ID might be in metadata
          const invoiceId = payment.invoiceId || payment.metadata?.invoice_id;

          if (!invoiceId) {
            console.warn(
              "Dodo payment succeeded without invoiceId; skipping post-processing",
              { paymentId: payment.id }
            );
            return c.json({ received: true });
          }

          // Post-process the Dodo payment: update tax info, invoice totals, and handle PDF
          await postProcessDodoPayment({
            dodoPayment,
            paymentId: payment.id,
            invoiceId: invoiceId,
            merchantId,
          });
        }
        return c.json({ received: true });
      } else if (webhookPayload.type === "payment.failed") {
        try {
          await db
            .update(payments)
            .set({
              // same as before - first time payment it has the Dodo Subscription ID, subsequent payments have the Dodo Payment ID so we update it
              externalPaymentId: dodoPayment.payment_id,
              status: "failed",
              errorMessage: dodoPayment.error_message,
            })
            .where(eq(payments.id, payment.id));
          console.log(
            `Dodo payment failed: ${dodoPayment.payment_id} - ${dodoPayment.error_message}`
          );
          await handlePaymentFailureEvent(payment);
        } catch (e) {
          console.warn(
            `Failed to set externalPaymentId for failed Dodo payment ${dodoPayment.payment_id}`,
            e
          );
        }

        // Mark retry record as failed if applicable
        try {
          const retryId = payment.metadata?.payment_retry_id as
            | string
            | undefined;
          if (retryId) {
            await db
              .update(paymentRetries)
              .set({
                status: "failed",
                errorMessage: dodoPayment.error_message,
              })
              .where(eq(paymentRetries.id, retryId));
          }
        } catch (e) {
          console.warn(
            "Failed to update Dodo payment retry status (failed)",
            e
          );
        }

        return c.json({ received: true });
      }
    } catch (error) {
      console.error("Dodo webhook error:", error);
      return c.json(
        {
          error:
            "Webhook processing failed: " +
            (error instanceof Error ? error.message : "Unknown error"),
        },
        200
      );
    }
  })
  // stripe webhook
  .post("/webhook/:merchant_id", async (c) => {
    const merchantId = c.req.param("merchant_id");

    // these should match the events allowed at the time of webhook creation in routes/stripe.ts
    const supportedEventTypes = [
      "payment_intent.",
      "setup_intent.",
      "checkout.session.",
    ];

    type SupportedEvent =
      | Stripe.PaymentIntent
      | Stripe.SetupIntent
      | Stripe.Checkout.Session;

    // If you call c.req.text() later in the code, stripe webhook verification will fail
    const rawBody = await c.req.text();
    let event = (await c.req.json()) as Stripe.Event;

    if (supportedEventTypes.some((type) => event.type.startsWith(type))) {
      const message = `Received Stripe webhook for merchant ${merchantId}: Processing supported event type: ${event.type} status=${(event.data.object as SupportedEvent).status}, id=${(event.data.object as SupportedEvent).id}`;
      console.log(message);
    } else {
      const message = `Received Stripe webhook for merchant ${merchantId}: Skipping unsupported event type: ${event.type}`;
      console.log(message);
      return c.json({ message }, 200); // Return 200 to avoid retries, this is not an error
    }

    const signature = c.req.header("stripe-signature");
    if (!signature) {
      const errorMessage = `No signature provided for event ${event.id}`;
      console.error(errorMessage);
      return c.json({ error: errorMessage }, 400);
    }

    const paymentProvider = await getPaymentProvider(merchantId);

    if (!paymentProvider.isPaymentProviderReady) {
      console.error(paymentProvider.statusMessage);
      return c.json({ error: paymentProvider.statusMessage }, 400);
    }

    const stripeClient = await createStripeClient(paymentProvider);

    try {
      // Verify webhook signature and get Stripe client
      const isVerified = await verifyPaymentProviderWebhook({
        c,
        paymentProvider,
        client: stripeClient,
        rawBody,
      });

      if (!isVerified) {
        const errorMessage = `Webhook verification failed for event ${event.id}`;
        console.error(errorMessage);
        // Attempt auto-heal of Stripe webhook to keep things hands-off
        try {
          await attemptAutoRecreateStripeWebhook({
            merchantId,
            paymentProvider,
            stripeClient,
          });
        } catch (healErr) {
          console.error(
            `Auto-heal attempt failed for merchant ${merchantId}:`,
            healErr
          );
        }
        // Robust fallback: fetch the canonical event from Stripe and proceed
        try {
          const fetched = await stripeClient.events.retrieve(event.id);
          if (fetched && fetched.id === event.id) {
            event = fetched as Stripe.Event;
            console.log(
              `Recovered webhook event ${event.id} via Stripe API after verification failure`
            );
          } else {
            return c.json({ error: errorMessage }, 400);
          }
        } catch (fetchErr) {
          console.error(
            `Failed to fetch event ${event.id} from Stripe after verification failure:`,
            fetchErr
          );
          return c.json({ error: errorMessage }, 400);
        }
      }

      // IDEMPOTENCY CHECK: Prevent duplicate webhook processing
      const shouldProcess = await checkWebhookIdempotency(
        "stripe",
        merchantId,
        event.id
      );
      if (!shouldProcess) {
        return c.json({ received: true, duplicate: true }, 200);
      }

      const obj = event.data.object as SupportedEvent;

      if (obj.metadata?.is_checkout_session === "true") {
        console.log(
          `Received Stripe webhook for merchant ${merchantId}: Skipping checkout session event type: ${event.type}`
        );
        return c.json({ received: true }, 200);
      }

      // Prepare the broadcast data for SSE
      const broadcastData = prepareEventBroadcastData(event, merchantId);

      let payment: typeof payments.$inferSelect | undefined;
      // get lumen payment id from metadata
      // if payment intent / setup intent, get directly from metadata
      // if checkout session, get from the checkout session object > PI > metadata
      let lumenPaymentId: string | undefined;
      if (
        event.type.startsWith("payment_intent.") ||
        event.type.startsWith("setup_intent.")
      ) {
        lumenPaymentId = obj.metadata?.lumen_payment_id;
      } else if (event.type.startsWith("checkout.session.")) {
        const session = event.data.object as Stripe.Checkout.Session;
        const paymentIntentId = session.payment_intent as string;
        const paymentIntent =
          await stripeClient.paymentIntents.retrieve(paymentIntentId);
        lumenPaymentId = paymentIntent.metadata?.lumen_payment_id;
      }

      if (!lumenPaymentId) {
        const errorMessage = "Lumen payment ID not found";
        console.error(errorMessage);
        return c.json({ error: errorMessage }, 404);
      }

      // Only update when succeeded because there are race conditions in webhooks
      if (obj.status === "succeeded") {
        [payment] = await db
          .update(payments)
          .set({
            status: obj.status,
          })
          .where(eq(payments.id, lumenPaymentId))
          .returning();
      } else {
        payment = await db.query.payments.findFirst({
          where: eq(payments.id, lumenPaymentId),
        });
      }

      if (!payment) {
        const errorMessage = `Payment not found for externalPaymentId: ${obj.id}, lumenPaymentId: ${lumenPaymentId}`;
        console.error(errorMessage);
        return c.json({ error: errorMessage }, 404);
      }

      // Verify this webhook is for the correct merchant
      // Defense-in-depth: prevents processing payments belonging to different merchants
      if (payment.merchantId !== merchantId) {
        console.log(
          `Stripe webhook merchant mismatch: payment belongs to ${payment.merchantId}, but webhook was sent to ${merchantId}. Ignoring.`
        );
        return c.json({ received: true });
      }

      if (!payment?.metadata) {
        const errorMessage = "Payment metadata not found";
        console.error(errorMessage);
        return c.json({ error: errorMessage }, 404);
      }

      console.log(
        `Found matching payment object in lumen, metadata=${JSON.stringify(
          payment?.metadata
        )}`
      );

      // Process different event types - handle failures at top level
      if (event.type === "payment_intent.payment_failed") {
        // Handle payment failure events directly
        const lastPaymentError = (obj as Stripe.PaymentIntent)
          .last_payment_error;
        // try to update the payment record
        const updatedPayment = await db
          .update(payments)
          .set({
            status: "failed",
            errorMessage: lastPaymentError?.message,
          })
          .where(eq(payments.id, payment.id))
          .returning();
        try {
          const retryId = updatedPayment[0]?.metadata?.payment_retry_id as
            | string
            | undefined;

          if (retryId) {
            await db
              .update(paymentRetries)
              .set({
                status: "failed", // it was set to pending on the retry attempt
                errorMessage: lastPaymentError?.message,
              })
              .where(eq(paymentRetries.id, retryId));
          }
        } catch (e) {
          console.warn("Failed to update payment retry status (failed)", e);
        }
        await handlePaymentFailureEvent(updatedPayment[0]);
      } else if (event.type === "setup_intent.setup_failed") {
        // Handle setup failure events directly
        const lastSetupError = (obj as Stripe.SetupIntent).last_setup_error;
        const updatedPayment = await db
          .update(payments)
          .set({
            status: "failed",
            errorMessage: lastSetupError?.message,
          })
          .where(eq(payments.id, payment.id))
          .returning();
        await handleSetupFailureEvent(updatedPayment[0]);
      } else if (event.type === "payment_intent.succeeded") {
        // Handles successful payment events and recovers from dunning
        await handlePaymentEvent(payment);
        try {
          const retryId = payment.metadata?.payment_retry_id as
            | string
            | undefined;
          if (retryId) {
            await db
              .update(paymentRetries)
              .set({ status: "succeeded" })
              .where(eq(paymentRetries.id, retryId));
          }
        } catch (e) {
          console.warn("Failed to update payment retry status (succeeded)", e);
        }
      } else if (event.type === "setup_intent.succeeded") {
        // Handle successful setup events
        await handleSetupEvent(
          payment as typeof payments.$inferSelect & {
            // metadata not being null is not automatically inferred by the type
            metadata: Record<string, string>;
          }
        );
      } else if (event.type.startsWith("checkout.session.")) {
        // Handle Stripe checkout session - extract details and call generic handler
        const session = event.data.object as Stripe.Checkout.Session;
        if (
          event.type === "checkout.session.completed" &&
          session.payment_status === "paid"
        ) {
          await handlePaymentLinkEvent({
            payment,
            merchantId,
            externalPaymentId: session.id,
            paymentStatus: "paid",
            paymentNotes: `Paid online with Stripe checkout session ${session.id}`,
          });
        }
      }

      // Send event notification to connected clients across all instances
      const sseLookupId = getSSELookupIdFromEvent(event);
      if (sseLookupId) {
        const publishResult = await publishSSEEvent(sseLookupId, broadcastData);
        console.log("SSE publish result", {
          intentId: sseLookupId,
          deliveredLocally: publishResult.deliveredLocally,
          publishedToRedis: publishResult.publishedToRedis,
          cachedInRedis: publishResult.cachedInRedis,
        });
      } else {
        console.log(
          `Webhook event type ${event.type} not configured for SSE broadcast or ID not found.`
        );
      }

      return c.json({ received: true });
    } catch (error) {
      return handleWebhookError(c, error);
    }
  })
  .post("/webhook-test/:merchant_id", async (c) => {
    return c.json({
      received: true,
      status: "ok",
      message: "Test webhook endpoint - always returns OK",
    });
  })
  .post(
    "/calculate-tax",
    zValidator("json", taxCalculationSchema),
    async (c) => {
      const data = c.req.valid("json");

      try {
        // Find the merchant ID using the public key
        const apiKeyData = await db.query.apiKeys.findFirst({
          where: and(
            eq(apiKeys.keyValue, data.lumenPublishableKey),
            eq(apiKeys.keyType, "publishable"),
            isNull(apiKeys.revokedAt)
          ),
        });

        if (!apiKeyData) {
          return c.json({ error: "Invalid Lumen publishable key" }, 404);
        }

        console.log(
          `[calculate-tax] Starting tax calculation for merchant ${apiKeyData.merchantId}`,
          {
            subtotalCents: data.subtotalCents,
            customerCountry: data.customerCountry,
            customerStateProvince: data.customerStateProvince,
            taxId: data.taxId,
            businessName: data.businessName,
          }
        );

        // Calculate taxes using the payment flow helper
        const taxCalculationResult = await calculateTaxesForPaymentFlow({
          merchantId: apiKeyData.merchantId,
          subtotalCents: data.subtotalCents,
          currency: data.currency,
          billingDate: new Date(),
          customerCountry: data.customerCountry,
          customerStateProvince: data.customerStateProvince,
          taxId: data.taxId,
          businessName: data.businessName,
        });

        console.log(`[calculate-tax] Tax calculation completed`, {
          merchantId: apiKeyData.merchantId,
          originalAmount: data.subtotalCents,
          taxAmount: taxCalculationResult.totalTaxCents,
          totalAmount: data.subtotalCents + taxCalculationResult.totalTaxCents,
          jurisdiction: taxCalculationResult.jurisdiction,
          calculationMethod: taxCalculationResult.calculationMethod,
        });

        return c.json({
          success: true,
          taxCalculation: {
            subtotalCents: data.subtotalCents,
            taxAmountCents: taxCalculationResult.totalTaxCents,
            totalAmountCents:
              data.subtotalCents + taxCalculationResult.totalTaxCents,
            effectiveTaxRate: taxCalculationResult.effectiveTaxRate,
            jurisdiction: taxCalculationResult.jurisdiction,
            calculationMethod: taxCalculationResult.calculationMethod,
            taxLineItems: taxCalculationResult.taxLineItems,
            exemptionReason: taxCalculationResult.exemptionReason,
          },
        });
      } catch (error) {
        console.error(`[calculate-tax] Error calculating taxes:`, error);
        return c.json(
          {
            error: "Failed to calculate taxes",
            details: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    }
  )
  .post(
    "/update-payment-intent",
    zValidator("json", paymentIntentUpdateSchema),
    async (c) => {
      const data = c.req.valid("json");

      try {
        // Find the merchant ID using the public key
        const apiKeyData = await db.query.apiKeys.findFirst({
          where: and(
            eq(apiKeys.keyValue, data.lumenPublishableKey),
            eq(apiKeys.keyType, "publishable"),
            isNull(apiKeys.revokedAt)
          ),
        });

        if (!apiKeyData) {
          return c.json({ error: "Invalid Lumen publishable key" }, 404);
        }

        const paymentProvider = await getPaymentProvider(apiKeyData.merchantId);

        if (!paymentProvider.isPaymentProviderReady) {
          console.error(paymentProvider.statusMessage);
          return c.json({ error: paymentProvider.statusMessage }, 400);
        }

        const payment = await db.query.payments.findFirst({
          where: eq(payments.externalPaymentId, data.intentId),
        });

        if (!payment) {
          return c.json({ error: "Payment not found" }, 404);
        }

        console.log(
          `[update-payment-row] Updating payment row ${payment.id}. External payment ID: ${data.intentId}`,
          {
            newAmount: data.newAmountCents,
            taxAmount: data.taxAmountCents,
            jurisdiction: data.taxData.jurisdiction,
          }
        );

        await db
          .update(payments)
          .set({
            metadata: {
              ...payment.metadata,
              // Add tax information to metadata for later use in webhook processing
              tax_amount_cents: data.taxAmountCents.toString(),
              tax_jurisdiction: data.taxData.jurisdiction,
              tax_calculation_method: data.taxData.calculationMethod,
              effective_tax_rate: data.taxData.effectiveTaxRate.toString(),
              // Serialize tax line items for later use in webhook
              tax_line_items: JSON.stringify(data.taxData.taxLineItems || []),
            },
          })
          .where(eq(payments.externalPaymentId, data.intentId));

        const stripe = await createStripeClient(paymentProvider);

        // Update the payment intent amount
        const updatedPaymentIntent = await stripe.paymentIntents.update(
          data.intentId,
          {
            amount: data.newAmountCents,
          }
        );

        console.log(
          `[update-payment-row] Successfully updated payment row ${payment.id}. External payment ID: ${data.intentId}`,
          {
            newAmount: updatedPaymentIntent.amount,
            status: updatedPaymentIntent.status,
          }
        );

        return c.json({
          success: true,
          paymentIntent: {
            id: updatedPaymentIntent.id,
            amount: updatedPaymentIntent.amount,
            currency: updatedPaymentIntent.currency,
            status: updatedPaymentIntent.status,
            client_secret: updatedPaymentIntent.client_secret,
          },
          taxData: data.taxData,
        });
      } catch (error) {
        console.error(
          `[update-payment-row] Error updating payment row. External payment ID: ${data.intentId}`,
          error
        );

        // Check if the error is from Stripe and handle specific cases
        if (error instanceof Stripe.errors.StripeError) {
          if (error.code === "resource_missing") {
            return c.json(
              {
                error: "Payment intent not found",
                details: error.message,
              },
              404
            );
          } else if (error.code === "payment_intent_unexpected_state") {
            const errorMessage = `Payment intent cannot be updated in its current state: ${error.message}`;
            console.error(errorMessage);
            return c.json(
              {
                error: errorMessage,
                details: error.message,
              },
              400
            );
          }
        }

        return c.json(
          {
            error: "Failed to update payment intent",
            details: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    }
  )
  .post("/payment-init", zValidator("json", paymentInitSchema), async (c) => {
    const data = c.req.valid("json");
    // Find the merchant ID using the public key
    const apiKeyData = await db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.keyValue, data.lumenPublishableKey),
        eq(apiKeys.keyType, "publishable"),
        isNull(apiKeys.revokedAt)
      ),
    });

    if (!apiKeyData) {
      return c.json({ error: "Invalid Lumen publishable key" }, 404);
    }

    const plan = await db.query.plans.findFirst({
      where: and(
        eq(plans.id, data.planId),
        eq(plans.merchantId, apiKeyData.merchantId),
        isNull(plans.deletedAt)
      ),
    });

    if (!plan) {
      return c.json({ error: "Plan not found" }, 404);
    }

    // Fetch Price data first (read-only operation)
    const price = await db.query.prices.findFirst({
      where: and(
        eq(prices.id, data.priceId),
        eq(prices.merchantId, apiKeyData.merchantId),
        isNull(prices.deletedAt)
      ),
    });

    if (!price) {
      return c.json(
        {
          error:
            "Price not found. Please ensure the price ID is correct and try again.",
        },
        404
      );
    }

    // Handle trial activation if requested

    // Calculate the amount to bill immediately and determine if plan has future billing potential
    let immediateAmountToBill = 0;
    let totalPlanValueExcludingUsage = 0;
    let hasUsageComponentWithNonZeroPrice = false;

    if (price.pricingData && price.pricingData.components) {
      for (const component of price.pricingData.components) {
        if (component.type !== "usage") {
          // Apply minimum-seat logic for per_unit components at checkout as well
          const perUnitMultiplier =
            component.type === "per_unit"
              ? Math.max(
                  1,
                  (component as PerUnitPriceComponentSchemaType).num_seats || 1
                )
              : 1;
          const componentBaseAmount =
            (component.amount_cents || 0) * perUnitMultiplier;

          totalPlanValueExcludingUsage += componentBaseAmount;

          if (component.bill_immediately) {
            immediateAmountToBill += componentBaseAmount;
          }
        } else {
          if (component.unit_cost_cents > 0) {
            hasUsageComponentWithNonZeroPrice = true;
          }
        }
      }
    }

    console.log("immediateAmountToBill", immediateAmountToBill);
    console.log("totalPlanValueExcludingUsage", totalPlanValueExcludingUsage);
    console.log(
      "hasUsageComponentWithNonZeroPrice",
      hasUsageComponentWithNonZeroPrice
    );

    const paymentProvider = await getPaymentProvider(apiKeyData.merchantId);

    // Handle database mutations in a transaction
    try {
      const result = await db.transaction(async (tx) => {
        let customer: typeof customers.$inferSelect;
        let targetCustomerId = data.userId; // Default to userId for backward compatibility

        // Handle organization-based subscription creation for seat plans
        if (data.organizationId) {
          // Look up organization by external ID, create if it doesn't exist
          let organization = await tx.query.customerOrganizations.findFirst({
            where: and(
              eq(customerOrganizations.externalOrgId, data.organizationId),
              eq(customerOrganizations.merchantId, apiKeyData.merchantId),
              isNull(customerOrganizations.deletedAt)
            ),
          });

          if (organization && organization.billingCustomerId) {
            // Use the organization's billing customer for the subscription
            const billingCustomer = await tx.query.customers.findFirst({
              where: and(
                eq(customers.id, organization.billingCustomerId),
                eq(customers.merchantId, apiKeyData.merchantId),
                isNull(customers.deletedAt)
              ),
            });

            if (billingCustomer && billingCustomer.externalCustomerId) {
              targetCustomerId = billingCustomer.externalCustomerId;
              console.log(
                `Using existing organization billing customer: ${organization.billingCustomerId} (external: ${targetCustomerId})`
              );
            } else {
              console.warn(
                `Organization ${organization.id} has invalid billingCustomerId: ${organization.billingCustomerId}`
              );
            }
          } else if (!organization) {
            // Organization doesn't exist - we'll create it after customer creation
            console.log(
              `Organization ${data.organizationId} not found, will create after customer upsert`
            );
          }
        }

        try {
          customer = await upsertCustomer({
            merchantId: apiKeyData.merchantId,
            email: data.customerEmail,
            name: data.customerName,
            businessName: data.businessName,
            externalCustomerId: targetCustomerId,
            billingAddressLine1: data.customerAddress,
            billingAddressLine2: data.customerAddressLine2,
            billingCity: data.customerCity,
            billingPostalCode: data.customerZip,
            billingCountry: data.customerCountry,
            billingStateProvince: data.customerStateProvince,
            taxId: data.taxId,
            tx,
            // dangerouslyAllowCustomerWithoutEmail and dangerouslyAllowSameEmailForDifferentCustomers
            // are not currently part of paymentInitSchema, so they will use default values (false)
          });
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            code: 500,
          };
        }

        console.log("Customer in payment-init:", customer);

        // Check for existing active subscription before initiating payment
        // This prevents duplicate subscriptions when frontend doesn't have subscription check enabled
        const existingActiveSubscription =
          await getActiveSubscriptionForCustomer(
            apiKeyData.merchantId,
            customer.id,
            tx
          );

        if (
          existingActiveSubscription &&
          existingActiveSubscription.planId === data.planId
        ) {
          return {
            error: `You already have an active subscription to this plan (${plan.planName}). Please manage the existing subscription to change billing frequency.`,
            code: 409,
            existingSubscription: {
              stableSubscriptionId:
                existingActiveSubscription.stableSubscriptionId,
              planId: existingActiveSubscription.planId,
              planName: plan.planName,
              status: existingActiveSubscription.status,
            },
          };
        }

        if (!customer.pspCustomerId) {
          if (paymentProvider.isPaymentProviderReady) {
            console.log(
              `Creating new PSP Customer ID in ${paymentProvider.name} for customer ${customer.id}`
            );
            const pspCustomer = await createPspCustomer({
              paymentProvider,
              customer: {
                id: customer.id,
                email: customer.email || "",
                name: customer.name || "",
              },
            });

            if (!pspCustomer) {
              return {
                error: `Failed to create PSP Customer ID in ${paymentProvider.name} for customer ${customer.id}`,
                code: 500,
              };
            }

            try {
              console.log(
                `Updating local customer with PSP Customer ID in ${paymentProvider.name} for customer ${customer.id}`
              );
              const updatedCustomer = await tx
                .update(customers)
                .set({
                  pspCustomerId: pspCustomer.id,
                })
                .where(
                  and(
                    eq(customers.id, customer.id),
                    isNull(customers.deletedAt)
                  )
                )
                .returning();
              customer = updatedCustomer[0]; // Assign the updated customer back
            } catch (error) {
              // We were unable to update the customer object with the correct PSP ID
              // This can lead to really bad problems down the line so we should throw an error
              return {
                error:
                  "Failed to update customer with Stripe ID. Please contact support.",
                code: 500,
              };
            }
          } else {
            console.log(
              "Skipping creating PSP Customer ID: ",
              paymentProvider.statusMessage
            );
          }
        }

        // Create organization if organizationId was provided but not found
        if (data.organizationId) {
          let organization = await tx.query.customerOrganizations.findFirst({
            where: and(
              eq(customerOrganizations.externalOrgId, data.organizationId),
              eq(customerOrganizations.merchantId, apiKeyData.merchantId),
              isNull(customerOrganizations.deletedAt)
            ),
          });

          if (!organization) {
            // Create new organization with this customer as billing customer
            const [createdOrg] = await tx
              .insert(customerOrganizations)
              .values({
                merchantId: apiKeyData.merchantId,
                externalOrgId: data.organizationId,
                billingCustomerId: customer.id,
              })
              .returning();

            console.log(
              `Created new organization ${createdOrg.id} for external org ${data.organizationId} with billing customer ${customer.id}`
            );

            // Update customer to link to the organization with primary role
            await tx
              .update(customers)
              .set({
                customerOrganizationId: createdOrg.id,
                orgRole: "primary",
              })
              .where(eq(customers.id, customer.id));
          } else if (!organization.billingCustomerId) {
            // Update organization to use this customer as billing customer
            await tx
              .update(customerOrganizations)
              .set({ billingCustomerId: customer.id })
              .where(eq(customerOrganizations.id, organization.id));

            // Update customer to link to the organization with primary role
            await tx
              .update(customers)
              .set({
                customerOrganizationId: organization.id,
                orgRole: "primary",
              })
              .where(eq(customers.id, customer.id));

            console.log(
              `Updated organization ${organization.id} billing customer to ${customer.id}`
            );
          }
        }

        const baseMetadata = {
          subscription_id: "",
          merchant_id: apiKeyData.merchantId,
          customer_id: customer.id,
          plan_id: price.planId,
          price_id: price.id,
          platform_user_id: data.userId,
          invoice_id: "",
          ...(data.primarySeatEventTimestamp && {
            primary_seat_event_ts: data.primarySeatEventTimestamp,
          }),
        } as Record<string, string>;

        // Handle trial activation if requested
        if (data.startTrial) {
          console.log("Starting trial activation for plan", price.planId);

          // Look up the corresponding trial plan
          const trialPlan = await tx.query.plans.findFirst({
            where: and(
              eq(plans.trialParentPlanId, price.planId),
              eq(plans.merchantId, apiKeyData.merchantId),
              eq(plans.isTrialPlan, true),
              isNull(plans.deletedAt)
            ),
          });

          if (!trialPlan) {
            return {
              error:
                "Trial not available for this plan. Please contact support.",
              code: 500,
            };
          }

          if (!trialPlan.trialDays) {
            return {
              error: "Trial configuration is invalid. Please contact support.",
              code: 500,
            };
          }

          const trialEndDate = new Date();
          trialEndDate.setDate(trialEndDate.getDate() + trialPlan.trialDays);

          const metadata = {
            ...baseMetadata,
            is_trial: "true",
            trial_end_date: trialEndDate.toISOString(),
            // Pass the original plan/price IDs for the webhook to use for migration
            trial_parent_plan_id: price.planId,
            trial_parent_price_id: price.id,
          };

          const payment = await tx
            .insert(payments)
            .values({
              merchantId: apiKeyData.merchantId,
              externalPaymentId: "",
              amountCents: immediateAmountToBill,
              currency: price.currency,
              status: "pending",
              metadata,
            })
            .returning();

          // For trials, we only create an authorization. The subscription is created in the webhook.
          const paymentAuthorization = await createPspPaymentAuthorization({
            plan,
            amount: null,
            paymentProvider,
            customer: {
              id: customer.id,
              name: customer.name || "",
              email: customer.email || "",
              billingCity: customer.billingCity || "",
              billingCountry: customer.billingCountry || "",
              billingStateProvince: customer.billingStateProvince || "",
              billingAddressLine1: customer.billingAddressLine1 || "",
              billingPostalCode: customer.billingPostalCode || "",
              pspCustomerId: customer.pspCustomerId!,
              taxId: customer.taxId || null,
            },
            currency: price.currency,
            lumenPaymentId: payment[0].id,
          });

          if (!paymentAuthorization) {
            return {
              error: `Failed to create payment authorization in ${paymentProvider.name} for customer ${customer.id}`,
              code: 500,
            };
          }

          // update the payment row with the payment authorization id
          await tx
            .update(payments)
            .set({
              externalPaymentId: paymentAuthorization.id,
            })
            .where(eq(payments.id, payment[0].id));

          return generateReturnObject({
            paymentProvider,
            paymentAuthorization,
          });
        }

        // Calculate final amount including tax
        let finalAmount = immediateAmountToBill;
        if (data.taxData && data.taxData.totalTaxCents > 0) {
          finalAmount += data.taxData.totalTaxCents;
          console.log("Adding tax to payment intent:", {
            subtotal: immediateAmountToBill,
            tax: data.taxData.totalTaxCents,
            total: finalAmount,
            jurisdiction: data.taxData.jurisdiction,
          });
        }

        if (finalAmount > 0) {
          // Immediate billing required - create PaymentIntent
          console.log("Creating payment intent for immediate billing", {
            subtotal: immediateAmountToBill,
            tax: data.taxData?.totalTaxCents || 0,
            total: finalAmount,
          });

          // Add tax metadata to intent metadata
          const metadata = {
            ...baseMetadata,
            ...(data.taxData && {
              tax_amount_cents: data.taxData.totalTaxCents.toString(),
              tax_jurisdiction: data.taxData.jurisdiction,
              tax_calculation_method: data.taxData.calculationMethod,
              effective_tax_rate: data.taxData.effectiveTaxRate.toString(),
              // Serialize tax line items for later use in webhook
              tax_line_items: JSON.stringify(data.taxData.taxLineItems || []),
            }),
          };

          const payment = await tx
            .insert(payments)
            .values({
              merchantId: apiKeyData.merchantId,
              // if dodo - then for the first lumen payment object only, this is externalPaymentId == dodo.subscription_id
              // we don't actually use it though, we use the metadata.dodo_subscription_id instead
              externalPaymentId: "",
              amountCents: finalAmount,
              currency: price.currency,
              status: "pending",
              metadata,
            })
            .returning();

          console.log("created payment row in payment-init", payment[0].id);
          console.log("metadata", payment[0].metadata);

          const paymentAuthorization = await createPspPaymentAuthorization({
            plan,
            amount: finalAmount,
            paymentProvider,
            customer: {
              id: customer.id,
              name: customer.name || "",
              email: customer.email || "",
              billingCity: customer.billingCity || "",
              billingCountry: customer.billingCountry || "",
              billingStateProvince: customer.billingStateProvince || "",
              billingAddressLine1: customer.billingAddressLine1 || "",
              billingPostalCode: customer.billingPostalCode || "",
              pspCustomerId: customer.pspCustomerId!,
              taxId: customer.taxId || null,
            },
            currency: price.currency,
            lumenPaymentId: payment[0].id,
          });

          if (!paymentAuthorization) {
            return {
              error: `Failed to create payment authorization in ${paymentProvider.name} for customer ${customer.id}`,
              code: 500,
            };
          }

          // update the payment row with the payment authorization id
          await tx
            .update(payments)
            .set({
              externalPaymentId: paymentAuthorization.id,
            })
            .where(eq(payments.id, payment[0].id));

          return generateReturnObject({
            paymentProvider,
            paymentAuthorization,
          });
        } else if (
          totalPlanValueExcludingUsage > 0 ||
          hasUsageComponentWithNonZeroPrice
        ) {
          // No immediate billing but plan has future billing potential - create SetupIntent
          console.log("Creating setup intent for future billing");

          const payment = await tx
            .insert(payments)
            .values({
              merchantId: apiKeyData.merchantId,
              externalPaymentId: "",
              amountCents: immediateAmountToBill,
              currency: price.currency,
              status: "pending",
              metadata: baseMetadata,
            })
            .returning();

          const paymentAuthorization = await createPspPaymentAuthorization({
            plan,
            amount: null,
            paymentProvider,
            customer: {
              id: customer.id,
              name: customer.name || "",
              email: customer.email || "",
              billingCity: customer.billingCity || "",
              billingCountry: customer.billingCountry || "",
              billingStateProvince: customer.billingStateProvince || "",
              billingAddressLine1: customer.billingAddressLine1 || "",
              billingPostalCode: customer.billingPostalCode || "",
              pspCustomerId: customer.pspCustomerId!,
              taxId: customer.taxId || null,
            },
            currency: price.currency,
            lumenPaymentId: payment[0].id,
          });

          if (!paymentAuthorization) {
            return {
              error: `Failed to create payment authorization in ${paymentProvider.name} for customer ${customer.id}`,
              code: 500,
            };
          }

          // update the payment row with the payment authorization id
          await tx
            .update(payments)
            .set({
              externalPaymentId: paymentAuthorization.id,
            })
            .where(eq(payments.id, payment[0].id));

          return generateReturnObject({
            paymentProvider,
            paymentAuthorization,
          });
        } else {
          // Pure free plan with no billing potential - create subscription directly
          // using the explicitly requested plan and price (not auto-discovered)
          console.log(
            `Creating subscription directly for pure free plan: ${plan.id} with price: ${price.id}`
          );

          const { subscription, creditGrants } = await createSubscriptionCore({
            merchantId: apiKeyData.merchantId,
            customerId: customer.id,
            planId: plan.id,
            effectivePriceId: price.id,
            startTimestamp: new Date(),
            paymentMethodId: undefined, // No payment method needed for free plans
            dangerouslyAllowMultipleSubscriptions: true,
            tx,
          });

          if (!subscription) {
            return {
              error: "Failed to create subscription",
              code: 500,
            };
          }

          // Get the complete subscription with features
          const subscriptionWithFeatures =
            await tx.query.subscriptions.findFirst({
              where: eq(subscriptions.id, subscription.id),
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
                subscriptionDetails: true,
              },
            });

          if (!subscriptionWithFeatures) {
            return {
              error: "Failed to retrieve created subscription",
              code: 500,
            };
          }

          const invoice = await generateImmediateInvoice({
            merchantId: apiKeyData.merchantId,
            customerId: customer.id,
            subscription,
            price,
            subscriptionDetailsRecords:
              subscriptionWithFeatures.subscriptionDetails,
            firstBillingPeriodStart: new Date(),
            tx,
            taxInfo: undefined,
          });

          console.log(
            `Free subscription created successfully: ${subscription.id} for plan ${plan.planName}`
          );

          return {
            message: "Free subscription created successfully",
            subscription_id: subscription.id,
            invoice_id: invoice?.id,
            credit_grants_created: creditGrants.grantCount,
            plan: {
              id: plan.id,
              name: plan.planName,
              description: plan.planDescription,
            },
          };
        }
      });
      if ("error" in result) {
        console.error("Error in payment-init:", result.error);
        return c.json(result, result.code as ContentfulStatusCode);
      } else {
        return c.json(result);
      }
    } catch (error) {
      console.error("Error in payment-init:", error);
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Unknown error occurred",
        },
        500
      );
    }
  })
  .get(
    "/payment-link/:paymentId",
    zValidator(
      "param",
      z.object({
        paymentId: createPrefixValidator(
          ID_PREFIXES.payment,
          "Invalid payment ID"
        )(z.string()),
      })
    ),
    async (c) => {
      /**
       * Dynamic Payment Link Endpoint
       *
       * This endpoint solves the problem of Stripe checkout sessions expiring after 24 hours.
       * Instead of returning direct checkout session URLs to customers, we return a link to this endpoint.
       * When the customer clicks the link, we:
       * 1. Look up the payment and validate it's still pending
       * 2. Create a fresh checkout session on-demand
       * 3. Redirect to the new checkout session URL
       *
       * This ensures payment links never expire, as we generate a new checkout session each time.
       */
      try {
        const { paymentId } = c.req.valid("param");

        console.log(`Dynamic payment link accessed for payment: ${paymentId}`);

        // Create a fresh checkout session for this payment
        const { checkoutSessionUrl } = await createCheckoutSessionForPayment({
          paymentId,
        });

        console.log(
          `Redirecting to fresh checkout session: ${checkoutSessionUrl}`
        );

        // Redirect the customer to the fresh checkout session
        return c.redirect(checkoutSessionUrl, 302);
      } catch (error) {
        console.error("Error in dynamic payment link:", error);

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";

        if (errorMessage.includes("status: succeeded")) {
          return c.html(
            `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Invoice Already Paid</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  min-height: 100vh;
                  margin: 0;
                  background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
                }
                .container {
                  background: white;
                  padding: 3rem;
                  border-radius: 12px;
                  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                  max-width: 500px;
                  text-align: center;
                }
                .success-icon {
                  font-size: 4rem;
                  margin-bottom: 1rem;
                }
                h1 {
                  color: #38a169;
                  margin-bottom: 1rem;
                }
                p {
                  color: #4a5568;
                  line-height: 1.6;
                  margin-bottom: 1.5rem;
                }
                .success-details {
                  background: #c6f6d5;
                  border-left: 4px solid #38a169;
                  padding: 1rem;
                  margin: 1.5rem 0;
                  text-align: center;
                  font-size: 0.95rem;
                  color: #22543d;
                  font-weight: 500;
                }
                .help-text {
                  font-size: 0.9rem;
                  color: #718096;
                  margin-top: 2rem;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="success-icon">✓</div>
                <h1>Invoice Already Paid</h1>
                <p>Good news! This invoice has already been paid successfully.</p>
                <div class="success-details">
                  Payment completed
                </div>
                <p class="help-text">
                  If you have any questions about this payment, please contact the merchant.
                </p>
              </div>
            </body>
            </html>
            `,
            200
          );
        }

        return c.html(
          `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Link Error</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              }
              .container {
                background: white;
                padding: 3rem;
                border-radius: 12px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                max-width: 500px;
                text-align: center;
              }
              h1 {
                color: #e53e3e;
                margin-bottom: 1rem;
              }
              p {
                color: #4a5568;
                line-height: 1.6;
                margin-bottom: 1.5rem;
              }
              .error-details {
                background: #fed7d7;
                border-left: 4px solid #e53e3e;
                padding: 1rem;
                margin: 1.5rem 0;
                text-align: left;
                font-size: 0.9rem;
                color: #742a2a;
              }
              .help-text {
                font-size: 0.9rem;
                color: #718096;
                margin-top: 2rem;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Payment Link Error</h1>
              <p>We encountered an issue while processing your payment link.</p>
              <div class="error-details">
                ${errorMessage}
              </div>
              <p class="help-text">
                This payment link may have already been used or is no longer valid.
                Please contact the merchant if you need assistance.
              </p>
            </div>
          </body>
          </html>
          `,
          500
        );
      }
    }
  );
