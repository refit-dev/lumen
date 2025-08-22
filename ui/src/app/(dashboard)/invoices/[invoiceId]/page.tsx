"use client";

import { useAppForm } from "@/hooks/form";
import { apiClient } from "@/lib/hono-client";
import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import {
  ArrowLeft,
  Copy,
  Trash2,
  Loader2,
  Plus,
  X,
  DollarSign,
  Calendar,
  User,
  Mail,
  Phone,
  MapPin,
  Receipt,
  AlertCircle,
  CheckCircle,
  XCircle,
  Clock,
  FileText,
  CreditCard,
  Eye,
  Download,
  ExternalLink,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import {
  parseStringToCents,
  formatCentsToString,
} from "@/components/form/Number2DecimalsField";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";
import {
  formatCurrency,
  supportedCustomerCountries,
} from "@lumen/common/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import Link from "next/link";

const removeFalsyValuesFromObject = (obj: Record<string, unknown>) => {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => !!value));
};

// Helper function to get the appropriate tax ID label based on customer's country
const getTaxIdLabel = (customer: { billingCountry?: string }) => {
  if (!customer.billingCountry) {
    return "Tax ID"; // Default fallback
  }

  const countryConfig = supportedCustomerCountries.find(
    (c) => c.value === customer.billingCountry
  );

  return countryConfig?.taxLabel || "Tax ID";
};

// Helper function to extract tax information from tax line items - simplified
const extractTaxInfo = (invoice: Invoice) => {
  console.log("[extractTaxInfo] Processing invoice:", {
    invoiceId: invoice.id,
    taxCalculationMethod: invoice.taxCalculationMethod,
    taxLineItemDescriptions: invoice.taxLineItemDescriptions,
    lineItemsCount: invoice.lineItems?.length || 0,
    taxLineItemsCount:
      invoice.lineItems?.filter((item) => item.type === "tax").length || 0,
  });

  // Extract tax line items from invoice
  const taxLineItems =
    invoice.lineItems?.filter(
      (item) => (item.type || "").toLowerCase() === "tax"
    ) || [];

  console.log(
    "[extractTaxInfo] Tax line items found:",
    taxLineItems.map((item) => ({
      description: item.description,
      type: item.type,
      taxMetadata: item.taxMetadata,
    }))
  );

  const taxReferences: Array<{
    referenceNumber: number;
    fullDescription: string;
  }> = [];

  let referenceCounter = 1;

  // Extract tax references from line items taxMetadata
  for (const taxLineItem of taxLineItems) {
    console.log("[extractTaxInfo] Processing tax line item:", {
      description: taxLineItem.description,
      taxMetadata: taxLineItem.taxMetadata,
    });

    if (taxLineItem.taxMetadata?.fullDescription) {
      // Only add if not already added (avoid duplicates)
      const alreadyExists = taxReferences.some(
        (ref) =>
          ref.fullDescription === taxLineItem.taxMetadata!.fullDescription
      );

      if (!alreadyExists) {
        taxReferences.push({
          referenceNumber: referenceCounter++,
          fullDescription: taxLineItem.taxMetadata.fullDescription,
        });
        console.log("[extractTaxInfo] Added tax reference:", {
          referenceNumber: referenceCounter - 1,
          fullDescription: taxLineItem.taxMetadata.fullDescription,
        });
      }
    }
  }

  // Use API-provided tax line item descriptions if available, otherwise fall back to line item descriptions
  const taxLineItemDescriptions = invoice.taxLineItemDescriptions?.length
    ? invoice.taxLineItemDescriptions
    : taxLineItems.map((item) => item.description);

  const result = {
    taxReferences,
    taxLineItemDescriptions,
  };

  console.log("[extractTaxInfo] Final result:", result);
  return result;
};

type InvoiceItem = {
  id?: string;
  description: string;
  quantity: number;
  unitAmountCents: number;
  type?: string | null;
  taxMetadata?: {
    taxAuthority?: string;
    taxType?: string;
    jurisdiction?: string;
    taxRate?: number;
    rateSource?: string;
    exemptionReason?: string;
    reasonCode?: number;
    fullDescription?: string;
  } | null;
};

type Invoice = {
  id: string;
  issueDate: string;
  dueDate: string;
  customerId: string;
  currency: string;
  status: string;
  customerInvoiceNumber?: string;
  notes?: string;
  lineItems?: Array<{
    id: string;
    description: string;
    quantity: number;
    unitAmountCents: number;
    type?: string | null;
    taxMetadata?: {
      taxAuthority?: string;
      taxType?: string;
      jurisdiction?: string;
      taxRate?: number;
      rateSource?: string;
      exemptionReason?: string;
      reasonCode?: number;
      fullDescription?: string;
    } | null;
  }>;
  totalAmountCents?: number;
  taxAmountCents?: number;
  subtotalCents?: number | null;
  effectiveTaxRate?: string | null;
  taxJurisdiction?: string | null;
  taxCalculationMethod?: string | null;
  taxLineItemDescriptions?: string[]; // API-provided tax descriptions
  hasPdf?: boolean;
  subscription?: {
    id: string;
    stableSubscriptionId: string;
    plan?: {
      planName: string;
    } | null;
  } | null;
  payment?: {
    id: string;
    status: string;
    amountCents: number;
    currency: string;
    paymentMethodId: string;
    externalPaymentId: string | null;
    createdAt: string;
    errorMessage: string | null;
    refundedAmountCents: number | null;
    refundStatus: string | null;
  } | null;
  customer?: {
    id: string;
    name?: string;
    email?: string;
    billingCountry?: string;
    billingCity?: string;
    billingAddressLine1?: string;
    billingAddressLine2?: string;
    billingPostalCode?: string;
    phone?: string;
    taxId?: string;
    // Additional tax-related fields
    businessName?: string;
    taxExempt?: boolean;
    taxExemptionReason?: string;
    taxExemptionCertificate?: string;
    taxCalculationMethod?: string;
    billingStateProvince?: string;
  };
};

// Helper functions
const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "paid":
      return "bg-green-100 text-green-800 border-green-200 hover:bg-green-200";
    case "draft":
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
    case "void":
      return "bg-red-100 text-red-800 border-red-200 hover:bg-red-200";
    case "pending":
      return "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200";
    case "overdue":
      return "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toLowerCase()) {
    case "paid":
      return <CheckCircle className="w-4 h-4" />;
    case "void":
      return <XCircle className="w-4 h-4" />;
    case "pending":
    case "draft":
      return <Clock className="w-4 h-4" />;
    case "overdue":
      return <AlertCircle className="w-4 h-4" />;
    default:
      return <FileText className="w-4 h-4" />;
  }
};

const calculateInvoiceTotal = (lineItems: InvoiceItem[]) => {
  return lineItems.reduce((total, item) => {
    return total + item.quantity * item.unitAmountCents;
  }, 0);
};

// Component to render notes with special handling for checkout links
function NotesRenderer({ notes }: { notes: string }) {
  // Check if notes contain a checkout link
  const checkoutLinkMatch = notes.match(
    /https:\/\/checkout\.stripe\.com\/[^\s]+/
  );

  if (checkoutLinkMatch) {
    const checkoutLink = checkoutLinkMatch[0];
    const beforeLink = notes.substring(0, checkoutLinkMatch.index);
    const afterLink = notes.substring(
      checkoutLinkMatch.index! + checkoutLink.length
    );

    // Check if this is a payment completion note vs payment required note
    const isPaid = notes.includes("Paid online via checkout session");
    const isPaymentRequired = notes.includes("Payment required:");

    if (isPaid) {
      // For paid invoices, show a completed payment indicator
      return (
        <div className="text-sm font-medium space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-600" />
            <span className="text-green-700 font-semibold">
              Payment Completed
            </span>
          </div>
          <p className="text-muted-foreground text-xs">
            This invoice was paid online via Stripe checkout.
          </p>
        </div>
      );
    } else if (isPaymentRequired) {
      // For payment required notes, show information for merchant view
      return (
        <div className="text-sm font-medium space-y-3">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-orange-600" />
            <span className="text-orange-700 font-semibold">
              Payment Required
            </span>
          </div>
          <p className="text-muted-foreground text-xs mb-3">
            Customer payment link has been provided. Payment can be completed
            at:
          </p>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-mono">
                Stripe Checkout Link
              </span>
              <Button size="sm" variant="outline" asChild className="text-xs">
                <a
                  href={checkoutLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="w-3 h-3 mr-1" />
                  View Link
                </a>
              </Button>
            </div>
          </div>
        </div>
      );
    } else {
      // Generic case: just make the link clickable
      return (
        <p className="text-sm font-medium">
          {beforeLink}
          <a
            href={checkoutLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline font-medium inline-flex items-center gap-1"
          >
            Pay Online
            <ExternalLink className="w-3 h-3" />
          </a>
          {afterLink}
        </p>
      );
    }
  }

  // For notes without checkout links, render as plain text
  return <p className="text-sm font-medium whitespace-pre-wrap">{notes}</p>;
}

function UnitPriceInput({
  initialValue,
  onChange,
}: {
  initialValue: number;
  onChange: (val: number) => void;
}) {
  const [displayValue, setDisplayValue] = useState(
    formatCentsToString(initialValue)
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // Allow only numbers, a single decimal point, and up to 2 decimal places
    if (value === "" || /^\d*\.?\d{0,2}$/.test(value)) {
      setDisplayValue(value);
      if (value === "") {
        onChange(0);
      } else {
        const cents = parseStringToCents(value);
        onChange(cents);
      }
    }
  };

  return (
    <div>
      <Input
        type="text"
        inputMode="decimal"
        pattern="\d*\.?\d{0,2}"
        placeholder="0.00"
        value={displayValue}
        onChange={handleChange}
        className="h-9 text-right"
      />
    </div>
  );
}

const invoiceFormSchema = z.object({
  issueDate: z.string().min(1, "Issue date is required"),
  dueDate: z.string().min(1, "Due date is required"),
  customerId: z.string().min(1, "Customer ID is required"),
  currency: z.string().min(1, "Currency is required"),
  status: z.string(),
  customerInvoiceNumber: z.string().optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1, "Description is required"),
        quantity: z.number().min(1, "Quantity must be at least 1"),
        unitAmountCents: z.number().min(0, "Unit price must be positive"),
      })
    )
    .optional(),
  notes: z.string().optional(),
});

export default function InvoiceDetailsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams();
  const { data: session } = useSession();

  const [isEditMode, setIsEditMode] = useState(
    searchParams.get("edit") === "true"
  );

  const invoiceId = params.invoiceId as string;

  // State for managing line items
  const [lineItems, setLineItems] = useState<InvoiceItem[]>([]);
  // State for tracking deleted line item IDs
  const [deletedLineItemIds, setDeletedLineItemIds] = useState<string[]>([]);

  // Only show normal line items in the table - tax details are handled by enhanced tax summary
  const normalLineItems = lineItems.filter(
    (item) => item.type && item.type.toLowerCase() !== "tax"
  );

  // PDF preview/download state
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const voidInvoiceMutation = useMutation({
    mutationFn: async () => {
      const response = await apiClient.invoices[":id"].$post({
        param: { id: invoiceId },
        json: {
          status: "void",
        },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      router.push("/invoices");
    },
  });

  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: async () => {
      if (!invoiceId) return null;
      const response = await apiClient.invoices[":id"].$get({
        param: { id: invoiceId },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      if (!data.invoice) {
        throw new Error("Invoice not found");
      }
      return data.invoice as Invoice;
    },
    enabled: !!invoiceId,
  });

  // Initialize line items from invoice data
  useEffect(() => {
    if (invoice?.lineItems && lineItems.length === 0) {
      setLineItems(
        invoice.lineItems.map((item) => ({
          id: item.id,
          description: item.description || "",
          quantity: item.quantity || 0,
          unitAmountCents: item.unitAmountCents || 0,
          type: item.type ?? null,
        }))
      );
    }
  }, [invoice, lineItems.length]);

  const form = useAppForm({
    defaultValues: {
      issueDate: invoice?.issueDate ?? "",
      dueDate: invoice?.dueDate ?? "",
      customerId: invoice?.customerId ?? "",
      currency: invoice?.currency ?? "EUR",
      status: invoice?.status ?? "draft",
      customerInvoiceNumber: invoice?.customerInvoiceNumber ?? "",
      notes: invoice?.notes ?? "",
    },
    onSubmit: async ({ value }) => {
      try {
        // Create a clean payload that explicitly includes lineItems and deletedLineItemIds
        const payload = {
          ...removeFalsyValuesFromObject(value),
          lineItems: lineItems.map((item) => ({
            id: item.id,
            description: item.description,
            quantity: item.quantity,
            unitAmountCents: item.unitAmountCents,
          })),
          deletedLineItemIds:
            deletedLineItemIds.length > 0 ? deletedLineItemIds : undefined,
        };

        const response = await apiClient.invoices[":id"].$post({
          param: { id: invoiceId },
          json: payload,
        });

        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }

        // Explicitly invalidate the query to force a refetch
        await queryClient.invalidateQueries({
          queryKey: ["invoice", invoiceId],
        });

        setIsEditMode(false);
        // Reset deleted line item IDs after saving
        setDeletedLineItemIds([]);
      } catch (error) {
        console.error("Error updating invoice:", error);
        throw error;
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = invoiceFormSchema.safeParse({
          ...value,
          lineItems: lineItems,
        });
        if (!result.success) {
          const errors = result.error.issues.reduce(
            (acc: Record<string, string>, issue: z.ZodIssue) => ({
              ...acc,
              [issue.path[0]]: issue.message,
            }),
            {}
          );
          return { fields: errors };
        }
        return undefined;
      },
    },
  });

  useEffect(() => {
    if (invoice) {
      form.reset({
        issueDate: invoice.issueDate ?? "",
        dueDate: invoice.dueDate ?? "",
        customerId: invoice.customerId ?? "",
        currency: invoice.currency ?? "EUR",
        status: invoice.status ?? "draft",
        customerInvoiceNumber: invoice.customerInvoiceNumber ?? "",
        notes: invoice.notes ?? "",
      });

      // Reset deleted line item IDs when toggling edit mode off
      if (!isEditMode) {
        setDeletedLineItemIds([]);
      }
    }
  }, [isEditMode, invoice, form]);

  const handleNavigateBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleCopyId = useCallback(() => {
    if (invoiceId) {
      navigator.clipboard.writeText(invoiceId);
    }
  }, [invoiceId]);

  // Open embedded PDF preview
  const handleViewInvoice = useCallback(async () => {
    if (!invoice?.hasPdf) return;
    try {
      setPdfLoading(true);
      const response = await apiClient.invoices[":id"].pdf.$get({
        param: { id: invoiceId },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Failed to fetch PDF presigned URL:", data.error);
        return;
      }
      setPdfUrl(data.pdfUrl as string);
      setPdfModalOpen(true);
    } catch (err) {
      console.error("Error fetching PDF presigned URL:", err);
    } finally {
      setPdfLoading(false);
    }
  }, [invoice?.hasPdf, invoiceId]);

  // Download the PDF directly
  const handleDownloadInvoice = useCallback(async () => {
    if (!invoice?.hasPdf) return;
    try {
      setPdfLoading(true);
      const response = await apiClient.invoices[":id"].pdf.$get({
        param: { id: invoiceId },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Failed to fetch PDF presigned URL:", data.error);
        return;
      }
      const link = document.createElement("a");
      link.href = data.pdfUrl as string;
      link.download = invoice.customerInvoiceNumber
        ? `invoice-${invoice.customerInvoiceNumber}.pdf`
        : "invoice.pdf";
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error("Error downloading invoice PDF:", err);
    } finally {
      setPdfLoading(false);
    }
  }, [invoice?.hasPdf, invoice?.customerInvoiceNumber, invoiceId]);

  const addItem = () => {
    setLineItems([
      ...lineItems,
      { description: "", quantity: 1, unitAmountCents: 0 },
    ]);
  };

  const removeItem = (index: number) => {
    const item = lineItems[index];
    if (item.id) {
      // If the item has an ID, add it to deletedLineItemIds
      setDeletedLineItemIds([...deletedLineItemIds, item.id]);
    }
    setLineItems(lineItems.filter((_, i) => i !== index));
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && isEditMode) {
        event.preventDefault();
        form.handleSubmit();
      }
      if (event.key === "Escape" && !pdfModalOpen) {
        // Handle Escape key when modal is not open (navigate back). Closing
        // the modal itself is handled separately via onEscapeKeyDown.
        handleNavigateBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [form, form.handleSubmit, handleNavigateBack, isEditMode, pdfModalOpen]);

  if (isLoading) {
    return (
      <div className="container mx-auto py-8">
        <div className="space-y-6">
          <Skeleton className="h-10 w-48" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">
            Invoice Not Found
          </h1>
          <p className="text-gray-600 mt-2">
            The invoice you&apos;re looking for doesn&apos;t exist or has been
            deleted.
          </p>
          <Button onClick={handleNavigateBack} className="mt-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Invoices
          </Button>
        </div>
      </div>
    );
  }

  const taxInfo = extractTaxInfo(invoice);
  console.log("[InvoiceDetailsPage] Tax info extracted for display:", {
    invoiceId: invoice.id,
    taxInfo: taxInfo,
    taxAmountCents: invoice.taxAmountCents,
    taxCalculationMethod: invoice.taxCalculationMethod,
    effectiveTaxRate: invoice.effectiveTaxRate,
    taxJurisdiction: invoice.taxJurisdiction,
  });

  const taxAmountCents = invoice.taxAmountCents || 0;
  const subtotalCents = invoice.subtotalCents || 0;
  const totalAmountCents =
    invoice.totalAmountCents || calculateInvoiceTotal(lineItems);

  const daysUntilDue = Math.ceil(
    (new Date(invoice.dueDate).getTime() - new Date().getTime()) /
      (1000 * 60 * 60 * 24)
  );
  const isOverdue =
    daysUntilDue < 0 && invoice.status !== "paid" && invoice.status !== "void";

  return (
    <div className="container mx-auto py-8">
      {/* Header */}
      <div className="space-y-6 mb-8">
        {/* Back Button and Actions */}
        <div className="flex justify-between items-center">
          <Button variant="outline" onClick={handleNavigateBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
            <kbd className="ml-2 inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </Button>

          <div className="flex items-center gap-4">
            {!isEditMode && invoice.status !== "void" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Void Invoice
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Void Invoice</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently void the invoice and it cannot be
                      undone. The invoice will be marked as void and removed
                      from any billing processes.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <Button
                      variant="destructive"
                      onClick={() => voidInvoiceMutation.mutate()}
                      disabled={voidInvoiceMutation.isPending}
                    >
                      {voidInvoiceMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Voiding...
                        </>
                      ) : (
                        <>
                          <Trash2 className="mr-2 h-4 w-4" />
                          Void Invoice
                        </>
                      )}
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        {/* Title and ID Section */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Invoice Details</h1>
          <div className="flex items-center gap-4 mt-3">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 w-fit"
                    onClick={handleCopyId}
                  >
                    <code className="px-3 py-2 text-sm font-mono">
                      {invoiceId}
                    </code>
                    <div className="h-10 px-3 flex items-center">
                      <Copy className="h-4 w-4" />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Click to copy invoice ID</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {!isEditMode && invoice.hasPdf && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleViewInvoice}
                  disabled={pdfLoading}
                  className="bg-blue-100 border-blue-400 border-2 text-blue-800 hover:bg-blue-200 hover:border-blue-600 font-semibold !pr-4"
                >
                  {pdfLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Eye className="mr-2 h-4 w-4" />
                  )}
                  View
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadInvoice}
                  disabled={pdfLoading}
                  className="bg-emerald-100 border-emerald-400 border-2 text-emerald-800 hover:bg-emerald-200 hover:border-emerald-600 font-semibold !pr-4"
                >
                  {pdfLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  PDF
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <Card
          className={`${
            invoice.status === "paid"
              ? "bg-green-50 border-green-200"
              : invoice.status === "void"
                ? "bg-red-50 border-red-200"
                : isOverdue
                  ? "bg-orange-50 border-orange-200"
                  : invoice.status === "pending"
                    ? "bg-yellow-50 border-yellow-200"
                    : "bg-gray-50 border-gray-200"
          }`}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Status</CardTitle>
            {getStatusIcon(invoice.status)}
          </CardHeader>
          <CardContent>
            <Badge className={getStatusColor(invoice.status)}>
              {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
            </Badge>
          </CardContent>
        </Card>

        <Card className="bg-blue-50 border-blue-200">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-blue-900">
              Total Amount
            </CardTitle>
            <DollarSign className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-900">
              {formatCurrency(totalAmountCents, invoice.currency)}
            </div>
            <p className="text-xs text-blue-600">
              {normalLineItems.length} item
              {normalLineItems.length !== 1 ? "s" : ""}
            </p>
          </CardContent>
        </Card>

        <Card
          className={`${
            isOverdue
              ? "bg-red-50 border-red-200"
              : daysUntilDue <= 3 &&
                  invoice.status !== "paid" &&
                  invoice.status !== "void"
                ? "bg-yellow-50 border-yellow-200"
                : "bg-slate-50 border-slate-200"
          }`}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle
              className={`text-sm font-medium ${
                isOverdue
                  ? "text-red-900"
                  : daysUntilDue <= 3 &&
                      invoice.status !== "paid" &&
                      invoice.status !== "void"
                    ? "text-yellow-900"
                    : "text-slate-900"
              }`}
            >
              Due Date
            </CardTitle>
            <Calendar
              className={`h-4 w-4 ${
                isOverdue
                  ? "text-red-600"
                  : daysUntilDue <= 3 &&
                      invoice.status !== "paid" &&
                      invoice.status !== "void"
                    ? "text-yellow-600"
                    : "text-slate-600"
              }`}
            />
          </CardHeader>
          <CardContent>
            <div
              className={`text-lg font-semibold ${
                isOverdue
                  ? "text-red-900"
                  : daysUntilDue <= 3 &&
                      invoice.status !== "paid" &&
                      invoice.status !== "void"
                    ? "text-yellow-900"
                    : "text-slate-900"
              }`}
            >
              <LocaleAwareDate date={invoice.dueDate} />
            </div>
            <p
              className={`text-xs font-medium ${
                isOverdue
                  ? "text-red-600"
                  : daysUntilDue <= 3 &&
                      invoice.status !== "paid" &&
                      invoice.status !== "void"
                    ? "text-yellow-600"
                    : "text-slate-600"
              }`}
            >
              {isOverdue
                ? `${Math.abs(daysUntilDue)} days overdue`
                : daysUntilDue === 0
                  ? "Due today"
                  : `${daysUntilDue} days remaining`}
            </p>
          </CardContent>
        </Card>

        <Card
          className={`${
            invoice.status === "paid"
              ? "bg-emerald-50 border-emerald-200"
              : "bg-slate-50 border-slate-200"
          }`}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle
              className={`text-sm font-medium ${
                invoice.status === "paid"
                  ? "text-emerald-900"
                  : "text-slate-900"
              }`}
            >
              Payment
            </CardTitle>
            <CreditCard
              className={`h-4 w-4 ${
                invoice.status === "paid"
                  ? "text-emerald-600"
                  : "text-slate-600"
              }`}
            />
          </CardHeader>
          <CardContent>
            <div
              className={`text-lg font-semibold ${
                invoice.status === "paid"
                  ? "text-emerald-900"
                  : "text-slate-900"
              }`}
            >
              {invoice.payment?.id ? (
                <Link
                  href={`/payments/${invoice.payment.id}`}
                  target="_blank"
                  className="hover:text-blue-800 hover:underline decoration-2 underline-offset-2 cursor-pointer flex items-center gap-1"
                >
                  {formatCurrency(
                    invoice.payment.amountCents || totalAmountCents,
                    invoice.currency
                  )}
                  <ExternalLink className="h-4 w-4 mb-1" />
                </Link>
              ) : (
                formatCurrency(
                  invoice.payment?.amountCents || totalAmountCents,
                  invoice.currency
                )
              )}
            </div>
            <div
              className={`text-xs ${
                invoice.status === "paid"
                  ? "text-emerald-600"
                  : "text-slate-600"
              }`}
            >
              {invoice.status === "paid"
                ? "Payment received"
                : "Awaiting payment"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column - Invoice & Customer Info */}
        <div className="space-y-6">
          {/* Invoice Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Receipt className="mr-2 h-5 w-5 text-muted-foreground" />
                Invoice Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Dates Section */}
              <div className="space-y-4">
                <form.AppField
                  name="issueDate"
                  children={(field) => (
                    <div>
                      <Label className="text-sm font-semibold text-muted-foreground">
                        Issue Date
                      </Label>
                      <div className="mt-2">
                        {isEditMode ? (
                          <field.DatePicker
                            label="Issue Date"
                            readOnly={false}
                          />
                        ) : (
                          <div className="text-base font-semibold">
                            <LocaleAwareDate date={invoice.issueDate} />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                />

                <form.AppField
                  name="dueDate"
                  children={(field) => (
                    <div>
                      <Label className="text-sm font-semibold text-muted-foreground">
                        Due Date
                      </Label>
                      <div className="mt-2">
                        {isEditMode ? (
                          <field.DatePicker label="Due Date" readOnly={false} />
                        ) : (
                          <div className="text-base font-semibold">
                            <LocaleAwareDate date={invoice.dueDate} />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                />
              </div>

              <Separator />

              {/* Basic Info Section */}
              <div className="space-y-4">
                {invoice.customerInvoiceNumber && (
                  <div>
                    <Label className="text-sm font-semibold text-muted-foreground">
                      Invoice Number
                    </Label>
                    <div className="mt-2 text-base font-bold font-mono">
                      {invoice.customerInvoiceNumber}
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-sm font-semibold text-muted-foreground">
                    Currency
                  </Label>
                  <div className="mt-2 text-base font-bold font-mono">
                    {invoice.currency}
                  </div>
                </div>
              </div>

              {/* Related Items Section */}
              {(invoice.subscription || invoice.payment) && (
                <>
                  <Separator />
                  <div className="space-y-5">
                    {invoice.subscription && (
                      <div>
                        <Label className="text-sm font-semibold text-muted-foreground">
                          Subscription
                        </Label>
                        <div className="mt-2 text-sm">
                          <Link
                            href={`/subscriptions/${invoice.subscription.stableSubscriptionId}`}
                            target="_blank"
                            className="text-primary hover:underline font-semibold inline-flex items-center gap-1"
                          >
                            {invoice.subscription.plan?.planName ? (
                              <>Plan: {invoice.subscription.plan.planName}</>
                            ) : (
                              "Subscription"
                            )}
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        </div>
                      </div>
                    )}

                    {invoice.payment && (
                      <div>
                        <Label className="text-sm font-semibold text-muted-foreground">
                          Payment
                        </Label>
                        <div className="mt-3">
                          <div className="flex items-center justify-between">
                            <Link
                              href={`/payments/${invoice.payment.id}`}
                              target="_blank"
                              className="text-blue-600 hover:text-blue-800 underline decoration-2 underline-offset-2 font-bold text-lg inline-flex items-center gap-2"
                            >
                              {formatCurrency(
                                invoice.payment.amountCents,
                                invoice.payment.currency ||
                                  invoice.currency ||
                                  session?.merchant?.defaultCurrency ||
                                  "USD"
                              )}
                              <ExternalLink className="h-4 w-4" />
                            </Link>
                            <Badge
                              className={`${getStatusColor(invoice.payment.status)} flex items-center gap-1`}
                            >
                              {getStatusIcon(invoice.payment.status)}
                              {invoice.payment.status.charAt(0).toUpperCase() +
                                invoice.payment.status.slice(1)}
                            </Badge>
                          </div>
                          {invoice.payment.errorMessage && (
                            <div className="mt-3 text-xs text-red-600 font-medium">
                              Error: {invoice.payment.errorMessage}
                            </div>
                          )}
                          {invoice.payment.refundedAmountCents != null &&
                            invoice.payment.refundedAmountCents > 0 && (
                              <div className="mt-3 text-xs text-purple-600 font-medium">
                                Refunded:{" "}
                                {formatCurrency(
                                  invoice.payment.refundedAmountCents,
                                  invoice.payment.currency ||
                                    invoice.currency ||
                                    session?.merchant?.defaultCurrency ||
                                    "USD"
                                )}
                              </div>
                            )}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Customer Information */}
          {invoice.customer && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <User className="mr-2 h-5 w-5 text-muted-foreground" />
                  Customer Information
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* Header with name and email */}
                <div className="mb-6">
                  <p className="text-lg font-semibold">
                    {invoice.customer.name || "Unknown Customer"}
                  </p>
                  <div className="flex items-center text-sm text-muted-foreground mt-1">
                    <Mail className="mr-1 h-4 w-4" />
                    {invoice.customer.email || "No email"}
                  </div>
                  {invoice.customer.phone && (
                    <div className="flex items-center text-sm text-muted-foreground mt-1">
                      <Phone className="mr-1 h-4 w-4" />
                      {invoice.customer.phone}
                    </div>
                  )}
                </div>

                {/* Two column layout for address and tax info */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Left Column - Billing Address */}
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-3">
                      Billing Address
                    </p>
                    <div className="flex items-start text-sm">
                      <MapPin className="mr-2 h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                      <div>
                        {invoice.customer.billingAddressLine1 ? (
                          <>
                            <p>{invoice.customer.billingAddressLine1}</p>
                            {invoice.customer.billingAddressLine2 && (
                              <p>{invoice.customer.billingAddressLine2}</p>
                            )}
                            <p>
                              {invoice.customer.billingCity &&
                                `${invoice.customer.billingCity}, `}
                              {invoice.customer.billingStateProvince &&
                                `${invoice.customer.billingStateProvince} `}
                              {invoice.customer.billingPostalCode &&
                                `${invoice.customer.billingPostalCode} `}
                              {invoice.customer.billingCountry}
                            </p>
                          </>
                        ) : (
                          <p className="text-muted-foreground">
                            {invoice.customer.billingCity &&
                              `${invoice.customer.billingCity}, `}
                            {invoice.customer.billingStateProvince &&
                              `${invoice.customer.billingStateProvince} `}
                            {invoice.customer.billingPostalCode &&
                              `${invoice.customer.billingPostalCode} `}
                            {invoice.customer.billingCountry ||
                              "No billing address"}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right Column - Tax Information */}
                  {(invoice.customer.taxId ||
                    invoice.customer.businessName ||
                    invoice.customer.taxExempt !== null ||
                    invoice.customer.taxExemptionReason ||
                    invoice.customer.taxExemptionCertificate ||
                    invoice.customer.taxCalculationMethod) && (
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-3">
                        Tax Information
                      </p>
                      <div className="space-y-1">
                        {invoice.customer.businessName && (
                          <div className="grid grid-cols-2 gap-4 py-0.5">
                            <p className="text-xs font-medium text-muted-foreground">
                              Business Name
                            </p>
                            <p className="text-sm">
                              {invoice.customer.businessName}
                            </p>
                          </div>
                        )}
                        {invoice.customer.taxId && (
                          <div className="grid grid-cols-2 gap-4 py-0.5">
                            <p className="text-xs font-medium text-muted-foreground">
                              {getTaxIdLabel(invoice.customer)}
                            </p>
                            <p className="text-sm">{invoice.customer.taxId}</p>
                          </div>
                        )}
                        {invoice.customer.taxExempt !== null && (
                          <div className="grid grid-cols-2 gap-4 py-0.5">
                            <p className="text-xs font-medium text-muted-foreground">
                              Tax Status
                            </p>
                            <div>
                              <Badge
                                variant={
                                  invoice.customer.taxExempt
                                    ? "secondary"
                                    : "outline"
                                }
                                className={
                                  invoice.customer.taxExempt
                                    ? "bg-amber-100 text-amber-800 border-amber-200"
                                    : "bg-green-100 text-green-800 border-green-200"
                                }
                              >
                                {invoice.customer.taxExempt
                                  ? "Tax Exempt"
                                  : "Tax Applicable"}
                              </Badge>
                            </div>
                          </div>
                        )}
                        {invoice.customer.taxExemptionReason && (
                          <div className="grid grid-cols-2 gap-4 py-0.5">
                            <p className="text-xs font-medium text-muted-foreground">
                              Exemption Reason
                            </p>
                            <p className="text-sm capitalize">
                              {invoice.customer.taxExemptionReason.replace(
                                "_",
                                " "
                              )}
                            </p>
                          </div>
                        )}
                        {invoice.customer.taxExemptionCertificate && (
                          <div className="grid grid-cols-2 gap-4 py-0.5">
                            <p className="text-xs font-medium text-muted-foreground">
                              Exemption Certificate
                            </p>
                            <p className="text-sm">
                              {invoice.customer.taxExemptionCertificate}
                            </p>
                          </div>
                        )}
                        {invoice.customer.taxCalculationMethod && (
                          <div className="grid grid-cols-2 gap-4 py-0.5">
                            <p className="text-xs font-medium text-muted-foreground">
                              Tax Calculation Method
                            </p>
                            <div>
                              <Badge variant="outline" className="capitalize">
                                {invoice.customer.taxCalculationMethod}
                              </Badge>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column - Line Items & Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Line Items */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center">
                  <FileText className="mr-2 h-5 w-5 text-muted-foreground" />
                  Line Items
                </div>
                {isEditMode && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addItem}
                  >
                    <Plus className="mr-2 h-4 w-4" /> Add Item
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pt-0">
              {isEditMode ? (
                <div className="space-y-3 px-6">
                  {lineItems.map((item, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-12 gap-4 items-end border rounded-lg p-3 bg-gray-50/50"
                    >
                      <div className="col-span-6">
                        <Label className="text-sm font-medium text-gray-700 mb-1 block">
                          Description
                        </Label>
                        <Input
                          value={item.description}
                          onChange={(e) => {
                            const newItems = [...lineItems];
                            newItems[index].description = e.target.value;
                            setLineItems(newItems);
                          }}
                          placeholder="Description"
                          className="h-9"
                        />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-sm font-medium text-gray-700 mb-1 block">
                          Qty
                        </Label>
                        <Input
                          type="number"
                          value={item.quantity}
                          min={1}
                          onChange={(e) => {
                            const newItems = [...lineItems];
                            newItems[index].quantity = Number(e.target.value);
                            setLineItems(newItems);
                          }}
                          placeholder="1"
                          className="h-9 text-center"
                        />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-sm font-medium text-gray-700 mb-1 block">
                          Unit Price
                        </Label>
                        <UnitPriceInput
                          initialValue={item.unitAmountCents}
                          onChange={(val) => {
                            const newItems = [...lineItems];
                            newItems[index].unitAmountCents = val;
                            setLineItems(newItems);
                          }}
                        />
                      </div>
                      <div className="col-span-1">
                        <Label className="text-sm font-medium text-gray-700 mb-1 block">
                          Amount
                        </Label>
                        <div className="h-9 text-sm font-medium px-3 py-2 bg-white rounded border flex items-center justify-end text-gray-900">
                          {formatCurrency(
                            item.quantity * item.unitAmountCents,
                            invoice.currency
                          )}
                        </div>
                      </div>
                      <div className="col-span-1 flex justify-end items-end">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeItem(index)}
                          className="h-9 w-9 hover:bg-red-100 hover:text-red-600"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="flex justify-end">
                    <div className="w-full">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent border-b-2 border-slate-200 bg-slate-50">
                            <TableHead className="font-semibold text-slate-800 py-4 pl-6 text-sm">
                              Description
                            </TableHead>
                            <TableHead className="text-center font-semibold text-slate-800 w-16 py-4 text-sm">
                              Qty
                            </TableHead>
                            <TableHead className="text-right font-semibold text-slate-800 w-24 py-4 text-sm">
                              Unit Price
                            </TableHead>
                            <TableHead className="font-semibold text-slate-800 w-96 py-4 text-sm">
                              <div className="flex justify-end pr-8">
                                Amount
                              </div>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {normalLineItems.map((item, index) => (
                            <TableRow
                              key={index}
                              className="hover:bg-muted/50 border-b border-slate-100"
                            >
                              <TableCell className="py-4 text-slate-900 pl-6 text-sm font-medium">
                                {item.description}
                              </TableCell>
                              <TableCell className="text-center py-4 w-16 text-sm font-medium text-slate-700">
                                {item.quantity}
                              </TableCell>
                              <TableCell className="text-right py-4 text-slate-600 w-24 text-sm font-mono">
                                {formatCurrency(
                                  item.unitAmountCents,
                                  invoice.currency
                                )}
                              </TableCell>
                              <TableCell className="py-4 font-semibold text-slate-900 w-96 text-sm font-mono">
                                <div className="flex justify-end pr-8">
                                  {formatCurrency(
                                    item.quantity * item.unitAmountCents,
                                    invoice.currency
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {normalLineItems.length === 0 && (
                    <div className="py-8 text-center">
                      <div className="bg-blue-50 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-3">
                        <FileText className="h-6 w-6 text-blue-500" />
                      </div>
                      <p className="text-base font-medium text-gray-900 mb-1">
                        No line items
                      </p>
                      <p className="text-sm text-gray-500">
                        This invoice doesn&apos;t have any line items yet.
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* Tax Summary - matches PDF layout */}
              {invoice && normalLineItems.length > 0 && (
                <div className="mt-6 px-6">
                  <div className="flex justify-end">
                    <div className="w-96 bg-muted/30 rounded-lg border p-4">
                      <div className="space-y-3">
                        <div className="flex justify-between items-center py-2 border-b">
                          <span className="text-sm font-medium">Subtotal</span>
                          <span className="text-sm font-semibold font-mono">
                            {formatCurrency(subtotalCents, invoice.currency)}
                          </span>
                        </div>

                        {/* Tax Line - matches PDF display */}
                        {taxInfo.taxLineItemDescriptions.length > 0 ? (
                          <div className="flex justify-between items-center py-2">
                            <span className="text-sm font-medium">
                              Tax: {taxInfo.taxLineItemDescriptions[0]}
                              {taxInfo.taxReferences.length > 0 && (
                                <span className="text-xs text-muted-foreground ml-1 font-medium">
                                  [{taxInfo.taxReferences[0].referenceNumber}]
                                </span>
                              )}
                            </span>
                            <span className="text-sm font-semibold font-mono">
                              {formatCurrency(taxAmountCents, invoice.currency)}
                            </span>
                          </div>
                        ) : (
                          <div className="flex justify-between items-center py-2">
                            <span className="text-sm font-medium text-muted-foreground">
                              Tax
                            </span>
                            <span className="text-sm font-semibold text-muted-foreground font-mono">
                              {formatCurrency(taxAmountCents, invoice.currency)}
                            </span>
                          </div>
                        )}

                        <div className="flex justify-between items-center py-3 border-t-2 bg-background rounded px-3 -mx-1">
                          <span className="text-base font-bold">Total</span>
                          <span className="text-base font-bold font-mono">
                            {formatCurrency(totalAmountCents, invoice.currency)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Tax References - matches PDF footnotes */}
                  {taxInfo.taxReferences.length > 0 && (
                    <div className="mt-6 pt-4 border-t">
                      <h4 className="text-sm font-semibold mb-3 text-blue-700">
                        Tax Information
                      </h4>
                      <div className="bg-blue-50 rounded-lg border border-blue-200 p-3">
                        {taxInfo.taxReferences.map((ref, index) => (
                          <div
                            key={index}
                            className="text-xs text-blue-700 mb-2 last:mb-0"
                          >
                            <span className="font-semibold">
                              [{ref.referenceNumber}]
                            </span>{" "}
                            {ref.fullDescription}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <FileText className="mr-2 h-5 w-5 text-muted-foreground" />
                Notes
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form.AppField
                name="notes"
                children={(field) => (
                  <div>
                    {isEditMode ? (
                      <field.TextField label="Notes" isOptional />
                    ) : (
                      <div className="bg-muted/30 rounded-lg p-4 border">
                        {invoice.notes ? (
                          <NotesRenderer notes={invoice.notes} />
                        ) : (
                          <p className="text-sm font-medium text-muted-foreground italic">
                            No notes added
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              />
            </CardContent>
          </Card>

          {/* Save Button */}
          {isEditMode && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                form.handleSubmit();
              }}
            >
              <form.AppForm>
                <Card>
                  <CardContent className="pt-6">
                    <form.SubmitButtonWithShortcut label="Update Invoice" />
                  </CardContent>
                </Card>
              </form.AppForm>
            </form>
          )}
        </div>
      </div>

      {/* PDF Viewer Dialog */}
      <Dialog open={pdfModalOpen} onOpenChange={setPdfModalOpen}>
        <DialogContent
          className="!w-[57vh] !h-[80vh] !max-w-none p-0 bg-white border shadow-2xl"
          // Ensure the modal closes when Escape is pressed
          onEscapeKeyDown={() => setPdfModalOpen(false)}
        >
          <DialogTitle className="sr-only">Invoice PDF Preview</DialogTitle>
          {pdfUrl ? (
            <iframe
              src={`${pdfUrl}#zoom=page-fit&toolbar=0&navpanes=0&scrollbar=1&statusbar=0&messages=0&view=Fit`}
              className="w-full h-full bg-white rounded-md"
              title="Invoice PDF"
            />
          ) : (
            <div className="flex items-center justify-center h-full bg-white rounded-md">
              <div className="text-center text-muted-foreground">
                <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium mb-2">PDF Not Available</p>
                <p className="text-sm">
                  This invoice doesn’t have a PDF version available.
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
