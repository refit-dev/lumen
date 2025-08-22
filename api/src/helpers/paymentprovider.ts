import { db } from "../db/client";
import { eq, and, isNull } from "drizzle-orm";
import { customers, stripe, dodo, plans } from "@lumen/common/schema";
import { decryptField, EncryptedField } from "./encryption";
import Stripe from "stripe";
import DodoPayments from "dodopayments";
import { logger } from "./logging";
import {
  payments,
  paymentMethods,
  subscriptionDetails,
  subscriptions,
} from "@lumen/common/schema";
import { invoices, invoiceLineItems } from "@lumen/common/schema";
import { env } from "../env";
import fs from "fs";
import { Webhook } from "standardwebhooks";
import { sendEmail } from "./emails";
import { getSecretOrEnvVar } from "./secrets";
import { slackLog } from "./slack";
import { merchants } from "@lumen/common/schema";
import { getObjectStorageUrl, uploadFile, generatePresignedUrl } from "./s3";
import type { TransactionType } from "./";
import { configure, tasks } from "@trigger.dev/sdk/v3";
import type { sendInvoiceEmailJob } from "../../trigger/jobs/sendInvoiceEmail";
import type { InvoiceCompleteAPI } from "./invoices";
import { formatInvoiceWithDetailsToCompleteAPI } from "./invoices";

// Configure Trigger.dev for server-side triggering
configure({
  secretKey: (await getSecretOrEnvVar({
    secretNameTemplate: "lumen/*/trigger-secret-key",
    envVariableName: "TRIGGER_SECRET_KEY",
    throwOnDevError: true,
    throwOnStagingOrProdError: true,
  })) as string,
});

export type PaymentProvider =
  | {
      name: "stripe";
      stripeIntegration: {
        publicKey: string;
        secretKey: EncryptedField;
        webhookSecret: EncryptedField;
      };
      dodoIntegration: null;
      isPaymentProviderReady: true;
      statusMessage: string;
    }
  | {
      name: "dodo";
      stripeIntegration: null;
      dodoIntegration: {
        secretKey: EncryptedField;
        webhookSecret: EncryptedField;
        environment: "test" | "live";
      };
      isPaymentProviderReady: true;
      statusMessage: string;
    }
  | {
      name: "stripe";
      stripeIntegration:
        | {
            secretKey: EncryptedField;
            webhookSecret: null;
            publicKey: string;
          }
        | {
            secretKey: null;
            webhookSecret: EncryptedField;
            publicKey: string;
          };
      dodoIntegration: null;
      isPaymentProviderReady: false;
      statusMessage: string;
    }
  | {
      name: "dodo";
      stripeIntegration: null;
      dodoIntegration:
        | {
            secretKey: EncryptedField;
            webhookSecret: null;
          }
        | {
            secretKey: null;
            webhookSecret: EncryptedField;
          };
      isPaymentProviderReady: false;
      statusMessage: string;
    }
  | {
      name: null;
      stripeIntegration: null;
      dodoIntegration: null;
      isPaymentProviderReady: false;
      statusMessage: string;
    };

const transformToUsdIfNotSupported = (currency: string) => {
  const supportedCurrencies = ["USD", "INR"];
  const currencyUpper = currency.toUpperCase();
  if (supportedCurrencies.includes(currencyUpper)) {
    return currencyUpper as DodoPayments.Currency;
  }
  return "USD" as DodoPayments.Currency;
};

export const getPaymentProvider = async (
  merchantId: string
): Promise<PaymentProvider> => {
  const stripeConfig = await db.query.stripe.findFirst({
    where: and(eq(stripe.merchantId, merchantId), isNull(stripe.deletedAt)),
  });
  if (stripeConfig) {
    const isPaymentProviderReady = !!(
      stripeConfig.secretKey &&
      stripeConfig.webhookSecret &&
      stripeConfig.publicKey
    );
    let statusMessage = "Stripe integration is ready";
    if (!isPaymentProviderReady) {
      statusMessage = "Stripe integration is not ready.";
      if (!stripeConfig.secretKey) {
        statusMessage += " Secret key is not set.";
      }
      if (!stripeConfig.webhookSecret) {
        statusMessage += " Webhook secret is not set.";
      }
      if (!stripeConfig.publicKey) {
        statusMessage += " Public key is not set.";
      }
    }
    return {
      name: "stripe",
      stripeIntegration: stripeConfig,
      dodoIntegration: null,
      isPaymentProviderReady,
      statusMessage,
    } as PaymentProvider;
  }
  const dodoConfig = await db.query.dodo.findFirst({
    where: and(eq(dodo.merchantId, merchantId), isNull(dodo.deletedAt)),
  });
  if (dodoConfig) {
    const isPaymentProviderReady = !!(
      dodoConfig.secretKey && dodoConfig.webhookSecret
    );
    let statusMessage = "Dodo integration is ready";
    if (!isPaymentProviderReady) {
      statusMessage = "Dodo integration is not ready.";
      if (!dodoConfig.secretKey) {
        statusMessage += " Secret key is not set.";
      }
      if (!dodoConfig.webhookSecret) {
        statusMessage += " Webhook secret is not set.";
      }
    }
    return {
      name: "dodo",
      stripeIntegration: null,
      dodoIntegration: dodoConfig,
      isPaymentProviderReady,
      statusMessage,
    } as PaymentProvider;
  }

  return {
    name: null,
    stripeIntegration: null,
    dodoIntegration: null,
    isPaymentProviderReady: false,
    statusMessage: "No payment provider configured",
  };
};

export const createStripeClient = async (
  paymentProvider: PaymentProvider
): Promise<Stripe> => {
  if (paymentProvider.name !== "stripe") {
    throw new Error(
      `Error creating Stripe Client: Payment provider is ${paymentProvider.name}`
    );
  }
  if (!paymentProvider.isPaymentProviderReady) {
    throw new Error(paymentProvider.statusMessage);
  }
  const secretKey = await decryptField(
    paymentProvider.stripeIntegration!.secretKey as EncryptedField
  );
  return new Stripe(secretKey, {
    apiVersion: "2025-02-24.acacia",
  });
};

export const createDodoClient = async (paymentProvider: PaymentProvider) => {
  if (paymentProvider.name !== "dodo") {
    throw new Error(
      `Error creating Dodo Client: Payment provider is ${paymentProvider.name}`
    );
  }
  if (!paymentProvider.isPaymentProviderReady) {
    throw new Error(paymentProvider.statusMessage);
  }
  const secretKey = await decryptField(
    paymentProvider.dodoIntegration.secretKey as EncryptedField
  );
  return new DodoPayments({
    bearerToken: secretKey,
    environment:
      paymentProvider.dodoIntegration.environment === "live"
        ? "live_mode"
        : "test_mode",
  });
};

const getPspCustomerId = async (
  paymentProvider: PaymentProvider,
  customer: typeof customers.$inferSelect
): Promise<string> => {
  if (paymentProvider.name === "stripe") {
    const stripe = await createStripeClient(paymentProvider);
    const stripeCustomer = await stripe.customers.create({
      name: customer.name || undefined,
      email: customer.email || undefined,
      // For info purposes only, we only rely on payments.metadata
      metadata: {
        customer_id: customer.id,
        merchant_id: customer.merchantId,
      },
    });
    return stripeCustomer.id;
  } else if (paymentProvider.name === "dodo") {
    const client = await createDodoClient(paymentProvider);
    const dodoCustomer = await client.customers.create({
      name: customer.name || "",
      email: customer.email || "",
    });
    return dodoCustomer.customer_id;
  }
  throw new Error("No payment provider configured");
};

const createPspPayment = async ({
  paymentProvider,
  currency,
  customer,
  invoice,
  paymentMethod,
  subscriptionId,
  lumenPaymentId,
  metadata,
}: {
  paymentProvider: PaymentProvider;
  currency: string;
  customer: typeof customers.$inferSelect;
  invoice: typeof invoices.$inferSelect;
  paymentMethod: typeof paymentMethods.$inferSelect;
  subscriptionId?: string;
  lumenPaymentId: string;
  metadata: Record<string, string>;
}): Promise<{
  id: string;
  status: string;
}> => {
  if (paymentProvider.name === "stripe") {
    const stripe = await createStripeClient(paymentProvider);
    // Create and confirm payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: invoice.totalAmountCents,
      currency,
      customer: customer.pspCustomerId!,
      payment_method: paymentMethod.externalPspPaymentMethodId!,
      off_session: true,
      confirm: true,
      metadata: {
        ...metadata, // For info purposes only, we only rely on payments.metadada
        lumen_payment_id: lumenPaymentId,
      },
    });
    return { id: paymentIntent.id, status: paymentIntent.status };
  } else if (paymentProvider.name === "dodo") {
    if (!subscriptionId) {
      const errorMessage = "Subscription ID is required for Dodo payments";
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
    try {
      const client = await createDodoClient(paymentProvider);

      const charge = await client.subscriptions.charge(
        paymentMethod.externalPspPaymentMethodId!,
        {
          product_description: `Payment for invoice ${invoice.customerInvoiceNumber || invoice.id}.`,
          product_price: invoice.totalAmountCents,
          metadata: {
            lumen_payment_id: lumenPaymentId,
          },
        }
      );
      return { id: charge.payment_id, status: "succeeded" };
    } catch (e) {
      logger.error(
        `Error creating Dodo payment for invoice ${invoice.id}: ${e instanceof Error ? e.message : JSON.stringify(e)}`
      );
      throw e;
    }
  }
  throw new Error("No payment provider configured");
};

export const processPayment = async ({
  context,
  subscriptionId,
  subDetails,
  invoice,
  invoiceId,
  payment,
}: {
  context: any;
  subscriptionId: string;
  subDetails: any[];
  invoice: any;
  invoiceId: string;
  payment: any;
}) => {
  try {
    if (
      !context.paymentMethod ||
      !context.paymentMethod.externalPspPaymentMethodId
    ) {
      throw new Error("No active payment method found for customer");
    }

    const paymentProvider = await getPaymentProvider(invoice.merchantId);

    if (!paymentProvider.isPaymentProviderReady) {
      throw new Error(paymentProvider.statusMessage);
    }

    // Ensure we have a PSP customer ID
    if (!context.customer.pspCustomerId) {
      const customerWithPspId = await ensurePspCustomerExists({
        paymentProvider,
        customerId: context.customer.id,
        merchantId: context.customer.merchantId,
      });

      context.customer.pspCustomerId = customerWithPspId.pspCustomerId;
    }

    const metadata = {
      customer_id: context.customer.id,
      merchant_id: context.customer.merchantId,
      subscription_id: subscriptionId,
      subscription_details_ids_string: subDetails
        .map((d) => d.subscriptionDetailsId)
        .join(","),
      payment_method_id: context.paymentMethod.id,
      is_first_payment: "false",
      invoice_id: invoiceId,
    };

    const pspPayment = await createPspPayment({
      paymentProvider,
      currency: context.currency,
      customer: context.customer,
      invoice,
      paymentMethod: context.paymentMethod,
      subscriptionId,
      lumenPaymentId: payment.id,
      metadata, // For info purposes only, we only rely on payments.metadada
    });

    if (pspPayment.status !== "succeeded") {
      throw new Error(`Payment failed: ${pspPayment.status}`);
    }

    logger.info(
      `Created ${paymentProvider.name} payment ${pspPayment.id} for customer ${context.customer.id}`
    );

    // Update the payment record with the external payment ID in a new transaction
    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          externalPaymentId: pspPayment.id,
          metadata,
        })
        .where(eq(payments.id, payment.id));

      // Update payment method's last used timestamp
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
        paymentIntentId: pspPayment.id,
        invoiceId: invoiceId,
        paymentId: payment.id,
        status: "succeeded",
        message: "Payment successfully processed",
      },
    };
  } catch (paymentProcessingError) {
    // Update payment status to failed in a new transaction
    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          status: "failed",
          errorMessage:
            paymentProcessingError instanceof Error
              ? paymentProcessingError.message
              : "Unknown error",
        })
        .where(eq(payments.id, payment.id));
    });

    // Don't re-throw - return failure response instead
    logger.error(
      `Payment failed for customer ${context.customer.id}: ${paymentProcessingError}`
    );

    return {
      type: "success", // Transaction was successful, but payment failed
      response: {
        success: false,
        invoiceId: invoiceId,
        paymentId: payment.id,
        status: "failed",
        message:
          paymentProcessingError instanceof Error
            ? paymentProcessingError.message
            : "Payment processing failed",
      },
    };
  }
};

/**
 * Ensures a PSP customer exists for the given customer, creating one if needed
 * Returns the customer data with pspCustomerId populated
 */
export const ensurePspCustomerExists = async ({
  paymentProvider,
  customerId,
  merchantId,
}: {
  paymentProvider: PaymentProvider;
  customerId: string;
  merchantId: string;
}): Promise<typeof customers.$inferSelect & { pspCustomerId: string }> => {
  // Get customer data from database
  const customerData = await db.query.customers.findFirst({
    where: and(
      eq(customers.id, customerId),
      eq(customers.merchantId, merchantId),
      isNull(customers.deletedAt)
    ),
  });

  if (!customerData) {
    throw new Error(`Customer not found: ${customerId}`);
  }

  // Validate required customer information
  if (!customerData.name || !customerData.email) {
    throw new Error(
      `Customer information incomplete. Name: ${customerData.name ? "✓" : "missing"}, Email: ${customerData.email ? "✓" : "missing"}`
    );
  }

  // Check if customer already has PSP customer ID
  if (customerData.pspCustomerId) {
    console.log(
      `Using existing ${paymentProvider.name} customer: ${customerData.pspCustomerId}`
    );
    return { ...customerData, pspCustomerId: customerData.pspCustomerId };
  }

  // Create new PSP customer
  console.log(
    `Creating new ${paymentProvider.name} customer for customer ${customerId}`
  );

  const pspCustomer = await createPspCustomer({
    paymentProvider,
    customer: {
      id: customerData.id,
      email: customerData.email,
      name: customerData.name,
    },
  });

  if (!pspCustomer) {
    throw new Error(`Failed to create ${paymentProvider.name} customer`);
  }

  // Update customer record with PSP customer ID
  await db
    .update(customers)
    .set({
      pspCustomerId: pspCustomer.id,
    })
    .where(eq(customers.id, customerId));

  console.log(
    `Created new ${paymentProvider.name} customer: ${pspCustomer.id}`
  );

  return { ...customerData, pspCustomerId: pspCustomer.id };
};

export const createOneTimePaymentLink = async ({
  invoice,
  currency,
  merchantId,
  customerId,
  lumenPaymentId,
}: {
  invoice: typeof invoices.$inferSelect & {
    subscription: typeof subscriptions.$inferSelect & {
      plan: typeof plans.$inferSelect;
    };
    merchant?: typeof merchants.$inferSelect;
    customer?: typeof customers.$inferSelect;
  };
  currency: string;
  merchantId: string;
  customerId: string;
  lumenPaymentId: string;
}): Promise<{
  checkoutSessionId?: string;
  checkoutSessionUrl?: string;
}> => {
  const paymentProvider = await getPaymentProvider(merchantId);

  if (!paymentProvider.isPaymentProviderReady) {
    logger.error(paymentProvider.statusMessage);
    throw new Error(paymentProvider.statusMessage);
  }

  // Ensure PSP customer exists for both Stripe and Dodo
  const customerWithPspId = await ensurePspCustomerExists({
    paymentProvider,
    customerId,
    merchantId,
  });

  console.log("Customer with PSP ID", customerWithPspId);

  if (paymentProvider.name === "stripe") {
    const stripe = await createStripeClient(paymentProvider);

    try {
      // Create a simple single line item for the total amount due
      // The detailed breakdown is already in the invoice that gets emailed to the customer
      const checkoutLineItems = [
        {
          price_data: {
            currency: currency,
            product_data: {
              name: `Invoice Payment - ${invoice.customerInvoiceNumber || invoice.id}`,
              description: `Payment for invoice ${invoice.customerInvoiceNumber || invoice.id}. See invoice email for detailed breakdown.`,
            },
            unit_amount: invoice.totalAmountCents, // Total amount including tax
          },
          quantity: 1,
        },
      ];

      // Get merchant information for success URL
      const merchantRecord = await db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
      });

      // Determine success and cancel URLs
      const baseUrl = env.CORS_ORIGIN; // UI URL

      const successUrl =
        merchantRecord?.websiteUrl && env.NODE_ENV !== "development"
          ? `${merchantRecord.websiteUrl}?payment=success&invoice=${invoice.id}`
          : `${baseUrl}/payment/success?invoice=${invoice.id}`;

      const cancelUrl =
        merchantRecord?.websiteUrl && env.NODE_ENV !== "development"
          ? `${merchantRecord.websiteUrl}?payment=cancelled&invoice=${invoice.id}`
          : `${baseUrl}/payment/cancelled?invoice=${invoice.id}`;

      // Create Stripe checkout session with customer and setup_future_usage for payment method saving
      const checkoutSession = await stripe.checkout.sessions.create({
        line_items: checkoutLineItems,
        mode: "payment",
        customer: customerWithPspId.pspCustomerId, // Link to Stripe customer
        success_url: successUrl,
        cancel_url: cancelUrl,
        payment_intent_data: {
          setup_future_usage: "off_session", // Save payment method for future use
          metadata: {
            is_checkout_session: "true", // needed to distinguish the normal PIs vs Checkout Session PIs
            lumen_payment_id: lumenPaymentId,
          },
        },
      });

      console.log("checkoutSession", checkoutSession);

      // Ensure we have a checkout session URL
      if (!checkoutSession.url) {
        throw new Error("Failed to create checkout session: no URL returned");
      }

      logger.info(
        `Created checkout session for invoice ${invoice.id}: ${checkoutSession.url}`
      );

      return {
        checkoutSessionId: checkoutSession.id,
        checkoutSessionUrl: checkoutSession.url,
      };
    } catch (stripeError) {
      logger.error(
        `Failed to create payment link for invoice ${invoice.id}:`,
        stripeError
      );
      throw new Error(
        `Failed to create payment link: ${stripeError instanceof Error ? stripeError.message : "Unknown Stripe error"}`
      );
    }
  } else if (paymentProvider.name === "dodo") {
    console.log("Creating Dodo payment link for invoice", invoice.id);
    const client = await createDodoClient(paymentProvider);

    try {
      // Validate required billing information for tax calculations (Dodo-specific)
      const missingBillingFields = [];
      if (!customerWithPspId.billingCountry)
        missingBillingFields.push("country");
      if (!customerWithPspId.billingCity) missingBillingFields.push("city");
      if (!customerWithPspId.billingAddressLine1)
        missingBillingFields.push("address line 1");
      if (!customerWithPspId.billingPostalCode)
        missingBillingFields.push("postal code");

      if (missingBillingFields.length > 0) {
        throw new Error(
          `Customer billing information incomplete. Missing required fields for tax calculation: ${missingBillingFields.join(", ")}`
        );
      }

      // For US customers, state is required for tax calculations
      if (
        customerWithPspId.billingCountry === "US" &&
        !customerWithPspId.billingStateProvince
      ) {
        throw new Error(
          "Customer billing state is required for US tax calculations"
        );
      }

      console.log("Creating Dodo subscription");
      // Create Dodo subscription with customer information
      const subscription = await client.subscriptions.create({
        payment_link: true,
        on_demand:
          invoice.totalAmountCents > 0
            ? {
                mandate_only: false,
                product_price: invoice.totalAmountCents,
                product_currency:
                  currency.toUpperCase() as DodoPayments.Currency,
              }
            : { mandate_only: true },
        customer: {
          customer_id: customerWithPspId.pspCustomerId,
        },
        billing: {
          city: customerWithPspId.billingCity!,
          country:
            customerWithPspId.billingCountry! as DodoPayments.CountryCode,
          state:
            customerWithPspId.billingCountry === "US"
              ? customerWithPspId.billingStateProvince!
              : customerWithPspId.billingStateProvince || "",
          street: customerWithPspId.billingAddressLine1!,
          zipcode: customerWithPspId.billingPostalCode!,
        },
        tax_id: customerWithPspId.taxId || null,
        // Create a product for this specific invoice payment
        product_id: invoice.subscription?.plan.pspPlanId!,
        billing_currency: transformToUsdIfNotSupported(currency),
        metadata: {
          lumen_payment_id: lumenPaymentId,
        },
        quantity: 1,
      });

      if (!subscription.payment_link) {
        throw new Error("Failed to create Dodo payment link: no URL returned");
      }

      logger.info(
        `Created Dodo payment link for invoice ${invoice.id}: ${subscription.payment_link}`
      );

      try {
        // Send payment link email to the customer since Dodo skips invoice PDF/email
        const merchantRecord = await db.query.merchants.findFirst({
          where: eq(merchants.id, merchantId),
        });

        const merchantName =
          merchantRecord?.displayName ||
          merchantRecord?.legalName ||
          "Your Service Provider";

        const resendApiKey =
          env.NODE_ENV === "production"
            ? await getSecretOrEnvVar({
                secretNameTemplate: "lumen/*/resend-api-key",
                envVariableName: "RESEND_API_KEY",
                throwOnDevError: false,
                throwOnStagingOrProdError: true,
              })
            : null;

        const invoiceNumber = invoice.customerInvoiceNumber || invoice.id;

        if (env.NODE_ENV === "production") {
          if (!resendApiKey) {
            logger.error(
              "RESEND_API_KEY is required to send payment link emails in production"
            );
          } else {
            const emailBody = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>Invoice Payment</h2>
                <p>Dear ${customerWithPspId.name},</p>
                <div style="background-color: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 20px 0;">
                  <h3 style="color: #92400e; margin-top: 0;">Payment Required</h3>
                  <p style="margin: 10px 0; color: #78716c;"><strong>To complete your payment, please click the secure link below:</strong></p>
                  <div style="text-align: center; margin: 20px 0;">
                    <a href="${subscription.payment_link}" style="display: inline-block; background-color: #2563eb; color: white; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: bold; font-size: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">Pay Invoice Online</a>
                  </div>
                  <p style="font-size: 14px; color: #6b7280; margin-bottom: 0;">
                    This secure payment link will take you to our hosted checkout page where you can pay with a card.
                  </p>
                </div>
                <p>Invoice: <strong>${invoiceNumber}</strong></p>
                <p>Best regards,<br>${merchantName}</p>
              </div>
            `;

            const result = await sendEmail({
              to: customerWithPspId.email!,
              subject: `Invoice payment from ${merchantName}`,
              body: emailBody,
              from: "noreply@getlumen.dev",
              resendApiKey,
            });

            if (!("success" in result && result.success)) {
              logger.error(
                `Failed to send payment link email for invoice ${invoice.id}: ${"error" in result ? String(result.error) : "unknown error"}`
              );
            } else {
              logger.info(
                `Sent payment link email to ${customerWithPspId.email} for invoice ${invoice.id}`
              );
            }
          }
        } else if (env.NODE_ENV === "staging") {
          await slackLog(
            `Would send payment link email (env: ${env.NODE_ENV})\nInvoice: ${invoiceNumber}\nCustomer: ${customerWithPspId.name} <${customerWithPspId.email}>\nMerchant: ${merchantName}\nLink: ${subscription.payment_link}`
          );
        } else if (env.NODE_ENV === "development") {
          console.log("================");
          console.log("Would send payment link email (env: development)");
          console.log("Invoice: ", invoiceNumber);
          console.log(
            "Customer: ",
            customerWithPspId.name,
            customerWithPspId.email
          );
          console.log("Merchant: ", merchantName);
          console.log("Link: ", subscription.payment_link);
          console.log("================");
        } else {
          console.log("Unhandled environment: ", env.NODE_ENV);
        }
      } catch (emailError) {
        logger.error(
          `Error while sending Dodo payment link email for invoice ${invoice.id}: ${emailError instanceof Error ? emailError.message : String(emailError)}`
        );
      }

      return {
        checkoutSessionId: subscription.subscription_id,
        checkoutSessionUrl: subscription.payment_link,
      };
    } catch (dodoError) {
      const errorMessage = `Failed to create Dodo payment link for invoice ${invoice.id}: ${dodoError instanceof Error ? dodoError.message : JSON.stringify(dodoError)}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  } else {
    throw new Error(
      "No payment provider configured for one-time payment links"
    );
  }
};

/**
 * Charges an existing invoice to the customer
 * Used for immediate billing of already created invoices
 */
export const chargeInvoice = async ({
  invoiceId,
}: {
  invoiceId: string;
}): Promise<{
  success: boolean;
  message: string;
  paymentIntentId?: string;
  paymentId?: string;
  status?: string;
}> => {
  try {
    // Get the invoice with related data
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
      with: {
        customer: true,
        merchant: true,
        subscription: {
          with: {
            plan: true,
          },
        },
      },
    });

    if (!invoice) {
      return {
        success: false,
        message: "Invoice not found",
      };
    }

    if (!invoice.subscription || !invoice.subscription.plan) {
      return {
        success: false,
        message: "Invoice has no subscription or plan",
      };
    }

    if (invoice.status === "paid") {
      return {
        success: true,
        message: "Invoice already paid",
        status: "paid",
      };
    }

    if (invoice.totalAmountCents === 0) {
      // Mark zero amount invoices as paid
      await db
        .update(invoices)
        .set({ status: "paid", paidDate: new Date() })
        .where(eq(invoices.id, invoiceId));

      return {
        success: true,
        message: "Zero amount invoice marked as paid",
        status: "paid",
      };
    }

    // Get customer's payment method
    const paymentMethod = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, invoice.customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });

    if (!paymentMethod) {
      // Create payment record for tracking
      const [payment] = await db
        .insert(payments)
        .values({
          merchantId: invoice.merchantId,
          invoiceId: invoiceId,
          paymentMethodId: null,
          amountCents: invoice.totalAmountCents,
          currency: invoice.currency,
          externalPaymentId: "",
          status: "pending",
          metadata: {
            invoice_id: invoice.id,
            customer_id: invoice.customerId,
            merchant_id: invoice.merchantId,
            ...(invoice.subscriptionId
              ? { subscription_id: invoice.subscriptionId }
              : {}),
            source: "manual_subscription_billing",
          },
        })
        .returning();

      // Create payment link for customers without payment methods
      const { checkoutSessionId, checkoutSessionUrl } =
        await createOneTimePaymentLink({
          invoice: {
            // TS can't infer that invoice.subscription is not null
            ...invoice,
            subscription: invoice.subscription!,
          },
          currency: invoice.currency,
          merchantId: invoice.merchantId,
          customerId: invoice.customerId,
          lumenPaymentId: payment.id,
        });

      // Update payment record with checkout session ID and URL
      await db
        .update(payments)
        .set({
          externalPaymentId: checkoutSessionId,
          metadata: {
            ...payment.metadata,
            checkoutSessionId,
            checkoutSessionUrl,
          },
        })
        .where(eq(payments.id, payment.id));

      // Update invoice with payment link
      await db
        .update(invoices)
        .set({
          notes: invoice.notes
            ? `${invoice.notes}. Payment required: Please complete your payment online at ${checkoutSessionUrl}`
            : `Payment required: Please complete your payment online at ${checkoutSessionUrl}`,
        })
        .where(eq(invoices.id, invoiceId));

      return {
        success: true,
        message: `Payment link created: ${checkoutSessionUrl}`,
        paymentId: payment.id,
        status: "payment_link_created",
      };
    } else {
      // don't need to explicity make an else branch because of early return above but keeping it for clarity
      // Create payment record
      const [payment] = await db
        .insert(payments)
        .values({
          merchantId: invoice.merchantId,
          invoiceId: invoiceId,
          paymentMethodId: paymentMethod.id,
          amountCents: invoice.totalAmountCents,
          currency: invoice.currency,
          status: "pending",
        })
        .returning();

      // Fetch subscription details if subscriptionId present to populate payment intent metadata
      let subDetails = [] as { subscriptionDetailsId: string }[];
      if (invoice.subscriptionId) {
        try {
          subDetails = await db
            .select({ subscriptionDetailsId: subscriptionDetails.id })
            .from(subscriptionDetails)
            .where(
              eq(subscriptionDetails.subscriptionId, invoice.subscriptionId)
            );
        } catch (err) {
          console.error(
            `Failed to fetch subscription details for invoice ${invoice.id}:`,
            err
          );
        }
      }

      const context = {
        customer: invoice.customer,
        paymentMethod,
        merchantId: invoice.merchantId,
        currency: invoice.currency,
      };

      const paymentResult = await processPayment({
        context,
        subscriptionId: invoice.subscriptionId || "",
        subDetails,
        invoice,
        invoiceId,
        payment,
      });

      if (paymentResult && paymentResult.response.success) {
        return {
          success: true,
          message: "Invoice charged successfully",
          paymentIntentId: paymentResult.response.paymentIntentId,
          paymentId: payment.id,
          status: paymentResult.response.status,
        };
      } else {
        return {
          success: false,
          message: `Payment failed: ${paymentResult?.response?.message || "Unknown payment error"}`,
          paymentId: payment.id,
          status: paymentResult?.response?.status || "failed",
        };
      }
    }
  } catch (error) {
    console.error("Error charging invoice:", error);
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
};

/**
 * Charges a customer a specific amount using their stored payment method
 * This is a generic abstraction that works with any PSP (Stripe, Dodo, etc.)
 */
export const chargeCustomerWithAmount = async ({
  customerId,
  merchantId,
  amountCents,
  currency,
  description,
  targetPlan,
  metadata = {},
}: {
  customerId: string;
  merchantId: string;
  amountCents: number;
  currency: string;
  description: string;
  targetPlan: typeof plans.$inferSelect;
  metadata?: Record<string, string>;
}): Promise<{
  success: boolean;
  pspPaymentId?: string;
  status?: string;
  message: string;
  error?: string;
}> => {
  try {
    // Get customer and their payment method
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.id, customerId),
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt)
      ),
    });

    if (!customer) {
      return {
        success: false,
        message: "Customer not found",
        error: "customer_not_found",
      };
    }

    // Get customer's active payment method
    const paymentMethod = await db.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.customerId, customerId),
        isNull(paymentMethods.deletedAt)
      ),
      orderBy: (paymentMethods, { desc }) => [desc(paymentMethods.lastUsedAt)],
    });

    if (!paymentMethod || !paymentMethod.externalPspPaymentMethodId) {
      return {
        success: false,
        message: "No stored payment method found for customer",
        error: "missing_payment_method",
      };
    }

    // Get payment provider configuration
    const paymentProvider = await getPaymentProvider(merchantId);

    if (!paymentProvider.isPaymentProviderReady) {
      logger.error(paymentProvider.statusMessage);
      throw new Error(paymentProvider.statusMessage);
    }

    if (paymentProvider.name === "stripe") {
      const stripe = await createStripeClient(paymentProvider);

      // Ensure customer has Stripe customer ID using generic function
      if (!customer.pspCustomerId) {
        const customerWithPspId = await ensurePspCustomerExists({
          paymentProvider,
          customerId,
          merchantId,
        });

        customer.pspCustomerId = customerWithPspId.pspCustomerId;
      }

      // Create payment record first
      const paymentRecord = await db
        .insert(payments)
        .values({
          merchantId,
          paymentMethodId: paymentMethod.id,
          amountCents,
          currency,
          status: "pending",
          externalPaymentId: "",
          metadata: {
            ...metadata,
            customer_id: customerId,
            merchant_id: merchantId,
          },
        })
        .returning();
      if (!paymentRecord || paymentRecord.length === 0) {
        throw new Error("Failed to create payment record");
      }

      // Create and confirm PaymentIntent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: currency,
        customer: customer.pspCustomerId,
        payment_method: paymentMethod.externalPspPaymentMethodId,
        description,
        metadata: {
          // For info purposes only, we only rely on payments.metadada
          customer_id: customerId,
          merchant_id: merchantId,
          lumen_payment_id: paymentRecord[0].id,
          ...metadata,
        },
      });

      // Update payment record with successful charge
      await db
        .update(payments)
        .set({
          externalPaymentId: paymentIntent.id,
        })
        .where(eq(payments.id, paymentRecord[0].id));

      await stripe.paymentIntents.confirm(paymentIntent.id, {
        off_session: true,
      });

      // Update payment method's last used timestamp
      await db
        .update(paymentMethods)
        .set({ lastUsedAt: new Date() })
        .where(eq(paymentMethods.id, paymentMethod.id));

      if (paymentIntent.status === "succeeded") {
        return {
          success: true,
          pspPaymentId: paymentIntent.id,
          status: paymentIntent.status,
          message: "Payment successful",
        };
      } else if (paymentIntent.status === "requires_action") {
        return {
          success: false,
          pspPaymentId: paymentIntent.id,
          status: paymentIntent.status,
          message: "Payment requires additional authentication",
          error: "requires_action",
        };
      } else {
        return {
          success: false,
          pspPaymentId: paymentIntent.id,
          status: paymentIntent.status,
          message: `Payment failed with status: ${paymentIntent.status}`,
          error: paymentIntent.status,
        };
      }
    } else if (paymentProvider.name === "dodo") {
      try {
        const client = await createDodoClient(paymentProvider);

        if (!targetPlan?.pspPlanId) {
          return {
            success: false,
            message:
              "Plan doesn't have a pspPlanId pointing to Dodo Subscription ID",
            error: "plan_not_configured_for_dodo",
          };
        }

        // Ensure customer has Dodo customer ID using generic function
        if (!customer.pspCustomerId) {
          const customerWithPspId = await ensurePspCustomerExists({
            paymentProvider,
            customerId,
            merchantId,
          });

          customer.pspCustomerId = customerWithPspId.pspCustomerId;
        }

        // Create payment record first
        const [payment] = await db
          .insert(payments)
          .values({
            merchantId,
            paymentMethodId: paymentMethod.id,
            amountCents,
            currency,
            status: "pending",
            metadata: {
              ...metadata,
              customer_id: customerId,
              merchant_id: merchantId,
            },
          })
          .returning();

        const charge = await client.subscriptions.charge(
          paymentMethod.externalPspPaymentMethodId!,
          {
            product_description: description,
            product_price: amountCents,
            metadata: {
              customer_id: customerId,
              merchant_id: merchantId,
              payment_id: payment.id,
              lumen_payment_id: payment.id,
              ...metadata,
            },
          }
        );

        // Update payment record with successful charge
        await db
          .update(payments)
          .set({
            externalPaymentId: charge.payment_id,
          })
          .where(eq(payments.id, payment.id));

        // Update payment method's last used timestamp
        await db
          .update(paymentMethods)
          .set({ lastUsedAt: new Date() })
          .where(eq(paymentMethods.id, paymentMethod.id));

        return {
          success: true,
          pspPaymentId: charge.payment_id,
          status: "succeeded",
          message: "Payment successful",
        };
      } catch (error) {
        logger.error(
          `Error charging Dodo customer: ${error instanceof Error ? error.message : JSON.stringify(error)}`
        );
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Dodo payment failed" + JSON.stringify(error),
          error: "dodo_charge_failed",
        };
      }
    } else {
      return {
        success: false,
        message: "No payment provider configured for merchant",
        error: "no_payment_provider",
      };
    }
  } catch (error) {
    logger.error("Error charging customer with amount:", error);
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
      error: "internal_error",
    };
  }
};

export const verifyPaymentProviderWebhook = async ({
  c,
  paymentProvider,
  client,
  rawBody,
}: {
  c: any;
  paymentProvider: PaymentProvider;
  client: any | undefined;
  rawBody: string;
}): Promise<boolean> => {
  if (!paymentProvider.isPaymentProviderReady) {
    throw new Error(
      "Error verifying webhook: " + paymentProvider.statusMessage
    );
  }

  if (paymentProvider.name === "stripe") {
    try {
      // Get the Stripe secret key for this merchant
      let stripeClient: Stripe | undefined = client;

      if (!stripeClient) {
        stripeClient = await createStripeClient(paymentProvider);
      }
      const signature = c.req.header("stripe-signature");
      if (!signature) {
        return false;
      }
      let webhookSecret = await decryptField(
        paymentProvider.stripeIntegration.webhookSecret as EncryptedField
      );
      if (env.NODE_ENV === "development") {
        try {
          const devSecret = fs
            .readFileSync("/tmp/test_webhook_secret.txt", "utf-8")
            .trim();
          if (devSecret) {
            webhookSecret = devSecret;
          }
        } catch (e) {
          // If file doesn't exist or can't be read, fallback to DB value
          console.error(
            "Error reading test webhook secret for dev environment:",
            e
          );
        }
      }

      await stripeClient.webhooks.constructEventAsync(
        rawBody,
        signature,
        webhookSecret
      );

      return true;
    } catch (e) {
      console.error((e as Error).message);
      return false;
    }
  } else if (paymentProvider.name === "dodo") {
    const webhookSecret = await decryptField(
      paymentProvider.dodoIntegration.webhookSecret as EncryptedField
    );

    // Extract webhook headers following Standard Webhooks specification
    const webhookHeaders = {
      "webhook-id": (c.req.header("webhook-id") || "") as string,
      "webhook-signature": (c.req.header("webhook-signature") || "") as string,
      "webhook-timestamp": (c.req.header("webhook-timestamp") || "") as string,
    };

    console.log("[DEBUG] Webhook headers:", webhookHeaders);

    // Verify all required headers are present
    if (
      !webhookHeaders["webhook-id"] ||
      !webhookHeaders["webhook-signature"] ||
      !webhookHeaders["webhook-timestamp"]
    ) {
      throw new Error(
        "Missing required webhook headers (webhook-id, webhook-signature, or webhook-timestamp)"
      );
    }
    try {
      const webhook = new Webhook(webhookSecret);
      await webhook.verify(rawBody, webhookHeaders);

      return true;
    } catch (error) {
      logger.error(
        `Dodo webhook verification failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`
      );
      return false;
    }
  } else {
    return false;
  }
};

const createPspClient = async (paymentProvider: PaymentProvider) => {
  try {
    if (paymentProvider.name === "stripe") {
      return await createStripeClient(paymentProvider);
    } else if (paymentProvider.name === "dodo") {
      return await createDodoClient(paymentProvider);
    }
  } catch (e) {
    logger.error(
      `Error creating PSP client for payment provider ${paymentProvider.name}: ${e instanceof Error ? e.message : JSON.stringify(e)}`
    );
    throw e;
  }
};

export const getPspPaymentMethodDetailsFromPayment = async ({
  paymentProvider,
  pspPaymentId,
  pspClient,
}: {
  paymentProvider: PaymentProvider;
  pspPaymentId: string;
  pspClient?: Stripe | DodoPayments;
}): Promise<{
  id: string;
  type: string;
  customerId: string;
  cardLastFour?: string;
  cardBrand?: string;
  cardExpiryMonth?: number;
  cardExpiryYear?: number;
  cardIssuerCountry?: string;
  cardNetwork?: string;
  metadata?: Record<string, string>;
}> => {
  const client = pspClient || (await createPspClient(paymentProvider));

  if (paymentProvider.name === "stripe") {
    const stripe = client as Stripe;
    let intent: Stripe.PaymentIntent | Stripe.SetupIntent | undefined;
    if (pspPaymentId.startsWith("pi_")) {
      intent = await stripe.paymentIntents.retrieve(pspPaymentId);
    } else if (pspPaymentId.startsWith("seti_")) {
      intent = await stripe.setupIntents.retrieve(pspPaymentId);
    } else if (pspPaymentId.startsWith("cs_")) {
      const session = await stripe.checkout.sessions.retrieve(pspPaymentId);
      intent = await stripe.paymentIntents.retrieve(
        session.payment_intent as string
      );
    } else {
      throw new Error(`Invalid payment ID: ${pspPaymentId}`);
    }
    const paymentMethod = await stripe.paymentMethods.retrieve(
      intent.payment_method as string
    );
    if (!paymentMethod) {
      throw new Error(
        `No payment method found for Stripe Payment Intent ID ${pspPaymentId}`
      );
    }
    return {
      id: paymentMethod.id,
      type: paymentMethod.type,
      customerId: intent.customer as string,
      cardLastFour: paymentMethod.card?.last4,
      cardBrand: paymentMethod.card?.brand,
      cardNetwork: paymentMethod.card?.brand,
      cardExpiryMonth: paymentMethod.card?.exp_month,
      cardExpiryYear: paymentMethod.card?.exp_year,
      cardIssuerCountry: paymentMethod.card?.country || undefined,
      metadata: paymentMethod.metadata as Record<string, string> | undefined,
    };
  } else if (paymentProvider.name === "dodo") {
    const dodo = client as DodoPayments;
    const payment = await dodo.payments.retrieve(pspPaymentId);
    const dodoSubscriptionId = payment.subscription_id;

    if (!dodoSubscriptionId) {
      throw new Error(
        `No subscription ID found for Dodo payment ${pspPaymentId}`
      );
    }

    // DodoPayments API returns payment details directly
    return {
      // in Dodo, there is no Payment Method - instead the subscription ID is used for all on-demand charges
      id: dodoSubscriptionId,
      type: "card",
      customerId: payment.customer.customer_id,
      cardLastFour: payment.card_last_four || undefined,
      cardBrand: payment.payment_method_type || undefined, // stores "visa", "mastercard", etc.
      cardExpiryMonth: undefined, // not provided by Dodo
      cardExpiryYear: undefined, // not provided by Dodo
      cardIssuerCountry: payment.card_issuing_country || undefined,
      cardNetwork: payment.card_network || undefined,
      metadata: payment.metadata || undefined,
    };
  } else {
    throw new Error(`${paymentProvider.name} is not a valid payment provider`);
  }
};

export const issuePspRefund = async ({
  merchantId,
  payment,
  amountCents,
}: {
  merchantId: string;
  payment: typeof payments.$inferSelect;
  amountCents?: number;
}): Promise<{
  id: string;
  status: string;
  amountCents: number;
}> => {
  const refundableRemaining =
    (payment.amountCents || 0) - (payment.refundedAmountCents || 0);
  const refundAmount =
    amountCents && amountCents > 0 ? amountCents : refundableRemaining;

  if (refundAmount <= 0) {
    throw new Error("Nothing to refund or invalid refund amount");
  }

  const paymentProvider = await getPaymentProvider(merchantId);

  if (!paymentProvider.isPaymentProviderReady) {
    throw new Error(paymentProvider.statusMessage);
  }

  if (!payment.externalPaymentId) {
    throw new Error("Payment is missing external PSP payment ID");
  }

  if (paymentProvider.name === "stripe") {
    const stripe = await createStripeClient(paymentProvider);
    const refund = await stripe.refunds.create({
      payment_intent: payment.externalPaymentId,
      amount: refundAmount,
    });
    return {
      id: refund.id,
      status: refund.status || "succeeded",
      amountCents: refund.amount || refundAmount,
    };
  } else if (paymentProvider.name === "dodo") {
    const client = await createDodoClient(paymentProvider);
    const { items } = await client.payments.retrieveLineItems(
      payment.externalPaymentId
    );
    const res = await client.refunds.create({
      payment_id: payment.externalPaymentId,
      items: [
        {
          item_id: items[0].items_id,
          amount: refundAmount,
        },
      ],
    });
    const externalId = res.refund_id;
    const status = res.status;
    const returnedAmount = res.amount || 0;
    return { id: externalId, status, amountCents: returnedAmount };
  }

  throw new Error("No payment provider configured");
};

export const createPspCustomer = async ({
  paymentProvider,
  customer,
}: {
  paymentProvider: PaymentProvider;
  customer: {
    id: string;
    email: string;
    name: string;
  };
}): Promise<{
  id: string;
  name: string;
  email: string;
} | null> => {
  if (paymentProvider.name === "stripe") {
    const stripe = await createStripeClient(paymentProvider);
    const stripeCustomer = await stripe.customers.create({
      name: customer.name || undefined,
      email: customer.email || undefined,
      metadata: {
        customerId: customer.id,
      },
    });
    return {
      id: stripeCustomer.id,
      name: stripeCustomer.name || "",
      email: stripeCustomer.email || "",
    };
  } else if (paymentProvider.name === "dodo") {
    if (!customer.name || !customer.email) {
      throw new Error(
        `Customer information incomplete. Name: ${customer.name ? "✓" : "missing"}, Email: ${customer.email ? "✓" : "missing"}`
      );
    }

    const dodo = await createDodoClient(paymentProvider);
    const dodoCustomer = await dodo.customers.create({
      name: customer.name,
      email: customer.email,
    });
    return {
      id: dodoCustomer.customer_id,
      name: dodoCustomer.name,
      email: dodoCustomer.email,
    };
  }
  return null;
};

type PaymentAuthorization =
  | {
      id: string;
      intentId: string;
      client_secret: string | null;
      object: "setup_intent" | "payment_intent";
    }
  | {
      id: string;
      payment_link: string;
    };

export const createPspPaymentAuthorization = async ({
  amount,
  paymentProvider,
  customer,
  currency,
  plan,
  lumenPaymentId,
}: {
  amount: number | null;
  paymentProvider: PaymentProvider;
  customer: {
    id: string;
    name: string | null;
    email: string | null;
    billingCity: string | null;
    billingCountry: string | null;
    billingStateProvince: string | null;
    billingAddressLine1: string | null;
    billingPostalCode: string | null;
    pspCustomerId: string;
    taxId: string | null;
  };
  currency: string;
  plan: typeof plans.$inferSelect;
  lumenPaymentId: string;
}): Promise<PaymentAuthorization | null> => {
  if (paymentProvider.name === "stripe") {
    const stripe = await createStripeClient(paymentProvider);
    let intent: Stripe.SetupIntent | Stripe.PaymentIntent;
    if (amount && amount > 0) {
      intent = await stripe.paymentIntents.create({
        amount,
        currency,
        customer: customer.pspCustomerId,
        payment_method_types: ["card"],
        setup_future_usage: "off_session",
        metadata: {
          lumen_payment_id: lumenPaymentId,
        },
      });
    } else {
      intent = await stripe.setupIntents.create({
        customer: customer.pspCustomerId,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: {
          lumen_payment_id: lumenPaymentId,
        },
      });
    }
    return {
      id: intent.id,
      intentId: intent.id,
      client_secret: intent.client_secret,
      object: intent.object,
    };
  } else if (paymentProvider.name === "dodo") {
    if (!plan.pspPlanId) {
      throw new Error(
        "Plan doesn't have a pspPlanId pointing to Dodo Subscription ID"
      );
    }
    const missingBillingFields = [];
    if (!customer.billingCountry) missingBillingFields.push("country");
    if (!customer.billingCity) missingBillingFields.push("city");
    if (!customer.billingAddressLine1)
      missingBillingFields.push("address line 1");
    if (!customer.billingPostalCode) missingBillingFields.push("postal code");

    if (missingBillingFields.length > 0) {
      throw new Error(
        `Customer billing information incomplete. Missing required fields for tax calculation: ${missingBillingFields.join(", ")}`
      );
    }

    if (customer.billingCountry === "US" && !customer.billingStateProvince) {
      throw new Error(
        "Customer billing state is required for US tax calculations"
      );
    }
    const client = await createDodoClient(paymentProvider);
    const subscription = await client.subscriptions.create({
      payment_link: true,
      on_demand:
        amount && amount > 0
          ? {
              mandate_only: false,
              product_price: amount,
              product_currency: currency.toUpperCase() as DodoPayments.Currency,
            }
          : { mandate_only: true },
      customer: {
        customer_id: customer.pspCustomerId,
      },
      billing: {
        city: customer.billingCity!,
        country: customer.billingCountry as DodoPayments.CountryCode,
        state:
          customer.billingCountry === "US"
            ? customer.billingStateProvince!
            : customer.billingStateProvince || "",
        street: customer.billingAddressLine1!,
        zipcode: customer.billingPostalCode!,
      },
      tax_id: customer.taxId,
      product_id: plan.pspPlanId,
      billing_currency: transformToUsdIfNotSupported(currency),
      quantity: 1,
      metadata: {
        lumen_payment_id: lumenPaymentId,
      },
    });
    if (!subscription) {
      throw new Error(
        `Failed to create subscription in ${paymentProvider.name} for customer ${customer.id}`
      );
    }
    return {
      id: subscription.subscription_id,
      payment_link: subscription.payment_link!,
    };
  }

  return null;
};

export const generateReturnObject = ({
  paymentProvider,
  paymentAuthorization,
}: {
  paymentProvider: PaymentProvider;
  paymentAuthorization: PaymentAuthorization;
}) => {
  if (
    paymentProvider.name === "stripe" &&
    "client_secret" in paymentAuthorization
  ) {
    return {
      clientSecret: paymentAuthorization.client_secret,
      stripePublishableKey: paymentProvider.stripeIntegration!.publicKey,
      intentId: paymentAuthorization.id,
      intentType: paymentAuthorization.object,
    };
  } else if (
    paymentProvider.name === "dodo" &&
    "payment_link" in paymentAuthorization
  ) {
    return {
      id: paymentAuthorization.id,
      success: true,
      payment_link: paymentAuthorization.payment_link,
    };
  } else {
    return {
      error: `Invalid payment authorization: ${JSON.stringify(paymentAuthorization)}`,
      code: 500,
    };
  }
};

/**
 * Post-processes a successful Dodo payment by:
 * 1. Extracting tax information from Dodo payment
 * 2. Creating/updating tax line items in the invoice
 * 3. Updating invoice subtotal, tax, and total amounts
 * 4. Fetching and uploading the PDF receipt
 * 5. Updating the invoice with PDF URL
 */
export const postProcessDodoPayment = async ({
  dodoPayment,
  paymentId,
  invoiceId,
  merchantId,
}: {
  dodoPayment: DodoPayments.Payment;
  paymentId: string;
  invoiceId: string;
  merchantId: string;
}): Promise<void> => {
  let emailPayload: {
    invoice: InvoiceCompleteAPI;
    fileName: string;
    pdfUrl: string;
    invoiceNumber: string;
    pdfBuffer?: Buffer;
  } | null = null;

  await db.transaction(async (tx) => {
    console.log(
      `Post-processing Dodo payment ${dodoPayment.payment_id} for invoice ${invoiceId}`
    );

    // 1. Extract tax information from Dodo payment
    const taxAmountCents = dodoPayment.tax || 0;
    const subtotalCents = dodoPayment.total_amount - taxAmountCents;

    console.log("Extracted tax information from Dodo payment:", {
      totalAmount: dodoPayment.total_amount,
      taxAmount: taxAmountCents,
      subtotal: subtotalCents,
    });

    // 2. Find existing tax line item for this invoice
    const existingTaxLineItem = await tx.query.invoiceLineItems.findFirst({
      where: and(
        eq(invoiceLineItems.invoiceId, invoiceId),
        eq(invoiceLineItems.type, "tax")
      ),
    });

    // 3. Create or update tax line item
    if (existingTaxLineItem && taxAmountCents > 0) {
      // Update existing tax line item
      await tx
        .update(invoiceLineItems)
        .set({
          description: "Sales Tax / VAT (Dodo Payments)",
          subtotalCents: taxAmountCents,
          taxMetadata: {
            taxAuthority: "Unknown",
            taxType: "sales_tax",
            jurisdiction: "Unknown", // Dodo doesn't expose billing address in payment object
            fullDescription: `Tax calculated by Dodo Payments for payment ${dodoPayment.payment_id}`,
          },
        })
        .where(eq(invoiceLineItems.id, existingTaxLineItem.id));

      console.log(`Updated existing tax line item ${existingTaxLineItem.id}`);
    } else if (!existingTaxLineItem && taxAmountCents > 0) {
      // Create new tax line item
      await tx.insert(invoiceLineItems).values({
        invoiceId,
        type: "tax",
        description: "Sales Tax / VAT (Dodo Payments)",
        subtotalCents: taxAmountCents,
        taxMetadata: {
          taxAuthority: "Unknown",
          taxType: "sales_tax",
          jurisdiction: "Unknown", // Dodo doesn't expose billing address in payment object
          fullDescription: `Tax calculated by Dodo Payments for payment ${dodoPayment.payment_id}`,
        },
      });

      console.log("Created new tax line item");
    }

    // 4. Fetch and upload PDF receipt
    const paymentProvider = await getPaymentProvider(merchantId);
    const client = await createDodoClient(paymentProvider);

    const effectiveTaxRate =
      subtotalCents > 0
        ? String((taxAmountCents / subtotalCents).toFixed(4))
        : "0";

    await tx
      .update(invoices)
      .set({
        subtotalCents,
        taxAmountCents,
        totalAmountCents: dodoPayment.total_amount,
        taxJurisdiction: null, // Dodo doesn't expose billing address in payment object
        taxCalculationMethod: "dodo_payments_mor",
        effectiveTaxRate,
      })
      .where(eq(invoices.id, invoiceId));

    console.log(
      `Successfully updated invoice: ${invoiceId}`,
      `Tax information - totalAmountCents: ${dodoPayment.total_amount},`,
      `subtotalCents: ${subtotalCents},`,
      `taxAmountCents: ${taxAmountCents},`,
      `effectiveTaxRate: ${effectiveTaxRate}`
    );

    try {
      console.log(`Fetching PDF for Dodo payment ${dodoPayment.payment_id}`);
      const pdf = await client.invoices.payments.retrieve(
        dodoPayment.payment_id
      );
      const pdfBuffer = Buffer.from(await pdf.arrayBuffer());

      const fileName = `invoices/${invoiceId}.pdf`;
      await uploadFile(fileName, pdfBuffer, "application/pdf");
      const pdfUrl = getObjectStorageUrl(fileName);
      // Create a short-lived presigned URL for Trigger.dev to fetch the PDF
      const presignedPdfUrl = await generatePresignedUrl(fileName, 60 * 30); // 30 minutes

      // 5. Update invoice with PDF URL and tax information
      await tx
        .update(invoices)
        .set({
          pdfUrl,
        })
        .where(eq(invoices.id, invoiceId));

      console.log(
        `Successfully updated invoice ${invoiceId} with PDF URL: ${pdfUrl}`
      );

      // Fetch invoice with required relations for composing the email payload
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

      if (
        invoiceWithDetails &&
        invoiceWithDetails.customer &&
        invoiceWithDetails.merchant
      ) {
        const pdfInvoice =
          formatInvoiceWithDetailsToCompleteAPI(invoiceWithDetails);

        const invoiceNumber =
          invoiceWithDetails.customerInvoiceNumber &&
          invoiceWithDetails.customerInvoiceNumber.trim()
            ? invoiceWithDetails.customerInvoiceNumber.trim()
            : `INV-${invoiceWithDetails.id.substring(0, 8)}`;

        emailPayload = {
          invoice: pdfInvoice,
          fileName,
          pdfUrl: presignedPdfUrl,
          invoiceNumber,
          pdfBuffer,
        };
      }
    } catch (pdfError) {
      console.error(
        `Failed to fetch/upload PDF for Dodo payment ${dodoPayment.payment_id}:`,
        pdfError
      );
      // Don't throw - PDF processing failure shouldn't fail the entire payment
    }

    console.log(
      `Successfully post-processed Dodo payment ${dodoPayment.payment_id} for invoice ${invoiceId}`
    );
  });

  // Trigger the email job outside the transaction
  try {
    if (emailPayload) {
      await tasks.trigger<typeof sendInvoiceEmailJob>(
        "send-invoice-email",
        emailPayload
      );
    }
  } catch (emailTriggerError) {
    logger.error(
      `Failed to trigger sendInvoiceEmailJob for invoice ${invoiceId}`,
      {
        invoiceId,
        error:
          emailTriggerError instanceof Error
            ? emailTriggerError.message
            : String(emailTriggerError),
      }
    );
  }
};
