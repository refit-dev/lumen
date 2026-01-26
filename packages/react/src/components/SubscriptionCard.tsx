/**
 * Component for displaying subscription details in a card
 */

import React from "react";
import { useSubscription, useEntitlements } from "../hooks";
import {
  getSubscriptionStatus,
  isTrialing,
  getDaysRemainingInTrial,
  formatCurrency,
} from "../lib/utils";

export interface SubscriptionCardProps {
  /**
   * User ID (external customer ID)
   */
  userId: string;

  /**
   * Show usage summary
   * @default false
   */
  showUsage?: boolean;

  /**
   * Show billing information
   * @default false
   */
  showBilling?: boolean;

  /**
   * Allow managing subscription (show button)
   * @default false
   */
  allowManageSubscription?: boolean;

  /**
   * Callback when manage subscription is clicked
   */
  onManageSubscription?: () => void;

  /**
   * Custom CSS class
   */
  className?: string;
}

/**
 * Component to display subscription details in a card format
 *
 * @example
 * ```tsx
 * <SubscriptionCard
 *   userId={userId}
 *   showUsage
 *   showBilling
 *   allowManageSubscription
 *   onManageSubscription={() => router.push('/portal')}
 * />
 * ```
 */
export function SubscriptionCard({
  userId,
  showUsage = false,
  showBilling = false,
  allowManageSubscription = false,
  onManageSubscription,
  className = "",
}: SubscriptionCardProps) {
  const { subscription, loading: subLoading } = useSubscription(userId);
  const { entitlements, loading: entLoading } = useEntitlements(userId, {
    enabled: showUsage,
  });

  if (subLoading) {
    return (
      <div className={`lumen-subscription-card ${className}`}>
        <p>Loading subscription...</p>
      </div>
    );
  }

  const sub = subscription?.subscription || null;
  const status = getSubscriptionStatus(sub);
  const isTrial = isTrialing(sub);
  const trialDays = getDaysRemainingInTrial(sub);

  return (
    <div className={`lumen-subscription-card ${className}`}>
      <div className="lumen-subscription-card-header">
        <h3>{sub?.planName || "Free Plan"}</h3>
        <span className={`lumen-status-badge lumen-status-${status}`}>
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </span>
      </div>

      {isTrial && trialDays !== null && (
        <div className="lumen-subscription-trial">
          <p>Trial ends in {trialDays} days</p>
        </div>
      )}

      {showBilling && sub && (
        <div className="lumen-subscription-billing">
          {sub.currentPeriodStart && sub.currentPeriodEnd && (
            <p className="lumen-billing-period">
              Current period:{" "}
              {new Date(sub.currentPeriodStart).toLocaleDateString()} -{" "}
              {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </p>
          )}

          {sub.cancelAtPeriodEnd && (
            <p className="lumen-cancel-notice">
              Subscription will cancel at end of period
            </p>
          )}
        </div>
      )}

      {showUsage && !entLoading && entitlements?.entitlements && (
        <div className="lumen-subscription-usage">
          <h4>Usage</h4>
          <ul>
            {entitlements.entitlements
              .filter((ent) => ent.usages && ent.usages.length > 0)
              .map((ent) => {
                const featureSlug = ent.feature?.slug || "";
                const totalUsage = ent.usages?.reduce(
                  (sum, u) => sum + u.usage,
                  0
                );
                const limit =
                  typeof ent.feature?.value === "number"
                    ? ent.feature.value
                    : null;

                return (
                  <li key={featureSlug}>
                    {formatFeatureName(featureSlug)}: {totalUsage}{" "}
                    {limit !== null && `/ ${limit}`}
                  </li>
                );
              })}
          </ul>
        </div>
      )}

      {allowManageSubscription && onManageSubscription && (
        <div className="lumen-subscription-actions">
          <button
            className="lumen-manage-button"
            onClick={onManageSubscription}
            type="button"
          >
            Manage Subscription
          </button>
        </div>
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
