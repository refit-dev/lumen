"use client";

import { apiClient } from "@/lib/hono-client";
import { useEffect, useCallback, useState, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Copy,
  Trash2,
  Loader2,
  Calendar,
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
  Activity,
  TrendingUp,
  Gift,
  ExternalLink,
  Timer,
  RefreshCw,
} from "lucide-react";
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

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";
import { formatCurrency } from "@lumen/common/utils";
import { useDateFormatter } from "@/lib/locale-context";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { parseStringToCents } from "@/components/form/Number2DecimalsField";
import { PerUnitPriceComponentSchemaType } from "@lumen/common";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Types
interface Subscription {
  id: string;
  customerId: string;
  planId: string;
  effectivePriceId: string;
  versionNumber: number;
  startTimestamp: string;
  endTimestamp: string | null;
  createdAt: string;
  customer: {
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
    // Additional tax-related fields
    businessName: string | null;
    taxExempt: boolean | null;
    taxExemptionReason: string | null;
    taxExemptionCertificate: string | null;
    taxCalculationMethod: string | null;
    billingStateProvince: string | null;
  };
  plan: {
    id: string;
    planName: string;
    planDescription: string | null;
    stablePlanId: string;
    versionNumber: number;
    isTrialPlan?: boolean;
    trialDays?: number;
  };
  price: {
    id: string;
    currency: string;
    pricingData: {
      components: Array<{
        type: string;
        amount_cents?: number;
        recurrence_rule?: string;
        unit_cost_cents?: number;
        bill_immediately?: boolean;
        component_name?: string;
        unit_label?: string;
      }>;
    };
  };
}

interface Payment {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  errorMessage: string | null;
  refundedAmountCents?: number | null;
  refundStatus?: string | null;
}

interface Invoice {
  id: string;
  customerInvoiceNumber: string;
  totalAmountCents: number;
  currency: string;
  status: string;
  issueDate: string;
  dueDate: string;
  hasPdf: boolean;
}

interface CreditGrant {
  id: string;
  initialAmount: number;
  remainingAmount: number;
  currency: string;
  status: string;
  expiryDate: string | null;
  applicationType: string;
  source: string;
  creditDefinition: {
    name: string;
    description: string | null;
    scope: string;
  };
}

interface PlanCreditDefinition {
  id: string;
  name: string;
  description: string | null;
  applicationType: "usage" | "monetary" | "component";
  defaultAmount: number;
  currency: string | null;
  refillRrule: string | null;
  refillAmount: number | null;
  renewOnBilling: boolean | null;
  featureId: string | null;
  planId: string | null;
}

interface SubscriptionDetail {
  id: string;
  componentId: string;
  nextBillingDate: string;
  subscriptionStartDate: string;
  previousBillingDate: string | null;
  cyclesBilled: number;
  recurrenceRule: string | null;
  component: {
    type: string;
    amount_cents?: number;
    unit_cost_cents?: number;
    recurrence_rule?: string;
    component_name?: string;
    unit_label?: string;
    bill_immediately?: boolean;
    component_id?: string;
    metric_id?: string;
  } | null;
}

interface UpcomingBilling {
  nextBillingDate: string;
  totalFixedAmountCents: number;
  hasUsageComponents: boolean;
  components: Array<{
    componentId: string;
    type: string;
    amountCents: number;
    componentName?: string;
    seatCount?: number;
    unitPrice?: number;
  }>;
}

interface FeatureEntitlement {
  entitled: boolean | null;
  feature: { slug: string; value: boolean | string | number | null } | null;
  source: "plan" | "override" | "default" | "credits" | null;
  usages?: { metricId: string; usage: number }[];
  creditInfo?: {
    creditAllowance: number;
    creditsRemaining: number;
    nextExpiryDate: Date | null;
  };
}

interface TrialInfo {
  isOnTrial: boolean;
  trialStartDate?: string;
  trialDays?: number;
  trialEndDate?: string | null;
  daysRemaining?: number | null;
  nextBillingDate?: string | null;
  upcomingPlan?: {
    id: string;
    planName: string;
    planDescription?: string;
  } | null;
  upcomingPrice?: {
    id: string;
    currency: string;
    pricingData: {
      components: Array<{
        type: string;
        amount_cents?: number;
        recurrence_rule?: string;
        unit_cost_cents?: number;
        component_name?: string;
        unit_label?: string;
      }>;
    };
  } | null;
}

interface SeatUsageData {
  customerId: string;
  subscriptionId: string;
  seatUsages: Array<{
    componentId: string;
    componentName?: string;
    unitLabel: string;
    metricId: string;
    currentUsage: number;
    pendingRemovals?: number;
    unitAmountCents: number;
  }>;
}

// Interface for price components
interface PriceComponent {
  type: string;
  amount_cents?: number;
  per_unit_cents?: number;
  unit_cost_cents?: number;
  recurrence_rule?: string;
  component_name?: string;
  label?: string;
  bill_immediately?: boolean;
  component_id?: string;
  metric_id?: string;
  unit_label?: string;
}

// Interface for prices with components
interface PriceWithComponents {
  id: string;
  currency: string;
  interval?: string;
  intervalCount?: number;
  nickname?: string;
  pricingData: {
    components: PriceComponent[];
  };
}

// Helper function to get component amount
const getComponentAmount = (component: PriceComponent): number => {
  return (
    component.amount_cents ??
    component.per_unit_cents ??
    component.unit_cost_cents ??
    0
  );
};

// Helper function to get component label/unit
const getComponentUnit = (component: PriceComponent): string => {
  if (component.type === "fixed") return "";
  if (component.type === "per_unit") {
    return component.unit_label ? `per ${component.unit_label}` : "per unit";
  }
  if (component.type === "usage") {
    if (component.unit_label) return `per ${component.unit_label}`;
    return "per use";
  }
  return "";
};

// Helper function to format recurrence/billing period
const formatRecurrence = (recurrence?: string) => {
  if (!recurrence) return "One-time";
  const lower = recurrence.toLowerCase();
  if (lower.includes("month")) return "monthly";
  if (lower.includes("year")) return "yearly";
  if (lower.includes("week")) return "weekly";
  if (lower.includes("day")) return "daily";
  return recurrence;
};

// Helper function to get billing period from price or component
const getBillingPeriod = (
  price: PriceWithComponents,
  component?: PriceComponent
): string => {
  // For subscriptions, prioritize component recurrence rule first
  if (component?.recurrence_rule) {
    return formatRecurrence(component.recurrence_rule);
  }

  // Then try to get period from the price itself
  if (price.nickname) {
    const lower = price.nickname.toLowerCase();
    if (lower.includes("monthly") || lower.includes("month")) return "monthly";
    if (lower.includes("yearly") || lower.includes("year")) return "yearly";
    if (lower.includes("weekly") || lower.includes("week")) return "weekly";
    if (lower.includes("daily") || lower.includes("day")) return "daily";
  }

  // Then try price interval
  if (price.interval) {
    const count = price.intervalCount || 1;
    const interval = price.interval.toLowerCase();

    if (count === 1) {
      switch (interval) {
        case "month":
          return "monthly";
        case "year":
          return "yearly";
        case "week":
          return "weekly";
        case "day":
          return "daily";
        default:
          return interval;
      }
    } else {
      // Handle multiple intervals (e.g., "every 3 months")
      const intervalName =
        interval === "month"
          ? "month"
          : interval === "year"
            ? "year"
            : interval;
      return `every ${count} ${intervalName}${count > 1 ? "s" : ""}`;
    }
  }

  // For subscriptions, default to monthly if no recurrence rule is found
  // This handles the case where subscription components might not have explicit recurrence rules
  return "monthly";
};

// Helper functions
const getSubscriptionStatus = (
  subscription: Subscription
): "active" | "ended" => {
  return subscription.endTimestamp ? "ended" : "active";
};

const calculateMRRContribution = (
  subscription: Subscription,
  currentSeatCount: number
): number => {
  if (!subscription.price?.pricingData?.components) return 0;

  let mrrCents = 0;
  for (const component of subscription.price.pricingData.components) {
    const amount = getComponentAmount(component);
    if (!amount) continue;

    const recurrenceRule = component.recurrence_rule || "";

    if (component.type === "fixed") {
      // Fixed components: amount is the total monthly or yearly charge
      if (recurrenceRule.includes("FREQ=MONTHLY")) {
        mrrCents += amount;
      } else if (recurrenceRule.includes("FREQ=YEARLY")) {
        mrrCents += Math.round(amount / 12);
      }
    } else if (component.type === "per_unit") {
      // Seat-based per_unit components: amount is per seat per billing period
      // From createPlan():
      // - Monthly: amount_cents = monthlyPrice (per seat per month)
      // - Yearly: amount_cents = yearlyPrice * 12 (per seat per year)

      // Handle minimum seats requirement - seat-based components may have num_seats for minimum billing
      const minSeats =
        (component as PerUnitPriceComponentSchemaType).num_seats || 0;
      const effectiveSeatCount = Math.max(currentSeatCount, minSeats);

      if (recurrenceRule.includes("FREQ=MONTHLY")) {
        // amount is per seat per month, so multiply by effective seat count
        mrrCents += amount * effectiveSeatCount;
      } else if (recurrenceRule.includes("FREQ=YEARLY")) {
        // amount is per seat per year, so divide by 12 to get per seat per month, then multiply by seats
        mrrCents += Math.round((amount * effectiveSeatCount) / 12);
      }
    }
    // Note: usage-based components are not included in MRR calculation
    // as they are variable and unpredictable
  }
  return mrrCents;
};

// Helper function to format price display
const formatPriceDisplay = (subscription: Subscription): string => {
  const components = subscription.price?.pricingData?.components || [];

  if (components.length === 0) {
    return "No pricing";
  }

  // Create a price-like object for getBillingPeriod function
  const priceInfo: PriceWithComponents = {
    id: subscription.price.id,
    currency: subscription.price.currency,
    pricingData: subscription.price.pricingData,
    // These might not be available in the subscription price object, but we'll try
    nickname: undefined,
    interval: undefined,
    intervalCount: undefined,
  };

  const formattedComponents = components.map((component) => {
    const amount = getComponentAmount(component);
    const unit = getComponentUnit(component);
    const period = getBillingPeriod(priceInfo, component);

    if (amount === 0) {
      return `Free ${component.type} ${period}`;
    }

    // Careful currency fallback - use subscription currency or fallback
    const displayCurrency = subscription.price?.currency || "USD";
    const currencyFormatted = formatCurrency(amount, displayCurrency);

    // Handle per_unit components specifically for seat-based pricing
    if (component.type === "per_unit") {
      const unitLabel = component.unit_label || "unit";
      return `${currencyFormatted} per ${unitLabel} ${period}`;
    }

    const typeLabel = component.type === "fixed" ? "fixed" : component.type;

    if (unit) {
      return `${currencyFormatted} ${unit} ${period}`;
    } else {
      return `${currencyFormatted} ${typeLabel} ${period}`;
    }
  });

  if (components.length === 1) {
    return formattedComponents[0];
  } else {
    return formattedComponents.join(" + ");
  }
};

const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "active":
    case "succeeded":
    case "paid":
      return "bg-green-100 text-green-800 border-green-200 hover:bg-green-200";
    case "ended":
    case "cancelled":
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
    case "failed":
    case "expired":
      return "bg-red-100 text-red-800 border-red-200 hover:bg-red-200";
    case "pending":
    case "processing":
      return "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toLowerCase()) {
    case "active":
    case "succeeded":
    case "paid":
      return <CheckCircle className="w-4 h-4" />;
    case "failed":
    case "expired":
      return <XCircle className="w-4 h-4" />;
    case "pending":
    case "processing":
      return <Clock className="w-4 h-4" />;
    default:
      return <AlertCircle className="w-4 h-4" />;
  }
};

// Helper function to format credit status with colors (matching subscription list page)
const formatCreditStatus = (status: string) => {
  const statusMap = {
    ACTIVE: {
      label: "Active",
      className:
        "bg-green-100 text-green-800 border-green-200 hover:bg-green-200",
    },
    DEPLETED: {
      label: "Depleted",
      className: "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200",
    },
    EXPIRED: {
      label: "Expired",
      className: "bg-red-100 text-red-800 border-red-200 hover:bg-red-200",
    },
    REVOKED: {
      label: "Revoked",
      className:
        "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200",
    },
  };
  return (
    statusMap[status as keyof typeof statusMap] || {
      label: status,
      className: "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200",
    }
  );
};

// Helper function to format currency
const formatCurrencyLocal = (amount: number, currency?: string | null) => {
  // Careful currency fallback - only when absolutely no currency data exists
  const displayCurrency = currency || "USD";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: displayCurrency.toUpperCase(),
  }).format(amount / 100);
};

// Add Feature interface after other interfaces
interface Feature {
  id: string;
  slug: string;
  displayName: string;
}

// Helper function to format trial status badge
const getTrialStatusBadge = (daysRemaining: number | null) => {
  if (daysRemaining === null) return null;

  if (daysRemaining === 0) {
    return {
      text: "Trial Ending Today",
      className: "bg-red-100 text-red-800 border-red-200 hover:bg-red-200",
      icon: <Timer className="w-4 h-4" />,
    };
  } else if (daysRemaining <= 3) {
    return {
      text: `${daysRemaining} Day${daysRemaining !== 1 ? "s" : ""} Left`,
      className:
        "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200",
      icon: <Timer className="w-4 h-4" />,
    };
  } else {
    return {
      text: `${daysRemaining} Days Left`,
      className: "bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200",
      icon: <Timer className="w-4 h-4" />,
    };
  }
};

export default function SubscriptionDetailsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const params = useParams();
  const stableSubscriptionId = params.stableSubscriptionId as string;
  const [activeTab, setActiveTab] = useState("payments");
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const [eventsLimit, setEventsLimit] = useState(10);
  const dateFormatter = useDateFormatter();
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundTargetPayment, setRefundTargetPayment] =
    useState<Payment | null>(null);
  const [isPartialRefund, setIsPartialRefund] = useState(false);
  const [refundAmountInput, setRefundAmountInput] = useState("");
  // Removed terminate toggle; action chosen via buttons

  const deleteSubscriptionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiClient.subscriptions[":id"].$delete({
        param: { id: stableSubscriptionId },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      router.push("/subscriptions");
    },
  });

  const refundPaymentMutation = useMutation({
    mutationFn: async ({
      paymentId,
      amountCents,
      terminate,
    }: {
      paymentId: string;
      amountCents?: number;
      terminate?: boolean;
    }) => {
      const response = await apiClient.subscriptions[":id"].refunds.$post({
        param: { id: stableSubscriptionId },
        json: { paymentId, amountCents, terminateSubscription: !!terminate },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error as string);
      }
      return data as {
        success: boolean;
        refund?: { id: string; status: string; amountCents: number };
      };
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Refund issued successfully");
        queryClient.invalidateQueries({
          queryKey: ["payments", subscription?.customerId],
        });
        setRefundModalOpen(false);
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

  const handleViewInvoice = useCallback(async (invoice: Invoice) => {
    if (!invoice.hasPdf) return;
    try {
      setPdfLoadingId(invoice.id);
      const response = await apiClient.invoices[":id"].pdf.$get({
        param: { id: invoice.id },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Failed to fetch PDF presigned URL:", data.error);
        return;
      }
      setPdfUrl(data.pdfUrl as string);
      setPdfModalOpen(true);
    } catch (error) {
      console.error("Error fetching PDF presigned URL:", error);
    } finally {
      setPdfLoadingId(null);
    }
  }, []);

  const handleDownloadInvoice = useCallback(async (invoice: Invoice) => {
    if (!invoice.hasPdf) return;
    try {
      setPdfLoadingId(invoice.id);
      const response = await apiClient.invoices[":id"].pdf.$get({
        param: { id: invoice.id },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Failed to fetch PDF presigned URL:", data.error);
        return;
      }

      // Create a temporary anchor element to trigger download
      const link = document.createElement("a");
      link.href = data.pdfUrl as string;
      link.download = `invoice-${invoice.customerInvoiceNumber}.pdf`;
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("Error downloading PDF:", error);
    } finally {
      setPdfLoadingId(null);
    }
  }, []);

  // Fetch subscription data
  const { data: subscription, isLoading: subscriptionLoading } = useQuery({
    queryKey: ["subscription", stableSubscriptionId],
    queryFn: async () => {
      const response = await apiClient.subscriptions[":id"].$get({
        param: { id: stableSubscriptionId },
      });
      const data = await response.json();
      if ("error" in data) throw new Error(data.error);
      if (!data.subscription) throw new Error("Subscription not found");
      return data.subscription as unknown as Subscription;
    },
    enabled: !!stableSubscriptionId,
  });

  // Fetch comprehensive trial information
  const { data: trialData } = useQuery({
    queryKey: ["trial-info", stableSubscriptionId],
    queryFn: async () => {
      if (!subscription?.id) return null;
      try {
        const response = await apiClient.subscriptions[":id"][
          "trial-info"
        ].$get({
          param: { id: stableSubscriptionId },
        });
        const data = await response.json();
        if ("error" in data) {
          console.error("Error fetching trial info:", data.error);
          return null;
        }
        // Handle the union type - API can return either the trial info directly or wrapped in trialInfo
        if ("trialInfo" in data) {
          return data.trialInfo as TrialInfo;
        } else if ("isOnTrial" in data) {
          return data as TrialInfo;
        }
        return null;
      } catch (error) {
        console.error("Failed to fetch trial info:", error);
        return null;
      }
    },
    enabled: !!subscription?.id,
  });

  // Fetch payment history
  const { data: payments } = useQuery({
    queryKey: ["payments", subscription?.customerId],
    queryFn: async () => {
      if (!subscription?.customerId) return [];
      const response = await apiClient.payments.$get({
        query: { customerId: subscription.customerId },
      });
      const data = await response.json();
      return (data.payments || []) as Payment[];
    },
    enabled: !!subscription?.customerId,
  });

  // Fetch invoice history
  const { data: invoices } = useQuery({
    queryKey: ["invoices", subscription?.customerId],
    queryFn: async () => {
      if (!subscription?.customerId) return [];
      const response = await apiClient.invoices.$get({
        query: { customerId: subscription.customerId },
      });
      const data = await response.json();
      if ("error" in data) return [];
      return (data.invoices || []) as Invoice[];
    },
    enabled: !!subscription?.customerId,
  });

  // Fetch credit grants
  const { data: credits } = useQuery({
    queryKey: ["credits", subscription?.customerId],
    queryFn: async () => {
      if (!subscription?.customerId) return [];
      const response = await apiClient.credits.customers[
        ":customerId"
      ].grants.$get({
        param: { customerId: subscription.customerId },
        query: {},
      });
      const data = await response.json();
      if ("error" in data) return [];
      return (data.grants || []) as CreditGrant[];
    },
    enabled: !!subscription?.customerId,
  });

  // Fetch subscription events
  const {
    data: eventsResponse,
    isLoading: eventsLoading,
    refetch: refetchEvents,
    isRefetching: eventsRefetching,
  } = useQuery({
    queryKey: ["subscription-events", subscription?.customerId, eventsLimit],
    queryFn: async () => {
      if (!subscription?.customerId) return { data: [], hasMore: false };
      try {
        const response = await apiClient.events.$get({
          query: {
            customerId: subscription.customerId,
            limit: eventsLimit.toString(),
            offset: "0",
          },
        });
        const data = await response.json();
        if ("error" in data) {
          console.error("Events API error:", data.error);
          return { data: [], hasMore: false };
        }
        // Return raw data with pagination info
        const events = data.data || [];
        const hasMore = data.pagination?.hasMore || false;
        return { data: events, hasMore };
      } catch (error) {
        console.error("Failed to fetch subscription events:", error);
        return { data: [], hasMore: false };
      }
    },
    enabled: !!subscription?.customerId,
  });

  // Extract events data for easier access
  const subscriptionEvents = eventsResponse?.data || [];
  const hasMoreEvents = eventsResponse?.hasMore || false;

  // Handle loading more events
  const handleLoadMoreEvents = () => {
    setEventsLimit((prev) => prev + 10);
  };

  // Reset events limit when switching away from events tab
  useEffect(() => {
    if (activeTab !== "events") {
      setEventsLimit(10);
    }
  }, [activeTab]);

  // Fetch entitlements to get usage-based features and their current usage
  const { data: entitlements } = useQuery({
    queryKey: ["entitlements", subscription?.customerId],
    queryFn: async () => {
      if (!subscription?.customerId) return [];
      try {
        const response = await apiClient.entitlements[":customerId"].$get({
          param: { customerId: subscription.customerId },
          query: { isExtCustId: "false" },
        });
        const data = await response.json();
        if ("error" in data) {
          console.error("Entitlements API error:", data.error);
          return [];
        }
        return (data.entitlements || []) as FeatureEntitlement[];
      } catch (error) {
        console.error("Failed to fetch entitlements for subscription:", error);
        return [];
      }
    },
    enabled: !!subscription?.customerId,
  });

  // Fetch all features for the current merchant so we can map slug -> display name
  const { data: featuresList } = useQuery({
    queryKey: ["features"],
    queryFn: async () => {
      try {
        const response = await apiClient.features.$get({});
        const data = await response.json();
        if ("error" in data) return [];
        return (data.features || []) as Feature[];
      } catch (error) {
        console.error("Failed to fetch features list:", error);
        return [];
      }
    },
  });

  // Create a map for quick lookup of displayName by slug
  const featureNameMap = useMemo(() => {
    const map = new Map<string, string>();
    featuresList?.forEach((feat) => {
      map.set(feat.slug, feat.displayName);
    });
    return map;
  }, [featuresList]);

  // Fetch current seat usage for seat-based subscriptions
  const { data: seatUsage } = useQuery<SeatUsageData | null>({
    queryKey: ["seat-usage", subscription?.customerId],
    queryFn: async (): Promise<SeatUsageData | null> => {
      if (!subscription?.customerId) return null;

      // Check if this is a seat-based subscription
      const isSeatBasedSubscription =
        subscription?.price?.pricingData?.components?.some(
          (component) => component.type === "per_unit"
        );

      if (!isSeatBasedSubscription) return null;

      try {
        const response = await apiClient.seats.usage[":customerId"].$get({
          param: { customerId: subscription.customerId },
        });
        const data = await response.json();
        if ("error" in data) {
          console.error("Seat usage API error:", data.error);
          return null;
        }
        return data as SeatUsageData;
      } catch (error) {
        console.error("Failed to fetch seat usage:", error);
        return null;
      }
    },
    enabled: !!subscription?.customerId,
    staleTime: 30000, // Cache for 30 seconds
    gcTime: 60000, // Keep in cache for 1 minute
  });

  // Get current seat count from seat usage data
  const currentSeatCount = useMemo(() => {
    if (
      !seatUsage ||
      !seatUsage.seatUsages ||
      seatUsage.seatUsages.length === 0
    )
      return 0;

    // Sum up usage from all seat-based components (usually there's only one)
    return seatUsage.seatUsages.reduce(
      (total, usage) => total + usage.currentUsage,
      0
    );
  }, [seatUsage]);

  // Get pending removals count
  const pendingRemovals = useMemo(() => {
    if (
      !seatUsage ||
      !seatUsage.seatUsages ||
      seatUsage.seatUsages.length === 0
    )
      return 0;

    return seatUsage.seatUsages.reduce((total, usage) => {
      return total + (usage.pendingRemovals || 0);
    }, 0);
  }, [seatUsage]);

  // Calculate next billing amount based on current seats (pending removals take effect AFTER next billing)
  const nextBillingAmount = useMemo(() => {
    if (
      !seatUsage ||
      !seatUsage.seatUsages ||
      seatUsage.seatUsages.length === 0
    )
      return 0;

    // For next billing, we bill based on current seat count (pending removals take effect after)
    return seatUsage.seatUsages.reduce((total, usage) => {
      const seatsForThisComponent = usage.currentUsage; // Use current seats for next billing
      return total + seatsForThisComponent * (usage.unitAmountCents || 0);
    }, 0);
  }, [seatUsage]);

  // Fetch plan credit definitions
  const { data: planCreditDefinitions } = useQuery({
    queryKey: ["plan-credit-definitions", subscription?.planId],
    queryFn: async () => {
      if (!subscription?.planId) return [];
      const response = await apiClient.credits.definitions.$get({
        query: { scope: "plan" },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Error fetching credit definitions:", data.error);
        return [];
      }
      // Filter for this specific plan version - handle the type properly
      return data.definitions.filter(
        (def: { planId: string | null }) => def.planId === subscription.planId
      ) as PlanCreditDefinition[];
    },
    enabled: !!subscription?.planId,
  });

  // Fetch subscription details for upcoming billing calculation
  const { data: subscriptionDetails } = useQuery({
    queryKey: ["subscription-details", stableSubscriptionId],
    queryFn: async () => {
      const response = await apiClient.subscriptions[":id"].details.$get({
        param: { id: stableSubscriptionId },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Error fetching subscription details:", data.error);
        return [];
      }
      return data.subscriptionDetails as SubscriptionDetail[];
    },
    enabled: !!stableSubscriptionId,
  });

  // Calculate upcoming billing grouped by date
  const upcomingBilling: UpcomingBilling[] = useMemo(() => {
    if (!subscriptionDetails || !subscription) return [];

    // Group subscription details by next billing date
    const billingGroups = new Map<string, SubscriptionDetail[]>();

    subscriptionDetails.forEach((detail) => {
      if (detail.component && detail.nextBillingDate) {
        const dateKey = detail.nextBillingDate.split("T")[0]; // Group by date only
        if (!billingGroups.has(dateKey)) {
          billingGroups.set(dateKey, []);
        }
        billingGroups.get(dateKey)!.push(detail);
      }
    });

    // Convert to upcoming billing format
    const result: UpcomingBilling[] = [];

    billingGroups.forEach((details) => {
      let totalFixedAmountCents = 0;
      let hasUsageComponents = false;
      const components: UpcomingBilling["components"] = [];

      details.forEach((detail) => {
        if (!detail.component) return;

        const component = detail.component;
        const amountCents =
          component.amount_cents || component.unit_cost_cents || 0;

        if (component.type === "fixed") {
          totalFixedAmountCents += amountCents;
        } else if (component.type === "per_unit") {
          // For per_unit components, calculate the actual billing amount based on current seats
          // (pending removals take effect AFTER the next billing)
          const actualBillingAmount = currentSeatCount * amountCents;
          totalFixedAmountCents += actualBillingAmount;
        } else if (component.type === "usage") {
          hasUsageComponents = true;
        }

        components.push({
          componentId: detail.componentId,
          type: component.type,
          amountCents:
            component.type === "per_unit"
              ? currentSeatCount * amountCents
              : amountCents,
          componentName: component.component_name,
          seatCount:
            component.type === "per_unit" ? currentSeatCount : undefined,
          unitPrice: component.type === "per_unit" ? amountCents : undefined,
        });
      });

      result.push({
        nextBillingDate: details[0].nextBillingDate,
        totalFixedAmountCents,
        hasUsageComponents,
        components,
      });
    });

    // Sort by billing date
    result.sort(
      (a, b) =>
        new Date(a.nextBillingDate).getTime() -
        new Date(b.nextBillingDate).getTime()
    );

    return result;
  }, [subscriptionDetails, subscription, currentSeatCount]);

  // Override upcoming billing for trial subscriptions
  const trialUpcomingBilling: UpcomingBilling[] = useMemo(() => {
    if (
      !trialData?.isOnTrial ||
      !trialData?.nextBillingDate ||
      !trialData?.upcomingPrice
    ) {
      return [];
    }

    return [
      {
        nextBillingDate: trialData.nextBillingDate,
        totalFixedAmountCents:
          trialData.upcomingPrice.pricingData.components.reduce((sum, comp) => {
            return sum + (comp.amount_cents || comp.unit_cost_cents || 0);
          }, 0),
        hasUsageComponents: trialData.upcomingPrice.pricingData.components.some(
          (c) => c.type === "usage"
        ),
        components: trialData.upcomingPrice.pricingData.components.map(
          (comp, index) => ({
            componentId: `trial-component-${index}`,
            type: comp.type,
            amountCents: comp.amount_cents || comp.unit_cost_cents || 0,
            componentName: comp.component_name,
          })
        ),
      },
    ];
  }, [trialData]);

  // Use trial billing if available, otherwise use regular upcoming billing
  const finalUpcomingBilling =
    trialData?.isOnTrial && trialUpcomingBilling.length > 0
      ? trialUpcomingBilling
      : upcomingBilling;

  // Deduplicate credit definitions to avoid duplicates when the only difference is price linkage fields
  const dedupedCreditDefinitions = useMemo(() => {
    if (!planCreditDefinitions) return [];
    const seen = new Set<string>();
    return planCreditDefinitions.filter((def: PlanCreditDefinition) => {
      const key = `${def.featureId}-${def.applicationType}-${def.defaultAmount}-${def.currency || ""}-${def.refillRrule || ""}-${def.refillAmount || ""}`;
      if (seen.has(key)) {
        return false; // duplicate
      }
      seen.add(key);
      return true;
    });
  }, [planCreditDefinitions]);

  const handleNavigateBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleCopyId = useCallback(() => {
    if (subscription?.id) {
      navigator.clipboard.writeText(subscription.id);
    }
  }, [subscription?.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleNavigateBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNavigateBack]);

  if (subscriptionLoading) {
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

  if (!subscription) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">
            Subscription Not Found
          </h1>
          <p className="text-gray-600 mt-2">
            The subscription you&apos;re looking for doesn&apos;t exist or has
            been deleted.
          </p>
          <Button onClick={handleNavigateBack} className="mt-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Subscriptions
          </Button>
        </div>
      </div>
    );
  }

  // Check if this is a seat-based subscription
  const isSeatBasedSubscription =
    subscription.price?.pricingData?.components?.some(
      (component) => component.type === "per_unit"
    );

  const isBusinessCustomer = Boolean(
    subscription.customer.taxId || subscription.customer.businessName
  );

  const status = getSubscriptionStatus(subscription);
  const mrrContribution = calculateMRRContribution(
    subscription,
    currentSeatCount
  );
  const priceDisplay = formatPriceDisplay(subscription);
  const activeCredits = credits?.filter((c) => c.status === "ACTIVE") || [];
  const recentPayments = payments?.slice(0, 5) || [];
  const recentInvoices = invoices?.slice(0, 5) || [];

  // Use trial data from API
  const trialInfo = trialData || { isOnTrial: false };
  const trialStatusBadge =
    trialInfo.daysRemaining !== null && trialInfo.daysRemaining !== undefined
      ? getTrialStatusBadge(trialInfo.daysRemaining)
      : null;

  // Filter entitlements to show only usage-based features with usage data and available credits
  const usageBasedEntitlements =
    entitlements?.filter(
      (entitlement) =>
        entitlement.usages &&
        entitlement.usages.length > 0 &&
        entitlement.feature &&
        (typeof entitlement.feature.value === "number" ||
          entitlement.feature.value === "usage_based") &&
        entitlement.creditInfo &&
        entitlement.creditInfo.creditsRemaining > 0
    ) || [];

  return (
    <div className="container mx-auto py-8">
      {/* Header */}
      <div className="space-y-6 mb-8">
        {/* Back Button */}
        <div className="flex justify-between items-center">
          <Button variant="outline" onClick={handleNavigateBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
            <kbd className="ml-2 inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">
                <Trash2 className="mr-2 h-4 w-4" />
                Cancel Subscription
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel Subscription</AlertDialogTitle>
                <AlertDialogDescription>
                  This will immediately cancel the subscription and end billing.
                  The customer will lose access to all features. This action
                  cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={() => deleteSubscriptionMutation.mutate()}
                  disabled={deleteSubscriptionMutation.isPending}
                >
                  {deleteSubscriptionMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Cancelling...
                    </>
                  ) : (
                    <>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Cancel Subscription
                    </>
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* Title and ID Section */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">
              Subscription Details
            </h1>
            {trialInfo.isOnTrial && trialStatusBadge && (
              <Badge className={`${trialStatusBadge.className} px-3 py-1`}>
                {trialStatusBadge.icon}
                <span className="ml-1.5 font-medium">
                  {trialStatusBadge.text}
                </span>
              </Badge>
            )}
          </div>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 mt-3 w-fit"
                  onClick={handleCopyId}
                >
                  <code className="px-3 py-2 text-sm font-mono">
                    {subscription.id}
                  </code>
                  <div className="h-10 px-3 flex items-center">
                    <Copy className="h-4 w-4" />
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Click to copy subscription ID</p>
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
            {getStatusIcon(status)}
          </CardHeader>
          <CardContent>
            <Badge className={getStatusColor(status)}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              MRR Contribution
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(
                mrrContribution,
                subscription.price?.currency || "USD"
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {isSeatBasedSubscription
                ? `Monthly recurring revenue (${currentSeatCount} seats)`
                : "Monthly recurring revenue"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Active Credits
            </CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCredits.length}</div>
            <p className="text-xs text-muted-foreground">
              {activeCredits.reduce((sum, c) => sum + c.remainingAmount, 0)}{" "}
              remaining
            </p>
          </CardContent>
        </Card>

        {isSeatBasedSubscription ? (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Active Seats
              </CardTitle>
              <User className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{currentSeatCount}</div>
              <p className="text-xs text-muted-foreground">
                Current active seats
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Recent Activity
              </CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {subscriptionEvents.length}
              </div>
              <p className="text-xs text-muted-foreground">Recent events</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column - Subscription & Customer Info */}
        <div className="space-y-6">
          {/* Subscription Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Calendar className="mr-2 h-5 w-5" />
                Subscription Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Plan
                </p>
                <p className="text-lg font-semibold">
                  {subscription.plan.planName}
                </p>
                {subscription.plan.planDescription && (
                  <p className="text-sm text-muted-foreground">
                    {subscription.plan.planDescription}
                  </p>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Pricing
                </p>
                <div className="flex items-center gap-2">
                  <p className="text-lg font-semibold">
                    {trialInfo.isOnTrial ? "Free Trial" : priceDisplay}
                  </p>
                  {isSeatBasedSubscription && (
                    <Badge
                      variant="secondary"
                      className="bg-blue-100 text-blue-800 border-blue-200"
                    >
                      Seat-based
                    </Badge>
                  )}
                  {trialInfo.isOnTrial && trialInfo.upcomingPrice && (
                    <Badge variant="outline" className="text-xs">
                      Then{" "}
                      {formatPriceDisplay({
                        ...subscription,
                        price: trialInfo.upcomingPrice,
                      })}
                    </Badge>
                  )}
                </div>
                {trialInfo.isOnTrial && trialInfo.trialEndDate && (
                  <div className="text-sm text-muted-foreground mt-1">
                    Trial ends <LocaleAwareDate date={trialInfo.trialEndDate} />
                    {trialInfo.daysRemaining !== null && (
                      <span className="ml-1">
                        (
                        {trialInfo.daysRemaining === 0
                          ? "today"
                          : `${trialInfo.daysRemaining} days left`}
                        )
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Seat Information Section for Seat-based Subscriptions */}
              {isSeatBasedSubscription && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-4">
                    Seat Information
                  </p>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-blue-600" />
                        <span className="text-sm font-medium text-blue-900">
                          Current Active Seats
                        </span>
                      </div>
                      <span className="text-lg font-bold text-blue-900">
                        {currentSeatCount}
                      </span>
                    </div>
                    {/* Pending Removals Alert */}
                    {pendingRemovals > 0 && (
                      <div className="bg-amber-50 border border-amber-200 rounded-md p-3 mb-3">
                        <div className="flex items-center">
                          <AlertCircle className="h-4 w-4 text-amber-600 mr-2" />
                          <div>
                            <p className="text-xs font-medium text-amber-800">
                              {pendingRemovals} seat
                              {pendingRemovals > 1 ? "s" : ""} pending removal
                            </p>
                            <p className="text-xs text-amber-700">
                              Will take effect after next billing cycle
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="text-xs text-blue-700">
                      Seats are managed through the API and billing is
                      calculated based on the number of active seats during each
                      billing period.
                    </div>
                  </div>
                </div>
              )}

              {/* Plan Credits Section */}
              {dedupedCreditDefinitions.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-4">
                    Plan Credits
                  </p>
                  <div className="space-y-3">
                    {dedupedCreditDefinitions.map((creditDef, creditIndex) => {
                      // Determine refresh schedule
                      const getRefreshLabel = () => {
                        if (creditDef.renewOnBilling) {
                          return "Per billing cycle";
                        }
                        if (creditDef.refillRrule) {
                          const rule = creditDef.refillRrule.toLowerCase();
                          if (rule.includes("month")) return "Monthly";
                          if (rule.includes("year")) return "Yearly";
                          if (rule.includes("week")) return "Weekly";
                          if (rule.includes("day")) return "Daily";
                          return "Periodic";
                        }
                        if (
                          creditDef.refillAmount &&
                          creditDef.refillAmount > 0
                        ) {
                          return "Renewable";
                        }
                        return null;
                      };

                      const refreshLabel = getRefreshLabel();

                      return (
                        <div
                          key={`${creditDef.id}-${creditIndex}`}
                          className={`rounded-lg px-4 py-4 border ${
                            creditDef.applicationType === "usage"
                              ? "bg-blue-50 border-blue-200 text-blue-700"
                              : creditDef.applicationType === "monetary"
                                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                                : creditDef.applicationType === "component"
                                  ? "bg-purple-50 border-purple-200 text-purple-700"
                                  : "bg-slate-50 border-slate-200 text-slate-700"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex-1 pr-4">
                              <div className="font-semibold text-base leading-tight">
                                {creditDef.name}
                              </div>
                              {creditDef.description && (
                                <div className="text-xs mt-1.5 opacity-75 leading-relaxed">
                                  {creditDef.description}
                                </div>
                              )}
                            </div>
                            <div className="flex-shrink-0 text-right">
                              {creditDef.applicationType === "usage" ? (
                                <>
                                  <div className="font-bold text-base leading-tight">
                                    {creditDef.defaultAmount.toLocaleString()}
                                  </div>
                                  <div className="text-xs font-medium opacity-90 mt-0.5">
                                    credits
                                  </div>
                                  {refreshLabel && (
                                    <div className="text-xs opacity-70 mt-1.5 font-medium">
                                      {refreshLabel}
                                    </div>
                                  )}
                                </>
                              ) : creditDef.applicationType === "monetary" ? (
                                <>
                                  <div className="font-bold text-base leading-tight">
                                    {creditDef.currency === "USD" ? "$" : "€"}
                                    {(creditDef.defaultAmount / 100).toFixed(2)}
                                  </div>
                                  <div className="text-xs font-medium opacity-90 mt-0.5">
                                    discount
                                  </div>
                                  {refreshLabel && (
                                    <div className="text-xs opacity-70 mt-1.5 font-medium">
                                      {refreshLabel}
                                    </div>
                                  )}
                                </>
                              ) : creditDef.applicationType === "component" ? (
                                <>
                                  <div className="font-bold text-base leading-tight">
                                    {creditDef.currency === "USD" ? "$" : "€"}
                                    {(creditDef.defaultAmount / 100).toFixed(2)}
                                  </div>
                                  <div className="text-xs font-medium opacity-90 mt-0.5">
                                    component
                                  </div>
                                  {refreshLabel && (
                                    <div className="text-xs opacity-70 mt-1.5 font-medium">
                                      {refreshLabel}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="font-bold text-base">
                                  {creditDef.applicationType}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <Separator />

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Started
                  </p>
                  <LocaleAwareDate
                    date={subscription.startTimestamp}
                    className="text-sm"
                  />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Version
                  </p>
                  <p className="text-sm">v{subscription.versionNumber}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Customer Information */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center">
                  <User className="mr-2 h-5 w-5" />
                  Customer Information
                </div>
                <Link href={`/customers/${subscription.customer.id}`}>
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
                  {subscription.customer.name || "Unknown Customer"}
                </p>
                <div className="flex items-center text-sm text-muted-foreground mt-1">
                  <Mail className="mr-1 h-4 w-4" />
                  {subscription.customer.email || "No email"}
                </div>
                {subscription.customer.phone && (
                  <div className="flex items-center text-sm text-muted-foreground mt-1">
                    <Phone className="mr-1 h-4 w-4" />
                    {subscription.customer.phone}
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
                      {subscription.customer.billingAddressLine1 ? (
                        <>
                          <p>{subscription.customer.billingAddressLine1}</p>
                          {subscription.customer.billingAddressLine2 && (
                            <p>{subscription.customer.billingAddressLine2}</p>
                          )}
                          <p>
                            {subscription.customer.billingCity &&
                              `${subscription.customer.billingCity}, `}
                            {subscription.customer.billingPostalCode &&
                              `${subscription.customer.billingPostalCode} `}
                            {subscription.customer.billingCountry}
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
                {(subscription.customer.taxId ||
                  subscription.customer.businessName ||
                  subscription.customer.taxExemptionReason ||
                  subscription.customer.taxExemptionCertificate ||
                  subscription.customer.taxCalculationMethod ||
                  subscription.customer.taxExempt === true) && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-3">
                      Tax Information
                    </p>
                    <div className="space-y-1">
                      {subscription.customer.businessName && (
                        <div className="grid grid-cols-2 gap-4 py-0.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            Business Name
                          </p>
                          <p className="text-sm">
                            {subscription.customer.businessName}
                          </p>
                        </div>
                      )}
                      {subscription.customer.taxId && (
                        <div className="grid grid-cols-2 gap-4 py-0.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            Tax ID
                          </p>
                          <div>
                            <Badge variant="outline" className="font-mono">
                              {subscription.customer.taxId}
                            </Badge>
                          </div>
                        </div>
                      )}
                      {(isBusinessCustomer ||
                        subscription.customer.taxExempt === true) && (
                        <div className="grid grid-cols-2 gap-4 py-0.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            Tax Status
                          </p>
                          <div>
                            <Badge
                              variant={
                                subscription.customer.taxExempt
                                  ? "secondary"
                                  : "outline"
                              }
                              className={
                                subscription.customer.taxExempt
                                  ? "bg-amber-100 text-amber-800 border-amber-200"
                                  : "bg-green-100 text-green-800 border-green-200"
                              }
                            >
                              {subscription.customer.taxExempt
                                ? "Tax Exempt"
                                : "Tax Applicable"}
                            </Badge>
                          </div>
                        </div>
                      )}
                      {subscription.customer.taxExemptionReason && (
                        <div className="grid grid-cols-2 gap-4 py-0.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            Exemption Reason
                          </p>
                          <p className="text-sm capitalize">
                            {subscription.customer.taxExemptionReason.replace(
                              "_",
                              " "
                            )}
                          </p>
                        </div>
                      )}
                      {subscription.customer.taxExemptionCertificate && (
                        <div className="grid grid-cols-2 gap-4 py-0.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            Exemption Certificate
                          </p>
                          <p className="text-sm">
                            {subscription.customer.taxExemptionCertificate}
                          </p>
                        </div>
                      )}
                      {subscription.customer.taxCalculationMethod && (
                        <div className="grid grid-cols-2 gap-4 py-0.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            Tax Calculation Method
                          </p>
                          <div>
                            <Badge variant="outline" className="capitalize">
                              {subscription.customer.taxCalculationMethod}
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
        </div>

        {/* Right Column - Activity & Data */}
        <div className="lg:col-span-2">
          <div className="space-y-6">
            {/* Tab Navigation */}
            <div className="flex space-x-1 bg-muted p-1 rounded-md">
              {[
                { id: "payments", label: "Payments", icon: CreditCard },
                { id: "invoices", label: "Invoices", icon: DollarSign },
                { id: "credits", label: "Credits", icon: CreditCard },
                { id: "usage", label: "Current Usage", icon: TrendingUp },
                ...(isSeatBasedSubscription
                  ? [{ id: "seats", label: "Seats", icon: User }]
                  : []),
                { id: "events", label: "Events", icon: Activity },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-sm transition-all ${
                    activeTab === tab.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <tab.icon className="h-4 w-4" />
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            {activeTab === "payments" && (
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center">
                      <CreditCard className="mr-2 h-5 w-5" />
                      Payment History
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {recentPayments.length > 0 ||
                    finalUpcomingBilling.length > 0 ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Payment ID</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Amount</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Details</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {/* Past Payment Rows */}
                          {recentPayments.map((payment) => (
                            <TableRow key={payment.id}>
                              <TableCell>
                                <a
                                  href={`/payments/${payment.id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline font-mono text-sm"
                                >
                                  {payment.id.slice(0, 8)}...
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </TableCell>
                              <TableCell>
                                <LocaleAwareDate
                                  date={payment.createdAt}
                                  className="text-sm"
                                />
                              </TableCell>
                              <TableCell className="font-medium">
                                {formatCurrency(
                                  payment.amountCents,
                                  payment.currency
                                )}
                              </TableCell>
                              <TableCell>
                                {(payment.refundedAmountCents || 0) > 0 ? (
                                  <Badge className="bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-200">
                                    {payment.refundStatus &&
                                    payment.refundStatus !== "full"
                                      ? "partially refunded"
                                      : "refunded"}
                                  </Badge>
                                ) : (
                                  <Badge
                                    className={getStatusColor(payment.status)}
                                  >
                                    {payment.status}
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  {payment.errorMessage ? (
                                    <p className="text-sm text-red-600">
                                      {payment.errorMessage}
                                    </p>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">
                                      Past payment
                                    </span>
                                  )}
                                  {payment.status === "succeeded" &&
                                    payment.refundStatus !== "full" && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          setRefundTargetPayment(payment);
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
                              </TableCell>
                            </TableRow>
                          ))}

                          {/* Visual Separator between historical and upcoming */}
                          {finalUpcomingBilling.length > 0 && (
                            <TableRow>
                              <TableCell
                                colSpan={5}
                                className="py-3 bg-gray-100 text-center text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                              >
                                Upcoming
                              </TableCell>
                            </TableRow>
                          )}

                          {/* Upcoming Billing Rows */}
                          {finalUpcomingBilling.map((billing, index) => (
                            <TableRow
                              key={`upcoming-${index}`}
                              className="bg-blue-50 border-blue-200"
                            >
                              <TableCell>
                                <span className="text-xs text-blue-600">
                                  Upcoming
                                </span>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center">
                                  <LocaleAwareDate
                                    date={billing.nextBillingDate}
                                    className="text-sm font-medium text-blue-900"
                                  />
                                </div>
                              </TableCell>
                              <TableCell className="font-medium">
                                <div className="text-blue-900">
                                  {billing.totalFixedAmountCents > 0
                                    ? formatCurrency(
                                        billing.totalFixedAmountCents,
                                        subscription.price?.currency || "USD"
                                      )
                                    : "Free"}
                                  {billing.hasUsageComponents &&
                                    billing.totalFixedAmountCents > 0 && (
                                      <span className="text-xs text-blue-600 ml-1">
                                        + Usage
                                      </span>
                                    )}
                                  {billing.hasUsageComponents &&
                                    billing.totalFixedAmountCents === 0 && (
                                      <span className="text-sm font-medium text-blue-900">
                                        {billing.components.some(
                                          (c) => c.type === "per_unit"
                                        )
                                          ? "Seat-based"
                                          : "Usage-based"}
                                      </span>
                                    )}
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="text-xs text-blue-600 ml-1 cursor-help">
                                        + tax
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>
                                        Taxes will be calculated at the time of
                                        billing
                                      </p>
                                    </TooltipContent>
                                  </Tooltip>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge className="bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200">
                                  {trialInfo.isOnTrial
                                    ? "first billing"
                                    : "upcoming"}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <div className="text-xs text-blue-700">
                                  {billing.components.map((comp, compIndex) => {
                                    const amount = comp.amountCents ?? 0;
                                    const price = formatCurrency(
                                      amount,
                                      subscription.price?.currency || "USD"
                                    );

                                    if (comp.type === "fixed") {
                                      return (
                                        <div key={compIndex}>
                                          {`${price} (Fixed Monthly Price)`}
                                        </div>
                                      );
                                    }

                                    if (comp.type === "per_unit") {
                                      // Find the corresponding component to get unit_label and minimum seats
                                      const subDetail =
                                        subscriptionDetails?.find(
                                          (detail) =>
                                            detail.componentId ===
                                            comp.componentId
                                        );
                                      const unitLabel =
                                        subDetail?.component?.unit_label ||
                                        "unit";
                                      const unitPrice = comp.unitPrice || 0;
                                      const currentSeatCount =
                                        comp.seatCount || 0;

                                      // Get minimum seats from the original subscription price component
                                      // Match by component_name since subscription price components don't have component_id
                                      const originalComponent =
                                        subscription.price?.pricingData?.components?.find(
                                          (c) =>
                                            c.component_name ===
                                            comp.componentName
                                        );
                                      const minSeats =
                                        (
                                          originalComponent as PerUnitPriceComponentSchemaType
                                        )?.num_seats || 0;

                                      const unitPriceFormatted = formatCurrency(
                                        unitPrice,
                                        subscription.price?.currency || "USD"
                                      );

                                      if (minSeats > 0) {
                                        const minSeatsAmount =
                                          unitPrice * minSeats;
                                        const additionalSeats = Math.max(
                                          0,
                                          currentSeatCount - minSeats
                                        );

                                        const line1 = `${unitPriceFormatted} per ${unitLabel} × ${minSeats} minimum = ${formatCurrency(minSeatsAmount, subscription.price?.currency || "USD")}`;
                                        const line2 =
                                          additionalSeats > 0
                                            ? `+ ${additionalSeats} additional ${unitLabel}${additionalSeats !== 1 ? "s" : ""}`
                                            : `+ additional ${unitLabel}s as used`;

                                        return (
                                          <div key={compIndex}>
                                            <div>{line1}</div>
                                            <div className="text-muted-foreground">
                                              {line2}
                                            </div>
                                          </div>
                                        );
                                      } else {
                                        return (
                                          <div key={compIndex}>
                                            {`${unitPriceFormatted} per ${unitLabel}`}
                                          </div>
                                        );
                                      }
                                    }

                                    // For usage / variable components
                                    return (
                                      <div key={compIndex}>
                                        {`${price} * Usage`}
                                      </div>
                                    );
                                  })}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No payments found
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === "invoices" && (
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center">
                      <DollarSign className="mr-2 h-5 w-5" />
                      Invoice History
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {recentInvoices.length > 0 ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Invoice #</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Amount</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {recentInvoices.map((invoice) => (
                            <TableRow key={invoice.id}>
                              <TableCell className="font-medium">
                                <a
                                  href={`/invoices/${invoice.id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline"
                                >
                                  {invoice.customerInvoiceNumber}
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </TableCell>
                              <TableCell>
                                <LocaleAwareDate
                                  date={invoice.issueDate}
                                  className="text-sm"
                                />
                              </TableCell>
                              <TableCell className="font-medium">
                                {formatCurrency(
                                  invoice.totalAmountCents,
                                  invoice.currency
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  className={getStatusColor(invoice.status)}
                                >
                                  {invoice.status}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <div className="flex space-x-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleViewInvoice(invoice)}
                                    disabled={
                                      !invoice.hasPdf ||
                                      pdfLoadingId === invoice.id
                                    }
                                  >
                                    {pdfLoadingId === invoice.id ? (
                                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                    ) : (
                                      <Eye className="h-4 w-4 mr-1" />
                                    )}
                                    View
                                  </Button>
                                  {invoice.hasPdf && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        handleDownloadInvoice(invoice)
                                      }
                                      disabled={pdfLoadingId === invoice.id}
                                    >
                                      {pdfLoadingId === invoice.id ? (
                                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                      ) : (
                                        <Download className="h-4 w-4 mr-1" />
                                      )}
                                      PDF
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No invoices found
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === "credits" && (
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center">
                      <CreditCard className="mr-2 h-5 w-5" />
                      Credit Grants
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {credits && credits.length > 0 ? (
                      <div className="rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Credit</TableHead>
                              <TableHead>Type</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Remaining</TableHead>
                              <TableHead>Total</TableHead>
                              <TableHead>Expires</TableHead>
                              <TableHead>Source</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {credits.map((grant) => {
                              const statusInfo = formatCreditStatus(
                                grant.status
                              );
                              return (
                                <TableRow key={grant.id}>
                                  <TableCell>
                                    <div>
                                      <div className="font-medium">
                                        {grant.creditDefinition?.name ||
                                          "Unknown Credit"}
                                      </div>
                                      {grant.creditDefinition?.description && (
                                        <div className="text-sm text-muted-foreground">
                                          {grant.creditDefinition.description}
                                        </div>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex items-center gap-1">
                                      <Badge variant="outline">
                                        {grant.applicationType}
                                      </Badge>
                                      <Badge variant="outline">
                                        {grant.creditDefinition?.scope ||
                                          "unknown"}
                                      </Badge>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Badge className={statusInfo.className}>
                                      {statusInfo.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell>
                                    <div className="font-medium">
                                      {grant.applicationType === "monetary"
                                        ? formatCurrencyLocal(
                                            grant.remainingAmount,
                                            grant.currency
                                          )
                                        : grant.remainingAmount.toLocaleString()}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <div className="text-muted-foreground">
                                      {grant.applicationType === "monetary"
                                        ? formatCurrencyLocal(
                                            grant.initialAmount,
                                            grant.currency
                                          )
                                        : grant.initialAmount.toLocaleString()}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <div className="text-sm">
                                      {grant.expiryDate ? (
                                        <LocaleAwareDate
                                          date={grant.expiryDate}
                                          className="text-sm"
                                        />
                                      ) : (
                                        "Never"
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Badge
                                      variant="outline"
                                      className="capitalize"
                                    >
                                      {grant.source.toLowerCase()}
                                    </Badge>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <Gift className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p>No credit grants found for this customer</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === "usage" && (
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center">
                      <TrendingUp className="mr-2 h-5 w-5" />
                      Current Usage (This Billing Period)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {usageBasedEntitlements.length > 0 ? (
                      <div className="space-y-4">
                        <div className="text-sm text-muted-foreground">
                          Usage for features in this subscription for the
                          current billing period
                        </div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Feature</TableHead>
                              <TableHead>Current Usage</TableHead>
                              <TableHead>Limit</TableHead>
                              <TableHead>Usage %</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Credit Expiry</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {usageBasedEntitlements.map(
                              (entitlement, index) => {
                                const totalUsage =
                                  entitlement.usages?.reduce(
                                    (sum, usage) => sum + usage.usage,
                                    0
                                  ) || 0;
                                const limit =
                                  typeof entitlement.feature?.value === "number"
                                    ? entitlement.feature.value
                                    : entitlement.creditInfo?.creditAllowance ||
                                      0;
                                const usagePercent =
                                  limit > 0
                                    ? Math.round((totalUsage / limit) * 100)
                                    : 0;
                                const isOverLimit = totalUsage > limit;

                                return (
                                  <TableRow key={index}>
                                    <TableCell className="font-medium">
                                      {(() => {
                                        const slug = entitlement.feature?.slug;
                                        if (!slug) return "Unknown Feature";
                                        const name = featureNameMap.get(slug);
                                        if (name && name !== slug) {
                                          return `${name} (${slug})`;
                                        }
                                        return slug;
                                      })()}
                                    </TableCell>
                                    <TableCell>
                                      <div className="font-mono text-sm">
                                        {totalUsage.toLocaleString()}
                                      </div>
                                      {entitlement.usages &&
                                        entitlement.usages.length > 1 && (
                                          <div className="text-xs text-muted-foreground">
                                            {entitlement.usages.map(
                                              (usage, idx) => (
                                                <div key={idx}>
                                                  Metric {idx + 1}:{" "}
                                                  {usage.usage.toLocaleString()}
                                                </div>
                                              )
                                            )}
                                          </div>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                      <div className="font-mono text-sm">
                                        {limit.toLocaleString()}
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        {entitlement.source === "credits"
                                          ? "Credit Allowance"
                                          : "Plan Limit"}
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                                          <div
                                            className={`h-full transition-all ${
                                              usagePercent > 100
                                                ? "bg-red-500"
                                                : usagePercent > 80
                                                  ? "bg-yellow-500"
                                                  : "bg-green-500"
                                            }`}
                                            style={{
                                              width: `${Math.min(usagePercent, 100)}%`,
                                            }}
                                          />
                                        </div>
                                        <span className="text-sm font-medium">
                                          {usagePercent}%
                                        </span>
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <Badge
                                        className={
                                          isOverLimit
                                            ? "bg-red-100 text-red-800 border-red-200"
                                            : entitlement.entitled
                                              ? "bg-green-100 text-green-800 border-green-200"
                                              : "bg-gray-100 text-gray-800 border-gray-200"
                                        }
                                      >
                                        {isOverLimit
                                          ? "Over Limit"
                                          : entitlement.entitled
                                            ? "Entitled"
                                            : "Not Entitled"}
                                      </Badge>
                                    </TableCell>
                                    <TableCell>
                                      {entitlement.creditInfo
                                        ?.nextExpiryDate ? (
                                        <LocaleAwareDate
                                          date={
                                            entitlement.creditInfo
                                              .nextExpiryDate
                                          }
                                          className="text-sm"
                                        />
                                      ) : entitlement.source === "credits" ? (
                                        <span className="text-sm text-muted-foreground">
                                          Never
                                        </span>
                                      ) : (
                                        <span className="text-sm text-muted-foreground">
                                          —
                                        </span>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                );
                              }
                            )}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p className="mb-2">
                          No usage-based features with available credits found
                        </p>
                        <div className="text-xs space-y-1">
                          <p>
                            This subscription may only have fixed-price
                            features, or all usage credits have been depleted.
                          </p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === "seats" && isSeatBasedSubscription && (
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center">
                      <User className="mr-2 h-5 w-5" />
                      Seat Management
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-6">
                      {/* Current Seat Count */}
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
                        <div className="flex items-center justify-between mb-4">
                          <div>
                            <h3 className="text-lg font-semibold text-blue-900">
                              Current Active Seats
                            </h3>
                            <p className="text-sm text-blue-700">
                              Based on seat events in the current billing period
                            </p>
                          </div>
                          <div className="text-3xl font-bold text-blue-900">
                            {currentSeatCount}
                          </div>
                        </div>

                        {/* Pending Removals Warning */}
                        {pendingRemovals > 0 && (
                          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
                            <div className="flex items-center">
                              <AlertCircle className="h-5 w-5 text-amber-600 mr-2" />
                              <div>
                                <h4 className="text-sm font-medium text-amber-800">
                                  Pending Removals
                                </h4>
                                <p className="text-sm text-amber-700">
                                  {pendingRemovals} seat
                                  {pendingRemovals > 1 ? "s" : ""} removed in
                                  current period will take effect in next
                                  billing cycle
                                </p>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Pricing Information */}
                        <div className="border-t border-blue-200 pt-4">
                          <h4 className="text-sm font-medium text-blue-900 mb-2">
                            Pricing Information
                          </h4>
                          <div className="text-sm text-blue-700">
                            {subscription.price?.pricingData?.components
                              ?.filter((c) => c.type === "per_unit")
                              .map((component, index) => (
                                <div key={index} className="mb-1">
                                  {formatCurrency(
                                    component.amount_cents ||
                                      component.unit_cost_cents ||
                                      0,
                                    subscription.price?.currency || "USD"
                                  )}{" "}
                                  per {component.unit_label || "unit"}{" "}
                                  {formatRecurrence(component.recurrence_rule)}
                                </div>
                              ))}
                          </div>
                        </div>
                      </div>

                      {/* Next Billing Estimate */}
                      <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                        <div className="flex items-center justify-between mb-4">
                          <div>
                            <h3 className="text-lg font-semibold text-green-900">
                              Next Billing Estimate
                            </h3>
                            <p className="text-sm text-green-700">
                              Estimated amount for next billing cycle
                            </p>
                          </div>
                          <div className="text-3xl font-bold text-green-900">
                            {formatCurrency(
                              nextBillingAmount,
                              subscription.price?.currency || "USD"
                            )}
                          </div>
                        </div>

                        <div className="border-t border-green-200 pt-4">
                          <div className="text-sm text-green-700">
                            <div className="flex justify-between items-center mb-2">
                              <span>Seats to be billed:</span>
                              <span className="font-medium">
                                {currentSeatCount}
                              </span>
                            </div>
                            {pendingRemovals > 0 && (
                              <div className="flex justify-between items-center mb-2 text-amber-700">
                                <span>
                                  Removals (take effect after billing):
                                </span>
                                <span className="font-medium">
                                  -{pendingRemovals}
                                </span>
                              </div>
                            )}
                            <div className="flex justify-between items-center font-medium border-t border-green-200 pt-2">
                              <span>Seats after next billing:</span>
                              <span>
                                {Math.max(
                                  0,
                                  currentSeatCount - pendingRemovals
                                )}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Recent Seat Events */}
                      <div>
                        <h3 className="text-lg font-semibold mb-4">
                          Recent Seat Events
                        </h3>
                        {subscriptionEvents.filter(
                          (e) =>
                            e.eventName === "seat_added" ||
                            e.eventName === "seat_removed"
                        ).length > 0 ? (
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Event</TableHead>
                                <TableHead>User ID</TableHead>
                                <TableHead>Date & Time</TableHead>
                                <TableHead>Properties</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {subscriptionEvents
                                .filter(
                                  (e) =>
                                    e.eventName === "seat_added" ||
                                    e.eventName === "seat_removed"
                                )
                                .slice(0, 10)
                                .map((event, index) => (
                                  <TableRow key={index}>
                                    <TableCell>
                                      <Badge
                                        className={
                                          event.eventName === "seat_added"
                                            ? "bg-green-100 text-green-800 border-green-200"
                                            : "bg-red-100 text-red-800 border-red-200"
                                        }
                                      >
                                        {event.eventName === "seat_added"
                                          ? "Added"
                                          : "Removed"}
                                      </Badge>
                                    </TableCell>
                                    <TableCell className="font-mono text-sm">
                                      {event.eventString || "Unknown"}
                                    </TableCell>
                                    <TableCell>
                                      <div className="text-sm">
                                        <LocaleAwareDate
                                          date={event.eventTimestamp}
                                          className="block"
                                        />
                                        <span className="text-xs text-muted-foreground">
                                          {new Date(
                                            event.eventTimestamp
                                          ).toLocaleTimeString("en-US", {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                            hour12: true,
                                          })}
                                        </span>
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      {event.properties &&
                                      typeof event.properties === "object" &&
                                      Object.keys(event.properties).length >
                                        0 ? (
                                        <div className="text-xs">
                                          {Object.entries(event.properties).map(
                                            ([key, value]) => (
                                              <div key={key} className="mb-1">
                                                <span className="font-medium text-muted-foreground">
                                                  {key}:
                                                </span>{" "}
                                                <code className="bg-muted px-1 py-0.5 rounded text-xs">
                                                  {typeof value === "string"
                                                    ? value
                                                    : JSON.stringify(value)}
                                                </code>
                                              </div>
                                            )
                                          )}
                                        </div>
                                      ) : event.properties ? (
                                        <code className="text-xs bg-muted px-2 py-1 rounded">
                                          {typeof event.properties === "string"
                                            ? event.properties
                                            : JSON.stringify(event.properties)}
                                        </code>
                                      ) : (
                                        "—"
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                            </TableBody>
                          </Table>
                        ) : (
                          <div className="text-center py-8 text-muted-foreground">
                            <User className="h-8 w-8 mx-auto mb-2 opacity-50" />
                            <p>No seat events found for this subscription</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === "events" && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center">
                      <Activity className="mr-2 h-5 w-5" />
                      Events
                    </CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEventsLimit(10); // Reset to initial limit
                        refetchEvents();
                      }}
                      disabled={eventsLoading || eventsRefetching}
                    >
                      <RefreshCw
                        className={cn(
                          "h-4 w-4 mr-2",
                          eventsRefetching && "animate-spin"
                        )}
                      />
                      Refresh
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {eventsLoading ? (
                    <div className="space-y-3">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-16 w-full" />
                      ))}
                    </div>
                  ) : subscriptionEvents && subscriptionEvents.length > 0 ? (
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Event Name</TableHead>
                            <TableHead>Timestamp</TableHead>
                            <TableHead>Value</TableHead>
                            <TableHead>Properties</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {subscriptionEvents.map((event) => {
                            return (
                              <TableRow
                                key={`${event.idempotencyKey}-${event.eventTimestamp}`}
                              >
                                <TableCell>
                                  <Badge
                                    variant="secondary"
                                    className="font-mono text-xs"
                                  >
                                    {event.eventName}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <div className="font-medium">
                                    <div className="text-sm">
                                      {dateFormatter.formatDate(
                                        event.eventTimestamp,
                                        {
                                          style: "medium",
                                          includeTime: true,
                                        }
                                      )}
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <div className="font-medium">
                                    {event.eventValue ?? "—"}
                                    {event.eventString && (
                                      <div className="text-xs text-muted-foreground mt-1">
                                        &ldquo;{event.eventString}&rdquo;
                                      </div>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  {(() => {
                                    const rawProperties = event.properties;
                                    let properties: Record<
                                      string,
                                      unknown
                                    > | null = null;

                                    try {
                                      if (typeof rawProperties === "string") {
                                        properties = JSON.parse(rawProperties);
                                      } else if (
                                        rawProperties &&
                                        typeof rawProperties === "object"
                                      ) {
                                        properties = rawProperties as Record<
                                          string,
                                          unknown
                                        >;
                                      }
                                    } catch {
                                      properties = null;
                                    }

                                    if (
                                      !properties ||
                                      Object.keys(properties).length === 0
                                    ) {
                                      return (
                                        <div className="text-muted-foreground">
                                          —
                                        </div>
                                      );
                                    }

                                    const formattedForDisplay = Object.entries(
                                      properties
                                    )
                                      .map(([key, value]) => {
                                        if (typeof value === "string") {
                                          return `${key}: "${value}"`;
                                        }
                                        return `${key}: ${value}`;
                                      })
                                      .join(", ");

                                    const truncatedProperties =
                                      formattedForDisplay.length > 50
                                        ? formattedForDisplay.substring(0, 50) +
                                          "..."
                                        : formattedForDisplay;

                                    return (
                                      <div
                                        className="font-mono text-xs max-w-[200px] truncate"
                                        title={formattedForDisplay}
                                      >
                                        {truncatedProperties}
                                      </div>
                                    );
                                  })()}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>

                      {/* Pagination Controls */}
                      <div className="flex items-center justify-between p-4 border-t">
                        <div className="text-sm text-muted-foreground">
                          Showing {subscriptionEvents.length} events
                        </div>
                        <div className="flex items-center gap-2">
                          {hasMoreEvents && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleLoadMoreEvents}
                              disabled={eventsLoading || eventsRefetching}
                            >
                              {eventsRefetching ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  Loading...
                                </>
                              ) : (
                                <>Load More</>
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              router.push(
                                `/events?customerId=${subscription.customerId}`
                              )
                            }
                          >
                            <ExternalLink className="h-4 w-4 mr-2" />
                            View All Events
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>No events found for this customer</p>
                      <p className="text-sm mt-1">
                        Events will appear here when the customer performs
                        tracked actions
                      </p>
                    </div>
                  )}
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
        <DialogContent className="max-w-3xl">
          <DialogTitle>Issue Refund</DialogTitle>
          <div className="space-y-4">
            {refundTargetPayment && (
              <div className="text-sm text-muted-foreground">
                Total paid:{" "}
                {formatCurrency(
                  refundTargetPayment.amountCents,
                  refundTargetPayment.currency
                )}
              </div>
            )}
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
                {refundTargetPayment &&
                  refundAmountInput !== "" &&
                  parseStringToCents(refundAmountInput) >
                    refundTargetPayment.amountCents && (
                    <div className="text-xs text-red-600 mt-1">
                      Amount cannot exceed total paid
                    </div>
                  )}
              </div>
            )}
            {/* Show different buttons based on subscription status */}
            {status === "active" ? (
              // Active subscription: show all three buttons (Cancel, Refund & keep active, Refund & terminate)
              <div className="grid gap-4 sm:grid-cols-2 pt-4">
                <Button
                  variant="outline"
                  className="w-full px-6 py-3"
                  onClick={() => setRefundModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  className="w-full px-6 py-3"
                  onClick={() => {
                    if (!refundTargetPayment) return;
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
                          refundTargetPayment.amountCents)
                    ) {
                      toast.error(
                        "Enter a valid refund amount less than total"
                      );
                      return;
                    }
                    refundPaymentMutation.mutate({
                      paymentId: refundTargetPayment.id,
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
                  onClick={() => {
                    if (!refundTargetPayment) return;
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
                          refundTargetPayment.amountCents)
                    ) {
                      toast.error(
                        "Enter a valid refund amount less than total"
                      );
                      return;
                    }
                    refundPaymentMutation.mutate({
                      paymentId: refundTargetPayment.id,
                      amountCents: payloadAmount,
                      terminate: true,
                    });
                  }}
                  disabled={refundPaymentMutation.isPending}
                  className="w-full sm:col-span-2 px-6 py-3"
                >
                  {refundPaymentMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : null}
                  Refund & terminate subscription
                </Button>
              </div>
            ) : (
              // Inactive subscription: show only Cancel and Refund buttons (no terminate option)
              <div className="grid gap-4 sm:grid-cols-2 pt-4">
                <Button
                  variant="outline"
                  className="w-full px-6 py-3"
                  onClick={() => setRefundModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="w-full px-6 py-3"
                  onClick={() => {
                    if (!refundTargetPayment) return;
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
                          refundTargetPayment.amountCents)
                    ) {
                      toast.error(
                        "Enter a valid refund amount less than total"
                      );
                      return;
                    }
                    refundPaymentMutation.mutate({
                      paymentId: refundTargetPayment.id,
                      amountCents: payloadAmount,
                      // No terminate parameter for inactive subscriptions
                    });
                  }}
                  disabled={refundPaymentMutation.isPending}
                >
                  {refundPaymentMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : null}
                  Refund
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
