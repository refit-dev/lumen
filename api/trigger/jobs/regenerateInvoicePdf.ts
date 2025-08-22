import { task, logger } from "@trigger.dev/sdk/v3";
import {
  processInvoicePdfGeneration,
  InvoiceCompleteAPI,
} from "../../src/helpers/invoices";
import { z } from "zod";
import { triggerEnv } from "../trigger-env";

// Define the payload schema type
export type RegenerateInvoicePdfPayload = {
  invoiceId: string;
};

const UploadInvoicePdfResponseSchema = z.object({
  success: z.literal(true),
  pdfUrl: z.string().url(),
});

// Define the job
export const regenerateInvoicePdfJob = task({
  id: "regenerate-invoice-pdf",
  run: async (payload: RegenerateInvoicePdfPayload) => {
    const { invoiceId } = payload;
    logger.info(`Starting PDF regeneration for invoice ${invoiceId}`);

    const triggerApiAccessKey = triggerEnv.TRIGGER_API_ACCESS_KEY;
    const apiUrl = triggerEnv.API_URL;

    // Step 1: Fetch invoice data from the API
    try {
      const response = await fetch(
        `${apiUrl}/trigger/billing/get-invoice-for-pdf`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${triggerApiAccessKey}`,
          },
          body: JSON.stringify({ invoiceId }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          `Failed to fetch invoice data: Status ${response.status}, Response: ${errorText}`
        );
        return {
          success: 0,
          failed: 1,
          details: [
            {
              invoiceId,
              status: "failed",
              error: `Failed to fetch invoice data: ${errorText}`,
            },
          ],
        };
      }

      const responseData = (await response.json()) as { invoice: any };
      const invoice = responseData.invoice;
      logger.info(`Successfully fetched invoice data for ${invoiceId}`);

      // Step 2: Convert to the format expected by PDF generation
      const pdfInvoice: InvoiceCompleteAPI = {
        id: invoice.id,
        customerInvoiceNumber: invoice.customerInvoiceNumber,
        currency: invoice.currency,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        billingPeriodStartDate: invoice.billingPeriodStart,
        billingPeriodEndDate: invoice.billingPeriodEnd,
        subtotalCents: invoice.subtotalCents,
        taxAmountCents: invoice.taxAmountCents,
        totalAmountCents: invoice.totalAmountCents,
        effectiveTaxRate: invoice.effectiveTaxRate,
        taxJurisdiction: invoice.taxJurisdiction,
        taxCalculationMethod: invoice.taxCalculationMethod,
        notes: invoice.notes, // Add notes field for payment links
        lineItems: (invoice.lineItems || []).map((item: any) => ({
          id: item.id,
          description: item.description,
          type: item.type, // Essential for identifying tax items
          quantity: item.quantity ?? undefined,
          unitAmountCents: item.unitAmountCents ?? undefined,
          subtotalCents: item.subtotalCents,
          taxMetadata: item.taxMetadata, // Include tax metadata for tax line items
          billingPeriodStart: item.billingPeriodStart,
          billingPeriodEnd: item.billingPeriodEnd,
        })),
        customer: invoice.customer,
        merchant: invoice.merchant,
      };

      // Step 3: Generate the PDF
      const pdfResults = await processInvoicePdfGeneration([pdfInvoice]).catch(
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

      // Step 4: Upload the regenerated PDF (this will overwrite the existing one)
      try {
        const pdfBase64 = pdfResult.pdfBuffer.toString("base64");
        const uploadResponse = await fetch(
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

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text();
          logger.error(
            `Failed to upload regenerated PDF to API: Status ${uploadResponse.status}, Response: ${errorText}`
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
          await uploadResponse.json()
        );
        logger.info(`Successfully regenerated and uploaded PDF`, {
          invoiceId: pdfResult.invoiceId,
          pdfUrl,
        });

        return {
          success: 1,
          failed: 0,
          details: [
            {
              invoiceId: pdfResult.invoiceId,
              status: "success",
              pdfUrl,
              message: "PDF successfully regenerated and uploaded",
            },
          ],
        };
      } catch (error) {
        logger.error(
          `Failed to upload regenerated PDF: ${error instanceof Error ? error.message : String(error)}`
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
    } catch (error) {
      logger.error(
        `Failed to fetch invoice data for PDF regeneration: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        success: 0,
        failed: 1,
        details: [
          {
            invoiceId,
            status: "failed",
            error: `Failed to fetch invoice data: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
});
