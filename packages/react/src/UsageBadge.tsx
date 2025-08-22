"use client";
import React, { useEffect, useState } from "react";

const capitalize = (str: string) => {
  return str.charAt(0).toUpperCase() + str.slice(1);
};

interface UsageData {
  current: number;
  limit: number;
  type: "usage" | "credit";
}

export const UsageBadge = (params: {
  featureSlug: string;
  label?: string;
  apiUrl?: string;
}) => {
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const { featureSlug, label, apiUrl } = params;
  let url = apiUrl ?? window.location.origin + "/api/lumen";

  useEffect(() => {
    const fetchUsage = async () => {
      const response = await fetch(url);
      const data = await response.json();
      const entitlement = data.entitlements.filter(
        (e: any) => e.feature.slug === featureSlug
      )[0];

      if (!entitlement) return;

      // Handle credit-based entitlements
      if (entitlement.creditInfo) {
        const { creditAllowance, creditsRemaining } = entitlement.creditInfo;
        const creditsUsed = creditAllowance - creditsRemaining;
        setUsageData({
          current: creditsUsed,
          limit: creditAllowance,
          type: "credit",
        });
      }
      // Handle traditional usage-based entitlements
      else if (entitlement.usages && entitlement.usages.length > 0) {
        const usage = entitlement.usages[0].usage;
        const usageLimit = entitlement.feature.value;
        setUsageData({
          current: usage,
          limit: usageLimit,
          type: "usage",
        });
      }
    };

    fetchUsage();
    const intervalId = setInterval(fetchUsage, 5000);
    return () => clearInterval(intervalId);
  }, [featureSlug, url]);

  const displayLabel = label ?? capitalize(featureSlug.replace(/-/g, " "));

  const isOverLimit =
    usageData !== null && usageData.current >= usageData.limit;

  const badgeStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "6px",
    border: `1px solid ${isOverLimit ? "#fee2e2" : "#dbeafe"}`,
    padding: "2px 8px",
    fontSize: "12px",
    fontWeight: "500",
    backgroundColor: isOverLimit ? "#fee2e2" : "#dbeafe",
    color: isOverLimit ? "#b91c1c" : "#1e40af",
    whiteSpace: "nowrap",
  };

  const formatUsageText = () => {
    if (!usageData) return "...";

    if (usageData.type === "credit") {
      return `${usageData.current} / ${usageData.limit} credits`;
    }

    return `${usageData.current} / ${usageData.limit}`;
  };

  return (
    <span style={badgeStyle}>
      {displayLabel}: {formatUsageText()}
    </span>
  );
};
