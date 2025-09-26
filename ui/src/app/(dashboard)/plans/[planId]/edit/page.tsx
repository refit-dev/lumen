"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useAppForm } from "@/hooks/form";
import { apiClient } from "@/lib/hono-client";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Plus, X } from "lucide-react";
import { PricingTableCards } from "@/components/ui/pricing-table";
import { useStore } from "@tanstack/react-form";
import { useSession } from "@/lib/auth-client";
import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Toggle } from "@/components/ui/toggle";
import { APIPlanWithFeatures } from "../../../../../../../api/src/helpers";
import { PlanEnrollmentRules } from "@/components/dashboard/PlanEnrollmentRules";

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
  planId: string;
  priceId?: string;
  isEnterprisePlan?: boolean;
  minSeats?: number;
  pricingData?: { components: PricingComponent[] };
  // Trial information
  trial?: {
    available: boolean;
    days: number;
    trialPlanId: string;
  };
}

interface PricingComponent {
  type: "fixed" | "per_unit" | "usage";
  recurrence_rule?: string;
  amount_cents?: number;
  unit_cost_cents?: number;
  component_name?: string;
  component_id?: string;
  num_seats?: number;
  bill_immediately?: boolean;
  unit_label?: string;
  [key: string]: unknown;
}

// Helper to generate slugs from feature names
const generateSlugFromName = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
};

// Add a new (blank) feature row to the array field
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
  });
};

// NEW: Define CreditDefinition interface
interface CreditDefinition {
  featureId?: string | null;
  applicationType?: string;
  defaultAmount?: number;
  currency?: string | null;
  refillRrule?: string | null;
  refillAmount?: number | null;
  planId?: string | null;
  renewOnBilling?: boolean;
  priceId?: string | null;
  priceComponentId?: string | null;
}

export default function EditPlanPage() {
  const params = useParams();
  const planId = params.planId as string;
  const [hasYearlyPrice, setHasYearlyPrice] = useState(false);
  const [isEnterprisePlan, setIsEnterprisePlan] = useState(false);
  // Seat-based pricing state
  const [isSeatBased, setIsSeatBased] = useState(false);
  const [minSeats, setMinSeats] = useState<number | undefined>(undefined);
  // Controls whether a seat-based plan enforces a minimum-seats requirement
  const [requireMinSeats, setRequireMinSeats] = useState(false);
  const [hasFreeTrial, setHasFreeTrial] = useState(false);
  const [existingFeatures, setExistingFeatures] = useState<PreviewFeature[]>(
    []
  );
  const [isLoading, setIsLoading] = useState(true);
  const [currentPlan, setCurrentPlan] = useState<Record<
    string,
    unknown
  > | null>(null);
  const router = useRouter();
  const { data: session } = useSession();

  // Get merchant's default currency from session, fallback to USD
  const defaultCurrency = session?.merchant?.defaultCurrency || "USD";

  // Fetch existing plan data and features
  useEffect(() => {
    const fetchPlanData = async () => {
      try {
        setIsLoading(true);

        // Fetch current plan data
        const planResponse = await apiClient.plans[":id"].$get({
          param: { id: planId },
          query: { includeFeatures: "true" },
        });
        const planData = await planResponse.json();

        if ("error" in planData) {
          console.error("Failed to load plan data");
          router.push("/plans");
          return;
        }

        const plan = planData.plans[0];
        setCurrentPlan(plan);

        // Fetch trial plan information if it exists
        let trialPlan: APIPlanWithFeatures | null = null;
        const trialCreditDefinitions: Record<string, number> = {};
        try {
          // Look for a trial plan that has this plan as its parent
          const trialResponse = await apiClient.plans.$get({
            query: { includeTrials: "true", includeFeatures: "true" },
          });
          const trialData = await trialResponse.json();

          if ("plans" in trialData && Array.isArray(trialData.plans)) {
            trialPlan = (trialData.plans.find(
              (p) => p.isTrialPlan && p.trialParentPlanId === planId
            ) ?? null) as APIPlanWithFeatures | null;
            // manual typing needed because of union types - type inference is picking up the wrong part of the union

            if (trialPlan) {
              // Fetch trial credit definitions
              const trialCreditDefsRes =
                await apiClient.credits.definitions.$get({
                  query: { scope: "plan" },
                });
              const trialCreditDefsData = await trialCreditDefsRes.json();

              if (
                "definitions" in trialCreditDefsData &&
                Array.isArray(trialCreditDefsData.definitions)
              ) {
                const trialCredits = trialCreditDefsData.definitions.filter(
                  (def: any) =>
                    def.planId === trialPlan?.id &&
                    def.applicationType === "usage"
                );

                // Map trial credit allowances by feature slug
                trialCredits.forEach((def: any) => {
                  if (def.featureSlug) {
                    trialCreditDefinitions[def.featureSlug] =
                      def.defaultAmount || 0;
                  }
                });
              }
            }
          }
        } catch (err) {
          console.error("Error fetching trial plan data:", err);
        }

        // Fetch prices for the plan to pre-fill pricing fields
        const pricesResponse = await apiClient.prices.$get({
          query: { planId },
        });
        const pricesData = await pricesResponse.json();

        let monthlyPrice = 0;
        let yearlyPrice = 0;
        let hasYearly = false;
        // Detect seat-based components and track minimum seats if specified
        let seatBasedDetected = false;
        let detectedMinSeats: number | undefined;
        const usagePriceMap: Record<string, number> = {};
        const usageComponentRruleMap: Record<string, string> = {}; // Map component ID to RRULE

        if ("prices" in pricesData && Array.isArray(pricesData.prices)) {
          // Use the latest price records (they are returned newest->oldest in API)
          for (const price of pricesData.prices) {
            if (!price?.pricingData?.components) continue;
            for (const component of price.pricingData
              .components as PricingComponent[]) {
              // Handle fixed and per-unit (seat-based) components for base pricing info
              if (component.type === "per_unit") {
                seatBasedDetected = true;
                const ns = (component as { num_seats?: number }).num_seats;
                if (typeof ns === "number" && ns > 0) {
                  detectedMinSeats = ns;
                }
              }

              if (component.type === "fixed" || component.type === "per_unit") {
                if (
                  typeof component.recurrence_rule === "string" &&
                  component.recurrence_rule.includes("FREQ=MONTHLY")
                ) {
                  monthlyPrice = component.amount_cents || 0;
                }
                if (
                  typeof component.recurrence_rule === "string" &&
                  component.recurrence_rule.includes("FREQ=YEARLY")
                ) {
                  yearlyPrice = Math.round((component.amount_cents || 0) / 12);
                  hasYearly = true;
                }
              }

              if (
                component.type === "usage" &&
                typeof component.component_name === "string"
              ) {
                const slug = component.component_name.replace(/^usage_/, "");
                usagePriceMap[slug] = component.unit_cost_cents || 0;

                // Store RRULE for billing-based credit renewal frequency detection
                if (
                  component.recurrence_rule &&
                  typeof component.recurrence_rule === "string"
                ) {
                  // Map by component_id if available, otherwise by component_name
                  const componentKey =
                    component.component_id || component.component_name;
                  usageComponentRruleMap[componentKey] =
                    component.recurrence_rule;
                }
              }
            }
          }
        }

        // Update seat-based state after processing prices
        setIsSeatBased(seatBasedDetected);
        setMinSeats(detectedMinSeats);
        setRequireMinSeats((detectedMinSeats ?? 0) > 0);

        // NEW: Fetch credit definitions for this plan to pre-populate credit allowance amounts
        let creditDefMap: Record<string, CreditDefinition> = {};
        try {
          const creditDefsRes = await apiClient.credits.definitions.$get({
            query: { scope: "plan" },
          });
          const creditDefsData = await creditDefsRes.json();
          if (
            "definitions" in creditDefsData &&
            Array.isArray(creditDefsData.definitions)
          ) {
            // Filter for this plan & usage application type
            const filtered = (
              creditDefsData.definitions as CreditDefinition[]
            ).filter(
              (def) => def.planId === planId && def.applicationType === "usage"
            );
            // Dedup logic (same as details page)
            const seen = new Set<string>();
            const deduped = filtered.filter((def) => {
              const key = `${def.featureId}-${def.applicationType}-${def.defaultAmount}-${def.currency || ""}-${def.refillRrule || ""}-${def.refillAmount || ""}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            creditDefMap = deduped.reduce<Record<string, CreditDefinition>>(
              (acc, def) => {
                if (def.featureId && !acc[def.featureId]) {
                  acc[def.featureId] = def;
                }
                return acc;
              },
              {}
            );
          }
        } catch (err) {
          console.error("Error fetching credit definitions:", err);
        }

        // Basic pricing info setup
        setHasYearlyPrice(hasYearly);

        // Use safe property access with fallbacks
        const safeIsEnterprise =
          (plan as Record<string, unknown>)?.isEnterprisePlan || false;
        setIsEnterprisePlan(safeIsEnterprise as boolean);

        // Convert plan features to form format - with safe access
        const planFeatures = (plan as Record<string, unknown>)?.features || [];

        interface PlanFeatureRaw {
          id: string;
          slug: string;
          displayName: string;
          featureType?: string;
        }

        const formFeatures: FeatureData[] = (
          planFeatures as PlanFeatureRaw[]
        ).map((feature) => {
          const slug = feature.slug ?? "";
          const isUsage = feature.featureType === "number";

          // Look up existing credit definition (if any) for this feature
          const creditDef = creditDefMap[feature.id] as
            | CreditDefinition
            | undefined;
          const creditAmount = creditDef?.defaultAmount ?? 0;
          let renewal: "none" | "monthly" | "yearly" = "none";

          // Determine renewal frequency
          if (creditDef?.refillRrule) {
            // First priority: explicit RRULE on the credit definition
            if (creditDef.refillRrule.includes("FREQ=YEARLY")) {
              renewal = "yearly";
            } else if (creditDef.refillRrule.includes("FREQ=MONTHLY")) {
              renewal = "monthly";
            }
          } else if (creditDef?.renewOnBilling && creditDef?.priceComponentId) {
            // Second priority: billing-based renewal - look up the linked price component RRULE
            const linkedComponentRrule =
              usageComponentRruleMap[creditDef.priceComponentId];
            if (linkedComponentRrule) {
              if (linkedComponentRrule.includes("FREQ=YEARLY")) {
                renewal = "yearly";
              } else if (linkedComponentRrule.includes("FREQ=MONTHLY")) {
                renewal = "monthly";
              }
            } else {
              console.warn(
                `No RRULE found for component ${creditDef.priceComponentId} linked to credit definition`,
                {
                  featureId: feature.id,
                  featureSlug: slug,
                  creditDefId: creditDef.featureId,
                  priceComponentId: creditDef.priceComponentId,
                  availableComponents: Object.keys(usageComponentRruleMap),
                }
              );
            }
          }

          return {
            featureName: feature.displayName || "",
            slug,
            eventName: isUsage ? slug : "",
            isUsageBased: isUsage,
            isExisting: true,
            existingFeatureId: feature.id,
            readOnly: true,
            hasCreditAllowance: isUsage,
            usagePricePerUnit:
              isUsage && usagePriceMap[slug] ? usagePriceMap[slug] : undefined,
            creditAllowanceAmount: creditAmount,
            creditAllowanceRenewal: renewal,
            trialCreditAllowance: trialCreditDefinitions[slug] || 0,
          };
        });

        // Set form values safely with type casting
        const safePlan = plan as Record<string, unknown>;
        form.setFieldValue("planName", (safePlan?.planName as string) || "");
        form.setFieldValue(
          "planDescription",
          (safePlan?.planDescription as string) || ""
        );
        form.setFieldValue("currency", defaultCurrency);
        // Seat-based hydration
        form.setFieldValue("isSeatBased", seatBasedDetected);
        form.setFieldValue("minSeats", detectedMinSeats ?? 1);
        // Price hydration
        form.setFieldValue("monthlyPrice", monthlyPrice);
        form.setFieldValue("yearlyPrice", yearlyPrice);
        // Detect billImmediately from monthly/per_unit component if available
        let detectedBillImmediately = true;
        if ("prices" in pricesData && Array.isArray(pricesData.prices)) {
          const monthlyBase = (pricesData.prices as unknown[]).find((p: any) =>
            p.pricingData?.components?.some(
              (c: any) =>
                (c.type === "fixed" || c.type === "per_unit") &&
                c.recurrence_rule?.includes("FREQ=MONTHLY")
            )
          );
          if (monthlyBase) {
            const comp = (monthlyBase as any).pricingData.components.find(
              (c: any) => c.type === "fixed" || c.type === "per_unit"
            );
            if (comp && typeof comp.bill_immediately === "boolean") {
              detectedBillImmediately = comp.bill_immediately;
            }
          }
        }
        form.setFieldValue("billImmediately", detectedBillImmediately);
        form.setFieldValue("features", formFeatures);
        form.setFieldValue(
          "showInPricingTable",
          (safePlan?.isVisibleInPricingTable as boolean) || false
        );
        form.setFieldValue(
          "isEnterprisePlan",
          (safePlan?.isEnterprisePlan as boolean) || false
        );
        form.setFieldValue(
          "enterpriseButtonText",
          (safePlan?.buttonText as string) || "Contact us"
        );
        form.setFieldValue(
          "enterpriseRedirectUrl",
          (safePlan?.enterpriseRedirectUrl as string) || ""
        );

        // Set trial form values
        const hasTrialPlan = !!trialPlan;
        setHasFreeTrial(hasTrialPlan);
        form.setFieldValue("hasFreeTrial", hasTrialPlan);
        if (trialPlan) {
          form.setFieldValue("trialDays", trialPlan.trialDays || 7);
        }

        // Fetch all available features
        const featuresResponse = await apiClient.features.$get();
        const featuresData = await featuresResponse.json();
        if ("features" in featuresData) {
          setExistingFeatures(featuresData.features);
        }
      } catch (error) {
        console.error("Error fetching plan data:", error);
        router.push("/plans");
      } finally {
        setIsLoading(false);
      }
    };

    if (planId) {
      fetchPlanData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, router, defaultCurrency]);

  const form = useAppForm({
    defaultValues: {
      planName: "",
      planDescription: "",
      currency: defaultCurrency,
      monthlyPrice: 0,
      yearlyPrice: 0,
      features: [] as FeatureData[],
      showInPricingTable: true,
      isEnterprisePlan: false,
      isSeatBased: false,
      minSeats: 1,
      billImmediately: true,
      enterpriseButtonText: "Contact us",
      enterpriseRedirectUrl: "https://cal.com/your_user_link",
      // Trial configuration
      hasFreeTrial: false,
      trialDays: 7,
    },
    onSubmit: async ({ value }) => {
      try {
        // Call the new edit endpoint
        const editResponse = await apiClient.plans[":id"].edit.$post({
          param: { id: planId },
          json: {
            planName: value.planName,
            planDescription: value.planDescription,
            // Always send the features array – even when empty – so that the
            // API can accurately detect removed features and unlink them when
            // editing a plan in place.
            features: value.features,
            // Include pricing information
            currency: value.currency,
            ...(!value.isEnterprisePlan && {
              monthlyPrice: value.monthlyPrice,
              ...(hasYearlyPrice && {
                yearlyPrice: value.yearlyPrice,
              }),
              hasYearlyPrice,
              // Seat-based specific pricing settings
              isSeatBased: value.isSeatBased,
              minSeats: value.minSeats,
              billImmediately: value.billImmediately,
            }),
            showInPricingTable: value.showInPricingTable,
            // Enterprise plan fields
            isEnterprisePlan: value.isEnterprisePlan,
            ...(value.isEnterprisePlan && {
              enterpriseButtonText: value.enterpriseButtonText,
              enterpriseRedirectUrl: value.enterpriseRedirectUrl,
            }),
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

        const editResult = await editResponse.json();

        if ("error" in editResult) {
          throw new Error(editResult.error);
        }

        // Show success and redirect to the (potentially new) plan version with full page refresh
        const newPlanId = editResult?.plan?.id ?? planId;

        // Determine if migration is required based on API response
        const requiresMigration =
          editResult?.migrationInfo?.requiresMigration === true;

        // If migration is required, show modal after redirect
        const redirectUrl = requiresMigration
          ? `/plans/${newPlanId}?showMigration=1`
          : `/plans/${newPlanId}`;

        // Use window.location.href for full page refresh to bypass cache issues
        window.location.href = redirectUrl;
      } catch (error) {
        console.error("Error editing plan:", error);
        throw error;
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        const errors: Record<string, string> = {};

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

  // Watch form values using useStore for reactive preview
  const formValues = useStore(form.store, (state) => state.values);

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

  // Generate preview data reactively using useMemo
  const previewData = useMemo(() => {
    const newFeatures = formValues.features || [];

    const allFeatures = [
      ...newFeatures.map((f) => {
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
      }),
    ];

    // Build pricing components array for preview
    const pricingComponents: PricingComponent[] = [];

    // Fixed monthly component
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

    // Yearly price component
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

    // Usage components from features
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
      title:
        (formValues.planName as string) ||
        (currentPlan?.planName as string) ||
        "Your Plan",
      description:
        (formValues.planDescription as string) ||
        (currentPlan?.planDescription as string) ||
        "",
      price: formValues.monthlyPrice / 100,
      priceMonthly: formValues.monthlyPrice / 100,
      priceYearly: hasYearlyPrice
        ? (formValues.yearlyPrice * 12) / 100
        : undefined,
      interval: isSeatBased ? " month per seat" : "month",
      ...(minSeats ? { minSeats } : {}),
      currency: formValues.currency.toLowerCase(),
      features: allFeatures,
      pricingData: { components: pricingComponents },
      buttonText: formValues.isEnterprisePlan
        ? formValues.enterpriseButtonText
        : "Get Started",
      planId: "preview-plan",
      isEnterprisePlan: formValues.isEnterprisePlan,
      // Trial information
      trial: hasFreeTrial
        ? {
            available: true,
            days: formValues.trialDays,
            trialPlanId: "preview-trial-plan", // Placeholder, replace with actual trial plan ID
          }
        : undefined,
    };

    return {
      plans: [previewPlan],
    };
  }, [
    formValues,
    hasYearlyPrice,
    currentPlan,
    isSeatBased,
    minSeats,
    hasFreeTrial,
  ]);

  const handleNavigateBack = useCallback(() => {
    router.push(`/plans/${planId}`);
  }, [router, planId]);

  // Handle adding existing features to the form
  const handleExistingFeatureToggle = useCallback(
    (feature: PreviewFeature) => {
      const currentFeatures = form.getFieldValue("features") || [];
      const existingIndex = currentFeatures.findIndex(
        (f: FeatureData) => f.existingFeatureId === feature.id
      );

      if (existingIndex >= 0) {
        const newFeatures = currentFeatures.filter(
          (_: FeatureData, index: number) => index !== existingIndex
        );
        form.setFieldValue("features", newFeatures);
      } else {
        const newFeature: FeatureData = {
          featureName: feature.displayName,
          slug: feature.slug,
          eventName: feature.featureType === "number" ? feature.slug : "",
          isUsageBased: feature.featureType === "number",
          isExisting: true,
          existingFeatureId: feature.id,
          readOnly: true,
          hasCreditAllowance: feature.featureType === "number",
          creditAllowanceAmount: 0,
          creditAllowanceRenewal: "monthly",
          trialCreditAllowance: 0,
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

  if (isLoading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center h-64">
          <div className="text-lg">Loading plan data...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8">
      <Button className="mb-2" variant="outline" onClick={handleNavigateBack}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Plan
        <kbd className="ml-2 inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
          ESC
        </kbd>
      </Button>
      <div className="flex items-center gap-4 mb-8">
        <h1 className="text-2xl font-bold">
          Edit Plan: {currentPlan?.planName as string}
        </h1>
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
                    if (checked) {
                      form.setFieldValue("monthlyPrice", 0);
                      form.setFieldValue("yearlyPrice", 0);
                      form.setFieldValue("hasFreeTrial", false);
                      form.setFieldValue("trialDays", 7);
                      setHasYearlyPrice(false);
                      setHasFreeTrial(false);
                    }
                  }}
                />
                <Label className="text-sm">
                  Make Enterprise plan (Custom text in button and Redirect URL)
                </Label>
              </div>

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

              {!isEnterprisePlan ? (
                <>
                  {/* Seat-based toggle */}
                  <div className="flex items-center space-x-2">
                    <Switch
                      checked={isSeatBased}
                      onCheckedChange={(checked) => {
                        setIsSeatBased(checked);
                        form.setFieldValue("isSeatBased", checked);

                        if (checked) {
                          // Enable seat-based: default to post-pay with no min-seat requirement
                          setRequireMinSeats(false);
                          form.setFieldValue("minSeats", 0);
                          form.setFieldValue("billImmediately", false);
                        } else {
                          // Switch back to fixed pricing
                          setRequireMinSeats(false);
                          form.setFieldValue("minSeats", 1);
                          form.setFieldValue("billImmediately", true);
                        }
                      }}
                    />
                    <Label className="text-sm">Seat-based pricing</Label>
                  </div>

                  {/* Billing timing controls */}
                  {isSeatBased && (
                    <div className="space-y-4">
                      <Label className="text-base font-medium">
                        Billing Timing
                      </Label>
                      <form.AppField name="billImmediately">
                        {(field) => (
                          <div className="flex bg-gray-100 border border-gray-200 rounded-lg p-0.5 w-fit">
                            <button
                              type="button"
                              className={`px-3 py-2 text-sm font-medium rounded-md transition-all ${field.state.value ? "bg-white text-gray-900 shadow-sm border border-gray-200" : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"}`}
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
                              Bill at start of cycle
                            </button>
                            <button
                              type="button"
                              className={`px-3 py-2 text-sm font-medium rounded-md transition-all ${!field.state.value ? "bg-white text-gray-900 shadow-sm border border-gray-200" : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"}`}
                              onClick={() => {
                                field.handleChange(false);
                                // Switching to post-pay defaults to no min seat requirement
                                if (requireMinSeats) {
                                  setRequireMinSeats(false);
                                  form.setFieldValue("minSeats", 0);
                                }
                              }}
                            >
                              Bill at end of cycle
                            </button>
                          </div>
                        )}
                      </form.AppField>
                    </div>
                  )}
                  <form.AppField
                    name="monthlyPrice"
                    children={(field) => (
                      <field.Number2DecimalsField
                        label={
                          isSeatBased
                            ? "Price per month per seat"
                            : "Monthly Price"
                        }
                        subtitle={
                          isSeatBased
                            ? undefined
                            : "Base flat fee billed in addition to usage"
                        }
                      />
                    )}
                  />

                  <div className="space-y-4">
                    <div className="flex items-center space-x-2">
                      <Switch
                        checked={hasYearlyPrice}
                        onCheckedChange={setHasYearlyPrice}
                      />
                      <Label className="text-sm">Add yearly price</Label>
                    </div>

                    {hasYearlyPrice && (
                      <form.AppField
                        name="yearlyPrice"
                        children={(field) => (
                          <field.Number2DecimalsField
                            label={
                              isSeatBased
                                ? "Price per seat per year (per month)"
                                : "Yearly Price (per month)"
                            }
                            subtitle={
                              isSeatBased
                                ? "This will be multiplied by 12 and billed yearly per seat"
                                : "This will be multiplied by 12 and billed yearly"
                            }
                          />
                        )}
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

              {/* Minimum-seats toggle & numeric field */}
              {isSeatBased && (
                <>
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
            </div>

            {/* Enrollment Rules */}
            <div className="space-y-2">
              <PlanEnrollmentRules planId={planId} />
            </div>

            {/* Simplified Features Section for now */}
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <Label className="text-base font-medium">Features</Label>
              </div>

              <div className="space-y-2">
                <Label className="text-base font-medium">
                  Available Features
                </Label>
                <p className="text-sm text-muted-foreground">
                  Click on features to add/remove them from this plan
                </p>
                {existingFeatures.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No features found.
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
                          </span>
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <form.AppField name="showInPricingTable">
              {(field) => (
                <field.SwitchField label="Show plan in Pricing Table" />
              )}
            </form.AppField>

            {/* Configure Features (similar to create page) */}
            <form.AppField name="features" mode="array">
              {(field) => (
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
                      No features selected. Choose from available features above
                      or create new ones below.
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

                      {/* Feature Name */}
                      <form.AppField name={`features[${index}].featureName`}>
                        {(subField) => (
                          <subField.TextField
                            label="Feature Name"
                            onChange={(value: string) => {
                              subField.handleChange(value);
                              // Auto-generate slug for new features
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

                                // Auto-set event name for usage-based
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

                      {/* Slug */}
                      <form.AppField
                        name={`features[${index}].slug`}
                        validators={{
                          // Only validate slug for new features, not existing ones
                          ...(field.state.value[index]?.isExisting
                            ? {}
                            : {
                                onChangeAsyncDebounceMs: 500,
                                onChangeAsync: async ({
                                  value,
                                }: {
                                  value: string;
                                }) => {
                                  const response =
                                    await apiClient.features.checkSlug.$post({
                                      json: {
                                        slug: value,
                                      },
                                    });
                                  const data = await response.json();
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
                            disabled={field.state.value[index]?.isExisting}
                            onChange={(value: string) => {
                              // Only allow changes for new features
                              if (!field.state.value[index]?.isExisting) {
                                subField.handleChange(value);
                                // Keep event name in sync for usage-based features
                                const isUsageBased = form.getFieldValue(
                                  `features[${index}].isUsageBased`
                                );
                                if (isUsageBased) {
                                  form.setFieldValue(
                                    `features[${index}].eventName`,
                                    value
                                  );
                                }
                              }
                            }}
                          />
                        )}
                      </form.AppField>

                      {/* Feature Type Toggle */}
                      <form.AppField name={`features[${index}].isUsageBased`}>
                        {(subField) => (
                          <div className="space-y-2">
                            <Label>Feature Type</Label>
                            <div className="flex space-x-2">
                              <Toggle
                                pressed={!subField.state.value}
                                disabled={field.state.value[index]?.readOnly}
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
                                disabled={field.state.value[index]?.readOnly}
                                onPressedChange={() => {
                                  if (!field.state.value[index]?.readOnly) {
                                    subField.handleChange(true);
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

                      {/* Event Name for usage-based */}
                      <form.AppField name={`features[${index}].isUsageBased`}>
                        {(toggleField) =>
                          toggleField.state.value && (
                            <form.AppField
                              name={`features[${index}].eventName`}
                            >
                              {(subField) => (
                                <subField.TextField
                                  label="Event Name"
                                  disabled={field.state.value[index]?.readOnly}
                                />
                              )}
                            </form.AppField>
                          )
                        }
                      </form.AppField>

                      {/* Credit Allowance Section */}
                      <form.AppField name={`features[${index}].isUsageBased`}>
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
                                                  renewalField.state.value ===
                                                  "none"
                                                    ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                }`}
                                                onClick={() =>
                                                  renewalField.handleChange(
                                                    "none"
                                                  )
                                                }
                                              >
                                                One-time
                                              </button>
                                              <button
                                                type="button"
                                                className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${
                                                  renewalField.state.value ===
                                                  "monthly"
                                                    ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                }`}
                                                onClick={() =>
                                                  renewalField.handleChange(
                                                    "monthly"
                                                  )
                                                }
                                              >
                                                Monthly
                                              </button>
                                              <button
                                                type="button"
                                                className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${
                                                  renewalField.state.value ===
                                                  "yearly"
                                                    ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                                                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                                }`}
                                                onClick={() =>
                                                  renewalField.handleChange(
                                                    "yearly"
                                                  )
                                                }
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

                      {/* Trial Credit Allowance for usage-based features */}
                      <form.AppField name={`features[${index}].isUsageBased`}>
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
                                    Set how much of this feature users can use
                                    during the trial period. After hitting this
                                    limit, they cannot use the feature further
                                    until upgrading to the paid plan.
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

                      {/* Usage price */}
                      <form.AppField name={`features[${index}].isUsageBased`}>
                        {(toggleField) =>
                          toggleField.state.value && (
                            <form.AppField
                              name={`features[${index}].usagePricePerUnit`}
                            >
                              {(subField) => (
                                <subField.Number2DecimalsField
                                  label="Usage price per unit (billed monthly)"
                                  subtitle="Leave empty if you don't want to charge per usage. Use credit allowances above to set how much your users can use"
                                />
                              )}
                            </form.AppField>
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
              )}
            </form.AppField>

            <form.AppForm>
              <form.SubmitButtonWithShortcut label="Update Plan" />
            </form.AppForm>
          </form>
        </div>

        {/* Preview Section */}
        <div className="lg:sticky lg:top-8 lg:h-fit">
          <h2 className="text-xl font-semibold mb-4">Live Preview</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Preview of your updated plan
          </p>
          <div className="border rounded-lg p-4 bg-gray-50">
            <PricingTableCards {...previewData} />
          </div>
        </div>
      </div>
    </div>
  );
}
