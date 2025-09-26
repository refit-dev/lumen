"use client";

import { useAppForm } from "@/hooks/form";
import { z } from "zod";
import { apiClient } from "@/lib/hono-client";
import { customersInsertSchemaUI } from "@lumen/common/schema";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import {
  ArrowLeft,
  Copy,
  Trash2,
  Loader2,
  ExternalLink,
  Gift,
  FileText,
  User,
  Mail,
  Phone,
  MapPin,
  CreditCard,
  DollarSign,
  Activity,
  TrendingUp,
  Receipt,
  Eye,
  Download,
  AlertCircle,
  RefreshCw,
  Info,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
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
import { Badge } from "@/components/ui/badge";
import {
  hasBillingAddress,
  customerCountries,
  usStates,
  supportedCustomerCountries,
  formatCurrency,
} from "@lumen/common/utils";
import { PerUnitPriceComponentSchemaType } from "@lumen/common";
import { Skeleton } from "@/components/ui/skeleton";
import { ManualCreditGrantModal } from "@/components/credits/ManualCreditGrantModal";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { format } from "date-fns";
import { cn, checkTestMode } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";

const removeFalsyValuesFromObject = (obj: Record<string, unknown>) => {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => !!value));
};

// Helper functions for payment status
const getPaymentStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "succeeded":
      return "bg-green-100 text-green-800 border-green-200";
    case "pending":
    case "processing":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "failed":
    case "canceled":
      return "bg-red-100 text-red-800 border-red-200";
    case "refunded":
      return "bg-purple-100 text-purple-800 border-purple-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200";
  }
};

// Helper for Stripe dashboard URLs (payments, setup intents, checkout sessions)
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

// Helper function to calculate MRR contribution from subscription (returns cents)
const calculateMRRContribution = (
  subscription: SubscriptionWithPlan
): number => {
  if (!subscription.price?.pricingData?.components) return 0;

  let mrrCents = 0;
  for (const component of subscription.price.pricingData.components) {
    const amount = component.amount_cents;
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
      // Note: This calculates base MRR assuming minimum seats (since we don't have
      // actual seat usage data per customer in this detail view)
      const minSeats =
        (component as PerUnitPriceComponentSchemaType).num_seats || 1;

      if (recurrenceRule.includes("FREQ=MONTHLY")) {
        // amount is per seat per month
        mrrCents += amount * minSeats;
      } else if (recurrenceRule.includes("FREQ=YEARLY")) {
        // amount is per seat per year, so divide by 12 to get per seat per month
        mrrCents += Math.round((amount * minSeats) / 12);
      }
    }
    // Note: usage-based components are not included in MRR calculation
    // as they are variable and unpredictable
  }
  return mrrCents;
};

// Helper function to get subscription status
const getSubscriptionStatus = (
  subscription: SubscriptionWithPlan
): "active" | "ended" | "future" => {
  const now = new Date();
  const startTime = new Date(subscription.startTimestamp);

  if (subscription.endTimestamp) {
    return "ended";
  }

  if (startTime > now) {
    return "future";
  }

  return "active";
};

// Type for subscription with plan information
interface SubscriptionWithPlan {
  id: string;
  customerId: string;
  planId: string;
  createdAt: string;
  deletedAt: string | null;
  merchantId: string;
  versionNumber: number;
  effectivePriceId: string;
  priceOverrideId: string | null;
  featureOverrideId: string | null;
  startTimestamp: string;
  endTimestamp: string | null;
  plan?: {
    planName: string;
    planDescription?: string | null;
  };
  price?: {
    currency: string;
    pricingData: {
      components: Array<{
        type: string;
        amount_cents?: number;
        recurrence_rule?: string;
        num_seats?: number;
      }>;
    };
  };
}

export default function CreateCustomerPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams();
  const { data: session } = useSession();

  const [isEditMode, setIsEditMode] = useState(
    searchParams.get("edit") === "true"
  );
  const [isCreditModalOpen, setIsCreditModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("subscriptions");
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const [eventsLimit, setEventsLimit] = useState(10);
  const [isTestMode, setIsTestMode] = useState(false);

  const customerId = params.customerId as string;

  // Fetch tax rate definitions for the dropdown
  const { data: taxRateDefinitions } = useQuery({
    queryKey: ["tax-rate-definitions"],
    queryFn: async () => {
      const response = await apiClient.tax["rate-definitions"].$get();
      if (!response.ok) throw new Error("Failed to fetch tax rate definitions");
      return response.json();
    },
  });

  // Fetch merchant tax configuration
  const { data: taxConfig } = useQuery({
    queryKey: ["tax-config"],
    queryFn: async () => {
      const response = await apiClient.tax.config.$get();
      if (!response.ok) throw new Error("Failed to fetch tax config");
      return response.json();
    },
  });

  const deleteCustomerMutation = useMutation({
    mutationFn: async () => {
      const response = await apiClient.customers[":id"].$delete({
        param: { id: customerId },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      router.push("/customers");
    },
  });

  const { data: customer, isLoading } = useQuery({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      if (!customerId) return null;
      const response = await apiClient.customers[":id"].$get({
        param: { id: customerId },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      if (!data.customer) {
        throw new Error("Customer not found");
      }
      return data.customer;
    },
    enabled: !!customerId,
  });

  // Fetch customer credit grants
  const { data: creditGrants } = useQuery({
    queryKey: ["customer-credit-grants", customerId],
    queryFn: async () => {
      const response = await apiClient.credits.customers[
        ":customerId"
      ].grants.$get({
        param: { customerId },
        query: {},
      });
      if (!response.ok) throw new Error("Failed to fetch credit grants");
      return response.json();
    },
    enabled: !!customerId,
  });

  // Fetch customer credit transactions
  const { data: creditTransactions } = useQuery({
    queryKey: ["customer-credit-transactions", customerId],
    queryFn: async () => {
      const response = await apiClient.credits.customers[
        ":customerId"
      ].transactions.$get({
        param: { customerId },
        query: { limit: "50" },
      });
      if (!response.ok) throw new Error("Failed to fetch credit transactions");
      return response.json();
    },
    enabled: !!customerId,
  });

  // Fetch customer subscriptions
  const { data: subscriptions } = useQuery({
    queryKey: ["customer-subscriptions", customerId],
    queryFn: async () => {
      if (!customerId) return [];
      const response = await apiClient.subscriptions.customer[
        ":customerId"
      ].$get({
        param: { customerId },
        query: { includeFeatures: "false" },
      });
      if (!response.ok) throw new Error("Failed to fetch subscriptions");
      const data = await response.json();
      return data.subscriptions || [];
    },
    enabled: !!customerId,
  });

  // Fetch customer invoices
  const { data: invoices } = useQuery({
    queryKey: ["customer-invoices", customerId],
    queryFn: async () => {
      if (!customerId) return [];
      const response = await apiClient.invoices.customer[":customerId"].$get({
        param: { customerId },
      });
      if (!response.ok) throw new Error("Failed to fetch invoices");
      const data = await response.json();
      return data.invoices || [];
    },
    enabled: !!customerId,
  });

  // Fetch customer payments
  const { data: payments } = useQuery({
    queryKey: ["customer-payments", customerId],
    queryFn: async () => {
      if (!customerId) return [];
      const response = await apiClient.payments.$get({
        query: { customerId },
      });
      if (!response.ok) throw new Error("Failed to fetch payments");
      const data = await response.json();
      return data.payments || [];
    },
    enabled: !!customerId,
  });

  // Determine environment test mode (Stripe or Dodo)
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

  // Fetch organization customers if this customer has an organization
  const { data: organizationData } = useQuery({
    queryKey: ["customer-organization", customerId],
    queryFn: async () => {
      if (!customerId) return null;
      const response = await apiClient.customers[":id"][
        "organization-customers"
      ].$get({
        param: { id: customerId },
      });
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!customerId && !!customer?.customerOrganizationId,
  });

  // Fetch entitlements for each org customer to show credits
  const { data: orgCustomerEntitlements } = useQuery({
    queryKey: [
      "org-customer-entitlements",
      customerId,
      organizationData?.customers?.map((c) => c.id),
    ],
    queryFn: async () => {
      if (!organizationData?.customers) return {};

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entitlementsMap: Record<string, any[]> = {};

      for (const orgCustomer of organizationData.customers) {
        try {
          const response = await apiClient.entitlements[":customerId"].$get({
            param: { customerId: orgCustomer.id },
            query: { isExtCustId: "false" },
          });

          if (response.ok) {
            const data = await response.json();
            entitlementsMap[orgCustomer.id] = data.entitlements || [];
          } else {
            entitlementsMap[orgCustomer.id] = [];
          }
        } catch (error) {
          console.error(
            `Failed to fetch entitlements for customer ${orgCustomer.id}:`,
            error
          );
          entitlementsMap[orgCustomer.id] = [];
        }
      }

      return entitlementsMap;
    },
    enabled:
      !!organizationData?.customers && organizationData.customers.length > 0,
  });

  // Fetch latest payment detail (enriched with PSP payment method info)
  const latestPaymentId =
    payments && payments.length > 0 ? payments[0].id : null;
  const { data: latestPaymentDetail } = useQuery({
    queryKey: ["customer-latest-payment-detail", customerId, latestPaymentId],
    queryFn: async () => {
      if (!latestPaymentId) return null;
      const response = await apiClient.payments[":id"].$get({
        param: { id: latestPaymentId },
      });
      if (!response.ok)
        throw new Error("Failed to fetch latest payment detail");
      const data = await response.json();
      if ("error" in data) throw new Error(String(data.error));
      return data.payment as {
        id: string;
        externalPaymentId?: string | null;
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
      };
    },
    enabled: !!latestPaymentId,
  });

  // Fetch entitlements to get usage-based features and their current usage
  const { data: entitlements } = useQuery({
    queryKey: ["entitlements", customerId],
    queryFn: async () => {
      if (!customerId) return [];
      try {
        const response = await apiClient.entitlements[":customerId"].$get({
          param: { customerId },
          query: { isExtCustId: "false" },
        });
        const data = await response.json();
        if ("error" in data) {
          console.error("Entitlements API error:", data.error);
          return [];
        }
        return data.entitlements || [];
      } catch (error) {
        console.error("Failed to fetch entitlements for customer:", error);
        return [];
      }
    },
    enabled: !!customerId,
  });

  // Fetch all features for the current merchant so we can map slug -> display name
  const { data: featuresList } = useQuery({
    queryKey: ["features"],
    queryFn: async () => {
      try {
        const response = await apiClient.features.$get({});
        const data = await response.json();
        if ("error" in data) return [];
        return data.features || [];
      } catch (error) {
        console.error("Failed to fetch features list:", error);
        return [];
      }
    },
  });

  // Fetch customer events
  const {
    data: eventsResponse,
    isLoading: eventsLoading,
    refetch: refetchEvents,
    isRefetching: eventsRefetching,
  } = useQuery({
    queryKey: [
      "customer-events",
      customerId,
      customer?.externalCustomerId || null,
      eventsLimit,
    ],
    queryFn: async () => {
      if (!customerId) return { data: [], hasMore: false };
      try {
        const combinedIds = customer?.externalCustomerId
          ? `${customerId},${customer.externalCustomerId}`
          : customerId;
        const response = await apiClient.events.$get({
          query: {
            customerId: combinedIds,
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
        console.error("Failed to fetch customer events:", error);
        return { data: [], hasMore: false };
      }
    },
    enabled: !!customerId,
  });

  // Extract events data for easier access
  const customerEvents = eventsResponse?.data || [];
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

  const defaultFormValues = useMemo(
    () => ({
      name: "",
      email: "",
      externalCustomerId: "",
      businessName: "",
      billingAddressLine1: "",
      billingAddressLine2: "",
      billingCity: "",
      billingCountry: "",
      billingStateProvince: "",
      billingPostalCode: "",
      taxId: "",
      taxExemptionReason: "no",
      taxRateDefinitionId: "default",
      taxCalculationMethod: "default",
    }),
    []
  );

  const form = useAppForm({
    defaultValues: defaultFormValues,
    onSubmit: async ({ value }) => {
      try {
        // Determine tax treatment from local UI state
        const treatment = selectedTaxTreatment;

        const response = await apiClient.customers[":id"].$post({
          param: { id: customerId },
          json: {
            ...removeFalsyValuesFromObject(value),
            taxExempt: treatment === "exempt",
            // Convert frontend values to backend format
            taxRateDefinitionId:
              treatment === "manual" && value.taxRateDefinitionId !== "default"
                ? value.taxRateDefinitionId
                : null,
            taxCalculationMethod:
              treatment === "auto"
                ? "auto"
                : treatment === "manual"
                  ? "manual"
                  : treatment === "default"
                    ? "default"
                    : taxConfig?.autoTaxCalculation
                      ? "auto"
                      : "default",
            ...(treatment === "exempt"
              ? {
                  taxExemptionReason:
                    selectedExemptionReason === "other"
                      ? exemptionOtherText.trim()
                      : selectedExemptionReason,
                }
              : {}),
          },
        });
        queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }
        setIsEditMode(false);
      } catch (error) {
        console.error("Error updating customer:", error);
        throw error;
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        // Custom validation for US state requirement
        const errors: Record<string, string> = {};
        if (value.billingCountry === "US" && !value.billingStateProvince) {
          errors.billingStateProvince = "State is required for US customers";
        }

        const result = customersInsertSchemaUI.safeParse(value);
        if (!result.success) {
          const schemaErrors = result.error.issues.reduce(
            (acc: Record<string, string>, issue: z.ZodIssue) => ({
              ...acc,
              [issue.path[0]]: issue.message,
            }),
            {}
          );
          Object.assign(errors, schemaErrors);
        }

        if (Object.keys(errors).length > 0) {
          return { fields: errors };
        }
        return undefined;
      },
    },
  });

  // Subscribe to form values so the component re-renders when they change
  const formValues = useStore(form.store, (state) => state.values);

  const hasPopulatedRef = useRef(false);

  // Local UI state for tax treatment & exemption reason selector
  const [selectedTaxTreatment, setSelectedTaxTreatment] = useState<
    "auto" | "manual" | "default" | "exempt"
  >("default");
  const [exemptionDialogOpen, setExemptionDialogOpen] = useState(false);
  const [selectedExemptionReason, setSelectedExemptionReason] =
    useState<string>("nonprofit_organization");
  const [exemptionOtherText, setExemptionOtherText] = useState("");

  useEffect(() => {
    if (!customer || hasPopulatedRef.current) return;

    // Initialize local treatment state based on existing customer
    if (customer.taxExempt) {
      setSelectedTaxTreatment("exempt");
      setSelectedExemptionReason(
        (customer.taxExemptionReason as string) || "nonprofit_organization"
      );
    } else if (customer.taxCalculationMethod === "manual") {
      setSelectedTaxTreatment("manual");
    } else if (customer.taxCalculationMethod === "auto") {
      setSelectedTaxTreatment("auto");
    } else {
      setSelectedTaxTreatment("default");
    }

    form.setFieldValue("name", customer.name ?? "");
    form.setFieldValue("email", customer.email ?? "");
    form.setFieldValue("externalCustomerId", customer.externalCustomerId ?? "");
    form.setFieldValue("businessName", customer.businessName ?? "");
    form.setFieldValue(
      "billingAddressLine1",
      customer.billingAddressLine1 ?? ""
    );
    form.setFieldValue(
      "billingAddressLine2",
      customer.billingAddressLine2 ?? ""
    );
    form.setFieldValue("billingCity", customer.billingCity ?? "");
    form.setFieldValue("billingCountry", customer.billingCountry ?? "");
    form.setFieldValue(
      "billingStateProvince",
      customer.billingStateProvince ?? ""
    );
    form.setFieldValue("billingPostalCode", customer.billingPostalCode ?? "");
    form.setFieldValue("taxId", customer.taxId ?? "");
    form.setFieldValue(
      "taxExemptionReason",
      customer.taxExempt ? customer.taxExemptionReason || "" : ""
    );
    form.setFieldValue(
      "taxRateDefinitionId",
      customer.taxRateDefinitionId || "default"
    );
    form.setFieldValue(
      "taxCalculationMethod",
      customer.taxCalculationMethod || "default"
    );

    hasPopulatedRef.current = true;
  }, [customer, form]);

  const handleNavigateBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleViewInvoice = useCallback(
    async (invoice: { id: string; hasPdf?: boolean }) => {
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
    },
    []
  );

  const handleDownloadInvoice = useCallback(
    async (invoice: {
      id: string;
      customerInvoiceNumber?: string | null;
      hasPdf?: boolean;
    }) => {
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
    },
    []
  );

  // Clear state/province when switching from US to non-US or vice versa
  useEffect(() => {
    const isUS = formValues.billingCountry === "US";
    const hasStateValue = formValues.billingStateProvince;

    // If switching to non-US and there's a US state code, clear it
    if (
      !isUS &&
      hasStateValue &&
      usStates.some((state) => state.value === hasStateValue)
    ) {
      form.setFieldValue("billingStateProvince", "");
    }
  }, [formValues.billingCountry, formValues.billingStateProvince, form]);

  // No longer synchronize form field with UI state - handle only on submit

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        form.handleSubmit();
      }
      if (event.key === "Escape") {
        handleNavigateBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [form, form.handleSubmit, handleNavigateBack]);

  // Prevent auto calculation for unsupported customer countries while editing - UI state only
  useEffect(() => {
    if (!isEditMode) return;

    const isSupported = supportedCustomerCountries.some(
      (c) => c.value === formValues.billingCountry
    );

    if (!isSupported && selectedTaxTreatment === "auto") {
      const fallbackMethod = taxConfig?.defaultTaxRate ? "default" : "manual";
      setSelectedTaxTreatment(
        fallbackMethod === "default" ? "default" : "manual"
      );
    }
  }, [isEditMode, formValues.billingCountry, taxConfig, selectedTaxTreatment]);

  // No longer mirror dropdown into form field; we use local treatment state

  // Helper function to format credit status
  const formatCreditStatus = (status: string) => {
    const statusMap = {
      ACTIVE: { label: "Active", className: "bg-green-100 text-green-800" },
      DEPLETED: { label: "Depleted", className: "bg-gray-100 text-gray-800" },
      EXPIRED: { label: "Expired", className: "bg-red-100 text-red-800" },
      REVOKED: { label: "Revoked", className: "bg-orange-100 text-orange-800" },
    };
    return (
      statusMap[status as keyof typeof statusMap] || {
        label: status,
        className: "bg-gray-100 text-gray-800",
      }
    );
  };

  // Calculate summary metrics
  const activeSubscriptions =
    subscriptions?.filter((sub) => {
      const status = getSubscriptionStatus(sub);
      return status === "active" && !sub.deletedAt;
    }) || [];

  const totalMrrContribution = activeSubscriptions.reduce(
    (sum, sub) => sum + calculateMRRContribution(sub),
    0
  );

  // Calculate invoice breakdown by status
  const invoiceBreakdown =
    invoices?.reduce(
      (breakdown, invoice) => {
        const status = invoice.status;
        const amount = invoice.totalAmountCents || 0;

        console.log(
          `Invoice ${invoice.id}: status="${status}", amount=${amount}`
        );

        if (!breakdown[status]) {
          breakdown[status] = 0;
        }
        breakdown[status] += amount;

        return breakdown;
      },
      {} as Record<string, number>
    ) || {};

  // Calculate total from relevant statuses only (exclude drafts, voids, etc.)
  const relevantStatuses = ["paid", "pending", "overdue"];
  const totalInvoiceAmount = relevantStatuses.reduce((total, status) => {
    return total + (invoiceBreakdown[status] || 0);
  }, 0);

  const activeCredits =
    creditGrants?.grants?.filter((c) => c.status === "ACTIVE") || [];

  // Create a map for quick lookup of displayName by slug
  const featureNameMap = useMemo(() => {
    const map = new Map<string, string>();
    featuresList?.forEach((feat) => {
      map.set(feat.slug, feat.displayName);
    });
    return map;
  }, [featuresList]);

  // Filter entitlements to show only usage-based features with usage data and available credits
  const usageBasedEntitlements = useMemo(() => {
    return (
      entitlements?.filter(
        (entitlement) =>
          entitlement.usages &&
          entitlement.usages.length > 0 &&
          entitlement.feature &&
          (typeof entitlement.feature.value === "number" ||
            entitlement.feature.value === "usage_based") &&
          entitlement.creditInfo &&
          entitlement.creditInfo.creditsRemaining > 0
      ) || []
    );
  }, [entitlements]);

  // Determine currency with fallback priority: plan -> merchant -> customer -> USD
  const activePlanCurrency =
    activeSubscriptions.length > 0
      ? (activeSubscriptions[0] as SubscriptionWithPlan)?.price?.currency
      : null;

  const customerCurrency =
    activePlanCurrency ||
    session?.merchant?.defaultCurrency ||
    customer?.preferredCurrency ||
    "USD";

  // Add expanded state near other state declarations (around line 239)
  const [expandedSeatCustomer, setExpandedSeatCustomer] = useState<
    string | null
  >(null);

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

  if (!customer) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">
            Customer Not Found
          </h1>
          <p className="text-gray-600 mt-2">
            The customer you&apos;re looking for doesn&apos;t exist or has been
            deleted.
          </p>
          <Button onClick={handleNavigateBack} className="mt-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Customers
          </Button>
        </div>
      </div>
    );
  }

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
            <div className="flex items-center space-x-2">
              <Switch
                id="edit-customer"
                checked={isEditMode}
                onCheckedChange={setIsEditMode}
              />
              <Label htmlFor="edit-customer">Edit Mode</Label>
            </div>

            {!isEditMode && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setIsCreditModalOpen(true)}
                >
                  <Gift className="mr-2 h-4 w-4" />
                  Grant Credits
                </Button>
                {customer && hasBillingAddress(customer) && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      router.push(`/invoices/create?customerId=${customerId}`)
                    }
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    Create Invoice
                  </Button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive">
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete Customer
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Are you absolutely sure?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This action cannot be undone. This will permanently
                        delete the customer and all associated data.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <Button
                        variant="destructive"
                        onClick={() => deleteCustomerMutation.mutate()}
                        disabled={deleteCustomerMutation.isPending}
                      >
                        {deleteCustomerMutation.isPending ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Deleting...
                          </>
                        ) : (
                          <>
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </>
                        )}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        </div>

        {/* Title and ID Section */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Customer Details
          </h1>
          <div className="flex items-center gap-4 mt-3">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 w-fit"
                    onClick={() => {
                      if (typeof customerId === "string") {
                        navigator.clipboard.writeText(customerId);
                      }
                    }}
                  >
                    <code className="px-3 py-2 text-sm font-mono">
                      {customerId}
                    </code>
                    <div className="h-10 px-3 flex items-center">
                      <Copy className="h-4 w-4" />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Click to copy customer ID</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              MRR Contribution
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(totalMrrContribution, customerCurrency)}
            </div>
            <p className="text-xs text-muted-foreground">
              Monthly recurring revenue
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Active Subscriptions
            </CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {activeSubscriptions.length}
            </div>
            <p className="text-xs text-muted-foreground">
              {subscriptions?.length || 0} total subscriptions
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total Invoice Value
            </CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(totalInvoiceAmount, customerCurrency)}
            </div>
            <div className="text-xs text-muted-foreground">
              {invoices?.length || 0} invoices total
              {totalInvoiceAmount > 0 && (
                <div className="mt-1">
                  (
                  {invoiceBreakdown.paid && (
                    <span className="text-green-600">
                      {formatCurrency(invoiceBreakdown.paid, customerCurrency)}{" "}
                      paid
                    </span>
                  )}
                  {invoiceBreakdown.pending && (
                    <>
                      {invoiceBreakdown.paid && ", "}
                      <span className="text-yellow-600">
                        {formatCurrency(
                          invoiceBreakdown.pending,
                          customerCurrency
                        )}{" "}
                        pending
                      </span>
                    </>
                  )}
                  {invoiceBreakdown.overdue && (
                    <>
                      {(invoiceBreakdown.paid || invoiceBreakdown.pending) &&
                        ", "}
                      <span className="text-orange-600">
                        {formatCurrency(
                          invoiceBreakdown.overdue,
                          customerCurrency
                        )}{" "}
                        overdue
                      </span>
                    </>
                  )}
                  )
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Active Credits
            </CardTitle>
            <Gift className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCredits.length}</div>
            <p className="text-xs text-muted-foreground">
              {activeCredits.reduce((sum, c) => sum + c.remainingAmount, 0)}{" "}
              remaining
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column - Customer Details */}
        <div className="space-y-6">
          {/* Customer Information */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <User className="mr-2 h-5 w-5" />
                Customer Information
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Header with name and email */}
              <div className="mb-6">
                <p className="text-xl font-bold">
                  {customer.name || "Unknown Customer"}
                </p>
                <div className="flex items-center text-sm text-muted-foreground mt-2">
                  <Mail className="mr-2 h-4 w-4" />
                  <span className="font-medium">
                    {customer.email || "No email"}
                  </span>
                </div>
                {customer.phoneNumber && (
                  <div className="flex items-center text-sm text-muted-foreground mt-2">
                    <Phone className="mr-2 h-4 w-4" />
                    <span className="font-medium">{customer.phoneNumber}</span>
                  </div>
                )}
                {customer.externalCustomerId && (
                  <div className="flex items-center text-sm text-muted-foreground mt-2">
                    <User className="mr-2 h-4 w-4" />
                    <span className="font-bold">External ID: </span>
                    &nbsp;
                    <span className="font-medium font-mono">
                      {customer.externalCustomerId}
                    </span>
                  </div>
                )}
              </div>

              {/* Billing Address */}
              {(customer.billingAddressLine1 || customer.billingCountry) && (
                <div>
                  <p className="text-sm font-semibold text-muted-foreground mb-3 flex items-center">
                    <MapPin className="mr-2 h-4 w-4" />
                    Billing Address
                  </p>
                  <div className="pl-6">
                    {customer.billingAddressLine1 ? (
                      <div className="text-sm space-y-1">
                        <p className="font-medium">
                          {customer.billingAddressLine1}
                        </p>
                        {customer.billingAddressLine2 && (
                          <p className="font-medium">
                            {customer.billingAddressLine2}
                          </p>
                        )}
                        <p className="text-muted-foreground">
                          {customer.billingCity && `${customer.billingCity}, `}
                          {customer.billingPostalCode &&
                            `${customer.billingPostalCode} `}
                          <span className="font-medium">
                            {customer.billingCountry}
                          </span>
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground font-medium">
                        {customer.billingCountry || "No billing address"}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Tax Information */}
              {(customer.taxId ||
                customer.businessName ||
                customer.taxExempt === true) && (
                <div className="mt-4">
                  <p className="text-sm font-semibold text-muted-foreground mb-3 flex items-center">
                    <Receipt className="mr-2 h-4 w-4" />
                    Tax Information
                  </p>
                  <div className="space-y-2 pl-6">
                    {customer.businessName && (
                      <div className="grid grid-cols-2 gap-4 py-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          Business Name
                        </p>
                        <p className="text-sm">{customer.businessName}</p>
                      </div>
                    )}
                    {customer.taxId && (
                      <div className="grid grid-cols-2 gap-4 py-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          Tax ID
                        </p>
                        <div>
                          <Badge variant="outline" className="font-mono">
                            {customer.taxId}
                          </Badge>
                        </div>
                      </div>
                    )}
                    {(Boolean(customer.taxId || customer.businessName) ||
                      customer.taxExempt === true) && (
                      <div className="grid grid-cols-2 gap-4 py-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          Tax Status
                        </p>
                        <Badge
                          variant={customer.taxExempt ? "secondary" : "outline"}
                          className={
                            customer.taxExempt
                              ? "bg-amber-100 text-amber-800 border-amber-200"
                              : "bg-green-100 text-green-800 border-green-200"
                          }
                        >
                          {customer.taxExempt ? "Tax Exempt" : "Tax Applicable"}
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Payment Method */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <CreditCard className="mr-2 h-5 w-5" />
                Payment Method
              </CardTitle>
            </CardHeader>
            <CardContent>
              {latestPaymentDetail && latestPaymentDetail.pspPaymentMethod ? (
                <div className="space-y-3">
                  {typeof latestPaymentDetail.paymentProvider !==
                    "undefined" && (
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        Provider
                      </p>
                      <Badge
                        className={
                          latestPaymentDetail.paymentProvider === "stripe"
                            ? "bg-purple-100 text-purple-800 border-purple-200"
                            : latestPaymentDetail.paymentProvider === "dodo"
                              ? "bg-blue-100 text-blue-800 border-blue-200"
                              : "bg-gray-100 text-gray-800 border-gray-200"
                        }
                      >
                        {(
                          latestPaymentDetail.paymentProvider || "unknown"
                        ).toUpperCase()}
                      </Badge>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Type</p>
                      <p className="font-semibold">
                        {latestPaymentDetail.pspPaymentMethod.type}
                      </p>
                    </div>
                    {(latestPaymentDetail.pspPaymentMethod.cardBrand ||
                      latestPaymentDetail.pspPaymentMethod.cardLastFour) && (
                      <div>
                        <p className="text-sm text-muted-foreground">Card</p>
                        <p className="font-semibold">
                          {latestPaymentDetail.pspPaymentMethod.cardBrand || ""}
                          {latestPaymentDetail.pspPaymentMethod.cardLastFour
                            ? ` •••• ${latestPaymentDetail.pspPaymentMethod.cardLastFour}`
                            : ""}
                        </p>
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-sm text-muted-foreground mb-1">
                      {latestPaymentDetail.paymentProvider === "stripe"
                        ? "Stripe Payment Method ID"
                        : "Dodo Subscription ID"}
                    </p>
                    <div
                      className="inline-flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          latestPaymentDetail.pspPaymentMethod!.id
                        );
                      }}
                    >
                      <code className="px-2 py-1 text-xs font-mono">
                        {latestPaymentDetail.pspPaymentMethod.id}
                      </code>
                      <div className="h-8 px-2 flex items-center">
                        <Copy className="h-3 w-3" />
                      </div>
                    </div>
                  </div>

                  {latestPaymentDetail.externalPaymentId &&
                    latestPaymentDetail.paymentProvider === "stripe" && (
                      <div>
                        {(() => {
                          const url = getStripeDashboardUrl(
                            latestPaymentDetail.externalPaymentId!,
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

                  {latestPaymentDetail.externalPaymentId &&
                    latestPaymentDetail.paymentProvider === "dodo" && (
                      <div>
                        <a
                          href={`https://app.dodopayments.com/transactions/payments/${latestPaymentDetail.externalPaymentId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center text-sm text-blue-600 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3 mr-1" />
                          View in Dodo Dashboard
                        </a>
                      </div>
                    )}

                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        router.push(`/payments/${latestPaymentDetail.id}`)
                      }
                    >
                      <ExternalLink className="h-4 w-4 mr-1" />
                      View Latest Payment
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {payments && payments.length > 0
                    ? "Payment method details unavailable for the latest payment."
                    : "No payments yet. Payment method will appear after the first payment."}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Organization Information */}
          {customer?.customerOrganizationId && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <User className="mr-2 h-5 w-5" />
                  Organization
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">
                      Organization ID
                    </p>
                    <div
                      className="inline-flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 mt-1"
                      onClick={() => {
                        if (customer.customerOrganizationId) {
                          navigator.clipboard.writeText(
                            customer.customerOrganizationId
                          );
                        }
                      }}
                    >
                      <code className="px-2 py-1 text-xs font-mono">
                        {customer.customerOrganizationId}
                      </code>
                      <div className="h-6 px-2 flex items-center">
                        <Copy className="h-3 w-3" />
                      </div>
                    </div>
                  </div>

                  {organizationData?.organization?.externalOrgId && (
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        External Organization ID
                      </p>
                      <div
                        className="inline-flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 mt-1"
                        onClick={() => {
                          if (organizationData.organization?.externalOrgId) {
                            navigator.clipboard.writeText(
                              organizationData.organization.externalOrgId
                            );
                          }
                        }}
                      >
                        <code className="px-2 py-1 text-xs font-mono">
                          {organizationData.organization.externalOrgId}
                        </code>
                        <div className="h-6 px-2 flex items-center">
                          <Copy className="h-3 w-3" />
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-sm font-medium text-muted-foreground">
                      Role in Organization
                    </p>
                    <Badge className="mt-1 bg-blue-100 text-blue-800 border-blue-200">
                      {customer.orgRole || "Primary"}
                    </Badge>
                  </div>

                  {organizationData?.customers &&
                    organizationData.customers.length > 1 && (
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">
                          Total Customers
                        </p>
                        <p className="text-lg font-semibold mt-1">
                          {organizationData.customers.length}
                          <span className="text-sm text-muted-foreground font-normal ml-1">
                            (1 primary + {organizationData.customers.length - 1}{" "}
                            seats)
                          </span>
                        </p>
                      </div>
                    )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Edit Customer Details */}
          {isEditMode && (
            <Card>
              <CardHeader>
                <CardTitle>Edit Customer Details</CardTitle>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    form.handleSubmit();
                  }}
                  className="space-y-6"
                >
                  <form.AppField
                    name="name"
                    children={(field) => (
                      <field.TextField
                        label="Name"
                        autoFocus
                        readOnly={!isEditMode}
                      />
                    )}
                  />
                  <form.AppField
                    name="email"
                    children={(field) => (
                      <field.TextField label="Email" readOnly={!isEditMode} />
                    )}
                  />
                  <form.AppField
                    name="externalCustomerId"
                    children={(field) => (
                      <field.TextField
                        label="External Customer ID"
                        isOptional
                        readOnly={!isEditMode}
                      />
                    )}
                  />

                  <div className="border border-gray-200 rounded-md p-4 space-y-4">
                    <div className="flex items-center mb-2">
                      <h3 className="font-medium">Billing Information</h3>
                      {customer && !hasBillingAddress(customer) && (
                        <Badge variant="secondary" className="ml-2">
                          Required for invoice
                        </Badge>
                      )}
                    </div>

                    <form.AppField
                      name="businessName"
                      children={(field) => (
                        <field.TextField
                          label="Business Name (provide to buy as a business)"
                          isOptional
                          readOnly={!isEditMode}
                        />
                      )}
                    />

                    <form.AppField
                      name="billingAddressLine1"
                      children={(field) => (
                        <field.TextField
                          label="Address Line 1"
                          readOnly={!isEditMode}
                        />
                      )}
                    />
                    <form.AppField
                      name="billingAddressLine2"
                      children={(field) => (
                        <field.TextField
                          label="Address Line 2"
                          isOptional
                          readOnly={!isEditMode}
                        />
                      )}
                    />
                    <form.AppField
                      name="billingCity"
                      children={(field) => (
                        <field.TextField label="City" readOnly={!isEditMode} />
                      )}
                    />
                    <form.AppField
                      name="billingCountry"
                      children={(field) => (
                        <field.Dropdown
                          label="Country"
                          options={customerCountries}
                          searchEnabled
                          readOnly={!isEditMode}
                        />
                      )}
                    />

                    {/* Notice for unsupported countries when merchant uses automatic tax */}
                    {taxConfig?.autoTaxCalculation &&
                      formValues.billingCountry &&
                      !supportedCustomerCountries.some(
                        (c) => c.value === formValues.billingCountry
                      ) && (
                        <p className="text-xs text-amber-600 ml-1">
                          Automatic tax calculation isn&apos;t supported for
                          this country. Please make sure you&apos;ve selected a
                          manual tax-calculation method below.
                        </p>
                      )}

                    <form.AppField
                      name="billingStateProvince"
                      children={(field) => {
                        const isUS = formValues.billingCountry === "US";

                        if (isUS && isEditMode) {
                          return (
                            <field.Dropdown
                              label="State"
                              defaultValue=""
                              options={usStates}
                              searchEnabled
                              placeholder="Select a state"
                            />
                          );
                        }

                        if (isUS && !isEditMode) {
                          return (
                            <field.TextField label="State" readOnly={true} />
                          );
                        }

                        return (
                          <field.TextField
                            label="State/Province"
                            isOptional
                            readOnly={!isEditMode}
                          />
                        );
                      }}
                    />
                    <form.AppField
                      name="billingPostalCode"
                      children={(field) => (
                        <field.TextField
                          label="Postal Code"
                          readOnly={!isEditMode}
                        />
                      )}
                    />
                    <form.AppField
                      name="taxId"
                      children={(field) => (
                        <field.TextField
                          label="Tax ID / VAT Number"
                          readOnly={!isEditMode}
                        />
                      )}
                    />
                  </div>

                  <div className="border border-gray-200 rounded-md p-4 space-y-4">
                    <div className="flex items-center mb-2">
                      <h3 className="font-medium">Tax Configuration</h3>
                      <Badge variant="secondary" className="ml-2">
                        Optional
                      </Badge>
                    </div>

                    {/* Smart tax treatment dropdown */}
                    {(() => {
                      const isSupportedCountry =
                        supportedCustomerCountries.some(
                          (c) => c.value === formValues.billingCountry
                        );
                      const autoAllowed =
                        isSupportedCountry && taxConfig?.autoTaxCalculation;

                      const currentValue = selectedTaxTreatment;

                      return (
                        <div className="space-y-2">
                          <Label>Tax Treatment</Label>
                          <Select
                            value={currentValue}
                            onValueChange={(val) => {
                              if (val === "exempt") {
                                setSelectedTaxTreatment("exempt");
                                setExemptionDialogOpen(true);
                                return;
                              }
                              setSelectedTaxTreatment(
                                val as "auto" | "manual" | "default" | "exempt"
                              );
                            }}
                          >
                            <SelectTrigger disabled={!isEditMode}>
                              <SelectValue placeholder="Select tax treatment" />
                            </SelectTrigger>
                            <SelectContent>
                              {autoAllowed ? (
                                <>
                                  <SelectItem value="auto">
                                    Calculate automatically based on location
                                  </SelectItem>
                                  <SelectItem value="manual">
                                    Use specific tax rate
                                  </SelectItem>
                                  <SelectItem value="exempt">
                                    Tax exempt
                                  </SelectItem>
                                </>
                              ) : (
                                <>
                                  <SelectItem value="default">
                                    {taxConfig?.defaultTaxRate
                                      ? `Apply default rate (${(
                                          parseFloat(taxConfig.defaultTaxRate) *
                                          100
                                        ).toFixed(2)}%)`
                                      : "No tax (default tax rate not set)"}
                                  </SelectItem>
                                  <SelectItem value="manual">
                                    Use specific tax rate
                                  </SelectItem>
                                  <SelectItem value="exempt">
                                    Tax exempt
                                  </SelectItem>
                                </>
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })()}

                    {/* Show description for selected option */}
                    <div className="text-xs text-gray-600">
                      {(() => {
                        if (selectedTaxTreatment === "exempt") {
                          return (
                            <p className="flex items-start gap-1.5">
                              <span className="text-green-600 mt-0.5">✓</span>
                              <span>
                                This customer is tax exempt. No tax will be
                                charged on any invoices.
                              </span>
                            </p>
                          );
                        }
                        if (selectedTaxTreatment === "auto") {
                          return (
                            <p className="flex items-start gap-1.5">
                              <span className="text-green-600 mt-0.5">✓</span>
                              <span>
                                Tax will be calculated automatically based on
                                the customer&apos;s billing location and
                                applicable tax rules.
                              </span>
                            </p>
                          );
                        }
                        if (selectedTaxTreatment === "manual") {
                          return (
                            <p className="flex items-start gap-1.5">
                              <span className="text-green-600 mt-0.5">✓</span>
                              <span>
                                Select a specific tax rate to apply to this
                                customer below.
                              </span>
                            </p>
                          );
                        }
                        if (selectedTaxTreatment === "default" && taxConfig) {
                          if (taxConfig.autoTaxCalculation) {
                            return (
                              <p className="flex items-start gap-1.5">
                                <span className="text-green-600 mt-0.5">✓</span>
                                <span>
                                  Tax will be calculated automatically based on
                                  the customer&apos;s billing location.
                                </span>
                              </p>
                            );
                          } else if (taxConfig.defaultTaxRate) {
                            return (
                              <p className="flex items-start gap-1.5">
                                <span className="text-green-600 mt-0.5">✓</span>
                                <span>
                                  Your default tax rate of{" "}
                                  {(
                                    parseFloat(taxConfig.defaultTaxRate) * 100
                                  ).toFixed(2)}
                                  % will be applied.
                                </span>
                              </p>
                            );
                          } else {
                            return (
                              <p className="flex items-start gap-1.5">
                                <span className="text-amber-600 mt-0.5">!</span>
                                <span>
                                  No default tax rate configured. No tax will be
                                  charged unless you set up a default rate in
                                  tax settings.
                                </span>
                              </p>
                            );
                          }
                        }
                        return null;
                      })()}
                    </div>

                    {/* Show tax rate dropdown only when manual rate is selected */}
                    {selectedTaxTreatment === "manual" && (
                      <div className="space-y-3">
                        {taxRateDefinitions && taxRateDefinitions.length > 0 ? (
                          <form.AppField
                            name="taxRateDefinitionId"
                            children={(field) => (
                              <field.Dropdown
                                label="Select Tax Rate"
                                options={[
                                  ...taxRateDefinitions.map((def) => ({
                                    label: `${def.name} (${(parseFloat(def.taxRate) * 100).toFixed(2)}%)`,
                                    value: def.id,
                                  })),
                                ]}
                                defaultValue={
                                  taxRateDefinitions[0]?.id || "default"
                                }
                                readOnly={!isEditMode}
                              />
                            )}
                          />
                        ) : (
                          <div className="text-sm text-gray-600">
                            <p className="mb-2">No tax rates defined yet.</p>
                          </div>
                        )}

                        {/* Always show link to create/manage tax rates */}
                        {isEditMode && (
                          <div className="text-sm">
                            <a
                              href="/tax"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 underline"
                            >
                              {taxRateDefinitions &&
                              taxRateDefinitions.length > 0
                                ? "Manage tax rates"
                                : "Create your first tax rate"}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Hidden field to maintain calculation method state */}
                    <div style={{ display: "none" }}>
                      <form.AppField
                        name="taxCalculationMethod"
                        children={(field) => <field.TextField label="" />}
                      />
                    </div>

                    {/* Exemption reason selection dialog */}
                    <Dialog
                      open={exemptionDialogOpen}
                      onOpenChange={setExemptionDialogOpen}
                    >
                      <DialogContent>
                        <DialogTitle>Select tax exemption reason</DialogTitle>
                        <div className="mt-3 space-y-3">
                          <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                            <Info className="h-4 w-4 mt-0.5" />
                            <p>
                              Tax-exempt customers are legally exempt from tax
                              collection (for eg, some non-profits, overseas
                              sales etc.). Only select this if you have a valid
                              exemption certificate for the customer OR if you
                              know what you&apos;re doing.
                            </p>
                          </div>
                          <RadioGroup
                            value={selectedExemptionReason}
                            onValueChange={(v) => setSelectedExemptionReason(v)}
                          >
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value="nonprofit_organization"
                                id="exempt-np-edit"
                              />
                              <label
                                htmlFor="exempt-np-edit"
                                className="text-sm"
                              >
                                Nonprofit organization
                              </label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value="government_entity"
                                id="exempt-gov-edit"
                              />
                              <label
                                htmlFor="exempt-gov-edit"
                                className="text-sm"
                              >
                                Government entity
                              </label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value="educational_institution"
                                id="exempt-edu-edit"
                              />
                              <label
                                htmlFor="exempt-edu-edit"
                                className="text-sm"
                              >
                                Educational institution
                              </label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value="resale"
                                id="exempt-resale-edit"
                              />
                              <label
                                htmlFor="exempt-resale-edit"
                                className="text-sm"
                              >
                                Resale certificate
                              </label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value="other"
                                id="exempt-other-edit"
                              />
                              <label
                                htmlFor="exempt-other-edit"
                                className="text-sm"
                              >
                                Other
                              </label>
                            </div>
                          </RadioGroup>
                          {selectedExemptionReason === "other" && (
                            <div className="pt-2">
                              <Input
                                placeholder="Enter exemption reason"
                                value={exemptionOtherText}
                                onChange={(e) =>
                                  setExemptionOtherText(e.target.value)
                                }
                              />
                            </div>
                          )}
                          <div className="pt-2 flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              onClick={() => {
                                setExemptionDialogOpen(false);
                                const fallback = taxConfig?.autoTaxCalculation
                                  ? "auto"
                                  : "default";
                                setSelectedTaxTreatment(fallback);
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              onClick={() => {
                                setExemptionDialogOpen(false);
                                const reason =
                                  selectedExemptionReason === "other"
                                    ? exemptionOtherText.trim()
                                    : selectedExemptionReason;
                                if (reason) {
                                  form.setFieldValue(
                                    "taxExemptionReason",
                                    reason
                                  );
                                }
                              }}
                            >
                              Save
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>

                  <form.AppForm>
                    <form.SubmitButtonWithShortcut label="Update Customer" />
                  </form.AppForm>
                </form>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column - Activity & Data */}
        <div className="lg:col-span-2">
          <div className="space-y-6">
            {/* Tab Navigation */}
            <div className="flex space-x-1 bg-muted p-1 rounded-md">
              {[
                {
                  id: "subscriptions",
                  label: "Subscriptions",
                  icon: CreditCard,
                },
                { id: "invoices", label: "Invoices", icon: FileText },
                { id: "payments", label: "Payments", icon: DollarSign },
                { id: "credits", label: "Credits", icon: Gift },
                { id: "usage", label: "Usage", icon: TrendingUp },
                ...(customer?.customerOrganizationId
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
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="capitalize">{activeTab}</CardTitle>
                  {activeTab === "events" && (
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
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {activeTab === "subscriptions" && (
                  <div>
                    {subscriptions && subscriptions.length > 0 ? (
                      <div className="rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Plan</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Start Date</TableHead>
                              <TableHead>End Date</TableHead>
                              <TableHead>Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {subscriptions.map((subscription) => {
                              const subscriptionWithPlan =
                                subscription as SubscriptionWithPlan;
                              return (
                                <TableRow key={subscription.id}>
                                  <TableCell>
                                    <div>
                                      <div className="font-medium">
                                        {subscriptionWithPlan.plan?.planName ||
                                          "Unknown Plan"}
                                      </div>
                                      {subscriptionWithPlan.plan
                                        ?.planDescription && (
                                        <div className="text-sm text-muted-foreground">
                                          {
                                            subscriptionWithPlan.plan
                                              .planDescription
                                          }
                                        </div>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Badge
                                      className={
                                        subscription.endTimestamp
                                          ? "bg-gray-100 text-gray-800 border-gray-200"
                                          : "bg-green-100 text-green-800 border-green-200"
                                      }
                                    >
                                      {subscription.endTimestamp
                                        ? "Ended"
                                        : "Active"}
                                    </Badge>
                                  </TableCell>
                                  <TableCell>
                                    <LocaleAwareDate
                                      date={subscription.startTimestamp}
                                      className="text-sm"
                                    />
                                  </TableCell>
                                  <TableCell>
                                    {subscription.endTimestamp ? (
                                      <LocaleAwareDate
                                        date={subscription.endTimestamp}
                                        className="text-sm"
                                      />
                                    ) : (
                                      <div className="text-sm">—</div>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() =>
                                        router.push(
                                          `/subscriptions/${subscription.id}`
                                        )
                                      }
                                    >
                                      View Details
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <CreditCard className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p>No subscriptions found for this customer</p>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "invoices" && (
                  <div>
                    {invoices && invoices.length > 0 ? (
                      <div className="rounded-md border">
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
                            {invoices.map((invoice) => (
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
                                    className={
                                      invoice.status === "paid"
                                        ? "bg-green-100 text-green-800 border-green-200"
                                        : invoice.status === "pending"
                                          ? "bg-yellow-100 text-yellow-800 border-yellow-200"
                                          : invoice.status === "overdue"
                                            ? "bg-red-100 text-red-800 border-red-200"
                                            : "bg-gray-100 text-gray-800 border-gray-200"
                                    }
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
                      </div>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p>No invoices found for this customer</p>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "payments" && (
                  <div>
                    {payments && payments.length > 0 ? (
                      <div className="rounded-md border">
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
                            {payments.map((payment) => (
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
                                  <Badge
                                    className={getPaymentStatusColor(
                                      payment.status
                                    )}
                                  >
                                    {payment.status}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <div className="space-y-1">
                                    {payment.errorMessage ? (
                                      <p className="text-sm text-red-600">
                                        {payment.errorMessage}
                                      </p>
                                    ) : null}

                                    {payment.customerInvoiceNumber ? (
                                      <div className="text-sm text-muted-foreground">
                                        Invoice:{" "}
                                        <a
                                          href={`/invoices/${payment.invoiceId}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline"
                                        >
                                          {payment.customerInvoiceNumber}
                                          <ExternalLink className="h-3 w-3" />
                                        </a>
                                      </div>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">
                                        Payment processed
                                      </span>
                                    )}

                                    {payment.externalPaymentId ? (
                                      <div>
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
                                              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                                            >
                                              View in Stripe Dashboard
                                              <ExternalLink className="h-3 w-3" />
                                            </a>
                                          ) : null;
                                        })()}
                                      </div>
                                    ) : null}

                                    {(payment.refundedAmountCents || 0) > 0 ? (
                                      <div className="text-sm text-muted-foreground">
                                        Refunded:{" "}
                                        {formatCurrency(
                                          payment.refundedAmountCents ?? 0,
                                          payment.currency
                                        )}
                                        {payment.refundStatus &&
                                        payment.refundStatus !== "full"
                                          ? " (partial)"
                                          : ""}
                                      </div>
                                    ) : null}
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p>No payments found for this customer</p>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "credits" && (
                  <div>
                    {creditGrants?.grants && creditGrants.grants.length > 0 ? (
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
                              <TableHead>Renews</TableHead>
                              <TableHead>Source</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {creditGrants.grants.map((grant) => {
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
                                        ? formatCurrency(
                                            grant.remainingAmount,
                                            grant.currency || "USD"
                                          )
                                        : grant.remainingAmount.toLocaleString()}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <div className="text-muted-foreground">
                                      {grant.applicationType === "monetary"
                                        ? formatCurrency(
                                            grant.initialAmount,
                                            grant.currency || "USD"
                                          )
                                        : grant.initialAmount.toLocaleString()}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    {grant.expiryDate ? (
                                      <LocaleAwareDate
                                        date={grant.expiryDate}
                                        className="text-sm"
                                      />
                                    ) : (
                                      <div className="text-sm">Never</div>
                                    )}
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
                        <p className="text-sm">
                          Use the &quot;Grant Credits&quot; button above to add
                          credits
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "usage" && (
                  <div>
                    {usageBasedEntitlements.length > 0 ? (
                      <div className="rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Feature</TableHead>
                              <TableHead>Current Usage</TableHead>
                              <TableHead>Limit</TableHead>
                              <TableHead>Source</TableHead>
                              <TableHead>Credits</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {usageBasedEntitlements.map(
                              (entitlement, index) => {
                                const feature = entitlement.feature;
                                if (!feature) return null;

                                const displayName =
                                  featureNameMap.get(feature.slug) ||
                                  feature.slug;
                                const currentUsage =
                                  entitlement.usages?.[0]?.usage || 0;
                                const limit =
                                  typeof feature.value === "number"
                                    ? feature.value
                                    : "Unlimited";
                                const source = entitlement.source || "default";
                                const creditInfo = entitlement.creditInfo;

                                // Calculate usage percentage for progress indication
                                const usagePercentage =
                                  typeof feature.value === "number" &&
                                  feature.value > 0
                                    ? Math.min(
                                        (currentUsage / feature.value) * 100,
                                        100
                                      )
                                    : 0;

                                return (
                                  <TableRow key={`${feature.slug}-${index}`}>
                                    <TableCell>
                                      <div>
                                        <div className="font-medium">
                                          {displayName}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                          {feature.slug}
                                        </div>
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        <span className="font-medium">
                                          {currentUsage.toLocaleString()}
                                        </span>
                                        {typeof feature.value === "number" &&
                                          feature.value > 0 && (
                                            <div className="flex-1 max-w-[100px]">
                                              <div className="w-full bg-gray-200 rounded-full h-2">
                                                <div
                                                  className={`h-2 rounded-full ${
                                                    usagePercentage >= 90
                                                      ? "bg-red-500"
                                                      : usagePercentage >= 70
                                                        ? "bg-yellow-500"
                                                        : "bg-green-500"
                                                  }`}
                                                  style={{
                                                    width: `${usagePercentage}%`,
                                                  }}
                                                ></div>
                                              </div>
                                            </div>
                                          )}
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <span className="font-medium">
                                        {typeof limit === "number"
                                          ? limit.toLocaleString()
                                          : limit}
                                      </span>
                                    </TableCell>
                                    <TableCell>
                                      <Badge
                                        variant="outline"
                                        className="capitalize"
                                      >
                                        {source}
                                      </Badge>
                                    </TableCell>
                                    <TableCell>
                                      {creditInfo ? (
                                        <div className="text-sm">
                                          <div className="font-medium">
                                            {creditInfo.creditsRemaining} /{" "}
                                            {creditInfo.creditAllowance}
                                          </div>
                                          <div className="text-xs text-muted-foreground">
                                            credits remaining
                                          </div>
                                          {creditInfo.nextExpiryDate && (
                                            <div className="text-xs text-muted-foreground">
                                              Expires:{" "}
                                              <LocaleAwareDate
                                                date={creditInfo.nextExpiryDate}
                                              />
                                            </div>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="text-xs text-muted-foreground">
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
                        <p>
                          No usage-based features with available credits found
                        </p>
                        <p className="text-sm mt-1">
                          Usage tracking shows consumption of metered features
                          with remaining credits
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "seats" && (
                  <div>
                    {organizationData?.customers &&
                    organizationData.customers.length > 0 ? (
                      <div className="space-y-4">
                        {/* Organization Summary */}
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <h3 className="font-medium text-blue-900">
                                Organization:{" "}
                                {organizationData.customers.length} customers
                              </h3>
                              <p className="text-sm text-blue-700 mt-1">
                                1 primary customer +{" "}
                                {organizationData.customers.length - 1} seat
                                customers
                              </p>
                            </div>
                            {organizationData.organization?.externalOrgId && (
                              <div className="text-right">
                                <p className="text-xs text-blue-600 font-medium">
                                  External Org ID
                                </p>
                                <code className="text-xs font-mono text-blue-800">
                                  {organizationData.organization.externalOrgId}
                                </code>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Seat Customer Cards */}
                        <div className="space-y-3">
                          {organizationData.customers
                            .filter((c) => c.orgRole === "member") // Only show seat customers
                            .map((seatCustomer) => {
                              const isExpanded =
                                expandedSeatCustomer === seatCustomer.id;
                              const customerEntitlements =
                                orgCustomerEntitlements?.[seatCustomer.id] ||
                                [];
                              const usageEntitlements =
                                customerEntitlements.filter(
                                  (ent) =>
                                    ent.creditInfo &&
                                    ent.creditInfo.creditAllowance > 0
                                );

                              const totalCredits = usageEntitlements.reduce(
                                (sum, ent) =>
                                  sum + (ent.creditInfo?.creditsRemaining || 0),
                                0
                              );

                              return (
                                <Card
                                  key={seatCustomer.id}
                                  className="overflow-hidden"
                                >
                                  <CardContent className="p-0">
                                    {/* Main Customer Info */}
                                    <div
                                      className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                                      onClick={() =>
                                        setExpandedSeatCustomer(
                                          isExpanded ? null : seatCustomer.id
                                        )
                                      }
                                    >
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center space-x-4">
                                          <div className="flex-shrink-0">
                                            <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                                              <User className="w-5 h-5 text-gray-500" />
                                            </div>
                                          </div>

                                          <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                              <h4 className="font-medium text-gray-900 truncate">
                                                {seatCustomer.name ||
                                                  "Unnamed Seat"}
                                              </h4>
                                              <Badge className="bg-gray-100 text-gray-800 border-gray-200">
                                                Seat
                                              </Badge>
                                            </div>

                                            <div className="flex items-center gap-4 mt-1">
                                              {seatCustomer.externalCustomerId && (
                                                <div className="flex items-center gap-1">
                                                  <span className="text-xs text-gray-500">
                                                    ID:
                                                  </span>
                                                  <code className="text-xs font-mono bg-gray-100 px-1.5 py-0.5 rounded">
                                                    {
                                                      seatCustomer.externalCustomerId
                                                    }
                                                  </code>
                                                </div>
                                              )}

                                              {totalCredits > 0 && (
                                                <div className="flex items-center gap-1">
                                                  <Gift className="w-3 h-3 text-green-600" />
                                                  <span className="text-xs text-green-600 font-medium">
                                                    {totalCredits} credits
                                                  </span>
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                        </div>

                                        <div className="flex items-center space-x-3">
                                          <Badge className="bg-green-100 text-green-800 border-green-200">
                                            Active
                                          </Badge>

                                          <div className="text-gray-400">
                                            {isExpanded ? (
                                              <div className="flex items-center gap-1 text-xs">
                                                <span>Collapse</span>
                                                <div className="w-4 h-4 flex items-center justify-center">
                                                  <div className="w-2 h-0.5 bg-gray-400"></div>
                                                </div>
                                              </div>
                                            ) : (
                                              <div className="flex items-center gap-1 text-xs">
                                                <span>Expand</span>
                                                <div className="w-4 h-4 flex items-center justify-center">
                                                  <div className="relative">
                                                    <div className="w-2 h-0.5 bg-gray-400"></div>
                                                    <div className="w-0.5 h-2 bg-gray-400 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2"></div>
                                                  </div>
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    </div>

                                    {/* Expanded Details */}
                                    {isExpanded && (
                                      <div className="border-t bg-gray-50 p-4 space-y-4">
                                        {/* Credits Section */}
                                        {usageEntitlements.length > 0 ? (
                                          <div>
                                            <h5 className="text-sm font-medium text-gray-900 mb-3">
                                              Credits & Usage
                                            </h5>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                              {usageEntitlements.map(
                                                (entitlement, idx) => {
                                                  const feature =
                                                    entitlement.feature;
                                                  const displayName =
                                                    featureNameMap.get(
                                                      feature?.slug || ""
                                                    ) ||
                                                    feature?.slug ||
                                                    "Unknown Feature";
                                                  const currentUsage =
                                                    entitlement.usages?.[0]
                                                      ?.usage || 0;
                                                  const creditsRemaining =
                                                    entitlement.creditInfo
                                                      ?.creditsRemaining || 0;
                                                  const creditAllowance =
                                                    entitlement.creditInfo
                                                      ?.creditAllowance || 0;

                                                  return (
                                                    <div
                                                      key={idx}
                                                      className="bg-white border rounded-lg p-3"
                                                    >
                                                      <div className="flex justify-between items-start mb-2">
                                                        <div>
                                                          <h6 className="text-sm font-medium text-gray-900">
                                                            {displayName}
                                                          </h6>
                                                          <code className="text-xs text-gray-500">
                                                            {feature?.slug}
                                                          </code>
                                                        </div>
                                                        <Badge
                                                          variant="outline"
                                                          className="text-xs"
                                                        >
                                                          {entitlement.source}
                                                        </Badge>
                                                      </div>

                                                      <div className="space-y-2">
                                                        <div className="flex justify-between text-sm">
                                                          <span className="text-gray-600">
                                                            Current Usage:
                                                          </span>
                                                          <span className="font-medium">
                                                            {currentUsage}
                                                          </span>
                                                        </div>
                                                        <div className="flex justify-between text-sm">
                                                          <span className="text-gray-600">
                                                            Credits Remaining:
                                                          </span>
                                                          <span className="font-medium text-green-600">
                                                            {creditsRemaining} /{" "}
                                                            {creditAllowance}
                                                          </span>
                                                        </div>

                                                        {/* Progress bar */}
                                                        <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                                                          <div
                                                            className="bg-green-500 h-2 rounded-full transition-all"
                                                            style={{
                                                              width: `${creditAllowance > 0 ? (creditsRemaining / creditAllowance) * 100 : 0}%`,
                                                            }}
                                                          ></div>
                                                        </div>
                                                      </div>
                                                    </div>
                                                  );
                                                }
                                              )}
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="text-center py-4 text-gray-500">
                                            <Gift className="w-6 h-6 mx-auto mb-2 opacity-50" />
                                            <p className="text-sm">
                                              No credits or usage data available
                                            </p>
                                          </div>
                                        )}

                                        {/* Quick Actions */}
                                        <div className="flex items-center justify-between pt-3 border-t">
                                          <div className="text-xs text-gray-500">
                                            Added:{" "}
                                            {format(
                                              new Date(seatCustomer.createdAt),
                                              "MMM dd, yyyy"
                                            )}
                                          </div>
                                          <div className="flex gap-2">
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              onClick={() => {
                                                if (
                                                  seatCustomer.externalCustomerId
                                                ) {
                                                  navigator.clipboard.writeText(
                                                    seatCustomer.externalCustomerId
                                                  );
                                                }
                                              }}
                                            >
                                              <Copy className="w-3 h-3 mr-1" />
                                              Copy ID
                                            </Button>
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </CardContent>
                                </Card>
                              );
                            })}
                        </div>

                        {/* Primary Customer Summary */}
                        <div className="mt-6">
                          <h4 className="text-sm font-medium text-gray-700 mb-3">
                            Primary Customer (Current)
                          </h4>
                          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                            <div className="flex items-center justify-between">
                              <div>
                                <h5 className="font-medium text-blue-900">
                                  {customer?.name || "Unknown Customer"}
                                </h5>
                                <p className="text-sm text-blue-700 mt-1">
                                  {customer?.email} • External ID:{" "}
                                  {customer?.externalCustomerId}
                                </p>
                              </div>
                              <Badge className="bg-green-100 text-green-800 border-green-200">
                                Primary Customer
                              </Badge>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <User className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p>This customer has no linked seat customers</p>
                        <p className="text-sm mt-1">
                          Seat customers will appear here when added via the
                          Seats API
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "events" && (
                  <div>
                    {eventsLoading ? (
                      <div className="space-y-3">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Skeleton key={i} className="h-16 w-full" />
                        ))}
                      </div>
                    ) : customerEvents && customerEvents.length > 0 ? (
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
                            {customerEvents.map((event) => {
                              // Parse date safely for each event
                              const eventDate = new Date(event.eventTimestamp);
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
                                        {format(
                                          eventDate,
                                          "MMM dd, yyyy 'at' HH:mm:ss"
                                        )}
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        {format(eventDate, "EEEE")}
                                      </div>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <div className="font-medium">
                                      {event.eventValue ?? "—"}
                                      {event.eventString && (
                                        <div className="text-xs text-muted-foreground mt-1">
                                          &quot;{event.eventString}&quot;
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
                                          properties =
                                            JSON.parse(rawProperties);
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

                                      const formattedForDisplay =
                                        Object.entries(properties)
                                          .map(([key, value]) => {
                                            if (typeof value === "string") {
                                              return `${key}: "${value}"`;
                                            }
                                            return `${key}: ${value}`;
                                          })
                                          .join(", ");

                                      const truncatedProperties =
                                        formattedForDisplay.length > 50
                                          ? formattedForDisplay.substring(
                                              0,
                                              50
                                            ) + "..."
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
                            Showing {customerEvents.length} events
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
                                router.push(`/events?customerId=${customerId}`)
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
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Manual Credit Grant Modal */}
      {customer && (
        <ManualCreditGrantModal
          customerId={customerId}
          customerName={customer.name || customer.email || "Unknown Customer"}
          isOpen={isCreditModalOpen}
          onClose={() => setIsCreditModalOpen(false)}
          onSuccess={() => {
            // Refresh customer data and credit grants
            queryClient.invalidateQueries({
              queryKey: ["customer", customerId],
            });
            queryClient.invalidateQueries({
              queryKey: ["customer-credit-grants", customerId],
            });
            queryClient.invalidateQueries({
              queryKey: ["customer-credit-transactions", customerId],
            });
          }}
        />
      )}

      {/* Credit Information Section */}
      <div className="mt-12 max-w-6xl space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Customer Credits</h2>
          <div className="text-sm text-muted-foreground">
            {creditGrants?.grants?.length || 0} credit grants
          </div>
        </div>

        {/* Credit Grants Section */}
        <Card>
          <CardHeader>
            <CardTitle>Credit Grants</CardTitle>
            <CardDescription>
              Active and historical credit grants for this customer
            </CardDescription>
          </CardHeader>
          <CardContent>
            {creditGrants?.grants && creditGrants.grants.length > 0 ? (
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
                      <TableHead>Renews</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {creditGrants.grants.map((grant) => {
                      const statusInfo = formatCreditStatus(grant.status);
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
                                {grant.creditDefinition?.scope || "unknown"}
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
                                ? formatCurrency(
                                    grant.remainingAmount,
                                    grant.currency || customerCurrency
                                  )
                                : grant.remainingAmount.toLocaleString()}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-muted-foreground">
                              {grant.applicationType === "monetary"
                                ? formatCurrency(
                                    grant.initialAmount,
                                    grant.currency || customerCurrency
                                  )
                                : grant.initialAmount.toLocaleString()}
                            </div>
                          </TableCell>
                          <TableCell>
                            {grant.expiryDate ? (
                              <LocaleAwareDate
                                date={grant.expiryDate}
                                className="text-sm"
                              />
                            ) : (
                              <div className="text-sm">Never</div>
                            )}
                          </TableCell>
                          <TableCell>
                            {grant.nextRenewalDate ? (
                              <LocaleAwareDate
                                date={grant.nextRenewalDate}
                                className="text-sm"
                              />
                            ) : (
                              <div className="text-sm">—</div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="capitalize">
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
                <p className="text-sm">
                  Use the &quot;Grant Credits&quot; button above to add credits
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Credit Transactions */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Credit Activity</CardTitle>
            <CardDescription>
              Recent credit usage and transactions
            </CardDescription>
          </CardHeader>
          <CardContent>
            {creditTransactions?.transactions &&
            creditTransactions.transactions.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Credit</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {creditTransactions.transactions
                      .slice(0, 10)
                      .map((transaction) => (
                        <TableRow key={transaction.id}>
                          <TableCell>
                            <div className="text-sm">
                              <LocaleAwareDate
                                date={transaction.eventTimestamp}
                                className="text-sm"
                              />
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium capitalize">
                              {transaction.eventName.replace(/_/g, " ")}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">
                              {transaction.creditGrantId ? (
                                <span className="font-mono text-xs">
                                  {transaction.creditGrantId.slice(0, 8)}...
                                </span>
                              ) : (
                                "N/A"
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">
                              {transaction.applicationType === "monetary"
                                ? formatCurrency(
                                    transaction.amount,
                                    transaction.currency || customerCurrency
                                  )
                                : transaction.amount.toLocaleString()}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {transaction.applicationType}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <p>No credit transactions found</p>
              </div>
            )}
          </CardContent>
        </Card>
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
    </div>
  );
}
