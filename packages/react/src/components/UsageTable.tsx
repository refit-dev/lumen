/**
 * Component for displaying a usage table
 */

import React from "react";
import { useEntitlements } from "../hooks";
import { getFeatureUsage, formatUsage } from "../lib/utils";

export interface UsageTableProps {
  /**
   * User ID (external customer ID)
   */
  userId: string;

  /**
   * Feature slugs to display in the table
   * If not provided, will show all features with usage data
   */
  features?: string[];

  /**
   * Custom CSS class
   */
  className?: string;

  /**
   * Show progress bars
   * @default false
   */
  showProgressBars?: boolean;

  /**
   * Column headers
   */
  headers?: {
    feature?: string;
    usage?: string;
    limit?: string;
    percentage?: string;
  };
}

/**
 * Component to display a table of feature usage
 *
 * @example
 * ```tsx
 * <UsageTable
 *   userId={userId}
 *   features={["api-calls", "storage", "users"]}
 *   showProgressBars
 * />
 * ```
 */
export function UsageTable({
  userId,
  features,
  className = "",
  showProgressBars = false,
  headers = {},
}: UsageTableProps) {
  const { entitlements, loading, error } = useEntitlements(userId);

  if (loading) {
    return (
      <div className={`lumen-usage-table ${className}`}>
        <p>Loading usage data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`lumen-usage-table ${className}`}>
        <p>Failed to load usage data</p>
      </div>
    );
  }

  if (!entitlements?.entitlements) {
    return null;
  }

  // Filter entitlements based on provided features or show all with usage
  let displayEntitlements = entitlements.entitlements;

  if (features && features.length > 0) {
    displayEntitlements = displayEntitlements.filter((ent) =>
      features.includes(ent.feature?.slug || "")
    );
  } else {
    // Show only features with usage data
    displayEntitlements = displayEntitlements.filter(
      (ent) => ent.usages && ent.usages.length > 0
    );
  }

  if (displayEntitlements.length === 0) {
    return (
      <div className={`lumen-usage-table ${className}`}>
        <p>No usage data available</p>
      </div>
    );
  }

  return (
    <div className={`lumen-usage-table ${className}`}>
      <table>
        <thead>
          <tr>
            <th>{headers.feature || "Feature"}</th>
            <th>{headers.usage || "Usage"}</th>
            {showProgressBars && <th></th>}
          </tr>
        </thead>
        <tbody>
          {displayEntitlements.map((ent) => {
            const featureSlug = ent.feature?.slug || "";
            const usage = getFeatureUsage(entitlements.entitlements, featureSlug);

            if (!usage) return null;

            const formatted = formatUsage(usage.used, usage.limit);
            const percentage = formatted.percentage || 0;

            return (
              <tr key={featureSlug}>
                <td className="lumen-usage-table-feature">
                  {formatFeatureName(featureSlug)}
                </td>
                <td className="lumen-usage-table-value">{formatted.formatted}</td>
                {showProgressBars && (
                  <td className="lumen-usage-table-progress">
                    {!formatted.isUnlimited && (
                      <div className="lumen-progress-container">
                        <div
                          className="lumen-progress-bar"
                          style={{
                            width: `${Math.min(percentage, 100)}%`,
                          }}
                        />
                      </div>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
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
