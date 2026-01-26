import { createMiddleware } from "hono/factory";
import { env } from "../env";
import { getSecretOrEnvVar } from "../helpers/secrets";

let cachedInternalApiKey: string | null | undefined;

async function getInternalApiKey(): Promise<string | null> {
  if (cachedInternalApiKey !== undefined) return cachedInternalApiKey;

  try {
    const key = await getSecretOrEnvVar({
      secretNameTemplate: "lumen/*/internal-api-key",
      envVariableName: "INTERNAL_API_KEY",
      throwOnDevError: false,
      throwOnStagingOrProdError: env.NODE_ENV !== "development",
    });
    cachedInternalApiKey = key;
    return key;
  } catch (e) {
    console.error("Failed to resolve INTERNAL_API_KEY", e);
    cachedInternalApiKey = null;
    return null;
  }
}

export const requireInternalApiKey = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    const errorMessage =
      "Invalid authorization header. Must start with Bearer.";
    console.error(errorMessage);
    return c.json({ error: errorMessage }, 401);
  }

  const providedKey = authHeader.substring(7);
  const internalApiKey = await getInternalApiKey();

  if (!internalApiKey) {
    console.error("Internal API key not configured");
    return c.json({ error: "Internal API key not configured" }, 500);
  }

  if (providedKey !== internalApiKey) {
    const errorMessage = "Invalid internal API key";
    console.error(errorMessage);
    return c.json({ error: errorMessage }, 401);
  }

  await next();
});
