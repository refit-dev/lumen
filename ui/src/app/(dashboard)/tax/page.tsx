"use client";

import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/hono-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { NexusWizard } from "@/components/dashboard/NexusWizard";
import { TaxRateDefinitionsManager } from "@/components/dashboard/TaxRateDefinitionsManager";
import { AuthenticatedContactModal } from "@/components/ContactUsModal";
import { usStates } from "@lumen/common/utils";
import { usePageTitle } from "@/components/dashboard/page-title-context";

type NexusConfig = {
  id: string;
  merchantId: string;
  state: string;
  hasNexus: boolean | null;
  nexusType: string | null;
  hasEmployees: boolean | null;
  hasOffices: boolean | null;
  hasInventory: boolean | null;
  otherPresence: string | null;
  salesThreshold: number | null;
  transactionThreshold: number | null;
  createdAt: string;
  updatedAt: string;
};

export default function TaxSettingsPage() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { setTitle } = usePageTitle();

  useEffect(() => {
    setTitle("Tax");
  }, [setTitle]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [autoTaxCalculation, setAutoTaxCalculation] = useState(false);
  const [defaultTaxRate, setDefaultTaxRate] = useState("");
  const [taxRateError, setTaxRateError] = useState("");
  const [showNexusWizard, setShowNexusWizard] = useState(false);

  const merchantId = session?.merchant?.id;

  // Validate tax rate input
  const validateTaxRate = (value: string) => {
    if (!value || value.trim() === "") {
      setTaxRateError("");
      return true;
    }

    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      setTaxRateError("Please enter a valid number");
      return false;
    }

    if (numValue < 0) {
      setTaxRateError("Tax rate cannot be negative");
      return false;
    }

    if (numValue > 100) {
      setTaxRateError("Tax rate cannot exceed 100%");
      return false;
    }

    setTaxRateError("");
    return true;
  };

  // Fetch current merchant data to get country
  const { data: merchant } = useQuery({
    queryKey: ["merchant", merchantId],
    queryFn: async () => {
      if (!merchantId) return null;
      const response = await apiClient.merchants.current.$get();
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error as string);
      }
      return data;
    },
    enabled: !!merchantId,
  });

  // Fetch current tax configuration
  const { data: taxConfig, isLoading } = useQuery({
    queryKey: ["tax-config", merchantId],
    queryFn: async () => {
      if (!merchantId) return null;
      const response = await apiClient.tax.config.$get();
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error as string);
      }
      return data;
    },
    enabled: !!merchantId,
  });

  // Fetch current nexus configurations
  const { data: nexusConfigs, isLoading: isLoadingNexus } = useQuery({
    queryKey: ["nexus-config", merchantId],
    queryFn: async () => {
      if (!merchantId) return [];
      const response = await apiClient.tax.nexus.$get();
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error as string);
      }
      return data;
    },
    enabled: !!merchantId,
  });

  // Fetch Dodo configuration
  const { data: dodoConfig, isLoading: isLoadingDodo } = useQuery({
    queryKey: ["dodo-config", merchantId],
    queryFn: async () => {
      if (!merchantId) return null;
      const response = await apiClient.dodo.config.$get();
      const data = await response.json();
      if ("error" in data) {
        // If error is 404 (not found), return null instead of throwing
        if (response.status === 404) {
          return null;
        }
        throw new Error(data.error as string);
      }
      return data;
    },
    enabled: !!merchantId,
  });

  // Update tax configuration mutation
  const updateTaxConfigMutation = useMutation({
    mutationFn: async (values: {
      autoTaxCalculation: boolean;
      defaultTaxRate?: string;
    }) => {
      const response = await apiClient.tax["config"]["update"].$post({
        json: values,
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error as string);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tax-config", merchantId] });
      setIsSubmitting(false);
    },
    onError: (error) => {
      console.error("Error updating tax config:", error);
      setIsSubmitting(false);
    },
  });

  // Update nexus configuration mutation
  const updateNexusMutation = useMutation({
    mutationFn: async (nexusData: {
      recommendedStates: string[];
      nexusMap: Map<
        string,
        { physical: boolean; economic: boolean; reasons: string[] }
      >;
    }) => {
      /**
       * Sync nexus configuration.
       *
       * 1. Upsert all states returned by the wizard (set hasNexus = true).
       * 2. For any state that previously had nexus but is **not** in the new list,
       *    set hasNexus = false so we don't keep accumulating stale entries.
       */
      // Determine which states need to be added/updated and which need to be disabled
      const statesToEnable = nexusData.recommendedStates;
      const existingEnabledStates = Array.isArray(nexusConfigs)
        ? nexusConfigs
            .filter((c: NexusConfig) => c.hasNexus)
            .map((c: NexusConfig) => c.state)
        : [];
      const statesToDisable = existingEnabledStates.filter(
        (state) => !statesToEnable.includes(state)
      );

      // Upsert selected states (enable)
      const enablePromises = statesToEnable.map(async (state: string) => {
        const nexusInfo = nexusData.nexusMap.get(state);

        const response = await apiClient.tax.nexus[":state"].update.$post({
          param: { state },
          json: {
            hasNexus: true,
            nexusType: nexusInfo?.physical ? "physical" : "economic",
            hasEmployees:
              nexusInfo?.reasons.includes("Employees present") || false,
            hasOffices: nexusInfo?.physical || false,
          },
        });

        const data = await response.json();
        if ("error" in data) {
          throw new Error(`Failed to update nexus for ${state}: ${data.error}`);
        }
        return data;
      });

      // Disable states that were previously enabled but are no longer selected
      const disablePromises = statesToDisable.map(async (state: string) => {
        const response = await apiClient.tax.nexus[":state"].update.$post({
          param: { state },
          json: {
            hasNexus: false,
            nexusType: null,
            hasEmployees: false,
            hasOffices: false,
            hasInventory: false,
            otherPresence: null,
          },
        });
        const data = await response.json();
        if ("error" in data) {
          throw new Error(
            `Failed to disable nexus for ${state}: ${data.error}`
          );
        }
        return data;
      });

      await Promise.all([...enablePromises, ...disablePromises]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nexus-config", merchantId] });
    },
    onError: (error) => {
      console.error("Error updating nexus configuration:", error);
    },
  });

  // Update local state when tax config data loads
  useEffect(() => {
    if (taxConfig) {
      setAutoTaxCalculation(taxConfig.autoTaxCalculation ?? false);
      setDefaultTaxRate(
        taxConfig.defaultTaxRate
          ? (parseFloat(taxConfig.defaultTaxRate) * 100).toString()
          : ""
      );
    }
  }, [taxConfig]);

  const handleSubmit = async () => {
    setIsSubmitting(true);

    const payload = {
      autoTaxCalculation,
      defaultTaxRate:
        defaultTaxRate && !autoTaxCalculation
          ? (parseFloat(defaultTaxRate) / 100).toString()
          : undefined,
    };

    await updateTaxConfigMutation.mutateAsync(payload);
  };

  // Check if current settings differ from saved settings
  const hasUnsavedChanges = () => {
    if (!taxConfig) return false;
    const savedAutoTax = taxConfig.autoTaxCalculation ?? false;
    const savedDefaultRate = taxConfig.defaultTaxRate
      ? (parseFloat(taxConfig.defaultTaxRate) * 100).toString()
      : "";

    return (
      savedAutoTax !== autoTaxCalculation || savedDefaultRate !== defaultTaxRate
    );
  };

  // Check if nexus configuration is recent (within 24 hours)
  const isNexusConfigRecent = () => {
    if (!nexusConfigs || !Array.isArray(nexusConfigs)) return false;

    const enabledConfigs = nexusConfigs.filter(
      (config: NexusConfig) => config.hasNexus
    );
    if (enabledConfigs.length === 0) return false;

    // Find the most recent update
    const mostRecentUpdate = enabledConfigs.reduce((latest, config) => {
      const configDate = new Date(config.updatedAt);
      return configDate > latest ? configDate : latest;
    }, new Date(0));

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return mostRecentUpdate > oneDayAgo;
  };

  // Determine if we should show the nexus wizard when switching to automatic
  const shouldShowNexusWizard = () => {
    if (!merchant?.country || merchant.country !== "US") return false;
    if (!nexusConfigs || !Array.isArray(nexusConfigs)) return true;

    const hasExistingNexus = nexusConfigs.some(
      (config: NexusConfig) => config.hasNexus
    );

    // Show wizard if no existing nexus OR if nexus config is older than 24 hours
    return !hasExistingNexus || !isNexusConfigRecent();
  };

  if (isLoading || isLoadingDodo) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  // If Dodo configuration exists, show Dodo-specific message
  if (dodoConfig) {
    return (
      <div className="max-w-4xl w-full mx-auto p-6">
        <div>
          <h1 className="text-3xl font-bold">Tax Settings</h1>
          <p className="text-muted-foreground mt-2">
            Configure how taxes are calculated and applied to your B2B invoices
          </p>
        </div>

        <Card className="mt-8">
          <CardContent className="p-8 text-center">
            <div className="space-y-4">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                <svg
                  className="w-8 h-8 text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-gray-900">
                  Tax Compliance Active
                </h2>
                <p className="text-gray-700 max-w-2xl mx-auto">
                  You are using Dodo Payments which is a Merchant of Record with
                  automatic tax calculation. There is no further action required
                  from your side to stay compliant.
                </p>
              </div>
              <div className="pt-4">
                <Badge
                  variant="secondary"
                  className="bg-green-100 text-green-800"
                >
                  Dodo Payments -{" "}
                  {dodoConfig.environment === "test" ? "Test" : "Live"}{" "}
                  Environment
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Use saved configuration for current status, not local state
  const currentAutoTax = taxConfig?.autoTaxCalculation ?? false;
  const currentDefaultRate = taxConfig?.defaultTaxRate
    ? (parseFloat(taxConfig.defaultTaxRate) * 100).toString()
    : "";

  return (
    <div className="max-w-4xl w-full mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Tax Settings</h1>
        <p className="text-muted-foreground mt-2">
          Configure how taxes are calculated and applied to your B2B invoices
        </p>
        <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-sm text-blue-900 mb-2">
            <strong>Note:</strong> Lumen currently provides built-in tax
            calculation for B2B transactions.
          </p>
          <p className="text-sm text-blue-800">
            For B2C taxes or more comprehensive B2B tax requirements, we support
            integration with external tax providers (TaxJar, Avalara, etc.).
            This feature is currently in development.{" "}
            <AuthenticatedContactModal context="external-tax-providers">
              <button className="text-blue-700 hover:text-blue-900 underline font-medium">
                Contact us to integrate with an external tax provider
              </button>
            </AuthenticatedContactModal>
            .
          </p>
        </div>
      </div>

      {/* Current Status */}
      <div className="flex items-center gap-3 mt-4">
        <span className="text-sm font-medium text-gray-700">
          Current method:
        </span>
        <Badge variant="secondary">
          {currentAutoTax ? "Automatic" : "Manual"}
        </Badge>
        {!currentAutoTax && currentDefaultRate && (
          <span className="text-sm font-medium text-gray-700">
            {currentDefaultRate}% default
          </span>
        )}
        {!currentAutoTax && !currentDefaultRate && (
          <span className="text-sm font-medium text-orange-700">
            0% default
          </span>
        )}
      </div>

      {/* Configuration Form */}
      <Card>
        <CardHeader>
          <CardTitle>Tax Calculation Method</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Method Selection */}
          <div className="space-y-3">
            {/* Selection Buttons */}
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-900">
                Tax method:
              </span>
              <div className="flex bg-gray-100 rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => setAutoTaxCalculation(false)}
                  className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                    !autoTaxCalculation
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Manual
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAutoTaxCalculation(true);
                    // Show nexus wizard for US merchants switching to automatic
                    // Only show if no recent nexus config exists
                    if (!autoTaxCalculation && shouldShowNexusWizard()) {
                      setShowNexusWizard(true);
                    }
                  }}
                  className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                    autoTaxCalculation
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Automatic
                </button>
              </div>
            </div>

            {/* Description */}
            <p className="text-sm text-gray-600">
              {autoTaxCalculation
                ? "Taxes are calculated automatically based on customer location and registrations."
                : "If no tax rate is set for any customer, then your default rate is used."}
            </p>
          </div>

          {/* US Nexus Configuration */}
          {autoTaxCalculation && merchant?.country === "US" && (
            <>
              {isLoadingNexus ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="ml-2 text-sm text-gray-600">
                    Loading nexus configuration...
                  </span>
                </div>
              ) : nexusConfigs &&
                nexusConfigs.some((config: NexusConfig) => config.hasNexus) ? (
                // Show current nexus states if any exist
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-gray-900">
                      Current Nexus States
                    </h3>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowNexusWizard(true)}
                      className="text-blue-700 border-blue-300 hover:bg-blue-100"
                    >
                      Update Nexus States
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {nexusConfigs
                      .filter((config: NexusConfig) => config.hasNexus)
                      .map((config: NexusConfig) => {
                        const stateInfo = usStates.find(
                          (s: { value: string; label: string }) =>
                            s.value === config.state
                        );
                        return (
                          <div
                            key={config.state}
                            className="flex items-center justify-between p-3 border border-gray-200 rounded-lg"
                          >
                            <div className="flex items-center gap-3">
                              <span className="font-medium text-gray-900">
                                {stateInfo?.label || config.state}
                              </span>
                              <div className="flex gap-1">
                                {config.nexusType === "physical" && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs bg-purple-100 text-purple-700"
                                  >
                                    Physical
                                  </Badge>
                                )}
                                {config.nexusType === "economic" && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs bg-orange-100 text-orange-700"
                                  >
                                    Economic
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <div className="text-xs text-gray-500">
                              {config.hasEmployees && "Employees • "}
                              {config.hasOffices && "Offices • "}
                              {config.nexusType === "economic" &&
                                "Sales threshold met"}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ) : (
                // Show configure box if no nexus states exist
                <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm font-medium text-blue-900 mb-2">
                    US Tax Setup
                  </p>
                  <p className="text-sm text-blue-700 mb-3">
                    To ensure accurate tax calculation, configure which states
                    you have tax nexus in.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowNexusWizard(true)}
                    className="text-blue-700 border-blue-300 hover:bg-blue-100"
                  >
                    Configure State Tax Nexus
                  </Button>
                </div>
              )}
            </>
          )}

          {/* Manual Tax Configuration */}
          {!autoTaxCalculation && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor="default-tax-rate"
                    className="text-sm font-medium text-gray-900"
                  >
                    Default rate:
                  </Label>
                  <div className="flex items-center gap-1">
                    <Input
                      id="default-tax-rate"
                      type="text"
                      inputMode="decimal"
                      pattern="[0-9]*\.?[0-9]*"
                      value={defaultTaxRate}
                      onChange={(e) => {
                        const value = e.target.value;
                        // Only allow numbers and single decimal point
                        if (value === "" || /^\d*\.?\d*$/.test(value)) {
                          setDefaultTaxRate(value);
                          validateTaxRate(value);
                        }
                      }}
                      placeholder="0.00"
                      className="w-20 h-8 text-sm"
                    />
                    <span className="text-sm text-gray-700">%</span>
                  </div>
                </div>
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="w-4 h-4 text-gray-400 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs">
                      <p>
                        Applied to all invoices unless customer has specific
                        rate. Set customer rates when creating customers.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {!defaultTaxRate && (
                  <span className="text-xs text-orange-700">
                    (0% on new invoices)
                  </span>
                )}
              </div>

              {taxRateError && (
                <div className="text-xs text-red-600 mt-1">{taxRateError}</div>
              )}
            </div>
          )}

          {/* Save Button */}
          <div className="flex justify-end pt-3">
            <div className="flex items-center gap-4">
              {hasUnsavedChanges() && (
                <p className="text-sm text-orange-700 font-medium">
                  You have unsaved changes
                </p>
              )}
              <Button
                onClick={handleSubmit}
                disabled={
                  isSubmitting || !hasUnsavedChanges() || !!taxRateError
                }
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Configuration"
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tax Rate Definitions Management */}
      <TaxRateDefinitionsManager />

      {/* Nexus Wizard for US merchants */}
      {showNexusWizard && merchant?.country === "US" && (
        <NexusWizard
          onComplete={(nexusStates) => {
            // Extract states with nexus from the Map
            const statesWithNexus = Array.from(nexusStates.entries())
              .filter(([, info]) => info.physical || info.economic)
              .map(([state]) => state);

            // Update nexus configuration for each state
            updateNexusMutation.mutate({
              recommendedStates: statesWithNexus,
              nexusMap: nexusStates,
            });
            setShowNexusWizard(false);
          }}
          onClose={() => setShowNexusWizard(false)}
        />
      )}
    </div>
  );
}
