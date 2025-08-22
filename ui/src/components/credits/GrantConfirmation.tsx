"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  CheckCircle,
  Calendar,
  FileText,
  User,
  CreditCard,
} from "lucide-react";
import { format } from "date-fns";
import { formatCurrency } from "@/lib/utils";
import type {
  AvailableCreditDefinition,
  NewCreditConfig,
  GrantConfig,
} from "./ManualCreditGrantModal";

interface GrantConfirmationProps {
  customerName: string;
  creditType: "extend" | "new";
  selectedDefinition?: AvailableCreditDefinition | null;
  newCreditConfig?: NewCreditConfig | null;
  grantConfig: GrantConfig;
  isLoading: boolean;
  onConfirm: () => void;
  onBack: () => void;
  onClose: () => void;
}

export function GrantConfirmation({
  customerName,
  creditType,
  selectedDefinition,
  newCreditConfig,
  grantConfig,
  isLoading,
  onConfirm,
  onBack,
  onClose,
}: GrantConfirmationProps) {
  const applicationType =
    selectedDefinition?.applicationType ||
    newCreditConfig?.applicationType ||
    "usage";
  const creditName =
    selectedDefinition?.name || newCreditConfig?.name || "Credit";

  const formatAmount = (amount: number, appType: string) => {
    if (appType === "monetary") {
      const currency =
        selectedDefinition?.currency || newCreditConfig?.currency || "USD";
      return formatCurrency(amount, currency);
    }
    return amount.toLocaleString();
  };

  const currentBalance =
    creditType === "extend" && selectedDefinition
      ? selectedDefinition.currentGrants.reduce(
          (sum, grant) => sum + grant.remainingAmount,
          0
        )
      : 0;

  return (
    <div className="space-y-6 w-[500px] max-w-[90vw] mx-auto">
      {/* Header */}
      <div className="text-center space-y-2">
        <h3 className="text-2xl font-bold text-foreground">
          Confirm Credit Grant
        </h3>
        <p className="text-muted-foreground">
          Review the details before granting credits.
        </p>
      </div>

      {/* Warning Alert */}
      <div className="flex items-center gap-3 p-4 bg-orange-50 border border-orange-200 rounded-lg">
        <AlertTriangle className="h-5 w-5 text-orange-600 flex-shrink-0" />
        <p className="text-sm text-orange-800">
          This action cannot be undone, but credits can be revoked if necessary.
        </p>
      </div>

      {/* Main Grant Summary */}
      <Card className="border-2 border-border/50 shadow-lg">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-600" />
            Grant Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Customer and Source */}
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <User className="h-4 w-4" />
                Customer
              </div>
              <div className="text-lg font-semibold text-foreground">
                {customerName}
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <CreditCard className="h-4 w-4" />
                Source
              </div>
              <div className="text-lg font-semibold text-foreground">
                {creditType === "extend" ? "Extend Existing" : "New Credit"}
              </div>
            </div>
          </div>

          {/* Grant Details */}
          <div className="pt-4 border-t border-border/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-base font-medium text-foreground">
                  {creditName}
                </span>
                <Badge
                  variant={
                    applicationType === "usage" ? "default" : "secondary"
                  }
                >
                  {applicationType === "usage" ? "Usage" : "Monetary"}
                </Badge>
              </div>
              <div className="text-2xl font-bold text-green-600">
                {formatAmount(grantConfig.amount, applicationType)}
              </div>
            </div>

            {/* Current vs New Balance for Extensions */}
            {creditType === "extend" && selectedDefinition && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-blue-800">Current Balance:</span>
                  <span className="font-medium text-blue-900">
                    {formatAmount(currentBalance, applicationType)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm mt-1">
                  <span className="text-blue-800">After Grant:</span>
                  <span className="font-bold text-blue-900">
                    {formatAmount(
                      currentBalance + grantConfig.amount,
                      applicationType
                    )}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Expiry Date */}
          {grantConfig.expiryDate && (
            <div className="pt-4 border-t border-border/50">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
                <Calendar className="h-4 w-4" />
                Expiry Date
              </div>
              <div className="text-base font-semibold text-foreground">
                {format(grantConfig.expiryDate, "EEEE, MMMM d, yyyy")}
              </div>
            </div>
          )}

          {/* Notes */}
          {grantConfig.notes && (
            <div className="pt-4 border-t border-border/50">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
                <FileText className="h-4 w-4" />
                Internal Notes
              </div>
              <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                {grantConfig.notes}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex justify-between items-center pt-4">
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={isLoading}
          className="text-muted-foreground h-12 px-6"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="flex space-x-3">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
            className="h-12 px-6"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isLoading}
            className="bg-green-600 hover:bg-green-700 h-12 px-8"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Granting...
              </>
            ) : (
              "Grant Credits Now"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
