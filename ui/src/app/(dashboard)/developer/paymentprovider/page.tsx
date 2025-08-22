"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/hono-client";
import { PaymentProviders } from "@/components/paymentproviders";
import { PageContent } from "@/components/dashboard/page-content";
import { toast } from "sonner";

export default function PaymentProviderPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [showProviders, setShowProviders] = useState(false);

  useEffect(() => {
    const checkPaymentProvider = async () => {
      try {
        const response = await apiClient.merchants["payment-provider"].$get();

        if (!response.ok) {
          toast.error("Failed to fetch payment provider");
          throw new Error("Failed to fetch payment provider");
        }

        const data = await response.json();

        if ("error" in data) {
          toast.error(data.error as string);
          throw new Error(data.error as string);
        }

        // If provider exists, redirect to developer/{provider}
        if (data.provider && data.provider !== null) {
          router.push(`/developer/${data.provider}`);
        } else {
          // If provider is null, show the PaymentProviders component
          setShowProviders(true);
        }
      } catch (error) {
        console.error("Error checking payment provider:", error);
        // On error, show the PaymentProviders component as fallback
        setShowProviders(true);
      } finally {
        setIsLoading(false);
      }
    };

    checkPaymentProvider();
  }, [router]);

  const handleStripeClick = () => {
    router.push("/developer/stripe");
  };

  const handleDodoClick = () => {
    router.push("/developer/dodo");
  };

  if (isLoading) {
    return (
      <PageContent title="Payment Provider">
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" />
        </div>
      </PageContent>
    );
  }

  if (showProviders) {
    return (
      <PageContent title="Select Payment Provider">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              Choose your payment provider
            </h2>
            <p className="text-gray-600">
              Select a payment provider to get started with processing payments.
            </p>
          </div>
          <PaymentProviders
            onStripeClick={handleStripeClick}
            onDodoClick={handleDodoClick}
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
        </div>
      </PageContent>
    );
  }

  return null;
}
