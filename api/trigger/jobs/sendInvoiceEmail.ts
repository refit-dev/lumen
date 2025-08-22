import { task, logger } from "@trigger.dev/sdk/v3";
import { sendEmail } from "../../src/helpers/emails";
import type { InvoiceCompleteAPI } from "../../src/helpers/invoices";
import { triggerEnv } from "../trigger-env";

// Define the payload schema type for the email job
export type SendInvoiceEmailPayload = {
  invoice: InvoiceCompleteAPI;
  pdfBuffer?: Buffer;
  fileName: string;
  pdfUrl: string;
  invoiceNumber: string;
};

// Define the email sending job
export const sendInvoiceEmailJob = task({
  id: "send-invoice-email",
  run: async (payload: SendInvoiceEmailPayload) => {
    const { invoice, pdfBuffer, fileName, pdfUrl, invoiceNumber } = payload;

    logger.info(`Starting email sending for invoice ${invoice.id}`, {
      invoiceId: invoice.id,
      customerEmail: invoice.customer?.email,
      invoiceNumber,
    });

    // Ensure we have a PDF buffer; if not provided, fetch from pdfUrl
    let attachmentBuffer: Buffer | null = pdfBuffer ?? null;
    if (!attachmentBuffer) {
      try {
        const resp = await fetch(pdfUrl);
        if (!resp.ok) {
          throw new Error(`Failed to fetch PDF from url: ${resp.status}`);
        }
        const arr = await resp.arrayBuffer();
        attachmentBuffer = Buffer.from(arr);
      } catch (e) {
        logger.error(
          `Could not retrieve PDF buffer from url for invoice ${invoice.id}`,
          {
            invoiceId: invoice.id,
            pdfUrl,
            error: e instanceof Error ? e.message : String(e),
          }
        );
        attachmentBuffer = null;
      }
    }

    if (triggerEnv.NODE_ENV === "production") {
      // Check if customer has email
      if (!invoice.customer?.email) {
        logger.warn(
          `No customer email available for invoice ${invoice.id}, skipping email`
        );
        return {
          success: false,
          invoiceId: invoice.id,
          error: "No customer email available",
          message: "Invoice email skipped - no customer email",
        };
      }

      try {
        if (!attachmentBuffer) {
          return {
            success: false,
            invoiceId: invoice.id,
            error: "PDF buffer unavailable",
            message: "Invoice email skipped - could not obtain PDF",
          };
        }
        const customerName = invoice.customer.name || "Valued Customer";
        const merchantName =
          invoice.merchant?.displayName ||
          invoice.merchant?.legalName ||
          "Your Service Provider";

        // Check if invoice has payment-related information in notes
        const paymentLinkMatch = invoice.notes?.match(
          /https:\/\/checkout\.stripe\.com\/[^\s]+/
        );
        const paymentLink = paymentLinkMatch ? paymentLinkMatch[0] : null;

        // Check different payment states
        const isPaymentRequired = invoice.notes?.includes("Payment required:");
        const isPaymentCompleted = invoice.notes?.includes(
          "Paid online via checkout session"
        );
        const hasPaymentLink =
          paymentLink && (isPaymentRequired || isPaymentCompleted);

        const emailResult = await sendEmail({
          to: invoice.customer.email,
          subject: `Invoice from ${merchantName}`,
          body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Invoice</h2>
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
                  This invoice was paid online via Stripe checkout. No further action is required.
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
            <p>Please find your invoice attached to this email.</p>
            ${
              isPaymentCompleted
                ? "<p><em>Your payment has been confirmed and this invoice is now marked as paid.</em></p>"
                : isPaymentRequired
                  ? ""
                  : "<p><em>This invoice will be processed automatically using your stored payment method.</em></p>"
            }
            <p>Best regards,<br>${merchantName}</p>
          </div>
        `,
          from: "noreply@getlumen.dev",
          attachment: {
            filename: `INVOICE-${invoiceNumber.toUpperCase()}.pdf`,
            content: attachmentBuffer,
            contentType: "application/pdf",
          },
          resendApiKey: triggerEnv.RESEND_API_KEY,
        });

        if (emailResult.success) {
          logger.info(
            `Successfully sent invoice email to ${invoice.customer.email}`,
            {
              invoiceId: invoice.id,
              customerEmail: invoice.customer.email,
            }
          );
          return {
            success: true,
            invoiceId: invoice.id,
            customerEmail: invoice.customer.email,
            message: "Invoice email sent successfully",
          };
        } else {
          logger.error(
            `Failed to send invoice email to ${invoice.customer.email}`,
            {
              invoiceId: invoice.id,
              error: emailResult.error,
            }
          );
          return {
            success: false,
            invoiceId: invoice.id,
            error: emailResult.error,
            message: "Failed to send invoice email",
          };
        }
      } catch (emailError) {
        logger.error(`Error sending invoice email`, {
          invoiceId: invoice.id,
          customerEmail: invoice.customer.email,
          error:
            emailError instanceof Error
              ? emailError.message
              : String(emailError),
        });
        return {
          success: false,
          invoiceId: invoice.id,
          error:
            emailError instanceof Error
              ? emailError.message
              : String(emailError),
          message: "Error occurred while sending invoice email",
        };
      }
    } else {
      // NODE_ENV === "staging" || "development" || "test"
      logger.info(
        `Non-production environment detected for invoice ${invoice.id}, sending Slack notification instead of email`
      );

      if (!triggerEnv.SLACK_WEBHOOK) {
        logger.warn(
          `No Slack webhook configured for staging environment, skipping notification`
        );
        return {
          success: false,
          invoiceId: invoice.id,
          error: "No Slack webhook configured",
          message: "Staging notification skipped - no Slack webhook",
        };
      }

      try {
        const customerName = invoice.customer?.name || "Valued Customer";
        const merchantName =
          invoice.merchant?.displayName ||
          invoice.merchant?.legalName ||
          "Your Service Provider";

        const slackMessage = {
          text: `📧 Invoice Email (Staging)`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Invoice Email would be sent in production*\n\n*Invoice:* ${invoiceNumber}\n*Customer:* ${customerName}\n*Customer Email:* ${invoice.customer?.email || "No email"}\n*Merchant:* ${merchantName}\n*Invoice ID:* ${invoice.id}\n*PDF URL:* ${pdfUrl}`,
              },
            },
          ],
        };

        const response = await fetch(triggerEnv.SLACK_WEBHOOK, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(slackMessage),
        });

        if (response.ok) {
          logger.info(
            `Successfully sent Slack notification for invoice ${invoice.id}`,
            {
              invoiceId: invoice.id,
              customerEmail: invoice.customer?.email,
            }
          );
          return {
            success: true,
            invoiceId: invoice.id,
            customerEmail: invoice.customer?.email,
            message: "Slack notification sent successfully (staging)",
          };
        } else {
          const errorText = await response.text();
          logger.error(
            `Failed to send Slack notification for invoice ${invoice.id}`,
            {
              invoiceId: invoice.id,
              error: errorText,
              status: response.status,
            }
          );
          return {
            success: false,
            invoiceId: invoice.id,
            error: `Slack webhook failed: ${response.status} - ${errorText}`,
            message: "Failed to send Slack notification",
          };
        }
      } catch (slackError) {
        logger.error(`Error sending Slack notification`, {
          invoiceId: invoice.id,
          error:
            slackError instanceof Error
              ? slackError.message
              : String(slackError),
        });
        return {
          success: false,
          invoiceId: invoice.id,
          error:
            slackError instanceof Error
              ? slackError.message
              : String(slackError),
          message: "Error occurred while sending Slack notification",
        };
      }
    }
  },
});
