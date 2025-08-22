import React, { useState, ReactElement, useEffect } from "react";
import {
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import {
  loadStripe,
  PaymentIntent,
  SetupIntent,
  Stripe,
} from "@stripe/stripe-js";
import styled, { keyframes, css } from "styled-components";
import { Elements } from "@stripe/react-stripe-js";
import { Plan } from "./types";
import { currencySymbol } from "../lib/utils";

// Shadcn/ui component imports - now local
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/card";
import { Input as ShadInput } from "./ui/input"; // Using local input
import { Checkbox } from "./ui/checkbox"; // Using local checkbox
import { Label } from "./ui/label"; // Using local label
import { Alert, AlertDescription } from "./ui/alert"; // AlertTitle removed if not used
import { CloseButton } from "./ui/close-button"; // Import the new CloseButton
import { SearchableSelect } from "./ui/searchable-select";
import { customerCountries, usStates } from "./utils/countries";

const validateEmail = (email: string) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Utility function to safely extract error messages from unknown error shapes
const getErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const errorObj = error as Record<string, unknown>;
    if (typeof errorObj.error === "string") return errorObj.error;
    if (typeof errorObj.message === "string") return errorObj.message;
    if (typeof errorObj.details === "string") return errorObj.details;
    try {
      return JSON.stringify(errorObj);
    } catch {
      return "Unknown error occurred";
    }
  }
  return "Unknown error occurred";
};
/**
 * Props for the PaymentModal component
 *
 * @interface PaymentModalProps
 */
export interface PaymentModalProps {
  /** Controls whether the payment modal is visible */
  isOpen: boolean;

  /** Your Lumen publishable key for authentication */
  lumenPublishableKey: string;

  /** The plan object containing pricing information */
  plan: Plan | null;

  /** Pre-populated email address (optional) */
  userEmail?: string;

  /** Unique identifier for the user on your app (required) */
  userId: string;

  /** API endpoint URL (defaults to "https://api.getlumen.dev/v1") */
  apiBaseUrl?: string;

  /** Callback when modal is closed */
  onClose?: () => void;

  /** Callback when payment succeeds */
  onPaymentSuccess?: (paymentIntentId?: string) => void;

  /** Callback when payment fails */
  onPaymentError?: (error?: string) => void;

  /**
   * If true, billing details (address, city, etc.) are always required
   * regardless of whether the user is buying as a business
   *
   * When false, billing details are only required if the user
   * selects the "I'm buying as a business" option
   */
  requireBillingDetails?: boolean;
}

// Add new interface for tax calculation
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

export const PaymentModal = function App({
  isOpen,
  lumenPublishableKey,
  plan,
  userEmail,
  userId,
  onClose,
  onPaymentSuccess,
  onPaymentError,
  requireBillingDetails = false,
  apiBaseUrl = "https://api.getlumen.dev/v1",
}: PaymentModalProps) {
  const [stripePromise, setStripePromise] =
    useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [intentType, setIntentType] = useState<string | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [customerEmail, setCustomerEmail] = useState<string>(userEmail || "");
  const [customerName, setCustomerName] = useState<string>("");
  const [businessName, setBusinessName] = useState<string>("");
  const [customerAddress, setCustomerAddress] = useState<string>("");
  const [customerAddressLine2, setCustomerAddressLine2] = useState<string>("");
  const [customerZip, setcustomerZip] = useState<string>("");
  const [customerCity, setCustomerCity] = useState<string>("");
  const [customerCountry, setCustomerCountry] = useState<string>("");
  const [customerStateProvince, setCustomerStateProvince] =
    useState<string>("");
  const [taxId, setTaxId] = useState<string>("");
  const [isBusiness, setIsBusiness] = useState<boolean>(false);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [emailSubmitting, setEmailSubmitting] = useState(false);

  // State for tax calculation result
  const [taxData, setTaxData] = useState<
    TaxCalculationResult["taxCalculation"] | null
  >(null);

  // New state for checkout form errors (from SSE or other sources)
  const [checkoutFormErrorMessage, setCheckoutFormErrorMessage] = useState<
    string | null
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
      // Determine the correct price based on billing interval
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

      // Convert to cents
      subtotalCents = subtotalCents * 100;

      // Apply minimum seat multiplier for seat-based plans so tax is computed on correct amount
      const seatMultiplier = plan.interval?.includes("per seat")
        ? Math.max(1, plan.minSeats || 1)
        : 1;
      subtotalCents = subtotalCents * seatMultiplier;

      const response = await fetch(`${apiBaseUrl}/public/calculate-tax`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
        } catch {
          // Non-JSON body
        }
        throw new Error(errorMessage);
      }

      const result: TaxCalculationResult = await response.json();
      console.log("Tax calculation result:", result);
      return result.taxCalculation;
    } catch (error) {
      console.error("Error calculating taxes:", error);
      // Return null on error to continue with payment without taxes
      return null;
    }
  };

  // Reset payment state only when billing interval changes (monthly/yearly toggle)
  useEffect(() => {
    if (plan && showPaymentForm) {
      // Reset all payment-related state when billing interval changes
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

    // Check required fields based on business toggle and requireBillingDetails
    const requiredFieldsError = [];

    if (!customerName) requiredFieldsError.push("full name");
    if (!userId) {
      requiredFieldsError.push("user ID");
    }

    if (isBusiness) {
      if (!taxId) requiredFieldsError.push("tax ID");
      if (!businessName) requiredFieldsError.push("business name");
    }

    if (isBusiness || requireBillingDetails) {
      if (!customerAddress) requiredFieldsError.push("address");
      if (!customerZip) requiredFieldsError.push("ZIP code");
      if (!customerCity) requiredFieldsError.push("city");
      if (!customerCountry) requiredFieldsError.push("country");
      if (customerCountry === "US" && !customerStateProvince) {
        requiredFieldsError.push("state");
      }
    }

    if (requiredFieldsError.length > 0) {
      setIntegrationError(
        `Please fill in all required fields: ${requiredFieldsError.join(", ")}`
      );
      return;
    }

    setEmailSubmitting(true);
    try {
      if (!plan) {
        setIntegrationError("No plan selected");
        return;
      }

      // Step 1: Calculate taxes if we have address information
      let taxCalculation: TaxCalculationResult["taxCalculation"] | null = null;

      const willStartTrial = !!plan.trial?.available;
      if (
        !willStartTrial &&
        customerCountry &&
        (isBusiness || requireBillingDetails)
      ) {
        console.log("Calculating taxes before payment initialization...");
        taxCalculation = await calculateTaxesForSubmission(
          plan,
          customerCountry,
          customerStateProvince,
          isBusiness ? taxId : undefined,
          isBusiness ? businessName : undefined
        );

        if (taxCalculation) {
          console.log("Tax calculation successful:", {
            subtotal: taxCalculation.subtotalCents,
            tax: taxCalculation.taxAmountCents,
            total: taxCalculation.totalAmountCents,
            jurisdiction: taxCalculation.jurisdiction,
          });
          // Store tax data for potential UI display
          setTaxData(taxCalculation);
        }
      }

      // Step 2: Determine the correct price based on billing interval
      const isYearlyBilling = plan.selectedBillingInterval === "yearly";

      // Determine the correct price ID based on billing interval
      let selectedPriceId = plan.priceId; // Default fallback
      if (isYearlyBilling && plan.priceIdYearly) {
        selectedPriceId = plan.priceIdYearly;
      } else if (!isYearlyBilling && plan.priceIdMonthly) {
        selectedPriceId = plan.priceIdMonthly;
      }

      // Step 3: Build request body with tax information
      const requestBody: Record<string, unknown> = {
        lumenPublishableKey,
        priceId: selectedPriceId,
        planId: plan.planId,
        customerEmail,
        customerName,
        userId,
        ...(plan.trial?.available && { startTrial: true }),
      };

      // Include tax data if available
      if (taxCalculation) {
        requestBody.taxData = {
          taxableAmount: taxCalculation.subtotalCents,
          totalTaxCents: taxCalculation.taxAmountCents,
          effectiveTaxRate: taxCalculation.effectiveTaxRate,
          jurisdiction: taxCalculation.jurisdiction,
          calculationMethod: taxCalculation.calculationMethod,
          taxLineItems: taxCalculation.taxLineItems,
        };
      }

      // Only include business-related fields if buying as a business
      if (isBusiness) {
        requestBody.businessName = businessName;
        requestBody.taxId = taxId;
      }

      // Only include address fields if required
      if (isBusiness || requireBillingDetails) {
        requestBody.customerAddress = customerAddress;
        requestBody.customerAddressLine2 = customerAddressLine2;
        requestBody.customerZip = customerZip;
        requestBody.customerCity = customerCity;
        requestBody.customerCountry = customerCountry;
        requestBody.customerStateProvince = customerStateProvince;
      }

      // Step 4: Initialize payment with tax-inclusive amount
      const response = await fetch(`${apiBaseUrl}/public/payment-init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      // Robust handling for non-JSON responses
      let data: any = null;
      try {
        data = await response.json();
      } catch {
        setIntegrationError(`Unexpected response (${response.status})`);
        onPaymentError?.(`Unexpected response (${response.status})`);
        setEmailSubmitting(false);
        return;
      }

      if (!response.ok) {
        const message =
          getErrorMessage(data) || `Request failed (${response.status})`;
        setIntegrationError(message);
        onPaymentError?.(message);
        setEmailSubmitting(false);
        return;
      }

      // Free or immediate subscription flow (no Stripe client secret)
      if (data.message && data.subscription_id && !data.clientSecret) {
        onPaymentSuccess?.(undefined);
        setEmailSubmitting(false);
        return;
      }

      if (!data.stripePublishableKey || !data.clientSecret || !data.intentId) {
        const msg = getErrorMessage(data) || "Failed to initialize payment";
        setIntegrationError(msg);
        onPaymentError?.(msg);
        setEmailSubmitting(false);
        return;
      }

      setClientSecret(data.clientSecret);
      setIntentId(data.intentId);
      setIntentType(data.intentType);
      setStripePromise(loadStripe(data.stripePublishableKey));
      setShowPaymentForm(true);
    } catch (error) {
      console.error("Error initializing payment:", error);
      setIntegrationError(
        getErrorMessage(error) ||
          "Failed to initialize payment. Please try again."
      );
      onPaymentError?.(
        getErrorMessage(error) ||
          "Failed to initialize payment. Please try again."
      );
    } finally {
      setEmailSubmitting(false);
    }
  };

  // Handler for when a new payment attempt is made in the checkout form
  const handleCheckoutAttempt = () => {
    // Clear any previous checkout form errors when a new attempt is made
    setCheckoutFormErrorMessage(null);
  };

  // useEffect for Server-Sent Events
  useEffect(() => {
    if (!isOpen || !showPaymentForm || !intentId) {
      return;
    }

    const sseUrl = `${apiBaseUrl}/public/events/${intentId}`;
    console.log(`Attempting to connect to SSE: ${sseUrl}`);
    const eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      console.log(
        `SSE connection established for intentId: ${intentId} at ${sseUrl}`
      );
    };

    eventSource.addEventListener("stripe_event", (event) => {
      console.log("Received stripe_event via SSE:", event.data);
      try {
        const eventData = JSON.parse(event.data);
        if (eventData.type === "payment_intent.succeeded") {
          console.log("Payment succeeded via SSE:", eventData.data.object.id);
          // Clear any error messages on success
          setCheckoutFormErrorMessage(null);
          onPaymentSuccess?.(eventData.data.object.id);
          eventSource.close(); // Close connection on success
        } else if (eventData.type === "payment_intent.payment_failed") {
          const errorMessage =
            eventData.data.object.last_payment_error?.message ||
            "Payment failed";
          console.error("Payment failed via SSE:", errorMessage);
          // Set error message but DON'T close the connection to allow retries
          setCheckoutFormErrorMessage(errorMessage);
          onPaymentError?.(errorMessage);
          // Note: Not closing eventSource here to allow for retries
        } else if (eventData.type === "setup_intent.succeeded") {
          console.log(
            "SetupIntent succeeded via SSE:",
            eventData.data.object.id
          );
          // Clear any error messages on success
          setCheckoutFormErrorMessage(null);
          onPaymentSuccess?.(undefined); // No paymentIntentId for SetupIntent success via webhook alone
          eventSource.close();
        } else if (eventData.type === "setup_intent.setup_failed") {
          const errorMessage =
            eventData.data.object.last_setup_error?.message || "Setup failed";
          console.error("SetupIntent failed via SSE:", errorMessage);
          // Set error message but DON'T close the connection to allow retries
          setCheckoutFormErrorMessage(errorMessage);
          onPaymentError?.(errorMessage);
          // Note: Not closing eventSource here to allow for retries
        }
        // Potentially handle other event types like 'payment_intent.processing', etc.
      } catch (e) {
        console.error("Failed to parse SSE event data:", e);
      }
    });

    eventSource.addEventListener("ping", (event) => {
      console.log("SSE ping received:", event.data);
    });

    eventSource.onerror = (error) => {
      console.error("SSE Error:", error);
      setCheckoutFormErrorMessage("Network error. Please retry.");
      onPaymentError?.("Network error during payment processing.");
      eventSource.close(); // Close on error to prevent retries if it's a persistent issue
    };

    // Cleanup on component unmount or when dependencies change
    return () => {
      console.log(
        `Closing SSE connection for intentId: ${intentId} at ${sseUrl}`
      );
      eventSource.close();
    };
  }, [
    isOpen,
    showPaymentForm,
    intentId,
    onPaymentSuccess,
    apiBaseUrl,
    onPaymentError,
  ]);

  if (!isOpen) {
    return null;
  }

  if (!showPaymentForm) {
    return (
      <ModalOverlay>
        <Card className="w-full max-w-lg max-h-[90vh] flex flex-col">
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
              <LoadingWrapper>
                <SpinnerSvg
                  width="40"
                  height="40"
                  viewBox="0 0 40 40"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M20 4C11.163 4 4 11.163 4 20C4 28.837 11.163 36 20 36C28.837 36 36 28.837 36 20C36 11.163 28.837 4 20 4ZM20 32C12.268 32 6 25.732 6 18C6 10.268 12.268 4 20 4C27.732 4 34 10.268 34 18C34 25.732 27.732 32 20 32Z"
                    fill="#E6E6E6"
                  />
                  <path
                    d="M20 4C11.163 4 4 11.163 4 20C4 28.837 11.163 36 20 36"
                    stroke="#5469D4"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </SpinnerSvg>
              </LoadingWrapper>
            ) : (
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <ShadInput
                  type="email"
                  placeholder="Email address"
                  value={customerEmail}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setCustomerEmail(e.target.value);
                    setIntegrationError(null);
                  }}
                  required
                  aria-invalid={!!integrationError}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === "Enter") {
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <ShadInput
                  type="text"
                  placeholder="Full name"
                  value={customerName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setCustomerName(e.target.value);
                    setIntegrationError(null);
                  }}
                  required
                  aria-invalid={!!integrationError}
                />

                <div className="flex items-center space-x-2 my-4">
                  <Checkbox
                    id="business-toggle"
                    checked={isBusiness}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setIsBusiness(e.target.checked)
                    }
                  />
                  <Label htmlFor="business-toggle" className="cursor-pointer">
                    I'm buying as a business
                  </Label>
                </div>

                {isBusiness && (
                  <>
                    <ShadInput
                      type="text"
                      placeholder="Tax ID (VAT/EIN/GST/etc.)"
                      value={taxId}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setTaxId(e.target.value);
                        setIntegrationError(null);
                      }}
                      required
                      aria-invalid={!!integrationError}
                    />
                    <ShadInput
                      type="text"
                      placeholder="Business name"
                      value={businessName}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setBusinessName(e.target.value);
                        setIntegrationError(null);
                      }}
                      required
                      aria-invalid={!!integrationError}
                    />
                  </>
                )}

                {(isBusiness || requireBillingDetails) && (
                  <>
                    <ShadInput
                      type="text"
                      placeholder="Address"
                      value={customerAddress}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setCustomerAddress(e.target.value);
                        setIntegrationError(null);
                      }}
                      required
                      aria-invalid={!!integrationError}
                    />
                    <ShadInput
                      type="text"
                      placeholder="Address line 2 (Optional)"
                      value={customerAddressLine2}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setCustomerAddressLine2(e.target.value);
                        setIntegrationError(null);
                      }}
                      aria-invalid={!!integrationError}
                    />
                    <ShadInput
                      type="text"
                      placeholder="ZIP code"
                      value={customerZip}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setcustomerZip(e.target.value);
                        setIntegrationError(null);
                      }}
                      required
                      aria-invalid={!!integrationError}
                    />
                    <ShadInput
                      type="text"
                      placeholder="City"
                      value={customerCity}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setCustomerCity(e.target.value);
                        setIntegrationError(null);
                      }}
                      required
                      aria-invalid={!!integrationError}
                    />
                    <SearchableSelect
                      options={customerCountries}
                      value={customerCountry}
                      onValueChange={(value) => {
                        setCustomerCountry(value);
                        // Clear state/province when switching from US to non-US
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
                      <ShadInput
                        type="text"
                        placeholder="State/Province (optional)"
                        value={customerStateProvince}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          setCustomerStateProvince(e.target.value);
                          setIntegrationError(null);
                        }}
                        aria-invalid={!!integrationError}
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
      </ModalOverlay>
    );
  }

  if (!stripePromise || !clientSecret) {
    return (
      <ModalOverlay>
        <Card className="w-full max-w-lg max-h-[90vh] flex flex-col">
          <CardHeader className="flex-shrink-0">
            {onClose && (
              <CloseButton onClick={onClose} aria-label="Close modal">
                ×
              </CloseButton>
            )}
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto">
            <LoadingWrapper>
              <SpinnerSvg
                width="40"
                height="40"
                viewBox="0 0 40 40"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M20 4C11.163 4 4 11.163 4 20C4 28.837 11.163 36 20 36C28.837 36 36 28.837 36 20C36 11.163 28.837 4 20 4ZM20 32C12.268 32 6 25.732 6 18C6 10.268 12.268 4 20 4C27.732 4 34 10.268 34 18C34 25.732 27.732 32 20 32Z"
                  fill="#E6E6E6"
                />
                <path
                  d="M20 4C11.163 4 4 11.163 4 20C4 28.837 11.163 36 20 36"
                  stroke="#5469D4"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </SpinnerSvg>
            </LoadingWrapper>
          </CardContent>
        </Card>
      </ModalOverlay>
    );
  }

  return (
    <div className="App">
      <Elements stripe={stripePromise} options={{ clientSecret }}>
        <CheckoutForm
          onClose={onClose}
          clientSecret={clientSecret}
          userEmail={customerEmail}
          plan={plan!}
          apiUrl={apiBaseUrl + "/public/payment-init"}
          onPaymentSuccess={onPaymentSuccess}
          onPaymentError={onPaymentError}
          intentType={intentType}
          taxData={taxData}
          initialError={checkoutFormErrorMessage}
          onAttemptSubmit={handleCheckoutAttempt}
        />
      </Elements>
    </div>
  );
};

const spin = keyframes`
  to {
    transform: rotate(360deg);
  }
`;

const ModalOverlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 1000;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 4rem 1rem;
  box-sizing: border-box;
  min-height: 100vh;

  /* Create flexible spacers for proper centering */
  &::before,
  &::after {
    content: "";
    flex: 1;
    min-height: 4rem;
  }

  /* The modal content doesn't shrink and stays in the center */
  > * {
    flex-shrink: 0;
  }
`;

const PaymentForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const CardError = styled.div`
  color: #fa755a;
  text-align: left;
  font-size: 14px;
  margin-top: 12px;
`;

const ResultMessage = styled.p<{ hidden?: boolean }>`
  color: #32cd32;
  text-align: center;
  margin-top: 12px;
  display: ${(props) => (props.hidden ? "none" : "block")};
`;

const Spinner = styled.div`
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 3px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: white;
  animation: ${spin} 1s ease-in-out infinite;
`;

const SpinnerSvg = styled.svg`
  animation: ${spin} 1s linear infinite;
`;

const LoadingWrapper = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

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
  initialError?: string | null; // New prop to receive error from parent
  onAttemptSubmit?: () => void; // New prop to notify parent of submission attempt
}

function CheckoutForm({
  onClose,
  plan,
  clientSecret,
  apiUrl,
  onPaymentSuccess,
  onPaymentError,
  intentType,
  taxData,
  initialError,
  onAttemptSubmit,
}: CheckoutFormProps): ReactElement {
  const [succeeded, setSucceeded] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const stripe = useStripe();
  const elements = useElements();

  // Effect to update local error state when an error is received from parent (e.g., from SSE)
  useEffect(() => {
    if (initialError) {
      setCardError(initialError);
      setProcessing(false); // Re-enable the form for retry
    }
  }, [initialError]);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!stripe || !elements) return;

    // Clear previous errors when starting a new attempt
    setCardError(null);
    // Notify parent component of submission attempt (to clear SSE errors)
    onAttemptSubmit?.();

    setProcessing(true);

    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        setCardError(`Form submission failed: ${submitError.message}`);
        setProcessing(false);
        onPaymentError?.(submitError.message);
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
        setCardError("Invalid intent type. Cannot confirm payment/setup.");
        setProcessing(false);
        onPaymentError?.("Invalid intent type.");
        return;
      }

      const result = await confirmPromise;

      if (result.error) {
        setCardError(
          result.error.message || "An error occurred. Please try again."
        );
        setProcessing(false);
        onPaymentError?.(result.error.message);
      } else {
        // Successfully submitted to Stripe, now wait for SSE to confirm.
        // The existing SSE listener will handle 'succeeded', 'processing', and 'onPaymentSuccess'.
        if (intentType === "payment_intent") {
          console.log(
            "PaymentIntent submitted to Stripe. Waiting for webhook/SSE for final confirmation.",
            (result as { paymentIntent: PaymentIntent }).paymentIntent
          );
        } else {
          // intentType === "setup_intent"
          console.log(
            "SetupIntent submitted to Stripe. Waiting for webhook/SSE for final confirmation.",
            (result as { setupIntent: SetupIntent }).setupIntent
          );
        }
      }
    } catch (err) {
      setCardError("An unexpected error occurred. Please try again.");
      setProcessing(false);
      console.error("Payment error:", err);
      onPaymentError?.("An unexpected error occurred. Please try again.");
    }
  };

  return (
    <ModalOverlay>
      <Card className="w-full max-w-lg max-h-[90vh] flex flex-col">
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
          <div style={{ marginBottom: "1rem" }}>
            {/* Subtotal */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "1rem",
                marginBottom: "0.25rem",
              }}
            >
              <span>Subtotal</span>
              <span>
                {plan.currency ? currencySymbol(plan.currency) : "€"}
                {(function () {
                  const isSetup =
                    intentType === "setup_intent" ||
                    (clientSecret || "").startsWith("seti_");
                  if (isSetup) return "0.00";
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

            {/* Tax */}
            {taxData &&
              taxData.taxAmountCents > 0 &&
              taxData.jurisdiction !== "payment_flow" &&
              intentType !== "setup_intent" &&
              !(clientSecret || "").startsWith("seti_") && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "1rem",
                    marginBottom: "0.25rem",
                  }}
                >
                  <span>Tax ({taxData.jurisdiction})</span>
                  <span>
                    {plan.currency ? currencySymbol(plan.currency) : "€"}
                    {(taxData.taxAmountCents / 100).toFixed(2)}
                  </span>
                </div>
              )}

            {/* Total */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontWeight: "bold",
                fontSize: "1.1rem",
              }}
            >
              <span>Total due now</span>
              <span>
                {plan.currency ? currencySymbol(plan.currency) : "€"}
                {(function () {
                  const isSetup =
                    intentType === "setup_intent" ||
                    (clientSecret || "").startsWith("seti_");
                  if (isSetup) return "0.00";
                  if (taxData)
                    return (taxData.totalAmountCents / 100).toFixed(2);
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
          {(intentType === "setup_intent" ||
            (clientSecret || "").startsWith("seti_")) && (
            <Alert variant="default">
              <AlertDescription>
                You won't be charged today. Your payment method will be stored.
                Future charges will be{" "}
                {plan.currency ? currencySymbol(plan.currency) : "€"}
                {(function () {
                  const amount =
                    plan.selectedBillingInterval === "yearly" &&
                    plan.priceYearly
                      ? plan.priceYearly
                      : (plan.priceMonthly ?? plan.price);
                  return amount?.toFixed(2);
                })()}{" "}
                {(() => {
                  const seatSuffix = plan.interval?.includes("per seat")
                    ? " per seat"
                    : "";
                  const period =
                    plan.selectedBillingInterval === "yearly"
                      ? "year"
                      : "month";
                  return `per ${period}${seatSuffix} + taxes`;
                })()}
                .
              </AlertDescription>
            </Alert>
          )}
          <p style={{ color: "#666", marginBottom: "1rem" }}>
            {plan.description}
          </p>

          <PaymentForm onSubmit={handleSubmit}>
            <PaymentElement id="payment-element" />
            <Button type="submit" disabled={processing} className="w-full mt-4">
              <span>
                {processing ? (
                  <Spinner />
                ) : intentType === "setup_intent" ||
                  (clientSecret || "").startsWith("seti_") ? (
                  "Confirm payment method"
                ) : (
                  "Pay now"
                )}
              </span>
            </Button>
            {cardError && (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{cardError}</AlertDescription>
              </Alert>
            )}
            <ResultMessage hidden={!succeeded}>
              Payment succeeded! Thank you for your purchase.
            </ResultMessage>
          </PaymentForm>
        </CardContent>
      </Card>
    </ModalOverlay>
  );
}
