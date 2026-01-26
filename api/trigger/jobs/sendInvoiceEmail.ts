import { task } from "@trigger.dev/sdk/v3";
import { sendInvoiceEmail } from "../../src/helpers/invoiceEmail";
import type { InvoiceCompleteAPI } from "../../src/helpers/invoices";
import { triggerEnv } from "../trigger-env";

// Define the payload schema type for the email job
export type SendInvoiceEmailPayload = {
  invoice: InvoiceCompleteAPI;
  pdfBuffer?: Buffer;
  pdfUrl: string;
  invoiceNumber: string;
};

// Define the email sending job
export const sendInvoiceEmailJob = task({
  id: "send-invoice-email",
  run: async (payload: SendInvoiceEmailPayload) => {
    const { invoice, pdfBuffer, pdfUrl, invoiceNumber } = payload;

    const result = await sendInvoiceEmail({
      invoice,
      pdfBuffer,
      pdfUrl,
      invoiceNumber,
      nodeEnv: triggerEnv.NODE_ENV,
      resendApiKey: triggerEnv.RESEND_API_KEY ?? null,
      slackWebhook: triggerEnv.SLACK_WEBHOOK ?? null,
      apiUrl: triggerEnv.API_URL,
      internalApiKey: triggerEnv.INTERNAL_API_KEY,
    });

    return result;
  },
});
