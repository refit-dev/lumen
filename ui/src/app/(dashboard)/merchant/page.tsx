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
import { Loader2, Copy, HelpCircle, Info } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  const [dunningLoading, setDunningLoading] = useState(false);
  const [dunningGraceDays, setDunningGraceDays] = useState<number>(7);
  const [dunningAction, setDunningAction] = useState<
    "pause_subscription" | "mark_as_unpaid" | "cancel_subscription"
  >("pause_subscription");

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

        // Fetch dunning config
        try {
          const dunResp = await apiClient.merchants["dunning-config"].$get();
          if (dunResp.ok) {
            const { config } = await dunResp.json();
            if (config) {
              setDunningGraceDays(config.gracePeriodDays ?? 7);
              setDunningAction(
                (config.endOfDunningAction as
                  | "pause_subscription"
                  | "mark_as_unpaid"
                  | "cancel_subscription"
                  | undefined) || "pause_subscription"
              );
            }
          }
        } catch (e) {
          console.warn("Failed to load dunning config", e);
        }
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

        <Card className="w-full mt-6">
          <CardHeader>
            <CardTitle>Payment Recovery Settings</CardTitle>
            <CardDescription>
              Configure how failed payments are handled to reduce customer churn
              and improve revenue recovery
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {/* Information Banner */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <Info className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div className="space-y-2">
                    <h4 className="font-medium text-blue-900">
                      How payment recovery works
                    </h4>
                    <div className="text-sm text-blue-800 space-y-1">
                      <p>
                        • When payment fails, customers get a grace period to
                        fix their payment method
                      </p>
                      <p>
                        • If not fixed in time, the chosen action is applied to
                        their subscription
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Settings */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <TooltipProvider>
                    <div className="flex items-center gap-2 h-6">
                      <Label
                        htmlFor="grace-period"
                        className="text-sm font-medium"
                      >
                        Grace period (payment retry time)
                      </Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          <p>
                            How long customers have to fix their payment method.
                            7 days is recommended for most businesses.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TooltipProvider>
                  <Select
                    value={String(dunningGraceDays)}
                    onValueChange={(val) => setDunningGraceDays(parseInt(val))}
                  >
                    <SelectTrigger id="grace-period">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[0, 1, 3, 7, 14, 30].map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d === 0
                            ? "No grace period (immediate action)"
                            : `${d} day${d > 1 ? "s" : ""}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-2 h-6">
                    <Label
                      htmlFor="recovery-action"
                      className="text-sm font-medium"
                    >
                      When payment can&apos;t be recovered
                    </Label>
                  </div>
                  <Select
                    value={dunningAction}
                    onValueChange={(val) =>
                      setDunningAction(
                        val as
                          | "pause_subscription"
                          | "mark_as_unpaid"
                          | "cancel_subscription"
                      )
                    }
                  >
                    <SelectTrigger id="recovery-action">
                      <SelectValue>
                        {dunningAction === "pause_subscription"
                          ? "Pause subscription (Recommended)"
                          : dunningAction === "mark_as_unpaid"
                            ? "Mark as unpaid"
                            : dunningAction === "cancel_subscription"
                              ? "Cancel subscription"
                              : "Choose action"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pause_subscription" className="py-3">
                        <div className="w-full space-y-1">
                          <div className="font-medium flex items-center gap-2">
                            Pause subscription
                            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                              Recommended
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Subscription is paused after grace period. Customer
                            can resume after updating payment method.
                          </div>
                        </div>
                      </SelectItem>
                      <SelectItem value="mark_as_unpaid" className="py-3">
                        <div className="w-full space-y-1">
                          <div className="font-medium">Mark as unpaid</div>
                          <div className="text-xs text-muted-foreground">
                            Subscription continues, flagged for follow-up
                          </div>
                        </div>
                      </SelectItem>
                      <SelectItem value="cancel_subscription" className="py-3">
                        <div className="w-full space-y-1">
                          <div className="font-medium text-red-600">
                            Cancel subscription
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Subscription is canceled after grace period.
                            Customer can resubscribe after updating payment
                            method.
                          </div>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Example scenarios */}
              <div className="bg-gray-50 border rounded-lg p-4">
                <h4 className="font-medium text-gray-900 mb-3">
                  Example scenarios with current settings:
                </h4>
                <div className="space-y-2 text-sm text-gray-700">
                  <div className="flex items-start gap-2">
                    <span className="text-blue-600">1.</span>
                    <span>
                      Customer&apos;s card expires and payment fails → They have{" "}
                      <strong>
                        {dunningGraceDays === 0
                          ? "no time"
                          : `${dunningGraceDays} day${dunningGraceDays > 1 ? "s" : ""}`}
                      </strong>{" "}
                      to update their payment method
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-blue-600">2.</span>
                    <span>
                      If they don&apos;t fix it in time, their subscription will
                      be{" "}
                      <strong>
                        {dunningAction === "pause_subscription"
                          ? "paused (they keep access, no new charges)"
                          : dunningAction === "mark_as_unpaid"
                            ? "marked as unpaid (continues but flagged)"
                            : "cancelled (they lose access)"}
                      </strong>
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-blue-600">3.</span>
                    <span>
                      When they update their payment method,{" "}
                      {dunningAction === "cancel_subscription"
                        ? "they will need to resubscribe"
                        : "their subscription will automatically resume"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t">
                <Button
                  disabled={dunningLoading}
                  onClick={async () => {
                    setDunningLoading(true);
                    try {
                      const resp = await apiClient.merchants[
                        "dunning-config"
                      ].$post({
                        json: {
                          gracePeriodDays: dunningGraceDays,
                          endOfDunningAction: dunningAction,
                        },
                      });
                      if (!resp.ok) {
                        const err = await resp.json();
                        console.log("Dunning update error", err);
                        toast.error(
                          "Failed to update payment recovery settings"
                        );
                        return;
                      }
                      toast.success(
                        "Payment recovery settings updated successfully"
                      );
                    } catch {
                      toast.error("Failed to update payment recovery settings");
                    } finally {
                      setDunningLoading(false);
                    }
                  }}
                  className="w-full md:w-auto"
                >
                  {dunningLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    "Save Payment Recovery Settings"
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </PageContent>
  );
}
