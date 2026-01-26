"use client";

import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { UserNav } from "@/components/dashboard/user-nav";
import { SearchButton } from "@/components/dashboard/search-button";
import {
  PageTitleProvider,
  usePageTitle,
} from "@/components/dashboard/page-title-context";
import { useSession, getSession } from "@/lib/auth-client";
import type { EnhancedSession } from "@lumen/common";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useCookieConsent } from "@/lib/cookie-consent-context";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { LocaleProvider } from "@/lib/locale-context";
import { apiClient } from "@/lib/hono-client";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

const queryClient = new QueryClient();

function DashboardHeader() {
  const { title } = usePageTitle();

  return (
    <header className="relative flex h-16 shrink-0 items-center gap-2 border-b bg-background px-4 font-sans">
      <div className="flex items-center gap-3 w-full">
        <SidebarTrigger className="-ml-1" />
        <div className="flex-1 flex items-center justify-between min-w-0">
          <h1 className="text-lg font-semibold mr-4 flex-1 min-w-0 truncate whitespace-nowrap">
            {title}
          </h1>
          <UserNav />
        </div>
      </div>

      {/* Centered search button */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <SearchButton />
      </div>
    </header>
  );
}

function LocaleWrapper({ children }: { children: React.ReactNode }) {
  const { data: merchant } = useQuery({
    queryKey: ["current-merchant-locale"],
    queryFn: async () => {
      const response = await apiClient.merchants.current.$get();
      if (!response.ok) {
        return null; // Gracefully handle if merchant data isn't available
      }
      const data = await response.json();
      if ("error" in data) {
        return null;
      }
      return data;
    },
    retry: false, // Don't retry if it fails
    refetchOnWindowFocus: false,
  });

  return (
    <LocaleProvider merchantCountry={merchant?.country}>
      {children}
    </LocaleProvider>
  );
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const { data, isPending } = useSession();
  const session = (data as unknown as EnhancedSession) || null;
  const router = useRouter();
  const { autoConsentOnLogin } = useCookieConsent();

  useEffect(() => {
    let cancelled = false;
    const ensureMerchantAndMaybeRedirect = async () => {
      if (isPending) return;
      if (!session?.user) {
        router.replace("/login");
        return;
      }
      if (!session?.merchant?.id) {
        try {
          const { data: freshData } = await getSession({
            query: { disableCookieCache: true },
          });
          const fresh = (freshData as unknown as EnhancedSession) || null;
          if (!cancelled && !fresh?.merchant?.id) {
            router.replace("/onboarding");
            return;
          }
        } catch {
          if (!cancelled) router.replace("/onboarding");
          return;
        }
      }

      if (!cancelled) {
        autoConsentOnLogin();
      }
    };
    ensureMerchantAndMaybeRedirect();
    return () => {
      cancelled = true;
    };
  }, [
    session?.user,
    session?.merchant?.id,
    isPending,
    router,
    autoConsentOnLogin,
  ]);

  // Show loading state while checking authentication
  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" />
      </div>
    );
  }

  // Only render the layout if authenticated && merchant is created
  if (!session?.user || !session?.merchant?.id) {
    return null;
  }

  return (
    <PageTitleProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <DashboardHeader />
          <QueryClientProvider client={queryClient}>
            <LocaleWrapper>
              <div className="flex flex-1 flex-col gap-4 p-6 pt-6 font-sans">
                {children}
              </div>
            </LocaleWrapper>
          </QueryClientProvider>
        </SidebarInset>
      </SidebarProvider>
    </PageTitleProvider>
  );
}
