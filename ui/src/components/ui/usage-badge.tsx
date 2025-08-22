"use client";

import { useEffect, useState } from "react";
import { Badge } from "./badge";
import { cn } from "@/lib/utils";

interface UsageData {
  current: number;
  limit: number;
  type: "usage" | "credit";
}

interface Entitlement {
  feature: {
    slug: string;
    value?: number;
  };
  creditInfo?: {
    creditAllowance: number;
    creditsRemaining: number;
  };
  usages?: Array<{ usage: number }>;
}

type Theme = "green" | "yellow" | "blue";

interface UsageBadgeProps {
  /**
   * Slug of the feature whose entitlement usage should be displayed.
   */
  featureSlug: string;
  /**
   * Optional label to show before the usage stats (defaults to a capitalised version of the slug).
   */
  label?: string;
  /**
   * Optional label to show after the usage stats (defaults to "credits").
   */
  labelAfter?: string;
  /**
   * Optional calculation to show after the usage stats (defaults to "used").
   */
  creditCalculation?: "used" | "available";
  /**
   * Optional API endpoint returning Lumen entitlements (defaults to `${window.location.origin}/api/lumen`).
   */
  apiUrl?: string;
  /**
   * Optional additional class names passed to the underlying Badge component.
   */
  className?: string;
  /**
   * Color theme for the badge (defaults to "blue").
   */
  theme?: Theme;
}

export function UsageBadge({
  featureSlug,
  label,
  labelAfter = "credits",
  creditCalculation = "used",
  apiUrl,
  className,
  theme = "blue",
}: UsageBadgeProps) {
  const [usageData, setUsageData] = useState<UsageData | null>(null);

  // Capitalise the slug (e.g. "api-calls" => "API Calls") if no label provided.
  const displayLabel =
    label ??
    featureSlug
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\bAi\b/g, "AI")
      .replace(/\bApi\b/g, "API") + ":";

  // Determine whether the usage has reached or exceeded the limit.
  const isOverLimit =
    usageData !== null && usageData.current >= usageData.limit;

  // Get theme-specific styling
  const getThemeClasses = () => {
    if (isOverLimit) {
      // Over-limit styling - keep destructive styling for all themes
      return "border-transparent bg-red-100 text-red-800 hover:bg-red-200";
    } else {
      // Normal usage styling with light theme colors and darker text
      switch (theme) {
        case "green":
          return "border-transparent bg-green-100 text-green-800 hover:bg-green-200";
        case "yellow":
          return "border-transparent bg-yellow-100 text-yellow-800 hover:bg-yellow-200";
        case "blue":
          return "border-transparent bg-blue-100 text-blue-800 hover:bg-blue-200";
        default:
          return "border-transparent bg-blue-100 text-blue-800 hover:bg-blue-200";
      }
    }
  };

  useEffect(() => {
    if (!featureSlug) return;

    // Default to same-origin /api/lumen when no explicit apiUrl is provided.
    const url =
      (apiUrl || `${window.location.origin}/api/lumen`) +
      "/entitlements/{customerId}";

    const fetchUsage = async () => {
      try {
        const response = await fetch(url);
        const data = (await response.json()) as {
          entitlements?: Entitlement[];
        };

        const entitlement: Entitlement | undefined = data.entitlements?.find(
          (e: Entitlement) => e.feature.slug === featureSlug
        );

        if (!entitlement) return;

        // Credit-based entitlement
        if (entitlement.creditInfo) {
          const { creditAllowance, creditsRemaining } = entitlement.creditInfo;
          const creditsUsed = creditAllowance - creditsRemaining;
          setUsageData({
            current: creditsUsed,
            limit: creditAllowance,
            type: "credit",
          });
          return;
        }

        // Traditional usage-based entitlement
        if (entitlement.usages && entitlement.usages.length > 0) {
          const usage = entitlement.usages[0].usage;
          const usageLimit = entitlement.feature.value ?? 0;
          setUsageData({
            current: usage,
            limit: usageLimit,
            type: "usage",
          });
        }
      } catch (error) {
        // Silently fail – the badge is non-critical UI.
        console.error("Failed to fetch usage", error);
      }
    };

    fetchUsage();
    const interval = setInterval(fetchUsage, 5_000);
    return () => clearInterval(interval);
  }, [featureSlug, apiUrl]);

  const formattedUsage = () => {
    if (!usageData) return "...";

    if (usageData.type === "credit") {
      if (creditCalculation === "used") {
        return `${usageData.current} / ${usageData.limit}`;
      } else {
        return `${usageData.limit - usageData.current} / ${usageData.limit}`;
      }
    }

    return `${usageData.current} / ${usageData.limit}`;
  };

  return (
    <Badge className={cn("gap-1", getThemeClasses(), className)}>
      {displayLabel} {formattedUsage()} {labelAfter}
    </Badge>
  );
}
