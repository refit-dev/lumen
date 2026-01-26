import { db } from "../db/client";
import { and, eq } from "drizzle-orm";
import {
  invoices as invoicesTable,
  invoiceLineItems as invoiceLineItemsTable,
} from "@lumen/common/schema";
import { triggerInvoicePdfGeneration } from "./billing";
import { getPaymentProvider } from "./paymentprovider";
import { sendRefundNoticeEmail } from "./invoiceEmail";

type TxType = Parameters<typeof db.transaction>[0] extends (arg: infer T) => any
  ? T
  : any;

export async function createRefundAdjustmentInvoice(params: {
  tx: TxType;
  merchantId: string;
  originalInvoiceId: string;
  documentType: "cancellation" | "credit_note";
  amountCents?: number; // required for credit_note; ignored for cancellation
  reason?: string | null;
}): Promise<{ id: string } | null> {
  const {
    tx,
    merchantId,
    originalInvoiceId,
    documentType,
    amountCents,
    reason,
  } = params;

  const originalInvoice = await tx.query.invoices.findFirst({
    where: eq(invoicesTable.id, originalInvoiceId),
    with: {
      lineItems: true,
      customer: true,
      merchant: true,
    },
  });
  if (!originalInvoice) return null;

  const now = new Date();
  const origSubtotal = originalInvoice.subtotalCents || 0;
  const origTax = originalInvoice.taxAmountCents || 0;
  const origTotal = originalInvoice.totalAmountCents || origSubtotal + origTax;

  let total = origTotal;
  let taxPortion = origTax;
  let netPortion = origSubtotal;

  if (documentType === "credit_note") {
    const refundTotal = amountCents || 0;
    total = refundTotal;
    taxPortion =
      origTotal > 0 ? Math.round((refundTotal * origTax) / origTotal) : 0;
    netPortion = refundTotal - taxPortion;
  }

  // Create adjustment invoice shell
  const [newInv] = await tx
    .insert(invoicesTable)
    .values({
      merchantId,
      customerId: originalInvoice.customerId,
      subscriptionId: originalInvoice.subscriptionId || null,
      status: "issued",
      totalAmountCents: total,
      subtotalCents: netPortion,
      taxAmountCents: taxPortion,
      effectiveTaxRate: originalInvoice.effectiveTaxRate,
      taxJurisdiction: originalInvoice.taxJurisdiction,
      taxCalculationMethod: originalInvoice.taxCalculationMethod,
      currency: originalInvoice.currency,
      customerInvoiceNumber: await generateNextCustomerInvoiceNumber({
        tx,
        merchantId,
        customerId: originalInvoice.customerId,
      }),
      dueDate: now,
      issueDate: now,
      billingPeriodStart: originalInvoice.billingPeriodStart,
      billingPeriodEnd: originalInvoice.billingPeriodEnd,
      notes:
        documentType === "cancellation"
          ? "Invoice cancellation for refund"
          : "Credit note for partial refund",
      documentType,
      originalInvoiceId: originalInvoice.id,
      cancellationOrCreditReason: reason || null,
    })
    .returning();

  // Line items: net and optional tax
  const values: any[] = [];
  if (netPortion > 0) {
    values.push({
      invoiceId: newInv.id,
      type: "discount",
      description:
        documentType === "cancellation"
          ? `Cancellation of invoice ${originalInvoice.customerInvoiceNumber || originalInvoice.id}`
          : "Refund credit",
      quantity: 1,
      unitAmountCents: netPortion,
      subtotalCents: netPortion,
    });
  }
  if (taxPortion > 0) {
    values.push({
      invoiceId: newInv.id,
      type: "tax",
      description:
        documentType === "cancellation"
          ? "Tax adjustment for cancellation"
          : "Tax adjustment for refund",
      quantity: 1,
      unitAmountCents: taxPortion,
      subtotalCents: taxPortion,
      taxMetadata: {
        fullDescription:
          documentType === "cancellation"
            ? "Tax adjustment corresponding to cancellation"
            : "Tax adjustment corresponding to refund",
      },
    });
  }
  if (values.length > 0) {
    await tx.insert(invoiceLineItemsTable).values(values);
  }

  // Generate PDF (Stripe will email via job; Dodo requires manual email fallback)
  const invoiceWithDetails = await tx.query.invoices.findFirst({
    where: eq(invoicesTable.id, newInv.id),
    with: {
      customer: true,
      merchant: true,
      lineItems: true,
      originalInvoice: true,
    },
  });
  if (invoiceWithDetails) {
    await triggerInvoicePdfGeneration(invoiceWithDetails, tx);

    try {
      const provider = await getPaymentProvider(merchantId);
      if (provider.name === "dodo") {
        const to = invoiceWithDetails.customer?.email as string | undefined;
        if (to) {
          const merchantName =
            (invoiceWithDetails.merchant as any)?.displayName ||
            (invoiceWithDetails.merchant as any)?.legalName ||
            "Your Service Provider";
          const invoiceNumber =
            invoiceWithDetails.customerInvoiceNumber || newInv.id;
          const originalNumber =
            originalInvoice.customerInvoiceNumber || originalInvoice.id;
          await sendRefundNoticeEmail({
            to,
            merchantName,
            documentType,
            invoiceNumber,
            amountCents: newInv.totalAmountCents,
            currency: newInv.currency,
            originalInvoiceNumber: originalNumber,
            reason: reason || null,
            db,
          });
          // TODO: Attach Dodo refund PDF once Dodo exposes a refund invoice retrieval API for refunds.
        }
      }
    } catch (e) {
      console.error("Failed to send refund notice email (Dodo)", e);
    }
  }

  return { id: newInv.id };
}

async function generateNextCustomerInvoiceNumber(args: {
  tx: TxType;
  merchantId: string;
  customerId: string;
}): Promise<string> {
  // Use the helper from billing to keep numbering consistent
  const { getAndIncrementInvoiceCounter, formatCustomerInvoiceNumber } =
    await import("./billing");
  const seq = await getAndIncrementInvoiceCounter(
    args.tx as any,
    args.merchantId,
    args.customerId
  );
  const prefix = args.customerId.startsWith("cus_")
    ? args.customerId.slice(4, 10)
    : args.customerId.slice(0, 6);
  return formatCustomerInvoiceNumber(prefix, seq);
}
