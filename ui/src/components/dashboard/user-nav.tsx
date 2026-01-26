"use client";

import { Button } from "@/components/ui/button";
import { useSession, signOut, admin } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { CommandPalette } from "./command-palette";
import { LogOut, Settings, Shield, UserX, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { YC_ENROLLMENT_FEATURE_SLUG } from "@lumen/common/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
// import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface FeatureEntitlement {
  entitled: boolean | null;
  feature: { slug: string; value: boolean | string | number | null } | null;
}

const getEntitlements = async () => {
  const res = await fetch("/api/lumen/entitlements/{customerId}", {
    credentials: "include",
  });
  return res.json();
};

export function UserNav() {
  const { data: session } = useSession();
  const router = useRouter();
  const [entitlements, setEntitlements] = useState<FeatureEntitlement[]>([]);

  // Check if currently impersonating a user
  const isImpersonating = session?.session?.impersonatedBy;

  useEffect(() => {
    getEntitlements().then((data) => {
      setEntitlements(data.entitlements || []);
    });
  }, []);

  const hasYcEntitlement = useMemo(
    () =>
      entitlements.some((e) => e?.feature?.slug === YC_ENROLLMENT_FEATURE_SLUG),
    [entitlements]
  );

  const handleStopImpersonating = async () => {
    try {
      const result = await admin.stopImpersonating();

      if (result.error) {
        console.error("Failed to stop impersonating:", result.error.message);
        return;
      }

      // Refresh the page to get the original session back
      window.location.reload();
    } catch (err) {
      console.error("Error stopping impersonation:", err);
    }
  };

  return (
    <div className="flex items-center justify-end shrink-0 font-sans">
      {/* Company Info Dropdown */}
      <div className="flex items-center justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className={`h-auto p-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-md border border-transparent hover:border-border transition-colors ${
                isImpersonating
                  ? "bg-orange-50 border-orange-200 hover:bg-orange-100"
                  : ""
              }`}
            >
              <div className="flex items-center gap-2">
                {isImpersonating && (
                  <Shield className="h-4 w-4 text-orange-600" />
                )}
                <div className="flex flex-col items-end text-right">
                  <span
                    className={`text-sm font-semibold leading-tight ${
                      isImpersonating ? "text-orange-800" : "text-foreground"
                    }`}
                  >
                    {hasYcEntitlement ? (
                      <Badge className="mr-2 bg-orange-50 text-orange-700 border-orange-200">
                        YC
                      </Badge>
                    ) : null}
                    {session?.merchant?.displayName || "No Company"}
                    {isImpersonating && (
                      <span className="ml-2 text-xs font-normal text-orange-600">
                        (Impersonating)
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-xs leading-tight mt-1 opacity-70 ${
                      isImpersonating
                        ? "text-orange-700"
                        : "text-muted-foreground"
                    }`}
                  >
                    {session?.user?.email || "No email"}
                  </span>
                </div>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" forceMount>
            {isImpersonating && (
              <>
                <DropdownMenuItem
                  onClick={handleStopImpersonating}
                  className="text-orange-700 focus:text-orange-800 focus:bg-orange-50"
                >
                  <UserX className="mr-2 h-4 w-4" />
                  <span>Stop Impersonating</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              onClick={() => router.push("/billing")}
              className="flex flex-col items-start gap-1 py-2"
            >
              <span className="flex items-center text-sm font-medium text-foreground">
                <Wallet className="mr-2 h-4 w-4" />
                My Lumen Subscription
              </span>
              <span className="text-xs text-muted-foreground ml-6">
                Manage your plan, payment method, and Lumen invoices.
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/merchant")}>
              <Settings className="mr-2 h-4 w-4" />
              <span>Workspace Settings</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                signOut({
                  fetchOptions: {
                    onSuccess: () => {
                      router.push("/");
                    },
                  },
                })
              }
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CommandPalette />
    </div>
  );
}
