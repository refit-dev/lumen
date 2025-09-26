import React, { useEffect, useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, Stripe } from "@stripe/stripe-js";
import { DodoPayments } from "dodopayments-checkout";
import { CreditCard, Loader2, AlertCircle } from "lucide-react";

import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "./ui/table";

// Utility functions
const cn = (...classes: (string | undefined | null | false)[]): string => {
  return classes.filter(Boolean).join(" ");
};

const currencySymbol = (currency: string): string => {
  switch (currency.toLowerCase()) {
    case "usd":
      return "$";
    case "eur":
      return "€";
    case "gbp":
      return "£";
    case "cad":
      return "C$";
    case "aud":
      return "A$";
    default:
      return currency.toUpperCase();
  }
};

const getErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const errorObj = error as Record<string, unknown>;
    if (typeof errorObj.error === "string") return errorObj.error;
    if (typeof errorObj.message === "string") return errorObj.message;
    if (typeof errorObj.details === "string") return errorObj.details;
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error occurred";
    }
  }
  return "Unknown error occurred";
};

// Simple Tabs components
interface TabsProps {
  defaultValue: string;
  children: React.ReactNode;
  className?: string;
}

const Tabs: React.FC<TabsProps> = ({
  defaultValue,
  children,
  className = "",
}) => {
  const [activeTab, setActiveTab] = useState(defaultValue);

  return (
    <div className={className}>
      {React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          return React.cloneElement(child as React.ReactElement<any>, {
            activeTab,
            setActiveTab,
          });
        }
        return child;
      })}
    </div>
  );
};

const TabsList: React.FC<{
  children: React.ReactNode;
  className?: string;
  activeTab?: string;
  setActiveTab?: (value: string) => void;
}> = ({ children, className = "", activeTab, setActiveTab }) => (
  <div
    className={`inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground ${className}`}
  >
    {React.Children.map(children, (child) => {
      if (React.isValidElement(child)) {
        return React.cloneElement(child as React.ReactElement<any>, {
          activeTab,
          setActiveTab,
        });
      }
      return child;
    })}
  </div>
);

const TabsTrigger: React.FC<{
  value: string;
  children: React.ReactNode;
  className?: string;
  activeTab?: string;
  setActiveTab?: (value: string) => void;
}> = ({ value, children, className = "", activeTab, setActiveTab }) => {
  const isActive = activeTab === value;
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        isActive
          ? "bg-background text-foreground shadow-sm"
          : "hover:bg-background/50",
        className
      )}
      onClick={() => setActiveTab?.(value)}
    >
      {children}
    </button>
  );
};

const TabsContent: React.FC<{
  value: string;
  children: React.ReactNode;
  className?: string;
  activeTab?: string;
}> = ({ value, children, className = "", activeTab }) => {
  if (activeTab !== value) return null;
  return (
    <div
      className={cn(
        "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
    >
      {children}
    </div>
  );
};

// Type definitions
type PortalOverview = {
  portal: {
    customer: { id: string; name: string | null; email: string | null };
    subscription: {
      id: string;
      stableSubscriptionId: string;
      status: string;
      planId: string;
      gracePeriodEndsAt: string | null;
      paymentMethodId: string | null;
    } | null;
    paymentMethods: Array<{
      id: string;
      provider: string | null;
      paymentType: string | null;
      status: string | null;
      cardBrand: string | null;
      cardLastFour: string | null;
      cardExpiryMonth: number | null;
      cardExpiryYear: number | null;
      linkedToSubscription: boolean;
    }>;
    invoices: Array<{
      id: string;
      number: string | null;
      status: string;
      totalAmountCents: number;
      currency: string;
      issueDate: string | null;
      paidDate: string | null;
      pdfUrl: string | null;
      paymentStatus: string | null;
      documentType?: "standard" | "cancellation" | "credit_note" | null;
      originalInvoiceId?: string | null;
      originalInvoiceNumber?: string | null;
    }>;
    payments: Array<{
      id: string;
      amountCents: number;
      currency: string;
      status: string;
      createdAt: string;
      errorMessage: string | null;
      invoiceId: string | null;
    }>;
  };
};

type CreateSetupIntentResponse =
  | {
      provider: "stripe";
      stripe: {
        clientSecret: string;
        intentId: string;
        publishableKey: string;
      };
    }
  | {
      provider: "dodo";
      dodo: { paymentLink: string };
    };

export interface CustomerPortalProps {
  lumenHandlerUrl: string;
  externalCustomerId: string;
  className?: string;
  apiBaseUrl?: string; // Base URL for Lumen public API (SSE events)
  environment?: "test" | "live"; // For Dodo overlay mode
}

export function CustomerPortal({
  lumenHandlerUrl,
  externalCustomerId,
  className,
  apiBaseUrl = "https://api.getlumen.dev/v1",
  environment = "live",
}: CustomerPortalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PortalOverview["portal"] | null>(null);

  const [addingPm, setAddingPm] = useState(false);
  const [stripePromise, setStripePromise] =
    useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [pmRefreshing, setPmRefreshing] = useState(false);
  const [listeningForSetupEvent, setListeningForSetupEvent] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState<{
    hasActiveSubscription: boolean;
    subscription: {
      planName: string;
      planDescription: string | null;
      startTimestamp: string;
      currency: string;
    } | null;
  } | null>(null);
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const [initialPmCount, setInitialPmCount] = useState<number | null>(null);
  const pollTimerRef = React.useRef<number | null>(null);

  useEffect(() => {
    try {
      const mode =
        typeof window !== "undefined" &&
        window.location.hostname === "localhost"
          ? "test"
          : "live";
      DodoPayments.Initialize({
        mode,
        theme: "light",
        linkType: "dynamic",
        displayType: "overlay",
        onEvent: (event) => console.log("Dodo checkout event", event),
      });
    } catch {
      // ignore init failures; we'll fallback to new tab open later
    }
  }, []);

  const fetchOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const [portalRes, statusRes] = await Promise.all([
        fetch(
          `${lumenHandlerUrl}/customers/portal/overview?externalCustomerId=${encodeURIComponent(
            externalCustomerId
          )}`,
          { credentials: "include" }
        ),
        fetch(
          `${lumenHandlerUrl}/customers/subscription-status?externalCustomerId=${encodeURIComponent(
            externalCustomerId
          )}`,
          { credentials: "include" }
        ),
      ]);

      if (!portalRes.ok)
        throw new Error(`Failed to load (${portalRes.status})`);
      const portalJson: PortalOverview = await portalRes.json();
      setData(portalJson.portal);

      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        setSubscriptionStatus(statusJson);
      }
    } catch (e: any) {
      setError(getErrorMessage(e) || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
  }, [externalCustomerId, lumenHandlerUrl]);

  const startAddPaymentMethod = async () => {
    setError(null);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/customers/portal/create-setup-intent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ externalCustomerId }),
        }
      );
      if (!res.ok)
        throw new Error(`Failed to create setup intent (${res.status})`);
      const json: CreateSetupIntentResponse = await res.json();
      if (json.provider === "stripe") {
        setClientSecret(json.stripe.clientSecret);
        setSetupIntentId(json.stripe.intentId);
        setStripePromise(loadStripe(json.stripe.publishableKey));
        setAddingPm(true);
        setListeningForSetupEvent(true);
      } else if (json.provider === "dodo") {
        try {
          const link = json.dodo.paymentLink;
          const mode = environment;
          DodoPayments.Initialize({
            mode,
            theme: "light",
            linkType: "dynamic",
            displayType: "overlay",
          });
          DodoPayments.Checkout.open({
            paymentLink: link,
            redirectUrl: window.location.href,
          });
        } catch (e) {
          console.warn(
            "Failed to initialize Dodo overlay, opening in new tab",
            e
          );
          window.open(json.dodo.paymentLink, "_blank");
        }
        setInitialPmCount(data?.paymentMethods.length ?? 0);
        setPmRefreshing(true);
        let attempts = 0;
        const maxAttempts = 15;
        const poll = async () => {
          try {
            const portalRes = await fetch(
              `${lumenHandlerUrl}/customers/portal/overview?externalCustomerId=${encodeURIComponent(
                externalCustomerId
              )}`,
              { credentials: "include" }
            );
            if (portalRes.ok) {
              const portalJson: PortalOverview = await portalRes.json();
              setData(portalJson.portal);
              const newCount = portalJson.portal.paymentMethods.length;
              if (
                (initialPmCount ?? 0) < newCount ||
                portalJson.portal.subscription?.status === "active"
              ) {
                setPmRefreshing(false);
                if (pollTimerRef.current) {
                  clearTimeout(pollTimerRef.current);
                  pollTimerRef.current = null;
                }
                return;
              }
            }
          } catch {}
          if (++attempts <= maxAttempts) {
            pollTimerRef.current = window.setTimeout(poll, 2000);
          } else {
            setPmRefreshing(false);
          }
        };
        poll();
      }
    } catch (e: any) {
      setError(getErrorMessage(e) || "Failed to start payment method setup");
    }
  };

  // Listen for setup intent completion via SSE to refresh payment methods immediately
  useEffect(() => {
    if (!listeningForSetupEvent || !setupIntentId) return;
    try {
      const es = new EventSource(
        `${apiBaseUrl}/public/events/${encodeURIComponent(setupIntentId)}`
      );
      es.addEventListener("stripe_event", async (ev: MessageEvent) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data);
          const type = data.type as string;
          if (type === "setup_intent.succeeded") {
            setAddingPm(false);
            setClientSecret(null);
            setSetupIntentId(null);
            setPmRefreshing(true);
            es.close();
            window.setTimeout(async () => {
              await fetchOverview();
              setPmRefreshing(false);
              setListeningForSetupEvent(false);
            }, 2000);
          }
        } catch {
          // ignore parse errors
        }
      });
      es.onerror = () => {
        es.close();
      };
      return () => es.close();
    } catch {
      // ignore SSE issues (non-critical)
    }
  }, [listeningForSetupEvent, setupIntentId, apiBaseUrl]);

  const setDefaultPaymentMethod = async (paymentMethodId: string) => {
    setError(null);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/customers/portal/set-subscription-payment-method`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ externalCustomerId, paymentMethodId }),
        }
      );
      if (!res.ok)
        throw new Error(`Failed to set payment method (${res.status})`);
      await fetchOverview();
    } catch (e: any) {
      setError(getErrorMessage(e) || "Failed to set default payment method");
    }
  };

  const removePaymentMethod = async (paymentMethodId: string) => {
    setError(null);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/customers/portal/payment-methods/${encodeURIComponent(paymentMethodId)}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!res.ok)
        throw new Error(`Failed to remove payment method (${res.status})`);
      await fetchOverview();
    } catch (e: any) {
      setError(getErrorMessage(e) || "Failed to remove payment method");
    }
  };

  const formatCurrency = (amountCents: number, currency: string) => {
    const amount = (amountCents / 100).toFixed(2);
    const symbol = currencySymbol(currency);
    return `${symbol}${amount}`;
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "—";
    return new Date(dateString).toLocaleDateString();
  };

  const formatDateTime = (dateString: string | null) => {
    if (!dateString) return "—";
    try {
      const d = new Date(dateString);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      return formatDate(dateString);
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "active":
      case "paid":
      case "succeeded":
        return "bg-green-100 text-green-800 border-green-200";
      case "past_due":
      case "failed":
        return "bg-red-100 text-red-800 border-red-200";
      case "pending":
      case "processing":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "canceled":
      case "cancelled":
        return "bg-gray-100 text-gray-800 border-gray-200";
      default:
        return "bg-blue-100 text-blue-800 border-blue-200";
    }
  };

  const getCardBrandTheme = (brand?: string | null) => {
    const name = (brand || "").toLowerCase();
    switch (name) {
      case "visa":
        return { bg: "bg-blue-50 border-blue-200", fg: "text-blue-700" };
      case "mastercard":
        return { bg: "bg-amber-50 border-amber-200", fg: "text-amber-700" };
      case "amex":
      case "american express":
        return { bg: "bg-cyan-50 border-cyan-200", fg: "text-cyan-700" };
      case "discover":
        return { bg: "bg-orange-50 border-orange-200", fg: "text-orange-700" };
      case "diners":
      case "diners club":
        return { bg: "bg-pink-50 border-pink-200", fg: "text-pink-700" };
      case "jcb":
        return { bg: "bg-indigo-50 border-indigo-200", fg: "text-indigo-700" };
      default:
        return { bg: "bg-gray-50 border-gray-200", fg: "text-gray-700" };
    }
  };

  const toTitleCase = (value: string) =>
    value ? value.charAt(0).toUpperCase() + value.slice(1) : value;

  const formatPaymentMethodTitle = (pm: {
    cardBrand: string | null;
    paymentType: string | null;
    provider: string | null;
    cardLastFour: string | null;
  }) => {
    const name = toTitleCase(
      String(pm.cardBrand || pm.paymentType || pm.provider || "Card")
    );
    return pm.cardLastFour ? `${name} ending in ${pm.cardLastFour}` : name;
  };

  const BrandLogo: React.FC<{
    brand?: string | null;
    className?: string;
  }> = ({ brand, className = "" }) => {
    const b = (brand || "").toLowerCase();
    if (b === "mastercard") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <circle cx="15" cy="12" r="7.5" fill="#EB001B" />
          <circle cx="25" cy="12" r="7.5" fill="#F79E1B" />
        </svg>
      );
    }
    if (b === "visa") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <text
            x="4"
            y="16"
            fontSize="12"
            fontWeight="700"
            fill="#1A1F71"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
          >
            VISA
          </text>
        </svg>
      );
    }
    if (b === "amex" || b === "american express") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <rect x="3" y="5" width="34" height="14" rx="2" fill="#2E77BC" />
          <text
            x="20"
            y="16"
            fontSize="10"
            fontWeight="700"
            fill="#fff"
            textAnchor="middle"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
          >
            AMEX
          </text>
        </svg>
      );
    }
    if (b === "discover") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <circle cx="30" cy="12" r="6" fill="#F76B1C" />
          <text
            x="4"
            y="16"
            fontSize="10"
            fontWeight="700"
            fill="#111827"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
          >
            DISC
          </text>
        </svg>
      );
    }
    if (b === "jcb") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <text
            x="8"
            y="16"
            fontSize="12"
            fontWeight="700"
            fill="#0B6BB8"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
          >
            JCB
          </text>
        </svg>
      );
    }
    return <CreditCard className={className} />;
  };

  const handleDownloadInvoice = async (invoiceId: string) => {
    setPdfLoadingId(invoiceId);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/invoices/${encodeURIComponent(invoiceId)}/pdf`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`Failed to get PDF URL (${res.status})`);
      const data = await res.json();
      if (!data?.pdfUrl) throw new Error("No PDF URL received");
      window.open(data.pdfUrl as string, "_blank");
    } catch (e: any) {
      setError(e?.message || "Failed to download invoice");
    } finally {
      setPdfLoadingId(null);
    }
  };

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading Customer Portal
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-red-600 flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            Error Loading Portal
          </CardTitle>
          <CardDescription className="text-red-600">{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={fetchOverview} variant="outline">
            Try Again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card className={className}>
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>Account Overview</CardTitle>
            <CardDescription className="mt-1">
              {data.customer.name && (
                <span className="font-medium">{data.customer.name} • </span>
              )}
              {data.customer.email}
            </CardDescription>
            {subscriptionStatus?.hasActiveSubscription &&
              subscriptionStatus.subscription && (
                <div className="text-xs text-muted-foreground mt-1">
                  Plan: {subscriptionStatus.subscription.planName} • Active
                  since{" "}
                  {formatDateTime(
                    subscriptionStatus.subscription.startTimestamp
                  )}
                </div>
              )}
          </div>
          {data.subscription && (
            <Badge className={getStatusBadgeColor(data.subscription.status)}>
              {data.subscription.status}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="payment-methods" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="payment-methods">Payment Methods</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="payments">Payment History</TabsTrigger>
          </TabsList>

          <TabsContent value="payment-methods" className="mt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">Payment Methods</h3>
                  <p className="text-sm text-muted-foreground">
                    Manage your saved payment methods
                  </p>
                </div>
                <Button onClick={startAddPaymentMethod} size="sm">
                  Add Payment Method
                </Button>
              </div>

              {pmRefreshing ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    Updating payment methods...
                  </span>
                </div>
              ) : data.paymentMethods.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-muted-foreground mb-2">
                    No payment methods found
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Add a payment method to manage your subscription
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {data.paymentMethods.map((pm) => (
                    <div
                      key={pm.id}
                      className="flex items-center justify-between p-4 border rounded-xl hover:bg-gray-50 shadow-sm hover:shadow transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            "h-10 w-16 rounded-md border flex items-center justify-center",
                            getCardBrandTheme(pm.cardBrand || pm.provider).bg
                          )}
                        >
                          <BrandLogo
                            brand={pm.cardBrand || pm.provider}
                            className={cn(
                              "h-5 w-auto",
                              getCardBrandTheme(pm.cardBrand || pm.provider).fg
                            )}
                          />
                        </div>
                        <div>
                          <div className="font-medium">
                            {formatPaymentMethodTitle(pm)}
                          </div>
                          {pm.cardExpiryMonth && pm.cardExpiryYear && (
                            <div className="text-xs text-muted-foreground">
                              Expires{" "}
                              {pm.cardExpiryMonth.toString().padStart(2, "0")}/
                              {pm.cardExpiryYear}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {data.subscription?.paymentMethodId === pm.id ? (
                          <Badge className="bg-green-100 text-green-800 border-green-200">
                            Default
                          </Badge>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDefaultPaymentMethod(pm.id)}
                          >
                            Set as Default
                          </Button>
                        )}
                        {!(
                          pm.linkedToSubscription ||
                          data.subscription?.paymentMethodId === pm.id
                        ) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removePaymentMethod(pm.id)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="invoices" className="mt-6">
            <div className="space-y-4">
              <div>
                <h3 className="font-medium">Invoices</h3>
                <p className="text-sm text-muted-foreground">
                  View and download your invoices
                </p>
              </div>

              {data.invoices.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-muted-foreground mb-2">
                    No invoices found
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Your invoices will appear here once generated
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.invoices.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span>#{inv.number || inv.id.slice(-6)}</span>
                              {inv.documentType &&
                                inv.documentType !== "standard" && (
                                  <Badge variant="outline">
                                    {inv.documentType === "cancellation"
                                      ? "Cancellation"
                                      : "Credit Note"}
                                  </Badge>
                                )}
                            </div>
                            {inv.originalInvoiceId && (
                              <div className="text-xs text-muted-foreground mt-1">
                                Ref: #
                                {inv.originalInvoiceNumber ||
                                  inv.originalInvoiceId}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDateTime(inv.issueDate)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {formatCurrency(inv.totalAmountCents, inv.currency)}
                        </TableCell>
                        <TableCell>
                          <Badge className={getStatusBadgeColor(inv.status)}>
                            {inv.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDownloadInvoice(inv.id)}
                            disabled={!inv.pdfUrl || pdfLoadingId === inv.id}
                            aria-disabled={!inv.pdfUrl}
                          >
                            {pdfLoadingId === inv.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              "PDF"
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="payments" className="mt-6">
            <div className="space-y-4">
              <div>
                <h3 className="font-medium">Payment History</h3>
                <p className="text-sm text-muted-foreground">
                  View your recent payment transactions
                </p>
              </div>

              {data.payments.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-muted-foreground mb-2">
                    No payments found
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Your payment history will appear here
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Amount</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">
                          {formatCurrency(p.amountCents, p.currency)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDateTime(p.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div>
                            <Badge className={getStatusBadgeColor(p.status)}>
                              {p.status}
                            </Badge>
                            {p.errorMessage && (
                              <div className="text-xs text-red-600 mt-1">
                                {p.errorMessage}
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {addingPm && stripePromise && clientSecret ? (
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <AddPaymentMethodModal
              onClose={(reason) => {
                setAddingPm(false);
                setClientSecret(null);
                if (reason === "cancelled") {
                  setListeningForSetupEvent(false);
                  setSetupIntentId(null);
                }
              }}
            />
          </Elements>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AddPaymentMethodModal({
  onClose,
}: {
  onClose: (reason: "submitted" | "cancelled") => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setError(null);
    setProcessing(true);
    try {
      const { error } = await elements.submit();
      if (error) throw new Error(error.message);
      const result = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
      });
      if (result.error) throw new Error(result.error.message);
      onClose("submitted");
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to confirm payment method");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Add payment method</CardTitle>
          <CardDescription>
            Your card will be stored for future charges.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <PaymentElement id="payment-element" />
            {error ? <div className="text-sm text-red-600">{error}</div> : null}
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                onClick={() => onClose("cancelled")}
                disabled={processing}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={processing}>
                {processing ? "Processing..." : "Confirm"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
