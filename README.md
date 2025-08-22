[![Discord](https://img.shields.io/badge/Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/FgfrugCd)
[![Y Combinator](https://img.shields.io/badge/Y%20Combinator-W24-orange)](https://www.ycombinator.com/companies/lumen-payments)
[![Cloud](https://img.shields.io/badge/Cloud-☁️-blue)](https://getlumen.dev)
[![Documentation](https://img.shields.io/badge/Documentation-📕-blue)](https://docs.getlumen.dev)

DM founders:
<br>
[![Connect](https://img.shields.io/badge/-LinkedIn-blue?style=flat-square&logo=Linkedin&logoColor=white&link=https://www.linkedin.com/in/ramon-garate-4b379093/)](https://www.linkedin.com/in/ramon-garate-4b379093/)
[![Follow](https://img.shields.io/twitter/follow/ramonverse?style=social)](https://x.com/ramonverse)
<br>
[![Connect](https://img.shields.io/badge/-LinkedIn-blue?style=flat-square&logo=Linkedin&logoColor=white&link=https://www.linkedin.com/in/prasoondshukla/)](https://www.linkedin.com/in/prasoondshukla/)
[![Follow](https://img.shields.io/twitter/follow/prasoonds?style=social)](https://x.com/prasoonds)
<br>
founders@getlumen.dev

# <img src="https://getlumen.dev/lumen-logo-black-bg.png" alt="Lumen" height="40" style="vertical-align: middle; margin-right: 10px;">Lumen

The fastest way to add billing and feature access to your SaaS. Lumen is PSP agnostic and support merchants in India, United States and Europe through our integrations with Stripe & Dodo Payments. Integrations for Paddle, checkout.com, Razorpay and Adyen coming soon.
<br />

<div align="center">
  <a href="https://stripe.com" target="_blank">
    <img src="https://getlumen.dev/stripe.png" alt="Stripe" height="40" style="margin: 0 20px;">
  </a>
  <a href="https://dodopayments.com" target="_blank">
    <img src="https://getlumen.dev/dodopayments.svg" alt="Dodo Payments" height="40" style="margin: 0 20px;">
  </a>
</div>

## What is Lumen?

Lumen is a modern billing and entitlements platform that eliminates the complexity of implementing subscription management and feature access control. Unlike traditional approaches that scatter plan-based logic throughout your codebase, Lumen focuses on **features** instead of **plans**, making it trivial to modify pricing strategies without touching your code.

### The Problem with Traditional Billing

Most developers implement Stripe with plan-based checks scattered throughout their codebase:

```javascript
if (plan === "gold") {
  // give access to feature A
}

if (plan === "gold" || plan === "enterprise") {
  // give access to advanced analytics
  // also give access to feature B
}
```

When your business needs change (like moving a feature to a different plan or adding a free trial), engineers must hunt down and update every conditional without breaking existing functionality.

### Solution

Lumen eliminates plan-based logic by focusing on **features**:

```javascript
if (
  await isFeatureEntitled({ feature: "advanced-analytics", userId: user.id })
) {
  // give access
}
```

With this approach, your CRO can add the "advanced-analytics" feature to any plan with any trial period via the Lumen Dashboard, and everything just works!

## Key Benefits

- **Feature-First Architecture**: Structure your code around features, not plans
- **No Webhook Management**: We handle all the complex Stripe webhook orchestration
- **Built-in UI Components**: Ready-to-use React components for pricing tables and usage tracking
- **Usage-Based Billing**: Track and bill for feature usage automatically
- **High Rate Limits**: Call our APIs as much as you need without worrying about limits
- **Dashboard Management**: Non-technical team members can manage pricing without code changes

## Quick Integration

### 1. Install Packages

```bash
npm install @getlumen/server
```

```bash
npx shadcn@latest add https://getlumen.dev/pricing-table.json
```

### 2. Add Pricing Table (shadcn component)

```tsx
import { PricingTable } from "@/components/ui/pricing-table";

export default function PricingPage() {
  return (
    <PricingTable
      lumenPublishableKey={process.env.NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY}
      userId={session?.user?.id}
      loginRedirectUrl="/login"
    />
  );
}
```

### 3. Control Feature Access

```tsx
import { sendEvent, isFeatureEntitled } from "@getlumen/server";

export async function POST(request: NextRequest) {
  const { user } = await getUser();

  if (
    await isFeatureEntitled({
      feature: "ai-chat-requests",
      userId: user.id,
    })
  ) {
    // Your feature logic here...

    // Track usage after completion
    await sendEvent({
      name: "ai-chat-requests",
      userId: user.id,
    });
  }
}
```

## Documentation

- **📖 Full Documentation**: [docs.getlumen.dev](https://docs.getlumen.dev)
- **🚀 Getting Started Guide**: [docs.getlumen.dev/getting-started](https://docs.getlumen.dev/getting-started)
- **🎨 UI Components**:
  - [Pricing Table](https://docs.getlumen.dev/ui-components/pricing-table)
  - [Usage Badge](https://docs.getlumen.dev/ui-components/usage-badge)
- **📊 API Reference**: [docs.getlumen.dev/api-reference](https://docs.getlumen.dev/api-reference)
- **🆚 Lumen vs Stripe**: [docs.getlumen.dev/lumen-vs-stripe](https://docs.getlumen.dev/lumen-vs-stripe)

## Services Overview

### Getting Started

- Start all services: `bun run dev`
- Install ALL dependencies: `bun install` (at root)
- Clean node modules and install everything fresh: `bun run npm:delete-all && bun install`
- Clean DB, generate new schema and apply: `bun run db:reset-schema`
- Generate changes to the better-auth schema in the correct location: `bun run better-auth:generate-schema`
- Stop Docker services: `bun run docker:down`

### API Server

- **Base URL:** [http://localhost:8000](http://localhost:8000)

### Frontend

- **Next.js Frontend:** [http://localhost:3000](http://localhost:3000)

### Development Services (via Docker)

- **PostgreSQL:** [localhost:5432](localhost:5432)
  - **Database Name:** lumen
  - **Username:** lumen
  - **Password:** lumen_local
- **MinIO:**
  - **API:** [http://localhost:9000](http://localhost:9000)
  - **Console:** [http://localhost:9001](http://localhost:9001)
  - **Access Key:** lumen_minio
  - **Secret Key:** lumen_minio_local
- **pgAdmin:** [http://localhost:5050](http://localhost:5050)
  - **Email:** admin@example.com
  - **Password:** lumen_admin

  When you first log in to pgAdmin, you'll need to add the PostgreSQL server connection with these details:
  - **Host:** postgres (use the service name from docker-compose)
  - **Port:** 5432
  - **Database:** lumen
  - **Username:** lumen
  - **Password:** lumen_local

## Access Details

- **Next.js Frontend:** [http://localhost:3000](http://localhost:3000)
- **pgAdmin:** [http://localhost:5050](http://localhost:5050) (login with `admin@example.com` / `lumen_admin`)
- **MinIO Console:** [http://localhost:9001](http://localhost:9001) (login with `lumen_minio` / `lumen_minio_local`)
