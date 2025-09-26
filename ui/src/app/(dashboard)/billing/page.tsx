"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { CustomerPortalShadcn } from "@/components/ui/pricing-table";
import { useSession } from "@/lib/auth-client";
import { PageContent } from "@/components/dashboard/page-content";

export default function BillingPage() {
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { data: session } = useSession();
  const environment = process.env.NEXT_PUBLIC_API_URL?.includes("localhost")
    ? "test"
    : "live";

  useEffect(() => {
    const loadMerchantId = async () => {
      try {
        setLoading(true);

        // We can get the merchant ID from the session or make an API call
        // For now, we'll set it to load the component
        setMerchantId("loaded"); // This triggers the CustomerPortal to load
      } catch (error) {
        console.error("Failed to load merchant data:", error);
      } finally {
        setLoading(false);
      }
    };

    loadMerchantId();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <PageContent title="Lumen Account & Billing">
      <div className="max-w-6xl w-full mx-auto p-6">
        <div className="space-y-6 mb-8">
          <div>
            <p className="text-muted-foreground mt-2">
              Manage your Lumen subscription, view invoices, and update payment
              methods
            </p>
          </div>
        </div>

        {merchantId ? (
          <CustomerPortalShadcn
            lumenHandlerUrl={`${process.env.NEXT_PUBLIC_API_URL}/v1/lumen`}
            externalCustomerId={session?.user?.id || ""}
            className="mt-2"
            apiBaseUrl={`${process.env.NEXT_PUBLIC_API_URL}/v1`}
            environment={environment}
          />
        ) : (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading billing
            portal...
          </div>
        )}
      </div>
    </PageContent>
  );
}
