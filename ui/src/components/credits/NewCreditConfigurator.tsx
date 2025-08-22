"use client";

import React, { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Settings,
  AlertCircle,
  Eye,
  EyeOff,
  HelpCircle,
  Loader2,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/hono-client";
import type { NewCreditConfig } from "./ManualCreditGrantModal";

interface NewCreditConfiguratorProps {
  onConfigured: (config: NewCreditConfig) => void;
  onBack: () => void;
  onClose: () => void;
}

interface Plan {
  id: string;
  planName: string;
  planDescription?: string | null;
  stablePlanId: string;
  versionNumber: number;
}

interface PlanGroup {
  stablePlanId: string;
  planName: string;
  planDescription?: string | null;
  latestVersion: Plan;
  allVersions: Plan[];
}

interface Feature {
  id: string;
  slug: string;
  displayName: string;
  description?: string | null;
  featureType: "boolean" | "number" | "string";
  featureValue: boolean | number | string;
}

interface PlanWithFeatures extends Plan {
  features: Feature[];
}

interface PriceComponent {
  component_id: string;
  component_name?: string;
  type: string;
  label?: string;
  metric_id?: string;
  recurrence_rule?: string;
  billing_cycle?: string;
  amount_cents?: number;
  per_unit_cents?: number;
  unit_cost_cents?: number;
  unit_label?: string;
}

interface Price {
  id: string;
  planId: string;
  currency: string;
  interval?: string; // "month", "year", "week", etc.
  intervalCount?: number; // 1, 3, 6, 12, etc.
  nickname?: string; // Human-readable name like "Monthly Plan" or "Annual Discount"
  pricingData?: {
    components?: PriceComponent[];
  };
}

// Usage Credit Linkage Types
type UsageLinkageType = "feature" | "price_component" | "both";

export function NewCreditConfigurator({
  onConfigured,
  onBack,
  onClose,
}: NewCreditConfiguratorProps) {
  const [config, setConfig] = useState<NewCreditConfig>({
    applicationType: "monetary",
    scope: "merchant",
    currency: "USD",
    billingVisible: true,
    billingDescription: "",
    name: "",
    description: "",
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selectedPlanVersionId, setSelectedPlanVersionId] =
    useState<string>("");
  const [usageLinkageType, setUsageLinkageType] =
    useState<UsageLinkageType>("feature");

  // Fetch all plans and group by stablePlanId
  const { data: allPlans, isLoading: plansLoading } = useQuery({
    queryKey: ["all-plans"],
    queryFn: async () => {
      const response = await apiClient.plans.$get();
      const data = await response.json();
      return "plans" in data ? (data.plans as Plan[]) : [];
    },
    enabled:
      config.applicationType === "usage" ||
      config.scope === "plan" ||
      config.scope === "price" ||
      config.scope === "component",
  });

  // Group plans by stablePlanId and get latest versions
  const planGroups = useMemo(() => {
    if (!allPlans) return [];

    const groups = new Map<string, PlanGroup>();

    allPlans.forEach((plan) => {
      const stablePlanId = plan.stablePlanId;

      if (!groups.has(stablePlanId)) {
        groups.set(stablePlanId, {
          stablePlanId,
          planName: plan.planName,
          planDescription: plan.planDescription,
          latestVersion: plan,
          allVersions: [plan],
        });
      } else {
        const group = groups.get(stablePlanId)!;
        group.allVersions.push(plan);

        // Update latest version if this plan has higher version number
        if (plan.versionNumber > group.latestVersion.versionNumber) {
          group.latestVersion = plan;
        }
      }
    });

    // Sort all versions within each group by version number (latest first)
    groups.forEach((group) => {
      group.allVersions.sort((a, b) => b.versionNumber - a.versionNumber);
    });

    return Array.from(groups.values());
  }, [allPlans]);

  // Get the selected plan group and version
  const selectedPlanGroup = useMemo(() => {
    if (!selectedPlanVersionId || !planGroups.length) return null;

    return (
      planGroups.find((group) =>
        group.allVersions.some((v) => v.id === selectedPlanVersionId)
      ) || null
    );
  }, [planGroups, selectedPlanVersionId]);

  // Auto-select latest version when plan group changes
  useEffect(() => {
    if (config.planId && selectedPlanGroup && !selectedPlanVersionId) {
      setSelectedPlanVersionId(selectedPlanGroup.latestVersion.id);
      setConfig((prev) => ({
        ...prev,
        planId: selectedPlanGroup.latestVersion.id,
      }));
    }
  }, [config.planId, selectedPlanGroup, selectedPlanVersionId]);

  // Handle plan selection (this selects the stable plan, auto-selecting latest version)
  const handlePlanSelection = (stablePlanId: string) => {
    const planGroup = planGroups.find((g) => g.stablePlanId === stablePlanId);
    if (planGroup) {
      const latestVersion = planGroup.latestVersion;
      setSelectedPlanVersionId(latestVersion.id);
      setConfig((prev) => ({
        ...prev,
        planId: latestVersion.id,
        priceId: undefined,
        priceComponentId: undefined,
        featureId: undefined,
      }));
    }
  };

  // Handle version selection within a plan group
  const handleVersionSelection = (versionId: string) => {
    setSelectedPlanVersionId(versionId);
    setConfig((prev) => ({
      ...prev,
      planId: versionId,
      priceId: undefined,
      priceComponentId: undefined,
      featureId: undefined,
    }));
  };

  // Fetch plan features when plan is selected and we need features
  const { data: planWithFeatures, isLoading: featuresLoading } = useQuery({
    queryKey: ["plan-features", selectedPlanVersionId],
    queryFn: async () => {
      if (!selectedPlanVersionId) return null;
      const response = await apiClient.plans[":id"].$get({
        param: { id: selectedPlanVersionId },
        query: { includeFeatures: "true" },
      });
      const data = await response.json();
      if ("plans" in data && data.plans.length > 0) {
        return data.plans[0] as PlanWithFeatures;
      }
      return null;
    },
    enabled:
      !!selectedPlanVersionId &&
      config.applicationType === "usage" &&
      (usageLinkageType === "feature" || usageLinkageType === "both"),
  });

  // Fetch prices for selected plan
  const { data: prices, isLoading: pricesLoading } = useQuery({
    queryKey: ["prices", selectedPlanVersionId],
    queryFn: async () => {
      if (!selectedPlanVersionId) return [];
      const response = await apiClient.prices.$get({
        query: { planId: selectedPlanVersionId },
      });
      const data = await response.json();
      return "prices" in data ? data.prices : [];
    },
    enabled:
      !!selectedPlanVersionId &&
      config.applicationType === "usage" &&
      (usageLinkageType === "price_component" || usageLinkageType === "both"),
  });

  // Fetch price components for selected price
  const { data: priceComponents, isLoading: componentsLoading } = useQuery({
    queryKey: ["price-components", config.priceId],
    queryFn: async () => {
      if (!config.priceId) return [];
      const response = await apiClient.prices[":priceId"].$get({
        param: { priceId: config.priceId },
      });
      const data = await response.json();
      if ("price" in data && data.price?.pricingData?.components) {
        return data.price.pricingData.components;
      }
      return [];
    },
    enabled:
      !!config.priceId &&
      config.applicationType === "usage" &&
      (usageLinkageType === "price_component" || usageLinkageType === "both"),
  });

  // Auto-filter scope options based on application type
  const getAvailableScopes = () => {
    if (config.applicationType === "usage") {
      // Usage credits support multiple scopes now
      return [
        {
          value: "merchant",
          label: "Merchant",
          description: "Apply across all customer usage",
        },
        { value: "plan", label: "Plan", description: "Apply to specific plan" },
        {
          value: "price",
          label: "Price",
          description: "Apply to specific price",
        },
        {
          value: "component",
          label: "Price Component",
          description: "Apply to specific price component",
        },
      ];
    }

    return [
      {
        value: "merchant",
        label: "Merchant",
        description: "Apply across all customer usage",
      },
      { value: "plan", label: "Plan", description: "Apply to specific plan" },
      {
        value: "price",
        label: "Price",
        description: "Apply to specific price",
      },
      {
        value: "component",
        label: "Price Component",
        description: "Apply to specific price component",
      },
    ];
  };

  // Get available linkage types for usage credits
  const getUsageLinkageTypes = () => {
    return [
      {
        value: "feature" as const,
        label: "Feature Only",
        description: "Link to feature for entitlement checks only",
      },
      {
        value: "price_component" as const,
        label: "Price Component Only",
        description: "Link to price component for billing only",
      },
      {
        value: "both" as const,
        label: "Feature + Price Component",
        description:
          "Link to both feature (entitlements) and price component (billing)",
      },
    ];
  };

  // Reset dependent fields when scope changes
  useEffect(() => {
    if (
      config.scope !== "plan" &&
      config.scope !== "price" &&
      config.scope !== "component"
    ) {
      setConfig((prev) => ({
        ...prev,
        planId: undefined,
        priceId: undefined,
        priceComponentId: undefined,
        featureId: undefined,
      }));
    } else if (config.scope !== "price" && config.scope !== "component") {
      setConfig((prev) => ({
        ...prev,
        priceId: undefined,
        priceComponentId: undefined,
      }));
    } else if (config.scope !== "component") {
      setConfig((prev) => ({
        ...prev,
        priceComponentId: undefined,
      }));
    }
  }, [config.scope]);

  // Reset linkage-dependent fields when linkage type changes
  useEffect(() => {
    if (usageLinkageType === "feature") {
      setConfig((prev) => ({
        ...prev,
        priceId: undefined,
        priceComponentId: undefined,
      }));
    } else if (usageLinkageType === "price_component") {
      setConfig((prev) => ({
        ...prev,
        featureId: undefined,
      }));
    }
  }, [usageLinkageType]);

  // Reset to valid scope when application type changes
  useEffect(() => {
    const availableScopes = getAvailableScopes();
    const currentScopeValid = availableScopes.some(
      (s) => s.value === config.scope
    );
    if (!currentScopeValid) {
      setConfig((prev) => ({
        ...prev,
        scope: availableScopes[0].value as
          | "component"
          | "price"
          | "plan"
          | "merchant",
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.applicationType]);

  const validateConfig = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!config.name.trim()) {
      newErrors.name = "Credit name is required";
    }

    if (config.applicationType === "monetary" && !config.currency) {
      newErrors.currency = "Currency required for monetary credits";
    }

    if (
      config.applicationType === "monetary" &&
      config.billingVisible &&
      !config.billingDescription?.trim()
    ) {
      newErrors.billingDescription =
        "Billing description required when billing visible is enabled";
    }

    // For usage credits, validate linkage requirements
    if (config.applicationType === "usage") {
      if (!selectedPlanVersionId) {
        newErrors.planId = "Plan selection is required for usage credits";
      }

      // Validate based on linkage type
      if (usageLinkageType === "feature" || usageLinkageType === "both") {
        if (!config.featureId) {
          newErrors.featureId = "Feature selection is required";
        }
      }

      if (
        usageLinkageType === "price_component" ||
        usageLinkageType === "both"
      ) {
        if (!config.priceId) {
          newErrors.priceId = "Price selection is required";
        }
        if (!config.priceComponentId) {
          newErrors.priceComponentId = "Price component selection is required";
        }
      }
    } else {
      // For monetary credits, validate based on scope
      if (config.scope === "plan" && !selectedPlanVersionId) {
        newErrors.planId = "Plan selection is required";
      }

      if (config.scope === "price") {
        if (!selectedPlanVersionId) {
          newErrors.planId = "Plan selection is required";
        }
        if (!config.priceId) {
          newErrors.priceId = "Price selection is required";
        }
      }

      if (config.scope === "component") {
        if (!selectedPlanVersionId) {
          newErrors.planId = "Plan selection is required";
        }
        if (!config.priceId) {
          newErrors.priceId = "Price selection is required";
        }
        if (!config.priceComponentId) {
          newErrors.priceComponentId = "Price component selection is required";
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleContinue = () => {
    if (validateConfig()) {
      // Ensure planId is set to the selected version ID
      const finalConfig = {
        ...config,
        planId: selectedPlanVersionId || config.planId,
      };
      onConfigured(finalConfig);
    }
  };

  const updateConfig = (
    field: keyof NewCreditConfig,
    value: string | boolean
  ) => {
    setConfig((prev) => ({ ...prev, [field]: value }));

    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
  };

  // Helper function to format component names
  const formatComponentName = (component: PriceComponent): string => {
    // If we have a proper label, use it
    if (component.label && component.label.trim()) {
      return component.label;
    }

    // Get the raw name from component_name or component_id
    const rawName = component.component_name?.trim() || component.component_id;

    if (!rawName) {
      return "Component";
    }

    // Clean up the raw name
    const cleaned = rawName
      .replace(/[_-]/g, " ") // Replace underscores and dashes with spaces
      .replace(/([a-z])([A-Z])/g, "$1 $2") // Add space between camelCase
      .toLowerCase()
      .trim();

    // Split into words and remove duplicates while preserving order
    const words = cleaned.split(/\s+/).filter((word) => word.length > 0);
    const uniqueWords = [];
    const seen = new Set();

    for (const word of words) {
      if (!seen.has(word)) {
        seen.add(word);
        uniqueWords.push(word);
      }
    }

    // If we end up with just one word and it matches the type, make it more descriptive
    if (uniqueWords.length === 1) {
      const word = uniqueWords[0];
      if (word === "usage") {
        return "Usage Component";
      } else if (word === "fixed") {
        return "Fixed Component";
      }
    }

    // Capitalize first letter of each word
    return (
      uniqueWords
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ") || "Component"
    );
  };

  // Helper function to get component type display
  const getComponentTypeLabel = (component: PriceComponent): string => {
    const type = component.type?.toLowerCase();

    switch (type) {
      case "usage":
      case "usage_based":
        return "Usage";
      case "fixed":
      case "flat":
        return "Fixed";
      case "tiered":
        return "Tiered";
      case "volume":
        return "Volume";
      default:
        return type
          ? type.charAt(0).toUpperCase() + type.slice(1)
          : "Component";
    }
  };

  // Helper function to check if component is usage-based
  const isUsageBasedComponent = (component: PriceComponent): boolean => {
    const type = component.type?.toLowerCase();
    return type === "usage" || type === "usage_based";
  };

  // Helper function to format currency
  const formatCurrency = (amountCents: number, currency: string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
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

  // Helper function to get component unit label
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
    price: Price,
    component?: PriceComponent
  ): string => {
    // First try to get period from the price itself
    if (price.nickname) {
      const lower = price.nickname.toLowerCase();
      if (lower.includes("monthly") || lower.includes("month"))
        return "monthly";
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
      const lower = component.recurrence_rule.toLowerCase();
      if (lower.includes("month")) return "monthly";
      if (lower.includes("year")) return "yearly";
      if (lower.includes("week")) return "weekly";
      if (lower.includes("day")) return "daily";
      if (lower.includes("freq=monthly")) return "monthly";
      if (lower.includes("freq=yearly")) return "yearly";
      if (lower.includes("freq=weekly")) return "weekly";
      if (lower.includes("freq=daily")) return "daily";
    }

    // Try billing_cycle as fallback
    if (component?.billing_cycle) {
      const lower = component.billing_cycle.toLowerCase();
      if (lower.includes("month")) return "monthly";
      if (lower.includes("year")) return "yearly";
      if (lower.includes("week")) return "weekly";
      if (lower.includes("day")) return "daily";
    }

    return "once";
  };

  // Main function to format price display
  const formatPriceDisplay = (price: Price): string => {
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

    // Just show the components directly
    if (components.length === 1) {
      return formattedComponents[0];
    } else {
      return formattedComponents.join(" + ");
    }
  };

  const availableScopes = getAvailableScopes();
  const usageLinkageTypes = getUsageLinkageTypes();

  return (
    <TooltipProvider>
      <div className="w-[480px] max-w-[95vw] mx-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <h2 className="text-xl font-semibold text-foreground mb-1">
            Configure New Credits
          </h2>
          <p className="text-sm text-muted-foreground">
            Set up custom credit parameters
          </p>
        </div>

        {/* Single Compact Form */}
        <Card className="shadow-lg">
          <CardContent className="p-6 space-y-5">
            {/* Type & Scope Row */}
            <div
              className={
                config.applicationType === "usage"
                  ? "space-y-2"
                  : "grid grid-cols-2 gap-4"
              }
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">Type</Label>
                </div>
                <Select
                  value={config.applicationType}
                  onValueChange={(value: "usage" | "monetary") =>
                    updateConfig("applicationType", value)
                  }
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="usage">Usage</SelectItem>
                    <SelectItem value="monetary">Monetary</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Only show scope selector for monetary credits */}
              {config.applicationType === "monetary" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">Scope</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <div className="space-y-1">
                          <p className="font-medium">
                            Credit Application Scope:
                          </p>
                          {availableScopes.map((scope) => (
                            <div key={scope.value} className="text-xs">
                              <span className="font-medium">
                                {scope.label}:
                              </span>{" "}
                              {scope.description}
                            </div>
                          ))}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Select
                    value={config.scope}
                    onValueChange={(
                      value: "component" | "price" | "plan" | "merchant"
                    ) => updateConfig("scope", value)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableScopes.map((scope) => (
                        <SelectItem key={scope.value} value={scope.value}>
                          {scope.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Usage Credit Linkage Type Selection */}
            {config.applicationType === "usage" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">
                      Credit Linkage
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <div className="space-y-1">
                          <p className="font-medium">
                            Usage Credit Linkage Types:
                          </p>
                          {usageLinkageTypes.map((type) => (
                            <div key={type.value} className="text-xs">
                              <span className="font-medium">{type.label}:</span>{" "}
                              {type.description}
                            </div>
                          ))}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Select
                    value={usageLinkageType}
                    onValueChange={(value: UsageLinkageType) =>
                      setUsageLinkageType(value)
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {usageLinkageTypes.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800 font-medium">
                    {usageLinkageType === "feature"
                      ? "Feature-linked credits are used for entitlement checks only"
                      : usageLinkageType === "price_component"
                        ? "Price component-linked credits are used for billing discounts only"
                        : "Credits linked to both feature and price component are used for both entitlements and billing"}
                  </p>
                  <p className="text-xs text-blue-600 mt-1">
                    {usageLinkageType === "feature"
                      ? "Select a plan, then choose the feature these credits apply to"
                      : usageLinkageType === "price_component"
                        ? "Select a plan, then a price, then the specific component for billing discounts"
                        : "Select a plan, then choose both the feature (for entitlements) and price component (for billing)"}
                  </p>
                </div>
              </div>
            )}

            {/* Plan Selection */}
            {(config.applicationType === "usage" ||
              config.scope === "plan" ||
              config.scope === "price" ||
              config.scope === "component") && (
              <div className="space-y-4">
                {/* Plan Selector */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Plan *</Label>
                  <Select
                    value={selectedPlanGroup?.stablePlanId || ""}
                    onValueChange={(stablePlanId) =>
                      handlePlanSelection(stablePlanId)
                    }
                    disabled={plansLoading}
                  >
                    <SelectTrigger
                      className={`h-9 ${errors.planId ? "border-destructive" : ""}`}
                    >
                      {plansLoading ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Loading plans...</span>
                        </div>
                      ) : (
                        <SelectValue placeholder="Select a plan" />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {planGroups?.map((group) => (
                        <SelectItem
                          key={group.stablePlanId}
                          value={group.stablePlanId}
                        >
                          <div className="font-medium">
                            {group.planName}
                            {group.planDescription && (
                              <span className="text-muted-foreground ml-2">
                                • {group.planDescription}
                              </span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.planId && (
                    <div className="flex items-center gap-2 text-xs text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      {errors.planId}
                    </div>
                  )}
                </div>

                {/* Version Selection - Show if multiple versions exist for selected plan */}
                {selectedPlanGroup &&
                  selectedPlanGroup.allVersions.length > 1 && (
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Version</Label>
                      <Select
                        value={selectedPlanVersionId}
                        onValueChange={(versionId) =>
                          handleVersionSelection(versionId)
                        }
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="Select version" />
                        </SelectTrigger>
                        <SelectContent>
                          {selectedPlanGroup.allVersions.map((version) => (
                            <SelectItem key={version.id} value={version.id}>
                              Version {version.versionNumber}
                              {version.id ===
                                selectedPlanGroup.latestVersion.id &&
                                " (Latest)"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
              </div>
            )}

            {/* Feature Selection - For usage credits with feature linkage */}
            {config.applicationType === "usage" &&
              (usageLinkageType === "feature" || usageLinkageType === "both") &&
              selectedPlanVersionId && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Feature *</Label>
                  <Select
                    value={config.featureId || ""}
                    onValueChange={(value) => updateConfig("featureId", value)}
                    disabled={featuresLoading || !selectedPlanVersionId}
                  >
                    <SelectTrigger
                      className={`h-9 ${errors.featureId ? "border-destructive" : ""}`}
                    >
                      {featuresLoading ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Loading features...</span>
                        </div>
                      ) : (
                        <SelectValue placeholder="Select a feature" />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {planWithFeatures?.features &&
                      planWithFeatures.features.length > 0 ? (
                        planWithFeatures.features
                          .filter(
                            (feature: Feature) =>
                              feature.featureType === "number"
                          )
                          .map((feature: Feature) => (
                            <SelectItem
                              key={feature.id}
                              value={feature.id}
                              className="cursor-pointer"
                            >
                              <div className="py-1">
                                <span className="font-medium">
                                  {feature.displayName}
                                </span>
                                <span className="text-muted-foreground ml-2">
                                  ({feature.slug})
                                </span>
                              </div>
                            </SelectItem>
                          ))
                      ) : (
                        <SelectItem value="no-features" disabled>
                          <div className="flex items-center space-x-3 py-2 text-muted-foreground">
                            <div className="text-xs">
                              No usage features found for this plan
                            </div>
                          </div>
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {errors.featureId && (
                    <div className="flex items-center gap-2 text-xs text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      {errors.featureId}
                    </div>
                  )}
                </div>
              )}

            {/* Price Selection - For price component linkage or monetary credits */}
            {((config.applicationType === "usage" &&
              (usageLinkageType === "price_component" ||
                usageLinkageType === "both")) ||
              (config.applicationType === "monetary" &&
                (config.scope === "price" || config.scope === "component"))) &&
              selectedPlanVersionId && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Price *</Label>
                  <Select
                    value={config.priceId || ""}
                    onValueChange={(value) => updateConfig("priceId", value)}
                    disabled={pricesLoading || !selectedPlanVersionId}
                  >
                    <SelectTrigger
                      className={`h-9 ${errors.priceId ? "border-destructive" : ""}`}
                    >
                      {pricesLoading ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Loading prices...</span>
                        </div>
                      ) : (
                        <SelectValue placeholder="Select a price" />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {prices
                        ?.filter((price) => price.id && price.id.trim() !== "")
                        .map((price: Price) => {
                          const priceInfo = formatPriceDisplay(price);

                          return (
                            <SelectItem
                              key={price.id}
                              value={price.id}
                              className="cursor-pointer"
                            >
                              <div className="py-1">
                                <div className="font-medium">{priceInfo}</div>
                              </div>
                            </SelectItem>
                          );
                        })}
                    </SelectContent>
                  </Select>
                  {errors.priceId && (
                    <div className="flex items-center gap-2 text-xs text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      {errors.priceId}
                    </div>
                  )}
                </div>
              )}

            {/* Price Component Selection - For component linkage */}
            {((config.applicationType === "usage" &&
              (usageLinkageType === "price_component" ||
                usageLinkageType === "both")) ||
              (config.applicationType === "monetary" &&
                config.scope === "component")) &&
              config.priceId && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">
                    Price Component *
                  </Label>
                  <Select
                    value={config.priceComponentId || ""}
                    onValueChange={(value) =>
                      updateConfig("priceComponentId", value)
                    }
                    disabled={componentsLoading || !config.priceId}
                  >
                    <SelectTrigger
                      className={`h-9 ${errors.priceComponentId ? "border-destructive" : ""}`}
                    >
                      {componentsLoading ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Loading components...</span>
                        </div>
                      ) : (
                        <SelectValue placeholder="Select a price component" />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {priceComponents && priceComponents.length > 0 ? (
                        priceComponents
                          .filter(
                            (component) =>
                              component.component_id &&
                              component.component_id.trim() !== "" &&
                              // For usage credits, only show usage-based components
                              (config.applicationType !== "usage" ||
                                isUsageBasedComponent(component))
                          )
                          .map((component: PriceComponent) => {
                            const componentName =
                              formatComponentName(component);
                            const componentType =
                              getComponentTypeLabel(component);

                            return (
                              <SelectItem
                                key={component.component_id}
                                value={component.component_id}
                                className="cursor-pointer"
                              >
                                <div className="py-1">
                                  <div className="font-medium text-foreground">
                                    {componentName}
                                    <span className="text-muted-foreground font-normal">
                                      {` • ${componentType} Price`}
                                    </span>
                                  </div>
                                </div>
                              </SelectItem>
                            );
                          })
                      ) : (
                        <SelectItem value="no-components" disabled>
                          <div className="flex items-center space-x-3 py-2 text-muted-foreground">
                            <div className="text-xs">
                              {config.applicationType === "usage"
                                ? "No usage-based components found for this price"
                                : "No price components found for this price"}
                            </div>
                          </div>
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {errors.priceComponentId && (
                    <div className="flex items-center gap-2 text-xs text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      {errors.priceComponentId}
                    </div>
                  )}
                </div>
              )}

            {/* Credit Name */}
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm font-medium">
                Credit Name *
              </Label>
              <Input
                id="name"
                value={config.name}
                onChange={(e) => updateConfig("name", e.target.value)}
                placeholder="e.g., Customer Appreciation Credit"
                className={`h-9 ${errors.name ? "border-destructive" : ""}`}
              />
              {errors.name && (
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3 w-3" />
                  {errors.name}
                </div>
              )}
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description" className="text-sm font-medium">
                Description
              </Label>
              <Textarea
                id="description"
                value={config.description || ""}
                onChange={(e) => updateConfig("description", e.target.value)}
                placeholder="Optional description for internal tracking"
                rows={2}
                className="resize-none text-sm"
              />
            </div>

            {/* Monetary Settings - Only show if monetary type */}
            {config.applicationType === "monetary" && (
              <div className="pt-3 border-t space-y-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Settings className="h-4 w-4" />
                  Monetary Settings
                </div>

                {/* Currency & Show on Invoices Row */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="currency" className="text-sm font-medium">
                      Currency *
                    </Label>
                    <Select
                      value={config.currency}
                      onValueChange={(value) => updateConfig("currency", value)}
                    >
                      <SelectTrigger
                        className={`h-9 ${
                          errors.currency ? "border-destructive" : ""
                        }`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="EUR">EUR</SelectItem>
                        <SelectItem value="GBP">GBP</SelectItem>
                        <SelectItem value="CAD">CAD</SelectItem>
                      </SelectContent>
                    </Select>
                    {errors.currency && (
                      <div className="flex items-center gap-2 text-xs text-destructive">
                        <AlertCircle className="h-3 w-3" />
                        {errors.currency}
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      Show on Invoices
                    </Label>
                    <div className="flex items-center justify-between h-9 px-3 bg-muted/30 rounded-md">
                      <div className="flex items-center gap-2">
                        {config.billingVisible ? (
                          <Eye className="h-3 w-3 text-green-600" />
                        ) : (
                          <EyeOff className="h-3 w-3 text-muted-foreground" />
                        )}
                        <span className="text-xs text-muted-foreground">
                          {config.billingVisible ? "Visible" : "Hidden"}
                        </span>
                      </div>
                      <Switch
                        checked={config.billingVisible}
                        onCheckedChange={(checked: boolean) =>
                          updateConfig("billingVisible", checked)
                        }
                      />
                    </div>
                  </div>
                </div>

                {/* Billing Description - Only show if billing visible */}
                {config.billingVisible && (
                  <div className="space-y-2">
                    <Label
                      htmlFor="billingDescription"
                      className="text-sm font-medium"
                    >
                      Billing Description *
                    </Label>
                    <Input
                      id="billingDescription"
                      value={config.billingDescription || ""}
                      onChange={(e) =>
                        updateConfig("billingDescription", e.target.value)
                      }
                      placeholder="How this credit will appear on invoices"
                      className={`h-9 ${
                        errors.billingDescription ? "border-destructive" : ""
                      }`}
                    />
                    {errors.billingDescription && (
                      <div className="flex items-center gap-2 text-xs text-destructive">
                        <AlertCircle className="h-3 w-3" />
                        {errors.billingDescription}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex justify-between items-center mt-6">
          <Button
            variant="ghost"
            onClick={onBack}
            className="text-muted-foreground h-10 px-4"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div className="flex space-x-3">
            <Button variant="outline" onClick={onClose} className="h-10 px-4">
              Cancel
            </Button>
            <Button
              onClick={handleContinue}
              className="bg-green-600 hover:bg-green-700 h-10 px-6"
            >
              Continue to Amount
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
