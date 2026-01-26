/**
 * Component for gating features based on entitlements
 */

import React from "react";
import { useFeatureGate } from "../hooks";

export interface FeatureGateProps {
  /**
   * User ID (external customer ID)
   */
  userId: string;

  /**
   * Feature slug to check
   */
  feature: string;

  /**
   * Content to show when user has access
   */
  children: React.ReactNode;

  /**
   * Content to show when user doesn't have access
   * If not provided, children will not be rendered
   */
  fallback?: React.ReactNode;

  /**
   * Content to show while loading
   */
  loading?: React.ReactNode;

  /**
   * Content to show on error
   */
  error?: React.ReactNode;

  /**
   * Callback when access is denied
   */
  onAccessDenied?: (reason: string | null) => void;
}

/**
 * Component to gate features based on user entitlements
 *
 * @example
 * ```tsx
 * <FeatureGate
 *   userId={userId}
 *   feature="premium-analytics"
 *   fallback={<UpgradePrompt />}
 * >
 *   <PremiumAnalyticsDashboard />
 * </FeatureGate>
 * ```
 *
 * @example
 * ```tsx
 * // Just hide content if not entitled
 * <FeatureGate userId={userId} feature="beta-features">
 *   <BetaFeatures />
 * </FeatureGate>
 * ```
 */
export function FeatureGate({
  userId,
  feature,
  children,
  fallback,
  loading: loadingComponent,
  error: errorComponent,
  onAccessDenied,
}: FeatureGateProps) {
  const { canAccess, reason, loading, error } = useFeatureGate(
    userId,
    feature
  );

  // Handle loading state
  if (loading) {
    if (loadingComponent) {
      return <>{loadingComponent}</>;
    }
    return null;
  }

  // Handle error state
  if (error) {
    if (errorComponent) {
      return <>{errorComponent}</>;
    }
    // Silent fail - don't show content
    return null;
  }

  // Handle access denied
  if (!canAccess) {
    if (onAccessDenied) {
      onAccessDenied(reason);
    }

    if (fallback) {
      return <>{fallback}</>;
    }

    return null;
  }

  // User has access
  return <>{children}</>;
}
