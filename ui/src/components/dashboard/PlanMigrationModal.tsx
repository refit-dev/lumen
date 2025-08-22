"use client";

import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Loader2, Users, AlertTriangle, Info, Check } from "lucide-react";
import { apiClient } from "@/lib/hono-client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

interface PlanMigrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The plan's stablePlanId shared across versions */
  stablePlanId: string;
  /** Total number of active subscriptions across all versions */
  activeSubscriptionsCount: number;
  /** The source (current) version number subscribers are on */
  fromVersion: number;
  /** The target version number created after editing */
  toVersion: number;
  /** Mapping of source priceId -> target priceId to use during migration */
  priceMapping: Record<string, string>;
  migrationAnalysis: {
    hasFeatureChanges: boolean;
    hasPriceChanges: boolean;
    hasNumericFeatureChanges: boolean;
    recommendedStrategy: "immediate" | "next_billing_cycle" | "edit_in_place";
    canUseImmediate: boolean;
  };
}

type MigrationStrategy = "immediate" | "next_billing_cycle" | "do_not_migrate";

export function PlanMigrationModal({
  isOpen,
  onClose,
  stablePlanId,
  activeSubscriptionsCount,
  fromVersion,
  toVersion,
  priceMapping,
  migrationAnalysis,
}: PlanMigrationModalProps) {
  // Set default to first available strategy
  const getDefaultStrategy = (): MigrationStrategy => {
    if (migrationAnalysis.recommendedStrategy === "edit_in_place") {
      return "do_not_migrate";
    }

    // If immediate migration is not available (e.g., due to price changes),
    // default to next_billing_cycle regardless of what's recommended
    if (!migrationAnalysis.canUseImmediate) {
      return "next_billing_cycle";
    }

    // If immediate is available, use the recommended strategy
    return migrationAnalysis.recommendedStrategy;
  };

  const [selectedStrategy, setSelectedStrategy] =
    useState<MigrationStrategy>(getDefaultStrategy());
  const [isProcessing, setIsProcessing] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  // Reset strategy whenever modal opens or pertinent analysis data changes
  useEffect(() => {
    if (isOpen) {
      setSelectedStrategy(getDefaultStrategy());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    migrationAnalysis.canUseImmediate,
    migrationAnalysis.recommendedStrategy,
  ]);

  const handleMigrate = async () => {
    if (selectedStrategy === "do_not_migrate") {
      toast.success(
        "Plan updated successfully. Existing subscribers will remain on their current plan versions."
      );
      // Remove migration-related query parameters from URL
      const url = new URL(window.location.href);
      url.searchParams.delete("showMigration");
      url.searchParams.delete("fromVersion");
      url.searchParams.delete("toVersion");
      router.replace(url.pathname + url.search);
      onClose();
      return;
    }

    setIsProcessing(true);

    try {
      const response = await apiClient.plans[":stablePlanId"]["migrate"].$post({
        param: { stablePlanId },
        json: {
          strategy: selectedStrategy,
          fromVersion,
          toVersion,
          priceMapping,
        },
      });

      const result = await response.json();

      if ("error" in result) {
        throw new Error(result.error);
      }

      if (response.status === 202) {
        toast.success(
          result.message ||
            "Migration task has been enqueued and will process in the background."
        );
      } else {
        toast.success(result.message || "Migration completed successfully.");
      }

      // Invalidate queries to update UI
      queryClient.invalidateQueries({
        queryKey: ["scheduled-migrations"],
      });
      queryClient.invalidateQueries({
        queryKey: ["incoming-migrations"],
      });
      queryClient.invalidateQueries({
        queryKey: ["subscriptions"],
      });
      queryClient.invalidateQueries({
        queryKey: ["plan-versions"],
      });

      // Remove migration-related query parameters from URL
      const url = new URL(window.location.href);
      url.searchParams.delete("showMigration");
      url.searchParams.delete("fromVersion");
      url.searchParams.delete("toVersion");
      router.replace(url.pathname + url.search);

      onClose();
    } catch (error) {
      console.error("Migration error:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to start migration"
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const getStrategyInfo = (strategy: MigrationStrategy) => {
    switch (strategy) {
      case "immediate":
        return {
          title: "Immediate Migration",
          description:
            "Subscribers are moved to the new plan version right now",
          warning: migrationAnalysis.hasNumericFeatureChanges
            ? "Full credit allowances will be granted for numeric features"
            : null,
        };
      case "next_billing_cycle":
        return {
          title: "Next Billing Cycle",
          description:
            "Subscribers are moved at the start of their next billing period",
          warning: null,
        };
      case "do_not_migrate":
        return {
          title: "Keep Legacy Subscribers",
          description:
            "Existing subscribers stay on their current plan version indefinitely",
          warning: null,
        };
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Migrate Existing Subscribers
          </DialogTitle>
          <DialogDescription>
            You have <strong>{activeSubscriptionsCount}</strong> active
            subscriber
            {activeSubscriptionsCount !== 1 ? "s" : ""} on version {fromVersion}
            . How would you like to migrate them to version {toVersion}?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Migration Analysis */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Changes Detected:</h4>
            <div className="flex flex-wrap gap-2">
              {migrationAnalysis.hasFeatureChanges && (
                <Badge variant="outline" className="text-xs">
                  Feature Changes
                </Badge>
              )}
              {migrationAnalysis.hasPriceChanges && (
                <Badge variant="outline" className="text-xs">
                  Price Changes
                </Badge>
              )}
              {migrationAnalysis.hasNumericFeatureChanges && (
                <Badge variant="outline" className="text-xs">
                  Usage/Credit Changes
                </Badge>
              )}
            </div>
          </div>

          {/* Strategy Selection */}
          <div className="space-y-4">
            <Label className="text-sm font-medium">Migration Strategy:</Label>
            <div className="space-y-3">
              {/* Immediate Migration */}
              <div
                className={`
                  relative cursor-pointer rounded-lg border-2 p-4 transition-all
                  ${
                    selectedStrategy === "immediate"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300"
                  }
                  ${
                    !migrationAnalysis.canUseImmediate
                      ? "cursor-not-allowed opacity-50"
                      : ""
                  }
                `}
                onClick={() => {
                  if (migrationAnalysis.canUseImmediate) {
                    setSelectedStrategy("immediate");
                  }
                }}
              >
                <div className="flex items-start space-x-3">
                  <div
                    className={`
                      mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center
                      ${
                        selectedStrategy === "immediate"
                          ? "border-blue-500 bg-blue-500"
                          : "border-gray-300"
                      }
                    `}
                  >
                    {selectedStrategy === "immediate" && (
                      <Check className="h-2.5 w-2.5 text-white" />
                    )}
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center">
                      <Label className="font-medium cursor-pointer">
                        {getStrategyInfo("immediate").title}
                      </Label>
                      {migrationAnalysis.recommendedStrategy ===
                        "immediate" && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          Recommended
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-gray-600">
                      {getStrategyInfo("immediate").description}
                    </p>
                    {!migrationAnalysis.canUseImmediate && (
                      <Alert className="mt-2">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription className="text-xs">
                          Not available when price changes are detected
                        </AlertDescription>
                      </Alert>
                    )}
                    {getStrategyInfo("immediate").warning && (
                      <Alert className="mt-2">
                        <Info className="h-4 w-4" />
                        <AlertDescription className="text-xs">
                          {getStrategyInfo("immediate").warning}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </div>
              </div>

              {/* Next Billing Cycle */}
              <div
                className={`
                  relative cursor-pointer rounded-lg border-2 p-4 transition-all
                  ${
                    selectedStrategy === "next_billing_cycle"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300"
                  }
                `}
                onClick={() => setSelectedStrategy("next_billing_cycle")}
              >
                <div className="flex items-start space-x-3">
                  <div
                    className={`
                      mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center
                      ${
                        selectedStrategy === "next_billing_cycle"
                          ? "border-blue-500 bg-blue-500"
                          : "border-gray-300"
                      }
                    `}
                  >
                    {selectedStrategy === "next_billing_cycle" && (
                      <Check className="h-2.5 w-2.5 text-white" />
                    )}
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center">
                      <Label className="font-medium cursor-pointer">
                        {getStrategyInfo("next_billing_cycle").title}
                      </Label>
                      {migrationAnalysis.recommendedStrategy ===
                        "next_billing_cycle" && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          Recommended
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-gray-600">
                      {getStrategyInfo("next_billing_cycle").description}
                    </p>
                  </div>
                </div>
              </div>

              {/* Do Not Migrate */}
              <div
                className={`
                  relative cursor-pointer rounded-lg border-2 p-4 transition-all
                  ${
                    selectedStrategy === "do_not_migrate"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300"
                  }
                `}
                onClick={() => setSelectedStrategy("do_not_migrate")}
              >
                <div className="flex items-start space-x-3">
                  <div
                    className={`
                      mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center
                      ${
                        selectedStrategy === "do_not_migrate"
                          ? "border-blue-500 bg-blue-500"
                          : "border-gray-300"
                      }
                    `}
                  >
                    {selectedStrategy === "do_not_migrate" && (
                      <Check className="h-2.5 w-2.5 text-white" />
                    )}
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label className="font-medium cursor-pointer">
                      {getStrategyInfo("do_not_migrate").title}
                    </Label>
                    <p className="text-sm text-gray-600">
                      {getStrategyInfo("do_not_migrate").description}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isProcessing}>
            Cancel
          </Button>
          <Button onClick={handleMigrate} disabled={isProcessing}>
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              "Apply Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
