"use client";

import { PricingTable } from "@/components/ui/pricing-table";
import { useSession } from "@/lib/auth-client";

export default function PricingPage() {
  const { data: session, isPending } = useSession();

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
        />
      </div>
    </section>
  );
}
