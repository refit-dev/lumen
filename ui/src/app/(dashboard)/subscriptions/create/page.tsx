"use client";

import { useAppForm } from "@/hooks/form";
import { z } from "zod";
import { apiClient } from "@/lib/hono-client";
import { subscriptionsInsertSchema } from "@lumen/common/schema";
import { useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Info, CreditCard, Mail } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
// import { Switch } from "@/components/ui/switch"; // End date feature
// import { Label } from "@/components/ui/label"; // End date feature
import React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";

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

// Helper function to format currency
const formatCurrency = (amountCents: number, currency: string) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
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
  if (component.type === "per_unit") return "per unit";
  if (component.type === "usage") {
    if (component.unit_label) return `per ${component.unit_label}`;
    return "per use";
  }
  return "";
};

// Helper function to get billing period from price or component
const getBillingPeriod = (
  price: PriceWithComponents,
  component?: PriceComponent
): string => {
  // First try to get period from the price itself
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

  // Finally try component recurrence rule
  if (component?.recurrence_rule) {
    return formatRecurrence(component.recurrence_rule);
  }

  return "once";
};

// Main function to format price display
const formatPriceDisplay = (price: PriceWithComponents): string => {
  const components = price.pricingData?.components || [];

  if (components.length === 0) {
    return `${price.currency} - No components`;
  }

  const formattedComponents = components.map((component) => {
    const amount = getComponentAmount(component);
    const unit = getComponentUnit(component);
    const period = getBillingPeriod(price, component);

    if (amount === 0) {
      return `Free ${component.type} ${period}`;
    }

    const currencyFormatted = formatCurrency(amount, price.currency);
    const typeLabel = component.type === "fixed" ? "fixed" : component.type;

    if (unit) {
      return `${currencyFormatted} ${unit} ${period}`;
    } else {
      return `${currencyFormatted} ${typeLabel} ${period}`;
    }
  });

  // Just show the components directly without currency/period prefix
  if (components.length === 1) {
    return formattedComponents[0];
  } else {
    return formattedComponents.join(" + ");
  }
};

type PlanVersion = {
  id: string;
  planName: string;
  planDescription: string | null;
  stablePlanId: string;
  versionNumber: number;
  createdAt: string;
};

type GroupedPlan = {
  stablePlanId: string;
  planName: string;
  planDescription: string | null;
  versions: PlanVersion[];
  hasMultipleVersions: boolean;
  latestVersion: PlanVersion;
};

export default function CreateSubscriptionPage() {
  const router = useRouter();
  // const [hasEndDate, setHasEndDate] = useState(false); // End date feature

  const { data: customers } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const response = await apiClient.customers.$get();
      const data = await response.json();
      return data.customers;
    },
  });

  const { data: allPlans } = useQuery({
    queryKey: ["plans"],
    queryFn: async () => {
      const response = await apiClient.plans.$get();
      const data = await response.json();
      return data.plans as PlanVersion[];
    },
  });

  // Group plans by stablePlanId and identify multiple versions
  const groupedPlans = useMemo(() => {
    if (!allPlans) return [];

    const planMap = new Map<string, PlanVersion[]>();

    // Group plans by stablePlanId
    allPlans.forEach((plan) => {
      if (!planMap.has(plan.stablePlanId)) {
        planMap.set(plan.stablePlanId, []);
      }
      planMap.get(plan.stablePlanId)!.push(plan);
    });

    // Convert to GroupedPlan array
    const grouped: GroupedPlan[] = [];
    planMap.forEach((versions, stablePlanId) => {
      // Sort versions by versionNumber (highest first)
      versions.sort((a, b) => b.versionNumber - a.versionNumber);

      const latestVersion = versions[0];
      grouped.push({
        stablePlanId,
        planName: latestVersion.planName,
        planDescription: latestVersion.planDescription,
        versions,
        hasMultipleVersions: versions.length > 1,
        latestVersion,
      });
    });

    return grouped;
  }, [allPlans]);

  const form = useAppForm({
    defaultValues: {
      customerId: "",
      stablePlanId: "", // Track stable plan ID
      selectedVersion: "", // Track selected version
      planId: "", // This will be set based on stablePlanId + selectedVersion
      effectivePriceId: "",
      startTimestamp: new Date(),
      // endTimestamp: new Date(), // End date feature
    },
    onSubmit: async ({ value }) => {
      // Frontend required field validation to prevent empty submissions
      const requiredErrors: Record<string, string> = {};
      if (!value.customerId) requiredErrors.customerId = "Customer is required";
      if (!value.planId) requiredErrors.planId = "Plan is required";
      if (!value.effectivePriceId)
        requiredErrors.effectivePriceId = "Price is required";

      if (Object.keys(requiredErrors).length > 0) {
        return { fields: requiredErrors };
      }

      try {
        const response = await apiClient.subscriptions.$post({
          json: {
            customerId: value.customerId,
            planId: value.planId, // Use the resolved planId
            effectivePriceId: value.effectivePriceId,
            startTimestamp: value.startTimestamp.toISOString(),
            triggerImmediateBilling: true, // trigger billing via createOneTimeLink if needed (i.e. if there are bill_immediately components)
            // endTimestamp: hasEndDate // End date feature
            //   ? value.endTimestamp.toISOString()
            //   : undefined,
          },
        });
        const data = await response.json();
        if ("error" in data) {
          // Display error message to the user
          toast.error(data.error);
          throw new Error(data.error);
        }
        // Redirect to the newly created subscription details page
        if (!data.subscription?.stableSubscriptionId) {
          const errorMessage =
            "Subscription creation failed: No stable subscription ID returned";
          toast.error(errorMessage);
          throw new Error(errorMessage);
        }

        toast.success("Subscription created successfully");
        router.push(`/subscriptions/${data.subscription.stableSubscriptionId}`);
      } catch (error) {
        console.error("Error creating subscription:", error);
        // Don't show toast if we already showed one above
        if (
          error instanceof Error &&
          !error.message.includes("already has an active subscription")
        ) {
          toast.error(error.message || "Failed to create subscription");
        }
        throw error;
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        // Frontend required field validation to prevent empty submissions
        const requiredErrors: Record<string, string> = {};
        if (!value.customerId)
          requiredErrors.customerId = "Customer is required";
        if (!value.planId) requiredErrors.planId = "Plan is required";
        if (!value.effectivePriceId)
          requiredErrors.effectivePriceId = "Price is required";

        if (Object.keys(requiredErrors).length > 0) {
          return { fields: requiredErrors };
        }

        const result = subscriptionsInsertSchema.safeParse({
          customerId: value.customerId,
          planId: value.planId,
          effectivePriceId: value.effectivePriceId,
          startTimestamp: value.startTimestamp,
        });
        if (!result.success) {
          const errors = result.error.issues.reduce(
            (acc: Record<string, string>, issue: z.ZodIssue) => ({
              ...acc,
              [issue.path[0]]: issue.message,
            }),
            {}
          );
          return { fields: errors };
        }
        return undefined;
      },
    },
  });

  const stablePlanId = useStore(
    form.store,
    (state) => state.values.stablePlanId
  );
  const selectedVersion = useStore(
    form.store,
    (state) => state.values.selectedVersion
  );
  const planId = useStore(form.store, (state) => state.values.planId);

  // Get the selected grouped plan
  const selectedGroupedPlan = useMemo(() => {
    return groupedPlans.find((gp) => gp.stablePlanId === stablePlanId);
  }, [groupedPlans, stablePlanId]);

  // Update planId when stablePlanId or selectedVersion changes
  useEffect(() => {
    if (stablePlanId && selectedVersion) {
      form.setFieldValue("planId", selectedVersion);
    } else if (
      stablePlanId &&
      selectedGroupedPlan &&
      !selectedGroupedPlan.hasMultipleVersions
    ) {
      // If single version, set planId directly
      form.setFieldValue("planId", selectedGroupedPlan.latestVersion.id);
    }
  }, [stablePlanId, selectedVersion, selectedGroupedPlan, form]);

  // Auto-select latest version when a plan with multiple versions is selected
  useEffect(() => {
    if (selectedGroupedPlan?.hasMultipleVersions && !selectedVersion) {
      form.setFieldValue(
        "selectedVersion",
        selectedGroupedPlan.latestVersion.id
      );
    }
  }, [selectedGroupedPlan, selectedVersion, form]);

  const { data: prices } = useQuery({
    queryKey: [planId],
    queryFn: async () => {
      if (!planId) return [];
      const response = await apiClient.prices.$get({
        query: { planId },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      return data.prices as PriceWithComponents[];
    },
  });

  useEffect(() => {
    if (prices?.length === 1) {
      form.setFieldValue("effectivePriceId", prices[0].id);
    }
  }, [prices, form]);

  const handleNavigateBack = useCallback(() => {
    router.back();
  }, [router]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        const target = event.target as HTMLElement | null;
        // Avoid submitting when the focus is on an interactive input inside dropdown/search
        const isInputLike =
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.getAttribute("role") === "combobox");
        if (isInputLike) {
          return; // Let the dropdown handle the Enter keypress
        }
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
      <h1 className="text-2xl font-bold mb-8">Create New Subscription</h1>

      {/* Payment Information Alert */}
      <Alert className="mb-6 border-blue-200 bg-blue-50">
        <Info className="h-4 w-4 text-blue-600" />
        <AlertDescription className="text-blue-800">
          <div className="space-y-2">
            <p className="font-medium">How Payment Collection Works:</p>
            <div className="flex items-start gap-2">
              <CreditCard className="h-4 w-4 mt-0.5 text-blue-600" />
              <p className="text-sm">
                If the customer doesn&apos;t have a payment method on file,
                we&apos;ll automatically create a secure payment link when their
                first invoice is due.
              </p>
            </div>
            <div className="flex items-start gap-2">
              <Mail className="h-4 w-4 mt-0.5 text-blue-600" />
              <p className="text-sm">
                The customer will receive an email with this link. They can
                click it to pay online. We will store the payment method on file
                for future invoices.
              </p>
            </div>
          </div>
        </AlertDescription>
      </Alert>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
        className="max-w-2xl space-y-6"
      >
        <form.AppField
          name="customerId"
          children={(field) => (
            <field.Dropdown
              label="Customer"
              searchEnabled={true}
              options={
                customers?.map((customer) => ({
                  label: customer.email
                    ? `${customer.name || customer.id} (${customer.email})`
                    : customer.name || customer.id,
                  value: customer.id,
                })) || []
              }
            />
          )}
        />

        <form.AppField
          name="stablePlanId"
          children={(field) => (
            <field.Dropdown
              label="Plan"
              options={
                groupedPlans?.map((groupedPlan) => ({
                  label: groupedPlan.hasMultipleVersions
                    ? `${groupedPlan.planName} (${groupedPlan.versions.length} versions)`
                    : groupedPlan.planName,
                  value: groupedPlan.stablePlanId,
                })) || []
              }
            />
          )}
        />

        {selectedGroupedPlan?.hasMultipleVersions && (
          <form.AppField
            name="selectedVersion"
            children={(field) => (
              <field.Dropdown
                label="Version"
                options={
                  selectedGroupedPlan.versions.map((version) => ({
                    label: `v${version.versionNumber}${version.id === selectedGroupedPlan.latestVersion.id ? " (Latest)" : ""}`,
                    value: version.id,
                  })) || []
                }
              />
            )}
          />
        )}

        <form.AppField
          name="effectivePriceId"
          children={(field) => (
            <field.Dropdown
              label="Price"
              options={
                prices?.map((price) => ({
                  label: formatPriceDisplay(price),
                  value: price.id,
                })) || []
              }
            />
          )}
        />

        <form.AppField
          name="startTimestamp"
          children={(field) => <field.DatePicker label="Start Date" />}
        />

        {/* <div className="flex items-center space-x-2">
          <Switch
            id="end-date-toggle"
            checked={hasEndDate}
            onCheckedChange={setHasEndDate}
          />
          <Label htmlFor="end-date-toggle">Set end date</Label>
        </div>

        {hasEndDate && (
          <form.AppField
            name="endTimestamp"
            children={(field) => <field.DatePicker label="End Date" />}
          />
        )} */}

        <form.AppForm>
          <form.SubmitButtonWithShortcut label="Create Subscription" />
        </form.AppForm>
      </form>
    </div>
  );
}
