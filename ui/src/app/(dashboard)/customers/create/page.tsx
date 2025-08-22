"use client";

import { useAppForm } from "@/hooks/form";
import { z } from "zod";
import { apiClient } from "@/lib/hono-client";
import {
  customersInsertSchemaUI,
  customersInsertSchemaReq,
} from "@lumen/common/schema";

import { useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  customerCountries,
  usStates,
  supportedCustomerCountries,
} from "@lumen/common/utils";
import { randomCustomer } from "@/lib/random";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";

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
      taxExemptionReason: "no",
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
          submitData = {
            ...restValue,
            taxExempt:
              value.taxExemptionReason === "reverse_charge" ||
              value.taxExemptionReason === "customer_exempt",
          };

          // Convert frontend values to backend format - only include if not default
          if (value.taxRateDefinitionId !== "default") {
            submitData.taxRateDefinitionId = value.taxRateDefinitionId;
          }
          if (value.taxCalculationMethod !== "default") {
            submitData.taxCalculationMethod = value.taxCalculationMethod;
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

  // Update calculation method based on tax exemption reason selection
  // Only run for non-Dodo payment providers
  useEffect(() => {
    if (paymentProvider?.provider === "dodo") return;

    const { taxExemptionReason: reason, taxCalculationMethod: method } =
      formValues;

    if (reason === "no_manual" && method !== "manual") {
      form.setFieldValue("taxCalculationMethod", "manual");
    } else if (reason === "no_auto" && method !== "auto") {
      form.setFieldValue("taxCalculationMethod", "auto");
    } else if (reason === "no" && method !== "default") {
      form.setFieldValue("taxCalculationMethod", "default");
    } else if (
      (reason === "reverse_charge" || reason === "customer_exempt") &&
      method === "manual"
    ) {
      // Reset to merchant's default calculation mode when selecting exemptions
      const fallbackMethod = taxConfig?.autoTaxCalculation ? "auto" : "default";
      form.setFieldValue("taxCalculationMethod", fallbackMethod);
    }
  }, [
    formValues.taxExemptionReason,
    formValues.taxCalculationMethod,
    taxConfig,
    form,
    formValues,
    paymentProvider,
  ]);

  // Ensure auto tax method is not set for unsupported countries
  // Only run for non-Dodo payment providers
  useEffect(() => {
    if (paymentProvider?.provider === "dodo") return;

    const isSupported = supportedCustomerCountries.some(
      (c) => c.value === formValues.billingCountry
    );

    if (!isSupported && formValues.taxCalculationMethod === "auto") {
      // Reset to default/manual when automatic not allowed
      const fallbackMethod = taxConfig?.defaultTaxRate ? "default" : "manual";
      form.setFieldValue("taxCalculationMethod", fallbackMethod);

      if (formValues.taxExemptionReason === "no_auto") {
        form.setFieldValue("taxExemptionReason", "no");
      }
    }
  }, [
    formValues.billingCountry,
    formValues.taxCalculationMethod,
    formValues.taxExemptionReason,
    form,
    taxConfig,
    paymentProvider,
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
              <form.AppField
                name="taxExemptionReason"
                children={(field) => {
                  const isSupportedCountry = supportedCustomerCountries.some(
                    (c) => c.value === formValues.billingCountry
                  );

                  const options: { label: string; value: string }[] = [];

                  const autoAllowed =
                    isSupportedCountry && taxConfig?.autoTaxCalculation;

                  if (autoAllowed) {
                    // Merchant default is automatic & country supported
                    options.push({
                      label: "Calculate automatically based on location",
                      value: "no_auto",
                    });
                    options.push({
                      label: "Use specific tax rate",
                      value: "no_manual",
                    });
                  } else {
                    // Automatic calc not available (either merchant manual or country unsupported)
                    if (taxConfig?.defaultTaxRate) {
                      const rate = (
                        parseFloat(taxConfig.defaultTaxRate) * 100
                      ).toFixed(2);
                      options.push({
                        label: `Apply default rate (${rate}%)`,
                        value: "no",
                      });
                    } else {
                      options.push({
                        label: "No tax (default rate not set)",
                        value: "no",
                      });
                    }

                    // Manual always available
                    options.push({
                      label: "Use specific tax rate",
                      value: "no_manual",
                    });

                    // Only allow auto if explicitly permitted
                    if (taxConfig?.autoTaxCalculation && isSupportedCountry) {
                      options.push({
                        label: "Calculate automatically based on location",
                        value: "no_auto",
                      });
                    }
                  }

                  // Always include exemption options
                  options.push({
                    label: "Reverse charge (B2B VAT)",
                    value: "reverse_charge",
                  });
                  options.push({
                    label: "Tax exempt",
                    value: "customer_exempt",
                  });

                  return (
                    <field.Dropdown
                      label="Tax Treatment"
                      options={options}
                      defaultValue={autoAllowed ? "no_auto" : "no"}
                    />
                  );
                }}
              />

              {/* Show description for selected option */}
              <div className="text-xs text-gray-600">
                {(() => {
                  const exemptionReason = formValues.taxExemptionReason;
                  const calcMethod = formValues.taxCalculationMethod;

                  if (exemptionReason === "reverse_charge") {
                    return (
                      <p className="flex items-start gap-1.5">
                        <span className="text-green-600 mt-0.5">✓</span>
                        <span>
                          No tax will be charged. The customer is responsible
                          for paying VAT directly to their tax authority
                          (reverse charge mechanism).
                        </span>
                      </p>
                    );
                  }
                  if (exemptionReason === "customer_exempt") {
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
                  if (calcMethod === "auto") {
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
                  if (calcMethod === "manual") {
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
                  if (calcMethod === "default" && taxConfig) {
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
              {formValues.taxCalculationMethod === "manual" && (
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
