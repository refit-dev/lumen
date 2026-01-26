/**
 * Hook for tracking usage quotas
 */

import { useMemo } from "react";
import type { UseQueryOptions } from "../types";
import { useFeature } from "./useFeature";
import { isNearLimit, isOverLimit, formatUsage } from "../lib/utils";

export interface UseUsageQuotaResult {
  used: number;
  limit: number | null;
  percentage: number | null;
  formatted: string;
  isNearLimit: boolean;
  isOverLimit: boolean;
  isUnlimited: boolean;
  loading: boolean;
  error: Error | null;
}

/**
 * Hook to track usage quota for a feature
 *
 * @example
 * ```tsx
 * function ApiUsageDisplay() {
 *   const {
 *     used,
 *     limit,
 *     percentage,
 *     isNearLimit,
 *     isOverLimit,
 *     loading
 *   } = useUsageQuota(userId, "api-calls", 0.8);
 *
 *   if (loading) return <div>Loading...</div>;
 *
 *   return (
 *     <div>
 *       <h3>API Usage</h3>
 *       <p>{used} / {limit || "Unlimited"}</p>
 *       {isNearLimit && <p className="warning">Approaching limit!</p>}
 *       {isOverLimit && <p className="error">Limit exceeded!</p>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useUsageQuota(
  userId: string,
  featureSlug: string,
  warnThreshold: number = 0.8,
  options: UseQueryOptions = {}
): UseUsageQuotaResult {
  const { usage, loading, error } = useFeature(
    userId,
    featureSlug,
    options
  );

  const result = useMemo(() => {
    const used = usage?.used || 0;
    const limit = usage?.limit || null;

    const formattedUsage = formatUsage(used, limit);

    return {
      used,
      limit,
      percentage: formattedUsage.percentage,
      formatted: formattedUsage.formatted,
      isNearLimit: isNearLimit(used, limit, warnThreshold),
      isOverLimit: isOverLimit(used, limit),
      isUnlimited: formattedUsage.isUnlimited,
    };
  }, [usage, warnThreshold]);

  return {
    ...result,
    loading,
    error,
  };
}
