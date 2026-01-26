/**
 * Component for displaying feature usage
 */

import React from "react";
import { useUsageQuota } from "../hooks";

export interface UsageDisplayProps {
  /**
   * User ID (external customer ID)
   */
  userId: string;

  /**
   * Feature slug to display usage for
   */
  feature: string;

  /**
   * Show a progress bar
   * @default false
   */
  showProgressBar?: boolean;

  /**
   * Warning threshold (0-1)
   * @default 0.8
   */
  warnThreshold?: number;

  /**
   * Custom CSS class
   */
  className?: string;

  /**
   * Show label
   * @default true
   */
  showLabel?: boolean;

  /**
   * Custom label text
   */
  label?: string;
}

/**
 * Component to display feature usage with optional progress bar
 *
 * @example
 * ```tsx
 * <UsageDisplay
 *   userId={userId}
 *   feature="api-calls"
 *   showProgressBar
 *   warnThreshold={0.8}
 * />
 * ```
 *
 * @example
 * ```tsx
 * <UsageDisplay
 *   userId={userId}
 *   feature="storage"
 *   label="Storage Used"
 *   showProgressBar
 * />
 * ```
 */
export function UsageDisplay({
  userId,
  feature,
  showProgressBar = false,
  warnThreshold = 0.8,
  className = "",
  showLabel = true,
  label,
}: UsageDisplayProps) {
  const {
    formatted,
    percentage,
    isNearLimit,
    isOverLimit,
    isUnlimited,
    loading,
    error,
  } = useUsageQuota(userId, feature, warnThreshold);

  if (loading) {
    return (
      <div className={`lumen-usage-display ${className}`}>
        <div className="lumen-usage-loading">Loading usage...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`lumen-usage-display ${className}`}>
        <div className="lumen-usage-error">Failed to load usage</div>
      </div>
    );
  }

  const statusClass = isOverLimit
    ? "lumen-usage-over-limit"
    : isNearLimit
      ? "lumen-usage-near-limit"
      : "lumen-usage-normal";

  return (
    <div className={`lumen-usage-display ${statusClass} ${className}`}>
      {showLabel && (
        <div className="lumen-usage-label">
          {label || formatFeatureName(feature)}
        </div>
      )}

      <div className="lumen-usage-value">{formatted}</div>

      {showProgressBar && !isUnlimited && percentage !== null && (
        <div className="lumen-usage-progress-container">
          <div
            className="lumen-usage-progress-bar"
            style={{
              width: `${Math.min(percentage, 100)}%`,
            }}
          />
        </div>
      )}

      {isOverLimit && (
        <div className="lumen-usage-warning">Limit exceeded</div>
      )}
      {isNearLimit && !isOverLimit && (
        <div className="lumen-usage-warning">Approaching limit</div>
      )}
    </div>
  );
}

/**
 * Helper to format feature slug as a readable name
 */
function formatFeatureName(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
