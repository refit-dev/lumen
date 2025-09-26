"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/hono-client";
import { Button } from "@/components/ui/button";
import { Loader2, Check, XCircle, Circle } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import type {
  PlanWithFeaturesAndPrices,
  CustomerFromApi,
  MerchantFromApi,
} from "@lumen/common/schema";

type StepStatus = "idle" | "running" | "success" | "error";

interface StepItem {
  id: "merchant" | "plans" | "customers" | "subscriptions";
  title: string;
  status: StepStatus;
  error?: string;
}

// Placeholder bodies – fill these with actual payloads later
const planCreateBodies: Record<string, unknown>[] = [
  {
    planName: "Basic Plan",
    planDescription: "Default plan assigned to all users",
    commitMessage: "Created plan: Basic Plan",
    newFeatures: [
      {
        featureName: "Chat messages",
        slug: "chat-messages",
        eventName: "chat-messages",
        isUsageBased: true,
        hasCreditAllowance: true,
        creditAllowanceAmount: 100,
        creditAllowanceRenewal: "monthly",
        trialCreditAllowance: 0,
      },
    ],
    currency: "USD",
    monthlyPrice: 0,
    hasYearlyPrice: false,
    showInPricingTable: true,
    isEnterprisePlan: false,
    isSeatBased: false,
    billImmediately: true,
  },
  {
    planName: "Premium",
    planDescription: "Free users should convert to this",
    commitMessage: "Created plan: Premium",
    newFeatures: [
      {
        featureName: "Chat messages",
        slug: "chat-messages",
        eventName: "chat-messages",
        isUsageBased: true,
        isExisting: true,
        existingFeatureId: "to_be_backfilled_manually",
        readOnly: true,
        hasCreditAllowance: true,
        creditAllowanceAmount: 500,
        creditAllowanceRenewal: "monthly",
        trialCreditAllowance: 0,
      },
      {
        featureName: "Premium models",
        slug: "premium-models",
        eventName: "",
        isUsageBased: false,
        hasCreditAllowance: false,
        creditAllowanceAmount: 0,
        creditAllowanceRenewal: "monthly",
        trialCreditAllowance: 0,
      },
      {
        featureName: "24/7 Support",
        slug: "247-support",
        eventName: "",
        isUsageBased: false,
        hasCreditAllowance: false,
        creditAllowanceAmount: 0,
        creditAllowanceRenewal: "monthly",
        trialCreditAllowance: 0,
      },
    ],
    currency: "USD",
    monthlyPrice: 1000,
    yearlyPrice: 800,
    hasYearlyPrice: true,
    showInPricingTable: true,
    isEnterprisePlan: false,
    isSeatBased: false,
    billImmediately: true,
  },
  {
    planName: "Enterprise",
    planDescription: "Custom plans for big companies",
    commitMessage: "Created plan: Enterprise",
    newFeatures: [
      {
        featureName: "Dedicated support",
        slug: "dedicated-support",
        eventName: "",
        isUsageBased: false,
        hasCreditAllowance: false,
        creditAllowanceAmount: 0,
        creditAllowanceRenewal: "monthly",
        trialCreditAllowance: 0,
      },
      {
        featureName: "SSO",
        slug: "sso",
        eventName: "",
        isUsageBased: false,
        hasCreditAllowance: false,
        creditAllowanceAmount: 0,
        creditAllowanceRenewal: "monthly",
        trialCreditAllowance: 0,
      },
      {
        featureName: "Higer rate limits",
        slug: "higer-rate-limits",
        eventName: "",
        isUsageBased: false,
        hasCreditAllowance: false,
        creditAllowanceAmount: 0,
        creditAllowanceRenewal: "monthly",
        trialCreditAllowance: 0,
      },
    ],
    currency: "USD",
    showInPricingTable: true,
    isEnterprisePlan: true,
    enterpriseButtonText: "Contact us",
    enterpriseRedirectUrl: "https://cal.com/ramongarate/quick-chat",
    isSeatBased: false,
    billImmediately: true,
  },
]; // free, premium, enterprise
const customerCreateBodies: {
  name: string;
  email: string;
  externalCustomerId: string;
  businessName: string;
  billingAddressLine1: string;
  billingAddressLine2: string;
  billingCity: string;
  billingCountry: string;
  billingStateProvince: string;
  billingPostalCode: string;
  taxId: string;
  taxExemptionReason: string;
  taxExempt: boolean;
  taxCalculationMethod: string;
}[] = [
  {
    name: "Michael McBasic",
    email: "michael.mcbasic@getlumen.dev",
    externalCustomerId: "",
    businessName: "",
    billingAddressLine1: "668 Washington Blvd",
    billingAddressLine2: "",
    billingCity: "Los Angeles",
    billingCountry: "US",
    billingStateProvince: "CA",
    billingPostalCode: "99445",
    taxId: "",
    taxExemptionReason: "",
    taxExempt: false,
    taxCalculationMethod: "default",
  },
  {
    name: "Sarah McPremium",
    email: "sarah.mcpremium@getlumen.dev",
    externalCustomerId: "",
    businessName: "",
    billingAddressLine1: "668 Washington Blvd",
    billingAddressLine2: "",
    billingCity: "Los Angeles",
    billingCountry: "US",
    billingStateProvince: "CA",
    billingPostalCode: "99445",
    taxId: "",
    taxExemptionReason: "",
    taxExempt: false,
    taxCalculationMethod: "default",
  },
];
async function responseToError(res: Response) {
  try {
    const data = await res.clone().json();
    if (typeof data === "string") return data;
    if (data?.error) return JSON.stringify(data.error);
    return res.statusText || "Request failed";
  } catch {
    return res.statusText || "Request failed";
  }
}

export default function CreateDemoDataPage() {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [steps, setSteps] = useState<StepItem[]>([
    { id: "merchant", title: "Creating merchant...", status: "idle" },
    { id: "plans", title: "Creating plans...", status: "idle" },
    { id: "customers", title: "Creating customers...", status: "idle" },
    { id: "subscriptions", title: "Creating subscriptions...", status: "idle" },
  ]);
  const { data: session, isPending, refetch } = useSession();

  const hasError = useMemo(
    () => steps.some((s) => s.status === "error"),
    [steps]
  );

  const setStepStatus = useCallback(
    (id: StepItem["id"], status: StepStatus, error?: string) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status, error } : s))
      );
    },
    []
  );

  const resetAll = useCallback(() => {
    setCompleted(false);
    setIsRunning(false);
    setHasStarted(false);
    setSteps((prev) =>
      prev.map((s) => ({ ...s, status: "idle", error: undefined }))
    );
  }, []);

  const createMerchant = useCallback(async () => {
    if (isPending) {
      return;
    }

    const userSlug =
      session?.user?.email?.split("@")[0].replace(/[^a-zA-Z0-9]/g, "") ??
      "User";

    const merchRes = await apiClient.merchants[
      "onboarding-create-merchant"
    ].$post({
      json: {
        legalName: `Demo Company of ${userSlug}`,
        displayName: `Demo Company of ${userSlug}`,
        taxId: "TAX1234567890",
        websiteUrl: "https://getlumen.dev",
        defaultCurrency: "USD",
        addressLine1: "354 Oyster Point Blvd",
        city: "South San Francisco",
        stateProvince: "CA",
        postalCode: "94080",
        country: "US",
        isDemo: true,
      } as never,
    });
    if (!merchRes.ok) throw new Error(await responseToError(merchRes));
    const merchant = (await merchRes.json()) as MerchantFromApi;

    // 5) Configure dunning
    const dunningRes = await apiClient.merchants["dunning-config"].$post({
      json: {
        gracePeriodDays: 7,
        endOfDunningAction: "pause_subscription",
      } as never,
    });
    if (!dunningRes.ok) throw new Error(await responseToError(dunningRes));
    await dunningRes.json();

    return merchant;
  }, [isPending, session]);

  const createPlans = useCallback(async () => {
    const results: PlanWithFeaturesAndPrices[] = [];
    for (const body of planCreateBodies) {
      const res = await apiClient.plans.$post({ json: body as never });
      if (!res.ok) throw new Error(await responseToError(res));
      const data = (await res.json()) as unknown;
      let plan: PlanWithFeaturesAndPrices;
      if (
        typeof data === "object" &&
        data !== null &&
        "plans" in data &&
        Array.isArray((data as { plans?: unknown }).plans)
      ) {
        plan = (data as unknown as { plans: PlanWithFeaturesAndPrices[] })
          .plans[0];
      } else {
        plan = data as PlanWithFeaturesAndPrices;
      }
      if (body.planName === "Basic Plan") {
        const featureId = plan.features?.[0]?.id as string;
        (
          planCreateBodies[1] as unknown as {
            newFeatures: Array<{
              existingFeatureId?: string;
            }>;
          }
        ).newFeatures[0].existingFeatureId = featureId;
      }
      results.push(plan);
    }

    return results;
  }, []);

  const createCustomers = useCallback(async () => {
    const results: CustomerFromApi[] = [];
    for (const body of customerCreateBodies) {
      const res = await apiClient.customers.$post({ json: body as never });
      if (!res.ok) throw new Error(await responseToError(res));
      const data = (await res.json()) as unknown;
      let customer: CustomerFromApi;
      if (typeof data === "object" && data !== null && "customer" in data) {
        customer = (data as unknown as { customer: CustomerFromApi }).customer;
      } else {
        customer = data as CustomerFromApi;
      }
      results.push(customer);
    }
    return results;
  }, []);

  const createSubscriptions = useCallback(
    async (
      merchant: MerchantFromApi,
      customers: CustomerFromApi[],
      plans: PlanWithFeaturesAndPrices[]
    ) => {
      const merchantId = merchant?.id || null;

      // Helper: pick a price with monthly recurrence if possible
      const selectPriceId = (
        plan: PlanWithFeaturesAndPrices
      ): string | null => {
        const prices = plan.prices || [];
        if (prices.length === 0) return null;
        // Prefer a price whose pricingData has a monthly component
        for (const p of prices) {
          const components = p.pricingData?.components;
          if (
            Array.isArray(components) &&
            components.some(
              (c) => c.recurrence_rule?.includes("FREQ=MONTHLY") === true
            )
          ) {
            return p.id;
          }
        }
        // Fallback to first
        return prices[0]?.id || null;
      };

      // Build from state if we have required entities
      const generatedBodies: Array<Record<string, unknown>> = [];

      if (merchantId && customers.length > 0 && plans.length > 0) {
        // Filter out plans that don't have valid prices
        const plansWithPrices = plans.filter(
          (plan) => selectPriceId(plan) !== null
        );

        if (plansWithPrices.length > 0) {
          for (let i = 0; i < customers.length; i++) {
            const customer = customers[i];
            const plan = plansWithPrices[i % plansWithPrices.length];
            const priceId = selectPriceId(plan);
            // We know priceId won't be null since we filtered, but keeping the check for safety
            if (!priceId) continue;
            generatedBodies.push({
              customerId: customer.id,
              planId: plan.id,
              effectivePriceId: priceId,
              triggerImmediateBilling: true,
            });
          }
        }
      }

      for (const body of generatedBodies) {
        const res = await apiClient.subscriptions.$post({
          json: body as never,
        });
        if (!res.ok) throw new Error(await responseToError(res));
        await res.json();
      }
    },
    []
  );

  const run = useCallback(async () => {
    if (isRunning) return;
    setIsRunning(true);
    setCompleted(false);
    try {
      setStepStatus("merchant", "running");
      const merchant = await createMerchant();
      setStepStatus("merchant", "success");

      setStepStatus("plans", "running");
      const plans = await createPlans();
      setStepStatus("plans", "success");

      setStepStatus("customers", "running");
      const customers = await createCustomers();
      setStepStatus("customers", "success");

      setStepStatus("subscriptions", "running");
      await createSubscriptions(merchant!, customers, plans);
      setStepStatus("subscriptions", "success");

      // Refresh session to include the new merchant data
      refetch();

      setCompleted(true);
      setTimeout(() => router.replace("/subscriptions"), 2000);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      console.error("Demo creation error:", e);

      // Find the first running step and mark it as error
      setSteps((prev) => {
        const idx = prev.findIndex((s) => s.status === "running");
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], status: "error", error: message };
        // Set any remaining idle steps back to idle (no change)
        return next;
      });

      // Stop execution completely on error - don't continue to next steps
      return;
    } finally {
      setIsRunning(false);
    }
  }, [
    createCustomers,
    createMerchant,
    createPlans,
    createSubscriptions,
    isRunning,
    refetch,
    router,
    setStepStatus,
  ]);

  // Track if we've already started to prevent infinite loops
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    // Only run once when component mounts, prevent infinite loops
    if (!hasStarted && !isRunning && !completed && !hasError && !isPending) {
      if (session?.merchant) {
        router.push("/dashboard");
        return;
      }
      setHasStarted(true);
      run();
    }
  }, [
    hasStarted,
    isRunning,
    completed,
    hasError,
    isPending,
    session?.merchant,
    router,
    run,
  ]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">
            Setting up your demo workspace
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            This will only take a moment. Please keep this tab open.
          </p>
        </div>

        <div className="space-y-3">
          {steps.map((step) => (
            <div
              key={step.id}
              className="flex items-start justify-between rounded-lg border p-4"
            >
              <div className="flex items-start gap-3">
                {step.status === "running" ? (
                  <Loader2 className="h-4 w-4 animate-spin mt-0.5" />
                ) : step.status === "success" ? (
                  <Check className="h-4 w-4 text-green-600 mt-0.5" />
                ) : step.status === "error" ? (
                  <XCircle className="h-4 w-4 text-red-600 mt-0.5" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground mt-0.5" />
                )}
                <div>
                  <div className="font-medium">{step.title}</div>
                  {step.status === "error" && step.error && (
                    <div className="text-sm text-red-600 mt-1 break-words">
                      {step.error}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {step.status === "idle" && "Pending"}
                {step.status === "running" && "In progress"}
                {step.status === "success" && "Done"}
                {step.status === "error" && "Failed"}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between">
          {!hasError && !completed && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working...
            </div>
          )}

          {completed && (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <Check className="h-4 w-4" /> All set! Redirecting to dashboard...
            </div>
          )}

          {hasError && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  resetAll();
                  run();
                }}
              >
                Retry
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
