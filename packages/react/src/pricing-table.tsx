import * as React from "react";
import { useState, useEffect, useRef } from "react";
import { AlertCircle, Loader2, Check, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { PaymentModal } from "./PaymentModal";
import { Plan, PricingTableProps, InitialCustomer } from "./types";
import { PricingTableCards } from "./pricing-table-cards";
import { DodoPayments } from "dodopayments-checkout";
import {
  getErrorMessage,
  sanitizeInitialCustomer,
  currencySymbol,
} from "../lib/utils";

// Simple validation function (replacing Zod)
const validatePricingTableData = (data: unknown): data is PricingTableProps => {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.plans)) return false;

  return d.plans.every((plan) => {
    if (!plan || typeof plan !== "object") return false;
    const p = plan as Record<string, unknown>;
    return (
      typeof p.title === "string" &&
      typeof p.buttonText === "string" &&
      typeof p.price === "number" &&
      typeof p.interval === "string"
    );
  });
};

export async function fetchPricingTable({
  slug,
  lumenPublishableKey,
  apiBaseUrl = "https://api.getlumen.dev/v1",
}: {
  slug?: string;
  lumenPublishableKey: string;
  apiBaseUrl?: string;
}): Promise<PricingTableProps> {
  try {
    const url = slug
      ? `${apiBaseUrl}/public/pricing-tables/${slug}`
      : `${apiBaseUrl}/public/pricing-tables`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Lumen-Key": lumenPublishableKey,
      },
    });

    if (!response.ok) {
      let errorMessage = `Failed to fetch pricing table (${response.status})`;
      try {
        const errorData = await response.json();
        errorMessage = getErrorMessage(errorData) || errorMessage;
      } catch {
        // If response body is not JSON, use the status-based message
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    return data.pricingTable;
  } catch (error) {
    console.error("Error fetching pricing table:", error);
    // Re-throw with consistent error message format
    throw new Error(getErrorMessage(error));
  }
}

export async function fetchSubscriptionStatus({
  externalCustomerId,
  lumenHandlerUrl,
}: {
  externalCustomerId: string;
  lumenHandlerUrl: string;
}) {
  try {
    const url = `${lumenHandlerUrl}/customers/subscription-status?externalCustomerId=${encodeURIComponent(externalCustomerId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include", // Include cookies and auth headers for session-based auth
    });

    if (!response.ok) {
      let errorMessage = `Failed to fetch subscription status (${response.status})`;
      try {
        const errorData = await response.json();
        errorMessage = getErrorMessage(errorData) || errorMessage;
      } catch {
        // If response body is not JSON, use the status-based message
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching subscription status:", error);
    return null;
  }
}

// Centered high-contrast result overlay shown after the payment modal closes
const ResultOverlay: React.FC<{
  type: "success" | "error";
  message: string;
  countdownSeconds?: number | null;
  onClose?: () => void;
}> = ({ type, message, countdownSeconds, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden border border-gray-100">
        <div
          className={`px-6 py-5 flex items-center gap-3 ${
            type === "success" ? "bg-green-600" : "bg-red-600"
          }`}
        >
          <div className="text-white">
            {type === "success" ? (
              <Check className="h-5 w-5" />
            ) : (
              <AlertCircle className="h-5 w-5" />
            )}
          </div>
          <h3 className="text-white font-medium text-base flex-1">
            {type === "success" ? "Payment Successful!" : "Payment Failed"}
          </h3>
          {onClose && (
            <button
              onClick={onClose}
              className="text-white/90 hover:text-white hover:bg-white/10 rounded-full p-1 transition-colors"
              aria-label="Close notification"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="px-6 py-5">
          <p className="text-gray-600 text-sm leading-relaxed">{message}</p>
          {typeof countdownSeconds === "number" && countdownSeconds >= 0 && (
            <p className="text-xs text-gray-500 mt-3 font-medium">
              Redirecting in {countdownSeconds} seconds...
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// Stable overlay container used by inline modals
const Overlay: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
    {children}
  </div>
);

// Update the component props
export const PricingTable = function PricingTable({
  pricingTableSlug,
  lumenPublishableKey = process?.env?.NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY,
  redirectUrl,
  apiBaseUrl = "https://api.getlumen.dev/v1",
  userId,
  organizationId,
  loginRedirectUrl,
  pricingData, // For backward compatibility and testing
  lumenHandlerUrl,
  paymentProvider = "stripe",
  environment = "live",
  initialCustomer,
}: {
  /**
   * The slug of the pricing table to fetch from Lumen (REQUIRED)
   * This identifies which pricing table to display
   */
  pricingTableSlug?: string;

  /**
   * Your Lumen publishable key, if not provided it will try to read it from NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY
   * Format: pk_test_xxx or pk_live_xxx
   */
  lumenPublishableKey?: string;

  /**
   * Optional URL to redirect to after successful payment
   */
  redirectUrl?: string;

  /**
   * Optional base URL for the Lumen API
   * Only override for development/testing
   */
  apiBaseUrl?: string;

  /**
   * Optional unique identifier for the user
   * Will be stored with the subscription
   */
  userId?: string;

  /**
   * Optional organization ID (preferred for seat-based plans)
   * When provided, the subscription will be created under the organization's billing customer
   */
  organizationId?: string;

  /**
   * URL to redirect if the user is not logged in
   */
  loginRedirectUrl: string;

  /**
   * Optional manual pricing data
   * Used only for backward compatibility or testing
   * In production, data is fetched from Lumen API
   */
  pricingData?: Partial<PricingTableProps>;
  lumenHandlerUrl?: string;
  paymentProvider?: "stripe" | "dodo";
  environment?: "test" | "live";
  initialCustomer?: InitialCustomer;
}) {
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [validatedPricingData, setValidatedPricingData] =
    useState<PricingTableProps | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<any | null>(
    null
  );
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
    countdown: number | null;
  } | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const autoDismissTimeoutRef = useRef<number | null>(null);

  const sanitizedInitialCustomer = React.useMemo(
    () => sanitizeInitialCustomer(initialCustomer),
    [initialCustomer]
  );

  React.useEffect(() => {
    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      if (autoDismissTimeoutRef.current) {
        clearTimeout(autoDismissTimeoutRef.current);
        autoDismissTimeoutRef.current = null;
      }
    };
  }, []);

  const dismissNotification = () => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (autoDismissTimeoutRef.current) {
      clearTimeout(autoDismissTimeoutRef.current);
      autoDismissTimeoutRef.current = null;
    }
    setNotification(null);
  };

  const handleStripePaymentSuccess = () => {
    setSelectedPlan(null);
    if (redirectUrl) {
      setNotification({
        type: "success",
        message: "Payment successful.",
        countdown: 5,
      });
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
      countdownIntervalRef.current = window.setInterval(() => {
        setNotification((prev) => {
          if (!prev || prev.countdown === null) return prev;
          if (prev.countdown <= 1) {
            window.setTimeout(() => {
              if (countdownIntervalRef.current) {
                clearInterval(countdownIntervalRef.current);
                countdownIntervalRef.current = null;
              }
              window.location.href = redirectUrl;
            }, 0);
            return { ...prev, countdown: 0 };
          }
          return { ...prev, countdown: prev.countdown - 1 };
        });
      }, 1000);
    } else {
      setNotification({
        type: "success",
        message: "Payment successful.",
        countdown: null,
      });
      if (autoDismissTimeoutRef.current) {
        clearTimeout(autoDismissTimeoutRef.current);
      }
      autoDismissTimeoutRef.current = window.setTimeout(() => {
        setNotification(null);
        autoDismissTimeoutRef.current = null;
      }, 3000);
    }
  };

  const handleStripePaymentError = (err?: string) => {
    const msg = err || "Payment failed. Please try again.";
    setNotification({ type: "error", message: msg, countdown: null });
    if (autoDismissTimeoutRef.current) {
      clearTimeout(autoDismissTimeoutRef.current);
    }
    autoDismissTimeoutRef.current = window.setTimeout(() => {
      setNotification(null);
      autoDismissTimeoutRef.current = null;
    }, 3000);
  };

  // Fetch pricing table and optional subscription status
  useEffect(() => {
    if (lumenPublishableKey) {
      setLoading(true);
      setError(null);

      const fetches: Promise<any>[] = [
        fetchPricingTable({
          slug: pricingTableSlug,
          lumenPublishableKey,
          apiBaseUrl,
        }),
      ];

      if (userId) {
        const resolvedHandlerUrl =
          lumenHandlerUrl || `${window.location.origin}/api/lumen`;
        fetches.push(
          fetchSubscriptionStatus({
            externalCustomerId: userId,
            lumenHandlerUrl: resolvedHandlerUrl,
          })
        );
      }

      Promise.all(fetches)
        .then((results) => {
          const pricingTableData = results[0];
          const subscriptionStatusData = results[1];
          if (validatePricingTableData(pricingTableData)) {
            setValidatedPricingData(pricingTableData);
          } else {
            setError("Invalid pricing table data received from server");
          }

          if (
            subscriptionStatusData &&
            typeof subscriptionStatusData === "object" &&
            "hasActiveSubscription" in subscriptionStatusData &&
            subscriptionStatusData.hasActiveSubscription &&
            "customer" in subscriptionStatusData &&
            "subscription" in subscriptionStatusData
          ) {
            setSubscriptionStatus(subscriptionStatusData);
          }
        })
        .catch((err) =>
          setError(`Failed to load pricing table: ${err.message}`)
        )
        .finally(() => setLoading(false));
    } else if (pricingData) {
      if (validatePricingTableData(pricingData)) {
        setValidatedPricingData(pricingData);
      } else {
        setError("Invalid pricing table configuration");
      }
    }
  }, [
    pricingTableSlug,
    lumenPublishableKey,
    apiBaseUrl,
    pricingData,
    userId,
    lumenHandlerUrl,
  ]);

  // Initialize Dodo Payments when applicable
  useEffect(() => {
    if (paymentProvider !== "dodo" || !validatedPricingData) return;
    try {
      DodoPayments.Initialize({
        mode: environment,
        onEvent: (event: any) => console.log("Checkout event:", event),
        theme: "light",
        linkType: "dynamic",
        displayType: "overlay",
      });
    } catch (e) {
      console.error("Failed to initialize DodoPayments SDK", e);
    }
  }, [paymentProvider, validatedPricingData, environment]);

  // Show loading state
  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2">Loading pricing information...</span>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <Alert variant="destructive" className="max-w-2xl mx-auto my-8">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!lumenPublishableKey) {
    return (
      <Alert variant="destructive" className="max-w-2xl mx-auto my-8">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Missing API Key</AlertTitle>
        <AlertDescription>
          <div className="text-sm mt-2">
            <p>
              No publishable key, please set NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY
              in your environment variables or pass it as a prop. Get your API
              Key from{" "}
              <a
                href="https://getlumen.dev/developer/apikeys"
                target="_blank"
                rel="noopener noreferrer"
              >
                https://getlumen.dev/developer/apikeys
              </a>
            </p>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  if (!validatedPricingData) {
    return (
      <Alert variant="destructive" className="max-w-2xl mx-auto my-8">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Missing Pricing Table Data</AlertTitle>
        <AlertDescription>
          <div className="text-sm mt-2">
            <p>No pricing table data found.</p>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  // Destructure the validated data
  const { heading, description, plans } = validatedPricingData;

  return (
    <div>
      {notification && selectedPlan === null && (
        <ResultOverlay
          type={notification.type}
          message={notification.message}
          countdownSeconds={notification.countdown}
          onClose={dismissNotification}
        />
      )}
      <PricingTableCards
        heading={heading}
        description={description}
        plans={plans}
        subscriptionStatus={subscriptionStatus}
        setSelectedPlan={
          userId
            ? setSelectedPlan
            : () => {
                window.location.href = loginRedirectUrl;
              }
        }
      />
      {paymentProvider === "dodo" ? (
        <PaymentModalDodo
          isOpen={!!selectedPlan}
          lumenPublishableKey={lumenPublishableKey}
          userId={userId || ""}
          organizationId={organizationId}
          plan={selectedPlan}
          onClose={() => setSelectedPlan(null)}
          apiBaseUrl={apiBaseUrl}
          redirectUrl={redirectUrl}
          initialCustomer={sanitizedInitialCustomer}
        />
      ) : (
        <PaymentModal
          isOpen={!!selectedPlan}
          lumenPublishableKey={lumenPublishableKey}
          userId={userId || ""}
          organizationId={organizationId}
          plan={selectedPlan}
          onPaymentSuccess={handleStripePaymentSuccess}
          onPaymentError={handleStripePaymentError}
          onClose={() => setSelectedPlan(null)}
          apiBaseUrl={apiBaseUrl}
          initialCustomer={sanitizedInitialCustomer}
        />
      )}
    </div>
  );
};

// Lightweight Dodo modal (mirrors UI behavior)
interface PaymentModalDodoProps {
  isOpen: boolean;
  lumenPublishableKey: string;
  plan: Plan | null;
  userEmail?: string;
  userId: string;
  organizationId?: string;
  apiBaseUrl?: string;
  onClose?: () => void;
  redirectUrl?: string;
  initialCustomer?: InitialCustomer;
  onPaymentError?: (message: string) => void;
}

import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { SearchableSelect } from "./ui/searchable-select";
import { customerCountries, usStates } from "./utils/countries";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./ui/card";

const PaymentModalDodo = ({
  isOpen,
  lumenPublishableKey,
  plan,
  userEmail,
  userId,
  organizationId,
  onClose,
  apiBaseUrl = "https://api.getlumen.dev/v1",
  redirectUrl,
  onPaymentError,
  initialCustomer,
}: PaymentModalDodoProps) => {
  const [loading, setLoading] = useState(false);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [customerEmail, setCustomerEmail] = useState<string>(
    initialCustomer?.email || userEmail || ""
  );
  const [customerName, setCustomerName] = useState<string>(
    initialCustomer?.name || ""
  );
  const [businessName, setBusinessName] = useState<string>(
    initialCustomer?.businessName || ""
  );
  const [customerAddress, setCustomerAddress] = useState<string>(
    initialCustomer?.address || ""
  );
  const [customerAddressLine2, setCustomerAddressLine2] = useState<string>(
    initialCustomer?.addressLine2 || ""
  );
  const [customerZip, setCustomerZip] = useState<string>(
    initialCustomer?.zip || ""
  );
  const [customerCity, setCustomerCity] = useState<string>(
    initialCustomer?.city || ""
  );
  const [customerCountry, setCustomerCountry] = useState<string>(
    initialCustomer?.country || ""
  );
  const [customerStateProvince, setCustomerStateProvince] = useState<string>(
    initialCustomer?.stateProvince || ""
  );
  const [taxId, setTaxId] = useState<string>(initialCustomer?.taxId || "");
  const [isBusiness, setIsBusiness] = useState<boolean>(
    initialCustomer?.isBusiness || false
  );

  const validateEmail = (email: string) =>
    /[^\s@]+@[^\s@]+\.[^\s@]+/.test(email);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateEmail(customerEmail)) {
      setIntegrationError("Please enter a valid email address");
      return;
    }

    const missing: string[] = [];
    if (!customerName) missing.push("full name");
    if (!userId) missing.push("user ID");
    if (isBusiness) {
      if (!taxId) missing.push("tax ID");
      if (!businessName) missing.push("business name");
    }
    if (!customerAddress) missing.push("address");
    if (!customerZip) missing.push("ZIP code");
    if (!customerCity) missing.push("city");
    if (!customerCountry) missing.push("country");
    if (customerCountry === "US" && !customerStateProvince)
      missing.push("state");
    if (missing.length) {
      setIntegrationError(
        `Please fill in all required fields: ${missing.join(", ")}`
      );
      return;
    }

    setLoading(true);
    try {
      if (!plan) {
        setIntegrationError("No plan selected");
        return;
      }
      const isYearly = plan.selectedBillingInterval === "yearly";
      let priceId = plan.priceId;
      if (isYearly && plan.priceIdYearly) priceId = plan.priceIdYearly;
      else if (!isYearly && plan.priceIdMonthly) priceId = plan.priceIdMonthly;

      const body: Record<string, unknown> = {
        lumenPublishableKey,
        customerEmail,
        customerName,
        userId,
        ...(organizationId && { organizationId }),
        planId: plan.planId,
        priceId,
        currency: plan.currency || "USD",
        productName: plan.title,
        ...(plan.trial?.available && { startTrial: true }),
        customerAddress,
        customerAddressLine2,
        customerZip,
        customerCity,
        customerCountry,
        customerStateProvince,
      };
      if (isBusiness) {
        body.businessName = businessName;
        body.taxId = taxId;
      }

      const resp = await fetch(`${apiBaseUrl}/public/payment-init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setIntegrationError(data.error || "Failed to create payment");
        return;
      }
      if (data.success && data.payment_link) {
        DodoPayments.Checkout.open({
          paymentLink: data.payment_link,
          redirectUrl,
        });

        try {
          const injectNotice = () => {
            const inner = document.getElementById("dodo-checkout-inner-div");
            if (!inner) return false;
            const existing = document.getElementById(
              "lumen-dodo-overlay-notice"
            );
            if (existing) return true;
            const symbol = plan.currency ? currencySymbol(plan.currency) : "€";
            const amount = (() => {
              const base =
                isYearly && plan.priceYearly
                  ? plan.priceYearly
                  : (plan.priceMonthly ?? plan.price);
              const seatMultiplier = plan.interval?.includes("per seat")
                ? Math.max(1, plan.minSeats || 1)
                : 1;
              return (base * seatMultiplier).toFixed(2);
            })();
            const period = isYearly ? "year" : "month";
            const seatSuffix = plan.interval?.includes("per seat")
              ? " per seat"
              : "";
            const wrapper = document.createElement("div");
            wrapper.id = "lumen-dodo-overlay-notice";
            wrapper.style.position = "fixed";
            wrapper.style.top = "16px";
            wrapper.style.left = "50%";
            wrapper.style.transform = "translateX(-50%)";
            wrapper.style.zIndex = "1001";
            wrapper.style.maxWidth = "92vw";
            wrapper.style.pointerEvents = "none";
            const card = document.createElement("div");
            card.style.background = "#EFF6FF";
            card.style.border = "1px solid #BFDBFE";
            card.style.color = "#1E3A8A";
            card.style.borderRadius = "8px";
            card.style.padding = "12px 14px";
            card.style.boxShadow = "0 2px 6px rgba(0,0,0,0.08)";
            card.style.fontSize = "14px";
            card.style.lineHeight = "20px";
            card.style.pointerEvents = "auto";
            card.style.backdropFilter = "saturate(180%) blur(2px)";
            const headline = plan.trial?.available
              ? `You won't be charged today (taxes may apply after trial). Your payment method will be stored.`
              : `Review your payment details.`;
            const followup = plan.trial?.available
              ? `Future charges will be ${symbol}${amount} per ${period}${seatSuffix} + taxes.`
              : ``;
            card.textContent = `${headline} ${followup}`.trim();
            wrapper.appendChild(card);
            inner.appendChild(wrapper);
            const observer = new MutationObserver(() => {
              const outer = document.getElementById("dodo-checkout-outer-div");
              if (!outer) {
                wrapper.remove();
                observer.disconnect();
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            return true;
          };
          let attempts = 0;
          const tryAttach = () => {
            if (injectNotice()) {
              onClose?.();
              return;
            }
            if (attempts++ < 30) setTimeout(tryAttach, 100);
          };
          tryAttach();
          setTimeout(() => onClose?.(), 800);
        } catch (e) {
          console.warn("Failed to inject Dodo overlay notice", e);
        }
      } else {
        setIntegrationError("Failed to create payment link");
      }
    } catch (err) {
      console.error(err);
      setIntegrationError("Failed to initialize payment. Please try again.");
      onPaymentError?.("Failed to initialize payment. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Overlay>
      <Card className="w-full max-w-lg max-h-[90vh] flex flex-col relative">
        <CardHeader className="flex-shrink-0">
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close modal"
              className="absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">×</span>
            </button>
          )}
          <CardTitle>
            {plan?.trial?.available
              ? "Start your free trial"
              : "Enter your details"}
          </CardTitle>
          <CardDescription>
            {plan?.trial?.available
              ? `Start your ${plan.trial.days}-day free trial for ${plan.title}. You won't be charged today (taxes may apply after trial).`
              : `Please provide your information to proceed with the payment for ${plan?.title}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center min-h-[200px]">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                type="email"
                placeholder="Email address"
                value={customerEmail}
                onChange={(e) => {
                  setCustomerEmail(e.target.value);
                  setIntegrationError(null);
                }}
                required
              />
              <Input
                type="text"
                placeholder="Full name"
                value={customerName}
                onChange={(e) => {
                  setCustomerName(e.target.value);
                  setIntegrationError(null);
                }}
                required
              />
              <div className="flex items-center space-x-2 my-4">
                <Checkbox
                  id="business-toggle"
                  checked={isBusiness}
                  onCheckedChange={(checked: boolean) => setIsBusiness(checked)}
                />
                <Label htmlFor="business-toggle" className="cursor-pointer">
                  I&apos;m buying as a business
                </Label>
              </div>
              {isBusiness && (
                <>
                  <Input
                    type="text"
                    placeholder="Tax ID (VAT/EIN/GST/etc.)"
                    value={taxId}
                    onChange={(e) => setTaxId(e.target.value)}
                    required
                  />
                  <Input
                    type="text"
                    placeholder="Business name"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    required
                  />
                </>
              )}
              <Input
                type="text"
                placeholder="Address"
                value={customerAddress}
                onChange={(e) => setCustomerAddress(e.target.value)}
                required
              />
              <Input
                type="text"
                placeholder="Address line 2 (Optional)"
                value={customerAddressLine2}
                onChange={(e) => setCustomerAddressLine2(e.target.value)}
              />
              <Input
                type="text"
                placeholder="ZIP code"
                value={customerZip}
                onChange={(e) => setCustomerZip(e.target.value)}
                required
              />
              <Input
                type="text"
                placeholder="City"
                value={customerCity}
                onChange={(e) => setCustomerCity(e.target.value)}
                required
              />
              <SearchableSelect
                options={customerCountries}
                value={customerCountry}
                onValueChange={(value) => {
                  setCustomerCountry(value);
                  if (value !== "US" && customerStateProvince) {
                    const isUSState = usStates.some(
                      (s) => s.value === customerStateProvince
                    );
                    if (isUSState) setCustomerStateProvince("");
                  }
                  setIntegrationError(null);
                }}
                placeholder="Select country"
                required
              />
              {customerCountry === "US" ? (
                <SearchableSelect
                  options={usStates}
                  value={customerStateProvince}
                  onValueChange={(value) => {
                    setCustomerStateProvince(value);
                    setIntegrationError(null);
                  }}
                  placeholder="Select state"
                  required
                />
              ) : (
                <Input
                  type="text"
                  placeholder="State/Province (optional)"
                  value={customerStateProvince}
                  onChange={(e) => setCustomerStateProvince(e.target.value)}
                />
              )}
              {integrationError && (
                <Alert variant="destructive">
                  <AlertDescription>{integrationError}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : plan?.trial?.available ? (
                  "Start Free Trial"
                ) : (plan?.selectedPrice ??
                    plan?.priceMonthly ??
                    plan?.price ??
                    0) === 0 ? (
                  "Start free subscription"
                ) : (
                  "Continue to payment"
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </Overlay>
  );
};
