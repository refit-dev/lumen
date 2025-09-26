"use client";

import React, { useState, useEffect } from "react";
import { PricingTable, fetchPricingTable } from "@/components/ui/pricing-table";
import { apiClient } from "@/lib/hono-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CodeBlock } from "@/components/ui/codeblock";
import { checkTestMode, generateRandomUserId } from "@/lib/utils";
import { usePageTitle } from "@/components/dashboard/page-title-context";

interface PricingTableOption {
  id: string;
  slug: string;
  name: string;
}

interface PricingTableData {
  id: string;
  slug: string;
  name: string;
  heading: string | null;
  subheading: string | null;
  description: string | null;
}

interface UpdateFormData {
  heading: string;
  subheading: string;
}

export default function PricingTablePreview() {
  const { setTitle } = usePageTitle();

  useEffect(() => {
    setTitle("Pricing Table");
  }, [setTitle]);

  const [pricingTableSlug, setPricingTableSlug] = useState<string>("");
  const [publishableKey, setPublishableKey] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [pricingTables, setPricingTables] = useState<PricingTableOption[]>([]);
  const [currentPricingTable, setCurrentPricingTable] =
    useState<PricingTableData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paymentProvider, setPaymentProvider] = useState<
    "stripe" | "dodo" | null
  >(null);

  // Form state
  const [formData, setFormData] = useState<UpdateFormData>({
    heading: "",
    subheading: "",
  });
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [updateSuccess, setUpdateSuccess] = useState<boolean>(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // User ID state for test mode
  const [userId, setUserId] = useState<string>("tmp-user-2");
  const [organizationId, setOrganizationId] = useState<string>("");
  const [isTestMode, setIsTestMode] = useState<boolean>(false);
  const [pricingToggleWarning, setPricingToggleWarning] = useState<
    string | null
  >(null);

  // Fetch selected pricing table details
  const fetchPricingTableDetails = React.useCallback(
    async (slug: string) => {
      if (!slug) return;

      try {
        const selectedTable = pricingTables.find(
          (table) => table.slug === slug
        );
        if (!selectedTable) return;

        const response = await apiClient["pricing-tables"][":id"].$get({
          param: { id: selectedTable.id },
        });

        if (response.ok) {
          const { pricingTable } = await response.json();
          setCurrentPricingTable(pricingTable);
          setFormData({
            heading: pricingTable.heading || "",
            subheading: pricingTable.subheading || "",
          });
        }
      } catch (err) {
        console.error("Failed to fetch pricing table details:", err);
      }
    },
    [pricingTables]
  );

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Fetch publishable key, pricing tables and payment provider in parallel
        const [
          apiKeysResponse,
          pricingTablesResponse,
          paymentProviderResponse,
        ] = await Promise.all([
          apiClient["api-keys"].publishable.$get(),
          apiClient["pricing-tables"].$get(),
          apiClient["pricing-tables"]["payment-provider"].$get(),
        ]);

        if (apiKeysResponse.ok) {
          const {
            data: { keyValue },
          } = await apiKeysResponse.json();
          setPublishableKey(keyValue);
          // Check if Stripe keys are in test mode
          const testMode = await checkTestMode();
          setIsTestMode(testMode);
        } else {
          throw new Error("Failed to fetch publishable key");
        }

        if (pricingTablesResponse.ok) {
          const pricingTableData = await pricingTablesResponse.json();
          if (
            pricingTableData.pricingTables &&
            Array.isArray(pricingTableData.pricingTables)
          ) {
            setPricingTables(
              pricingTableData.pricingTables.map((pt: PricingTableData) => ({
                id: pt.id,
                slug: pt.slug,
                name: pt.name,
              }))
            );

            // Set first pricing table as default if available
            if (pricingTableData.pricingTables.length > 0) {
              const firstTable = pricingTableData.pricingTables[0];
              setPricingTableSlug(firstTable.slug);
            }
          }
        } else {
          throw new Error("Failed to fetch pricing tables");
        }

        if (paymentProviderResponse.ok) {
          const { paymentProvider } = await paymentProviderResponse.json();
          setPaymentProvider(paymentProvider);
        } else {
          throw new Error("Failed to fetch payment provider");
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load data";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  // Fetch details when pricing table selection changes
  useEffect(() => {
    if (pricingTableSlug && pricingTables.length > 0) {
      fetchPricingTableDetails(pricingTableSlug);
    }
  }, [pricingTableSlug, pricingTables, fetchPricingTableDetails]);

  // Warn if the selected pricing table contains any non-enterprise plans without a yearly price
  useEffect(() => {
    const loadAndCheckPlans = async () => {
      if (!publishableKey || !pricingTableSlug) {
        setPricingToggleWarning(null);
        return;
      }
      try {
        const apiBaseUrl = (process.env.NEXT_PUBLIC_API_URL || "") + "/v1";
        const data = await fetchPricingTable({
          slug: pricingTableSlug,
          lumenPublishableKey: publishableKey,
          apiBaseUrl,
        });
        const nonEnterprise = (data.plans || []).filter(
          (p) => !p.isEnterprisePlan
        );
        if (nonEnterprise.length === 0) {
          setPricingToggleWarning(null);
          return;
        }
        const allHaveYearly = nonEnterprise.every(
          (p) => p.priceYearly !== undefined && !!p.priceIdYearly
        );
        if (!allHaveYearly) {
          setPricingToggleWarning(
            "One or more plans are missing a yearly price. The yearly/monthly toggle will be hidden and only monthly pricing will be shown. Add a yearly price for all non-enterprise plans to enable the toggle."
          );
        } else {
          setPricingToggleWarning(null);
        }
      } catch {
        // Non-blocking; ignore warning if we can't load plans here
        setPricingToggleWarning(null);
      }
    };
    loadAndCheckPlans();
  }, [publishableKey, pricingTableSlug]);

  const handleInputChange = (field: keyof UpdateFormData, value: string) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
    // Clear success/error messages when user starts typing
    setUpdateSuccess(false);
    setUpdateError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPricingTable) return;

    setIsUpdating(true);
    setUpdateError(null);
    setUpdateSuccess(false);

    try {
      const response = await apiClient["pricing-tables"][":id"].$post({
        param: { id: currentPricingTable.id },
        json: {
          heading: formData.heading || undefined,
          subheading: formData.subheading || undefined,
        },
      });

      if (response.ok) {
        const { pricingTable } = await response.json();
        setCurrentPricingTable(pricingTable);
        setUpdateSuccess(true);
        // Success message will auto-clear after 3 seconds
        setTimeout(() => setUpdateSuccess(false), 3000);
      } else {
        const errorData = await response.json();
        throw new Error(
          (errorData as { error?: string }).error ||
            "Failed to update pricing table"
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update pricing table";
      setUpdateError(message);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleGenerateUserId = () => {
    setUserId(generateRandomUserId());
  };

  const handleGenerateOrganizationId = () => {
    setOrganizationId(`test-org-${Math.random().toString(36).substr(2, 9)}`);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading pricing table...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md text-center">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <h2 className="text-lg font-semibold text-red-800 mb-2">
              Error Loading Pricing Table
            </h2>
            <p className="text-red-600">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (pricingTables.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md text-center">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
            <h2 className="text-lg font-semibold text-yellow-800 mb-2">
              No Pricing Tables Found
            </h2>
            <p className="text-yellow-600">
              Create a pricing table first to preview it here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-full mx-auto py-8 px-4">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Pricing Table Management
          </h1>
          <p className="text-gray-600">
            Update and preview your pricing tables as they will appear to
            customers.
          </p>
          {isTestMode && (
            <Alert className="mt-4 border-blue-200 bg-blue-50">
              <AlertDescription className="text-blue-800">
                🔧 Test mode detected: You can customize the user ID for testing
                purposes below.
              </AlertDescription>
            </Alert>
          )}
          {pricingToggleWarning && (
            <Alert className="mt-4 border-yellow-200 bg-yellow-50">
              <AlertDescription className="text-yellow-800">
                {pricingToggleWarning}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="space-y-8">
          {/* Update Form and React Integration - Side by Side */}
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Update Form */}
            <Card className="flex-1">
              <CardContent className="space-y-4">
                {pricingTables.length > 1 && (
                  <div>
                    <Label htmlFor="pricing-table-select">
                      Select Pricing Table
                    </Label>
                    <select
                      id="pricing-table-select"
                      value={pricingTableSlug}
                      onChange={(e) => setPricingTableSlug(e.target.value)}
                      className="w-full mt-1 p-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    >
                      {pricingTables.map((table) => (
                        <option key={table.id} value={table.slug}>
                          {table.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Test Mode User ID Configuration */}
                {isTestMode && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-900 mb-3">
                      Test Mode Configuration
                    </h3>
                    <div className="space-y-3">
                      <div>
                        <Label htmlFor="user-id">External Customer ID</Label>
                        <div className="flex gap-2 mt-1">
                          <Input
                            id="user-id"
                            type="text"
                            value={userId}
                            onChange={(e) => setUserId(e.target.value)}
                            placeholder="Enter external customer ID"
                            className="flex-1"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleGenerateUserId}
                            className="whitespace-nowrap"
                          >
                            Generate Random
                          </Button>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          This represents the external customer ID from your
                          system (e.g., your database user ID)
                        </p>
                      </div>
                      <div>
                        <Label htmlFor="organization-id">
                          Organization ID (Optional)
                        </Label>
                        <div className="flex gap-2 mt-1">
                          <Input
                            id="organization-id"
                            type="text"
                            value={organizationId}
                            onChange={(e) => setOrganizationId(e.target.value)}
                            placeholder="Enter external organization ID"
                            className="flex-1"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleGenerateOrganizationId}
                            className="whitespace-nowrap"
                          >
                            Generate Random
                          </Button>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          Only needed for seat-based plans. This represents the
                          external organization ID from your system (e.g., your
                          company/team ID)
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {currentPricingTable && (
                  <form
                    onSubmit={handleSubmit}
                    className={`space-y-4 ${isTestMode ? "border-t pt-4" : ""}`}
                  >
                    <div className="grid gap-4">
                      <div>
                        <Label htmlFor="heading">Heading</Label>
                        <Input
                          id="heading"
                          type="text"
                          value={formData.heading}
                          onChange={(e) =>
                            handleInputChange("heading", e.target.value)
                          }
                          placeholder="Enter pricing table heading"
                          className="mt-1"
                        />
                      </div>

                      <div>
                        <Label htmlFor="subheading">Subheading</Label>
                        <Input
                          id="subheading"
                          type="text"
                          value={formData.subheading}
                          onChange={(e) =>
                            handleInputChange("subheading", e.target.value)
                          }
                          placeholder="Enter pricing table subheading"
                          className="mt-1"
                        />
                      </div>
                    </div>

                    <Button
                      type="submit"
                      disabled={isUpdating}
                      className="w-full md:w-auto"
                    >
                      {isUpdating ? "Updating..." : "Update Pricing Table"}
                    </Button>
                  </form>
                )}

                {updateSuccess && (
                  <Alert className="border-green-200 bg-green-50">
                    <AlertDescription className="text-green-800">
                      Pricing table updated successfully!
                    </AlertDescription>
                  </Alert>
                )}

                {updateError && (
                  <Alert className="border-red-200 bg-red-50">
                    <AlertDescription className="text-red-800">
                      {updateError}
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {/* React Integration Code */}
            <Card className="flex-1">
              <CardContent className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    NextJS Integration
                  </h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Any questions or want to use other frameworks?{" "}
                    <a
                      href="https://cal.com/ramongarate/quick-chat"
                      target="_blank"
                      rel="noopener"
                      className="text-blue-600 hover:underline"
                    >
                      Would love to learn more :)
                    </a>
                  </p>
                  <CodeBlock
                    language="tsx"
                    code={`// Install shadcn pricing table component by running:
// npx shadcn@latest add https://getlumen.dev/pricing-table${paymentProvider === "dodo" ? "-dodo" : ""}.json

import { PricingTable } from '@/components/ui/pricing-table';

export default function MyPricingPage() {
  return (
    <PricingTable
      lumenPublishableKey="${publishableKey}"
      userId={session?.user?.id}
      loginRedirectUrl="/login"
    />
  );
}`}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Pricing Table Preview */}
          <Card>
            <CardContent className="p-0">
              <div className="bg-white rounded-lg overflow-hidden">
                {publishableKey && pricingTableSlug ? (
                  <PricingTable
                    key={`${pricingTableSlug}-${currentPricingTable?.heading}-${currentPricingTable?.subheading}-${userId}-${organizationId}`}
                    lumenPublishableKey={publishableKey}
                    userId={userId}
                    organizationId={organizationId || undefined}
                    loginRedirectUrl={"/dashboard"}
                    apiBaseUrl={process.env.NEXT_PUBLIC_API_URL + "/v1"}
                    paymentProvider={paymentProvider || "stripe"}
                    environment={isTestMode ? "test" : "live"}
                    lumenHandlerUrl={process.env.NEXT_PUBLIC_API_URL + "/v1"}
                  />
                ) : (
                  <div className="p-8 text-center text-gray-500">
                    Loading pricing table configuration...
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
