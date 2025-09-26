import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/client";
import {
  invoices,
  invoiceLineItems,
  invoiceInsertSchemaReq,
  invoiceUpdateSchemaReq,
  paymentRetries,
  payments,
  paymentMethods,
  subscriptionDetails,
} from "@lumen/common/schema";
import { and, eq, desc, count, inArray, isNull } from "drizzle-orm";
import {
  generatePresignedUrl,
  extractBucketAndKeyFromUrl,
} from "../helpers/s3";
import {
  getAndIncrementInvoiceCounter,
  formatCustomerInvoiceNumber,
  triggerInvoicePdfGeneration,
} from "../helpers/billing";
import { retryInvoicePayment } from "../helpers/paymentprovider";

const listInvoicesSchema = z
  .object({
    customerId: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().optional().default(20),
    offset: z.number().optional().default(0),
  })
  .optional();

const getSubtotalCents = ({
  quantity,
  unitAmountCents,
}: {
  quantity?: number | null;
  unitAmountCents?: number | null;
}) => {
  return (quantity || 1) * (unitAmountCents || 0); // TODO: Fix when we support per_unit pricing
};

const getTotalAmountCents = (
  lineItems: {
    quantity?: number | null;
    unitAmountCents?: number | null;
  }[]
) => {
  return lineItems.reduce(
    (acc, item) =>
      acc +
      getSubtotalCents({
        quantity: item.quantity,
        unitAmountCents: item.unitAmountCents,
      }),
    0
  );
};

/**
 * Helper function to extract tax line item descriptions from invoice line items
 */
const extractTaxLineItemDescriptions = (lineItems: any[]) => {
  console.log("[extractTaxLineItemDescriptions] Processing line items:", {
    totalLineItems: lineItems.length,
    lineItemTypes: lineItems.map((item) => ({
      type: item.type,
      description: item.description,
    })),
  });

  const taxLineItems = lineItems.filter((item) => item.type === "tax");
  const descriptions = taxLineItems.map((item) => item.description);

  console.log("[extractTaxLineItemDescriptions] Extracted tax descriptions:", {
    taxLineItemsCount: taxLineItems.length,
    descriptions: descriptions,
    taxLineItems: taxLineItems.map((item) => ({
      type: item.type,
      description: item.description,
      subtotalCents: item.subtotalCents,
      taxMetadata: item.taxMetadata,
    })),
  });

  return descriptions;
};

/**
 * Router for managing invoices
 */
export const invoicesRouter = new Hono()
  // Get all invoices for a merchant with optional filtering
  .get("/", zValidator("query", listInvoicesSchema), async (c) => {
    try {
      const { customerId, status, limit, offset } = c.req.valid("query") || {};
      const merchantId = c.get("merchant")!.id;

      // Build the where clause
      let whereClause = and(eq(invoices.merchantId, merchantId));

      // Add optional filters
      if (customerId) {
        whereClause = and(whereClause, eq(invoices.customerId, customerId));
      }

      if (status) {
        whereClause = and(whereClause, eq(invoices.status, status));
      }

      // Query invoices with related data
      const invoicesList = await db.query.invoices.findMany({
        where: whereClause,
        with: {
          customer: true,
          subscription: {
            with: {
              plan: true,
            },
          },
          lineItems: true,
          payment: true,
          originalInvoice: true,
        },
        limit,
        offset,
        orderBy: [desc(invoices.createdAt)],
      });

      // Don't expose the actual PDF URL in the response
      // Instead, just indicate if a PDF is available
      const invoicesWithPdfStatus = invoicesList.map((invoice) => ({
        ...invoice,
        hasPdf: Boolean(invoice.pdfUrl),
        taxLineItemDescriptions: extractTaxLineItemDescriptions(
          invoice.lineItems || []
        ),
      }));

      // Get total count for pagination
      const totalCount = await db
        .select({ count: count() })
        .from(invoices)
        .where(whereClause);

      return c.json({
        invoices: invoicesWithPdfStatus,
        pagination: {
          total: Number(totalCount[0].count),
          limit,
          offset,
        },
      });
    } catch (error) {
      console.error("Error fetching invoices:", error);
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to fetch invoices",
        },
        500
      );
    }
  })

  // Get a single invoice by ID
  .get("/:id", async (c) => {
    try {
      const invoiceId = c.req.param("id");
      const merchantId = c.get("merchant")!.id;

      // Get invoice with all related data
      const invoice = await db.query.invoices.findFirst({
        where: and(
          eq(invoices.id, invoiceId),
          eq(invoices.merchantId, merchantId)
        ),
        with: {
          customer: true,
          merchant: true,
          subscription: {
            with: {
              plan: true,
            },
          },
          lineItems: true,
          payment: true,
          originalInvoice: true,
        },
      });

      if (!invoice) {
        return c.json({ error: "Invoice not found" }, 404);
      }

      // Don't expose the actual PDF URL, just indicate if a PDF is available
      const invoiceWithPdfStatus: any = {
        ...invoice,
        hasPdf: Boolean(invoice.pdfUrl),
        pdfUrl: undefined, // Remove the actual URL
        taxLineItemDescriptions: extractTaxLineItemDescriptions(
          invoice.lineItems || []
        ),
      };
      // Find adjustment invoices that reference this invoice
      const adjustments = await db.query.invoices.findMany({
        where: and(
          eq(invoices.merchantId, merchantId),
          eq(invoices.originalInvoiceId, invoiceId)
        ),
        with: {
          customer: true,
        },
        orderBy: [desc(invoices.createdAt)],
      });

      return c.json({
        invoice: {
          ...invoiceWithPdfStatus,
          adjustmentInvoices: adjustments.map((inv) => ({
            id: inv.id,
            customerInvoiceNumber: inv.customerInvoiceNumber,
            documentType: (inv as any).documentType,
            totalAmountCents: inv.totalAmountCents,
            currency: inv.currency,
            issueDate: inv.issueDate,
            hasPdf: Boolean(inv.pdfUrl),
          })),
        },
      });
    } catch (error) {
      console.error("Error fetching invoice:", error);
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to fetch invoice",
        },
        500
      );
    }
  })

  // Get invoices for a specific customer
  .get("/customer/:customerId", async (c) => {
    try {
      const customerId = c.req.param("customerId");
      const merchantId = c.get("merchant")!.id;

      // Get invoices for this customer
      const customerInvoices = await db.query.invoices.findMany({
        where: and(
          eq(invoices.customerId, customerId),
          eq(invoices.merchantId, merchantId)
        ),
        with: {
          lineItems: true,
          payment: true,
          originalInvoice: true,
        },
        orderBy: [desc(invoices.createdAt)],
      });

      // Don't expose the actual PDF URL, just indicate if a PDF is available
      const invoicesWithPdfStatus = customerInvoices.map((invoice) => ({
        ...invoice,
        hasPdf: Boolean(invoice.pdfUrl),
        pdfUrl: undefined, // Remove the actual URL
        taxLineItemDescriptions: extractTaxLineItemDescriptions(
          invoice.lineItems || []
        ),
      }));

      return c.json({ invoices: invoicesWithPdfStatus });
    } catch (error) {
      console.error("Error fetching customer invoices:", error);
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch customer invoices",
        },
        500
      );
    }
  })

  // Get a presigned URL for accessing the invoice PDF
  .get("/:id/pdf", async (c) => {
    try {
      const invoiceId = c.req.param("id");
      const merchantId = c.get("merchant")!.id;

      // Get invoice to check if it belongs to this merchant and has a PDF URL
      const invoice = await db.query.invoices.findFirst({
        where: and(
          eq(invoices.id, invoiceId),
          eq(invoices.merchantId, merchantId)
        ),
        columns: {
          id: true,
          pdfUrl: true,
          customerInvoiceNumber: true,
        },
      });

      if (!invoice) {
        return c.json({ error: "Invoice not found" }, 404);
      }

      if (!invoice.pdfUrl) {
        return c.json({ error: "No PDF available for this invoice" }, 404);
      }

      // Extract bucket and key from the stored URL
      const bucketAndKey = extractBucketAndKeyFromUrl(invoice.pdfUrl);
      if (!bucketAndKey) {
        return c.json({ error: "Failed to get file info" }, 500);
      }

      // Generate a presigned URL that expires in 15 minutes (900 seconds)
      const presignedUrl = await generatePresignedUrl(bucketAndKey.key, 900);

      return c.json({
        invoice: {
          id: invoice.id,
          customerInvoiceNumber: invoice.customerInvoiceNumber,
        },
        pdfUrl: presignedUrl,
        expiresIn: 900, // 15 minutes in seconds
      });
    } catch (error) {
      console.error("Error generating presigned URL for invoice PDF:", error);
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to generate PDF access URL",
        },
        500
      );
    }
  })
  // Manual retry endpoint for unpaid invoices
  .post("/:id/retry-payment", async (c) => {
    try {
      const invoiceId = c.req.param("id");
      const merchantId = c.get("merchant")!.id;

      // Ensure the invoice belongs to this merchant and is not paid
      const invoice = await db.query.invoices.findFirst({
        where: and(
          eq(invoices.id, invoiceId),
          eq(invoices.merchantId, merchantId)
        ),
        with: { customer: true },
      });

      if (!invoice) {
        return c.json({ error: "Invoice not found" }, 404);
      }

      if (invoice.status === "paid") {
        return c.json({ success: true, message: "Invoice already paid" }, 200);
      }

      // Compute next attempt number for this invoice
      const lastRetry = await db.query.paymentRetries.findFirst({
        where: eq(paymentRetries.invoiceId, invoiceId),
        orderBy: (paymentRetries, { desc }) => [
          desc(paymentRetries.attemptNumber),
        ],
      });
      const attemptNumber = (lastRetry?.attemptNumber || 0) + 1;

      // Find or create a payment record for this invoice
      let existingPayment = await db.query.payments.findFirst({
        where: eq(payments.invoiceId, invoiceId),
        orderBy: (payments, { desc }) => [desc(payments.createdAt)],
      });

      if (!existingPayment) {
        // Get customer's latest payment method if available
        // Prefer subscription's configured payment method, fallback to most recently used
        let pm: typeof paymentMethods.$inferSelect | null = null;
        if (invoice.subscriptionId) {
          const sd = await db.query.subscriptionDetails.findFirst({
            where: and(
              eq(subscriptionDetails.subscriptionId, invoice.subscriptionId),
              isNull(subscriptionDetails.deletedAt)
            ),
          });
          if (sd?.paymentMethodId) {
            const found = await db.query.paymentMethods.findFirst({
              where: and(
                eq(paymentMethods.id, sd.paymentMethodId),
                isNull(paymentMethods.deletedAt)
              ),
            });
            pm = found ?? null;
          }
        }
        if (!pm) {
          const found = await db.query.paymentMethods.findFirst({
            where: and(
              eq(paymentMethods.customerId, invoice.customerId),
              isNull(paymentMethods.deletedAt)
            ),
            orderBy: (paymentMethods, { desc }) => [
              desc(paymentMethods.lastUsedAt),
            ],
          });
          pm = found ?? null;
        }
        const [created] = await db
          .insert(payments)
          .values({
            merchantId: merchantId,
            invoiceId: invoiceId,
            paymentMethodId: pm ? pm.id : null,
            amountCents: invoice.totalAmountCents || 0,
            currency: invoice.currency,
            status: "pending",
          })
          .returning();
        existingPayment = created;
      }

      // Create retry record as pending so webhook can update it
      const [retryRecord] = await db
        .insert(paymentRetries)
        .values({
          paymentId: existingPayment.id,
          invoiceId,
          attemptNumber,
          status: "pending",
        })
        .returning();

      // Delegate to existing retry helper which triggers PSP attempt
      const result = await retryInvoicePayment({
        invoiceId,
        paymentRetryId: retryRecord.id,
        attemptNumber,
      });

      return c.json({
        success: result.queued,
        message:
          result.message ||
          (result.queued ? "Retry queued" : "Failed to queue retry"),
        attemptNumber,
        paymentId: result.paymentId,
      });
    } catch (error) {
      console.error("Error retrying invoice payment:", error);
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to retry payment",
        },
        500
      );
    }
  })
  .post(
    "/",
    zValidator(
      "json",
      invoiceInsertSchemaReq.extend({
        manualTaxDescription: z.string().optional(),
      })
    ),
    async (c) => {
      const merchantId = c.get("merchant")!.id;
      const data = c.req.valid("json");

      try {
        const invoice = await db.transaction(async (tx) => {
          // Calculate subtotal from line items
          const subtotalCents = getTotalAmountCents(data.lineItems || []);

          // Use provided tax information or default to zero
          const taxAmountCents = data.taxAmountCents || 0;
          const totalAmountCents =
            data.totalAmountCents || subtotalCents + taxAmountCents;

          let customerInvoiceNumber = data.customerInvoiceNumber;

          // If status is issued, generate a proper invoice number
          if (data.status === "issued") {
            const sequenceNumber = await getAndIncrementInvoiceCounter(
              tx,
              merchantId,
              data.customerId
            );

            // Use first 6 chars after prefix cus_ as prefix
            const prefix = data.customerId.startsWith("cus_")
              ? data.customerId.slice(4, 10)
              : data.customerId.slice(0, 6);

            customerInvoiceNumber = formatCustomerInvoiceNumber(
              prefix,
              sequenceNumber
            );
          }

          const [invoice] = await tx
            .insert(invoices)
            .values({
              ...data,
              merchantId,
              customerInvoiceNumber,
              issueDate: data.issueDate ? new Date(data.issueDate) : undefined,
              dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
              subtotalCents,
              taxAmountCents,
              totalAmountCents,
              effectiveTaxRate: data.effectiveTaxRate || "0",
              taxJurisdiction: data.taxJurisdiction || null,
              taxCalculationMethod: data.taxCalculationMethod || null,
            })
            .returning();

          // Create line items for charges
          if (data.lineItems) {
            await tx.insert(invoiceLineItems).values(
              data.lineItems.map((item) => ({
                ...item,
                invoiceId: invoice.id,
                subtotalCents: getSubtotalCents({
                  quantity: item.quantity,
                  unitAmountCents: item.unitAmountCents,
                }),
              }))
            );
          }

          // Create tax line item if tax is applied
          if (taxAmountCents > 0 || data.taxCalculationMethod === "exempt") {
            const taxLineItem = {
              invoiceId: invoice.id,
              type: "tax" as const,
              description:
                data.taxCalculationMethod === "manual" &&
                data.manualTaxDescription
                  ? `Tax: ${data.manualTaxDescription}`
                  : data.taxCalculationMethod === "exempt"
                    ? "Tax (Exempt)"
                    : `Tax (${(parseFloat(data.effectiveTaxRate || "0") * 100).toFixed(2)}%)`,
              quantity: 1,
              unitAmountCents: taxAmountCents,
              subtotalCents: taxAmountCents,
              billingPeriodStart: data.issueDate
                ? new Date(data.issueDate)
                : new Date(),
              billingPeriodEnd: data.dueDate
                ? new Date(data.dueDate)
                : new Date(),
              taxMetadata: {
                taxType:
                  data.taxCalculationMethod === "exempt"
                    ? "exempt"
                    : data.taxCalculationMethod || "manual",
                taxRate: parseFloat(data.effectiveTaxRate || "0"),
                jurisdiction: data.taxJurisdiction || "manual",
                rateSource:
                  data.taxCalculationMethod === "manual"
                    ? "manual_entry"
                    : "default",
                ...(data.taxCalculationMethod === "exempt" && {
                  exemptionReason: "other",
                }),
                ...(data.taxCalculationMethod === "manual" &&
                  data.manualTaxDescription && {
                    fullDescription: `Manual Tax: ${data.manualTaxDescription}`,
                  }),
              },
            };

            await tx.insert(invoiceLineItems).values([taxLineItem]);
          }

          // After invoice + line items commit, trigger PDF generation asynchronously
          try {
            const invoiceWithDetails = await tx.query.invoices.findFirst({
              where: eq(invoices.id, invoice.id),
              with: {
                customer: true,
                merchant: true,
                subscription: {
                  with: { plan: true },
                },
                lineItems: true,
                payment: true,
              },
            });

            if (invoiceWithDetails) {
              await triggerInvoicePdfGeneration(invoiceWithDetails, tx);
            }
          } catch (err) {
            console.error("Failed to trigger PDF generation", err);
          }

          return invoice;
        });
        return c.json(invoice, 201);
      } catch (error) {
        console.error("Error creating invoice:", error);
        return c.json({ error: "Failed to create invoice" }, 500);
      }
    }
  )
  .post("/:id", zValidator("json", invoiceUpdateSchemaReq), async (c) => {
    try {
      const invoiceId = c.req.param("id");
      const merchantId = c.get("merchant")!.id;

      // Get invoice with all related data
      const existingInvoice = await db.query.invoices.findFirst({
        where: and(
          eq(invoices.id, invoiceId),
          eq(invoices.merchantId, merchantId)
        ),
      });

      if (!existingInvoice) {
        return c.json({ error: "Invoice not found" }, 404);
      }

      if (existingInvoice.status !== "draft") {
        return c.json(
          {
            error: `Cannot update non-draft invoice. Current status: ${existingInvoice.status}`,
          },
          400
        );
      }

      const { status, issueDate, dueDate, lineItems, deletedLineItemIds } =
        c.req.valid("json");

      const invoice = await db.transaction(async (tx) => {
        let invoice = existingInvoice;
        if (status || issueDate || dueDate || lineItems) {
          const [updatedInvoice] = await tx
            .update(invoices)
            .set({
              status: status ? status : undefined,
              issueDate: issueDate ? new Date(issueDate) : undefined,
              dueDate: dueDate ? new Date(dueDate) : undefined,
              totalAmountCents: lineItems?.length
                ? getTotalAmountCents(lineItems)
                : undefined,
            })
            .where(
              and(
                eq(invoices.id, invoiceId),
                eq(invoices.merchantId, merchantId)
              )
            )
            .returning();
          if (updatedInvoice) {
            invoice = updatedInvoice;
          }
        }

        if (lineItems) {
          lineItems.forEach(async (item) => {
            const value = {
              ...item,
              invoiceId,
              subtotalCents: getSubtotalCents({
                quantity: item.quantity,
                unitAmountCents: item.unitAmountCents,
              }),
            };
            if (item.id) {
              await tx
                .update(invoiceLineItems)
                .set(value)
                .where(eq(invoiceLineItems.id, item.id));
            } else {
              await tx.insert(invoiceLineItems).values(value);
            }
          });
        }
        if (deletedLineItemIds?.length && invoice.status === "draft") {
          await tx
            .delete(invoiceLineItems)
            .where(inArray(invoiceLineItems.id, deletedLineItemIds));
        }

        return invoice;
      });

      if (!invoice) {
        return c.json({ error: "Failed to update invoice" }, 500);
      }
      return c.json(invoice, 200);
    } catch (error) {
      console.error("Error fetching invoice:", error);
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to fetch invoice",
        },
        500
      );
    }
  });

export default invoicesRouter;
