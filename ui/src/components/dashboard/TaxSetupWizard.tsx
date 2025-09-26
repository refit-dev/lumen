"use client";

import { useState, useMemo, type JSX } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { AuthenticatedContactModal } from "@/components/ContactUsModal";

type WizardMethod = "auto" | "single" | "manual";
type Audience = "b2b" | "b2b_b2c";

export type TaxWizardSubmission = {
  autoTaxCalculation: boolean;
  defaultTaxRate?: string; // decimal string between 0 and 1
};

export function TaxSetupWizard(props: {
  open: boolean;
  merchantCountry?: string | null;
  onSubmit: (payload: TaxWizardSubmission) => Promise<void>;
  onFinished: () => void;
  isSaving?: boolean;
}): JSX.Element {
  const { open, onSubmit, onFinished, isSaving, merchantCountry } = props;

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [audience, setAudience] = useState<Audience>("b2b");
  const [method, setMethod] = useState<WizardMethod>("auto");
  const [defaultRatePercent, setDefaultRatePercent] = useState<string>("");
  const [ackAutoConsumerZero, setAckAutoConsumerZero] =
    useState<boolean>(false);
  const [ackManualZeroDefault, setAckManualZeroDefault] =
    useState<boolean>(false);
  const [rateError, setRateError] = useState<string>("");
  const [ackError, setAckError] = useState<string>("");

  const requiresConsumerAck = useMemo(() => method === "auto", [method]);
  const requiresManualAck = useMemo(() => method === "manual", [method]);

  const validateRate = (value: string): boolean => {
    if (!value || value.trim() === "") {
      setRateError("Please enter a rate");
      return false;
    }
    const num = Number(value);
    if (Number.isNaN(num)) {
      setRateError("Enter a valid number");
      return false;
    }
    if (num < 0) {
      setRateError("Rate cannot be negative");
      return false;
    }
    if (num > 100) {
      setRateError("Rate cannot exceed 100%");
      return false;
    }
    setRateError("");
    return true;
  };

  // Previously used to disable Continue; now we validate on click for clarity.

  // Summary text is presented in a structured grid in Step 3 for readability

  const handleSave = async () => {
    const payload: TaxWizardSubmission =
      method === "auto"
        ? { autoTaxCalculation: true }
        : method === "single"
          ? {
              autoTaxCalculation: false,
              defaultTaxRate: (Number(defaultRatePercent) / 100).toString(),
            }
          : {
              // manual advanced: mark configured with 0% default so onboarding recognizes intent
              autoTaxCalculation: false,
              defaultTaxRate: "0",
            };
    await onSubmit(payload);
    onFinished();
  };

  const handleContinueStep2 = () => {
    setAckError("");
    if (method === "single") {
      if (!validateRate(defaultRatePercent)) {
        return;
      }
      setStep(3);
      return;
    }
    if (method === "auto") {
      if (requiresConsumerAck && !ackAutoConsumerZero) {
        setAckError(
          "Please acknowledge B2C customers will be charged 0% by default."
        );
        return;
      }
      setStep(3);
      return;
    }
    if (method === "manual") {
      if (requiresManualAck && !ackManualZeroDefault) {
        setAckError(
          "Please acknowledge the default rate will be 0% until you assign rates."
        );
        return;
      }
      setStep(3);
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Set up how you handle taxes</DialogTitle>
        </DialogHeader>
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Who do you sell to?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <RadioGroup
                value={audience}
                onValueChange={(v) => setAudience(v as Audience)}
              >
                <div
                  className={`p-3 border rounded-lg ${audience === "b2b" ? "border-blue-300 bg-blue-50" : ""}`}
                  onClick={() => setAudience("b2b")}
                  role="button"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id="aud-b2b" value="b2b" />
                    <Label htmlFor="aud-b2b">Businesses (B2B)</Label>
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Tax IDs and business names are common.
                  </div>
                </div>
                <div
                  className={`mt-2 p-3 border rounded-lg ${audience === "b2b_b2c" ? "border-blue-300 bg-blue-50" : ""}`}
                  onClick={() => setAudience("b2b_b2c")}
                  role="button"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id="aud-b2c" value="b2b_b2c" />
                    <Label htmlFor="aud-b2c">
                      Businesses and consumers (B2C)
                    </Label>
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    We will not calculate B2C taxes. B2C customers are 0% by
                    default unless you integrate a provider.
                  </div>
                </div>
              </RadioGroup>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setStep(2)}>Continue</Button>
              </div>
            </CardContent>
          </Card>
        )}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Choose a tax method</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-3">
                <RadioGroup
                  value={method}
                  onValueChange={(v) => setMethod(v as WizardMethod)}
                >
                  <div
                    className={`p-4 border rounded-lg ${method === "auto" ? "border-blue-300 bg-blue-50" : ""}`}
                    onClick={() => {
                      setMethod("auto");
                      setAckError("");
                    }}
                    role="button"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <RadioGroupItem id="m-auto" value="auto" />
                        <Label htmlFor="m-auto">Automatic (B2B only)</Label>
                        <Badge variant="secondary">Recommended</Badge>
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      We detect business customers and calculate by location.
                      B2C customers are charged 0% by default.
                    </div>
                    {method === "auto" && (
                      <>
                        {ackError && (
                          <div className="mt-3 mb-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                            {ackError}
                          </div>
                        )}
                        <div className="mt-3 flex items-center gap-2">
                          <Checkbox
                            id="ack-auto"
                            checked={ackAutoConsumerZero}
                            onCheckedChange={(v) =>
                              setAckAutoConsumerZero(Boolean(v))
                            }
                          />
                          <Label
                            htmlFor="ack-auto"
                            className="text-sm text-gray-700"
                          >
                            I understand B2C customers will be charged 0% by
                            default
                          </Label>
                        </div>
                      </>
                    )}
                  </div>

                  <div
                    className={`p-4 border rounded-lg ${method === "single" ? "border-blue-300 bg-blue-50" : ""}`}
                    onClick={() => {
                      setMethod("single");
                      setAckError("");
                    }}
                    role="button"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem id="m-single" value="single" />
                      <Label htmlFor="m-single">Single default rate</Label>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      Use one rate when your customers share the same tax rate
                      (e.g., selling in one country). You can override per
                      customer.
                    </div>
                    {method === "single" && (
                      <div className="mt-3 flex items-center gap-2">
                        <Label htmlFor="rate" className="text-sm">
                          Rate
                        </Label>
                        <Input
                          id="rate"
                          value={defaultRatePercent}
                          onChange={(e) =>
                            setDefaultRatePercent(e.target.value)
                          }
                          onBlur={(e) => validateRate(e.target.value)}
                          placeholder="0.00"
                          className="w-24 h-8 text-sm"
                          inputMode="decimal"
                        />
                        <span className="text-sm">%</span>
                        {rateError && (
                          <span className="text-xs text-red-600 ml-2">
                            {rateError}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div
                    className={`p-4 border rounded-lg ${method === "manual" ? "border-blue-300 bg-blue-50" : ""}`}
                    onClick={() => {
                      setMethod("manual");
                      setAckError("");
                    }}
                    role="button"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem id="m-manual" value="manual" />
                      <Label htmlFor="m-manual">Advanced manual rates</Label>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      Create country-specific rates and assign per customer.
                      Unassigned customers will use a 0% default.
                    </div>
                    {method === "manual" && (
                      <>
                        {ackError && (
                          <div className="mt-3 mb-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                            {ackError}
                          </div>
                        )}
                        <div className="mt-3 flex items-center gap-2">
                          <Checkbox
                            id="ack-manual"
                            checked={ackManualZeroDefault}
                            onCheckedChange={(v) =>
                              setAckManualZeroDefault(Boolean(v))
                            }
                          />
                          <Label
                            htmlFor="ack-manual"
                            className="text-sm text-gray-700"
                          >
                            I understand the default rate will be 0% until I
                            assign rates
                          </Label>
                        </div>
                      </>
                    )}
                  </div>
                </RadioGroup>
              </div>

              {merchantCountry === "US" && method === "auto" && (
                <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded p-2">
                  Tip: For US merchants, set up your state nexus after saving.
                </div>
              )}

              {audience === "b2b_b2c" && (
                <div className="space-y-3">
                  <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded p-2">
                    Note: With the current engine, B2C customers are 0%
                    regardless of the method. To charge B2C taxes, integrate an
                    external provider.
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">
                          Integrate external tax provider
                        </div>
                        <div className="text-sm text-muted-foreground mt-1">
                          Use a provider (e.g., Avalara/TaxJar) to calculate B2C
                          taxes.
                        </div>
                      </div>
                      <AuthenticatedContactModal context="external-tax-providers">
                        <Button>Contact us</Button>
                      </AuthenticatedContactModal>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button onClick={handleContinueStep2}>Continue</Button>
              </div>
            </CardContent>
          </Card>
        )}
        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Review and confirm</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="space-y-4">
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                      Audience
                    </div>
                    <div className="text-sm font-medium text-gray-900">
                      {audience === "b2b"
                        ? "Business Customers (B2B)"
                        : "Businesses and consumers (B2C)"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                      Method
                    </div>
                    <div className="text-sm font-medium text-gray-900">
                      {method === "auto"
                        ? "Automatic (B2B only)"
                        : method === "single"
                          ? `Single default rate (${defaultRatePercent || "0"}%)`
                          : "Advanced manual rates"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                      {method === "auto"
                        ? "B2C Customers"
                        : method === "single"
                          ? "Coverage"
                          : "Unassigned Customers"}
                    </div>
                    <div className="text-sm text-gray-700">
                      {method === "auto"
                        ? "0% by default unless you set a rate or integrate"
                        : method === "single"
                          ? "All customers unless overridden per customer"
                          : "0% until you assign rates"}
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(2)}>
                  Back
                </Button>
                <Button onClick={handleSave} disabled={Boolean(isSaving)}>
                  {isSaving ? "Saving..." : "Confirm & Save"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </DialogContent>
    </Dialog>
  );
}
