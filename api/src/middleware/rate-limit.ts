import { MiddlewareHandler } from "hono";
import { RateLimiter } from "../helpers/rate-limiter";

// Initialize the rate limiter instance for API key-based limiting
const rateLimiter = new RateLimiter();

export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const authMethod = c.get("authMethod");
  const apiKey = c.get("apiKey");

  // Only apply rate limiting if authentication was done via API key
  if (authMethod === "apiKey" && apiKey?.id) {
    try {
      const result = await rateLimiter.checkRateLimit(apiKey.id, "key");

      // Set rate limit headers
      c.header("X-RateLimit-Limit", result.limit.toString());
      c.header("X-RateLimit-Remaining", result.remaining.toString());
      c.header("X-RateLimit-Reset", result.reset.toString());
      c.header("X-RateLimit-By", "key");

      if (!result.isAllowed) {
        const retryAfter = Math.max(
          0,
          result.reset > Math.floor(Date.now() / 1000)
            ? result.reset - Math.floor(Date.now() / 1000)
            : 0
        );

        c.status(429);
        return c.json(
          {
            error: "Too Many Requests",
            message: `API key rate limit exceeded. Try again in ${retryAfter} seconds.`,
            limit: result.limit,
            remaining: result.remaining,
            reset: result.reset,
            limitBy: "key",
          },
          {
            headers: {
              "Retry-After": retryAfter.toString(),
            },
          }
        );
      }
    } catch (error) {
      console.error("API key rate limiting error:", error);
      // Fail open for consistency
      console.warn(
        "API key rate limit middleware failed open due to an error."
      );
    }
  }

  await next();
};
