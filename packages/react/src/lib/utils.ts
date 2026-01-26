/**
 * Utility functions for working with Lumen data
 * These are client-side helpers that can be used standalone or with hooks
 */

import type {
  FeatureEntitlement,
  FormattedUsage,
  UpgradeReason,
  Subscription,
  Usage,
} from "../types";

// ============================================================================
// Usage Formatting
// ============================================================================

export interface FormatUsageOptions {
  /**
   * Show percentage in the output
   * @default true
   */
  showPercentage?: boolean;

  /**
   * Format large numbers with K/M suffixes
   * @default false
   */
  abbreviateNumbers?: boolean;

  /**
   * Custom format string
   * Variables: {used}, {limit}, {percentage}
   * @example "{used} of {limit} ({percentage}%)"
   */
  format?: string;
}

/**
 * Format usage data for display
 *
 * @example
 * ```ts
 * formatUsage(150, 1000)
 * // => { used: 150, limit: 1000, percentage: 15, formatted: "150 / 1,000 (15%)", isUnlimited: false }
 *
 * formatUsage(150, null)
 * // => { used: 150, limit: null, percentage: null, formatted: "150", isUnlimited: true }
 * ```
 */
export function formatUsage(
  used: number,
  limit: number | null,
  options: FormatUsageOptions = {}
): FormattedUsage {
  const {
    showPercentage = true,
    abbreviateNumbers = false,
    format,
  } = options;

  const isUnlimited = limit === null || limit === 0;

  const formatNumber = (n: number) => {
    if (abbreviateNumbers) {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    }
    return n.toLocaleString();
  };

  if (isUnlimited) {
    return {
      used,
      limit: null,
      percentage: null,
      formatted: formatNumber(used),
      isUnlimited: true,
    };
  }

  const percentage = limit ? Math.round((used / limit) * 100) : 0;

  let formatted: string;
  if (format) {
    formatted = format
      .replace("{used}", formatNumber(used))
      .replace("{limit}", formatNumber(limit!))
      .replace("{percentage}", percentage.toString());
  } else {
    formatted = `${formatNumber(used)} / ${formatNumber(limit!)}`;
    if (showPercentage) {
      formatted += ` (${percentage}%)`;
    }
  }

  return {
    used,
    limit,
    percentage,
    formatted,
    isUnlimited: false,
  };
}

// ============================================================================
// Limit Checking
// ============================================================================

/**
 * Check if usage is near the limit
 *
 * @param used - Current usage
 * @param limit - Usage limit (null = unlimited)
 * @param threshold - Percentage threshold (0-1)
 * @default 0.8 (80%)
 *
 * @example
 * ```ts
 * isNearLimit(850, 1000, 0.8) // => true (85% > 80%)
 * isNearLimit(750, 1000, 0.8) // => false (75% < 80%)
 * isNearLimit(100, null) // => false (unlimited)
 * ```
 */
export function isNearLimit(
  used: number,
  limit: number | null,
  threshold: number = 0.8
): boolean {
  if (limit === null || limit === 0) return false;
  return used / limit >= threshold;
}

/**
 * Check if usage has exceeded the limit
 *
 * @example
 * ```ts
 * isOverLimit(1050, 1000) // => true
 * isOverLimit(950, 1000) // => false
 * isOverLimit(100, null) // => false (unlimited)
 * ```
 */
export function isOverLimit(used: number, limit: number | null): boolean {
  if (limit === null || limit === 0) return false;
  return used >= limit;
}

// ============================================================================
// Entitlement Checking
// ============================================================================

/**
 * Check if a customer has access to a feature
 *
 * @example
 * ```ts
 * const entitlements = [...];
 * canAccessFeature(entitlements, "premium-analytics") // => true
 * ```
 */
export function canAccessFeature(
  entitlements: FeatureEntitlement[],
  featureSlug: string
): boolean {
  const entitlement = entitlements.find(
    (e) => e.feature?.slug === featureSlug
  );

  if (!entitlement) return false;

  // If entitled is explicitly set, use it
  if (entitlement.entitled !== null) {
    return entitlement.entitled;
  }

  // For numeric features with multiple metrics, we need to check usages
  if (entitlement.usages && entitlement.usages.length > 0) {
    // If there's a limit, check if any usage exceeds it
    if (
      entitlement.feature?.value &&
      typeof entitlement.feature.value === "number"
    ) {
      const limit = entitlement.feature.value;
      return entitlement.usages.every((u) => u.usage < limit);
    }
  }

  // Default to checking if feature exists and has a value
  return entitlement.feature !== null;
}

/**
 * Get the feature value from entitlements
 *
 * @example
 * ```ts
 * getFeatureValue(entitlements, "api-calls") // => 1000
 * getFeatureValue(entitlements, "premium-support") // => true
 * ```
 */
export function getFeatureValue(
  entitlements: FeatureEntitlement[],
  featureSlug: string
): boolean | string | number | null {
  const entitlement = entitlements.find(
    (e) => e.feature?.slug === featureSlug
  );
  return entitlement?.feature?.value ?? null;
}

/**
 * Get feature usage data
 *
 * @example
 * ```ts
 * getFeatureUsage(entitlements, "api-calls")
 * // => { used: 150, limit: 1000, percentage: 15 }
 * ```
 */
export function getFeatureUsage(
  entitlements: FeatureEntitlement[],
  featureSlug: string
): { used: number; limit: number | null } | null {
  const entitlement = entitlements.find(
    (e) => e.feature?.slug === featureSlug
  );

  if (!entitlement || !entitlement.usages || entitlement.usages.length === 0) {
    return null;
  }

  // Sum all usages for this feature
  const used = entitlement.usages.reduce((sum, u) => sum + u.usage, 0);

  // Get limit from feature value or credit info
  let limit: number | null = null;
  if (
    entitlement.feature?.value &&
    typeof entitlement.feature.value === "number"
  ) {
    limit = entitlement.feature.value;
  } else if (entitlement.creditInfo?.creditAllowance) {
    limit = entitlement.creditInfo.creditAllowance;
  }

  return { used, limit };
}

// ============================================================================
// Upgrade Prompts
// ============================================================================

/**
 * Get a user-friendly reason for why an upgrade is needed
 *
 * @example
 * ```ts
 * getUpgradeReason(entitlement)
 * // => { reason: "You've used 95% of your API calls", severity: "critical" }
 * ```
 */
export function getUpgradeReason(
  entitlement: FeatureEntitlement
): UpgradeReason | null {
  // Not entitled at all
  if (!entitlement.entitled) {
    return {
      reason: `This feature is not included in your current plan`,
      severity: "info",
    };
  }

  // Check if over limit
  if (entitlement.usages && entitlement.usages.length > 0) {
    const totalUsage = entitlement.usages.reduce((sum, u) => sum + u.usage, 0);

    let limit: number | null = null;
    if (
      entitlement.feature?.value &&
      typeof entitlement.feature.value === "number"
    ) {
      limit = entitlement.feature.value;
    } else if (entitlement.creditInfo?.creditAllowance) {
      limit = entitlement.creditInfo.creditAllowance;
    }

    if (limit !== null) {
      const percentage = Math.round((totalUsage / limit) * 100);

      if (totalUsage >= limit) {
        return {
          reason: `You've reached your limit for this feature`,
          severity: "critical",
          percentage,
        };
      }

      if (percentage >= 90) {
        return {
          reason: `You've used ${percentage}% of your limit for this feature`,
          severity: "critical",
          percentage,
        };
      }

      if (percentage >= 80) {
        return {
          reason: `You've used ${percentage}% of your limit for this feature`,
          severity: "warning",
          percentage,
        };
      }
    }
  }

  return null;
}

// ============================================================================
// Subscription Utilities
// ============================================================================

/**
 * Get a user-friendly subscription status
 *
 * @example
 * ```ts
 * getSubscriptionStatus(subscription)
 * // => "active" | "trial" | "past_due" | "cancelled" | "paused"
 * ```
 */
export function getSubscriptionStatus(
  subscription: Subscription | null
): string {
  if (!subscription) return "none";

  // Map status to user-friendly names
  const statusMap: Record<string, string> = {
    active: "active",
    trialing: "trial",
    past_due: "past due",
    canceled: "cancelled",
    paused: "paused",
  };

  return statusMap[subscription.status] || subscription.status;
}

/**
 * Check if subscription is in trial period
 */
export function isTrialing(subscription: Subscription | null): boolean {
  if (!subscription) return false;
  return (
    subscription.status === "trialing" &&
    subscription.trialEnd !== null &&
    new Date(subscription.trialEnd) > new Date()
  );
}

/**
 * Get days remaining in trial
 */
export function getDaysRemainingInTrial(
  subscription: Subscription | null
): number | null {
  if (!subscription || !subscription.trialEnd) return null;

  const trialEnd = new Date(subscription.trialEnd);
  const now = new Date();

  if (trialEnd <= now) return null;

  const diffMs = trialEnd.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  return diffDays;
}

/**
 * Check if subscription is active (includes trialing)
 */
export function isSubscriptionActive(
  subscription: Subscription | null
): boolean {
  if (!subscription) return false;
  return subscription.status === "active" || subscription.status === "trialing";
}

/**
 * Format currency amount
 */
export function formatCurrency(
  amountCents: number,
  currency: string = "USD"
): string {
  const amount = amountCents / 100;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
}
