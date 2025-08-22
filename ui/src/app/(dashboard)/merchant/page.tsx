"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2, Copy } from "lucide-react";
import { apiClient } from "@/lib/hono-client";
import { useAppForm } from "@/hooks/form";
import { merchantsInsertSchema } from "@lumen/common/schema";
import { onboardingCountries, usStates } from "@lumen/common/utils";
import { useStore } from "@tanstack/react-form";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getAllSupportedCurrencies,
  formatCurrencyOption,
} from "@/lib/currencies";
import { PageContent } from "@/components/dashboard/page-content";

interface MerchantData {
  legalName: string;
  displayName: string;
  taxId?: string;
  websiteUrl?: string;
  defaultCurrency: string;
  country?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
}

export default function MerchantSettingsPage() {
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [merchantId, setMerchantId] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: {
      legalName: "",
      displayName: "",
      websiteUrl: "",
      country: "",
      addressLine1: "",
      addressLine2: "",
      city: "",
      stateProvince: "",
      postalCode: "",
      taxId: "",
      defaultCurrency: "EUR",
    },
    onSubmit: ({ value }) => {
      handleUpdateMerchant(value);
    },
    validators: {
      onSubmit: ({ value }) => {
        const sanitizedValue = Object.fromEntries(
          Object.entries(value).map(([key, val]) => [
            key,
            val === "" ? undefined : val,
          ])
        );

        // Custom validation for US state requirement
        const errors: Record<string, string> = {};
        if (value.country === "US" && !value.stateProvince) {
          errors.stateProvince = "State is required for US merchants";
        }

        const result = merchantsInsertSchema
          .omit({ id: true, userId: true, organizationId: true })
          .safeParse(sanitizedValue);
        if (!result.success) {
          const schemaErrors = result.error.issues.reduce(
            (acc, issue) => ({ ...acc, [issue.path[0]]: issue.message }),
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

  // Clear state/province when switching from US to non-US or vice versa
  useEffect(() => {
    const isUS = formValues.country === "US";
    const hasStateValue = formValues.stateProvince;

    // If switching to non-US and there's a US state code, clear it
    if (
      !isUS &&
      hasStateValue &&
      usStates.some((state) => state.value === hasStateValue)
    ) {
      form.setFieldValue("stateProvince", "");
    }
  }, [formValues.country, formValues.stateProvince, form]);

  const handleCopyId = () => {
    if (merchantId) {
      navigator.clipboard.writeText(merchantId);
      toast.success("Merchant ID copied to clipboard");
    }
  };

  useEffect(() => {
    const loadMerchantData = async () => {
      try {
        setInitialLoading(true);

        // Fetch merchant data
        const merchantResponse = await apiClient.merchants.current.$get();

        if (!merchantResponse.ok) {
          throw new Error("Failed to fetch merchant data");
        }

        const merchant = await merchantResponse.json();

        // Store the merchant ID
        setMerchantId(merchant.id);

        // Populate the form with current merchant data
        form.setFieldValue("legalName", merchant.legalName || "");
        form.setFieldValue("displayName", merchant.displayName || "");
        form.setFieldValue("websiteUrl", merchant.websiteUrl || "");
        form.setFieldValue("country", merchant.country || "");
        form.setFieldValue("addressLine1", merchant.addressLine1 || "");
        form.setFieldValue("addressLine2", merchant.addressLine2 || "");
        form.setFieldValue("city", merchant.city || "");
        form.setFieldValue("stateProvince", merchant.stateProvince || "");
        form.setFieldValue("postalCode", merchant.postalCode || "");
        form.setFieldValue("taxId", merchant.taxId || "");
        form.setFieldValue(
          "defaultCurrency",
          merchant.defaultCurrency || "EUR"
        );
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to load merchant data"
        );
      } finally {
        setInitialLoading(false);
      }
    };

    loadMerchantData();
  }, [form]);

  const handleUpdateMerchant = async (value: MerchantData) => {
    setLoading(true);
    try {
      const response = await apiClient.merchants.current.$post({
        json: {
          legalName: value.legalName,
          displayName: value.displayName,
          taxId: value.taxId,
          websiteUrl: value.websiteUrl || undefined,
          defaultCurrency: value.defaultCurrency,
          addressLine1: value.addressLine1,
          addressLine2: value.addressLine2,
          city: value.city,
          stateProvince: value.stateProvince,
          postalCode: value.postalCode,
          country: value.country,
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.log("Error updating merchant:", errorData);
        toast.error("Failed to update merchant information");
        return;
      }

      toast.success("Merchant information updated successfully");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update merchant"
      );
    } finally {
      setLoading(false);
    }
  };

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <PageContent title="Merchant Settings">
      <div className="max-w-6xl w-full mx-auto p-6">
        <div className="space-y-6 mb-8">
          {/* Merchant ID Section */}
          <div>
            <p className="text-muted-foreground mt-2">
              Update your company information and address details
            </p>
            {merchantId && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className="flex items-center bg-muted rounded cursor-pointer hover:bg-muted-foreground/10 mt-3 w-fit"
                      onClick={handleCopyId}
                    >
                      <code className="px-3 py-2 text-sm font-mono">
                        {merchantId}
                      </code>
                      <div className="h-10 px-3 flex items-center">
                        <Copy className="h-4 w-4" />
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Click to copy merchant ID</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Merchant Information</CardTitle>
            <CardDescription>
              Configure your merchant details and billing information
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                form.handleSubmit();
              }}
            >
              <form.AppField
                name="legalName"
                children={(field) => <field.TextField label="Legal Name" />}
              />
              <form.AppField
                name="displayName"
                children={(field) => <field.TextField label="Display Name" />}
              />
              <form.AppField
                name="websiteUrl"
                children={(field) => <field.TextField label="Website URL" />}
              />
              <form.AppField
                name="taxId"
                children={(field) => <field.TextField label="Tax ID" />}
              />
              <form.AppField
                name="country"
                children={(field) => (
                  <field.Dropdown
                    label="Country"
                    defaultValue={""}
                    options={onboardingCountries}
                    searchEnabled
                  />
                )}
              />
              <form.AppField
                name="addressLine1"
                children={(field) => <field.TextField label="Address Line 1" />}
              />
              <form.AppField
                name="addressLine2"
                children={(field) => (
                  <field.TextField label="Address Line 2" isOptional />
                )}
              />
              <form.AppField
                name="city"
                children={(field) => <field.TextField label="City" />}
              />
              <form.AppField
                name="stateProvince"
                children={(field) => {
                  const isUS = formValues.country === "US";

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
                name="postalCode"
                children={(field) => <field.TextField label="Postal Code" />}
              />
              <form.AppField
                name="defaultCurrency"
                children={(field) => {
                  const availableCurrencies = getAllSupportedCurrencies();
                  const currencyOptions = availableCurrencies.map(
                    (currency) => ({
                      value: currency.code,
                      label: formatCurrencyOption(currency),
                    })
                  );

                  return (
                    <field.Dropdown
                      label="Default Currency"
                      defaultValue="EUR"
                      options={currencyOptions}
                      searchEnabled={false}
                    />
                  );
                }}
              />
              <form.AppForm>
                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    "Update"
                  )}
                </Button>
              </form.AppForm>
            </form>
          </CardContent>
        </Card>
      </div>
    </PageContent>
  );
}
