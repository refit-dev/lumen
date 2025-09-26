"use client";

import { useAppForm } from "@/hooks/form";
import { z } from "zod";
import { apiClient } from "@/lib/hono-client";
import {
  customersInsertSchemaUI,
  customersInsertSchemaReq,
} from "@lumen/common/schema";

import { useEffect, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ExternalLink, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  customerCountries,
  usStates,
  supportedCustomerCountries,
} from "@lumen/common/utils";
import { randomCustomer } from "@/lib/random";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

export default function CreateCustomerPage() {
  const router = useRouter();

  // Fetch tax rate definitions for the dropdown
  const { data: taxRateDefinitions } = useQuery({
    queryKey: ["tax-rate-definitions"],
    queryFn: async () => {
      const response = await apiClient.tax["rate-definitions"].$get();
      if (!response.ok) throw new Error("Failed to fetch tax rate definitions");
      return response.json();
    },
  });

  // Fetch merchant tax configuration
  const { data: taxConfig } = useQuery({
    queryKey: ["tax-config"],
    queryFn: async () => {
      const response = await apiClient.tax.config.$get();
      if (!response.ok) throw new Error("Failed to fetch tax config");
      return response.json();
    },
  });

  // Fetch payment provider to determine tax handling
  const { data: paymentProvider } = useQuery({
    queryKey: ["payment-provider"],
    queryFn: async () => {
      const response = await apiClient.merchants["payment-provider"].$get();
      if (!response.ok) throw new Error("Failed to fetch payment provider");
      return response.json();
    },
  });

  const form = useAppForm({
    defaultValues: {
      name: "",
      email: "",
      externalCustomerId: "",
      businessName: "",
      billingAddressLine1: "",
      billingAddressLine2: "",
      billingCity: "",
      billingCountry: "",
      billingStateProvince: "",
      billingPostalCode: "",
      taxId: "",
      taxExemptionReason: "",
      taxRateDefinitionId: "default",
      taxCalculationMethod: "default",
    },
    onSubmit: async ({ value }) => {
      try {
        // For Dodo payment provider, set appropriate tax defaults since Dodo handles tax
        let submitData: Partial<z.infer<typeof customersInsertSchemaReq>>;

        if (paymentProvider?.provider === "dodo") {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { taxRateDefinitionId, taxCalculationMethod, ...restValue } =
            value;
          submitData = {
            ...restValue,
            taxExempt: false, // Dodo handles tax, so not exempt
            // Don't include taxRateDefinitionId and taxCalculationMethod - Dodo manages these
          };
        } else {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { taxRateDefinitionId, taxCalculationMethod, ...restValue } =
            value;

          // Determine tax treatment based on UI state
          const treatment = selectedTaxTreatment;

          submitData = {
            ...restValue,
            taxExempt: treatment === "exempt",
          };

          // Map calculation method
          if (treatment === "auto") {
            submitData.taxCalculationMethod = "auto" as
              | "auto"
              | "manual"
              | "default";
          } else if (treatment === "manual") {
            submitData.taxCalculationMethod = "manual" as
              | "auto"
              | "manual"
              | "default";
          } else if (treatment === "default") {
            submitData.taxCalculationMethod = "default" as
              | "auto"
              | "manual"
              | "default";
          } else if (treatment === "exempt") {
            // Keep merchant default calculation method in the background
            submitData.taxCalculationMethod = (
              taxConfig?.autoTaxCalculation ? "auto" : "default"
            ) as "auto" | "manual" | "default";
            // Pass the detailed exemption reason
            const reason =
              selectedExemptionReason === "other"
                ? exemptionOtherText.trim()
                : selectedExemptionReason;
            if (reason) {
              submitData = {
                ...(submitData as object),
                taxExemptionReason: reason,
              } as typeof submitData;
            }
          }

          // Convert frontend values to backend format - only include if not default
          if (
            treatment === "manual" &&
            value.taxRateDefinitionId !== "default"
          ) {
            submitData.taxRateDefinitionId = value.taxRateDefinitionId;
          }
        }

        const response = await apiClient.customers.$post({
          json: submitData as z.infer<typeof customersInsertSchemaReq>,
        });
        const data = await response.json();
        if ("error" in data) {
          throw new Error(data.error);
        }
        router.push(`/customers`);
      } catch (error) {
        console.error("Error creating customer:", error);
        throw error;
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        // Custom validation for US state requirement
        const errors: Record<string, string> = {};
        if (value.billingCountry === "US" && !value.billingStateProvince) {
          errors.billingStateProvince = "State is required for US customers";
        }

        const result = customersInsertSchemaUI.safeParse(value);
        if (!result.success) {
          const schemaErrors = result.error.issues.reduce(
            (acc: Record<string, string>, issue: z.ZodIssue) => ({
              ...acc,
              [issue.path[0]]: issue.message,
            }),
            {}
          );
          Object.assign(errors, schemaErrors);
        }

        if (Object.keys(errors).length > 0) {
          return { fields: errors };
        }
        return undefined;
      },
    },
  });

  // Subscribe to form values so the component re-renders when they change
  const formValues = useStore(form.store, (state) => state.values);

  // Local UI state for tax treatment and exemption reasons
  const [selectedTaxTreatment, setSelectedTaxTreatment] = useState<
    "auto" | "manual" | "default" | "exempt"
  >("default");
  const [exemptionDialogOpen, setExemptionDialogOpen] = useState(false);
  const [selectedExemptionReason, setSelectedExemptionReason] =
    useState<string>("nonprofit_organization");
  const [exemptionOtherText, setExemptionOtherText] = useState("");

  // Initialize default tax treatment based on merchant config - UI only
  useEffect(() => {
    if (paymentProvider?.provider === "dodo") return;
    if (taxConfig?.autoTaxCalculation) {
      setSelectedTaxTreatment("auto");
    } else {
      setSelectedTaxTreatment("default");
    }
  }, [taxConfig?.autoTaxCalculation, paymentProvider]);

  // No longer mirror dropdown into form field; we use local treatment state

  const handleNavigateBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleGenerateMockData = useCallback(() => {
    const mockCustomer = randomCustomer();
    form.setFieldValue("name", mockCustomer.name);
    form.setFieldValue("email", mockCustomer.email);
    form.setFieldValue("billingAddressLine1", mockCustomer.billingAddressLine1);
    form.setFieldValue("billingAddressLine2", mockCustomer.billingAddressLine2);
    form.setFieldValue("billingCity", mockCustomer.billingCity);
    form.setFieldValue("billingPostalCode", mockCustomer.billingPostalCode);
    form.setFieldValue("billingCountry", mockCustomer.billingCountry);
  }, [form]);

  // Clear state/province when switching from US to non-US or vice versa
  useEffect(() => {
    const isUS = formValues.billingCountry === "US";
    const hasStateValue = formValues.billingStateProvince;

    // If switching to non-US and there's a US state code, clear it
    if (
      !isUS &&
      hasStateValue &&
      usStates.some((state) => state.value === hasStateValue)
    ) {
      form.setFieldValue("billingStateProvince", "");
    }
  }, [formValues.billingCountry, formValues.billingStateProvince, form]);

  // No longer synchronize form field with UI state - handle only on submit

  // Ensure auto tax method is not set for unsupported countries - UI state only
  useEffect(() => {
    if (paymentProvider?.provider === "dodo") return;

    const isSupported = supportedCustomerCountries.some(
      (c) => c.value === formValues.billingCountry
    );

    if (!isSupported && selectedTaxTreatment === "auto") {
      // Reset to default/manual when automatic not allowed
      const fallbackMethod = taxConfig?.defaultTaxRate ? "default" : "manual";
      setSelectedTaxTreatment(
        fallbackMethod === "default" ? "default" : "manual"
      );
    }
  }, [
    formValues.billingCountry,
    taxConfig,
    paymentProvider,
    selectedTaxTreatment,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
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
      <div className="flex items-center gap-4 mb-8">
        <h1 className="text-2xl font-bold">Create New Customer</h1>
        <Button variant="outline" onClick={handleGenerateMockData}>
          Generate mock data
        </Button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
        className="max-w-2xl space-y-6"
      >
        <form.AppField
          name="name"
          children={(field) => <field.TextField label="Name" autoFocus />}
        />
        <form.AppField
          name="email"
          children={(field) => <field.TextField label="Email" />}
        />
        <form.AppField
          name="externalCustomerId"
          children={(field) => (
            <field.TextField label="External Customer ID" isOptional />
          )}
        />

        <div className="border border-gray-200 rounded-md p-4 space-y-4">
          <div className="flex items-center mb-2">
            <h3 className="font-medium">Billing Information</h3>
            <Badge variant="secondary" className="ml-2">
              Required for invoice
            </Badge>
          </div>
          <form.AppField
            name="businessName"
            children={(field) => (
              <field.TextField
                label="Business Name (provide to buy as a business)"
                isOptional
              />
            )}
          />

          <form.AppField
            name="billingAddressLine1"
            children={(field) => <field.TextField label="Address Line 1" />}
          />
          <form.AppField
            name="billingAddressLine2"
            children={(field) => (
              <field.TextField label="Address Line 2" isOptional />
            )}
          />
          <form.AppField
            name="billingCity"
            children={(field) => <field.TextField label="City" />}
          />
          <form.AppField
            name="billingCountry"
            children={(field) => (
              <field.Dropdown
                label="Country"
                options={customerCountries}
                searchEnabled
              />
            )}
          />
          {/* Inform merchant when automatic tax won't be available for the selected country */}
          {taxConfig?.autoTaxCalculation &&
            formValues.billingCountry &&
            !supportedCustomerCountries.some(
              (c) => c.value === formValues.billingCountry
            ) && (
              <p className="text-xs text-amber-600 ml-1">
                Automatic tax calculation isn&apos;t supported for this country.
                Please make sure you&apos;ve selected a manual tax-calculation
                method below.
              </p>
            )}
          <form.AppField
            name="billingStateProvince"
            children={(field) => {
              const isUS = formValues.billingCountry === "US";

              if (isUS) {
                return (
                  <field.Dropdown
                    label="State"
                    defaultValue=""
                    options={usStates}
                    searchEnabled
                    placeholder="Select a state"
                  />
                );
              }

              return <field.TextField label="State/Province" isOptional />;
            }}
          />
          <form.AppField
            name="billingPostalCode"
            children={(field) => <field.TextField label="Postal Code" />}
          />
          <form.AppField
            name="taxId"
            children={(field) => (
              <field.TextField label="Tax ID / VAT Number" />
            )}
          />
        </div>

        <div className="border border-gray-200 rounded-md p-4 space-y-4">
          <div className="flex items-center mb-2">
            <h3 className="font-medium">Tax Configuration</h3>
            <Badge variant="secondary" className="ml-2">
              Optional
            </Badge>
          </div>

          {/* Show different content based on payment provider */}
          {paymentProvider?.provider === "dodo" ? (
            // Dodo - Merchant of Record
            <div className="text-sm text-gray-600">
              <p className="flex items-start gap-1.5">
                <span className="text-green-600 mt-0.5">✓</span>
                <span>
                  <strong>Dodo Payments</strong> is configured as your merchant
                  of record and will automatically handle all tax calculations,
                  collection, and remittance for this customer based on their
                  billing location and applicable tax rules.
                </span>
              </p>
              <p className="mt-2 text-xs text-gray-500">
                No additional tax configuration is needed when using Dodo
                Payments.
              </p>
            </div>
          ) : (
            // Stripe or no payment provider - show full tax configuration
            <>
              {/* Smart tax treatment dropdown */}
              {(() => {
                const isSupportedCountry = supportedCustomerCountries.some(
                  (c) => c.value === formValues.billingCountry
                );
                const autoAllowed =
                  isSupportedCountry && taxConfig?.autoTaxCalculation;

                const currentValue = selectedTaxTreatment;

                return (
                  <div className="space-y-2">
                    <Label>Tax Treatment</Label>
                    <Select
                      value={currentValue}
                      onValueChange={(val) => {
                        if (val === "exempt") {
                          setSelectedTaxTreatment("exempt");
                          setExemptionDialogOpen(true);
                          return;
                        }
                        setSelectedTaxTreatment(
                          val as "auto" | "manual" | "default" | "exempt"
                        );
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select tax treatment" />
                      </SelectTrigger>
                      <SelectContent>
                        {autoAllowed ? (
                          <>
                            <SelectItem value="auto">
                              Calculate automatically based on location
                            </SelectItem>
                            <SelectItem value="manual">
                              Use specific tax rate
                            </SelectItem>
                            <SelectItem value="exempt">Tax exempt</SelectItem>
                          </>
                        ) : (
                          <>
                            <SelectItem value="default">
                              {taxConfig?.defaultTaxRate
                                ? `Apply default rate (${(
                                    parseFloat(taxConfig.defaultTaxRate) * 100
                                  ).toFixed(2)}%)`
                                : "No tax (default rate not set)"}
                            </SelectItem>
                            <SelectItem value="manual">
                              Use specific tax rate
                            </SelectItem>
                            <SelectItem value="exempt">Tax exempt</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })()}

              {/* Show description for selected option */}
              <div className="text-xs text-gray-600">
                {(() => {
                  if (selectedTaxTreatment === "exempt") {
                    return (
                      <p className="flex items-start gap-1.5">
                        <span className="text-green-600 mt-0.5">✓</span>
                        <span>
                          This customer is tax exempt. No tax will be charged on
                          any invoices.
                        </span>
                      </p>
                    );
                  }
                  if (selectedTaxTreatment === "auto") {
                    return (
                      <p className="flex items-start gap-1.5">
                        <span className="text-green-600 mt-0.5">✓</span>
                        <span>
                          Tax will be calculated automatically based on the
                          customer&apos;s billing location and applicable tax
                          rules.
                        </span>
                      </p>
                    );
                  }
                  if (selectedTaxTreatment === "manual") {
                    return (
                      <p className="flex items-start gap-1.5">
                        <span className="text-green-600 mt-0.5">✓</span>
                        <span>
                          Select a specific tax rate to apply to this customer
                          below.
                        </span>
                      </p>
                    );
                  }
                  if (selectedTaxTreatment === "default" && taxConfig) {
                    if (taxConfig.autoTaxCalculation) {
                      return (
                        <p className="flex items-start gap-1.5">
                          <span className="text-green-600 mt-0.5">✓</span>
                          <span>
                            Tax will be calculated automatically based on the
                            customer&apos;s billing location.
                          </span>
                        </p>
                      );
                    } else if (taxConfig.defaultTaxRate) {
                      return (
                        <p className="flex items-start gap-1.5">
                          <span className="text-green-600 mt-0.5">✓</span>
                          <span>
                            Your default tax rate of{" "}
                            {(
                              parseFloat(taxConfig.defaultTaxRate) * 100
                            ).toFixed(2)}
                            % will be applied.
                          </span>
                        </p>
                      );
                    } else {
                      return (
                        <p className="flex items-start gap-1.5">
                          <span className="text-amber-600 mt-0.5">!</span>
                          <span>
                            No default tax rate configured. No tax will be
                            charged unless you set up a default rate in tax
                            settings.
                          </span>
                        </p>
                      );
                    }
                  }
                  return null;
                })()}
              </div>

              {/* Show tax rate dropdown only when manual rate is selected */}
              {selectedTaxTreatment === "manual" && (
                <div className="space-y-3">
                  {taxRateDefinitions && taxRateDefinitions.length > 0 ? (
                    <form.AppField
                      name="taxRateDefinitionId"
                      children={(field) => (
                        <field.Dropdown
                          label="Select Tax Rate"
                          options={[
                            ...taxRateDefinitions.map((def) => ({
                              label: `${def.name} (${(parseFloat(def.taxRate) * 100).toFixed(2)}%)`,
                              value: def.id,
                            })),
                          ]}
                          defaultValue={taxRateDefinitions[0]?.id || "default"}
                        />
                      )}
                    />
                  ) : (
                    <div className="text-sm text-gray-600">
                      <p className="mb-2">No tax rates defined yet.</p>
                    </div>
                  )}

                  {/* Always show link to create/manage tax rates */}
                  <div className="text-sm">
                    <a
                      href="/tax"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 underline"
                    >
                      {taxRateDefinitions && taxRateDefinitions.length > 0
                        ? "Manage tax rates"
                        : "Create your first tax rate"}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              )}

              {/* Hidden field to maintain calculation method state */}
              <div style={{ display: "none" }}>
                <form.AppField
                  name="taxCalculationMethod"
                  children={(field) => <field.TextField label="" />}
                />
              </div>
              {/* Exemption reason selection dialog */}
              <Dialog
                open={exemptionDialogOpen}
                onOpenChange={setExemptionDialogOpen}
              >
                <DialogContent>
                  <DialogTitle>Select tax exemption reason</DialogTitle>
                  <div className="mt-3 space-y-3">
                    <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                      <Info className="h-4 w-4 mt-0.5" />
                      <p>
                        Tax-exempt customers are legally exempt from tax
                        collection (for eg, some non-profits, overseas sales
                        etc.). Only select this if you have a valid exemption
                        certificate for the customer OR if you know what
                        you&apos;re doing.
                      </p>
                    </div>
                    <RadioGroup
                      value={selectedExemptionReason}
                      onValueChange={(v) => setSelectedExemptionReason(v)}
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem
                          value="nonprofit_organization"
                          id="exempt-np"
                        />
                        <label htmlFor="exempt-np" className="text-sm">
                          Nonprofit organization
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem
                          value="government_entity"
                          id="exempt-gov"
                        />
                        <label htmlFor="exempt-gov" className="text-sm">
                          Government entity
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem
                          value="educational_institution"
                          id="exempt-edu"
                        />
                        <label htmlFor="exempt-edu" className="text-sm">
                          Educational institution
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="resale" id="exempt-resale" />
                        <label htmlFor="exempt-resale" className="text-sm">
                          Resale certificate
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="other" id="exempt-other" />
                        <label htmlFor="exempt-other" className="text-sm">
                          Other
                        </label>
                      </div>
                    </RadioGroup>
                    {selectedExemptionReason === "other" && (
                      <div className="pt-2">
                        <Input
                          placeholder="Enter exemption reason"
                          value={exemptionOtherText}
                          onChange={(e) =>
                            setExemptionOtherText(e.target.value)
                          }
                        />
                      </div>
                    )}
                    <div className="pt-2 flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setExemptionDialogOpen(false);
                          const fallback = taxConfig?.autoTaxCalculation
                            ? "auto"
                            : "default";
                          setSelectedTaxTreatment(fallback);
                          // Do not mutate form field here; local state drives UI
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={() => {
                          setExemptionDialogOpen(false);
                          // Persist selected reason into form for backend
                          const reason =
                            selectedExemptionReason === "other"
                              ? exemptionOtherText.trim()
                              : selectedExemptionReason;
                          if (reason) {
                            form.setFieldValue("taxExemptionReason", reason);
                          }
                        }}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>

        <form.AppForm>
          <form.SubmitButtonWithShortcut label="Create Customer" />
        </form.AppForm>
      </form>
    </div>
  );
}
