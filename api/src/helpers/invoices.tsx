/** @jsxImportSource react */
// ^ we need this because otherwise JSX gets parsed with hono/jsx

import { Document, Font, pdf, Page, Text } from "@react-pdf/renderer";
import { InvoiceDocument, InvoiceData } from "@lumen/common/pdf";
import { CustomerFromApi, MerchantFromApi } from "@lumen/common/schema";
import { taxReasonCodes, getTaxReasonInfo } from "./tax-rates";
import path from "path";
import fs from "fs";

// -- Types from the original implementation --
// Add the required type - this would normally be imported from the invoice schema
// Line item coming from the DB/API. Quantity & unitAmountCents are optional because
// legacy data may not include them, but we prefer using them if available.
type InvoiceLineItemAPI = {
  id: string;
  description: string;
  type?: string; // e.g. "fixed", "usage", "per_unit", "tax", etc.
  subtotalCents?: number; // optional so we can derive it when missing
  quantity?: number | null;
  unitAmountCents?: number | null;
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
  billingPeriodStart?: string | Date;
  billingPeriodEnd?: string | Date;
};

// Tax line item with metadata from tax engine
type TaxLineItemAPI = {
  type: "tax";
  description: string;
  subtotalCents: number;
  taxMetadata: {
    taxAuthority?: string;
    taxType?: string;
    jurisdiction?: string;
    taxRate?: number;
    rateSource?: string;
    exemptionReason?: string;
    reasonCode?: number; // Updated to number to match tax-engine interface
    fullDescription?: string;
  };
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
};

type InvoiceWithLineItemsAPI = {
  id: string;
  customerInvoiceNumber?: string | null;
  currency: string;
  issueDate?: string | null;
  dueDate?: string | null;
  billingPeriodStartDate?: string | null;
  billingPeriodEndDate?: string | null;
  lineItems: InvoiceLineItemAPI[];
  taxLineItems?: TaxLineItemAPI[]; // Add tax line items with metadata
  // Tax fields for enhanced PDF display
  subtotalCents?: number | null;
  taxAmountCents?: number | null;
  totalAmountCents?: number;
  effectiveTaxRate?: string | null;
  taxJurisdiction?: string | null;
  taxCalculationMethod?: string | null;
  notes?: string | null; // Add notes field for payment links and other information
  // Refund/correction fields
  documentType?: "standard" | "cancellation" | "credit_note" | null;
  originalInvoiceId?: string | null;
  cancellationOrCreditReason?: string | null;
  originalInvoiceNumber?: string | null;
  originalIssueDate?: string | null;
};

// Type for the complete invoice data including customer and merchant
export type InvoiceCompleteAPI = InvoiceWithLineItemsAPI & {
  customer: CustomerFromApi;
  merchant: MerchantFromApi;
};

// Helper function to find the correct fonts directory
function getFontsDirectory(): string {
  const possiblePaths = [
    // Bundled environment (both dev and production) - additionalFiles copies maintaining relative path
    path.join(process.cwd(), "trigger/assets/fonts/Geist/static"),
    // Fallback - relative to this file
    path.resolve(__dirname, "../../trigger/assets/fonts/Geist/static"),
  ];

  for (const fontsPath of possiblePaths) {
    const testFontPath = path.join(fontsPath, "Geist-Regular.ttf");
    console.log(`Checking font path: ${testFontPath}`);

    if (fs.existsSync(testFontPath)) {
      console.log(`Found fonts at: ${fontsPath}`);
      return fontsPath;
    }
  }

  throw new Error(
    `Could not find Geist fonts in any of these locations: ${possiblePaths.join(", ")}`
  );
}

// Register fonts only in trigger environment
function registerFontsIfTriggerEnv() {
  // Check if we're in trigger environment
  const isTriggerEnv =
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test" ||
    process.env.IS_TRIGGER_ENV; // this will be set on trigger's staging and prod envs

  if (!isTriggerEnv) {
    console.log("Skipping font registration - not in trigger environment");
    return;
  }

  try {
    const fontsDir = getFontsDirectory();

    // Register Geist font for better typography
    Font.register({
      family: "Geist",
      fonts: [
        {
          src: path.join(fontsDir, "Geist-Regular.ttf"),
          fontWeight: "normal",
          fontStyle: "normal",
        },
        {
          src: path.join(fontsDir, "Geist-Bold.ttf"),
          fontWeight: "bold",
          fontStyle: "normal",
        },
        {
          src: path.join(fontsDir, "Geist-Light.ttf"),
          fontWeight: "normal",
          fontStyle: "italic",
        },
        {
          src: path.join(fontsDir, "Geist-SemiBold.ttf"),
          fontWeight: "bold",
          fontStyle: "italic",
        },
      ],
    });

    // Also register hyphenation callback for better text wrapping
    Font.registerHyphenationCallback((word) => [word]);

    console.log("Successfully registered Geist fonts");
  } catch (error) {
    console.warn("Failed to register fonts:", error);
  }
}

// Register fonts on module load if in trigger environment
registerFontsIfTriggerEnv();

// Shared helper: format a DB-loaded invoice (with relations) into InvoiceCompleteAPI
export function formatInvoiceWithDetailsToCompleteAPI(
  invoiceWithDetails: any
): InvoiceCompleteAPI {
  const toIsoOrNull = (value: any): string | null => {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    try {
      return new Date(value as string).toISOString();
    } catch {
      return null;
    }
  };

  const formatted = {
    id: invoiceWithDetails.id,
    customerInvoiceNumber: invoiceWithDetails.customerInvoiceNumber,
    currency: invoiceWithDetails.currency,
    issueDate: toIsoOrNull(invoiceWithDetails.issueDate),
    dueDate: toIsoOrNull(invoiceWithDetails.dueDate),
    billingPeriodStartDate: toIsoOrNull(invoiceWithDetails.billingPeriodStart),
    billingPeriodEndDate: toIsoOrNull(invoiceWithDetails.billingPeriodEnd),
    subtotalCents: invoiceWithDetails.subtotalCents,
    taxAmountCents: invoiceWithDetails.taxAmountCents,
    totalAmountCents: invoiceWithDetails.totalAmountCents,
    effectiveTaxRate: invoiceWithDetails.effectiveTaxRate,
    taxJurisdiction: invoiceWithDetails.taxJurisdiction,
    taxCalculationMethod: invoiceWithDetails.taxCalculationMethod,
    notes: invoiceWithDetails.notes,
    documentType: invoiceWithDetails.documentType,
    originalInvoiceId: invoiceWithDetails.originalInvoiceId,
    cancellationOrCreditReason: invoiceWithDetails.cancellationOrCreditReason,
    originalInvoiceNumber:
      (invoiceWithDetails.originalInvoice &&
        (invoiceWithDetails.originalInvoice.customerInvoiceNumber ||
          invoiceWithDetails.originalInvoice.id)) ||
      null,
    originalIssueDate:
      (invoiceWithDetails.originalInvoice &&
        (toIsoOrNull(invoiceWithDetails.originalInvoice.issueDate) || null)) ||
      null,
    lineItems: (invoiceWithDetails.lineItems || []).map((item: any) => ({
      id: item.id,
      description: item.description,
      type: item.type,
      quantity: item.quantity ?? undefined,
      unitAmountCents: item.unitAmountCents ?? undefined,
      subtotalCents: item.subtotalCents,
      taxMetadata: item.taxMetadata,
      billingPeriodStart: toIsoOrNull(item.billingPeriodStart) || undefined,
      billingPeriodEnd: toIsoOrNull(item.billingPeriodEnd) || undefined,
    })),
    customer: invoiceWithDetails.customer && {
      id: invoiceWithDetails.customer.id,
      name: invoiceWithDetails.customer.name ?? "",
      email: invoiceWithDetails.customer.email ?? "",
      billingAddressLine1: invoiceWithDetails.customer.billingAddressLine1,
      billingAddressLine2: invoiceWithDetails.customer.billingAddressLine2,
      billingCity: invoiceWithDetails.customer.billingCity,
      billingStateProvince: invoiceWithDetails.customer.billingStateProvince,
      billingPostalCode: invoiceWithDetails.customer.billingPostalCode,
      billingCountry: invoiceWithDetails.customer.billingCountry,
      taxId: invoiceWithDetails.customer.taxId,
      invoicePrefix: invoiceWithDetails.customer.invoicePrefix,
      createdAt: toIsoOrNull(invoiceWithDetails.customer.createdAt)!,
      timezone: invoiceWithDetails.customer.timezone,
    },
    merchant: invoiceWithDetails.merchant && {
      id: invoiceWithDetails.merchant.id,
      userId: invoiceWithDetails.merchant.userId,
      organizationId: invoiceWithDetails.merchant.organizationId,
      legalName: invoiceWithDetails.merchant.legalName,
      displayName: invoiceWithDetails.merchant.displayName,
      taxId: invoiceWithDetails.merchant.taxId,
      websiteUrl: invoiceWithDetails.merchant.websiteUrl,
      supportEmail: invoiceWithDetails.merchant.supportEmail,
      billingEmail: invoiceWithDetails.merchant.billingEmail,
      phoneNumber: invoiceWithDetails.merchant.phoneNumber,
      addressLine1: invoiceWithDetails.merchant.addressLine1,
      addressLine2: invoiceWithDetails.merchant.addressLine2,
      city: invoiceWithDetails.merchant.city,
      stateProvince: invoiceWithDetails.merchant.stateProvince,
      postalCode: invoiceWithDetails.merchant.postalCode,
      country: invoiceWithDetails.merchant.country,
      defaultCurrency: invoiceWithDetails.merchant.defaultCurrency,
      supportedCurrencies: invoiceWithDetails.merchant.supportedCurrencies,
      timezone: invoiceWithDetails.merchant.timezone,
      defaultPaymentTerms: invoiceWithDetails.merchant.defaultPaymentTerms,
      defaultPaymentMethods: invoiceWithDetails.merchant.defaultPaymentMethods,
      invoicePrefix: invoiceWithDetails.merchant.invoicePrefix,
      invoiceTemplateId: invoiceWithDetails.merchant.invoiceTemplateId,
      brandingSettings: invoiceWithDetails.merchant.brandingSettings,
      notificationPreferences:
        invoiceWithDetails.merchant.notificationPreferences,
      featureFlags: invoiceWithDetails.merchant.featureFlags,
      createdAt: toIsoOrNull(invoiceWithDetails.merchant.createdAt)!,
      updatedAt: toIsoOrNull(invoiceWithDetails.merchant.updatedAt),
      deletedAt: toIsoOrNull(invoiceWithDetails.merchant.deletedAt),
    },
  } as any;

  return formatted as InvoiceCompleteAPI;
}

// Helper function to get human-readable description from tax reason code
function getTaxReasonDescription(reasonCode: string): string | null {
  // Find the tax reason code entry by matching snake_case
  const reasonEntry = Object.values(taxReasonCodes).find(
    (entry) => entry.snake_case === reasonCode
  );

  if (reasonEntry) {
    return reasonEntry.short_description;
  }

  // Handle additional exemption reasons that might not be in the tax reason codes
  const additionalReasons: Record<string, string> = {
    nonprofit_organization: "Nonprofit Organization",
    government_entity: "Government Entity",
    educational_institution: "Educational Institution",
    resale: "Resale Certificate",
    other: "Tax Exempt Customer",
    no_nexus: "No Tax Nexus",
    no_manual_rate_configured: "No Tax Rate Configured",
    calculation_error: "Tax Calculation Error",
    missing_state_info: "Missing State Information",
    no_tax_rule: "No Tax Rule Found",
  };

  return additionalReasons[reasonCode] || null;
}

// Helper function to extract tax information from tax line items metadata
function extractTaxInfo(invoice: InvoiceCompleteAPI): {
  exemptionReason: string | null;
  isReverseCharge: boolean;
  reverseChargeMessage: string | null;
  taxReferences: Array<{
    referenceNumber: number;
    shortDescription: string;
    fullDescription: string;
  }>;
} {
  console.log("[extractTaxInfo] Processing invoice tax line items:", {
    taxLineItemsCount: invoice.taxLineItems?.length || 0,
    taxLineItems:
      invoice.taxLineItems?.map((item) => ({
        type: item.type,
        description: item.description,
        subtotalCents: item.subtotalCents,
        taxType: item.taxMetadata?.taxType,
        reasonCode: item.taxMetadata?.reasonCode,
        exemptionReason: item.taxMetadata?.exemptionReason,
      })) || [],
  });

  // If no tax line items, return defaults
  if (!invoice.taxLineItems || invoice.taxLineItems.length === 0) {
    console.log("[extractTaxInfo] No tax line items found");
    return {
      exemptionReason: null,
      isReverseCharge: false,
      reverseChargeMessage: null,
      taxReferences: [],
    };
  }

  const taxReferences: Array<{
    referenceNumber: number;
    shortDescription: string;
    fullDescription: string;
  }> = [];

  let referenceCounter = 1;

  // Look for reverse charge in tax line items
  const reverseChargeItem = invoice.taxLineItems.find(
    (item) => item.taxMetadata.taxType === "reverse_charge"
  );

  if (reverseChargeItem) {
    // Generate reverse charge message based on tax authority/jurisdiction
    let reverseChargeMessage = "EU Reverse Charge";
    if (
      reverseChargeItem.taxMetadata.taxAuthority ||
      reverseChargeItem.taxMetadata.jurisdiction
    ) {
      const jurisdiction =
        reverseChargeItem.taxMetadata.taxAuthority ||
        reverseChargeItem.taxMetadata.jurisdiction;
      reverseChargeMessage = `EU Reverse Charge - ${jurisdiction}`;
    }

    // Create tax reference for reverse charge
    if (reverseChargeItem.taxMetadata.reasonCode) {
      try {
        const reasonCode = reverseChargeItem.taxMetadata
          .reasonCode as keyof typeof taxReasonCodes;
        const reasonInfo = getTaxReasonInfo(reasonCode);
        taxReferences.push({
          referenceNumber: referenceCounter++,
          shortDescription: reasonInfo.short_description,
          fullDescription: reasonInfo.full_description,
        });
      } catch (error) {
        // Fallback if reason code lookup fails
        const exemptionReasonCode =
          reverseChargeItem.taxMetadata.exemptionReason;
        const humanReadableReason = exemptionReasonCode
          ? getTaxReasonDescription(exemptionReasonCode) || exemptionReasonCode
          : "Reverse Charge";

        taxReferences.push({
          referenceNumber: referenceCounter++,
          shortDescription: humanReadableReason,
          fullDescription: reverseChargeMessage,
        });
      }
    }

    // Use proper English description instead of raw code
    const exemptionReasonCode = reverseChargeItem.taxMetadata.exemptionReason;
    const humanReadableReason = exemptionReasonCode
      ? getTaxReasonDescription(exemptionReasonCode) || exemptionReasonCode
      : null;

    return {
      exemptionReason: humanReadableReason,
      isReverseCharge: true,
      reverseChargeMessage,
      taxReferences,
    };
  }

  // Process other tax line items for references
  for (const taxLineItem of invoice.taxLineItems) {
    console.log("[extractTaxInfo] Processing tax line item:", {
      description: taxLineItem.description,
      reasonCode: taxLineItem.taxMetadata.reasonCode,
      taxType: taxLineItem.taxMetadata.taxType,
    });

    if (taxLineItem.taxMetadata.reasonCode) {
      try {
        const reasonCode = taxLineItem.taxMetadata
          .reasonCode as keyof typeof taxReasonCodes;
        const reasonInfo = getTaxReasonInfo(reasonCode);
        console.log("[extractTaxInfo] Got reason info:", {
          reasonCode,
          shortDescription: reasonInfo.short_description,
          fullDescription: reasonInfo.full_description,
        });

        // Only add if not already added (avoid duplicates)
        const alreadyExists = taxReferences.some(
          (ref) => ref.shortDescription === reasonInfo.short_description
        );

        if (!alreadyExists) {
          taxReferences.push({
            referenceNumber: referenceCounter++,
            shortDescription: reasonInfo.short_description,
            fullDescription: reasonInfo.full_description,
          });
          console.log("[extractTaxInfo] Added tax reference:", {
            referenceNumber: referenceCounter - 1,
            shortDescription: reasonInfo.short_description,
          });
        } else {
          console.log(
            "[extractTaxInfo] Skipped duplicate tax reference:",
            reasonInfo.short_description
          );
        }
      } catch (error) {
        console.warn(
          "[extractTaxInfo] Failed to get tax reason info for code:",
          taxLineItem.taxMetadata.reasonCode,
          error
        );
      }
    } else {
      console.log("[extractTaxInfo] Tax line item has no reasonCode");
    }
  }

  console.log("[extractTaxInfo] Final tax references:", taxReferences);

  // Look for any exemption reason in tax line items
  const exemptionReasonCode = invoice.taxLineItems.find(
    (item) => item.taxMetadata.exemptionReason
  )?.taxMetadata.exemptionReason;

  // Convert exemption reason code to human-readable description
  const humanReadableReason = exemptionReasonCode
    ? getTaxReasonDescription(exemptionReasonCode) || exemptionReasonCode
    : null;

  const result = {
    exemptionReason: humanReadableReason,
    isReverseCharge: false,
    reverseChargeMessage: null,
    taxReferences,
  };

  console.log("[extractTaxInfo] Returning result:", result);
  return result;
}

/**
 * Processes invoice data and generates PDF documents for each invoice.
 * This function handles the core PDF generation logic, converting invoice data into PDF buffers.
 *
 * @param invoices Array of invoice objects with complete data (including customer and merchant details)
 * @returns An object containing success/failure counts and array of generated PDF results (including buffers)
 */
export async function processInvoicePdfGeneration(
  invoices: InvoiceCompleteAPI[]
) {
  // Track results for reporting
  const results = {
    success: 0,
    failed: 0,
    generatedPdfs: [] as Array<{
      invoiceId: string;
      status: "success" | "failed";
      error?: string;
      pdfBuffer: Buffer | null;
      fileName: string;
      invoiceNumber: string;
      pdfData: InvoiceData | null;
    }>,
  };

  // Process each invoice
  for (const invoice of invoices) {
    let invoiceId = invoice?.id || "unknown";
    let pdfData: InvoiceData | null = null;

    try {
      // Validate the invoice has required fields
      if (!invoice || !invoice.id) {
        throw new Error("Invalid invoice data: missing ID");
      }

      if (
        !invoice.lineItems ||
        !Array.isArray(invoice.lineItems) ||
        invoice.lineItems.length === 0
      ) {
        throw new Error("Invalid invoice data: missing or empty line items");
      }

      invoiceId = invoice.id;

      // Generate safe invoice number, ensuring it exists
      const invoiceNumber =
        invoice.customerInvoiceNumber && invoice.customerInvoiceNumber.trim()
          ? invoice.customerInvoiceNumber.trim()
          : `INV-${invoiceId.substring(0, 8)}`;

      // Helper to compute subtotal for a line item when the explicit subtotal is missing
      const lineItemSubtotal = (li: InvoiceLineItemAPI): number => {
        if (typeof li.subtotalCents === "number") return li.subtotalCents;

        const qty =
          typeof li.quantity === "number" && !isNaN(li.quantity)
            ? li.quantity
            : 1;
        const unit =
          typeof li.unitAmountCents === "number" ? li.unitAmountCents : 0;
        return qty * unit;
      };

      const computedSubtotalCents =
        typeof invoice.subtotalCents === "number"
          ? invoice.subtotalCents
          : invoice.lineItems
              .filter((li: InvoiceLineItemAPI) => li.type !== "tax")
              .reduce((acc, li) => acc + lineItemSubtotal(li), 0);

      // Derive tax if not provided: sum taxLineItems.subtotalCents when available, else 0
      const computedTaxAmountCents =
        typeof invoice.taxAmountCents === "number"
          ? invoice.taxAmountCents
          : (invoice.taxLineItems || []).reduce(
              (acc, tl) =>
                acc +
                (typeof tl.subtotalCents === "number" ? tl.subtotalCents : 0),
              0
            );

      const computedTotalAmountCents =
        typeof invoice.totalAmountCents === "number"
          ? invoice.totalAmountCents
          : computedSubtotalCents + computedTaxAmountCents;

      // Format dates exactly like the UI preview
      const formatDateForUI = (
        dateString: string | null | undefined
      ): string => {
        if (!dateString) return "N/A";

        try {
          const date = new Date(dateString);
          if (isNaN(date.getTime())) return "N/A";

          return date.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          });
        } catch {
          return "N/A";
        }
      };

      // Ensure we have a consistent list of tax line items for downstream helpers
      const normalizedTaxLineItems = (
        invoice.taxLineItems && invoice.taxLineItems.length > 0
          ? invoice.taxLineItems
          : invoice.lineItems
              .filter((li: any) => li.type === "tax")
              .map((li: any) => ({
                type: "tax" as const,
                description: li.description,
                subtotalCents: li.subtotalCents,
                taxMetadata: li.taxMetadata || {},
                billingPeriodStart: li.billingPeriodStart
                  ? new Date(li.billingPeriodStart)
                  : new Date(),
                billingPeriodEnd: li.billingPeriodEnd
                  ? new Date(li.billingPeriodEnd)
                  : new Date(),
              }))
      ) as TaxLineItemAPI[];

      // Clone invoice with normalizedTaxLineItems so extractTaxInfo can inspect
      const invoiceForTax = {
        ...invoice,
        taxLineItems: normalizedTaxLineItems,
      } as InvoiceCompleteAPI;

      // Create invoice data exactly like the UI preview
      const taxInfo = extractTaxInfo(invoiceForTax);
      console.log("[processInvoicePdfGeneration] Tax info extracted:", {
        exemptionReason: taxInfo.exemptionReason,
        isReverseCharge: taxInfo.isReverseCharge,
        taxReferencesCount: taxInfo.taxReferences.length,
        taxReferences: taxInfo.taxReferences,
      });

      pdfData = {
        customer: invoice.customer,
        invoiceNumber,
        items: invoice.lineItems
          .filter((item: InvoiceLineItemAPI) => item.type !== "tax")
          .map((item: InvoiceLineItemAPI) => {
            // Determine quantity & unit price intelligently
            const qty =
              typeof item.quantity === "number" && !isNaN(item.quantity)
                ? item.quantity
                : 1;

            // Prefer provided unit amount; otherwise derive from subtotal/qty
            const unit =
              typeof item.unitAmountCents === "number" &&
              !isNaN(item.unitAmountCents)
                ? item.unitAmountCents
                : typeof item.subtotalCents === "number"
                  ? Math.round(item.subtotalCents / qty)
                  : 0;

            // Handle per_unit (seat-based) line items with improved descriptions
            let description = item.description || "Unknown Item";
            if (item.type === "per_unit") {
              // For per_unit items, create a cleaner description
              // Extract the unit price from the original description if possible
              const unitPriceMatch = description.match(/([€$][\d,]+\.?\d*)/);
              const unitPrice = unitPriceMatch
                ? unitPriceMatch[1]
                : `${invoice.currency === "USD" ? "$" : "€"}${(unit / 100).toFixed(2)}`;

              // Extract the period from the description (per month, per year, etc.)
              const periodMatch = description.match(
                /per (month|year|week|day)/i
              );
              const period = periodMatch
                ? periodMatch[1].toLowerCase()
                : "month";

              // Create a cleaner description for seat-based pricing
              description = `${unitPrice} per seat per ${period}`;

              // Add billing period information if available
              if (item.billingPeriodStart && item.billingPeriodEnd) {
                const startDate = new Date(item.billingPeriodStart);
                const endDate = new Date(item.billingPeriodEnd);
                const formatDate = (date: Date) =>
                  date.toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  });
                description += ` (${formatDate(startDate)} - ${formatDate(endDate)})`;
              }
            }

            return {
              description,
              quantity: qty,
              unitAmountCents: unit,
            };
          }),
        merchant: invoice.merchant,
        dueDate: formatDateForUI(invoice.dueDate),
        issueDate: formatDateForUI(invoice.issueDate),
        currency: invoice.currency as "USD" | "EUR" | undefined,
        // Include tax data for enhanced PDF display
        subtotalCents: computedSubtotalCents,
        taxAmountCents: computedTaxAmountCents,
        totalAmountCents: computedTotalAmountCents,
        effectiveTaxRate: invoice.effectiveTaxRate,
        taxJurisdiction: invoice.taxJurisdiction,
        taxCalculationMethod: invoice.taxCalculationMethod,
        // Derive exemption reason from tax data
        exemptionReason: taxInfo.exemptionReason || undefined,
        // Add reverse charge information
        isReverseCharge: taxInfo.isReverseCharge,
        reverseChargeMessage: taxInfo.reverseChargeMessage || undefined,
        // Add tax line item descriptions from actual tax line items
        taxLineItemDescriptions: normalizedTaxLineItems.map(
          (item) => item.description
        ),
        taxReferences: taxInfo.taxReferences, // Add tax references to pdfData
        notes: invoice.notes === null ? undefined : invoice.notes, // Add notes for payment link handling
        documentType: (invoice.documentType as any) || "standard",
        originalInvoiceNumber:
          invoice.originalInvoiceNumber ||
          (invoice.originalInvoiceId ? invoice.originalInvoiceId : undefined),
        originalIssueDate: invoice.originalIssueDate || undefined,
        adjustmentReason:
          (invoice.cancellationOrCreditReason as any) || undefined,
      };

      console.log("[processInvoicePdfGeneration] Created PDF data:", {
        invoiceId,
        taxReferencesCount: pdfData!.taxReferences?.length || 0,
        taxReferences: pdfData!.taxReferences,
        taxLineItemDescriptions: pdfData!.taxLineItemDescriptions,
      });

      console.log("Attempting to generate PDF for invoice:", invoiceId);

      let pdfBlob: Blob | null = null;
      if (
        process.env.NODE_ENV === "development" &&
        !process.env.GENERATE_PDFS // Set this env var to see PDFs locally
      ) {
        // Development code path
        pdfBlob = await pdf(
          <Document>
            <Page size="A4">
              <Text>
                Mock PDF: If you want to generate full PDFs locally, set the
                GENERATE_PDFS environment variable to true in /api/.env
              </Text>
            </Page>
          </Document>
        ).toBlob();
      } else {
        // Production code path
        pdfBlob = await pdf(<InvoiceDocument data={pdfData!} />).toBlob();
      }
      const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
      console.log("Successfully generated PDF buffer for invoice:", invoiceId);

      const pdfFileName = `invoices/${invoiceId}.pdf`;

      results.success++;
      results.generatedPdfs.push({
        invoiceId,
        status: "success",
        pdfBuffer,
        fileName: pdfFileName,
        invoiceNumber: pdfData!.invoiceNumber || "",
        pdfData: pdfData,
      });
    } catch (error) {
      console.error("Failed to generate PDF for invoice:", invoiceId, error);
      results.failed++;
      results.generatedPdfs.push({
        invoiceId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        pdfBuffer: null,
        fileName: "",
        invoiceNumber: pdfData?.invoiceNumber || "",
        pdfData: null,
      });
    }
  }

  console.log("Final results:", {
    success: results.success,
    failed: results.failed,
    totalInvoices: invoices.length,
  });

  return results;
}
