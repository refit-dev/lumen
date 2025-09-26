"use client";

import { PricingTable } from "@/components/ui/pricing-table";
import { useSession } from "@/lib/auth-client";
import { useEffect, useState } from "react";
import { apiClient } from "@/lib/hono-client";

export default function PricingPage() {
  const { data: session, isPending } = useSession();
  const environment = process.env.NEXT_PUBLIC_API_URL?.includes("localhost")
    ? "test"
    : "live";

  const [initialCustomer, setInitialCustomer] = useState<
    | {
        email?: string;
        name?: string;
        businessName?: string;
        address?: string;
        addressLine2?: string;
        zip?: string;
        city?: string;
        country?: string;
        stateProvince?: string;
        taxId?: string;
        isBusiness?: boolean;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    if (isPending) return;
    if (!session?.user) {
      setInitialCustomer(undefined);
      return;
    }

    // Seed from session immediately
    const seeded: Record<string, string | boolean | undefined> = {
      email: session.user.email || undefined,
      name: session.user.name || undefined,
      businessName:
        session.merchant?.displayName ||
        session.merchant?.legalName ||
        undefined,
    };

    // Set provisional "isBusiness" if we have a business name
    if (seeded.businessName) {
      seeded.isBusiness = true;
    }

    setInitialCustomer(seeded);

    // Enrich with full merchant profile
    (async () => {
      try {
        const resp = await apiClient.merchants.current.$get();
        if (!resp.ok) return;
        const merchant = await resp.json();
        const enriched: Record<string, string | boolean | undefined> = {
          ...seeded,
          businessName:
            merchant.displayName ||
            merchant.legalName ||
            (seeded.businessName as string | undefined),
          taxId: merchant.taxId || undefined,
          address: merchant.addressLine1 || undefined,
          addressLine2: merchant.addressLine2 || undefined,
          city: merchant.city || undefined,
          stateProvince: merchant.stateProvince || undefined,
          zip: merchant.postalCode || undefined,
          country: merchant.country || undefined,
        };
        // Mark as business only if we have a strong signal (businessName or taxId)
        enriched.isBusiness = Boolean(enriched.businessName || enriched.taxId);
        setInitialCustomer(enriched);
      } catch {
        // ignore failures; seeded values are still useful
      }
    })();
  }, [isPending, session]);

  console.log("environment", environment, process.env.NEXT_PUBLIC_ENVIRONMENT);
  if (isPending) {
    return null;
  }

  return (
    <section className="relative pt-24 pb-32 px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-light text-gray-900 mb-6 tracking-tight leading-none">
            Simple, transparent{" "}
            <span className="bg-gradient-to-r from-gray-900 via-gray-800 to-gray-700 bg-clip-text text-transparent font-medium">
              pricing
            </span>
          </h1>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto leading-relaxed">
            Start free and scale as you grow. No hidden fees, no surprises.
          </p>
        </div>

        <PricingTable
          userId={session?.user?.id}
          loginRedirectUrl="/login"
          apiBaseUrl={process.env.NEXT_PUBLIC_API_URL + "/v1"}
          lumenHandlerUrl={process.env.NEXT_PUBLIC_API_URL + "/v1/lumen"}
          paymentProvider="dodo"
          environment={environment}
          initialCustomer={initialCustomer}
        />
      </div>
    </section>
  );
}
