# API Reference - Cheat Sheet

Quick reference for all hooks, components, and utilities.

## Hooks

### `useSubscription(userId, options?)`

Get subscription status.

```tsx
const { subscription, loading, error, refetch } = useSubscription(userId);
```

**Returns:**
- `subscription: SubscriptionStatus | null`
- `loading: boolean`
- `error: Error | null`
- `refetch: () => Promise<void>`

---

### `useEntitlements(userId, options?)`

Get all feature entitlements.

```tsx
const { entitlements, loading, error, refetch } = useEntitlements(userId);
```

**Returns:**
- `entitlements: EntitlementsResponse | null`
- `loading: boolean`
- `error: Error | null`
- `refetch: () => Promise<void>`

---

### `useFeature(userId, featureSlug, options?)`

Check specific feature with usage.

```tsx
const { entitled, value, usage, loading, error } = useFeature(userId, "api-calls");
```

**Returns:**
- `entitled: boolean`
- `value: boolean | string | number | null`
- `usage: { used: number; limit: number | null } | null`
- `loading: boolean`
- `error: Error | null`

---

### `useFeatureGate(userId, featureSlug, options?)`

Check feature with upgrade prompts.

```tsx
const { canAccess, showUpgrade, reason, loading, error } = useFeatureGate(userId, "premium");
```

**Returns:**
- `canAccess: boolean`
- `showUpgrade: boolean`
- `reason: string | null`
- `loading: boolean`
- `error: Error | null`

---

### `useUsageQuota(userId, featureSlug, warnThreshold?, options?)`

Track usage with warnings.

```tsx
const { used, limit, percentage, formatted, isNearLimit, isOverLimit, isUnlimited, loading, error } =
  useUsageQuota(userId, "api-calls", 0.8);
```

**Returns:**
- `used: number`
- `limit: number | null`
- `percentage: number | null`
- `formatted: string`
- `isNearLimit: boolean`
- `isOverLimit: boolean`
- `isUnlimited: boolean`
- `loading: boolean`
- `error: Error | null`

---

### `useCustomerPortal(userId, options?)`

Get customer portal data.

```tsx
const { overview, loading, error, refetch } = useCustomerPortal(userId);
```

**Returns:**
- `overview: CustomerOverview | null`
- `loading: boolean`
- `error: Error | null`
- `refetch: () => Promise<void>`

---

## Hook Options

All hooks accept optional configuration:

```tsx
{
  enabled?: boolean;                    // default: true
  refetchInterval?: number;             // milliseconds
  refetchOnWindowFocus?: boolean;       // default: false
  onSuccess?: (data: any) => void;
  onError?: (error: Error) => void;
}
```

---

## Components

### `<FeatureGate>`

Gate content by feature.

```tsx
<FeatureGate
  userId={string}
  feature={string}
  fallback?={ReactNode}
  loading?={ReactNode}
  error?={ReactNode}
  onAccessDenied?={(reason) => void}
>
  {children}
</FeatureGate>
```

---

### `<UsageDisplay>`

Display usage with progress.

```tsx
<UsageDisplay
  userId={string}
  feature={string}
  showProgressBar?={boolean}      // default: false
  warnThreshold?={number}          // default: 0.8
  className?={string}
  showLabel?={boolean}             // default: true
  label?={string}
/>
```

---

### `<SubscriptionBadge>`

Display subscription status.

```tsx
<SubscriptionBadge
  userId={string}
  className?={string}
  showTrialDays?={boolean}         // default: true
  labels?={{
    active?: string;
    trial?: string;
    pastDue?: string;
    cancelled?: string;
    paused?: string;
    none?: string;
  }}
/>
```

---

### `<Paywall>`

Show upgrade prompt.

```tsx
<Paywall
  userId={string}
  feature={string}
  title?={string}
  description?={string}
  upgradeButtonText?={string}      // default: "Upgrade Now"
  onUpgrade?={() => void}
  className?={string}
>
  {children}
</Paywall>
```

---

### `<UsageTable>`

Display usage table.

```tsx
<UsageTable
  userId={string}
  features?={string[]}
  className?={string}
  showProgressBars?={boolean}      // default: false
  headers?={{
    feature?: string;
    usage?: string;
    limit?: string;
    percentage?: string;
  }}
/>
```

---

### `<SubscriptionCard>`

Display subscription details.

```tsx
<SubscriptionCard
  userId={string}
  showUsage?={boolean}             // default: false
  showBilling?={boolean}           // default: false
  allowManageSubscription?={boolean} // default: false
  onManageSubscription?={() => void}
  className?={string}
/>
```

---

## Utilities

### Usage Utilities

```tsx
formatUsage(used, limit, options?)
// => { used, limit, percentage, formatted, isUnlimited }

isNearLimit(used, limit, threshold?)  // default threshold: 0.8
// => boolean

isOverLimit(used, limit)
// => boolean
```

---

### Entitlement Utilities

```tsx
canAccessFeature(entitlements, featureSlug)
// => boolean

getFeatureValue(entitlements, featureSlug)
// => boolean | string | number | null

getFeatureUsage(entitlements, featureSlug)
// => { used, limit } | null

getUpgradeReason(entitlement)
// => { reason, severity, percentage? } | null
```

---

### Subscription Utilities

```tsx
getSubscriptionStatus(subscription)
// => "active" | "trial" | "past due" | "cancelled" | "paused" | "none"

isTrialing(subscription)
// => boolean

getDaysRemainingInTrial(subscription)
// => number | null

isSubscriptionActive(subscription)
// => boolean

formatCurrency(amountCents, currency?)  // default: "USD"
// => string (e.g., "$99.00")
```

---

## Types

### Subscription Types

```typescript
interface SubscriptionStatus {
  hasActiveSubscription: boolean;
  customer: Customer;
  subscription: Subscription;
}

interface Customer {
  id: string;
  name: string | null;
  email: string | null;
  externalCustomerId: string | null;
}

interface Subscription {
  id: string;
  planId: string;
  planName: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "paused";
  currentPeriodEnd: string | null;
  currentPeriodStart: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
}
```

---

### Entitlement Types

```typescript
interface FeatureEntitlement {
  entitled: boolean | null;
  feature: Feature | null;
  source: EntitlementSource | null;
  usages?: Usage[];
  creditInfo?: CreditInfo;
}

interface Feature {
  slug: string;
  value: boolean | string | number | null;
}

type EntitlementSource = "plan" | "override" | "default" | "credits";

interface Usage {
  metricId: string;
  usage: number;
}

interface CreditInfo {
  creditAllowance: number;
  creditsRemaining: number;
  nextExpiryDate: Date | null;
}
```

---

### Portal Types

```typescript
interface CustomerOverview {
  customer: Customer;
  subscription: Subscription | null;
  paymentMethods: PaymentMethod[];
  upcomingInvoice: Invoice | null;
  recentInvoices: Invoice[];
}

interface PaymentMethod {
  id: string;
  type: string;
  last4?: string;
  brand?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault: boolean;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  dueDate: string | null;
  paidAt: string | null;
  invoiceDate: string;
  pdfUrl?: string;
}
```

---

## CSS Classes

### Usage Display
```css
.lumen-usage-display
.lumen-usage-label
.lumen-usage-value
.lumen-usage-progress-container
.lumen-usage-progress-bar
.lumen-usage-warning
.lumen-usage-normal
.lumen-usage-near-limit
.lumen-usage-over-limit
```

### Paywall
```css
.lumen-paywall
.lumen-paywall-content
.lumen-paywall-title
.lumen-paywall-description
.lumen-paywall-reason
.lumen-paywall-button
```

### Subscription Badge
```css
.lumen-subscription-badge
.lumen-badge-active
.lumen-badge-trial
.lumen-badge-past-due
.lumen-badge-cancelled
.lumen-badge-paused
.lumen-badge-none
```

### Usage Table
```css
.lumen-usage-table
.lumen-usage-table-feature
.lumen-usage-table-value
.lumen-usage-table-progress
.lumen-progress-container
.lumen-progress-bar
```

### Subscription Card
```css
.lumen-subscription-card
.lumen-subscription-card-header
.lumen-status-badge
.lumen-subscription-trial
.lumen-subscription-billing
.lumen-subscription-usage
.lumen-subscription-actions
```

---

## Quick Examples

### Feature Gate
```tsx
<FeatureGate userId={userId} feature="premium" fallback={<Upgrade />}>
  <PremiumFeature />
</FeatureGate>
```

### Check Access
```tsx
const { entitled } = useFeature(userId, "premium");
if (!entitled) return <Upgrade />;
```

### Show Usage
```tsx
<UsageDisplay userId={userId} feature="api-calls" showProgressBar />
```

### Usage Warning
```tsx
const { isNearLimit, percentage } = useUsageQuota(userId, "api-calls", 0.8);
{isNearLimit && <Alert>At {percentage}%!</Alert>}
```

### Subscription Badge
```tsx
<SubscriptionBadge userId={userId} showTrialDays />
```

### Full Paywall
```tsx
<Paywall
  userId={userId}
  feature="premium"
  title="Upgrade to Pro"
  onUpgrade={() => router.push("/pricing")}
>
  <PremiumContent />
</Paywall>
```
