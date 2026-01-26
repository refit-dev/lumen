import { Hono } from "hono";
import { lumenHonoHandler } from "@getlumen/server";
import { env } from "../env";
import { getSecretOrEnvVar } from "../helpers/secrets";

async function getLumenApiKey() {
  const lumenApiKey = await getSecretOrEnvVar({
    secretNameTemplate: "lumen/*/lumen-api-key",
    envVariableName: "LUMEN_API_KEY",
    throwOnDevError: false,
    throwOnStagingOrProdError: true,
  });
  return lumenApiKey;
}

// Router used for dogfooding Lumen stuff
// Uses the standard lumenHonoHandler from @getlumen/server
export const lumenRouter = new Hono()
  // User endpoint for getting the current user info (used by Next.js handler)
  .get("/user", async (c) => {
    return c.json({
      user: {
        name: c.get("user")?.name,
        email: c.get("user")?.email,
        id: c.get("user")?.id,
      },
    });
  })
  // All other Lumen requests are handled by lumenHonoHandler
  .all("/*", async (c) => {
    const apiKey = await getLumenApiKey();

    const handler = lumenHonoHandler({
      getUserId: (ctx) => ctx.get("user")?.id,
      mountPath: "/v1/lumen",
      apiKey: apiKey || undefined,
      apiUrl: env.API_URL,
    });

    return handler(c);
  });
