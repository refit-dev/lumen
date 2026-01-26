# @getlumen/react

React hooks and components for Lumen Billing - feature gates, usage tracking, and subscription management.

## Installation

```bash
npm install @getlumen/react
# or
yarn add @getlumen/react
# or
pnpm add @getlumen/react
```

## Quick Start

### 1. Set up the Lumen Proxy Handler

First, create a backend handler that proxies requests to Lumen API. This ensures your API key stays secure.

**Next.js App Router:**

```typescript
// app/api/lumen/[...path]/route.ts
import { lumenNextHandler } from "@getlumen/server";
import { auth } from "@/lib/auth"; // Your auth system

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await lumenNextHandler({
    request,
    userId: session.user.id,
  });

  return Response.json(result);
}

export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
```

### 2. Wrap your app with LumenProvider

```tsx
// app/layout.tsx or app/providers.tsx
import { Provider } from "@getlumen/react";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <<Provider config={{ apiProxyUrl: "/api/lumen" }}>
      {children}
    </LumenProvider>
  );
}
```

### 3. Use hooks and components

```tsx
import { useFeature, FeatureGate } from "@getlumen/react";

function MyComponent() {
  const userId = getCurrentUserId(); // Your auth system

  // Check feature access with a hook
  const { entitled, loading } = useFeature(userId, "premium-analytics");

  // Or use a component to gate content
  return (
    <<FeatureGate
      userId={userId}
      feature="premium-analytics"
      fallback={<UpgradePrompt />}
    >
      <PremiumAnalyticsDashboard />
    </FeatureGate>
  );
}
```

## Core Concepts

### Hooks (Data Fetching)

Hooks provide reactive data fetching from your Lumen proxy endpoint.

#### `useSubscription`

Get subscription status for a user.

```tsx
import { useSubscription } from "@getlumen/react";

function SubscriptionInfo() {
  const { subscription, loading, error, refetch } = useSubscription(userId);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      {subscription?.hasActiveSubscription ? (
        <p>Plan: {subscription.subscription.planName}</p>
      ) : (
        <p>No active subscription</p>
      )}
    </div>
  );
}
```

#### `useEntitlements`

Get all feature entitlements for a user.

```tsx
import { useEntitlements } from "@getlumen/react";

function FeaturesList() {
  const { entitlements, loading, error } = useEntitlements(userId);

  return (
    <ul>
      {entitlements?.entitlements.map((ent) => (
        <li key={ent.feature?.slug}>
          {ent.feature?.slug}: {ent.entitled ? "✓" : "✗"}
        </li>
      ))}
    </ul>
  );
}
```

#### `useFeature`

Check entitlement for a specific feature with usage data.

```tsx
import { useFeature } from "@getlumen/react";

function ApiCallsCounter() {
  const { entitled, usage, loading } = useFeature(userId, "api-calls");

  if (!entitled) return <div>Not available in your plan</div>;

  return (
    <div>
      API Calls: {usage?.used} / {usage?.limit || "Unlimited"}
    </div>
  );
}
```

#### `useFeatureGate`

Check feature access with upgrade prompts.

```tsx
import { useFeatureGate } from "@getlumen/react";

function PremiumFeature() {
  const { canAccess, showUpgrade, reason, loading } = useFeatureGate(
    userId,
    "premium-analytics"
  );

  if (loading) return <div>Loading...</div>;

  if (!canAccess && showUpgrade) {
    return (
      <div>
        <h2>Upgrade Required</h2>
        <p>{reason}</p>
        <button>Upgrade Now</button>
      </div>
    );
  }

  return <PremiumAnalyticsDashboard />;
}
```

#### `useUsageQuota`

Track usage quotas with percentage and limits.

```tsx
import { useUsageQuota } from "@getlumen/react";

function UsageDisplay() {
  const {
    used,
    limit,
    percentage,
    isNearLimit,
    isOverLimit,
    loading
  } = useUsageQuota(userId, "api-calls", 0.8);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <p>{used} / {limit || "Unlimited"}</p>
      {isNearLimit && <p className="warning">Approaching limit!</p>}
      {isOverLimit && <p className="error">Limit exceeded!</p>}
    </div>
  );
}
```

#### `useCustomerPortal`

Get customer portal data (subscription, payment methods, invoices).

```tsx
import { useCustomerPortal } from "@getlumen/react";

function CustomerPortal() {
  const { overview, loading, error } = useCustomerPortal(userId);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h2>Subscription: {overview?.subscription?.planName}</h2>

      <h3>Payment Methods</h3>
      <ul>
        {overview?.paymentMethods.map((pm) => (
          <li key={pm.id}>{pm.brand} •••• {pm.last4}</li>
        ))}
      </ul>

      <h3>Recent Invoices</h3>
      <ul>
        {overview?.recentInvoices.map((inv) => (
          <li key={inv.id}>{inv.invoiceNumber}: {inv.status}</li>
        ))}
      </ul>
    </div>
  );
}
```

### Components (UI)

Pre-built components for common patterns.

#### `<<FeatureGate>`

Gate content based on feature entitlement.

```tsx
import { FeatureGate } from "@getlumen/react";

<<FeatureGate
  userId={userId}
  feature="premium-analytics"
  fallback={<UpgradePrompt />}
  loading={<Spinner />}
>
  <PremiumAnalyticsDashboard />
</FeatureGate>
```

#### `<<UsageDisplay>`

Display feature usage with optional progress bar.

```tsx
import { UsageDisplay } from "@getlumen/react";

<<UsageDisplay
  userId={userId}
  feature="api-calls"
  showProgressBar
  warnThreshold={0.8}
  label="API Calls"
/>
```

#### `<<SubscriptionBadge>`

Display subscription status badge.

```tsx
import { SubscriptionBadge } from "@getlumen/react";

<<SubscriptionBadge
  userId={userId}
  showTrialDays
  labels={{
    active: "Pro Member",
    trial: "Trial Active"
  }}
/>
```

#### `<<Paywall>`

Show an upgrade paywall when user lacks access.

```tsx
import { Paywall } from "@getlumen/react";

<<Paywall
  userId={userId}
  feature="premium-analytics"
  title="Premium Analytics"
  description="Get access to advanced analytics"
  onUpgrade={() => router.push('/pricing')}
>
  <PremiumAnalyticsDashboard />
</Paywall>
```

#### `<<UsageTable>`

Display usage data in a table format.

```tsx
import { UsageTable } from "@getlumen/react";

<<UsageTable
  userId={userId}
  features={["api-calls", "storage", "users"]}
  showProgressBars
/>
```

#### `<<SubscriptionCard>`

Display subscription details in a card.

```tsx
import { SubscriptionCard } from "@getlumen/react";

<<SubscriptionCard
  userId={userId}
  showUsage
  showBilling
  allowManageSubscription
  onManageSubscription={() => router.push('/portal')}
/>
```

### Utility Functions

Client-side helpers for working with Lumen data.

```tsx
import {
  formatUsage,
  isNearLimit,
  isOverLimit,
  canAccessFeature,
  getFeatureValue,
  getFeatureUsage,
  getUpgradeReason,
  getSubscriptionStatus,
  isTrialing,
  getDaysRemainingInTrial,
  isSubscriptionActive,
  formatCurrency
} from "@getlumen/react";

// Format usage
const formatted = formatUsage(150, 1000);
// => { used: 150, limit: 1000, percentage: 15, formatted: "150 / 1,000 (15%)" }

// Check limits
const nearLimit = isNearLimit(850, 1000, 0.8); // => true
const overLimit = isOverLimit(1050, 1000); // => true

// Check feature access
const canAccess = canAccessFeature(entitlements, "premium-analytics");

// Get feature value
const limit = getFeatureValue(entitlements, "api-calls"); // => 1000

// Get usage data
const usage = getFeatureUsage(entitlements, "api-calls");
// => { used: 150, limit: 1000 }

// Get upgrade reason
const reason = getUpgradeReason(entitlement);
// => { reason: "You've used 95% of your limit", severity: "critical" }

// Subscription utilities
const status = getSubscriptionStatus(subscription); // => "active"
const isTrial = isTrialing(subscription); // => true
const daysLeft = getDaysRemainingInTrial(subscription); // => 7
const isActive = isSubscriptionActive(subscription); // => true

// Format currency
const price = formatCurrency(999900, "USD"); // => "$9,999.00"
```

## Hook Options

All data-fetching hooks support these options:

```tsx
{
  // Enable/disable fetching
  enabled?: boolean; // default: true

  // Auto-refetch interval (ms)
  refetchInterval?: number;

  // Refetch on window focus
  refetchOnWindowFocus?: boolean; // default: false

  // Success callback
  onSuccess?: (data: any) => void;

  // Error callback
  onError?: (error: Error) => void;
}
```

Example:

```tsx
const { subscription } = useSubscription(userId, {
  refetchInterval: 60000, // Refetch every minute
  refetchOnWindowFocus: true,
  onSuccess: (data) => console.log("Fetched:", data),
  onError: (error) => console.error("Error:", error),
});
```

## Styling

All components use simple CSS classes that you can style:

```css
/* Feature Gate */
.lumen-paywall { }
.lumen-paywall-content { }
.lumen-paywall-title { }
.lumen-paywall-description { }
.lumen-paywall-button { }

/* Usage Display */
.lumen-usage-display { }
.lumen-usage-label { }
.lumen-usage-value { }
.lumen-usage-progress-container { }
.lumen-usage-progress-bar { }
.lumen-usage-warning { }
.lumen-usage-normal { }
.lumen-usage-near-limit { }
.lumen-usage-over-limit { }

/* Subscription Badge */
.lumen-subscription-badge { }
.lumen-badge-active { }
.lumen-badge-trial { }
.lumen-badge-past-due { }
.lumen-badge-cancelled { }
.lumen-badge-none { }

/* Usage Table */
.lumen-usage-table { }
.lumen-progress-container { }
.lumen-progress-bar { }

/* Subscription Card */
.lumen-subscription-card { }
.lumen-subscription-card-header { }
.lumen-status-badge { }
.lumen-subscription-trial { }
.lumen-subscription-billing { }
.lumen-subscription-usage { }
.lumen-subscription-actions { }
```

## TypeScript

This package is written in TypeScript and includes full type definitions.

```tsx
import type {
  SubscriptionStatus,
  FeatureEntitlement,
  CustomerOverview,
  LumenConfig,
  UseQueryOptions
} from "@getlumen/react";
```

## Examples

### Complete Feature Gate Example

```tsx
import { FeatureGate, Paywall } from "@getlumen/react";

function ProtectedFeature() {
  const userId = useAuth().userId;

  return (
    <<Paywall
      userId={userId}
      feature="premium-analytics"
      title="Unlock Premium Analytics"
      description="Get access to advanced analytics and insights"
      onUpgrade={() => router.push('/pricing')}
    >
      <PremiumAnalyticsDashboard />
    </Paywall>
  );
}
```

### Complete Usage Dashboard Example

```tsx
import {
  useSubscription,
  useUsageQuota,
  UsageDisplay,
  UsageTable
} from "@getlumen/react";

function UsageDashboard() {
  const userId = useAuth().userId;
  const { subscription } = useSubscription(userId);
  const apiUsage = useUsageQuota(userId, "api-calls", 0.8);

  return (
    <div>
      <h1>Your Plan: {subscription?.subscription.planName}</h1>

      {apiUsage.isNearLimit && (
        <div className="warning">
          You're at {apiUsage.percentage}% of your API limit
        </div>
      )}

      <<UsageDisplay
        userId={userId}
        feature="api-calls"
        showProgressBar
      />

      <<UsageTable
        userId={userId}
        showProgressBars
      />
    </div>
  );
}
```

## License

ISC

## Links

- [Documentation](https://docs.getlumen.dev)
- [GitHub](https://github.com/getlumen/lumen)
- [Website](https://getlumen.dev)
