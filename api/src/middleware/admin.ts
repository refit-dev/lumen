import { MiddlewareHandler } from "hono";
import { ExtendedUser } from "@lumen/common";

/**
 * Middleware to require admin privileges.
 * Allows access if:
 * - Session user exists and has role "admin"
 * - OR an API key is present and includes the "admin" permission
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  try {
    const apiKey = c.get("apiKey") as { permissions: string[] } | undefined;
    if (apiKey && Array.isArray(apiKey.permissions)) {
      if (apiKey.permissions.includes("admin")) {
        return await next();
      }
    }

    const user = c.get("user") as ExtendedUser | null | undefined;
    if (user && user.role === "admin") {
      return await next();
    }

    return c.json({ error: "Forbidden: admin privileges required" }, 403);
  } catch (error) {
    console.error("requireAdmin error", error);
    return c.json({ error: "Forbidden" }, 403);
  }
};
