"use client";

import { apiClient } from "@/lib/hono-client";
import { useEffect, useCallback, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import {
  ArrowLeft,
  Copy,
  Loader2,
  CreditCard,
  DollarSign,
  User,
  Mail,
  Phone,
  MapPin,
  Eye,
  Download,
  AlertCircle,
  CheckCircle,
  XCircle,
  Clock,
  Calendar,
  Receipt,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";
import { formatCurrency } from "@lumen/common/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { parseStringToCents } from "@/components/form/Number2DecimalsField";
import { checkTestMode } from "@/lib/utils";
import { toast } from "sonner";

// Types
interface PaymentDetail {
  id: string;
  merchantId: string;
  invoiceId: string;
  paymentMethodId: string | null;
  externalPaymentId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  errorMessage: string | null;
  refundedAmountCents: number | null;
  refundStatus: string | null;
  createdAt: string;
  updatedAt: string;
  // PSP info
  paymentProvider?: "stripe" | "dodo" | null;
  pspPaymentMethod?: {
    id: string;
    type: string;
    customerId: string;
    cardLastFour?: string;
    cardBrand?: string;
    cardExpiryMonth?: number;
    cardExpiryYear?: number;
    cardIssuerCountry?: string;
    cardNetwork?: string;
    metadata?: Record<string, string>;
  };
  // Related entity information
  customerInvoiceNumber: string | null;
  customerName: string | null;
  subscriptionId: string | null;
  subscriptionStableId: string | null;
  planId: string | null;
  planName: string | null;
  // Additional customer details
  customer?: {
    id: string;
    name: string | null;
    email: string | null;
    billingCountry: string | null;
    billingCity: string | null;
    billingAddressLine1: string | null;
    billingAddressLine2: string | null;
    billingPostalCode: string | null;
    phone: string | null;
    taxId: string | null;
  };
  // Invoice details
  invoice?: {
    id: string;
    customerInvoiceNumber: string;
    totalAmountCents: number;
    currency: string;
    status: string;
    issueDate: string;
    dueDate: string;
    hasPdf: boolean;
  };
}

// Helper functions
const getPaymentStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "succeeded":
      return "bg-green-100 text-green-800 border-green-200 hover:bg-green-200";
    case "pending":
    case "processing":
      return "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200";
    case "failed":
    case "canceled":
      return "bg-red-100 text-red-800 border-red-200 hover:bg-red-200";
    case "refunded":
      return "bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
  }
};

const getPaymentStatusIcon = (status: string) => {
  switch (status.toLowerCase()) {
    case "succeeded":
      return <CheckCircle className="w-4 h-4" />;
    case "failed":
    case "canceled":
      return <XCircle className="w-4 h-4" />;
    case "pending":
    case "processing":
      return <Clock className="w-4 h-4" />;
    case "refunded":
      return <RefreshCw className="w-4 h-4" />;
    default:
      return <AlertCircle className="w-4 h-4" />;
  }
};

const getRefundStatusColor = (status: string | null) => {
  if (!status) return "bg-gray-100 text-gray-800 border-gray-200";
  switch (status.toLowerCase()) {
    case "succeeded":
      return "bg-green-100 text-green-800 border-green-200";
    case "pending":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "failed":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200";
  }
};

const truncateId = (id: string, maxLength: number = 54) => {
  if (id.length <= maxLength) return id;
  const start = Math.floor((maxLength - 3) / 2);
  const end = Math.ceil((maxLength - 3) / 2);
  return `${id.slice(0, start)}...${id.slice(-end)}`;
};

const getStripeDashboardUrl = (
  externalId: string | null | undefined,
  isTest: boolean
) => {
  if (!externalId) return null;
  const base = isTest
    ? "https://dashboard.stripe.com/test"
    : "https://dashboard.stripe.com";
  if (externalId.startsWith("pi_")) return `${base}/payments/${externalId}`;
  if (externalId.startsWith("seti_"))
    return `${base}/setup_intents/${externalId}`;
  if (externalId.startsWith("cs_"))
    return `${base}/checkout/sessions/${externalId}`;
  return base;
};

export default function PaymentDetailsPage() {
  const router = useRouter();
  const params = useParams();
  const { data: session } = useSession();
  const paymentId = params.paymentId as string;
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [isTestMode, setIsTestMode] = useState(false);
  const queryClient = useQueryClient();
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [isPartialRefund, setIsPartialRefund] = useState(false);
  const [refundAmountInput, setRefundAmountInput] = useState("");

  // Fetch payment data
  const {
    data: payment,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["payment", paymentId],
    queryFn: async () => {
      const response = await apiClient.payments[":id"].$get({
        param: { id: paymentId },
      });
      if (!response.ok) {
        throw new Error("Failed to fetch payment");
      }
      const data = await response.json();
      if ("error" in data) throw new Error(String(data.error));
      return data.payment as PaymentDetail;
    },
    enabled: !!paymentId,
  });

  // Fetch minimal subscription status for refund options
  const { data: linkedSubscription } = useQuery({
    queryKey: ["subscription-status", payment?.subscriptionStableId],
    queryFn: async () => {
      if (!payment?.subscriptionStableId) return null;
      const response = await apiClient.subscriptions[":id"].$get({
        param: { id: payment.subscriptionStableId },
      });
      const data = await response.json();
      if ("error" in data || !data.subscription) return null;
      return data.subscription as {
        status: string;
        endTimestamp: string | null;
      };
    },
    enabled: !!payment?.subscriptionStableId,
  });

  const handleNavigateBack = useCallback(() => {
    router.push("/payments");
  }, [router]);

  const handleCopyId = useCallback((id: string) => {
    navigator.clipboard.writeText(id);
  }, []);

  const retryInvoicePaymentMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const response = await apiClient.invoices[":id"]["retry-payment"].$post({
        param: { id: invoiceId },
      });
      const data = await response.json();
      if (!response.ok || ("error" in data && data.error)) {
        throw new Error(
          (data as { error?: string }).error || "Failed to queue retry"
        );
      }
      return data as { success: boolean; attemptNumber?: number };
    },
    onSuccess: () => {
      toast.success("Payment retry queued");
      if (payment?.customer?.id) {
        queryClient.invalidateQueries({
          queryKey: ["payments", payment.customer.id],
        });
      }
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Failed to queue retry");
    },
  });

  const refundPaymentMutation = useMutation({
    mutationFn: async ({
      amountCents,
      terminate,
    }: {
      amountCents?: number;
      terminate?: boolean;
    }) => {
      if (!payment?.subscriptionStableId) {
        throw new Error("Refunds are only supported for subscription payments");
      }
      const response = await apiClient.subscriptions[":id"].refunds.$post({
        param: { id: payment.subscriptionStableId },
        json: { paymentId, amountCents, terminateSubscription: !!terminate },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(String(data.error));
      }
      return data as {
        success: boolean;
        refund?: { id: string; status: string; amountCents: number };
      };
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Refund issued successfully");
        queryClient.invalidateQueries({ queryKey: ["payment", paymentId] });
        if (payment?.customer?.id) {
          queryClient.invalidateQueries({
            queryKey: ["payments", payment.customer.id],
          });
        }
        setRefundModalOpen(false);
        setRefundAmountInput("");
        setIsPartialRefund(false);
      } else {
        toast.error("Refund failed");
      }
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof Error ? err.message : "Failed to issue refund"
      );
    },
  });

  const handleViewInvoice = useCallback(async () => {
    if (!payment?.invoice?.hasPdf || !payment.invoiceId) return;
    try {
      setPdfLoading(true);
      const response = await apiClient.invoices[":id"].pdf.$get({
        param: { id: payment.invoiceId },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Failed to fetch PDF presigned URL:", String(data.error));
        return;
      }
      setPdfUrl(data.pdfUrl as string);
      setPdfModalOpen(true);
    } catch (error) {
      console.error("Error fetching PDF presigned URL:", error);
    } finally {
      setPdfLoading(false);
    }
  }, [payment]);

  const handleDownloadInvoice = useCallback(async () => {
    if (!payment?.invoice?.hasPdf || !payment.invoiceId) return;
    try {
      setPdfLoading(true);
      const response = await apiClient.invoices[":id"].pdf.$get({
        param: { id: payment.invoiceId },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Failed to fetch PDF presigned URL:", String(data.error));
        return;
      }

      // Create a temporary anchor element to trigger download
      const link = document.createElement("a");
      link.href = data.pdfUrl as string;
      link.download = `invoice-${payment.invoice?.customerInvoiceNumber}.pdf`;
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("Error downloading PDF:", error);
    } finally {
      setPdfLoading(false);
    }
  }, [payment]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleNavigateBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNavigateBack]);

  // Determine if payment provider is in test mode (Stripe or Dodo)
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const test = await checkTestMode();
        if (!ignore) setIsTestMode(test);
      } catch (e) {
        console.error("Failed to determine test mode", e);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  if (isLoading) {
    return (
      <div className="container mx-auto py-8">
        <div className="space-y-6">
          <Skeleton className="h-10 w-48" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (isError || !payment) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">
            Payment Not Found
          </h1>
          <p className="text-gray-600 mt-2">
            The payment you&apos;re looking for doesn&apos;t exist or has been
            deleted.
          </p>
          <Button onClick={handleNavigateBack} className="mt-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Payments
          </Button>
        </div>
      </div>
    );
  }

  const refundAmount = payment.refundedAmountCents || 0;
  const netAmount = payment.amountCents - refundAmount;
  const displayStatus =
    refundAmount > 0
      ? payment.refundStatus && payment.refundStatus !== "full"
        ? "partially refunded"
        : "refunded"
      : payment.status;

  return (
    <div className="container mx-auto py-8">
      {/* Header */}
      <div className="space-y-6 mb-8">
        {/* Back Button */}
        <div className="flex justify-between items-center">
          <Button variant="outline" onClick={handleNavigateBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Payments
            <kbd className="ml-2 inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </Button>
          <div>
            {payment.status === "succeeded" &&
              payment.refundStatus !== "full" &&
              !!payment.subscriptionStableId && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsPartialRefund(false);
                    setRefundAmountInput("");
                    setRefundModalOpen(true);
                  }}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Refund
                </Button>
              )}
          </div>
        </div>

        {/* Title and ID Section */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Payment Details</h1>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 mt-3 w-fit"
                  onClick={() => handleCopyId(payment.id)}
                >
                  <code className="px-3 py-2 text-sm font-mono">
                    {payment.id}
                  </code>
                  <div className="h-10 px-3 flex items-center">
                    <Copy className="h-4 w-4" />
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Click to copy payment ID</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Status</CardTitle>
            {getPaymentStatusIcon(displayStatus)}
          </CardHeader>
          <CardContent>
            <Badge className={getPaymentStatusColor(displayStatus)}>
              {displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)}
            </Badge>
            {payment.errorMessage && (
              <p className="text-xs text-red-600 mt-2">
                {payment.errorMessage}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Amount</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(payment.amountCents, payment.currency)}
            </div>
            {refundAmount > 0 && (
              <p className="text-xs text-muted-foreground">
                Refunded: {formatCurrency(refundAmount, payment.currency)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net Amount</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(netAmount, payment.currency)}
            </div>
            <p className="text-xs text-muted-foreground">After refunds</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Processed</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold">
              <LocaleAwareDate
                date={payment.createdAt}
                style="medium"
                className="text-lg font-semibold"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column - Payment & Customer Info */}
        <div className="space-y-6">
          {/* Payment Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <CreditCard className="mr-2 h-5 w-5" />
                Payment Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Amount
                  </p>
                  <p className="text-lg font-semibold">
                    {formatCurrency(payment.amountCents, payment.currency)}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Currency
                  </p>
                  <p className="text-lg font-semibold">
                    {payment.currency.toUpperCase()}
                  </p>
                </div>
              </div>

              {refundAmount > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-2">
                      Refund Information
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-muted-foreground">
                          Refunded Amount
                        </p>
                        <p className="font-semibold text-purple-700">
                          {formatCurrency(refundAmount, payment.currency)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">
                          Refund Status
                        </p>
                        <Badge
                          className={getRefundStatusColor(payment.refundStatus)}
                        >
                          {payment.refundStatus || "Unknown"}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-2">
                      <p className="text-sm text-muted-foreground">
                        Net Amount
                      </p>
                      <p className="text-lg font-semibold">
                        {formatCurrency(netAmount, payment.currency)}
                      </p>
                    </div>
                  </div>
                </>
              )}

              <Separator />

              <div className="space-y-3">
                {typeof payment.paymentProvider !== "undefined" && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">
                      Payment Provider
                    </p>
                    <div className="mt-1">
                      <Badge
                        className={
                          payment.paymentProvider === "stripe"
                            ? "bg-purple-100 text-purple-800 border-purple-200"
                            : payment.paymentProvider === "dodo"
                              ? "bg-blue-100 text-blue-800 border-blue-200"
                              : "bg-gray-100 text-gray-800 border-gray-200"
                        }
                      >
                        {(payment.paymentProvider || "unknown").toUpperCase()}
                      </Badge>
                    </div>
                  </div>
                )}

                {payment.externalPaymentId && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">
                      {payment.paymentMethodId
                        ? "External Payment ID"
                        : "Checkout Session ID"}
                    </p>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            className="flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 w-fit"
                            onClick={() =>
                              handleCopyId(payment.externalPaymentId!)
                            }
                          >
                            <code className="px-2 py-1 text-xs font-mono">
                              {truncateId(payment.externalPaymentId)}
                            </code>
                            <div className="h-8 px-2 flex items-center">
                              <Copy className="h-3 w-3" />
                            </div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>
                            Click to copy{" "}
                            {payment.paymentMethodId
                              ? "external payment ID"
                              : "checkout session ID"}
                            <br />
                            <code className="text-xs">
                              {payment.externalPaymentId}
                            </code>
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    {payment.paymentProvider === "stripe" && (
                      <div className="mt-2">
                        {(() => {
                          const url = getStripeDashboardUrl(
                            payment.externalPaymentId,
                            isTestMode
                          );
                          return url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center text-sm text-blue-600 hover:underline"
                            >
                              <ExternalLink className="h-3 w-3 mr-1" />
                              View in Stripe Dashboard
                            </a>
                          ) : null;
                        })()}
                      </div>
                    )}
                    {payment.paymentProvider === "dodo" && (
                      <div className="mt-2">
                        <a
                          href={`https://app.dodopayments.com/transactions/payments/${payment.externalPaymentId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center text-sm text-blue-600 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3 mr-1" />
                          View in Dodo Dashboard
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <Separator />

              {payment.pspPaymentMethod && (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-muted-foreground">
                    Payment Method Details
                  </p>
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">
                        {payment.paymentProvider === "stripe"
                          ? "Stripe Payment Method ID"
                          : "Dodo Subscription ID"}
                      </p>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className="flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 w-fit"
                              onClick={() =>
                                handleCopyId(payment.pspPaymentMethod!.id)
                              }
                            >
                              <code className="px-2 py-1 text-xs font-mono">
                                {truncateId(payment.pspPaymentMethod.id, 40)}
                              </code>
                              <div className="h-8 px-2 flex items-center">
                                <Copy className="h-3 w-3" />
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Click to copy payment method ID</p>
                            <code className="text-xs">
                              {payment.pspPaymentMethod.id}
                            </code>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-muted-foreground">Type</p>
                        <p className="font-semibold">
                          {payment.pspPaymentMethod.type}
                        </p>
                      </div>
                      {(payment.pspPaymentMethod.cardBrand ||
                        payment.pspPaymentMethod.cardLastFour) && (
                        <div>
                          <p className="text-sm text-muted-foreground">Card</p>
                          <p className="font-semibold">
                            {payment.pspPaymentMethod.cardBrand || ""}
                            {payment.pspPaymentMethod.cardLastFour
                              ? ` •••• ${payment.pspPaymentMethod.cardLastFour}`
                              : ""}
                          </p>
                        </div>
                      )}
                    </div>
                    {(payment.pspPaymentMethod.cardNetwork ||
                      payment.pspPaymentMethod.cardIssuerCountry) && (
                      <div className="grid grid-cols-2 gap-4">
                        {payment.pspPaymentMethod.cardNetwork && (
                          <div>
                            <p className="text-sm text-muted-foreground">
                              Network
                            </p>
                            <p className="font-semibold">
                              {payment.pspPaymentMethod.cardNetwork}
                            </p>
                          </div>
                        )}
                        {payment.pspPaymentMethod.cardIssuerCountry && (
                          <div>
                            <p className="text-sm text-muted-foreground">
                              Country
                            </p>
                            <p className="font-semibold">
                              {payment.pspPaymentMethod.cardIssuerCountry}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Created
                  </p>
                  <LocaleAwareDate
                    date={payment.createdAt}
                    className="text-sm"
                  />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Updated
                  </p>
                  <LocaleAwareDate
                    date={payment.updatedAt}
                    className="text-sm"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Customer Information */}
          {payment.customer && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <div className="flex items-center">
                    <User className="mr-2 h-5 w-5" />
                    Customer Information
                  </div>
                  <Link href={`/customers/${payment.customer.id}`}>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex items-center gap-1"
                    >
                      <ExternalLink className="h-4 w-4" />
                      View Customer
                    </Button>
                  </Link>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* Header with name and email */}
                <div className="mb-6">
                  <p className="text-lg font-semibold">
                    {payment.customer.name ||
                      payment.customerName ||
                      "Unknown Customer"}
                  </p>
                  <div className="flex items-center text-sm text-muted-foreground mt-1">
                    <Mail className="mr-1 h-4 w-4" />
                    {payment.customer.email || "No email"}
                  </div>
                  {payment.customer.phone && (
                    <div className="flex items-center text-sm text-muted-foreground mt-1">
                      <Phone className="mr-1 h-4 w-4" />
                      {payment.customer.phone}
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
                        {payment.customer.billingAddressLine1 ? (
                          <>
                            <p>{payment.customer.billingAddressLine1}</p>
                            {payment.customer.billingAddressLine2 && (
                              <p>{payment.customer.billingAddressLine2}</p>
                            )}
                            <p>
                              {payment.customer.billingCity &&
                                `${payment.customer.billingCity}, `}
                              {payment.customer.billingPostalCode &&
                                `${payment.customer.billingPostalCode} `}
                              {payment.customer.billingCountry}
                            </p>
                          </>
                        ) : (
                          <p className="text-muted-foreground">
                            No billing address
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right Column - Tax Information */}
                  {payment.customer.taxId && (
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-3">
                        Tax Information
                      </p>
                      <div className="space-y-1">
                        <div className="grid grid-cols-2 gap-4 py-0.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            Tax ID
                          </p>
                          <div>
                            <Badge variant="outline" className="font-mono">
                              {payment.customer.taxId}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column - Related Information */}
        <div className="lg:col-span-2">
          <div className="space-y-6">
            {/* Related Invoice */}
            {payment.invoice && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <Receipt className="mr-2 h-5 w-5" />
                    Related Invoice
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">
                          Invoice Number
                        </p>
                        <p className="text-lg font-semibold">
                          {payment.invoice.customerInvoiceNumber}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">
                          Total Amount
                        </p>
                        <p className="text-lg font-semibold">
                          {formatCurrency(
                            payment.invoice.totalAmountCents,
                            payment.invoice.currency ||
                              payment.currency ||
                              session?.merchant?.defaultCurrency ||
                              "USD"
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">
                          Status
                        </p>
                        <Badge
                          className={getPaymentStatusColor(
                            payment.invoice.status
                          )}
                        >
                          {payment.invoice.status}
                        </Badge>
                      </div>
                    </div>
                    <div className="space-y-4">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">
                          Issue Date
                        </p>
                        <LocaleAwareDate
                          date={payment.invoice.issueDate}
                          fallback="—"
                          className="text-sm"
                        />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">
                          Due Date
                        </p>
                        <LocaleAwareDate
                          date={payment.invoice.dueDate}
                          fallback="—"
                          className="text-sm"
                        />
                      </div>
                      {payment.invoice.hasPdf && (
                        <div className="flex space-x-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleViewInvoice}
                            disabled={pdfLoading}
                          >
                            {pdfLoading ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <Eye className="h-4 w-4 mr-1" />
                            )}
                            View PDF
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleDownloadInvoice}
                            disabled={pdfLoading}
                          >
                            {pdfLoading ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4 mr-1" />
                            )}
                            Download
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-4 pt-4 border-t">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        router.push(`/invoices/${payment.invoiceId}`)
                      }
                    >
                      <ExternalLink className="h-4 w-4 mr-1" />
                      View Full Invoice Details
                    </Button>
                    {payment.invoice.status === "issued" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-2"
                        onClick={() =>
                          retryInvoicePaymentMutation.mutate(payment.invoiceId!)
                        }
                        disabled={retryInvoicePaymentMutation.isPending}
                      >
                        {retryInvoicePaymentMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : null}
                        Retry Payment
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Subscription Context */}
            {payment.subscriptionStableId && payment.planName && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <CreditCard className="mr-2 h-5 w-5" />
                    Subscription Context
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        Plan
                      </p>
                      <p className="text-lg font-semibold">
                        {payment.planName}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        Subscription ID
                      </p>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className="flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 w-fit"
                              onClick={() =>
                                handleCopyId(payment.subscriptionStableId!)
                              }
                            >
                              <code className="px-2 py-1 text-xs font-mono">
                                {payment.subscriptionStableId}
                              </code>
                              <div className="h-8 px-2 flex items-center">
                                <Copy className="h-3 w-3" />
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Click to copy subscription ID</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <div className="pt-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          router.push(
                            `/subscriptions/${payment.subscriptionStableId}`
                          )
                        }
                      >
                        <ExternalLink className="h-4 w-4 mr-1" />
                        View Subscription Details
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Error Information */}
            {payment.errorMessage && (
              <Card className="border-red-200">
                <CardHeader>
                  <CardTitle className="flex items-center text-red-700">
                    <AlertCircle className="mr-2 h-5 w-5" />
                    Error Information
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="bg-red-50 p-4 rounded-md">
                    <p className="text-sm text-red-800">
                      {payment.errorMessage}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* PDF Viewer Dialog */}
      <Dialog open={pdfModalOpen} onOpenChange={setPdfModalOpen}>
        <DialogContent className="!w-[57vh] !h-[80vh] !max-w-none p-0 bg-white border shadow-2xl">
          <DialogTitle className="sr-only">Invoice PDF Preview</DialogTitle>
          {pdfUrl ? (
            <iframe
              src={`${pdfUrl}#zoom=page-fit&toolbar=0&navpanes=0&scrollbar=1&statusbar=0&messages=0&view=Fit`}
              className="w-full h-full bg-white rounded-md"
              title="Invoice PDF"
              onLoad={() => console.log("PDF loaded successfully")}
              onError={() => console.error("PDF failed to load")}
            />
          ) : (
            <div className="flex items-center justify-center h-full bg-white rounded-md">
              <div className="text-center text-muted-foreground">
                <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium mb-2">PDF Not Available</p>
                <p className="text-sm">
                  This invoice doesn&apos;t have a PDF version available.
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Refund Modal */}
      <Dialog open={refundModalOpen} onOpenChange={setRefundModalOpen}>
        <DialogContent className="z-[1000] !w-auto !max-w-[650px] !min-w-[550px]">
          <DialogHeader>
            <DialogTitle>Issue Refund</DialogTitle>
            <DialogDescription>
              Refundable remaining:{" "}
              {formatCurrency(
                (payment.amountCents || 0) - (payment.refundedAmountCents || 0),
                payment.currency
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="partial-refund">Partial refund</Label>
              <Switch
                id="partial-refund"
                checked={isPartialRefund}
                onCheckedChange={(v) => {
                  setIsPartialRefund(!!v);
                  if (!v) setRefundAmountInput("");
                }}
              />
            </div>
            {isPartialRefund && (
              <div>
                <Label htmlFor="refund-amount" className="mb-1 block">
                  Refund amount
                </Label>
                <Input
                  id="refund-amount"
                  type="text"
                  inputMode="decimal"
                  pattern="\d*\.?\d{0,2}"
                  placeholder="0.00"
                  value={refundAmountInput}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === "" || /^\d*\.?\d{0,2}$/.test(value)) {
                      setRefundAmountInput(value);
                    }
                  }}
                />
                {refundAmountInput !== "" &&
                  parseStringToCents(refundAmountInput) >
                    payment.amountCents -
                      (payment.refundedAmountCents || 0) && (
                    <div className="text-xs text-red-600 mt-1">
                      Amount cannot exceed refundable remaining
                    </div>
                  )}
              </div>
            )}
          </div>
          <DialogFooter className="mt-2 flex flex-col sm:flex-row sm:justify-end gap-2">
            <Button
              className="w-full sm:w-auto"
              variant="outline"
              onClick={() => setRefundModalOpen(false)}
            >
              Cancel
            </Button>
            {linkedSubscription?.status === "active" ? (
              <>
                <Button
                  className="w-full sm:w-auto"
                  onClick={() => {
                    const payloadAmount = isPartialRefund
                      ? refundAmountInput === ""
                        ? undefined
                        : parseStringToCents(refundAmountInput)
                      : undefined;
                    if (
                      isPartialRefund &&
                      (refundAmountInput === "" ||
                        parseStringToCents(refundAmountInput) <= 0 ||
                        parseStringToCents(refundAmountInput) >
                          payment.amountCents -
                            (payment.refundedAmountCents || 0))
                    ) {
                      toast.error(
                        "Enter a valid refund amount less than total"
                      );
                      return;
                    }
                    refundPaymentMutation.mutate({
                      amountCents: payloadAmount,
                      terminate: false,
                    });
                  }}
                  disabled={refundPaymentMutation.isPending}
                >
                  {refundPaymentMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : null}
                  Refund & keep subscription active
                </Button>
                <Button
                  className="w-full sm:w-auto"
                  variant="destructive"
                  onClick={() => {
                    const payloadAmount = isPartialRefund
                      ? refundAmountInput === ""
                        ? undefined
                        : parseStringToCents(refundAmountInput)
                      : undefined;
                    if (
                      isPartialRefund &&
                      (refundAmountInput === "" ||
                        parseStringToCents(refundAmountInput) <= 0 ||
                        parseStringToCents(refundAmountInput) >
                          payment.amountCents -
                            (payment.refundedAmountCents || 0))
                    ) {
                      toast.error(
                        "Enter a valid refund amount less than total"
                      );
                      return;
                    }
                    refundPaymentMutation.mutate({
                      amountCents: payloadAmount,
                      terminate: true,
                    });
                  }}
                  disabled={refundPaymentMutation.isPending}
                >
                  {refundPaymentMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : null}
                  Refund & terminate subscription
                </Button>
              </>
            ) : (
              <Button
                className="w-full sm:w-auto"
                onClick={() => {
                  const payloadAmount = isPartialRefund
                    ? refundAmountInput === ""
                      ? undefined
                      : parseStringToCents(refundAmountInput)
                    : undefined;
                  if (
                    isPartialRefund &&
                    (refundAmountInput === "" ||
                      parseStringToCents(refundAmountInput) <= 0 ||
                      parseStringToCents(refundAmountInput) >
                        payment.amountCents -
                          (payment.refundedAmountCents || 0))
                  ) {
                    toast.error("Enter a valid refund amount less than total");
                    return;
                  }
                  refundPaymentMutation.mutate({ amountCents: payloadAmount });
                }}
                disabled={refundPaymentMutation.isPending}
              >
                {refundPaymentMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : null}
                Refund
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
