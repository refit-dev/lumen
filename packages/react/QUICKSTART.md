# Lumen React SDK - Quick Start

Get started with Lumen React SDK in under 5 minutes.

## 1. Install

```bash
npm install @getlumen/react @getlumen/server
```

## 2. Create Backend Proxy

```typescript
// app/api/lumen/[...path]/route.ts
import { lumenNextHandler } from "@getlumen/server";
import { auth } from "@/lib/auth";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json(
    await lumenNextHandler({
      request,
      userId: session.user.id,
    })
  );
}

export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
```

## 3. Add Provider

```tsx
// app/providers.tsx
"use client";
import { LumenProvider } from "@getlumen/react";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LumenProvider config={{ apiProxyUrl: "/api/lumen" }}>
      {children}
    </LumenProvider>
  );
}
```

```tsx
// app/layout.tsx
import { Providers } from "./providers";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

## 4. Use It!

### Feature Gate

```tsx
import { FeatureGate } from "@getlumen/react";

<FeatureGate
  userId={userId}
  feature="premium-analytics"
  fallback={<UpgradePrompt />}
>
  <PremiumFeature />
</FeatureGate>
```

### Usage Display

```tsx
import { UsageDisplay } from "@getlumen/react";

<UsageDisplay
  userId={userId}
  feature="api-calls"
  showProgressBar
/>
```

### Check Feature Access

```tsx
import { useFeature } from "@getlumen/react";

const { entitled, usage, loading } = useFeature(userId, "api-calls");

if (!entitled) {
  return <UpgradePrompt />;
}

return <div>Used: {usage?.used} / {usage?.limit}</div>;
```

### Monitor Usage

```tsx
import { useUsageQuota } from "@getlumen/react";

const { percentage, isNearLimit, isOverLimit } = useUsageQuota(
  userId,
  "api-calls",
  0.8 // Warn at 80%
);

{isOverLimit && <Alert>Limit exceeded!</Alert>}
{isNearLimit && <Warning>At {percentage}% of limit</Warning>}
```

### Show Subscription

```tsx
import { SubscriptionBadge } from "@getlumen/react";

<SubscriptionBadge userId={userId} showTrialDays />
```

## Common Patterns

### Feature with Paywall

```tsx
import { Paywall } from "@getlumen/react";

<Paywall
  userId={userId}
  feature="premium"
  title="Upgrade to Pro"
  description="Get access to premium features"
  onUpgrade={() => router.push("/pricing")}
>
  <PremiumContent />
</Paywall>
```

### Usage Dashboard

```tsx
import { UsageTable, SubscriptionBadge, useUsageQuota } from "@getlumen/react";

function Dashboard() {
  const apiUsage = useUsageQuota(userId, "api-calls", 0.8);

  return (
    <div>
      <SubscriptionBadge userId={userId} />

      {apiUsage.isNearLimit && (
        <Alert>You're at {apiUsage.percentage}% of your limit</Alert>
      )}

      <UsageTable
        userId={userId}
        features={["api-calls", "storage", "users"]}
        showProgressBars
      />
    </div>
  );
}
```

### Subscription Management

```tsx
import { SubscriptionCard } from "@getlumen/react";

<SubscriptionCard
  userId={userId}
  showUsage
  showBilling
  allowManageSubscription
  onManageSubscription={() => router.push("/portal")}
/>
```

## All Hooks

```tsx
import {
  useSubscription,        // Get subscription status
  useEntitlements,        // Get all entitlements
  useFeature,             // Check specific feature
  useFeatureGate,         // Feature check with upgrade prompts
  useUsageQuota,          // Track usage with warnings
  useCustomerPortal,      // Get portal data
} from "@getlumen/react";
```

## All Components

```tsx
import {
  FeatureGate,            // Gate content by feature
  UsageDisplay,           // Show usage with progress
  SubscriptionBadge,      // Display subscription status
  Paywall,                // Upgrade prompt
  UsageTable,             // Table of usage data
  SubscriptionCard,       // Full subscription details
} from "@getlumen/react";
```

## Hook Options

```tsx
const { data, loading, error } = useSubscription(userId, {
  enabled: true,                    // Enable/disable fetching
  refetchInterval: 60000,           // Auto-refetch every 60s
  refetchOnWindowFocus: true,       // Refetch on focus
  onSuccess: (data) => console.log(data),
  onError: (error) => console.error(error),
});
```

## TypeScript

```tsx
import type {
  SubscriptionStatus,
  FeatureEntitlement,
  UseFeatureResult,
  FeatureGateProps,
} from "@getlumen/react";
```

## Utilities

```tsx
import {
  formatUsage,              // Format usage for display
  isNearLimit,              // Check if near limit
  isOverLimit,              // Check if over limit
  canAccessFeature,         // Check feature access
  getFeatureValue,          // Get feature value
  getUpgradeReason,         // Get upgrade message
  formatCurrency,           // Format money
} from "@getlumen/react";
```

## Next Steps

- See [DOCUMENTATION.md](./DOCUMENTATION.md) for complete API reference
- See [EXAMPLES.md](./EXAMPLES.md) for detailed examples
- Visit [docs.getlumen.dev](https://docs.getlumen.dev) for guides

## Need Help?

- GitHub Issues: https://github.com/getlumen/lumen/issues
- Documentation: https://docs.getlumen.dev
- Website: https://getlumen.dev
