"use client";

import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowRight, Plus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

interface CreditSelectionStepProps {
  onSelect: (creditType: "extend" | "new") => void;
}

export function CreditSelectionStep({ onSelect }: CreditSelectionStepProps) {
  return (
    <div className="space-y-4 w-[450px] max-w-[90vw] mx-auto">
      {/* Extend Existing Credits Card */}
      <Card
        className={cn(
          "group cursor-pointer transition-all duration-200",
          "hover:shadow-md hover:shadow-blue-500/10",
          "border border-border hover:border-blue-300",
          "bg-card hover:bg-blue-50/80"
        )}
        onClick={() => onSelect("extend")}
      >
        <CardContent className="flex items-center justify-between p-6">
          <div className="flex items-center space-x-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-blue-50 border border-blue-200 group-hover:bg-blue-100 group-hover:border-blue-300 transition-colors">
              <RotateCcw className="h-5 w-5 text-blue-600" />
            </div>
            <div className="space-y-1">
              <h4 className="font-semibold text-foreground leading-none">
                Extend Existing Credits
              </h4>
              <p className="text-sm text-muted-foreground">
                From active subscription plans or already granted manual credits
              </p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all" />
        </CardContent>
      </Card>

      {/* Grant New Credits Card */}
      <Card
        className={cn(
          "group cursor-pointer transition-all duration-200",
          "hover:shadow-md hover:shadow-emerald-500/10",
          "border border-border hover:border-emerald-300",
          "bg-card hover:bg-emerald-50/80"
        )}
        onClick={() => onSelect("new")}
      >
        <CardContent className="flex items-center justify-between p-6">
          <div className="flex items-center space-x-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-emerald-50 border border-emerald-200 group-hover:bg-emerald-100 group-hover:border-emerald-300 transition-colors">
              <Plus className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="space-y-1">
              <h4 className="font-semibold text-foreground leading-none">
                Grant New Credits
              </h4>
              <p className="text-sm text-muted-foreground">
                Create custom credit grants
              </p>
            </div>
          </div>
          <ArrowRight className="h-5 w-5 text-muted-foreground group-hover:text-emerald-600 group-hover:translate-x-0.5 transition-all" />
        </CardContent>
      </Card>
    </div>
  );
}
