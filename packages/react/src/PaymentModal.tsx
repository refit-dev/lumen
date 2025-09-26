import * as React from "react";
import { useState, useEffect } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, Stripe } from "@stripe/stripe-js";
import { AlertCircle, Check, Loader2, X } from "lucide-react";

// Import UI components
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SearchableSelect } from "./ui/searchable-select";

import { Plan, InitialCustomer } from "./types";
import { currencySymbol, getErrorMessage, validateEmail } from "../lib/utils";
import { customerCountries, usStates } from "./utils/countries";

// Simple Alert component (inline to match shadcn source)
const Alert: React.FC<{
  variant?: "destructive" | "default";
  className?: string;
  children: React.ReactNode;
}> = ({ variant = "default", className = "", children }) => (
  <div
    className={`relative w-full rounded-lg border p-4 ${
      variant === "destructive"
        ? "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive"
        : "border-border"
    } ${className}`}
  >
    {children}
  </div>
);

const AlertDescription: React.FC<{
  className?: string;
  children: React.ReactNode;
}> = ({ className = "", children }) => (
  <div className={`text-sm [&_p]:leading-relaxed ${className}`}>{children}</div>
);

// Simple CloseButton component (inline)
const CloseButton: React.FC<{
  onClick?: () => void;
  "aria-label"?: string;
  children: React.ReactNode;
}> = ({ onClick, "aria-label": ariaLabel, children }) => (
  <button
    onClick={onClick}
    aria-label={ariaLabel}
    className="absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
  >
    <X className="h-4 w-4" />
    <span className="sr-only">{children}</span>
  </button>
);

// Overlay component
const Overlay: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
    {children}
  </div>
);

interface PaymentModalProps {
  isOpen: boolean;
  lumenPublishableKey: string;
  plan: Plan | null;
  userEmail?: string;
  userId: string;
  organizationId?: string;
  apiBaseUrl?: string;
  onClose?: () => void;
  onPaymentSuccess?: (paymentIntentId?: string) => void;
  onPaymentError?: (error?: string) => void;
  requireBillingDetails?: boolean;
  initialCustomer?: InitialCustomer;
}

// Tax calculation result interface
interface TaxCalculationResult {
  success: boolean;
  taxCalculation: {
    subtotalCents: number;
    taxAmountCents: number;
    totalAmountCents: number;
    effectiveTaxRate: number;
    jurisdiction: string;
    calculationMethod: string;
    taxLineItems: Array<{
      type: "tax";
      description: string;
      subtotalCents: number;
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
    }>;
    exemptionReason?: string;
  };
}

export const PaymentModal = ({
  isOpen,
  lumenPublishableKey,
  plan,
  userEmail,
  userId,
  organizationId,
  onClose,
  onPaymentSuccess,
  onPaymentError,
  requireBillingDetails = false,
  apiBaseUrl = "https://api.getlumen.dev/v1",
  initialCustomer,
}: PaymentModalProps) => {
  const [stripePromise, setStripePromise] =
    useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [intentType, setIntentType] = useState<string | null>(null);
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
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [checkoutFormErrorMessage, setCheckoutFormErrorMessage] = useState<
    string | null
  >(null);
  const [taxData, setTaxData] = useState<
    TaxCalculationResult["taxCalculation"] | null
  >(null);

  // Function to calculate taxes for a specific plan and customer details
  const calculateTaxesForSubmission = async (
    plan: Plan,
    customerCountry: string,
    customerStateProvince?: string,
    taxId?: string,
    businessName?: string
  ): Promise<TaxCalculationResult["taxCalculation"] | null> => {
    try {
      const isYearlyBilling = plan.selectedBillingInterval === "yearly";
      let selectedPriceId = plan.priceId;
      let subtotalCents = 0;

      if (isYearlyBilling && plan.priceIdYearly) {
        selectedPriceId = plan.priceIdYearly;
        subtotalCents = plan.selectedPrice ? plan.selectedPrice : 0;
      } else if (!isYearlyBilling && plan.priceIdMonthly) {
        selectedPriceId = plan.priceIdMonthly;
        subtotalCents = plan.priceMonthly ? plan.priceMonthly : plan.price || 0;
      } else {
        subtotalCents = plan.price || 0;
      }

      // Convert to cents and apply seat multiplier
      subtotalCents = subtotalCents * 100;
      const seatMultiplier = plan.interval?.includes("per seat")
        ? Math.max(1, plan.minSeats || 1)
        : 1;
      subtotalCents = subtotalCents * seatMultiplier;

      const response = await fetch(`${apiBaseUrl}/public/calculate-tax`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lumenPublishableKey,
          planId: plan.planId,
          priceId: selectedPriceId,
          subtotalCents,
          currency: plan.currency || "USD",
          customerCountry,
          customerStateProvince,
          taxId,
          businessName,
        }),
      });

      if (!response.ok) {
        let errorMessage = `Failed to calculate taxes (${response.status})`;
        try {
          const errorData = await response.json();
          errorMessage = getErrorMessage(errorData) || errorMessage;
        } catch {}
        throw new Error(errorMessage);
      }

      const result: TaxCalculationResult = await response.json();
      return result.taxCalculation;
    } catch (error) {
      console.error("Error calculating taxes:", error);
      return null;
    }
  };

  // Reset payment state when billing interval changes
  useEffect(() => {
    if (plan && showPaymentForm) {
      setClientSecret(null);
      setIntentId(null);
      setIntentType(null);
      setShowPaymentForm(false);
      setIntegrationError(null);
      setCheckoutFormErrorMessage(null);
      setEmailSubmitting(false);
      setTaxData(null);
    }
  }, [plan?.selectedBillingInterval]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
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
    if (isBusiness || requireBillingDetails) {
      if (!customerAddress) missing.push("address");
      if (!customerZip) missing.push("ZIP code");
      if (!customerCity) missing.push("city");
      if (!customerCountry) missing.push("country");
      if (customerCountry === "US" && !customerStateProvince) {
        missing.push("state");
      }
    }
    if (missing.length) {
      setIntegrationError(
        `Please fill in all required fields: ${missing.join(", ")}`
      );
      return;
    }

    setEmailSubmitting(true);
    try {
      if (!plan) {
        setIntegrationError("No plan selected");
        return;
      }

      // Step 1: Calculate taxes if we have address information and not starting a trial
      let taxCalculation: TaxCalculationResult["taxCalculation"] | null = null;
      const willStartTrial = !!plan.trial?.available;

      if (
        !willStartTrial &&
        customerCountry &&
        (isBusiness || requireBillingDetails)
      ) {
        taxCalculation = await calculateTaxesForSubmission(
          plan,
          customerCountry,
          customerStateProvince,
          isBusiness ? taxId : undefined,
          isBusiness ? businessName : undefined
        );
        if (taxCalculation) setTaxData(taxCalculation);
      }

      const isYearly = plan.selectedBillingInterval === "yearly";
      let priceId = plan.priceId;
      if (isYearly && plan.priceIdYearly) {
        priceId = plan.priceIdYearly;
      } else if (!isYearly && plan.priceIdMonthly) {
        priceId = plan.priceIdMonthly;
      }

      const body: Record<string, unknown> = {
        lumenPublishableKey,
        priceId,
        planId: plan.planId,
        customerEmail,
        customerName,
        userId,
        ...(organizationId && { organizationId }),
        ...(plan.trial?.available && { startTrial: true }),
      };

      if (isBusiness) {
        body.businessName = businessName;
        body.taxId = taxId;
      }

      if (isBusiness || requireBillingDetails) {
        body.customerAddress = customerAddress;
        body.customerAddressLine2 = customerAddressLine2;
        body.customerZip = customerZip;
        body.customerCity = customerCity;
        body.customerCountry = customerCountry;
        body.customerStateProvince = customerStateProvince;
      }

      if (taxCalculation) {
        body.taxData = {
          taxableAmount: taxCalculation.subtotalCents,
          totalTaxCents: taxCalculation.taxAmountCents,
          effectiveTaxRate: taxCalculation.effectiveTaxRate,
          jurisdiction: taxCalculation.jurisdiction,
          calculationMethod: taxCalculation.calculationMethod,
          taxLineItems: taxCalculation.taxLineItems,
        };
      }

      const resp = await fetch(`${apiBaseUrl}/public/payment-init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      let data: any = null;
      try {
        data = await resp.json();
      } catch {
        setIntegrationError(`Unexpected response (${resp.status})`);
        onPaymentError?.(`Unexpected response (${resp.status})`);
        setEmailSubmitting(false);
        return;
      }

      if (!resp.ok) {
        setIntegrationError(
          getErrorMessage(data) || `Request failed (${resp.status})`
        );
        setEmailSubmitting(false);
        return;
      }

      if (data.message && data.subscription_id && !data.clientSecret) {
        onPaymentSuccess?.();
        setEmailSubmitting(false);
        return;
      }

      if (!data.stripePublishableKey || !data.clientSecret || !data.intentId) {
        setIntegrationError(
          getErrorMessage(data) || "Failed to initialize payment"
        );
        setEmailSubmitting(false);
        return;
      }

      setClientSecret(data.clientSecret);
      setIntentId(data.intentId);
      setIntentType(data.intentType);
      setStripePromise(loadStripe(data.stripePublishableKey));
      setShowPaymentForm(true);
    } catch (err) {
      console.error(err);
      setIntegrationError(
        getErrorMessage(err) ||
          "Failed to initialize payment. Please try again."
      );
    } finally {
      setEmailSubmitting(false);
    }
  };

  const handleCheckoutAttempt = () => setCheckoutFormErrorMessage(null);

  useEffect(() => {
    if (!isOpen || !showPaymentForm || !intentId) return;
    const es = new EventSource(`${apiBaseUrl}/public/events/${intentId}`);
    es.addEventListener("stripe_event", (ev) => {
      try {
        const evt = JSON.parse((ev as MessageEvent).data);
        if (evt.type === "payment_intent.succeeded") {
          onPaymentSuccess?.(evt.data.object.id);
          es.close();
        } else if (evt.type === "payment_intent.payment_failed") {
          const msg =
            evt.data.object.last_payment_error?.message || "Payment failed";
          setCheckoutFormErrorMessage(msg);
          onPaymentError?.(msg);
        } else if (evt.type === "setup_intent.succeeded") {
          onPaymentSuccess?.();
          es.close();
        } else if (evt.type === "setup_intent.setup_failed") {
          const msg =
            evt.data.object.last_setup_error?.message || "Setup failed";
          setCheckoutFormErrorMessage(msg);
          onPaymentError?.(msg);
        }
      } catch (e) {
        console.error("Failed to parse SSE event", e);
      }
    });
    es.onerror = (e) => {
      console.error("SSE error", e);
      setCheckoutFormErrorMessage("Network error. Please retry.");
      onPaymentError?.("Network error during payment processing.");
      es.close();
    };
    return () => es.close();
  }, [
    isOpen,
    showPaymentForm,
    intentId,
    apiBaseUrl,
    onPaymentSuccess,
    onPaymentError,
  ]);

  if (!isOpen) return null;

  if (!showPaymentForm) {
    return (
      <Overlay>
        <Card className="w-full max-w-lg max-h-[90vh] flex flex-col relative">
          <CardHeader className="flex-shrink-0">
            {onClose && (
              <CloseButton onClick={onClose} aria-label="Close modal">
                ×
              </CloseButton>
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
            {emailSubmitting ? (
              <div className="flex items-center justify-center min-h-[200px]">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
              </div>
            ) : (
              <form onSubmit={handleEmailSubmit} className="space-y-4">
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
                    onCheckedChange={(checked: boolean) =>
                      setIsBusiness(checked)
                    }
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
                {(isBusiness || requireBillingDetails) && (
                  <>
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
                            (state) => state.value === customerStateProvince
                          );
                          if (isUSState) {
                            setCustomerStateProvince("");
                          }
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
                        onChange={(e) =>
                          setCustomerStateProvince(e.target.value)
                        }
                      />
                    )}
                  </>
                )}
                {integrationError && (
                  <Alert variant="destructive">
                    <AlertDescription>{integrationError}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" className="w-full">
                  {plan?.trial?.available
                    ? "Start Free Trial"
                    : (plan?.selectedPrice ??
                          plan?.priceMonthly ??
                          plan?.price ??
                          0) === 0
                      ? "Start free subscription"
                      : "Continue to payment"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </Overlay>
    );
  }

  if (!stripePromise || !clientSecret) {
    return (
      <Overlay>
        <Card className="w-full max-w-lg max-h-[90vh] flex flex-col relative">
          <CardHeader className="flex-shrink-0">
            {onClose && (
              <CloseButton onClick={onClose} aria-label="Close modal">
                ×
              </CloseButton>
            )}
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto flex items-center justify-center">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
          </CardContent>
        </Card>
      </Overlay>
    );
  }

  return (
    <Overlay>
      <Elements stripe={stripePromise} options={{ clientSecret }}>
        <CheckoutForm
          onClose={onClose}
          plan={plan!}
          clientSecret={clientSecret}
          userEmail={customerEmail}
          apiUrl={`${apiBaseUrl}/public/payment-init`}
          onPaymentSuccess={onPaymentSuccess}
          onPaymentError={onPaymentError}
          intentType={intentType}
          taxData={taxData}
          initialError={checkoutFormErrorMessage}
          onAttemptSubmit={handleCheckoutAttempt}
        />
      </Elements>
    </Overlay>
  );
};

interface CheckoutFormProps {
  onClose?: () => void;
  plan: Plan;
  clientSecret: string;
  userEmail?: string;
  apiUrl: string;
  onPaymentSuccess?: (paymentIntentId?: string) => void;
  onPaymentError?: (error?: string) => void;
  intentType: string | null;
  taxData?: TaxCalculationResult["taxCalculation"] | null;
  initialError?: string | null;
  onAttemptSubmit?: () => void;
}

function CheckoutForm({
  onClose,
  plan,
  clientSecret,
  onPaymentError,
  intentType,
  taxData,
  initialError,
  onAttemptSubmit,
  apiUrl: _apiUrl,
  userEmail: _userEmail,
}: CheckoutFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [cardError, setCardError] = useState<string | null>(
    initialError || null
  );
  const [processing, setProcessing] = useState(false);
  // Suppress unused variable warnings for props not currently used
  void _apiUrl;
  void _userEmail;
  const isSetupIntent =
    intentType === "setup_intent" || clientSecret?.startsWith("seti_");

  useEffect(() => {
    if (initialError) {
      setCardError(initialError);
      setProcessing(false);
    }
  }, [initialError]);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!stripe || !elements) return;
    setCardError(null);
    onAttemptSubmit?.();
    setProcessing(true);
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        const errorMessage =
          getErrorMessage(submitError) || "Form submission failed";
        setCardError(errorMessage);
        setProcessing(false);
        onPaymentError?.(errorMessage);
        return;
      }
      let confirmPromise;
      if (intentType === "payment_intent") {
        confirmPromise = stripe.confirmPayment({
          elements,
          clientSecret,
          confirmParams: { return_url: window.location.href.split("?")[0] },
          redirect: "if_required",
        });
      } else if (intentType === "setup_intent") {
        confirmPromise = stripe.confirmSetup({
          elements,
          clientSecret,
          confirmParams: { return_url: window.location.href.split("?")[0] },
          redirect: "if_required",
        });
      } else {
        setCardError("Invalid intent type.");
        setProcessing(false);
        onPaymentError?.("Invalid intent type.");
        return;
      }

      const result = await confirmPromise;
      if (result.error) {
        const errorMessage =
          getErrorMessage(result.error) || "An error occurred";
        setCardError(errorMessage);
        setProcessing(false);
        onPaymentError?.(errorMessage);
      }
    } catch (err) {
      console.error(err);
      const errorMessage = getErrorMessage(err) || "Unexpected error";
      setCardError(errorMessage);
      setProcessing(false);
      onPaymentError?.(errorMessage);
    }
  };

  return (
    <Card className="w-full max-w-lg max-h-[90vh] flex flex-col relative">
      <CardHeader className="flex-shrink-0">
        {onClose && (
          <CloseButton onClick={onClose} aria-label="Close modal">
            ×
          </CloseButton>
        )}
        <CardTitle>
          {plan.trial?.available
            ? `Start Free Trial - ${plan.title}`
            : plan.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto">
        {/* Price breakdown */}
        <div className="mb-4">
          <div className="flex justify-between text-base mb-1">
            <span>Subtotal</span>
            <span>
              {plan.currency ? currencySymbol(plan.currency) : "€"}
              {isSetupIntent
                ? "0.00"
                : (() => {
                    const unit =
                      plan.selectedBillingInterval === "yearly" &&
                      plan.selectedPrice
                        ? plan.selectedPrice
                        : ((plan.priceMonthly || plan.price) ?? 0);
                    const seatMultiplier = plan.interval?.includes("per seat")
                      ? Math.max(1, plan.minSeats || 1)
                      : 1;
                    return (unit * seatMultiplier).toFixed(2);
                  })()}
            </span>
          </div>

          {taxData &&
            taxData.taxAmountCents > 0 &&
            taxData.jurisdiction !== "payment_flow" &&
            !isSetupIntent && (
              <div className="flex justify-between text-base mb-1">
                <span>Tax ({taxData.jurisdiction})</span>
                <span>
                  {plan.currency ? currencySymbol(plan.currency) : "€"}
                  {(taxData.taxAmountCents / 100).toFixed(2)}
                </span>
              </div>
            )}

          <div className="flex justify-between font-bold text-lg border-t pt-2">
            <span>Total due now</span>
            <span>
              {plan.currency ? currencySymbol(plan.currency) : "€"}
              {isSetupIntent
                ? "0.00"
                : taxData
                  ? (taxData.totalAmountCents / 100).toFixed(2)
                  : (() => {
                      const unit =
                        plan.selectedBillingInterval === "yearly" &&
                        plan.selectedPrice
                          ? plan.selectedPrice
                          : ((plan.priceMonthly || plan.price) ?? 0);
                      const seatMultiplier = plan.interval?.includes("per seat")
                        ? Math.max(1, plan.minSeats || 1)
                        : 1;
                      return (unit * seatMultiplier).toFixed(2);
                    })()}
            </span>
          </div>
        </div>

        {isSetupIntent && (
          <Alert className="mb-4 bg-blue-50 border-blue-200">
            <AlertDescription className="text-blue-900">
              You won&apos;t be charged today. Your payment method will be
              stored. Future charges will be{" "}
              {plan.currency ? currencySymbol(plan.currency) : "€"}
              {(() => {
                const amount =
                  plan.selectedBillingInterval === "yearly" && plan.priceYearly
                    ? plan.priceYearly
                    : (plan.priceMonthly ?? plan.price);
                return amount?.toFixed(2);
              })()}{" "}
              {(() => {
                const seatSuffix = plan.interval?.includes("per seat")
                  ? " per seat"
                  : "";
                const period =
                  plan.selectedBillingInterval === "yearly" ? "year" : "month";
                return `per ${period}${seatSuffix} + taxes`;
              })()}
              .
            </AlertDescription>
          </Alert>
        )}
        <p className="text-muted-foreground mb-4">{plan.description}</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <PaymentElement id="payment-element" />
          <Button type="submit" disabled={processing} className="w-full mt-2">
            {processing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isSetupIntent ? (
              "Confirm payment method"
            ) : (
              "Pay now"
            )}
          </Button>
          {cardError && (
            <Alert variant="destructive">
              <AlertDescription>{cardError}</AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
