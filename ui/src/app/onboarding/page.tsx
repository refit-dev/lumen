"use client";

// This route is outside of (dashboard) folder so it is not affected
// by the layout that generates the sidebar.

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import {
  organization,
  useActiveOrganization,
  useSession,
  useListOrganizations,
  signOut,
} from "@/lib/auth-client";
import { apiClient } from "@/lib/hono-client";
import { useRouter } from "next/navigation";
import { useAppForm } from "@/hooks/form";
import { merchantsInsertSchema } from "@lumen/common/schema";
import { onboardingCountries } from "@lumen/common/utils";
import { randomCompanyName, randomAddress } from "@/lib/random";
import { CodeBlock } from "@/components/ui/codeblock";
import { PaymentProviders } from "@/components/paymentproviders";
import {
  getCurrenciesForProvider,
  formatCurrencyOption,
} from "@/lib/currencies";

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
  isSkipOnboardingInTestMode?: boolean;
}

interface Step {
  id: number;
  title: string;
  subtitle?: string;
  completed: boolean;
  active: boolean;
}

// Add payment provider type
type PaymentProvider =
  | "stripe"
  | "dodo"
  | "paddle"
  | "checkout"
  | "adyen"
  | null;

interface ApiKeyBase {
  id: string;
  name: string;
  keyType: "secret" | "publishable";
  environment: "live" | "test";
  createdAt: string;
  revokedAt?: string | null;
  merchantId: string;
}

interface PublishableKey {
  id: string;
  name: string;
  keyType: "secret" | "publishable";
  environment: "live" | "test";
  keyValue: string;
  prefix: string;
  createdAt: string;
}

interface CreatedApiKey extends ApiKeyBase {
  keyValue: string;
  prefix: string;
  permissions: ("admin" | "public")[];
}

interface CreateApiKeyPayload {
  name: string;
  keyType: "secret" | "publishable";
  environment: "live" | "test";
}

const removeSpecialChars = (str: string) => {
  return str.replace(/[^a-zA-Z0-9]/g, "");
};

export default function OnboardingPage() {
  const [secretKey, setSecretKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [mockDataGenerated, setMockDataGenerated] = useState(false);
  const [publishableKey, setPublishableKey] = useState<PublishableKey | null>(
    null
  );
  const [createdSecretKey, setCreatedSecretKey] =
    useState<CreatedApiKey | null>(null);
  // Add payment provider state
  const [selectedProvider, setSelectedProvider] =
    useState<PaymentProvider>(null);
  const activeOrganization = useActiveOrganization();
  // BUG: useSession & React 19, session not reactive http://github.com/better-auth/better-auth/issues/1006
  const { data: session, refetch, isPending } = useSession();
  const { data: organizations } = useListOrganizations();
  const router = useRouter();
  const [stripeMerchantData, setStripeMerchantData] = useState<MerchantData>();
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  const isStripeOnboardingComplete = !!secretKey && !!publicKey;

  const form = useAppForm({
    defaultValues: {
      legalName: stripeMerchantData?.legalName ?? "",
      displayName: stripeMerchantData?.displayName ?? "",
      websiteUrl: stripeMerchantData?.websiteUrl ?? "",
      country: "",
      addressLine1: "",
      addressLine2: "",
      city: "",
      stateProvince: "",
      postalCode: "",
      taxId: "",
      defaultCurrency:
        stripeMerchantData?.defaultCurrency ??
        (selectedProvider === "dodo" ? "USD" : "EUR"),
    },
    onSubmit: ({ value }) => {
      handleSaveMerchant(value);
    },
    validators: {
      onSubmit: ({ value }) => {
        // Convert empty strings to undefined
        const sanitizedValue = Object.fromEntries(
          Object.entries(value).map(([key, val]) => [
            key,
            val === "" ? undefined : val,
          ])
        );
        const result = merchantsInsertSchema.safeParse(sanitizedValue);
        if (!result.success) {
          const errors = result.error.issues.reduce(
            (acc, issue) => ({ ...acc, [issue.path[0]]: issue.message }),
            {}
          );
          return { fields: errors };
        }
        return undefined;
      },
    },
  });

  useEffect(() => {
    if (!isPending && !session?.user?.id) {
      router.replace("/login");
    }
  }, [session, isPending, router]);

  // Check onboarding completion status and redirect if already completed
  useEffect(() => {
    const checkOnboardingStatus = async () => {
      if (isPending || !session?.user?.id || onboardingChecked) {
        return;
      }

      try {
        // If merchant exists, check the onboarding status
        if (session?.merchant?.id) {
          const onboardingResponse =
            await apiClient.merchants.checkonboarding.$get();

          if (onboardingResponse.ok) {
            const onboardingData = await onboardingResponse.json();

            // If both merchant and payment provider are set up, redirect to dashboard
            if (onboardingData.hasPaymentProvider) {
              router.replace("/dashboard");
              return;
            }

            // If merchant exists but no payment provider, redirect to payment provider setup
            router.replace("/developer/stripe");
            return;
          }
        }

        // If we reach here, either no merchant, no session, or API failed
        setOnboardingChecked(true);
      } catch (error) {
        console.error("Error checking onboarding status:", error);
        // On error, continue with onboarding
        setOnboardingChecked(true);
      }
    };

    checkOnboardingStatus();
  }, [session, isPending, router, onboardingChecked]);

  // Redirect to login only after onboarding check is done
  useEffect(() => {
    if (!isPending && onboardingChecked && !session?.user?.id) {
      router.replace("/login");
    }
  }, [isPending, onboardingChecked, session, router]);

  useEffect(() => {
    if (organizations?.length) {
      organization.setActive({ organizationId: organizations[0].id });
    }
  }, [organizations]);

  // Update default currency when payment provider changes
  useEffect(() => {
    if (selectedProvider && !stripeMerchantData?.defaultCurrency) {
      const defaultCurrency = selectedProvider === "dodo" ? "USD" : "EUR";
      form.setFieldValue("defaultCurrency", defaultCurrency);
    }
  }, [selectedProvider, stripeMerchantData?.defaultCurrency, form]);

  const [steps, setSteps] = useState<Step[]>([
    {
      id: 0,
      title: "Choose Payment Provider",
      completed: false,
      active: true,
    },
    {
      id: 1,
      title: "API Keys (optional)",
      subtitle: "Needed to process payments, they can also be set up later",
      completed: false,
      active: false,
    },
    {
      id: 2,
      title: "Your merchant information",
      completed: false,
      active: false,
    },
    {
      id: 3,
      title: "Set up NextJS",
      subtitle: "Install Lumen by copy & pasting the code snippets below",
      completed: false,
      active: false,
    },
  ]);

  // Dynamic steps based on selected provider
  const getStepsForProvider = (): Step[] => {
    const baseSteps = [
      {
        id: 0,
        title: "Choose Payment Provider",
        completed: false,
        active: true,
      },
      {
        id: 1,
        title: "API Keys (optional)",
        subtitle: "Needed to process payments, they can also be set up later",
        completed: false,
        active: false,
      },
      {
        id: 2,
        title: "Your merchant information",
        completed: false,
        active: false,
      },
    ];

    baseSteps.push({
      id: 3,
      title: "Set up NextJS",
      subtitle: "Install Lumen by copy & pasting the code snippets below",
      completed: false,
      active: false,
    });

    return baseSteps;
  };

  const fetchPublishableKey = async (environment: "live" | "test" = "live") => {
    try {
      const response = await apiClient["api-keys"]["publishable"].$get({
        query: { environment },
      });
      if (!response.ok) {
        if (response.status === 404) {
          setPublishableKey(null);
          return;
        }
        throw new Error("Failed to fetch publishable key");
      }
      const result = await response.json();
      setPublishableKey(result.data || null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load publishable key.";
      toast.error(message);
    }
  };

  const createSecretKey = async () => {
    try {
      const payload: CreateApiKeyPayload = {
        name: "Secret Key created during Onboarding",
        keyType: "secret",
        environment: "live",
      };

      const response = await apiClient["api-keys"].$post({
        json: payload,
      });

      const result = await response.json();

      if (
        response.ok &&
        "success" in result &&
        result.success &&
        "data" in result
      ) {
        setCreatedSecretKey(result.data as CreatedApiKey);
        return result.data as CreatedApiKey;
      } else {
        throw new Error("Failed to create secret key");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create secret key.";
      toast.error(message);
      throw err;
    }
  };

  const handleFetchData = async () => {
    if (!secretKey) {
      toast.error("Please enter your Secret Key.");
      return;
    }
    setLoading(true);
    try {
      const response = await apiClient.merchants["merchant-data"].$post({
        json: {
          stripeSecretKey: secretKey,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch merchant data");
      }

      const data = await response.json();
      setStripeMerchantData(data);
      // Mark API Key step as completed and activate merchant info step
      const newSteps = steps.map((step) => {
        if (step.id === 1) return { ...step, completed: true, active: false };
        if (step.id === 2) return { ...step, active: true };
        return step;
      });
      setSteps(newSteps);
      setCurrentStep(2);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to fetch merchant data"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleProviderSelection = (provider: PaymentProvider) => {
    setSelectedProvider(provider);
    // Update steps based on provider and mark provider selection step as completed
    const providerSteps = getStepsForProvider();
    const newSteps = providerSteps.map((step) => {
      if (step.id === 0) return { ...step, completed: true, active: false };
      if (step.id === 1)
        return {
          ...step,
          active: true,
          title:
            provider === "stripe"
              ? "Stripe API Keys (optional)"
              : "Dodo Payments API Key (optional)",
        };
      return step;
    });
    setSteps(newSteps);
    setCurrentStep(1);
  };

  const handleSkipProviderSelection = () => {
    // Skip directly to merchant information step
    setSelectedProvider(null);
    const providerSteps = getStepsForProvider();
    const newSteps = providerSteps.map((step) => {
      if (step.id === 0) return { ...step, completed: true, active: false };
      if (step.id === 1) return { ...step, active: false };
      if (step.id === 2) return { ...step, active: true };
      return step;
    });
    setSteps(newSteps);
    setCurrentStep(2);
  };

  const handleContinueInApiKeys = async () => {
    // Only validate Stripe keys if Stripe is selected
    if (selectedProvider === "stripe" && secretKey && publicKey) {
      const stripeValidationResponse = await apiClient.stripe[
        "validate-keys"
      ].$post({
        json: {
          secretKey,
          publicKey,
        },
      });

      if (!stripeValidationResponse.ok) {
        const errorData = (await stripeValidationResponse.json()) as {
          error: string;
        };
        setLoading(false);
        toast.error(errorData.error || "Failed to validate Stripe keys");
        return;
      }
    }

    // Only validate Dodo Payments key if Dodo is selected
    if (selectedProvider === "dodo" && secretKey) {
      const dodoValidationResponse = await apiClient.dodo["validate-key"].$post(
        {
          json: {
            secretKey,
          },
        }
      );

      if (!dodoValidationResponse.ok) {
        const errorData = (await dodoValidationResponse.json()) as {
          error: string;
        };
        setLoading(false);
        toast.error(errorData.error || "Failed to validate Dodo API key");
        return;
      }
    }

    if (selectedProvider === "stripe") {
      await handleFetchData();
    } else {
      // For Dodo, skip merchant-data fetch and go directly to merchant info
      const newSteps = steps.map((step) => {
        if (step.id === 1) return { ...step, completed: true, active: false };
        if (step.id === 2) return { ...step, active: true };
        return step;
      });
      setSteps(newSteps);
      setCurrentStep(2);
    }
  };

  const handleSkipProviderOnboarding = () => {
    // Mark API Key step as completed and activate merchant info step
    const newSteps = steps.map((step) => {
      if (step.id === 1) return { ...step, active: false };
      if (step.id === 2) return { ...step, active: true };
      return step;
    });
    setSecretKey("");
    setPublicKey("");
    setSteps(newSteps);
    setCurrentStep(2);
  };

  const handleGoBack = () => {
    if (currentStep === 1) {
      // Go back to provider selection, reset provider and keys
      setSelectedProvider(null);
      setSecretKey("");
      setPublicKey("");
      const newSteps = steps.map((step) => {
        if (step.id === 0) return { ...step, completed: false, active: true };
        if (step.id === 1)
          return {
            ...step,
            completed: false,
            active: false,
            title: "API Keys (optional)",
          };
        return { ...step, completed: false, active: false };
      });
      setSteps(newSteps);
      setCurrentStep(0);
    }
  };

  const handleSaveMerchant = async (value: MerchantData) => {
    setLoading(true);
    try {
      let orgId = activeOrganization?.data?.id;
      if (!orgId) {
        const org = await organization.create({
          name: value.legalName,
          slug:
            removeSpecialChars(value.legalName).split(" ").join("-") +
            "-" +
            Date.now(),
        });
        orgId = org?.data?.id;
      }
      if (
        orgId &&
        value.addressLine1 &&
        value.city &&
        value.postalCode &&
        value.country
      ) {
        // Use the client with proper RPC method ($post)
        const response = await apiClient.merchants[
          "onboarding-create-merchant"
        ].$post({
          json: {
            userId: session!.user!.id,
            organizationId: orgId,
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
          console.log("Error creating merchant:", errorData);
          toast.error("Error creating merchant");
          setLoading(false);
          return;
        }

        await refetch();

        // Save API keys if they were validated earlier
        if (selectedProvider === "stripe" && secretKey && publicKey) {
          const stripeResponse = await apiClient.stripe.config.$post({
            json: {
              secretKey,
              publicKey,
            },
          });

          if (!stripeResponse.ok) {
            console.log(
              "🚀 ~ handleSaveMerchant ~ stripeResponse:",
              stripeResponse
            );
            toast.error("Failed to save Stripe keys");
            setLoading(false);
            return;
          }
        }

        if (selectedProvider === "dodo" && secretKey) {
          const dodoResponse = await apiClient.dodo.config.$post({
            json: {
              secretKey,
            },
          });

          if (!dodoResponse.ok) {
            toast.error("Failed to save Dodo API key");
            setLoading(false);
            return;
          }
        }

        // Mark merchant info step as completed and activate NextJS setup (step 3)
        const newSteps = steps.map((step) => {
          if (step.id === 2) return { ...step, completed: true, active: false };
          if (step.id === 3) return { ...step, active: true };
          return step;
        });
        setSteps(newSteps);
        setCurrentStep(3);

        // Create a new secret key and fetch the publishable key
        await createSecretKey();
        await fetchPublishableKey();
        setLoading(false);
      } else {
        toast.error("Failed to create organization");
        setLoading(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "An error occurred");
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key === "Enter" &&
      secretKey &&
      (selectedProvider === "dodo" || publicKey) &&
      !loading
    ) {
      handleContinueInApiKeys();
    }
  };

  const generateMockData = () => {
    const mockCompanyName = randomCompanyName();
    const mockAddress = randomAddress();

    // Set form values with mock data
    form.setFieldValue("legalName", mockCompanyName);
    form.setFieldValue("displayName", mockCompanyName);
    form.setFieldValue(
      "websiteUrl",
      `https://www.${mockCompanyName
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9]/g, "")}.com`
    );
    form.setFieldValue("country", mockAddress.country);
    form.setFieldValue("addressLine1", mockAddress.addressLine1);
    form.setFieldValue("addressLine2", mockAddress.addressLine2);
    form.setFieldValue("city", mockAddress.city);
    form.setFieldValue("postalCode", mockAddress.postalCode);
    form.setFieldValue("taxId", `TAX${Math.floor(Math.random() * 1000000)}`);
    setMockDataGenerated(true);
  };

  // Show loading while checking authentication or onboarding status
  if (isPending || !onboardingChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Left Sidebar */}
      <div className="w-64 bg-gray-50 p-6 border-r">
        <div className="space-y-4">
          {steps.map((step) => (
            <div
              key={step.id}
              className={`flex items-start space-x-3 ${
                step.active ? "" : "opacity-50"
              }`}
            >
              <div
                className={`flex-shrink-0 w-6 h-6 rounded-full ${
                  step.completed
                    ? "bg-blue-500"
                    : step.active
                      ? "border-2 border-blue-500"
                      : "border-2 border-gray-300"
                } flex items-center justify-center text-sm text-white`}
              >
                {step.completed ? <Check className="w-4 h-4" /> : step.id}
              </div>
              <div className="space-y-1">
                <div className="font-medium">{step.title}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="absolute bottom-6 space-y-2">
          <div className="text-sm text-muted-foreground truncate max-w-[200px]">
            {session?.user?.email}
          </div>
          <Button
            variant="ghost"
            onClick={() =>
              signOut({
                fetchOptions: {
                  onSuccess: () => {
                    router.push("/");
                  },
                },
              })
            }
            className="text-sm"
          >
            Sign out
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6">
        <div className="max-w-[50%] mx-auto">
          <Card>
            {/* Step 0: Payment Provider Selection */}
            {currentStep === 0 && (
              <>
                <CardHeader>
                  <CardTitle>{steps[currentStep].title}</CardTitle>
                  <CardDescription>
                    {steps[currentStep].subtitle}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mb-4">
                    <Button
                      variant="outline"
                      onClick={handleSkipProviderSelection}
                    >
                      Skip (you can set this up later)
                    </Button>
                  </div>
                  <PaymentProviders
                    onStripeClick={() => handleProviderSelection("stripe")}
                    onDodoClick={() => handleProviderSelection("dodo")}
                    onBetaRequestClick={async (paymentProvider: string) => {
                      await apiClient.beta.request.$post({
                        json: {
                          metadata: {
                            paymentProvider,
                          },
                        },
                      });
                      toast.success("Beta request sent successfully!");
                    }}
                  />
                </CardContent>
              </>
            )}

            {/* Step 1: API Key */}
            {currentStep === 1 && (
              <>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>{steps[currentStep].title}</CardTitle>
                      <CardDescription>
                        {steps[currentStep].subtitle}
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      onClick={handleGoBack}
                      disabled={loading}
                      size="sm"
                    >
                      Back
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {/* Show selected provider */}
                    <div className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg">
                      <div>
                        <div className="text-sm text-gray-600">
                          {selectedProvider === "stripe" ? (
                            <>
                              Get your API keys at{" "}
                              <a
                                href="https://dashboard.stripe.com/apikeys"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                https://dashboard.stripe.com/apikeys
                              </a>
                            </>
                          ) : (
                            <>
                              Get your API key at{" "}
                              <a
                                href="https://app.dodopayments.com/developer/api-keys"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                https://app.dodopayments.com/developer/api-keys
                              </a>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Stripe requires both keys */}
                    {selectedProvider === "stripe" && (
                      <div className="space-y-2">
                        <Label htmlFor="publicKey">
                          Stripe Publishable Key
                        </Label>
                        <Input
                          id="publicKey"
                          type="text"
                          autoComplete="off"
                          spellCheck="false"
                          value={publicKey}
                          onChange={(e) => setPublicKey(e.target.value)}
                          onKeyDown={handleKeyDown}
                          placeholder="pk_live_..."
                        />
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="secretKey">
                        {selectedProvider === "stripe"
                          ? "Stripe Secret Key"
                          : "Dodo Payments Secret Key"}
                      </Label>
                      <Input
                        id="secretKey"
                        type="text"
                        autoComplete="off"
                        spellCheck="false"
                        value={secretKey}
                        onChange={(e) => setSecretKey(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={
                          selectedProvider === "stripe"
                            ? "sk_live_..."
                            : "xxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        }
                      />
                    </div>

                    <div className="flex space-x-2 mt-2">
                      <Button
                        onClick={handleContinueInApiKeys}
                        disabled={
                          !secretKey ||
                          (selectedProvider === "stripe" && !publicKey) ||
                          loading
                        }
                      >
                        {loading ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          "Continue"
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleSkipProviderOnboarding}
                        disabled={loading}
                      >
                        Skip, do it later
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </>
            )}

            {/* Step 2: Merchant Information */}
            {currentStep === 2 && (
              <>
                <CardHeader>
                  <CardTitle>{steps[currentStep].title}</CardTitle>
                  {selectedProvider === "stripe" &&
                    isStripeOnboardingComplete && (
                      <CardDescription>
                        We pulled data from your Stripe account, complete the
                        missing information
                      </CardDescription>
                    )}
                  {selectedProvider === "dodo" && (
                    <CardDescription>
                      Enter your merchant information to get started
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent>
                  <div
                    onClick={generateMockData}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        generateMockData();
                      }
                    }}
                    className="mb-4 w-full p-4 border border-gray-300 rounded-md cursor-pointer hover:bg-gray-50 focus:outline-none text-center transition-colors"
                  >
                    {mockDataGenerated ? (
                      <div className="text-sm">
                        Now click continue at the bottom of the page
                      </div>
                    ) : (
                      <>
                        <div className="text-sm text-gray-700">
                          Click here to generate mock merchant data if you are
                          just testing the Lumen platform
                        </div>
                        <div className="text-sm text-gray-500 mt-1">
                          (you can update to your real data later)
                        </div>
                      </>
                    )}
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      form.handleSubmit();
                    }}
                  >
                    <form.AppField
                      name="legalName"
                      children={(field) => (
                        <field.TextField label="Legal Name" />
                      )}
                    />
                    <form.AppField
                      name="displayName"
                      children={(field) => (
                        <field.TextField label="Display Name" />
                      )}
                    />
                    <form.AppField
                      name="websiteUrl"
                      children={(field) => (
                        <field.TextField label="Website URL" />
                      )}
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
                      children={(field) => (
                        <field.TextField label="Address Line 1" />
                      )}
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
                      children={(field) => (
                        <field.TextField label="State/Province" isOptional />
                      )}
                    />
                    <form.AppField
                      name="postalCode"
                      children={(field) => (
                        <field.TextField label="Postal Code" />
                      )}
                    />
                    <form.AppField
                      name="defaultCurrency"
                      children={(field) => {
                        const availableCurrencies = getCurrenciesForProvider(
                          selectedProvider as
                            | "stripe"
                            | "dodo"
                            | "paddle"
                            | "checkout"
                            | "adyen"
                            | null
                        );
                        const currencyOptions = availableCurrencies.map(
                          (currency) => ({
                            value: currency.code,
                            label: formatCurrencyOption(currency),
                          })
                        );

                        return (
                          <field.Dropdown
                            label="Default Currency"
                            defaultValue={
                              selectedProvider === "dodo" ? "USD" : "EUR"
                            }
                            options={currencyOptions}
                            searchEnabled={false}
                          />
                        );
                      }}
                    />
                    <form.AppForm>
                      <Button
                        type="submit"
                        disabled={loading}
                        className="w-full"
                      >
                        {loading ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          "Continue"
                        )}
                      </Button>
                    </form.AppForm>
                  </form>
                </CardContent>
              </>
            )}

            {/* Step 3: API Keys Display */}
            {currentStep === 3 && (
              <>
                <CardHeader>
                  <CardTitle>{steps[currentStep].title}</CardTitle>
                  <CardDescription>
                    {steps[currentStep].subtitle}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {publishableKey && createdSecretKey && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-lg font-medium mb-2">
                          Copy into your .env file.
                        </h3>
                        <p className="text-sm text-gray-600 mb-3">
                          LUMEN_API_KEY value will not be shown again after this
                          step. But you easily create a new key at
                          https://getlumen.dev/developer/apikeys
                        </p>
                        <div className="mt-4">
                          <CodeBlock
                            code={`NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY=${publishableKey.keyValue}\nLUMEN_API_KEY=${createdSecretKey.keyValue}`}
                            language="typescript"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                  <div>
                    <h3 className="text-lg font-medium mb-2">
                      Install Lumen packages
                    </h3>
                    <div className="mt-4">
                      <CodeBlock
                        code={`npm i @getlumen/react @getlumen/server`}
                        language="bash"
                      />
                    </div>
                  </div>

                  <div className="pt-4 border-t">
                    <Button
                      onClick={() => router.push("/plans/create")}
                      className="w-full mb-2"
                    >
                      I have copied the keys into my .env file. Go to create
                      plan
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => router.push("/dashboard")}
                      className="w-full"
                    >
                      Skip onboarding and go to dashboard
                    </Button>
                  </div>
                </CardContent>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
