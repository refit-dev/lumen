import { MiddlewareHandler, Context } from "hono";
import { getConnInfo } from "hono/bun";
import { RateLimiter } from "../helpers/rate-limiter";

// Helper function to reliably get client IP address
const getClientIp = (c: Context): string | null => {
  // First try to get IP from Hono's ConnInfo
  try {
    const connInfo = getConnInfo(c);
    if (connInfo?.remote?.address) {
      return connInfo.remote.address;
    }
  } catch (error) {
    console.warn("Failed to get IP from ConnInfo:", error);
  }

  // Fallback to header checks if ConnInfo doesn't provide the address
  const headers = c.req.raw.headers;
  const ip =
    headers.get("cf-connecting-ip") || // Cloudflare
    headers.get("x-real-ip") || // Common proxy header
    headers.get("x-forwarded-for")?.split(",")[0].trim() || // Standard, take first if multiple
    null; // Fallback

  // Basic validation
  if (ip && ip.length > 0 && ip !== "::1" && ip !== "127.0.0.1") {
    return ip;
  }
  console.warn("Could not reliably determine client IP for rate limiting.");
  return null;
};

// Initialize a dedicated rate limiter instance for IP-based limiting
const ipRateLimiter = new RateLimiter();

export const ipRateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const clientIp = getClientIp(c);

  if (!clientIp) {
    console.warn("Skipping IP rate limit: Could not determine client IP");
    return next();
  }

  try {
    const result = await ipRateLimiter.checkRateLimit(clientIp, "ip");

    // Set rate limit headers
    c.header("X-RateLimit-Limit", result.limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.reset.toString());
    c.header("X-RateLimit-By", "ip");

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
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          limit: result.limit,
          remaining: result.remaining,
          reset: result.reset,
          limitBy: "ip",
        },
        {
          headers: {
            "Retry-After": retryAfter.toString(),
          },
        }
      );
    }
  } catch (error) {
    console.error("IP rate limiting error:", error);
    // Fail open for consistency with the main rate limiter
    console.warn("IP rate limit middleware failed open due to an error.");
  }

  await next();
};
