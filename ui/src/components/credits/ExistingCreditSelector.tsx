"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ArrowRight,
  CreditCard,
  Coins,
  DollarSign,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { AvailableCreditDefinition } from "./ManualCreditGrantModal";

interface ExistingCreditSelectorProps {
  availableDefinitions: AvailableCreditDefinition[];
  isLoading: boolean;
  onSelect: (definition: AvailableCreditDefinition) => void;
  onBack: () => void;
  onClose: () => void;
}

export function ExistingCreditSelector({
  availableDefinitions,
  isLoading,
  onSelect,
  onBack,
  onClose,
}: ExistingCreditSelectorProps) {
  // Deduplicate definitions by ID to avoid duplicate React keys
  const uniqueDefinitions = React.useMemo(() => {
    const seen = new Set<string>();
    return availableDefinitions.filter((def) => {
      if (seen.has(def.id)) return false;
      seen.add(def.id);
      return true;
    });
  }, [availableDefinitions]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          </div>
          <p className="text-muted-foreground">
            Loading available credit definitions...
          </p>
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="p-6">
              <div className="flex items-center space-x-4">
                <Skeleton className="h-11 w-11 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <Skeleton className="h-4 w-4" />
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (uniqueDefinitions.length === 0) {
    return (
      <div className="text-center py-16 space-y-6">
        <div className="mx-auto w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center">
          <CreditCard className="text-gray-400 h-8 w-8" />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-semibold text-foreground">
            No Credit Definitions Available
          </h3>
          <p className="text-muted-foreground max-w-md mx-auto">
            This customer doesn&apos;t have any credit definitions available to
            extend.
          </p>
        </div>
        <div className="flex justify-center space-x-3">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const formatAmount = (
    amount: number,
    applicationType: string,
    currency?: string
  ) => {
    if (applicationType === "monetary") {
      return formatCurrency(amount, currency || "USD");
    }
    return amount.toLocaleString();
  };

  const getBalanceText = (definition: AvailableCreditDefinition) => {
    const totalRemaining = definition.currentGrants.reduce(
      (sum, grant) => sum + grant.remainingAmount,
      0
    );
    const hasActiveGrants = definition.currentGrants.length > 0;

    if (!hasActiveGrants) {
      return {
        amount: "No active grants",
        subtitle: null,
        hasGrants: false,
      };
    }

    const formattedRemaining = formatAmount(
      totalRemaining,
      definition.applicationType,
      definition.currency || undefined
    );
    const activeGrantsCount = definition.currentGrants.length;

    return {
      amount: `${formattedRemaining} remaining`,
      subtitle: `${activeGrantsCount} active grant${activeGrantsCount !== 1 ? "s" : ""}`,
      hasGrants: true,
    };
  };

  return (
    <div className="space-y-6 w-[700px] max-w-[90vw] mx-auto">
      <div className="text-center space-y-2">
        <h3 className="text-xl font-semibold text-foreground">
          Select Credit Type to Extend
        </h3>
        <p className="text-muted-foreground">
          Choose from available credit definitions based on the customer&apos;s
          active subscription plans
        </p>
      </div>

      {/* Scrollable container for multiple credits */}
      <div className="max-h-96 overflow-y-auto space-y-4 pr-2">
        {uniqueDefinitions.map((definition) => {
          // Choose colors based on application type
          const isMonetary = definition.applicationType === "monetary";
          const colorClass = isMonetary
            ? "hover:shadow-emerald-500/10 border border-border hover:border-emerald-300 bg-card hover:bg-emerald-50/80"
            : "hover:shadow-blue-500/10 border border-border hover:border-blue-300 bg-card hover:bg-blue-50/80";
          const iconBgClass = isMonetary
            ? "bg-emerald-50 border-emerald-200 group-hover:bg-emerald-100 group-hover:border-emerald-300"
            : "bg-blue-50 border-blue-200 group-hover:bg-blue-100 group-hover:border-blue-300";
          const iconColorClass = isMonetary
            ? "text-emerald-600"
            : "text-blue-600";
          const arrowColorClass = isMonetary
            ? "group-hover:text-emerald-600"
            : "group-hover:text-blue-600";

          const balanceInfo = getBalanceText(definition);

          return (
            <Card
              key={definition.id}
              className={cn(
                "group cursor-pointer transition-all duration-200",
                "hover:shadow-md",
                colorClass
              )}
              onClick={() => onSelect(definition)}
            >
              <CardContent className="flex items-center justify-between p-6">
                <div className="flex items-center space-x-4">
                  <div
                    className={cn(
                      "flex h-11 w-11 items-center justify-center rounded-lg border transition-colors",
                      iconBgClass
                    )}
                  >
                    {isMonetary ? (
                      <DollarSign className={cn("h-5 w-5", iconColorClass)} />
                    ) : (
                      <Coins className={cn("h-5 w-5", iconColorClass)} />
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                      <h4 className="font-semibold text-foreground leading-none">
                        {definition.name}
                      </h4>
                      <Badge variant="outline" className="text-xs">
                        {isMonetary ? "Monetary" : "Usage"}
                      </Badge>
                    </div>
                    <div className="space-y-0.5">
                      <p
                        className={cn(
                          "font-medium leading-none",
                          balanceInfo.hasGrants
                            ? "text-foreground text-base"
                            : "text-muted-foreground text-sm"
                        )}
                      >
                        {balanceInfo.amount}
                      </p>
                      {balanceInfo.subtitle && (
                        <p className="text-xs text-muted-foreground">
                          {balanceInfo.subtitle}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <ArrowRight
                  className={cn(
                    "h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-all",
                    arrowColorClass
                  )}
                />
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Action buttons */}
      <div className="flex justify-between pt-4 border-t">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
