/**
 * Hook for gating features based on entitlements
 */

import { useMemo } from "react";
import type { UseQueryOptions } from "../types";
import { useFeature } from "./useFeature";
import { getUpgradeReason } from "../lib/utils";
import { useEntitlements } from "./useEntitlements";

export interface UseFeatureGateResult {
  canAccess: boolean;
  showUpgrade: boolean;
  reason: string | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Hook to check if a user can access a feature with upgrade prompts
 *
 * @example
 * ```tsx
 * function PremiumFeature() {
 *   const { canAccess, showUpgrade, reason, loading } = useFeatureGate(
 *     userId,
 *     "premium-analytics"
 *   );
 *
 *   if (loading) return <div>Loading...</div>;
 *
 *   if (!canAccess) {
 *     return (
 *       <div>
 *         <h2>Upgrade Required</h2>
 *         <p>{reason}</p>
 *         <button>Upgrade Now</button>
 *       </div>
 *     );
 *   }
 *
 *   return <PremiumAnalyticsDashboard />;
 * }
 * ```
 */
export function useFeatureGate(
  userId: string,
  featureSlug: string,
  options: UseQueryOptions = {}
): UseFeatureGateResult {
  const { entitled, loading, error } = useFeature(
    userId,
    featureSlug,
    options
  );
  const { entitlements } = useEntitlements(userId, options);

  const upgradeInfo = useMemo(() => {
    if (!entitlements?.entitlements) {
      return { showUpgrade: false, reason: null };
    }

    const entitlement = entitlements.entitlements.find(
      (e) => e.feature?.slug === featureSlug
    );

    if (!entitlement) {
      return {
        showUpgrade: true,
        reason: "This feature is not available in your current plan",
      };
    }

    const upgradeReason = getUpgradeReason(entitlement);

    return {
      showUpgrade: upgradeReason !== null,
      reason: upgradeReason?.reason || null,
    };
  }, [entitlements, featureSlug]);

  return {
    canAccess: entitled,
    showUpgrade: upgradeInfo.showUpgrade,
    reason: upgradeInfo.reason,
    loading,
    error,
  };
}
