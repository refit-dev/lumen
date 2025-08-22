import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import { subscriptions } from "@lumen/common/schema";
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
} from "@lumen/common/schema";
import {
  createSubscriptionCore,
  generateImmediateInvoice,
  getActiveSubscriptionForCustomer,
  upgradeSubscriptionAndInvoice,
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
} from "../helpers/paymentprovider";
import { createFreeSubscriptionForUser } from "../helpers/create-free-subscription";
import { ContentfulStatusCode } from "hono/utils/http-status";

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

// Map to store active SSE connections, keyed by paymentIntentId
export const sseClients = new Map<string, SSEStreamingApi>();
let id = 0;

// Export for testing purposes
export const exposeForTesting = {
  clearSseClients: () => sseClients.clear(),
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
    console.log(
      `${paymentProvider.name} payment method ${pspPaymentMethodDetails.id} is of type ${pspPaymentMethodDetails.type}, not 'card'. Skipping save.`
    );
    return null;
  } else {
    throw new Error(
      "Cannot get PSP payment method details for payment method type: " +
        pspPaymentMethodDetails.type
    );
  }
}

// Helper function to validate intent metadata
function validateIntentMetadata(
  intentType: "payment" | "setup",
  metadata: Record<string, string>,
  status: string
): { isValid: boolean; error?: string } {
  const {
    customer_id,
    plan_id,
    price_id,
    is_first_payment,
    subscription_id,
    payment_method_id,
    subscription_details_ids_string,
  } = metadata;

  // For recurring billing, we need customer_id and subscription_id to link payment
  if (status === "succeeded" && is_first_payment === "false") {
    if (
      !customer_id ||
      !subscription_id ||
      !payment_method_id ||
      !subscription_details_ids_string
    ) {
      const errorMessage = `Missing required metadata for recurring ${intentType} intent processing`;
      console.error(errorMessage, metadata);
      return {
        isValid: false,
        error: errorMessage,
      };
    }
  } else if (
    status === "succeeded" &&
    (!customer_id || !plan_id || !price_id)
  ) {
    // For initial payment, we need customer_id, plan_id, and price_id
    const errorMessage = `Missing required metadata for ${intentType} intent processing: ${JSON.stringify(metadata, null, 2)}`;
    console.error(errorMessage, metadata);
    return {
      isValid: false,
      error: errorMessage,
    };
  }

  return { isValid: true };
}

// Helper function to send event to SSE client
function sendEventToSSEClient(sseLookupId: string, broadcastData: any): void {
  console.log("sseLookupId", sseLookupId);
  const clientStream = sseClients.get(sseLookupId);

  if (clientStream) {
    console.log("Found clientStream");
    try {
      clientStream.writeSSE({
        data: JSON.stringify(broadcastData),
        event: "stripe_event", // Use a specific event name for Stripe webhooks
        id: crypto.randomUUID(),
      });
      console.log(
        `Sent Stripe event type ${broadcastData.type} to SSE client for ID: ${sseLookupId}`
      );
    } catch (err) {
      console.error(`Failed to send to SSE client for ID ${sseLookupId}:`, err);
    }
  } else {
    console.log(`No active SSE client found for ID: ${sseLookupId}`);
  }
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
  payment: typeof payments.$inferSelect & {
    metadata: Record<string, string>;
  }
): Promise<void> {
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
        isImmediatePayment: true,
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

  // Trial-specific metadata
  const trial_parent_plan_id = metadata.trial_parent_plan_id;
  const trial_parent_price_id = metadata.trial_parent_price_id;

  return await db.transaction(async (tx) => {
    let paymentMethodId: string | null = null;
    let datetimeAtTransactionStart = new Date();

    try {
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
        });

      if (!subscription) {
        throw new Error("Failed to create trial subscription");
      }

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
}

// Process payment intent failure from webhook
async function processPaymentFailure(
  payment: typeof payments.$inferSelect & {
    metadata: Record<string, string>;
  }
) {
  const {
    payment_method_id,
    invoice_id,
    is_first_payment,
    last_payment_error,
  } = payment.metadata;

  console.log(
    "Processing payment failure for paymentIntent",
    payment.externalPaymentId
  );

  return await db.transaction(async (tx) => {
    if (
      is_first_payment === "true" ||
      is_first_payment === undefined ||
      is_first_payment === null
    ) {
      console.log("First-time payment failed, no payment record to update");
      return { status: "failed", firstTimePayment: true };
    }

    // Update the payment record status to "failed"
    await tx
      .update(payments)
      .set({
        status: "failed",
        errorMessage: last_payment_error?.message || "Payment failed",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    // Update invoice status back to "issued" (not paid)
    if (invoice_id) {
      await tx
        .update(invoices)
        .set({
          status: "issued", // Revert to issued status
        })
        .where(eq(invoices.id, invoice_id));
    }

    // Update payment method failure information
    if (payment_method_id) {
      await tx
        .update(paymentMethods)
        .set({
          lastFailedAt: new Date(),
          failureReason: last_payment_error?.message || "Payment failed",
        })
        .where(eq(paymentMethods.id, payment_method_id));
    }

    console.info(
      `Processed payment failure for payment ${payment.id}, invoice ${invoice_id || "N/A"}`
    );

    return { status: "failed", payment };
  });
}

// Handle payment intent events from stripe AND dodo payments
async function handlePaymentEvent(
  payment: typeof payments.$inferSelect & {
    metadata: Record<string, string | number | boolean>;
  }
) {
  console.log("Processing payment event:", {
    paymentId: payment.id,
    status: payment.status,
    externalPaymentId: payment.externalPaymentId,
  });

  const { is_first_payment } = payment.metadata;

  // Validate required metadata
  const metadataValidation = validateIntentMetadata(
    "payment",
    payment.metadata as Record<string, string>,
    payment.status
  );

  if (!metadataValidation.isValid) {
    console.error("Payment metadata validation failed:", {
      paymentId: payment.id,
      error: metadataValidation.error,
    });
    throw new Error(metadataValidation.error);
  }

  if (payment.status === "succeeded") {
    console.log("Payment succeeded, determining payment type:", {
      paymentId: payment.id,
      isTrialUpgrade: payment.metadata.is_trial_upgrade,
      isFirstPayment: is_first_payment,
    });

    // Check for trial upgrades first
    if (payment.metadata.is_trial_upgrade === "true") {
      console.log("Processing trial upgrade payment:", payment.id);
      return await processTrialUpgrade(
        payment as typeof payments.$inferSelect & {
          metadata: Record<string, string>;
        }
      );
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
  } else if (payment.status === "canceled") {
    // Payment intent was canceled
    // For other non-success statuses like 'requires_payment_method', 'processing', etc.,
    // we don't cancel the subscription since they may still complete successfully
    console.log("Payment was canceled:", {
      paymentId: payment.id,
      externalPaymentId: payment.externalPaymentId,
    });
    return { status: "canceled" };
  } else if (
    payment.status === "requires_payment_method" &&
    payment.metadata.last_payment_error
  ) {
    // Payment failed and requires a new payment method
    console.log("Payment failed and requires new payment method:", {
      paymentId: payment.id,
      error: payment.metadata.last_payment_error,
    });
    return await processPaymentFailure(
      payment as typeof payments.$inferSelect & {
        metadata: Record<string, string>;
      }
    );
  }

  console.log("Payment event processed with status:", {
    paymentId: payment.id,
    status: payment.status,
  });
  return { status: payment.status };
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

  if (payment.status === "succeeded") {
    console.log("Setup intent succeeded, processing:", payment.id);
    return await processSetupIntent(payment);
  } else if (payment.status === "canceled") {
    // Setup intent was canceled
    console.log(`Setup intent ${payment.id} was canceled`);
    return { status: "canceled" };
  }

  console.log("Setup event processed with status:", {
    paymentId: payment.id,
    status: payment.status,
  });
  return { status: payment.status };
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
      sseClients.set(paymentIntentId, stream);

      // Send initial connection-established event
      await stream.writeSSE({
        data: JSON.stringify({
          type: "connection_established",
          paymentIntentId,
        }),
        event: "message",
        id: crypto.randomUUID(),
      });

      // Periodic ping to keep connection alive
      const intervalId = setInterval(() => {
        void stream.writeSSE({
          data: "ping",
          event: "ping",
          id: crypto.randomUUID(),
        });
      }, 5000); // CRITICAL: NEEDS TO BE LESS THAN 10 SECONDS (BUN has 10 sec timeout)

      // Cleanup on client disconnect
      stream.onAbort(() => {
        console.log(
          `SSE client disconnected for paymentIntentId: ${paymentIntentId}`
        );
        sseClients.delete(paymentIntentId);
        clearInterval(intervalId);
      });

      // Prevent handler from completing—await client disconnect
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  })
  .post("/webhook-dodo/:merchant_id", async (c) => {
    const merchantId = c.req.param("merchant_id");
    console.log("[DEBUG] Received Dodo webhook for merchant", merchantId);

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

      // Process different event types
      if (webhookPayload.type === "payment.succeeded") {
        const dodoPayment = webhookPayload.data as DodoPayments.Payment;
        if (!dodoPayment.subscription_id) {
          throw new Error(
            `No subscription ID found for Dodo payment: ${dodoPayment.payment_id}`
          );
        }
        // this works fine for both first time payment and subsequent payments
        const lumenPaymentId = webhookPayload.data.metadata.lumen_payment_id;
        let payment = await db.query.payments.findFirst({
          where: eq(payments.id, lumenPaymentId),
        });

        if (!payment) {
          console.error(
            `No Lumen payment ID found for Dodo payment metadata. Dodo payment ID: ${dodoPayment.payment_id}`
          );
          return c.json({ received: true });
        }

        if (!payment.metadata) {
          console.error(
            `No metadata found for Lumen payment ID: ${lumenPaymentId}`
          );
          return c.json({ received: true });
        }

        if (dodoPayment.status === "succeeded") {
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

          // Get the updated payment record to ensure we have the invoice ID
          payment = await db.query.payments.findFirst({
            where: eq(payments.id, payment.id),
          });

          if (!payment?.invoiceId) {
            throw new Error("No invoice ID found for payment");
          }

          // Post-process the Dodo payment: update tax info, invoice totals, and handle PDF
          await postProcessDodoPayment({
            dodoPayment,
            paymentId: payment.id,
            invoiceId: payment.invoiceId,
            merchantId,
          });
        } else {
          // TODO: Handle Failures
          console.error(
            `Dodo payment ${dodoPayment.payment_id} failed with status ${dodoPayment.status}`
          );
          return c.json({ received: true });
        }
      } else {
        console.log(
          `Unhandled Dodo webhook event type: ${webhookPayload.type}`
        );
      }

      return c.json({ received: true });
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
    const event = (await c.req.json()) as Stripe.Event;

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
        return c.json({ error: errorMessage }, 400);
      }

      const obj = event.data.object as SupportedEvent;

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
        if (obj.metadata?.is_checkout_session === "true") {
          // do not retry. it's the PI from the checkout session. This will be handled in the checkout.session.success flow
          return c.json({ error: errorMessage }, 200);
        } else {
          return c.json({ error: errorMessage }, 404);
        }
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

      // Process different event types
      if (event.type.startsWith("payment_intent.")) {
        payment.metadata = {
          ...payment.metadata,
          ...((obj as Stripe.PaymentIntent).last_payment_error
            ? {
                last_payment_error: (obj as Stripe.PaymentIntent)
                  .last_payment_error,
              }
            : {}),
        };
        await handlePaymentEvent(
          payment as typeof payments.$inferSelect & {
            // metadata not being null is not automatically inferred by the type
            metadata: Record<string, string>;
          }
        );
      } else if (event.type.startsWith("setup_intent.")) {
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

      // Send event notification to connected clients
      const sseLookupId = getSSELookupIdFromEvent(event);
      if (sseLookupId) {
        sendEventToSSEClient(sseLookupId, broadcastData);
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

    const paymentProvider = await getPaymentProvider(apiKeyData.merchantId);
    if (!paymentProvider.isPaymentProviderReady) {
      console.error(paymentProvider.statusMessage);
      return c.json({ error: paymentProvider.statusMessage }, 400);
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

    // Handle database mutations in a transaction
    try {
      const result = await db.transaction(async (tx) => {
        let customer: typeof customers.$inferSelect;
        try {
          customer = await upsertCustomer({
            merchantId: apiKeyData.merchantId,
            email: data.customerEmail,
            name: data.customerName,
            businessName: data.businessName,
            externalCustomerId: data.userId,
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
        if (!customer.pspCustomerId) {
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
                and(eq(customers.id, customer.id), isNull(customers.deletedAt))
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
        }

        const baseMetadata = {
          subscription_id: "",
          merchant_id: apiKeyData.merchantId,
          customer_id: customer.id,
          plan_id: price.planId,
          price_id: price.id,
          platform_user_id: data.userId,
          invoice_id: "",
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
          console.log("Creating subscription directly for pure free plan");

          const [result, statusCode] = await createFreeSubscriptionForUser(
            {
              merchantId: apiKeyData.merchantId,
              userId: data.userId,
              customerEmail: data.customerEmail,
              customerName: data.customerName,
              billingAddressLine1: data.customerAddress,
              billingAddressLine2: data.customerAddressLine2,
              billingCity: data.customerCity,
              billingPostalCode: data.customerZip,
              billingCountry: data.customerCountry,
              taxId: data.taxId,
            },
            tx
          );

          if (statusCode !== 200) {
            return {
              ...result,
              code: statusCode,
            };
          }

          console.log("Free subscription created successfully", result);
          // At this point we know it's a success result but we need this to make TS happy
          if (
            "message" in result &&
            "subscription" in result &&
            "credit_grants_created" in result
          ) {
            return {
              message: result.message,
              subscription_id: result.subscription.id,
              invoice_id: result.invoice?.id, // Free subscriptions don't generate invoices
              credit_grants_created: result.credit_grants_created,
              plan: result.plan, // Include plan details for consistency with createFreeSubscriptionForUser
            };
          }

          // This should never happen
          return {
            error: "Unexpected response format",
            code: 500,
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
  });
