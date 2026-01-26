"use client";

import { useAppForm } from "@/hooks/form";
import { z } from "zod";
import { apiClient } from "@/lib/hono-client";
import { plansInsertSchema } from "@lumen/common/schema";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Plus, X } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { PricingTableCards } from "@/components/ui/pricing-table";
import { useStore } from "@tanstack/react-form";
import { useSession } from "@/lib/auth-client";
import { randomPlan } from "@/lib/random";
import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Feature interface
export interface FeatureData {
  featureName: string;
  slug: string;
  eventName: string;
  isUsageBased: boolean;
  usagePricePerUnit?: number;
  creditAllowanceAmount?: number;
  creditAllowanceRenewal?: "none" | "monthly" | "yearly";
  hasCreditAllowance?: boolean;
  // Trial-specific credit allowance
  trialCreditAllowance?: number;
  // Top-up configuration
  enableTopups?: boolean;
  topupPricePerCreditCents?: number;
  topupMinQuantity?: number;
  topupMaxQuantity?: number;
  topupExpiryBehavior?: "billing_cycle" | "custom_days" | "never";
  topupCustomExpiryDays?: number;
  // New fields for existing features
  isExisting?: boolean;
  existingFeatureId?: string;
  readOnly?: boolean;
}

// Types for the preview
interface PreviewFeature {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  featureType: "boolean" | "number" | "string";
  featureValue: boolean | number | string;
}

interface PricingComponent {
  type: "fixed" | "per_unit" | "usage";
  label?: string;
  amount_cents?: number;
  unit_cost_cents?: number;
  component_id: string;
  component_name: string;
  recurrence_rule?: string;
  bill_immediately?: boolean;
  unit_label?: string;
  [key: string]: unknown;
}

interface PricingTablePlan {
  title: string;
  description: string;
  price: number;
  priceMonthly: number;
  priceYearly?: number | undefined;
  interval: string;
  currency: string;
  features: { text: string }[];
  buttonText: string;
  buttonOutline?: boolean;
  isPopular?: boolean;
  popularText?: string;
  pricingData?: { components: PricingComponent[] };
  planId: string;
  priceId?: string;
  isEnterprisePlan?: boolean;
  minSeats?: number;
  // Trial information
  trial?: {
    available: boolean;
    days: number;
    trialPlanId: string;
  };
}

const generateSlugFromName = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
};

const formatCurrency = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);

const handleAddFeature = (field: {
  pushValue: (value: FeatureData) => void;
}) => {
  field.pushValue({
    featureName: "",
    slug: "",
    eventName: "",
    isUsageBased: false,
    usagePricePerUnit: undefined,
    hasCreditAllowance: false,
    creditAllowanceAmount: 0,
    creditAllowanceRenewal: "monthly",
    trialCreditAllowance: 0,
    // Top-up defaults
    enableTopups: false,
    topupPricePerCreditCents: undefined,
    topupMinQuantity: 1,
    topupMaxQuantity: undefined,
    topupExpiryBehavior: "billing_cycle",
    topupCustomExpiryDays: undefined,
  });
};

export default function CreatePlanPage() {
  const [hasYearlyPrice, setHasYearlyPrice] = useState(false);
  const [isEnterprisePlan, setIsEnterprisePlan] = useState(false);
  const [isSeatBased, setIsSeatBased] = useState(false);
  // Controls whether a seat-based plan enforces a minimum-seats requirement
  const [requireMinSeats, setRequireMinSeats] = useState(false);
  const [hasFreeTrial, setHasFreeTrial] = useState(false);
  const [existingFeatures, setExistingFeatures] = useState<PreviewFeature[]>(
    []
  );
  const router = useRouter();
  const { data: session } = useSession();

  // Get merchant's default currency from session, fallback to USD
  const defaultCurrency = session?.merchant?.defaultCurrency || "USD";

  // Fetch existing features for preview
  useEffect(() => {
    const fetchExistingFeatures = async () => {
      try {
        const response = await apiClient.features.$get();
        const data = await response.json();
        if ("features" in data) {
          setExistingFeatures(data.features);
        }
      } catch (error) {
        console.error("Error fetching existing features:", error);
      }
    };
    fetchExistingFeatures();
  }, []);

  const form = useAppForm({
    defaultValues: {
      planName: "",
      planDescription: "",
      currency: defaultCurrency,
      monthlyPrice: 0,
      yearlyPrice: 0,
      minSeats: 1,
      billImmediately: true, // Default for fixed pricing
      features: [] as FeatureData[],
      showInPricingTable: true,
      isEnterprisePlan: false,
      isSeatBased: false,
      enterpriseButtonText: "Contact us",
      enterpriseRedirectUrl: "https://cal.com/your_user_link",
      // Trial configuration
      hasFreeTrial: false,
      trialDays: 7,
    },
    onSubmit: async ({ value }) => {
      try {
        console.log(
          "Plan creation - value.features:",
          JSON.stringify(value.features, null, 2)
        );

        // Create the plan with all associated data in a single API call
        const planResponse = await apiClient.plans.$post({
          json: {
            planName: value.planName,
            planDescription: value.planDescription,
            commitMessage: `Created plan: ${value.planName}`,
            // Include new features to be created
            ...(value.features.length > 0 && {
              newFeatures: value.features,
            }),
            // Include pricing information
            currency: value.currency,
            ...(!value.isEnterprisePlan && {
              monthlyPrice: value.monthlyPrice,
              ...(hasYearlyPrice && {
                yearlyPrice: value.yearlyPrice,
              }),
              hasYearlyPrice,
            }),
            showInPricingTable: value.showInPricingTable,
            // Enterprise plan fields
            isEnterprisePlan: value.isEnterprisePlan,
            ...(value.isEnterprisePlan && {
              enterpriseButtonText: value.enterpriseButtonText,
              enterpriseRedirectUrl: value.enterpriseRedirectUrl,
            }),
            // Seat-based pricing
            isSeatBased: value.isSeatBased,
            ...(value.isSeatBased && {
              minSeats: value.minSeats,
            }),
            // Billing timing
            billImmediately: value.billImmediately,
            // Trial configuration
            ...(value.hasFreeTrial && {
              trial: {
                enabled: true,
                days: value.trialDays,
                creditOverrides: value.features
                  .filter(
                    (f: FeatureData) =>
                      f.isUsageBased &&
                      f.trialCreditAllowance != null &&
                      f.trialCreditAllowance > 0
                  )
                  .map((f: FeatureData) => ({
                    featureSlug: f.slug,
                    allowance: f.trialCreditAllowance!,
                  })),
              },
            }),
          },
        });

        const planData = await planResponse.json();
        if ("error" in planData) {
          toast.error(planData.error);
          throw new Error(planData.error);
        }

        const plan = planData.plans[0];
        toast.success("Plan created successfully");
        router.push(`/plans/${plan.id}`);
      } catch (error) {
        console.error("Error creating plan:", error);
        if (error instanceof Error) {
          toast.error(error.message || "Failed to create plan");
        }
        throw error;
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = plansInsertSchema.safeParse(value);
        const errors: Record<string, string> = {};

        if (!result.success) {
          result.error.issues.forEach((issue: z.ZodIssue) => {
            errors[issue.path[0]] = issue.message;
          });
        }

        // Validate yearly price for paid plans when yearly pricing is enabled
        if (
          !value.isEnterprisePlan &&
          hasYearlyPrice &&
          value.monthlyPrice > 0 &&
          value.yearlyPrice === 0
        ) {
          errors.yearlyPrice =
            "Yearly price is required when yearly pricing is enabled";
        }

        // Validate seat-based pricing - allow $0 per seat for free plans
        if (
          value.isSeatBased &&
          (value.monthlyPrice === undefined || value.monthlyPrice < 0)
        ) {
          errors.monthlyPrice =
            "Price per seat must be specified (can be $0 for free plans)";
        }

        // Validate minimum seats for seat-based pricing
        if (
          value.isSeatBased &&
          value.billImmediately &&
          (value.minSeats == null || value.minSeats < 1)
        ) {
          errors.minSeats =
            "Minimum seats must be at least 1 when billing at the start of the cycle";
        }

        // Validate enterprise plan fields
        if (value.isEnterprisePlan) {
          if (!value.enterpriseButtonText) {
            errors.enterpriseButtonText =
              "Button text is required for enterprise plans";
          }
          if (!value.enterpriseRedirectUrl) {
            errors.enterpriseRedirectUrl =
              "Redirect URL is required for enterprise plans";
          }
        }

        // Validate trial fields
        if (value.hasFreeTrial) {
          if (!value.trialDays || value.trialDays < 1) {
            errors.trialDays = "Trial days must be at least 1";
          }
          if (value.trialDays > 365) {
            errors.trialDays = "Trial days cannot exceed 365";
          }
        }

        // Return errors if any exist
        if (Object.keys(errors).length > 0) {
          return { fields: errors };
        }

        return undefined;
      },
    },
  });

  // Keep currency in sync with session's merchant default currency
  useEffect(() => {
    const currency = session?.merchant?.defaultCurrency || "USD";
    form.setFieldValue("currency", currency);
  }, [session?.merchant?.defaultCurrency, form]);

  // Watch form values using useStore for reactive preview
  const formValues = useStore(form.store, (state) => state.values);

  // Generate preview data reactively using useMemo
  const previewData = useMemo(() => {
    // Get new features from form
    const newFeatures = formValues.features || [];

    // Combine all features for preview
    const allFeatures = newFeatures.map((f) => {
      let text = f.featureName;
      if (
        f.hasCreditAllowance &&
        f.creditAllowanceAmount &&
        f.creditAllowanceAmount > 0
      ) {
        if (f.creditAllowanceRenewal && f.creditAllowanceRenewal !== "none") {
          text += ` (${f.creditAllowanceAmount} ${f.creditAllowanceRenewal === "monthly" ? "per month" : "per year"})`;
        }
      }

      // Add trial credit allowance info when trial is enabled
      if (
        hasFreeTrial &&
        f.isUsageBased &&
        f.trialCreditAllowance &&
        f.trialCreditAllowance > 0
      ) {
        text += ` • Trial: ${f.trialCreditAllowance} during trial period`;
      }

      return { text };
    });

    // Show monthly plan in preview (keep simple for now)
    // Build pricing components for preview
    const pricingComponents: PricingComponent[] = [];

    // Fixed monthly component if price > 0
    if (formValues.monthlyPrice > 0) {
      pricingComponents.push({
        type: "fixed",
        label: `${formValues.currency.toUpperCase()}${(formValues.monthlyPrice / 100).toFixed(2)} per month`,
        amount_cents: formValues.monthlyPrice,
        component_id: "preview_fixed_monthly",
        component_name: "monthly",
        recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
        bill_immediately: formValues.billImmediately,
      });
    }

    // Yearly price as separate component if enabled
    if (hasYearlyPrice && formValues.yearlyPrice > 0) {
      pricingComponents.push({
        type: "fixed",
        label: `${formValues.currency.toUpperCase()}${(formValues.yearlyPrice / 100).toFixed(2)} per month (billed yearly)`,
        amount_cents: formValues.yearlyPrice,
        component_id: "preview_fixed_yearly",
        component_name: "yearly",
        recurrence_rule: "RRULE:FREQ=YEARLY;INTERVAL=1",
        bill_immediately: formValues.billImmediately,
      });
    }

    // Usage components for usage-based features with per-unit pricing
    newFeatures.forEach((f) => {
      if (f.isUsageBased && f.usagePricePerUnit && f.usagePricePerUnit > 0) {
        pricingComponents.push({
          type: "usage",
          label: `${f.featureName} usage`,
          unit_cost_cents: f.usagePricePerUnit,
          component_id: `preview_usage_${f.slug}`,
          component_name: `usage_${f.slug}`,
          unit_label: f.slug,
          recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1",
          bill_immediately: false,
        });
      }
    });

    const previewPlan: PricingTablePlan = {
      title: formValues.planName || "Your Plan",
      description: formValues.planDescription,
      price: formValues.monthlyPrice / 100,
      priceMonthly: formValues.monthlyPrice / 100,
      priceYearly: hasYearlyPrice
        ? (formValues.yearlyPrice * 12) / 100
        : undefined,
      interval: formValues.isSeatBased ? "month per seat" : "month",
      currency: formValues.currency.toLowerCase(),
      ...(formValues.isSeatBased && { minSeats: formValues.minSeats }),
      features: allFeatures,
      buttonText: formValues.isEnterprisePlan
        ? formValues.enterpriseButtonText
        : "Get Started",
      planId: "preview-plan",
      isEnterprisePlan: formValues.isEnterprisePlan,
      pricingData: { components: pricingComponents },
      // Trial information
      trial: hasFreeTrial
        ? {
            available: true,
            days: formValues.trialDays,
            trialPlanId: "preview-trial-plan",
          }
        : undefined,
    };

    return {
      plans: [previewPlan],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formValues, hasYearlyPrice, isSeatBased, hasFreeTrial]);

  const handleNavigateBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleGenerateMockData = useCallback(() => {
    const mockPlan = randomPlan();
    form.setFieldValue("planName", mockPlan.planName);
    form.setFieldValue("planDescription", mockPlan.planDescription);
    form.setFieldValue("monthlyPrice", mockPlan.monthlyPrice);
    form.setFieldValue("yearlyPrice", mockPlan.yearlyPrice);

    // Add trial credit allowances to mock features
    const featuresWithTrialAllowances = mockPlan.features.map(
      (feature: FeatureData) => ({
        ...feature,
        trialCreditAllowance: feature.isUsageBased
          ? Math.floor(Math.random() * 50) + 10
          : 0,
      })
    );

    form.setFieldValue("features", featuresWithTrialAllowances);
    form.setFieldValue("isSeatBased", false);
    form.setFieldValue("minSeats", 1);
    form.setFieldValue("billImmediately", true);
    form.setFieldValue("hasFreeTrial", true);
    form.setFieldValue("trialDays", 14);
    // Enable yearly pricing since we're setting a yearly price
    setHasYearlyPrice(true);
    setIsSeatBased(false);
    setHasFreeTrial(true);
  }, [form]);

  // Handle adding existing features to the form
  const handleExistingFeatureToggle = useCallback(
    (feature: PreviewFeature) => {
      const currentFeatures = form.getFieldValue("features") || [];
      const existingIndex = currentFeatures.findIndex(
        (f: FeatureData) => f.existingFeatureId === feature.id
      );

      if (existingIndex >= 0) {
        // Remove existing feature from form
        const newFeatures = currentFeatures.filter(
          (_: FeatureData, index: number) => index !== existingIndex
        );
        form.setFieldValue("features", newFeatures);
      } else {
        // Add existing feature to form as read-only
        const newFeature: FeatureData = {
          featureName: feature.displayName,
          slug: feature.slug, // Use proper slug instead of feature ID
          eventName: feature.featureType === "number" ? feature.slug : "", // Use proper slug instead of feature ID
          isUsageBased: feature.featureType === "number",
          isExisting: true,
          existingFeatureId: feature.id,
          readOnly: true,
          hasCreditAllowance: feature.featureType === "number",
          creditAllowanceAmount: 0,
          creditAllowanceRenewal: "monthly",
          trialCreditAllowance: 0,
          // Top-up defaults
          enableTopups: false,
          topupPricePerCreditCents: undefined,
          topupMinQuantity: 1,
          topupMaxQuantity: undefined,
          topupExpiryBehavior: "billing_cycle",
          topupCustomExpiryDays: undefined,
        };
        form.setFieldValue("features", [...currentFeatures, newFeature]);
      }
    },
    [form]
  );

  // Get selected existing feature IDs for display
  const selectedExistingFeatureIds = useMemo(() => {
    const currentFeatures = formValues.features || [];
    return currentFeatures
      .filter((f: FeatureData) => f.isExisting && f.existingFeatureId)
      .map((f: FeatureData) => f.existingFeatureId!);
  }, [formValues.features]);

  // Enforce minimum-seat requirement when pre-pay is selected
  useEffect(() => {
    if (isSeatBased && formValues.billImmediately) {
      if (!requireMinSeats) {
        setRequireMinSeats(true);
      }
      if ((form.getFieldValue("minSeats") || 0) < 1) {
        form.setFieldValue("minSeats", 1);
      }
    }
  }, [isSeatBased, formValues.billImmediately, requireMinSeats, form]);

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

  return (
    <div className="container mx-auto py-8">
      <Button className="mb-2" variant="outline" onClick={handleNavigateBack}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
        <kbd className="ml-2 inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
          ESC
        </kbd>
      </Button>
      <div className="flex items-center gap-4 mb-8">
        <h1 className="text-2xl font-bold">Create New Plan</h1>
        <Button variant="outline" onClick={handleGenerateMockData}>
          Generate mock data
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Form Section */}
        <div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
            className="space-y-6"
          >
            <form.AppField
              name="planName"
              children={(field) => (
                <field.TextField label="Plan Name" autoFocus />
              )}
            />
            <form.AppField
              name="planDescription"
              children={(field) => (
                <field.TextField label="Plan Description" isOptional />
              )}
            />

            <div className="space-y-4">
              <div className="flex items-center space-x-2">
                <Switch
                  checked={isEnterprisePlan}
                  onCheckedChange={(checked) => {
                    setIsEnterprisePlan(checked);
                    form.setFieldValue("isEnterprisePlan", checked);
                    // Reset pricing fields when switching to enterprise
                    if (checked) {
                      form.setFieldValue("monthlyPrice", 0);
                      form.setFieldValue("yearlyPrice", 0);
                      form.setFieldValue("isSeatBased", false);
                      form.setFieldValue("hasFreeTrial", false);
                      form.setFieldValue("trialDays", 7);
                      setHasYearlyPrice(false);
                      setIsSeatBased(false);
                      setHasFreeTrial(false);
                    }
                  }}
                />
                <Label className="text-sm">
                  Make Enterprise plan (Custom text in button and Redirect URL)
                </Label>
              </div>

              {!isEnterprisePlan && (
                <div className="flex items-center space-x-2">
                  <Switch
                    checked={isSeatBased}
                    onCheckedChange={(checked) => {
                      setIsSeatBased(checked);
                      form.setFieldValue("isSeatBased", checked);

                      // When enabling seat-based pricing start in post-pay mode with no min-seat requirement
                      if (checked) {
                        setRequireMinSeats(false);
                        form.setFieldValue("minSeats", 0);
                        form.setFieldValue("billImmediately", false);
                      } else {
                        // Revert related state when switching back to fixed pricing
                        setRequireMinSeats(false);
                        form.setFieldValue("minSeats", 1);
                        form.setFieldValue("billImmediately", true);
                      }
                    }}
                  />
                  <Label className="text-sm">Seat-based pricing</Label>
                </div>
              )}

              {!isEnterprisePlan && (
                <div className="space-y-4">
                  <div className="flex items-center space-x-2">
                    <Switch
                      checked={hasFreeTrial}
                      onCheckedChange={(checked) => {
                        setHasFreeTrial(checked);
                        form.setFieldValue("hasFreeTrial", checked);
                        // Reset trial days to default when disabling
                        if (!checked) {
                          form.setFieldValue("trialDays", 7);
                        }
                      }}
                    />
                    <Label className="text-sm">Add free trial</Label>
                  </div>

                  {hasFreeTrial && (
                    <div className="space-y-4 border rounded-lg p-4 bg-blue-50 border-blue-200">
                      <div className="flex items-start space-x-3">
                        <div className="flex-shrink-0">
                          <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                            <span className="text-white text-xs font-bold">
                              ℹ
                            </span>
                          </div>
                        </div>
                        <div className="flex-1">
                          <h3 className="text-sm font-medium text-blue-900">
                            Free Trial Configuration
                          </h3>
                          <p className="text-sm text-blue-700 mt-1">
                            Trial plans include the same features as the main
                            plan, but with custom credit allowances for
                            usage-based features. After hitting usage limits,
                            customers cannot use the feature further until they
                            upgrade to the paid plan.
                          </p>
                        </div>
                      </div>

                      <form.AppField name="trialDays">
                        {(field) => (
                          <field.NumberField
                            label="Trial duration (days)"
                            subtitle="Number of days the trial will last (1-365 days)"
                          />
                        )}
                      </form.AppField>
                    </div>
                  )}
                </div>
              )}

              {!isEnterprisePlan && (
                <div className="space-y-4">
                  <Label className="text-base font-medium">
                    Billing Timing
                  </Label>

                  <form.AppField name="billImmediately">
                    {(field) => (
                      <div className="flex bg-gray-100 border border-gray-200 rounded-lg p-0.5 w-fit">
                        <button
                          type="button"
                          className={`px-3 py-2 text-sm font-medium rounded-md transition-all ${
                            field.state.value
                              ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                              : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                          }`}
                          onClick={() => {
                            field.handleChange(true);
                            // Pre-pay requires a minimum seat
                            if (!requireMinSeats) {
                              setRequireMinSeats(true);
                            }
                            if ((form.getFieldValue("minSeats") || 0) < 1) {
                              form.setFieldValue("minSeats", 1);
                            }
                          }}
                        >
                          {isSeatBased
                            ? "Bill at start of cycle"
                            : "Bill immediately"}
                        </button>
                        <button
                          type="button"
                          className={`px-3 py-2 text-sm font-medium rounded-md transition-all ${
                            !field.state.value
                              ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                              : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                          }`}
                          onClick={() => {
                            field.handleChange(false);
                            // When switching to post-pay, default to no minimum seats
                            if (requireMinSeats) {
                              setRequireMinSeats(false);
                              form.setFieldValue("minSeats", 0);
                            }
                          }}
                        >
                          {isSeatBased
                            ? "Bill at end of cycle"
                            : "Bill at end of cycle"}
                        </button>
                      </div>
                    )}
                  </form.AppField>

                  {/* Immediate billing info callout */}
                  {isSeatBased &&
                    formValues.billImmediately &&
                    (formValues.minSeats || 0) > 0 && (
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <div className="flex items-start space-x-3">
                          <div className="flex-shrink-0">
                            <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                              <span className="text-white text-xs font-bold">
                                ⚡
                              </span>
                            </div>
                          </div>
                          <div className="flex-1">
                            <h3 className="text-sm font-medium text-blue-900">
                              Immediate Overage Billing Enabled
                            </h3>
                            <p className="text-sm text-blue-700 mt-1">
                              When users add seats beyond their minimum
                              allocation, they will be charged immediately for
                              the additional seats, prorated for the remaining
                              billing period.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                </div>
              )}

              {!isEnterprisePlan ? (
                <>
                  <form.AppField
                    name="monthlyPrice"
                    children={(field) => (
                      <field.Number2DecimalsField
                        label={
                          isSeatBased
                            ? "Price per month per seat"
                            : "Monthly Price"
                        }
                      />
                    )}
                  />

                  {isSeatBased && (
                    <>
                      {/* Toggle to enable/disable minimum seat requirement */}
                      <div className="flex items-center space-x-2">
                        <Switch
                          checked={requireMinSeats}
                          disabled={formValues.billImmediately}
                          onCheckedChange={(checked) => {
                            setRequireMinSeats(checked);
                            if (checked) {
                              if ((form.getFieldValue("minSeats") || 0) < 1) {
                                form.setFieldValue("minSeats", 1);
                              }
                            } else {
                              form.setFieldValue("minSeats", 0);
                            }
                          }}
                        />
                        <Label className="text-sm">Require minimum seats</Label>
                      </div>

                      {/* Only show numeric input when the requirement is enabled */}
                      {requireMinSeats && (
                        <form.AppField name="minSeats">
                          {(field) => (
                            <field.NumberField
                              label="Minimum seats"
                              subtitle={
                                formValues.billImmediately &&
                                (formValues.minSeats || 0) > 0
                                  ? "⚡ Overage billing: Users will be charged immediately when they exceed their seat limit"
                                  : undefined
                              }
                            />
                          )}
                        </form.AppField>
                      )}
                    </>
                  )}

                  <div className="space-y-4">
                    <div className="flex items-center space-x-2">
                      <Switch
                        checked={hasYearlyPrice}
                        onCheckedChange={setHasYearlyPrice}
                      />
                      <Label className="text-sm">
                        {isSeatBased
                          ? "Add yearly per-seat price"
                          : "Add yearly price"}
                      </Label>
                    </div>

                    {hasYearlyPrice && (
                      <form.AppField
                        name="yearlyPrice"
                        children={(field) => {
                          const yearlyTotal = (field.state.value || 0) * 12;
                          const formattedYearly = yearlyTotal > 0
                            ? formatCurrency(yearlyTotal / 100, defaultCurrency)
                            : null;
                          return (
                            <field.Number2DecimalsField
                              label={
                                isSeatBased
                                  ? "Price per seat per year (per month)"
                                  : "Yearly Price (per month)"
                              }
                              subtitle={
                                formattedYearly
                                  ? isSeatBased
                                    ? `${formattedYearly}/year per seat`
                                    : `${formattedYearly}/year`
                                  : isSeatBased
                                    ? "This will be multiplied by 12 and billed yearly per seat"
                                    : "This will be multiplied by 12 and billed yearly"
                              }
                            />
                          );
                        }}
                      />
                    )}
                  </div>
                </>
              ) : (
                <>
                  <form.AppField
                    name="enterpriseButtonText"
                    children={(field) => (
                      <field.TextField label="Button text" />
                    )}
                  />

                  <form.AppField
                    name="enterpriseRedirectUrl"
                    children={(field) => (
                      <field.TextField label="Redirect to this link when clicking:" />
                    )}
                  />
                </>
              )}
            </div>

            {/* Features Section */}
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <Label className="text-base font-medium">Features</Label>
              </div>

              {/* Existing Features Selector */}
              <div className="space-y-2">
                <Label className="text-base font-medium">
                  Existing Features
                </Label>
                <p className="text-sm text-muted-foreground">
                  Click on features to add them to this plan and configure
                  credit allowances
                </p>
                {existingFeatures.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No features found. Create your first feature by adding it
                    below.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {existingFeatures.map((feature) => {
                      const isSelected = selectedExistingFeatureIds.includes(
                        feature.id
                      );
                      return (
                        <Badge
                          key={feature.id}
                          variant={isSelected ? "default" : "outline"}
                          className={cn(
                            "cursor-pointer transition-all duration-200 hover:scale-105",
                            isSelected && "bg-primary text-primary-foreground",
                            !isSelected && "hover:bg-muted"
                          )}
                          onClick={() => handleExistingFeatureToggle(feature)}
                        >
                          <span className="flex items-center gap-1">
                            {isSelected ? (
                              <Check className="h-3 w-3" />
                            ) : (
                              <span className="h-3 w-3" />
                            )}
                            {feature.displayName}
                            {feature.featureType === "number" && (
                              <span className="text-xs opacity-75">
                                ({feature.featureValue} included)
                              </span>
                            )}
                          </span>
                        </Badge>
                      );
                    })}
                  </div>
                )}
                {selectedExistingFeatureIds.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {selectedExistingFeatureIds.length} feature
                    {selectedExistingFeatureIds.length !== 1 ? "s" : ""}{" "}
                    selected and added to form below
                  </p>
                )}
              </div>

              {/* New Features Section */}
              <form.AppField name="features" mode="array">
                {(field) => {
                  return (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-base font-medium">
                          Configure Features
                        </Label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleAddFeature(field)}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Add New Feature
                        </Button>
                      </div>

                      {field.state.value.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No features selected. Choose from existing features
                          above or create new ones below.
                        </p>
                      )}

                      {field.state.value.map((_, index) => (
                        <div
                          key={index}
                          className="border rounded-lg p-4 space-y-4 relative"
                        >
                          <div className="flex items-center justify-between">
                            <h3 className="text-lg font-medium">
                              {field.state.value[index]?.isExisting
                                ? "Existing "
                                : ""}
                              Feature {index + 1}
                              {field.state.value[index]?.readOnly && (
                                <span className="text-sm text-muted-foreground ml-2">
                                  (Read-only)
                                </span>
                              )}
                            </h3>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => field.removeValue(index)}
                              className="h-8 w-8 p-0"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>

                          <form.AppField
                            name={`features[${index}].featureName`}
                          >
                            {(subField) => (
                              <subField.TextField
                                label="Feature Name"
                                disabled={field.state.value[index]?.readOnly}
                                onChange={(value: string) => {
                                  subField.handleChange(value);
                                  // Auto-generate slug when feature name changes (only for new features)
                                  if (
                                    value &&
                                    !field.state.value[index]?.readOnly
                                  ) {
                                    const generatedSlug =
                                      generateSlugFromName(value);
                                    form.setFieldValue(
                                      `features[${index}].slug`,
                                      generatedSlug
                                    );
                                    form.validateField(
                                      `features[${index}].slug`,
                                      "change"
                                    );

                                    // Auto-set event name to slug if feature is usage-based
                                    const isUsageBased = form.getFieldValue(
                                      `features[${index}].isUsageBased`
                                    );
                                    if (isUsageBased) {
                                      form.setFieldValue(
                                        `features[${index}].eventName`,
                                        generatedSlug
                                      );
                                    }
                                  }
                                }}
                              />
                            )}
                          </form.AppField>

                          <form.AppField
                            name={`features[${index}].slug`}
                            validators={{
                              // Only validate slug for new features, not existing ones
                              ...(field.state.value[index]?.readOnly
                                ? {}
                                : {
                                    onChangeAsyncDebounceMs: 500,
                                    onChangeAsync: async ({
                                      value,
                                    }: {
                                      value: string;
                                    }) => {
                                      const repsonse =
                                        await apiClient.features.checkSlug.$post(
                                          {
                                            json: {
                                              slug: value,
                                            },
                                          }
                                        );
                                      const data = await repsonse.json();
                                      if ("error" in data) {
                                        return {
                                          fields: {
                                            slug: "Failed to check slug",
                                          },
                                        };
                                      } else {
                                        return data.conflict
                                          ? "Feature slug already exists. Please choose a different name."
                                          : undefined;
                                      }
                                    },
                                  }),
                            }}
                          >
                            {(subField) => (
                              <subField.TextField
                                label="Feature Slug"
                                disabled={field.state.value[index]?.readOnly}
                              />
                            )}
                          </form.AppField>

                          <form.AppField
                            name={`features[${index}].isUsageBased`}
                          >
                            {(subField) => (
                              <div className="space-y-2">
                                <Label>Feature Type</Label>
                                <div className="flex space-x-2">
                                  <Toggle
                                    pressed={!subField.state.value}
                                    disabled={
                                      field.state.value[index]?.readOnly
                                    }
                                    onPressedChange={() => {
                                      if (!field.state.value[index]?.readOnly) {
                                        subField.handleChange(false);
                                        form.setFieldValue(
                                          `features[${index}].eventName`,
                                          ""
                                        );
                                        form.setFieldValue(
                                          `features[${index}].hasCreditAllowance`,
                                          false
                                        );
                                      }
                                    }}
                                  >
                                    Boolean Feature
                                  </Toggle>
                                  <Toggle
                                    pressed={subField.state.value}
                                    disabled={
                                      field.state.value[index]?.readOnly
                                    }
                                    onPressedChange={() => {
                                      if (!field.state.value[index]?.readOnly) {
                                        subField.handleChange(true);
                                        // Auto-set eventName to slug when switching to usage-based
                                        const currentSlug = form.getFieldValue(
                                          `features[${index}].slug`
                                        );
                                        if (currentSlug) {
                                          form.setFieldValue(
                                            `features[${index}].eventName`,
                                            currentSlug
                                          );
                                        }
                                        form.setFieldValue(
                                          `features[${index}].hasCreditAllowance`,
                                          true
                                        );
                                      }
                                    }}
                                  >
                                    Usage-based Feature
                                  </Toggle>
                                </div>
                              </div>
                            )}
                          </form.AppField>

                          {/* Event Name field for usage-based features */}
                          <form.AppField
                            name={`features[${index}].isUsageBased`}
                          >
                            {(toggleField) =>
                              toggleField.state.value && (
                                <form.AppField
                                  name={`features[${index}].eventName`}
                                >
                                  {(subField) => (
                                    <subField.TextField
                                      label="Event Name"
                                      disabled={
                                        field.state.value[index]?.readOnly
                                      }
                                    />
                                  )}
                                </form.AppField>
                              )
                            }
                          </form.AppField>

                          {/* Credit Allowance Section for usage-based features */}
                          <form.AppField
                            name={`features[${index}].isUsageBased`}
                          >
                            {(toggleField) =>
                              toggleField.state.value && (
                                <form.AppField
                                  name={`features[${index}].hasCreditAllowance`}
                                >
                                  {(allowanceField) => (
                                    <div className="space-y-4">
                                      <allowanceField.SwitchField
                                        label="Add credit allowance for this feature"
                                        onChange={(checked) => {
                                          if (!checked) {
                                            form.setFieldValue(
                                              `features[${index}].creditAllowanceAmount`,
                                              0
                                            );
                                          }
                                        }}
                                      />

                                      {allowanceField.state.value && (
                                        <div className="space-y-4 border rounded-lg p-4 bg-white">
                                          <form.AppField
                                            name={`features[${index}].creditAllowanceAmount`}
                                          >
                                            {(amountField) => (
                                              <amountField.NumberField
                                                label="Credit Allowance Amount"
                                                subtitle="If they exceed this amount, they will be charged the usage price per unit (or feature access will be revoked if no price per unit is set)."
                                              />
                                            )}
                                          </form.AppField>

                                          <form.AppField
                                            name={`features[${index}].creditAllowanceRenewal`}
                                          >
                                            {(renewalField) => (
                                              <div className="space-y-3">
                                                <Label className="text-sm font-medium">
                                                  Renewal Frequency
                                                </Label>
                                                <div className="flex bg-gray-100 border border-gray-200 rounded-lg p-0.5 mt-2 w-fit">
                                                  <button
                                                    type="button"
                                                    className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${
                                                      renewalField.state
                                                        .value === "none"
                                                        ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                    }`}
                                                    onClick={() => {
                                                      renewalField.handleChange(
                                                        "none"
                                                      );
                                                    }}
                                                  >
                                                    One-time
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${
                                                      renewalField.state
                                                        .value === "monthly"
                                                        ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                    }`}
                                                    onClick={() => {
                                                      renewalField.handleChange(
                                                        "monthly"
                                                      );
                                                    }}
                                                  >
                                                    Monthly
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${
                                                      renewalField.state
                                                        .value === "yearly"
                                                        ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                    }`}
                                                    onClick={() => {
                                                      renewalField.handleChange(
                                                        "yearly"
                                                      );
                                                    }}
                                                  >
                                                    Yearly
                                                  </button>
                                                </div>
                                              </div>
                                            )}
                                          </form.AppField>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </form.AppField>
                              )
                            }
                          </form.AppField>

                          {/* Overage Handling - mutually exclusive choice between top-ups and usage pricing */}
                          <form.AppField
                            name={`features[${index}].hasCreditAllowance`}
                          >
                            {(creditField) =>
                              creditField.state.value && (
                                <div className="space-y-3">
                                  <Label className="text-sm font-medium">
                                    When credits run out
                                  </Label>
                                  <p className="text-xs text-muted-foreground -mt-1">
                                    Choose how to handle usage after the credit allowance is exhausted
                                  </p>

                                  {/* Option selector */}
                                  <div className="grid grid-cols-1 gap-3">
                                    {/* Option 1: Block access (no overage) */}
                                    <form.AppField name={`features[${index}].enableTopups`}>
                                      {(topupField) => (
                                        <form.AppField name={`features[${index}].usagePricePerUnit`}>
                                          {(usageField) => {
                                            const hasTopups = topupField.state.value;
                                            const hasUsagePrice = usageField.state.value && usageField.state.value > 0;
                                            const isBlockAccess = !hasTopups && !hasUsagePrice;

                                            return (
                                              <>
                                                {/* Block Access Option */}
                                                <button
                                                  type="button"
                                                  onClick={() => {
                                                    topupField.handleChange(false);
                                                    usageField.handleChange(undefined);
                                                  }}
                                                  className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                                                    isBlockAccess
                                                      ? "border-blue-500 bg-blue-50"
                                                      : "border-gray-200 hover:border-gray-300 bg-white"
                                                  }`}
                                                >
                                                  <div className="flex items-start gap-3">
                                                    <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex items-center justify-center ${
                                                      isBlockAccess ? "border-blue-500" : "border-gray-300"
                                                    }`}>
                                                      {isBlockAccess && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                                                    </div>
                                                    <div className="flex-1">
                                                      <div className="font-medium text-sm">Block access</div>
                                                      <div className="text-xs text-muted-foreground mt-0.5">
                                                        Users cannot use more than their credit allowance
                                                      </div>
                                                    </div>
                                                  </div>
                                                </button>

                                                {/* On-Demand Top-ups Option */}
                                                <button
                                                  type="button"
                                                  onClick={() => {
                                                    topupField.handleChange(true);
                                                    usageField.handleChange(undefined);
                                                  }}
                                                  className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                                                    hasTopups
                                                      ? "border-purple-500 bg-purple-50"
                                                      : "border-gray-200 hover:border-gray-300 bg-white"
                                                  }`}
                                                >
                                                  <div className="flex items-start gap-3">
                                                    <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex items-center justify-center ${
                                                      hasTopups ? "border-purple-500" : "border-gray-300"
                                                    }`}>
                                                      {hasTopups && <div className="w-2 h-2 rounded-full bg-purple-500" />}
                                                    </div>
                                                    <div className="flex-1">
                                                      <div className="font-medium text-sm">On-demand credit top-ups</div>
                                                      <div className="text-xs text-muted-foreground mt-0.5">
                                                        Users can purchase additional credits at a set price
                                                      </div>
                                                    </div>
                                                  </div>
                                                </button>

                                                {/* Usage-Based Billing Option */}
                                                <button
                                                  type="button"
                                                  onClick={() => {
                                                    topupField.handleChange(false);
                                                    // Set a default value to indicate usage pricing is selected
                                                    if (!usageField.state.value) {
                                                      usageField.handleChange(0);
                                                    }
                                                  }}
                                                  className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                                                    hasUsagePrice || (usageField.state.value === 0 && !hasTopups && !isBlockAccess)
                                                      ? "border-orange-500 bg-orange-50"
                                                      : "border-gray-200 hover:border-gray-300 bg-white"
                                                  }`}
                                                >
                                                  <div className="flex items-start gap-3">
                                                    <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex items-center justify-center ${
                                                      hasUsagePrice || (usageField.state.value === 0 && !hasTopups && !isBlockAccess) ? "border-orange-500" : "border-gray-300"
                                                    }`}>
                                                      {(hasUsagePrice || (usageField.state.value === 0 && !hasTopups && !isBlockAccess)) && <div className="w-2 h-2 rounded-full bg-orange-500" />}
                                                    </div>
                                                    <div className="flex-1">
                                                      <div className="font-medium text-sm">Usage-based billing (overage)</div>
                                                      <div className="text-xs text-muted-foreground mt-0.5">
                                                        Automatically charge per unit for usage beyond the allowance
                                                      </div>
                                                    </div>
                                                  </div>
                                                </button>
                                              </>
                                            );
                                          }}
                                        </form.AppField>
                                      )}
                                    </form.AppField>
                                  </div>

                                  {/* Top-up Configuration Panel */}
                                  <form.AppField name={`features[${index}].enableTopups`}>
                                    {(topupField) =>
                                      topupField.state.value && (
                                        <div className="space-y-4 border rounded-lg p-4 bg-purple-50 border-purple-200 mt-2">
                                          <div className="flex items-start space-x-3">
                                            <div className="flex-shrink-0">
                                              <div className="w-5 h-5 bg-purple-500 rounded-full flex items-center justify-center">
                                                <span className="text-white text-xs font-bold">
                                                  +
                                                </span>
                                              </div>
                                            </div>
                                            <div className="flex-1">
                                              <h4 className="text-sm font-medium text-purple-900">
                                                Credit Top-up Configuration
                                              </h4>
                                              <p className="text-sm text-purple-700 mt-1">
                                                Configure how customers can
                                                purchase additional credits when
                                                they run out.
                                              </p>
                                            </div>
                                          </div>

                                          <form.AppField
                                            name={`features[${index}].topupPricePerCreditCents`}
                                          >
                                            {(subField) => (
                                              <subField.Number2DecimalsField
                                                label="Price per credit"
                                                subtitle={`${formatCurrency(
                                                  (subField.state.value || 0) /
                                                    100,
                                                  defaultCurrency
                                                )} per credit`}
                                              />
                                            )}
                                          </form.AppField>

                                          <div className="grid grid-cols-2 gap-4">
                                            <form.AppField
                                              name={`features[${index}].topupMinQuantity`}
                                            >
                                              {(subField) => (
                                                <subField.NumberField
                                                  label="Minimum purchase"
                                                  subtitle="Minimum credits per purchase"
                                                />
                                              )}
                                            </form.AppField>

                                            <form.AppField
                                              name={`features[${index}].topupMaxQuantity`}
                                            >
                                              {(subField) => (
                                                <subField.NumberField
                                                  label="Maximum purchase (optional)"
                                                  subtitle="Maximum credits per purchase"
                                                />
                                              )}
                                            </form.AppField>
                                          </div>

                                          <form.AppField
                                            name={`features[${index}].topupExpiryBehavior`}
                                          >
                                            {(expiryField) => (
                                              <div className="space-y-3">
                                                <Label className="text-sm font-medium">
                                                  When do purchased credits
                                                  expire?
                                                </Label>
                                                <div className="flex bg-gray-100 border border-gray-200 rounded-lg p-0.5 mt-2 w-fit">
                                                  <button
                                                    type="button"
                                                    className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${
                                                      expiryField.state
                                                        .value ===
                                                      "billing_cycle"
                                                        ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                    }`}
                                                    onClick={() => {
                                                      expiryField.handleChange(
                                                        "billing_cycle"
                                                      );
                                                    }}
                                                  >
                                                    Billing cycle
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${
                                                      expiryField.state
                                                        .value === "custom_days"
                                                        ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                    }`}
                                                    onClick={() => {
                                                      expiryField.handleChange(
                                                        "custom_days"
                                                      );
                                                    }}
                                                  >
                                                    Custom days
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${
                                                      expiryField.state
                                                        .value === "never"
                                                        ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                    }`}
                                                    onClick={() => {
                                                      expiryField.handleChange(
                                                        "never"
                                                      );
                                                    }}
                                                  >
                                                    Never
                                                  </button>
                                                </div>
                                              </div>
                                            )}
                                          </form.AppField>

                                          <form.AppField
                                            name={`features[${index}].topupExpiryBehavior`}
                                          >
                                            {(expiryBehavior) =>
                                              expiryBehavior.state.value ===
                                                "custom_days" && (
                                                <form.AppField
                                                  name={`features[${index}].topupCustomExpiryDays`}
                                                >
                                                  {(subField) => (
                                                    <subField.NumberField
                                                      label="Days until expiry"
                                                      subtitle="How many days until purchased credits expire"
                                                    />
                                                  )}
                                                </form.AppField>
                                              )
                                            }
                                          </form.AppField>
                                        </div>
                                      )
                                    }
                                  </form.AppField>

                                  {/* Usage Price Configuration Panel */}
                                  <form.AppField name={`features[${index}].usagePricePerUnit`}>
                                    {(usageField) => {
                                      const hasUsagePrice = usageField.state.value !== undefined;
                                      const hasTopups = form.getFieldValue("features")?.[index]?.enableTopups;

                                      return hasUsagePrice && !hasTopups ? (
                                        <div className="space-y-4 border rounded-lg p-4 bg-orange-50 border-orange-200 mt-2">
                                          <div className="flex items-start space-x-3">
                                            <div className="flex-shrink-0">
                                              <div className="w-5 h-5 bg-orange-500 rounded-full flex items-center justify-center">
                                                <span className="text-white text-xs font-bold">
                                                  $
                                                </span>
                                              </div>
                                            </div>
                                            <div className="flex-1">
                                              <h4 className="text-sm font-medium text-orange-900">
                                                Usage-Based Overage Pricing
                                              </h4>
                                              <p className="text-sm text-orange-700 mt-1">
                                                Set the price charged per unit when users exceed their credit allowance.
                                              </p>
                                            </div>
                                          </div>

                                          <usageField.Number2DecimalsField
                                            label="Price per unit"
                                            subtitle={
                                              usageField.state.value && usageField.state.value > 0
                                                ? `${formatCurrency(usageField.state.value / 100, defaultCurrency)} per unit billed monthly`
                                                : "Enter the price per unit for overage usage"
                                            }
                                          />
                                        </div>
                                      ) : null;
                                    }}
                                  </form.AppField>
                                </div>
                              )
                            }
                          </form.AppField>

                          {/* Trial Credit Allowance for usage-based features */}
                          <form.AppField
                            name={`features[${index}].isUsageBased`}
                          >
                            {(toggleField) =>
                              toggleField.state.value &&
                              hasFreeTrial && (
                                <div className="space-y-4 border rounded-lg p-4 bg-yellow-50 border-yellow-200">
                                  <div className="flex items-start space-x-3">
                                    <div className="flex-shrink-0">
                                      <div className="w-5 h-5 bg-yellow-500 rounded-full flex items-center justify-center">
                                        <span className="text-white text-xs font-bold">
                                          ⏱
                                        </span>
                                      </div>
                                    </div>
                                    <div className="flex-1">
                                      <h4 className="text-sm font-medium text-yellow-900">
                                        Trial Credit Allowance
                                      </h4>
                                      <p className="text-sm text-yellow-700 mt-1">
                                        Set how much of this feature users can
                                        use during the trial period. After
                                        hitting this limit, they cannot use the
                                        feature further until upgrading to the
                                        paid plan.
                                      </p>
                                    </div>
                                  </div>

                                  <form.AppField
                                    name={`features[${index}].trialCreditAllowance`}
                                  >
                                    {(subField) => (
                                      <subField.NumberField
                                        label="Trial credit allowance"
                                        subtitle={`How many ${field.state.value[index]?.featureName || "units"} users can use during the trial`}
                                      />
                                    )}
                                  </form.AppField>
                                </div>
                              )
                            }
                          </form.AppField>

                        </div>
                      ))}

                      {field.state.value.length > 0 && (
                        <div className="flex justify-center pt-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleAddFeature(field)}
                            className="w-full max-w-xs"
                          >
                            <Plus className="mr-2 h-4 w-4" />
                            Add Another Feature
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                }}
              </form.AppField>
            </div>
            <form.AppField name="showInPricingTable">
              {(field) => (
                <field.SwitchField label="Show plan in Pricing Table" />
              )}
            </form.AppField>
            <form.AppForm>
              <form.SubmitButtonWithShortcut label="Create Plan" />
            </form.AppForm>
          </form>
        </div>

        {/* Preview Section */}
        <div className="lg:sticky lg:top-8 lg:h-fit">
          <h2 className="text-xl font-semibold mb-4">Live Preview</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Default settings, style can be customized in Pricing Table settings
          </p>
          <div className="border rounded-lg p-4 bg-gray-50">
            <PricingTableCards {...previewData} />
          </div>
        </div>
      </div>
    </div>
  );
}
