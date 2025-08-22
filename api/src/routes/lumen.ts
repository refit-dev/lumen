import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { env } from "../env";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { getSecretOrEnvVar } from "../helpers/secrets";

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

        const lumenApiKey = await getSecretOrEnvVar({
          secretNameTemplate: "lumen/*/lumen-api-key",
          envVariableName: "LUMEN_API_KEY",
          throwOnDevError: false,
          throwOnStagingOrProdError: true,
        });

        const response = await fetch(
          `${env.API_URL}/customers/subscription-status?externalCustomerId=${externalCustomerId}`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${lumenApiKey}`,
            },
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          console.error(
            "Failed to fetch subscription status from Lumen API:",
            errorData
          );
          return c.json(
            { error: errorData || "Failed to fetch subscription status" },
            response.status as ContentfulStatusCode
          );
        }

        const subscriptionData =
          (await response.json()) as SubscriptionStatusResponse;
        return c.json(subscriptionData);
      } catch (error) {
        console.error(
          "Error in pricing table subscription status endpoint:",
          error
        );
        return c.json({ error: "Internal server error" }, 500);
      }
    }
  );
