import { Hono } from "hono";
import { requireAuth, triggerAuth } from "../middleware/auth";
import merchantsRouter from "./merchants";
import { plansRoute } from "./plans";
import { pricesRoute } from "./prices";
import { entitlementsRouter } from "./entitlements";
import { featuresRouter } from "./features";
import { customersRouter } from "./customers";
import { publicRoute } from "./public";
import { subscriptionsRouter } from "./subscriptions";
import { billingRouter } from "./billing";
import apiKeysRouter from "./api_keys";
import invoicesRouter from "./invoices";
import { rateLimitMiddleware } from "../middleware/rate-limit"; // API key rate limiting
import { ipRateLimitMiddleware } from "../middleware/ip-rate-limit"; // IP-based rate limiting
import { stripeRouter } from "./stripe";
import { paymentMethodsRoute, paymentsRouter } from "./payment";
import { eventsRouter, eventsBackfillRouter } from "./events";
import { metricsRouter } from "./metrics";
import {
  pricingTablesRouter,
  publicPricingTablesRouter,
} from "./pricing_tables";
import { creditsRouter, triggerCreditsRouter } from "./credits";
import { taxRouter } from "./tax";
import { seatsRoute } from "./seats";
import { integrationWebhooksRouter } from "./webhook_integrations";
import { dodoRouter } from "./dodo";
import { lumenRouter } from "./lumen";
import { betaRouter } from "./beta";
import { enrollmentRouter } from "./enrollment";
import {
  internalKeyValuesRouter,
  internalDenyListRouter,
} from "./internal_key_values";
import { requireInternalApiKey } from "../middleware/internalApiKey";
import { teamRoute } from "./team";

// Create a subrouter for authenticated routes that require either:
// 1. Session auth (browser-based user session) OR
// 2. Secret API key auth (for API integrations)
// These routes CANNOT be accessed with publishable keys
// API key rate limiting is applied AFTER successful authentication
console.log("[ROUTES] Creating authenticated routes...");
const authenticatedRoutes = new Hono()
  .use(requireAuth) // Auth first
  .use(rateLimitMiddleware) // Then rate limit (will use API Key ID only, not session for now)
  .route("/merchants", merchantsRouter)
  .route("/plans", plansRoute)
  .route("/prices", pricesRoute)
  .route("/entitlements", entitlementsRouter)
  .route("/features", featuresRouter)
  .route("/customers", customersRouter)
  .route("/subscriptions", subscriptionsRouter)
  .route("/invoices", invoicesRouter)
  .route("/api-keys", apiKeysRouter)
  .route("/stripe", stripeRouter)
  .route("/dodo", dodoRouter)
  .route("/payments", paymentsRouter)
  .route("/payment-methods", paymentMethodsRoute)
  .route("/events", eventsRouter)
  .route("/metrics", metricsRouter)
  .route("/pricing-tables", pricingTablesRouter)
  .route("/credits", creditsRouter)
  .route("/tax", taxRouter)
  .route("/seats", seatsRoute)
  .route("/webhooks", integrationWebhooksRouter)
  .route("/enrollment", enrollmentRouter)
  .route("/lumen", lumenRouter) // For dogfooding Lumen stuff
  .route("/beta", betaRouter)
  .route("/internal", internalKeyValuesRouter)
  .route("/team", teamRoute);
// Router for Trigger.dev webhooks - requires Trigger.dev specific auth
// These routes are authenticated using the Trigger.dev TRIGGER_API_ACCESS_KEY
console.log("[ROUTES] Creating trigger routes...");
const triggerRouter = new Hono()
  .use(triggerAuth)
  .route("/billing", billingRouter)
  .route("/credits", triggerCreditsRouter)
  .route("/events-backfill", eventsBackfillRouter);

// Create a subrouter for public routes with IP-based rate limiting
console.log("[ROUTES] Creating public routes...");
const publicRoutesWithRateLimit = new Hono()
  .use(ipRateLimitMiddleware) // Apply IP-based rate limiting
  .route("/", publicRoute)
  .route("/pricing-tables", publicPricingTablesRouter);

const denylistRoutes = new Hono()
  .use(requireInternalApiKey)
  .route("/", internalDenyListRouter);

// Main router structure:
// - /public routes: For client-side usage, IP rate limited
// - / authenticated routes: Require session auth or secret key, API key rate limited
console.log("[ROUTES] Creating main router...");
const appRoutes = new Hono()
  .route("/public", publicRoutesWithRateLimit)
  // Fix for Dodo webhooks that were created with double /v1 prefix
  // caused by API_URL including /v1 and the code appending it again
  // Should be removed when we know that no one is using the old bad webhook URLs in Dodo
  .route("/v1/public", publicRoutesWithRateLimit)
  .route("/trigger", triggerRouter)
  .route("/denylist", denylistRoutes)
  // THIS ROUTE NEEDS TO BE MOUNTED LAST, so requireAuth doesn't apply to all routes
  .route("/", authenticatedRoutes);

console.log("[ROUTES] Main router created successfully");

// Export final routes type for client RPC
export type AppType = typeof appRoutes;

export default appRoutes;
console.log("[ROUTES] Exporting main router...");
