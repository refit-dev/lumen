# @getlumen/react - Usage Examples

Quick copy-paste examples to get you started.

## Setup

### 1. Create Lumen Proxy Handler (Next.js)

```typescript
// app/api/lumen/[...path]/route.ts
import { lumenNextHandler } from "@getlumen/server";
import { auth } from "@clerk/nextjs"; // or your auth system

export async function GET(request: Request) {
  const { userId } = auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await lumenNextHandler({
    request,
    userId,
  });

  return Response.json(result);
}

export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
```

### 2. Add LumenProvider

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

## Common Patterns

### Feature Gate with Paywall

```tsx
import { Paywall } from "@getlumen/react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

function PremiumFeature() {
  const router = useRouter();
  const { user } = useUser();

  return (
    <Paywall
      userId={user!.id}
      feature="premium-analytics"
      title="Unlock Premium Analytics"
      description="Get access to advanced insights and reporting"
      onUpgrade={() => router.push("/pricing")}
    >
      <PremiumAnalyticsDashboard />
    </Paywall>
  );
}
```

### Simple Feature Gate

```tsx
import { FeatureGate } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";

function BetaFeatures() {
  const { user } = useUser();

  return (
    <FeatureGate
      userId={user!.id}
      feature="beta-features"
      fallback={<p>This feature is not available yet</p>}
    >
      <BetaDashboard />
    </FeatureGate>
  );
}
```

### Usage Display with Warning

```tsx
import { UsageDisplay } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";

function ApiUsageWidget() {
  const { user } = useUser();

  return (
    <div className="usage-card">
      <UsageDisplay
        userId={user!.id}
        feature="api-calls"
        showProgressBar
        warnThreshold={0.8}
        label="API Calls This Month"
      />
    </div>
  );
}
```

### Subscription Status Badge

```tsx
import { SubscriptionBadge } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";

function Header() {
  const { user } = useUser();

  return (
    <header>
      <nav>
        <h1>My App</h1>
        <SubscriptionBadge
          userId={user!.id}
          showTrialDays
        />
      </nav>
    </header>
  );
}
```

### Subscription Management Card

```tsx
import { SubscriptionCard } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";

function SubscriptionPage() {
  const { user } = useUser();
  const router = useRouter();

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Your Subscription</h1>

      <SubscriptionCard
        userId={user!.id}
        showUsage
        showBilling
        allowManageSubscription
        onManageSubscription={() => router.push("/portal")}
      />
    </div>
  );
}
```

### Usage Dashboard

```tsx
import {
  UsageTable,
  SubscriptionBadge,
  useUsageQuota
} from "@getlumen/react";
import { useUser } from "@clerk/nextjs";

function UsageDashboard() {
  const { user } = useUser();
  const apiUsage = useUsageQuota(user!.id, "api-calls", 0.8);

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Usage Dashboard</h1>
        <SubscriptionBadge userId={user!.id} />
      </div>

      {apiUsage.isNearLimit && (
        <div className="bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-4 mb-6">
          <p>You're at {apiUsage.percentage}% of your API call limit!</p>
        </div>
      )}

      <UsageTable
        userId={user!.id}
        features={["api-calls", "storage", "users", "emails"]}
        showProgressBars
      />
    </div>
  );
}
```

### Custom Feature Check

```tsx
import { useFeature } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";

function CustomFeatureCheck() {
  const { user } = useUser();
  const { entitled, loading, usage } = useFeature(
    user!.id,
    "advanced-export"
  );

  if (loading) return <div>Loading...</div>;

  if (!entitled) {
    return (
      <button disabled className="opacity-50">
        Export (Upgrade to unlock)
      </button>
    );
  }

  return (
    <div>
      <button onClick={handleExport}>
        Export Data
      </button>
      {usage && (
        <p className="text-xs text-gray-500">
          {usage.used} / {usage.limit || "Unlimited"} exports this month
        </p>
      )}
    </div>
  );
}
```

### Programmatic Feature Gate

```tsx
import { useFeatureGate } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

function ProtectedPage() {
  const { user } = useUser();
  const router = useRouter();
  const { canAccess, loading, reason } = useFeatureGate(
    user!.id,
    "admin-panel"
  );

  useEffect(() => {
    if (!loading && !canAccess) {
      // Redirect if no access
      router.push("/pricing");
    }
  }, [loading, canAccess, router]);

  if (loading) return <div>Loading...</div>;
  if (!canAccess) return null; // Will redirect

  return <AdminPanel />;
}
```

### Real-time Usage Monitoring

```tsx
import { useUsageQuota } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";

function RealtimeUsageMonitor() {
  const { user } = useUser();

  // Refetch usage every 10 seconds
  const usage = useUsageQuota(
    user!.id,
    "api-calls",
    0.9, // Warn at 90%
    {
      refetchInterval: 10000,
      refetchOnWindowFocus: true,
    }
  );

  if (usage.loading) return <div>Loading...</div>;

  return (
    <div className="fixed bottom-4 right-4 bg-white shadow-lg rounded-lg p-4">
      <h3 className="font-semibold mb-2">API Usage</h3>
      <p className="text-2xl font-bold">{usage.formatted}</p>

      {usage.isOverLimit && (
        <p className="text-red-600 text-sm mt-2">Limit exceeded!</p>
      )}
      {usage.isNearLimit && !usage.isOverLimit && (
        <p className="text-yellow-600 text-sm mt-2">Approaching limit</p>
      )}
    </div>
  );
}
```

### All Features List

```tsx
import { useEntitlements } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";

function FeaturesPage() {
  const { user } = useUser();
  const { entitlements, loading } = useEntitlements(user!.id);

  if (loading) return <div>Loading features...</div>;

  return (
    <div className="grid grid-cols-2 gap-4">
      {entitlements?.entitlements.map((ent) => (
        <div
          key={ent.feature?.slug}
          className={`p-4 border rounded ${
            ent.entitled ? "border-green-500" : "border-gray-300"
          }`}
        >
          <h3 className="font-semibold">{ent.feature?.slug}</h3>
          <p className="text-sm">
            {ent.entitled ? "✓ Available" : "✗ Not available"}
          </p>

          {ent.usages && ent.usages.length > 0 && (
            <p className="text-xs text-gray-500 mt-2">
              Usage: {ent.usages.reduce((sum, u) => sum + u.usage, 0)}
              {typeof ent.feature?.value === "number" && ` / ${ent.feature.value}`}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
```

## Styling Examples

### Using Tailwind CSS

```tsx
import { Paywall } from "@getlumen/react";

function StyledPaywall() {
  return (
    <Paywall
      userId={userId}
      feature="premium"
      className="max-w-md mx-auto p-8 bg-gradient-to-br from-blue-50 to-indigo-100 rounded-xl shadow-lg"
    >
      <PremiumContent />
    </Paywall>
  );
}
```

### Custom CSS

```css
/* styles.css */
.lumen-paywall {
  max-width: 500px;
  margin: 2rem auto;
  padding: 2rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 1rem;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
}

.lumen-paywall-title {
  color: white;
  font-size: 2rem;
  margin-bottom: 1rem;
}

.lumen-paywall-button {
  background: white;
  color: #667eea;
  padding: 0.75rem 2rem;
  border-radius: 0.5rem;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: transform 0.2s;
}

.lumen-paywall-button:hover {
  transform: scale(1.05);
}

.lumen-usage-progress-bar {
  height: 8px;
  background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.lumen-usage-near-limit .lumen-usage-progress-bar {
  background: linear-gradient(90deg, #f59e0b 0%, #d97706 100%);
}

.lumen-usage-over-limit .lumen-usage-progress-bar {
  background: linear-gradient(90deg, #ef4444 0%, #dc2626 100%);
}
```

## Error Handling

```tsx
import { useSubscription } from "@getlumen/react";
import { useUser } from "@clerk/nextjs";

function SubscriptionWithErrorHandling() {
  const { user } = useUser();
  const { subscription, loading, error, refetch } = useSubscription(
    user!.id,
    {
      onError: (error) => {
        console.error("Failed to load subscription:", error);
        // Track error in your analytics
      },
      onSuccess: (data) => {
        console.log("Subscription loaded:", data);
      },
    }
  );

  if (loading) return <Skeleton />;

  if (error) {
    return (
      <div className="error-state">
        <p>Failed to load subscription</p>
        <button onClick={() => refetch()}>Try Again</button>
      </div>
    );
  }

  return <SubscriptionDisplay subscription={subscription} />;
}
```

## Testing

```tsx
// Mock for testing
import { LumenProvider } from "@getlumen/react";

function TestWrapper({ children }) {
  return (
    <LumenProvider
      config={{
        apiProxyUrl: "http://localhost:3000/api/lumen"
      }}
    >
      {children}
    </LumenProvider>
  );
}

// In your test
import { render } from "@testing-library/react";

test("feature gate works", () => {
  render(
    <TestWrapper>
      <MyComponent />
    </TestWrapper>
  );
  // ... test assertions
});
```
