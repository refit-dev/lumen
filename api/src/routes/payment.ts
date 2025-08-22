import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/client";
import {
  payments,
  paymentMethods,
  paymentMethodInsertSchemaReq,
  invoices,
  customers,
  subscriptions,
  plans,
} from "@lumen/common/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import {
  getPaymentProvider,
  getPspPaymentMethodDetailsFromPayment,
} from "../helpers/paymentprovider";

export const paymentMethodsRoute = new Hono()
  // Get all payment methods for a customer
  .get(
    "/:paymentMethodId",
    zValidator("param", z.object({ paymentMethodId: z.string() })),
    async (c) => {
      const { paymentMethodId } = c.req.valid("param");
      const merchantId = c.get("merchant")!.id;

      const paymentMethod = await db
        .select()
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.id, paymentMethodId),
            eq(paymentMethods.merchantId, merchantId),
            isNull(paymentMethods.deletedAt)
          )
        );

      if (!paymentMethod) {
        return c.json({ error: "Payment method not found" }, 404);
      }

      return c.json({ paymentMethod });
    }
  )

  .post("/", zValidator("json", paymentMethodInsertSchemaReq), async (c) => {
    const merchantId = c.get("merchant")!.id;
    try {
      const paymentMethod = await db
        .insert(paymentMethods)
        .values({
          ...c.req.valid("json"),
          merchantId,
        })
        .returning();
      return c.json(paymentMethod[0], 201);
    } catch (error) {
      console.error("Error creating payment method:", error);
      return c.json({ error: "Failed to create payment method" }, 500);
    }
  });

export const paymentsRouter = new Hono()
  .get("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");
    const merchantId = c.get("merchant")!.id;

    const paymentRaw = await db
      .select({
        id: payments.id,
        merchantId: payments.merchantId,
        invoiceId: payments.invoiceId,
        paymentMethodId: payments.paymentMethodId,
        externalPaymentId: payments.externalPaymentId,
        amountCents: payments.amountCents,
        currency: payments.currency,
        status: payments.status,
        errorMessage: payments.errorMessage,
        refundedAmountCents: payments.refundedAmountCents,
        refundStatus: payments.refundStatus,
        createdAt: payments.createdAt,
        updatedAt: payments.updatedAt,
        // PSP provider from stored payment method if available
        paymentProvider: paymentMethods.provider,
        // Add invoice information
        customerInvoiceNumber: invoices.customerInvoiceNumber,
        // Add customer information
        customerName: customers.name,
        // Add subscription information
        subscriptionId: subscriptions.id,
        subscriptionStableId: subscriptions.stableSubscriptionId,
        // Add plan information
        planId: plans.id,
        planName: plans.planName,
        // Additional customer details
        customerId: customers.id,
        customerEmail: customers.email,
        customerBillingCountry: customers.billingCountry,
        customerBillingCity: customers.billingCity,
        customerBillingAddressLine1: customers.billingAddressLine1,
        customerBillingAddressLine2: customers.billingAddressLine2,
        customerBillingPostalCode: customers.billingPostalCode,
        customerPhone: customers.phoneNumber,
        customerTaxId: customers.taxId,
        // Invoice details
        invoiceCustomerInvoiceNumber: invoices.customerInvoiceNumber,
        invoiceTotalAmountCents: invoices.totalAmountCents,
        invoiceCurrency: invoices.currency,
        invoiceStatus: invoices.status,
        invoiceIssueDate: invoices.issueDate,
        invoiceDueDate: invoices.dueDate,
        invoicePdfUrl: invoices.pdfUrl,
      })
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.merchantId, merchantId)))
      .leftJoin(invoices, eq(payments.invoiceId, invoices.id))
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
      .leftJoin(plans, eq(subscriptions.planId, plans.id))
      .leftJoin(paymentMethods, eq(payments.paymentMethodId, paymentMethods.id))
      .then((rows) => rows[0]);

    if (!paymentRaw) {
      return c.json({ error: "Payment not found" }, 404);
    }

    // Transform the raw data to match the expected structure
    const providerFromId = (
      externalId?: string | null
    ): "stripe" | "dodo" | null => {
      if (!externalId) return null;
      if (
        externalId.startsWith("pi_") ||
        externalId.startsWith("seti_") ||
        externalId.startsWith("cs_")
      ) {
        return "stripe";
      }
      return null;
    };

    const payment: any = {
      ...paymentRaw,
      customer: paymentRaw.customerId
        ? {
            id: paymentRaw.customerId,
            name: paymentRaw.customerName,
            email: paymentRaw.customerEmail,
            billingCountry: paymentRaw.customerBillingCountry,
            billingCity: paymentRaw.customerBillingCity,
            billingAddressLine1: paymentRaw.customerBillingAddressLine1,
            billingAddressLine2: paymentRaw.customerBillingAddressLine2,
            billingPostalCode: paymentRaw.customerBillingPostalCode,
            phone: paymentRaw.customerPhone,
            taxId: paymentRaw.customerTaxId,
          }
        : null,
      invoice: paymentRaw.invoiceId
        ? {
            id: paymentRaw.invoiceId,
            customerInvoiceNumber: paymentRaw.invoiceCustomerInvoiceNumber,
            totalAmountCents: paymentRaw.invoiceTotalAmountCents,
            currency: paymentRaw.invoiceCurrency,
            status: paymentRaw.invoiceStatus,
            issueDate: paymentRaw.invoiceIssueDate,
            dueDate: paymentRaw.invoiceDueDate,
            hasPdf: !!paymentRaw.invoicePdfUrl,
          }
        : null,
      // Prefer provider from payment method; otherwise infer from externalPaymentId
      paymentProvider:
        paymentRaw.paymentProvider ||
        providerFromId(paymentRaw.externalPaymentId),
    };

    // Try to fetch PSP payment method details (card brand, last4 etc.)
    // Only when we have an external payment ID and a configured provider
    try {
      if (payment.externalPaymentId) {
        const provider = await getPaymentProvider(merchantId);
        if (
          provider.name === payment.paymentProvider &&
          provider.isPaymentProviderReady
        ) {
          const details = await getPspPaymentMethodDetailsFromPayment({
            paymentProvider: provider,
            pspPaymentId: payment.externalPaymentId,
          });
          payment.pspPaymentMethod = details;
        }
      }
    } catch (e) {
      // Best-effort enrichment; ignore failures
      console.error("Failed to fetch PSP payment method details:", e);
    }

    return c.json({ payment });
  })
  .get(
    "/",
    zValidator(
      "query",
      z.object({ customerId: z.string().optional() }).optional()
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;

      const customerId = c.req.valid("query")?.customerId;
      if (customerId) {
        const paymentsData = await db
          .select({
            id: payments.id,
            merchantId: payments.merchantId,
            invoiceId: payments.invoiceId,
            paymentMethodId: payments.paymentMethodId,
            externalPaymentId: payments.externalPaymentId,
            amountCents: payments.amountCents,
            currency: payments.currency,
            status: payments.status,
            errorMessage: payments.errorMessage,
            refundedAmountCents: payments.refundedAmountCents,
            refundStatus: payments.refundStatus,
            createdAt: payments.createdAt,
            updatedAt: payments.updatedAt,
            // Add invoice information
            customerInvoiceNumber: invoices.customerInvoiceNumber,
            // Add customer information
            customerName: customers.name,
            // Add subscription information
            subscriptionId: subscriptions.id,
            subscriptionStableId: subscriptions.stableSubscriptionId,
            // Add plan information
            planId: plans.id,
            planName: plans.planName,
          })
          .from(payments)
          .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
          .innerJoin(customers, eq(invoices.customerId, customers.id))
          .leftJoin(
            paymentMethods,
            eq(payments.paymentMethodId, paymentMethods.id)
          )
          .leftJoin(
            subscriptions,
            eq(invoices.subscriptionId, subscriptions.id)
          )
          .leftJoin(plans, eq(subscriptions.planId, plans.id))
          .where(
            and(
              eq(payments.merchantId, merchantId),
              eq(customers.id, customerId)
            )
          )
          .orderBy(desc(payments.createdAt));
        return c.json({ payments: paymentsData });
      }

      // when no query params
      const DEFAULT_PAYMENT_OBJECTS = 10;
      const paymentsData = await db
        .select({
          id: payments.id,
          merchantId: payments.merchantId,
          invoiceId: payments.invoiceId,
          paymentMethodId: payments.paymentMethodId,
          externalPaymentId: payments.externalPaymentId,
          amountCents: payments.amountCents,
          currency: payments.currency,
          status: payments.status,
          errorMessage: payments.errorMessage,
          refundedAmountCents: payments.refundedAmountCents,
          refundStatus: payments.refundStatus,
          createdAt: payments.createdAt,
          updatedAt: payments.updatedAt,
          // Add invoice information
          customerInvoiceNumber: invoices.customerInvoiceNumber,
          // Add customer information
          customerName: customers.name,
          // Add subscription information
          subscriptionId: subscriptions.id,
          subscriptionStableId: subscriptions.stableSubscriptionId,
          // Add plan information
          planId: plans.id,
          planName: plans.planName,
        })
        .from(payments)
        .where(and(eq(payments.merchantId, merchantId)))
        .leftJoin(invoices, eq(payments.invoiceId, invoices.id))
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .leftJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .orderBy(desc(payments.createdAt))
        .limit(DEFAULT_PAYMENT_OBJECTS);
      return c.json({ payments: paymentsData });
    }
  );
