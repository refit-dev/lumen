/**
 * Component for displaying an upgrade paywall
 */

import React from "react";
import { useFeatureGate } from "../hooks";

export interface PaywallProps {
  /**
   * User ID (external customer ID)
   */
  userId: string;

  /**
   * Feature that's being blocked
   */
  feature: string;

  /**
   * Title for the paywall
   */
  title?: string;

  /**
   * Description text
   */
  description?: string;

  /**
   * Text for the upgrade button
   * @default "Upgrade Now"
   */
  upgradeButtonText?: string;

  /**
   * Callback when upgrade button is clicked
   */
  onUpgrade?: () => void;

  /**
   * Custom CSS class
   */
  className?: string;

  /**
   * Children will be shown when user has access
   */
  children?: React.ReactNode;
}

/**
 * Component to show an upgrade paywall when user doesn't have access to a feature
 *
 * @example
 * ```tsx
 * <Paywall
 *   userId={userId}
 *   feature="premium-analytics"
 *   title="Premium Analytics"
 *   description="Get access to advanced analytics and reporting"
 *   onUpgrade={() => router.push('/pricing')}
 * >
 *   <PremiumAnalyticsDashboard />
 * </Paywall>
 * ```
 */
export function Paywall({
  userId,
  feature,
  title,
  description,
  upgradeButtonText = "Upgrade Now",
  onUpgrade,
  className = "",
  children,
}: PaywallProps) {
  const { canAccess, reason, loading } = useFeatureGate(userId, feature);

  if (loading) {
    return (
      <div className={`lumen-paywall lumen-paywall-loading ${className}`}>
        <div className="lumen-paywall-content">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  // User has access - show children
  if (canAccess) {
    return <>{children}</>;
  }

  // Show paywall
  return (
    <div className={`lumen-paywall ${className}`}>
      <div className="lumen-paywall-content">
        {title && <h2 className="lumen-paywall-title">{title}</h2>}

        {description && (
          <p className="lumen-paywall-description">{description}</p>
        )}

        {reason && <p className="lumen-paywall-reason">{reason}</p>}

        {onUpgrade && (
          <button
            className="lumen-paywall-button"
            onClick={onUpgrade}
            type="button"
          >
            {upgradeButtonText}
          </button>
        )}
      </div>
    </div>
  );
}
