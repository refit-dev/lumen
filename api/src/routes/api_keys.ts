import { Hono } from "hono";
import { z } from "zod";
import { ID_PREFIXES, createPrefixValidator } from "@lumen/common";
import { zValidator } from "@hono/zod-validator";
import { createApiKey, listApiKeys, revokeApiKey } from "../helpers/api_keys";
import { omitKeyNoTypeError as omitKey } from "../helpers/utils";
import { db } from "../db/client";
import { and, isNull, eq } from "drizzle-orm";
import { apiKeys } from "@lumen/common/schema";

// Create a router for API key management

// Schema for creating a new API key
const createApiKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  keyType: z.enum(["secret", "publishable"]),
  environment: z.enum(["live", "test"]).default("live"),
  permissions: z.array(z.enum(["admin", "public"])).optional(), // setting manually because of zod parsing errors
});

// Schema for revoking an API key
const revokeApiKeySchema = z.object({
  id: createPrefixValidator(
    ID_PREFIXES.apiKey,
    "Invalid API key ID format"
  )(z.string()),
});

const apiKeysRouter = new Hono()
  /**
   * Get a publishable key by environment
   * GET /api-keys/publishable?environment=test|live
   */
  .get("/publishable", async (c) => {
    try {
      const merchantId = c.get("merchant")!.id;

      // Find the active publishable key for this environment
      const publishableKey = await db.query.apiKeys.findFirst({
        where: and(
          eq(apiKeys.merchantId, merchantId),
          eq(apiKeys.keyType, "publishable"),
          eq(apiKeys.environment, "live"),
          isNull(apiKeys.revokedAt)
        ),
      });

      if (!publishableKey) {
        return c.json(
          { error: "No active publishable key found for this environment" },
          404
        );
      }

      // Return the full key value for publishable keys (they're not hashed)
      return c.json({
        success: true,
        data: {
          id: publishableKey.id,
          name: publishableKey.name,
          keyType: publishableKey.keyType,
          environment: publishableKey.environment,
          keyValue: publishableKey.keyValue, // This is the full publishable key
          prefix: publishableKey.prefix,
          createdAt: publishableKey.createdAt,
        },
      });
    } catch (error) {
      console.error("Error getting publishable key:", error);
      return c.json(
        {
          error: "Failed to get publishable key",
          details: (error as Error).message,
        },
        500
      );
    }
  })

  /**
   * Create a new API key and return the full key value
   * Use with caution - this will return the REAL key value
   * POST /api-keys
   */
  .post("/", zValidator("json", createApiKeySchema), async (c) => {
    try {
      const merchantId = c.get("merchant")!.id;
      const body = c.req.valid("json");

      // Set default permissions based on key type
      const permissions =
        body.permissions ||
        (body.keyType === "secret" ? ["admin"] : ["public"]);

      if (body.keyType === "secret" && !permissions.includes("admin")) {
        return c.json(
          {
            error: "Bad Request",
            details: "Secret keys must include the 'admin' permission.",
          },
          400
        );
      }

      // Create the API key
      const apiKey = await createApiKey({
        merchantId,
        name: body.name,
        keyType: body.keyType,
        environment: body.environment,
        permissions,
      });

      return c.json(
        {
          success: true,
          data: apiKey, // this will have the REAL key value - use with caution
        },
        201
      );
    } catch (error) {
      console.error("Error creating API key:", error);
      return c.json(
        {
          error: "Failed to create API key",
          details: (error as Error).message,
        },
        500
      );
    }
  })
  /**
   * List all API keys for the authenticated merchant
   * GET /api-keys
   */
  .get("/", async (c) => {
    try {
      const merchantId = c.get("merchant")!.id;

      const keys = await listApiKeys(merchantId);

      // Map to response format, removing sensitive data
      const mappedKeys = keys.map((key) => {
        // Create a response object without the full key value
        const safeKey = omitKey(key, "keyValue");
        return {
          ...safeKey,
          // Only return the prefix for display
          keyValue: key.prefix,
        };
      });

      return c.json({
        success: true,
        data: mappedKeys,
      });
    } catch (error) {
      console.error("Error listing API keys:", error);
      return c.json(
        {
          error: "Failed to list API keys",
          details: (error as Error).message,
        },
        500
      );
    }
  })
  /**
   * Revoke an API key
   * DELETE /api-keys/:id
   */
  .delete("/:id", zValidator("param", revokeApiKeySchema), async (c) => {
    try {
      const merchantId = c.get("merchant")!.id;

      const { id } = c.req.valid("param");

      const revokedKey = await revokeApiKey(id, merchantId);
      console.log("revokedKey", revokedKey);

      if (!revokedKey) {
        return c.json({ error: "API key not found" }, 404);
      }

      return c.json({
        success: true,
        data: {
          id: revokedKey.id,
          revokedAt: revokedKey.revokedAt,
        },
      });
    } catch (error) {
      console.error("Error revoking API key:", error);
      return c.json(
        {
          error: "Failed to revoke API key",
          details: (error as Error).message,
        },
        500
      );
    }
  });

export default apiKeysRouter;
