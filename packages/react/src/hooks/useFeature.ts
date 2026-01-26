/**
 * Hook for checking a specific feature entitlement
 */

import { useMemo } from "react";
import type { UseQueryOptions } from "../types";
import { useEntitlements } from "./useEntitlements";
import { canAccessFeature, getFeatureUsage } from "../lib/utils";

export interface UseFeatureResult {
  entitled: boolean;
  value: boolean | string | number | null;
  usage: { used: number; limit: number | null } | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Hook to check entitlement for a specific feature
 *
 * @example
 * ```tsx
 * function PremiumFeature() {
 *   const { entitled, loading } = useFeature(userId, "premium-analytics");
 *
 *   if (loading) return <div>Loading...</div>;
 *   if (!entitled) return <div>Upgrade to access this feature</div>;
 *
 *   return <PremiumAnalyticsDashboard />;
 * }
 * ```
 *
 * @example
 * ```tsx
 * function ApiCallsCounter() {
 *   const { usage, loading } = useFeature(userId, "api-calls");
 *
 *   if (loading) return <div>Loading...</div>;
 *
 *   return (
 *     <div>
 *       API Calls: {usage?.used} / {usage?.limit || "Unlimited"}
 *     </div>
 *   );
 * }
 * ```
 */
export function useFeature(
  userId: string,
  featureSlug: string,
  options: UseQueryOptions = {}
): UseFeatureResult {
  const { entitlements, loading, error } = useEntitlements(userId, options);

  const result = useMemo(() => {
    if (!entitlements?.entitlements) {
      return {
        entitled: false,
        value: null,
        usage: null,
      };
    }

    const entitled = canAccessFeature(entitlements.entitlements, featureSlug);

    const entitlement = entitlements.entitlements.find(
      (e) => e.feature?.slug === featureSlug
    );

    const value = entitlement?.feature?.value ?? null;
    const usage = getFeatureUsage(entitlements.entitlements, featureSlug);

    return {
      entitled,
      value,
      usage,
    };
  }, [entitlements, featureSlug]);

  return {
    ...result,
    loading,
    error,
  };
}
