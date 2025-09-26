import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { env } from "../env";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { getSecretOrEnvVar } from "../helpers/secrets";

async function getLumenApiKeyOrThrow() {
  const lumenApiKey = await getSecretOrEnvVar({
    secretNameTemplate: "lumen/*/lumen-api-key",
    envVariableName: "LUMEN_API_KEY",
    throwOnDevError: false,
    throwOnStagingOrProdError: true,
  });
  return lumenApiKey;
}

async function proxyToLumen({
  path,
  method,
  body,
  query,
}: {
  path: string;
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}) {
  const lumenApiKey = await getLumenApiKeyOrThrow();

  const url = new URL(env.API_URL + (path.startsWith("/") ? path : `/${path}`));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${lumenApiKey}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // no-op: some endpoints may return empty body
  }

  return { status: response.status as ContentfulStatusCode, data };
}

function ensureUserOwnsExternalId({
  userId,
  externalCustomerId,
}: {
  userId?: string;
  externalCustomerId: string;
}) {
  if (!userId || externalCustomerId !== userId) {
    return false;
  }
  return true;
}

// Schema for the pricing table subscription status request
const subscriptionStatusSchema = z.object({
  externalCustomerId: z.string().min(1, "External customer ID is required"),
});

// Type for the subscription status response from /customers/subscription-status/:externalCustomerId
type SubscriptionStatusResponse = {
  hasActiveSubscription: boolean;
  customer: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  subscription: {
    id: string;
    planId: string;
    planName: string;
    planDescription: string | null;
    priceId: string;
    currency: string;
    pricingData: any;
    startTimestamp: Date;
  } | null;
};

// Router used for dogfooding Lumen stuff
export const lumenRouter = new Hono()
  // Pricing table subscription status endpoint for our own Lumen platform
  .get(
    "/customers/subscription-status",
    zValidator("query", subscriptionStatusSchema),
    async (c) => {
      try {
        const { externalCustomerId } = c.req.valid("query");
        // Verify the requesting user owns this external customer ID
        // In our case, with the dogfooding, the external customer ID comes from the user object
        const userId = c.get("user")?.id;
        if (externalCustomerId !== userId) {
          return c.json({ error: "Forbidden" }, 403);
        }

        const proxied = await proxyToLumen({
          path: "/customers/subscription-status",
          method: "GET",
          query: { externalCustomerId },
        });
        if (proxied.status >= 200 && proxied.status < 300) {
          return c.json(
            proxied.data as SubscriptionStatusResponse,
            proxied.status
          );
        }
        return c.json(
          { error: proxied.data || "Failed to fetch subscription status" },
          proxied.status
        );
      } catch (error) {
        console.error(
          "Error in pricing table subscription status endpoint:",
          error
        );
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  // Customer Portal: overview proxy
  .get(
    "/customers/portal/overview",
    zValidator("query", subscriptionStatusSchema),
    async (c) => {
      try {
        const { externalCustomerId } = c.req.valid("query");
        const userId = c.get("user")?.id;
        if (!ensureUserOwnsExternalId({ userId, externalCustomerId })) {
          return c.json({ error: "Forbidden" }, 403);
        }
        const proxied = await proxyToLumen({
          path: "/customers/portal/overview",
          method: "GET",
          query: { externalCustomerId },
        });
        return c.json(proxied.data ?? {}, proxied.status);
      } catch (error) {
        console.error("Error in portal overview proxy:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  // Customer Portal: create setup intent
  .post(
    "/customers/portal/create-setup-intent",
    zValidator("json", z.object({ externalCustomerId: z.string().min(1) })),
    async (c) => {
      try {
        const { externalCustomerId } = c.req.valid("json");
        const userId = c.get("user")?.id;
        if (!ensureUserOwnsExternalId({ userId, externalCustomerId })) {
          return c.json({ error: "Forbidden" }, 403);
        }
        const proxied = await proxyToLumen({
          path: "/customers/portal/create-setup-intent",
          method: "POST",
          body: { externalCustomerId },
        });
        return c.json(proxied.data ?? {}, proxied.status);
      } catch (error) {
        console.error("Error in create-setup-intent proxy:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  // Customer Portal: set subscription payment method
  .post(
    "/customers/portal/set-subscription-payment-method",
    zValidator(
      "json",
      z.object({
        externalCustomerId: z.string().min(1),
        paymentMethodId: z.string().min(1),
      })
    ),
    async (c) => {
      try {
        const { externalCustomerId, paymentMethodId } = c.req.valid("json");
        const userId = c.get("user")?.id;
        if (!ensureUserOwnsExternalId({ userId, externalCustomerId })) {
          return c.json({ error: "Forbidden" }, 403);
        }
        const proxied = await proxyToLumen({
          path: "/customers/portal/set-subscription-payment-method",
          method: "POST",
          body: { externalCustomerId, paymentMethodId },
        });
        return c.json(proxied.data ?? {}, proxied.status);
      } catch (error) {
        console.error("Error in set-subscription-payment-method proxy:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  // Customer Portal: delete payment method
  .delete(
    "/customers/portal/payment-methods/:id",
    zValidator("param", z.object({ id: z.string().min(1) })),
    async (c) => {
      try {
        const { id } = c.req.valid("param");
        const proxied = await proxyToLumen({
          path: `/customers/portal/payment-methods/${id}`,
          method: "DELETE",
        });
        return c.json(proxied.data ?? {}, proxied.status);
      } catch (error) {
        console.error("Error in delete payment method proxy:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  // Invoices: get a presigned URL for an invoice PDF
  .get(
    "/invoices/:id/pdf",
    zValidator("param", z.object({ id: z.string().min(1) })),
    async (c) => {
      try {
        const { id } = c.req.valid("param");
        const proxied = await proxyToLumen({
          path: `/invoices/${id}/pdf`,
          method: "GET",
        });
        return c.json(proxied.data ?? {}, proxied.status);
      } catch (error) {
        console.error("Error in invoice PDF proxy:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  )
  .get("/user", async (c) => {
    return c.json({
      user: {
        name: c.get("user")?.name,
        email: c.get("user")?.email,
        id: c.get("user")?.id,
      },
    });
  });
