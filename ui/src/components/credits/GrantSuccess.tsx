"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, Copy, Calendar, CreditCard, Hash } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

interface CreditGrant {
  id: string;
  initialAmount: number;
  remainingAmount: number;
  customerId: string;
  applicationType: "usage" | "monetary";
  source: string;
  status: string;
  createdAt: string;
}

interface CreditDefinition {
  id: string;
  name: string;
  description: string | null;
  applicationType: "usage" | "monetary";
  scope: "plan" | "merchant";
}

interface GrantSuccessProps {
  customerName: string;
  createdGrant: {
    creditGrant: CreditGrant;
    creditDefinition: CreditDefinition;
  };
  onClose: () => void;
  onGrantMore: () => void;
}

export function GrantSuccess({
  customerName,
  createdGrant,
  onClose,
  onGrantMore,
}: GrantSuccessProps) {
  const { creditGrant, creditDefinition } = createdGrant;

  const formatAmount = (amount: number, appType: string) => {
    if (appType === "monetary") {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(amount / 100);
    }
    return amount.toLocaleString();
  };

  const handleCopyGrantId = () => {
    navigator.clipboard.writeText(creditGrant.id);
    toast.success("Grant ID copied to clipboard");
  };

  return (
    <div className="space-y-6 w-[500px] max-w-[90vw] mx-auto">
      {/* Success Header */}
      <div className="text-center space-y-4">
        <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
          <CheckCircle className="h-8 w-8 text-green-600" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-foreground">
            Credits Granted Successfully
          </h2>
          <p className="text-muted-foreground">
            Credits have been successfully granted to{" "}
            <span className="font-semibold">{customerName}</span> and are now
            active in their account
          </p>
        </div>
      </div>

      {/* Grant Details Card */}
      <Card className="border-2 border-border/50 shadow-lg">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-semibold">
              Grant Details
            </CardTitle>
            <Badge
              variant="outline"
              className="bg-green-50 text-green-700 border-green-200"
            >
              Active
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Credit Type and Amount */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-base font-medium text-foreground">
                  {creditDefinition.name}
                </span>
                <Badge
                  variant={
                    creditGrant.applicationType === "usage"
                      ? "default"
                      : "secondary"
                  }
                >
                  {creditGrant.applicationType === "usage"
                    ? "Usage"
                    : "Monetary"}
                </Badge>
              </div>
            </div>
            <div className="text-2xl font-bold text-green-600">
              {formatAmount(
                creditGrant.initialAmount,
                creditGrant.applicationType
              )}
            </div>
          </div>

          {/* Grant ID */}
          <div className="pt-4 border-t border-border/50">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
              <Hash className="h-4 w-4" />
              Grant ID
            </div>
            <div className="flex items-center gap-3">
              <code className="text-sm bg-muted px-2 py-1 rounded font-mono text-foreground flex-1">
                {creditGrant.id}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCopyGrantId}
                className="h-8 px-3 text-xs"
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </Button>
            </div>
          </div>

          {/* Created Date */}
          <div className="pt-4 border-t border-border/50">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
              <Calendar className="h-4 w-4" />
              Created
            </div>
            <div className="text-base font-semibold text-foreground">
              {format(
                new Date(creditGrant.createdAt),
                "MMMM d, yyyy 'at' h:mm a"
              )}
            </div>
          </div>

          {/* Description */}
          {creditDefinition.description && (
            <div className="pt-4 border-t border-border/50">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
                <CreditCard className="h-4 w-4" />
                Description
              </div>
              <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                {creditDefinition.description}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex justify-between items-center pt-4">
        <Button variant="outline" onClick={onGrantMore} className="h-12 px-6">
          Grant More Credits
        </Button>
        <Button
          onClick={onClose}
          className="bg-green-600 hover:bg-green-700 h-12 px-8"
        >
          Close
        </Button>
      </div>
    </div>
  );
}
