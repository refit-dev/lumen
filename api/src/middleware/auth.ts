import { Context, MiddlewareHandler, Next } from "hono";
import { auth } from "../auth";
import { verifyApiKey } from "../helpers/api_keys";
import { apiKeysPermissionsSchema } from "@lumen/common/schema";
import { EnhancedSession } from "@lumen/common";
import { getSecretOrEnvVar } from "../helpers/secrets";
import { db } from "../db/client";
import { eq } from "drizzle-orm";
import { merchants } from "@lumen/common/schema";

// this is how we can do stuff like `c.get("merchant").id`
declare module "hono" {
  interface ContextVariableMap extends EnhancedSession {
    apiKey?: {
      keyType: "secret" | "publishable";
      permissions: (typeof apiKeysPermissionsSchema)[number][];
      keyValue: string;
      id: string;
    };
    triggerDev?: boolean; // Flag to indicate if the request is from Trigger.dev
  }
}

/**
 * Extract API key from various locations in the request
 */
const extractApiKey = (c: Context): string | null => {
  // Check Authorization header (Bearer token)
  const authHeader = c.req.header("Authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
};

/**
 * Middleware to require authentication (either session or API key)
 * This is the main authentication middleware used for most routes
 */
export const requireAuth: MiddlewareHandler = async (
  c: Context,
  next: Next
) => {
  try {
    // Check for API key first
    const apiKey = extractApiKey(c);

    if (apiKey) {
      if (apiKey.startsWith("pk_")) {
        return c.json(
          {
            error:
              "Secret API key required for this endpoint (starting with sk_), you are using a publishable key (starting with pk_)",
          },
          403
        );
      } else if (
        !apiKey.startsWith("sk_live_") &&
        !apiKey.startsWith("sk_test_")
      ) {
        return c.json(
          {
            error:
              "Invalid API key. Hint: a valid API key starts with sk_live_ or sk_test_",
          },
          401
        );
      }

      const keyData = await verifyApiKey(apiKey);

      if (!keyData) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const { merchantId, keyType } = keyData;

      if (keyType !== "secret") {
        // Safety check. We should never be able to hit this since we already check for
        // key starting with "sk_"
        return c.json(
          { error: "Secret API key required for this endpoint" },
          403
        );
      }
      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
      });

      if (!merchant) {
        return c.json({ error: "Merchant not found" }, 404);
      }

      // Create an enhanced session from API key data
      const enhancedSession: EnhancedSession = {
        user: null,
        session: null,
        organization: null,
        merchant,
      };

      // Store the session in context
      c.set("user", enhancedSession.user);
      c.set("session", enhancedSession.session);
      c.set("organization", enhancedSession.organization);
      c.set("merchant", enhancedSession.merchant);

      // Also store the key type and permissions
      c.set("apiKey", {
        keyType: keyData.keyType,
        permissions: keyData.permissions,
        keyValue: apiKey,
        id: keyData.id,
      });

      return await next();
    }

    // If no valid API key, try session-based auth
    const sessionResult = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (sessionResult) {
      // Cast to EnhancedSession since our auth config includes the enhanceSessionWithMerchant plugin
      const session = sessionResult as EnhancedSession;

      // If we have a valid session, store it in context
      c.set("user", session.user);
      c.set("session", session.session);

      // Store organization if available
      if (session.organization) {
        c.set("organization", session.organization);
      }

      // Store merchant if available
      if (session.merchant) {
        c.set("merchant", session.merchant);
      }

      // Block if no merchant is associated with the account
      if (
        !session.merchant &&
        // This route is used to fetch merchant data so it needs to be accessible without a merchant
        !c.req.path.includes("merchant-data") &&
        // This route creates the merchant so it needs to be accessible without a merchant
        !c.req.path.includes("onboarding-create-merchant") &&
        // This route is used to validate the Dodo API key so it needs to be accessible without a merchant
        !c.req.path.includes("stripe/validate-key") &&
        // This route is used to fetch the Dodo configuration so it needs to be accessible without a merchant
        !c.req.path.includes("dodo/validate-key") &&
        // This route is used to request access to Payment Providers before merchant is created
        !c.req.path.includes("beta/request")
      ) {
        return c.json(
          { error: "Unauthorized. No merchant associated with this account" },
          401
        );
      }

      return await next();
    } else {
      // Return 401 if not authenticated
      return c.json({ error: "Unauthorized" }, 401);
    }
  } catch (error) {
    console.error("Auth error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

/**
 * Middleware to validate Trigger.dev API key
 * This is used for endpoints that are triggered by Trigger.dev scheduled jobs
 */
export const triggerAuth: MiddlewareHandler = async (
  c: Context,
  next: Next
) => {
  try {
    const authHeader = c.req.header("Authorization");

    // Get the secret key from SSM Parameter Store or environment variable
    const triggerApiAccessKey = await getSecretOrEnvVar({
      secretNameTemplate: "lumen/*/trigger-api-access-key",
      envVariableName: "TRIGGER_API_ACCESS_KEY",
      throwOnDevError: true,
      throwOnStagingOrProdError: true,
    });

    if (!triggerApiAccessKey) {
      console.error(
        "Trigger secret key not found in SSM or environment variables"
      );
      return c.json({ error: "Server configuration error" }, 500);
    }

    // Check if Authorization header exists and matches "Bearer <TRIGGER_API_ACCESS_KEY>"
    if (!authHeader || authHeader !== `Bearer ${triggerApiAccessKey}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // If auth succeeds, set a special context value to indicate this is a Trigger.dev request
    c.set("triggerDev", true);

    return await next();
  } catch (error) {
    console.error("Trigger.dev auth error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
