/**
 * Component for displaying subscription status badge
 */

import React from "react";
import { useSubscription } from "../hooks";
import { getSubscriptionStatus, isTrialing, getDaysRemainingInTrial } from "../lib/utils";

export interface SubscriptionBadgeProps {
  /**
   * User ID (external customer ID)
   */
  userId: string;

  /**
   * Custom CSS class
   */
  className?: string;

  /**
   * Show trial days remaining
   * @default true
   */
  showTrialDays?: boolean;

  /**
   * Custom labels for different statuses
   */
  labels?: {
    active?: string;
    trial?: string;
    pastDue?: string;
    cancelled?: string;
    paused?: string;
    none?: string;
  };
}

/**
 * Component to display a subscription status badge
 *
 * @example
 * ```tsx
 * <SubscriptionBadge userId={userId} />
 * ```
 *
 * @example
 * ```tsx
 * <SubscriptionBadge
 *   userId={userId}
 *   labels={{
 *     active: "Pro Member",
 *     trial: "Trial Active",
 *     none: "Free Tier"
 *   }}
 * />
 * ```
 */
export function SubscriptionBadge({
  userId,
  className = "",
  showTrialDays = true,
  labels = {},
}: SubscriptionBadgeProps) {
  const { subscription, loading, error } = useSubscription(userId);

  if (loading) {
    return (
      <span className={`lumen-subscription-badge lumen-badge-loading ${className}`}>
        Loading...
      </span>
    );
  }

  if (error) {
    return null;
  }

  const sub = subscription?.subscription || null;
  const status = getSubscriptionStatus(sub);
  const isTrial = isTrialing(sub);
  const trialDays = getDaysRemainingInTrial(sub);

  // Get display text
  let displayText: string;
  let badgeClass: string;

  switch (status) {
    case "active":
      displayText = labels.active || sub?.planName || "Active";
      badgeClass = "lumen-badge-active";
      break;
    case "trial":
      if (isTrial && showTrialDays && trialDays !== null) {
        displayText = labels.trial || `Trial (${trialDays} days left)`;
      } else {
        displayText = labels.trial || "Trial";
      }
      badgeClass = "lumen-badge-trial";
      break;
    case "past due":
      displayText = labels.pastDue || "Past Due";
      badgeClass = "lumen-badge-past-due";
      break;
    case "cancelled":
      displayText = labels.cancelled || "Cancelled";
      badgeClass = "lumen-badge-cancelled";
      break;
    case "paused":
      displayText = labels.paused || "Paused";
      badgeClass = "lumen-badge-paused";
      break;
    default:
      displayText = labels.none || "Free";
      badgeClass = "lumen-badge-none";
  }

  return (
    <span className={`lumen-subscription-badge ${badgeClass} ${className}`}>
      {displayText}
    </span>
  );
}
