"use client";

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Calendar,
  DollarSign,
  Hash,
  AlertCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format } from "date-fns";
import {
  formatCurrency,
  parseCurrencyToCents,
  getCurrencySymbol,
} from "@/lib/utils";
import type {
  AvailableCreditDefinition,
  NewCreditConfig,
  GrantConfig,
} from "./ManualCreditGrantModal";

interface GrantConfiguratorProps {
  creditDefinition?: AvailableCreditDefinition | null;
  newCreditConfig?: NewCreditConfig | null;
  limits?: {
    MIN_USAGE_AMOUNT: number;
    MAX_USAGE_AMOUNT: number;
    MIN_MONETARY_AMOUNT_CENTS: number;
    MAX_MONETARY_AMOUNT_CENTS: number;
  };
  config: GrantConfig;
  onChange: (config: GrantConfig) => void;
  onNext: (config: GrantConfig) => void;
  onBack: () => void;
  onClose: () => void;
}

export function GrantConfigurator({
  creditDefinition,
  newCreditConfig,
  limits,
  config,
  onChange,
  onNext,
  onBack,
  onClose,
}: GrantConfiguratorProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expiryType, setExpiryType] = useState<"none" | "date">("none");
  const [displayAmount, setDisplayAmount] = useState<string>("");
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});

  // Determine if this is usage or monetary credits
  const applicationType =
    creditDefinition?.applicationType ||
    newCreditConfig?.applicationType ||
    "usage";
  const creditName =
    creditDefinition?.name || newCreditConfig?.name || "Credit";

  useEffect(() => {
    if (config.expiryDate) {
      setExpiryType("date");
    } else {
      setExpiryType("none");
    }
  }, [config.expiryDate]);

  const validateConfig = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (inputErrors.amount) {
      newErrors.amount = inputErrors.amount;
    } else if (!config.amount || config.amount <= 0) {
      newErrors.amount = "Amount must be greater than 0";
    } else if (limits) {
      if (applicationType === "usage") {
        if (
          config.amount < limits.MIN_USAGE_AMOUNT ||
          config.amount > limits.MAX_USAGE_AMOUNT
        ) {
          newErrors.amount = `Amount must be between ${limits.MIN_USAGE_AMOUNT.toLocaleString()} and ${limits.MAX_USAGE_AMOUNT.toLocaleString()}`;
        }
      } else if (applicationType === "monetary") {
        if (
          config.amount < limits.MIN_MONETARY_AMOUNT_CENTS ||
          config.amount > limits.MAX_MONETARY_AMOUNT_CENTS
        ) {
          const currency =
            creditDefinition?.currency || newCreditConfig?.currency || "USD";
          const minFormatted = formatCurrency(
            limits.MIN_MONETARY_AMOUNT_CENTS,
            currency
          );
          const maxFormatted = formatCurrency(
            limits.MAX_MONETARY_AMOUNT_CENTS,
            currency
          );
          newErrors.amount = `Amount must be between ${minFormatted} and ${maxFormatted}`;
        }
      }
    }

    if (expiryType === "date" && !config.expiryDate) {
      newErrors.expiryDate = "Please select an expiry date";
    }

    if (config.expiryDate && config.expiryDate <= new Date()) {
      newErrors.expiryDate = "Expiry date must be in the future";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleContinue = () => {
    if (validateConfig()) {
      onNext(config);
    }
  };

  const updateConfig = (
    field: keyof GrantConfig,
    value: number | Date | string | null
  ) => {
    const newConfig = { ...config, [field]: value };
    onChange(newConfig);

    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
  };

  const handleExpiryTypeChange = (type: "none" | "date") => {
    setExpiryType(type);
    if (type === "none") {
      updateConfig("expiryDate", null);
    }
  };

  const handleAmountChange = (inputValue: string) => {
    setDisplayAmount(inputValue);
    setInputErrors((prev) => ({ ...prev, amount: "" }));

    if (applicationType === "monetary") {
      const parseResult = parseCurrencyToCents(inputValue);

      if (!parseResult.isValid && inputValue.trim() !== "") {
        setInputErrors((prev) => ({
          ...prev,
          amount: parseResult.error || "Invalid input",
        }));
        return;
      }

      updateConfig("amount", parseResult.amount);
    } else {
      if (inputValue.trim() !== "") {
        const amount = parseFloat(inputValue);
        if (isNaN(amount)) {
          setInputErrors((prev) => ({
            ...prev,
            amount: "Please enter a valid number",
          }));
          return;
        }
        if (amount < 0) {
          setInputErrors((prev) => ({
            ...prev,
            amount: "Amount cannot be negative",
          }));
          return;
        }
        if (amount > 1000000) {
          setInputErrors((prev) => ({
            ...prev,
            amount: "Amount too large (max 1,000,000)",
          }));
          return;
        }
        updateConfig("amount", amount);
      } else {
        updateConfig("amount", 0);
      }
    }
  };

  useEffect(() => {
    if (config.amount > 0 && displayAmount === "") {
      if (applicationType === "monetary") {
        const displayValue = (config.amount / 100).toString();
        setDisplayAmount(displayValue);
      } else {
        setDisplayAmount(config.amount.toString());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatAmount = (amount: number, appType: string) => {
    if (appType === "monetary") {
      const currency =
        creditDefinition?.currency || newCreditConfig?.currency || "USD";
      return formatCurrency(amount, currency);
    }
    return amount.toLocaleString();
  };

  return (
    <div className="space-y-8 w-[700px] max-w-[90vw] mx-auto">
      {/* Header */}
      <div className="text-center space-y-4">
        <h3 className="text-2xl font-bold text-foreground">
          Configure Credit Grant
        </h3>
        <div className="flex items-center justify-center space-x-4">
          <p className="text-lg text-muted-foreground">{creditName}</p>
          <Badge variant="outline" className="text-sm font-medium px-3 py-1">
            {applicationType === "usage" ? "Usage" : "Monetary"} Credits
          </Badge>
        </div>
      </div>

      {/* Main configuration form */}
      <Card className="border-2 border-border/50 shadow-lg">
        <CardContent className="p-8">
          <div className="space-y-8">
            {/* Amount Configuration */}
            <div className="space-y-6">
              <div className="flex items-center space-x-3">
                {applicationType === "monetary" ? (
                  <DollarSign className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <Hash className="h-5 w-5 text-muted-foreground" />
                )}
                <Label
                  htmlFor="amount"
                  className="text-base font-semibold text-foreground"
                >
                  {applicationType === "monetary"
                    ? "Amount to Grant"
                    : "Number of Credits"}
                  {applicationType === "monetary" && (
                    <span className="text-muted-foreground ml-2 font-normal text-sm">
                      (
                      {creditDefinition?.currency ||
                        newCreditConfig?.currency ||
                        "USD"}
                      )
                    </span>
                  )}
                </Label>
              </div>

              <div className="space-y-3">
                <div className="relative">
                  {applicationType === "monetary" && (
                    <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-muted-foreground text-base">
                      {getCurrencySymbol(
                        creditDefinition?.currency ||
                          newCreditConfig?.currency ||
                          "USD"
                      )}
                    </span>
                  )}
                  <Input
                    id="amount"
                    type="text"
                    value={displayAmount}
                    onChange={(e) => handleAmountChange(e.target.value)}
                    placeholder={
                      applicationType === "monetary" ? "25.00" : "150"
                    }
                    className={`h-14 text-lg font-medium bg-white ${
                      applicationType === "monetary" ? "pl-12" : "pl-4"
                    } ${errors.amount || inputErrors.amount ? "border-destructive" : "border-border"}`}
                  />
                </div>

                {(errors.amount || inputErrors.amount) && (
                  <div className="flex items-start space-x-3 p-4 bg-destructive/5 border border-destructive/20 rounded-lg">
                    <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-destructive">
                      {errors.amount || inputErrors.amount}
                    </p>
                  </div>
                )}

                {config.amount > 0 && !inputErrors.amount && (
                  <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                    <p className="text-sm text-emerald-800 font-medium">
                      Will grant: {formatAmount(config.amount, applicationType)}
                      {applicationType === "usage" && " credits"}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Expiry Configuration */}
            <div className="space-y-6 pt-6 border-t border-border/50">
              <div className="flex items-center space-x-3">
                <Calendar className="h-5 w-5 text-muted-foreground" />
                <Label className="text-base font-semibold text-foreground">
                  Credit Expiry
                </Label>
              </div>

              <div className="space-y-4">
                <Select
                  value={expiryType}
                  onValueChange={handleExpiryTypeChange}
                >
                  <SelectTrigger className="h-12 text-base bg-white">
                    <SelectValue placeholder="Select expiry type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Never expires</SelectItem>
                    <SelectItem value="date">Set expiry date</SelectItem>
                  </SelectContent>
                </Select>

                {expiryType === "date" && (
                  <div className="space-y-3">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className={`w-full justify-start text-left h-12 bg-white text-base ${
                            errors.expiryDate
                              ? "border-destructive"
                              : "border-border"
                          }`}
                        >
                          <Calendar className="mr-3 h-5 w-5" />
                          {config.expiryDate
                            ? format(config.expiryDate, "MMMM d, yyyy")
                            : "Select expiry date"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <CalendarComponent
                          mode="single"
                          selected={config.expiryDate || undefined}
                          onSelect={(date) =>
                            updateConfig("expiryDate", date || null)
                          }
                          disabled={(date) => date <= new Date()}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    {errors.expiryDate && (
                      <div className="flex items-start space-x-3 p-4 bg-destructive/5 border border-destructive/20 rounded-lg">
                        <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
                        <p className="text-sm text-destructive">
                          {errors.expiryDate}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Notes Configuration */}
            <div className="space-y-6 pt-6 border-t border-border/50">
              <Label
                htmlFor="notes"
                className="text-base font-semibold text-foreground"
              >
                Internal Notes
              </Label>
              <div className="space-y-3">
                <Textarea
                  id="notes"
                  value={config.notes}
                  onChange={(e) => updateConfig("notes", e.target.value)}
                  placeholder="e.g., Customer exceeded limit during integration testing"
                  rows={6}
                  className="resize-none bg-white text-base leading-relaxed"
                />
                <p className="text-sm text-muted-foreground leading-relaxed">
                  These notes are for internal tracking only and will not be
                  visible to the customer.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex justify-between items-center pt-6">
        <Button
          variant="ghost"
          onClick={onBack}
          className="text-muted-foreground h-12 px-6"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="flex space-x-4">
          <Button variant="outline" onClick={onClose} className="h-12 px-6">
            Cancel
          </Button>
          <Button
            onClick={handleContinue}
            className="bg-foreground hover:bg-foreground/90 h-12 px-8"
          >
            Continue to Review
          </Button>
        </div>
      </div>
    </div>
  );
}
