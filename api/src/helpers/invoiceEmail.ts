import type { InvoiceCompleteAPI } from "./invoices";
import {
  createCoreNotificationProvider,
  type EmailAttachment,
} from "./notificationCore";
import { getPaymentLinkFromNotes } from "@lumen/common/pdf";
import { type PostgresDB } from "@lumen/common";

export type InvoiceEmailOptions = {
  invoice: InvoiceCompleteAPI;
  pdfBuffer?: Buffer;
  pdfUrl: string;
  invoiceNumber: string;
  nodeEnv?: "development" | "test" | "staging" | "production";
  resendApiKey?: string | null;
  slackWebhook?: string | null;
  apiUrl?: string | null;
  internalApiKey?: string | null;
  db?: PostgresDB;
};

export type InvoiceEmailResult = {
  success: boolean;
  invoiceId: string;
  customerEmail?: string;
  error?: string;
  message: string;
};

/**
 * Fetches PDF buffer from URL if not provided
 */
async function getPdfBuffer(
  pdfBuffer: Buffer | undefined,
  pdfUrl: string,
  invoiceId: string
): Promise<Buffer | null> {
  if (pdfBuffer) {
    return pdfBuffer;
  }

  try {
    const resp = await fetch(pdfUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch PDF from url: ${resp.status}`);
    }
    const arr = await resp.arrayBuffer();
    return Buffer.from(arr);
  } catch (e) {
    console.error(
      `Could not retrieve PDF buffer from url for invoice ${invoiceId}`,
      {
        invoiceId,
        pdfUrl,
        error: e instanceof Error ? e.message : String(e),
      }
    );
    return null;
  }
}

/**
 * Generates the HTML email content for an invoice
 */
function generateInvoiceEmailHtml(invoice: InvoiceCompleteAPI): string {
  const customerName = invoice.customer?.name || "Valued Customer";
  const merchantName =
    invoice.merchant?.displayName ||
    invoice.merchant?.legalName ||
    "Your Service Provider";
  const docHeading =
    invoice.documentType === "cancellation"
      ? "Invoice Cancellation"
      : invoice.documentType === "credit_note"
        ? "Credit Note"
        : "Invoice";

  const paymentLink = getPaymentLinkFromNotes(invoice.notes || "");
  const isPaymentRequired = invoice.notes?.includes("Payment required:");
  const isPaymentCompleted = invoice.notes?.includes(
    "Paid online via payment link"
  );
  const hasPaymentLink =
    paymentLink && (isPaymentRequired || isPaymentCompleted);

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${docHeading}</h2>
      <p>Dear ${customerName},</p>
      ${
        hasPaymentLink && paymentLink && isPaymentCompleted
          ? `
        <div style="background-color: #f0f9f0; border: 2px solid #22c55e; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #16a34a; margin-top: 0; display: flex; align-items: center;">
            <span style="margin-right: 8px;">✓</span> Payment Completed
          </h3>
          <p style="margin: 10px 0; color: #15803d;">
            <strong>Thank you! Your payment has been successfully processed.</strong>
          </p>
          <p style="font-size: 14px; color: #16a34a; margin-bottom: 0;">
            This invoice was paid online via Payment Link. No further action is required.
          </p>
        </div>
      `
          : hasPaymentLink && paymentLink && isPaymentRequired
            ? `
        <div style="background-color: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #92400e; margin-top: 0;">Payment Required</h3>
          <p style="margin: 10px 0; color: #78716c;"><strong>To complete your payment, please click the secure link below:</strong></p>
          <div style="text-align: center; margin: 20px 0;">
            <a href="${paymentLink}" style="display: inline-block; background-color: #2563eb; color: white; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: bold; font-size: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">Pay Invoice Online</a>
          </div>
          <p style="font-size: 14px; color: #6b7280; margin-bottom: 0;">
            This secure payment link will take you to Stripe's checkout page where you can pay with a credit or debit card.
          </p>
        </div>
      `
            : ""
      }
      <p>Please find your ${docHeading.toLowerCase()} attached to this email.</p>
      ${
        isPaymentCompleted
          ? "<p><em>Your payment has been confirmed and this invoice is now marked as paid.</em></p>"
          : isPaymentRequired
            ? ""
            : "<p><em>This invoice will be processed automatically using your stored payment method.</em></p>"
      }
      <p>Best regards,<br>${merchantName}</p>
    </div>
  `;
}

/**
 * Sends an invoice email with PDF attachment
 */
export async function sendInvoiceEmail(
  options: InvoiceEmailOptions
): Promise<InvoiceEmailResult> {
  const {
    invoice,
    pdfBuffer,
    pdfUrl,
    invoiceNumber,
    nodeEnv,
    resendApiKey,
    slackWebhook,
    apiUrl,
    internalApiKey,
    db,
  } = options;

  console.info(`Starting email sending for invoice ${invoice.id}`, {
    invoiceId: invoice.id,
    customerEmail: invoice.customer?.email,
    invoiceNumber,
  });

  const totalAmountCents = invoice.totalAmountCents ?? 0;
  if (totalAmountCents === 0) {
    console.info(
      `Invoice ${invoice.id} has zero total amount, skipping customer email`
    );
    return {
      success: true,
      invoiceId: invoice.id,
      customerEmail: invoice.customer?.email ?? undefined,
      message: "Invoice email skipped - zero amount invoice",
    };
  }

  // Check if customer has email
  if (!invoice.customer?.email) {
    console.warn(
      `No customer email available for invoice ${invoice.id}, skipping email`
    );
    return {
      success: false,
      invoiceId: invoice.id,
      error: "No customer email available",
      message: "Invoice email skipped - no customer email",
    };
  }

  // Get PDF buffer
  const attachmentBuffer = await getPdfBuffer(pdfBuffer, pdfUrl, invoice.id);
  if (!attachmentBuffer) {
    return {
      success: false,
      invoiceId: invoice.id,
      error: "PDF buffer unavailable",
      message: "Invoice email skipped - could not obtain PDF",
    };
  }

  // Create core notification provider with explicit configuration
  const notify = createCoreNotificationProvider({
    nodeEnv: nodeEnv || "development",
    resendApiKey: resendApiKey || null,
    slackWebhook: slackWebhook || null,
    apiUrl: apiUrl || null,
    internalApiKey: internalApiKey || null,
    db,
  });

  try {
    const merchantName =
      invoice.merchant?.displayName ||
      invoice.merchant?.legalName ||
      "Your Service Provider";

    const html = generateInvoiceEmailHtml(invoice);

    const attachment: EmailAttachment = {
      filename: `INVOICE-${invoiceNumber.toUpperCase()}.pdf`,
      content: attachmentBuffer,
      contentType: "application/pdf",
    };

    const emailResult = await notify.sendEmail({
      to: invoice.customer.email,
      subject:
        invoice.documentType === "cancellation"
          ? `Invoice Cancellation from ${merchantName}`
          : invoice.documentType === "credit_note"
            ? `Credit Note from ${merchantName}`
            : `Invoice from ${merchantName}`,
      html,
      from: "noreply@getlumen.dev",
      attachment,
    });

    if (emailResult.success) {
      console.info(
        `Successfully processed invoice email notification for ${invoice.customer.email}`,
        {
          invoiceId: invoice.id,
          customerEmail: invoice.customer.email,
        }
      );
      return {
        success: true,
        invoiceId: invoice.id,
        customerEmail: invoice.customer.email,
        message:
          nodeEnv === "production"
            ? "Invoice email sent successfully"
            : "Slack notification sent successfully (non-prod)",
      };
    } else {
      console.error(
        `Failed to process invoice email notification to ${invoice.customer.email}`,
        {
          invoiceId: invoice.id,
          error: emailResult.error,
        }
      );
      return {
        success: false,
        invoiceId: invoice.id,
        error: emailResult.error,
        message:
          nodeEnv === "production"
            ? "Failed to send invoice email"
            : "Failed to send Slack notification",
      };
    }
  } catch (err) {
    console.error(`Error processing invoice email notification`, {
      invoiceId: invoice.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      invoiceId: invoice.id,
      error: err instanceof Error ? err.message : String(err),
      message: "Error occurred while processing invoice notification",
    };
  }
}

// Lightweight refund notice without PDF attachment (used for Dodo refunds)
export async function sendRefundNoticeEmail(params: {
  to: string;
  merchantName: string;
  documentType: "cancellation" | "credit_note";
  invoiceNumber: string;
  amountCents: number;
  currency: string;
  originalInvoiceNumber?: string | null;
  reason?: string | null;
  db?: PostgresDB;
}): Promise<{ success: boolean; error?: string }> {
  const {
    to,
    merchantName,
    documentType,
    invoiceNumber,
    amountCents,
    currency,
    originalInvoiceNumber,
    reason,
    db,
  } = params;

  try {
    const notify = createCoreNotificationProvider({
      nodeEnv: (process.env.NODE_ENV as any) || "development",
      resendApiKey: process.env.RESEND_API_KEY || null,
      slackWebhook: process.env.SLACK_WEBHOOK || null,
      db,
    });

    const amount = (amountCents / 100).toFixed(2);
    const heading =
      documentType === "cancellation" ? "Invoice Cancellation" : "Credit Note";

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>${heading}</h2>
        <p>Dear Customer,</p>
        <p>We have issued a ${heading.toLowerCase()} ${
          originalInvoiceNumber
            ? `referencing your original invoice <strong>${originalInvoiceNumber}</strong>`
            : "for your recent payment"
        }.</p>
        <p>
          <strong>Document number:</strong> ${invoiceNumber}<br/>
          <strong>Amount:</strong> ${currency.toUpperCase()} ${amount}<br/>
          ${reason ? `<strong>Reason:</strong> ${reason}<br/>` : ""}
        </p>
        <p>
          This refund receipt is provided by our payment processor. We do not yet have a downloadable PDF for this refund.
        </p>
        <p style="color:#64748b; font-size: 12px;">
          <!-- TODO: Attach Dodo refund PDF once Dodo exposes a refund invoice retrieval API. -->
        </p>
        <p>Best regards,<br/>${merchantName}</p>
      </div>
    `;

    const result = await notify.sendEmail({
      to,
      subject: `${heading} from ${merchantName}`,
      html,
      from: "noreply@getlumen.dev",
    });

    return { success: !!result.success, error: result.error };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
