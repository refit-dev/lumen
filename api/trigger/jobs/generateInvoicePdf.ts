import { task, logger } from "@trigger.dev/sdk/v3";
import {
  processInvoicePdfGeneration,
  InvoiceCompleteAPI,
} from "../../src/helpers/invoices";
import { z } from "zod";
import { triggerEnv } from "../trigger-env";
import { sendInvoiceEmailJob } from "./sendInvoiceEmail";

// Define the payload schema type
// Accept a single invoice for PDF generation
export type GenerateInvoicePdfPayload = {
  invoice: InvoiceCompleteAPI;
};

const UploadInvoicePdfResponseSchema = z.object({
  success: z.literal(true),
  pdfUrl: z.string().url(),
});

// Define the job
export const generateInvoicePdfJob = task({
  id: "generate-invoice-pdf",
  run: async (payload: GenerateInvoicePdfPayload) => {
    const { invoice } = payload;
    logger.info(`Starting PDF generation for invoice ${invoice.id}`);

    const triggerApiAccessKey = triggerEnv.TRIGGER_API_ACCESS_KEY;
    const apiUrl = triggerEnv.API_URL;
    // Generate the PDF using the helper (always as an array for compatibility)
    const pdfResults = await processInvoicePdfGeneration([invoice]).catch(
      (error) => {
        logger.error(
          `Fatal error in PDF generation process: ${error instanceof Error ? error.message : String(error)}`
        );
        return {
          success: 0,
          failed: 1,
          generatedPdfs: [
            {
              invoiceId: invoice.id,
              status: "failed",
              error: `PDF generation failed: ${error instanceof Error ? error.message : String(error)}`,
              pdfBuffer: null,
              fileName: "",
              invoiceNumber: "",
            },
          ],
        };
      }
    );

    const pdfResult = pdfResults.generatedPdfs[0];
    if (pdfResult.status === "failed" || !pdfResult.pdfBuffer) {
      logger.error(`PDF generation failed: ${pdfResult.error}`);
      return {
        success: 0,
        failed: 1,
        details: [
          {
            invoiceId: pdfResult.invoiceId,
            status: "failed",
            error: pdfResult.error || "PDF generation failed",
          },
        ],
      };
    }

    // Prepare base64 PDF and POST to API endpoint
    try {
      const pdfBase64 = pdfResult.pdfBuffer.toString("base64");
      const response = await fetch(
        `${apiUrl}/trigger/billing/upload-invoice-pdf`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${triggerApiAccessKey}`,
          },
          body: JSON.stringify({
            invoiceId: pdfResult.invoiceId,
            fileName: pdfResult.fileName,
            pdfBase64,
            invoiceNumber: pdfResult.invoiceNumber,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          `Failed to upload PDF to API: Status ${response.status}, Response: ${errorText}`
        );
        return {
          success: 0,
          failed: 1,
          details: [
            {
              invoiceId: pdfResult.invoiceId,
              status: "failed",
              error: `API upload failed: ${errorText}`,
            },
          ],
        };
      }

      const { pdfUrl } = UploadInvoicePdfResponseSchema.parse(
        await response.json()
      );
      logger.info(`Successfully uploaded PDF and updated invoice record`, {
        invoiceId: pdfResult.invoiceId,
        pdfUrl,
      });

      // Trigger email job to send invoice via email
      const invoiceNumber =
        pdfResult.invoiceNumber || invoice.customerInvoiceNumber || invoice.id;

      try {
        const emailJobHandle = await sendInvoiceEmailJob.trigger({
          invoice,
          pdfBuffer: pdfResult.pdfBuffer!,
          pdfUrl,
          invoiceNumber,
        });

        logger.info(`Triggered email job for invoice ${invoice.id}`, {
          invoiceId: invoice.id,
          emailJobId: emailJobHandle.id,
        });
      } catch (emailJobError) {
        logger.error(`Failed to trigger email job for invoice ${invoice.id}`, {
          invoiceId: invoice.id,
          error:
            emailJobError instanceof Error
              ? emailJobError.message
              : String(emailJobError),
        });
      }

      return {
        success: 1,
        failed: 0,
        details: [
          {
            invoiceId: pdfResult.invoiceId,
            status: "success",
            pdfUrl,
          },
        ],
      };
    } catch (error) {
      logger.error(
        `Failed to POST PDF to API: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        success: 0,
        failed: 1,
        details: [
          {
            invoiceId: pdfResult.invoiceId,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
});
