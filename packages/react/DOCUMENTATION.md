# Lumen React SDK Documentation

Complete guide for integrating Lumen Billing into your React application with hooks and components.

## Table of Contents

1. [Installation](#installation)
2. [Setup](#setup)
3. [Hooks Reference](#hooks-reference)
4. [Components Reference](#components-reference)
5. [Utilities Reference](#utilities-reference)
6. [TypeScript Support](#typescript-support)
7. [Examples](#examples)

---

## Installation

```bash
npm install @getlumen/react
# or
yarn add @getlumen/react
# or
pnpm add @getlumen/react
```

**Requirements:**
- React 18.0.0 or higher
- react-dom 18.0.0 or higher

---

## Setup

### Step 1: Create Lumen Proxy Handler

The React SDK requires a secure backend proxy to communicate with the Lumen API. This keeps your API keys safe and ensures proper user authentication.

#### Next.js App Router

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
    userId: session.user.id, // Your user's ID from your auth system
  });

  return Response.json(result);
}

// Handle all HTTP methods
export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
```

#### Next.js Pages Router

```typescript
// pages/api/lumen/[...path].ts
import type { NextApiRequest, NextApiResponse } from "next";
import { lumenNextHandler } from "@getlumen/server";
import { getSession } from "@/lib/auth";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const session = await getSession(req);

  if (!session?.user?.id) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const result = await lumenNextHandler({
    request: req,
    userId: session.user.id,
  });

  return res.json(result);
}
```

### Step 2: Add LumenProvider

Wrap your application with the `LumenProvider` to configure the SDK:

```tsx
// app/providers.tsx (Next.js App Router)
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### Step 3: Use Hooks and Components

```tsx
import { useFeature, FeatureGate } from "@getlumen/react";

function MyComponent() {
  const userId = getCurrentUserId(); // From your auth system

  // Check access with a hook
  const { entitled, loading } = useFeature(userId, "premium-analytics");

  // Or use a component
  return (
    <FeatureGate
      userId={userId}
      feature="premium-analytics"
      fallback={<UpgradePrompt />}
    >
      <PremiumAnalyticsDashboard />
    </FeatureGate>
  );
}
```

---

## Hooks Reference

### `useSubscription()`

Get subscription status for a user.

```typescript
function useSubscription(
  userId: string,
  options?: UseQueryOptions
): UseSubscriptionResult
```

**Returns:**
```typescript
{
  subscription: SubscriptionStatus | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}
```

**Example:**
```tsx
function SubscriptionInfo() {
  const { subscription, loading, error } = useSubscription(userId);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      {subscription?.hasActiveSubscription ? (
        <>
          <h2>Plan: {subscription.subscription.planName}</h2>
          <p>Status: {subscription.subscription.status}</p>
        </>
      ) : (
        <p>No active subscription</p>
      )}
    </div>
  );
}
```

---

### `useEntitlements()`

Get all feature entitlements for a user.

```typescript
function useEntitlements(
  userId: string,
  options?: UseQueryOptions
): UseEntitlementsResult
```

**Returns:**
```typescript
{
  entitlements: EntitlementsResponse | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}
```

**Example:**
```tsx
function FeaturesList() {
  const { entitlements, loading } = useEntitlements(userId);

  if (loading) return <div>Loading...</div>;

  return (
    <ul>
      {entitlements?.entitlements.map((ent) => (
        <li key={ent.feature?.slug}>
          {ent.feature?.slug}: {ent.entitled ? "✓ Enabled" : "✗ Disabled"}
        </li>
      ))}
    </ul>
  );
}
```

---

### `useFeature()`

Check entitlement for a specific feature with usage data.

```typescript
function useFeature(
  userId: string,
  featureSlug: string,
  options?: UseQueryOptions
): UseFeatureResult
```

**Returns:**
```typescript
{
  entitled: boolean;
  value: boolean | string | number | null;
  usage: { used: number; limit: number | null } | null;
  loading: boolean;
  error: Error | null;
}
```

**Example:**
```tsx
function ApiCallsCounter() {
  const { entitled, usage, loading } = useFeature(userId, "api-calls");

  if (loading) return <div>Loading...</div>;
  if (!entitled) return <div>Not available in your plan</div>;

  return (
    <div>
      <p>API Calls: {usage?.used} / {usage?.limit || "Unlimited"}</p>
    </div>
  );
}
```

---

### `useFeatureGate()`

Check feature access with upgrade prompts and reasons.

```typescript
function useFeatureGate(
  userId: string,
  featureSlug: string,
  options?: UseQueryOptions
): UseFeatureGateResult
```

**Returns:**
```typescript
{
  canAccess: boolean;
  showUpgrade: boolean;
  reason: string | null;
  loading: boolean;
  error: Error | null;
}
```

**Example:**
```tsx
function PremiumFeature() {
  const { canAccess, showUpgrade, reason, loading } = useFeatureGate(
    userId,
    "premium-analytics"
  );

  if (loading) return <div>Loading...</div>;

  if (!canAccess && showUpgrade) {
    return (
      <div className="upgrade-prompt">
        <h2>Upgrade Required</h2>
        <p>{reason}</p>
        <button onClick={() => router.push("/pricing")}>
          Upgrade Now
        </button>
      </div>
    );
  }

  return <PremiumAnalyticsDashboard />;
}
```

---

### `useUsageQuota()`

Track usage quotas with percentage, limits, and warnings.

```typescript
function useUsageQuota(
  userId: string,
  featureSlug: string,
  warnThreshold?: number, // Default: 0.8 (80%)
  options?: UseQueryOptions
): UseUsageQuotaResult
```

**Returns:**
```typescript
{
  used: number;
  limit: number | null;
  percentage: number | null;
  formatted: string;
  isNearLimit: boolean;
  isOverLimit: boolean;
  isUnlimited: boolean;
  loading: boolean;
  error: Error | null;
}
```

**Example:**
```tsx
function UsageMonitor() {
  const {
    used,
    limit,
    percentage,
    isNearLimit,
    isOverLimit,
    formatted
  } = useUsageQuota(userId, "api-calls", 0.8);

  return (
    <div>
      <h3>API Usage</h3>
      <p>{formatted}</p>

      {isOverLimit && (
        <div className="alert alert-error">
          You've exceeded your limit!
        </div>
      )}

      {isNearLimit && !isOverLimit && (
        <div className="alert alert-warning">
          You're at {percentage}% of your limit
        </div>
      )}
    </div>
  );
}
```

---

### `useCustomerPortal()`

Get customer portal data including subscription, payment methods, and invoices.

```typescript
function useCustomerPortal(
  userId: string,
  options?: UseQueryOptions
): UseCustomerPortalResult
```

**Returns:**
```typescript
{
  overview: CustomerOverview | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}
```

**Example:**
```tsx
function CustomerPortal() {
  const { overview, loading, error } = useCustomerPortal(userId);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error loading portal data</div>;

  return (
    <div>
      <h2>Subscription</h2>
      <p>Plan: {overview?.subscription?.planName}</p>
      <p>Status: {overview?.subscription?.status}</p>

      <h3>Payment Methods</h3>
      <ul>
        {overview?.paymentMethods.map((pm) => (
          <li key={pm.id}>
            {pm.brand} •••• {pm.last4}
            {pm.isDefault && <span> (Default)</span>}
          </li>
        ))}
      </ul>

      <h3>Recent Invoices</h3>
      <ul>
        {overview?.recentInvoices.map((inv) => (
          <li key={inv.id}>
            {inv.invoiceNumber}: ${inv.amountPaid / 100} - {inv.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## Query Options

All data-fetching hooks accept optional configuration:

```typescript
interface UseQueryOptions {
  // Enable/disable fetching
  enabled?: boolean; // default: true

  // Auto-refetch interval in milliseconds
  refetchInterval?: number;

  // Refetch when window regains focus
  refetchOnWindowFocus?: boolean; // default: false

  // Success callback
  onSuccess?: (data: any) => void;

  // Error callback
  onError?: (error: Error) => void;
}
```

**Example:**
```tsx
const { subscription } = useSubscription(userId, {
  refetchInterval: 60000, // Refetch every minute
  refetchOnWindowFocus: true,
  onSuccess: (data) => {
    console.log("Subscription loaded:", data);
  },
  onError: (error) => {
    console.error("Failed to load subscription:", error);
  },
});
```

---

## Components Reference

### `<FeatureGate>`

Gate content based on feature entitlement.

**Props:**
```typescript
interface FeatureGateProps {
  userId: string;
  feature: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  loading?: React.ReactNode;
  error?: React.ReactNode;
  onAccessDenied?: (reason: string | null) => void;
}
```

**Example:**
```tsx
<FeatureGate
  userId={userId}
  feature="premium-analytics"
  fallback={<UpgradePrompt />}
  loading={<Skeleton />}
  onAccessDenied={(reason) => {
    console.log("Access denied:", reason);
  }}
>
  <PremiumAnalyticsDashboard />
</FeatureGate>
```

---

### `<UsageDisplay>`

Display feature usage with optional progress bar.

**Props:**
```typescript
interface UsageDisplayProps {
  userId: string;
  feature: string;
  showProgressBar?: boolean; // default: false
  warnThreshold?: number; // default: 0.8
  className?: string;
  showLabel?: boolean; // default: true
  label?: string;
}
```

**Example:**
```tsx
<UsageDisplay
  userId={userId}
  feature="api-calls"
  showProgressBar
  warnThreshold={0.9}
  label="API Calls This Month"
  className="my-usage-display"
/>
```

---

### `<SubscriptionBadge>`

Display subscription status as a badge.

**Props:**
```typescript
interface SubscriptionBadgeProps {
  userId: string;
  className?: string;
  showTrialDays?: boolean; // default: true
  labels?: {
    active?: string;
    trial?: string;
    pastDue?: string;
    cancelled?: string;
    paused?: string;
    none?: string;
  };
}
```

**Example:**
```tsx
<SubscriptionBadge
  userId={userId}
  showTrialDays
  labels={{
    active: "Pro Member",
    trial: "Trial Active",
    none: "Free Tier"
  }}
  className="subscription-badge"
/>
```

---

### `<Paywall>`

Show an upgrade paywall when user doesn't have access.

**Props:**
```typescript
interface PaywallProps {
  userId: string;
  feature: string;
  title?: string;
  description?: string;
  upgradeButtonText?: string; // default: "Upgrade Now"
  onUpgrade?: () => void;
  className?: string;
  children?: React.ReactNode;
}
```

**Example:**
```tsx
<Paywall
  userId={userId}
  feature="premium-analytics"
  title="Unlock Premium Analytics"
  description="Get access to advanced insights and reporting"
  upgradeButtonText="View Plans"
  onUpgrade={() => router.push("/pricing")}
  className="my-paywall"
>
  <PremiumAnalyticsDashboard />
</Paywall>
```

---

### `<UsageTable>`

Display usage data for multiple features in a table.

**Props:**
```typescript
interface UsageTableProps {
  userId: string;
  features?: string[]; // If not provided, shows all features with usage
  className?: string;
  showProgressBars?: boolean; // default: false
  headers?: {
    feature?: string;
    usage?: string;
    limit?: string;
    percentage?: string;
  };
}
```

**Example:**
```tsx
<UsageTable
  userId={userId}
  features={["api-calls", "storage", "users"]}
  showProgressBars
  headers={{
    feature: "Feature Name",
    usage: "Current Usage"
  }}
  className="usage-table"
/>
```

---

### `<SubscriptionCard>`

Display subscription details in a card format.

**Props:**
```typescript
interface SubscriptionCardProps {
  userId: string;
  showUsage?: boolean; // default: false
  showBilling?: boolean; // default: false
  allowManageSubscription?: boolean; // default: false
  onManageSubscription?: () => void;
  className?: string;
}
```

**Example:**
```tsx
<SubscriptionCard
  userId={userId}
  showUsage
  showBilling
  allowManageSubscription
  onManageSubscription={() => router.push("/portal")}
  className="subscription-card"
/>
```

---

## Utilities Reference

Client-side helper functions for working with Lumen data.

### Usage Formatting

#### `formatUsage()`

```typescript
function formatUsage(
  used: number,
  limit: number | null,
  options?: FormatUsageOptions
): FormattedUsage
```

**Example:**
```typescript
const result = formatUsage(150, 1000);
// => { used: 150, limit: 1000, percentage: 15, formatted: "150 / 1,000 (15%)", isUnlimited: false }

const unlimited = formatUsage(42, null);
// => { used: 42, limit: null, percentage: null, formatted: "42", isUnlimited: true }
```

#### `isNearLimit()`

```typescript
function isNearLimit(
  used: number,
  limit: number | null,
  threshold?: number // default: 0.8
): boolean
```

**Example:**
```typescript
isNearLimit(850, 1000, 0.8); // => true (85% > 80%)
isNearLimit(750, 1000, 0.8); // => false (75% < 80%)
isNearLimit(100, null); // => false (unlimited)
```

#### `isOverLimit()`

```typescript
function isOverLimit(
  used: number,
  limit: number | null
): boolean
```

**Example:**
```typescript
isOverLimit(1050, 1000); // => true
isOverLimit(950, 1000); // => false
```

### Entitlement Checking

#### `canAccessFeature()`

```typescript
function canAccessFeature(
  entitlements: FeatureEntitlement[],
  featureSlug: string
): boolean
```

**Example:**
```typescript
const hasAccess = canAccessFeature(entitlements, "premium-analytics");
if (hasAccess) {
  // Show premium feature
}
```

#### `getFeatureValue()`

```typescript
function getFeatureValue(
  entitlements: FeatureEntitlement[],
  featureSlug: string
): boolean | string | number | null
```

**Example:**
```typescript
const limit = getFeatureValue(entitlements, "api-calls"); // => 1000
const enabled = getFeatureValue(entitlements, "premium-support"); // => true
```

#### `getFeatureUsage()`

```typescript
function getFeatureUsage(
  entitlements: FeatureEntitlement[],
  featureSlug: string
): { used: number; limit: number | null } | null
```

**Example:**
```typescript
const usage = getFeatureUsage(entitlements, "api-calls");
// => { used: 150, limit: 1000 }
```

#### `getUpgradeReason()`

```typescript
function getUpgradeReason(
  entitlement: FeatureEntitlement
): UpgradeReason | null
```

**Example:**
```typescript
const reason = getUpgradeReason(entitlement);
// => { reason: "You've used 95% of your API calls", severity: "critical", percentage: 95 }
```

### Subscription Utilities

#### `getSubscriptionStatus()`

```typescript
function getSubscriptionStatus(
  subscription: Subscription | null
): string
```

**Example:**
```typescript
const status = getSubscriptionStatus(subscription);
// => "active" | "trial" | "past due" | "cancelled" | "paused" | "none"
```

#### `isTrialing()`

```typescript
function isTrialing(
  subscription: Subscription | null
): boolean
```

#### `getDaysRemainingInTrial()`

```typescript
function getDaysRemainingInTrial(
  subscription: Subscription | null
): number | null
```

**Example:**
```typescript
const daysLeft = getDaysRemainingInTrial(subscription); // => 7
```

#### `isSubscriptionActive()`

```typescript
function isSubscriptionActive(
  subscription: Subscription | null
): boolean
```

#### `formatCurrency()`

```typescript
function formatCurrency(
  amountCents: number,
  currency?: string // default: "USD"
): string
```

**Example:**
```typescript
formatCurrency(999900, "USD"); // => "$9,999.00"
formatCurrency(5000, "EUR"); // => "€50.00"
```

---

## TypeScript Support

The SDK is written in TypeScript and includes full type definitions.

### Import Types

```typescript
import type {
  // Subscription types
  SubscriptionStatus,
  Subscription,
  Customer,

  // Entitlement types
  FeatureEntitlement,
  Feature,
  EntitlementSource,
  CreditInfo,
  Usage,

  // Portal types
  CustomerOverview,
  PaymentMethod,
  Invoice,

  // Hook result types
  UseSubscriptionResult,
  UseEntitlementsResult,
  UseFeatureResult,
  UseFeatureGateResult,
  UseUsageQuotaResult,
  UseCustomerPortalResult,

  // Component prop types
  FeatureGateProps,
  UsageDisplayProps,
  SubscriptionBadgeProps,
  PaywallProps,
  UsageTableProps,
  SubscriptionCardProps,

  // Configuration types
  LumenConfig,
  UseQueryOptions,

  // Utility types
  FormattedUsage,
  UpgradeReason,
} from "@getlumen/react";
```

---

## Styling

All components use CSS classes with the `lumen-` prefix that you can style:

```css
/* Feature Gate & Paywall */
.lumen-paywall { }
.lumen-paywall-content { }
.lumen-paywall-title { }
.lumen-paywall-description { }
.lumen-paywall-reason { }
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
.lumen-badge-paused { }
.lumen-badge-none { }

/* Usage Table */
.lumen-usage-table { }
.lumen-usage-table-feature { }
.lumen-usage-table-value { }
.lumen-usage-table-progress { }
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

---

## Examples

See [EXAMPLES.md](./EXAMPLES.md) for complete copy-paste examples including:

- Feature gates with paywalls
- Usage monitoring dashboards
- Subscription management
- Real-time usage tracking
- Custom styling with Tailwind
- Error handling
- Testing setup

---

## Support

- **Documentation**: https://docs.getlumen.dev
- **GitHub**: https://github.com/getlumen/lumen
- **Issues**: https://github.com/getlumen/lumen/issues
- **Website**: https://getlumen.dev
