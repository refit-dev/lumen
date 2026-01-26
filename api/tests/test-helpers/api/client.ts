import { hc } from "hono/client";
import type { AppType } from "../../../src/routes";
import { auth } from "../../../src/auth";
import { env } from "../../../src/env";

export type ClientType = ReturnType<typeof createTestApiClient>;

/**
 * Creates a test API client with optional authentication token or API key
 *
 * @param tokenOrKey Authentication token or API key to include in headers
 * @param authType Type of authentication to use (session or apiKey)
 * @returns Hono client for the API
 */
export function createTestApiClient(
  tokenOrKey?: string,
  authType: "session" | "apiKey" = "session"
) {
  const headers: Record<string, string> = {};

  if (tokenOrKey) {
    if (authType === "session") {
      headers.Cookie = `better-auth.session_token=${tokenOrKey}`;
    } else {
      headers.Authorization = `Bearer ${tokenOrKey}`;
    }
  }

  return hc<AppType>(env.API_URL, {
    headers,
  });
}

/**
 * Creates an authenticated API client using session authentication
 *
 * @param email User email
 * @param password User password
 * @returns Promise resolving to an authenticated API client
 */
export async function createAuthenticatedClient(
  email: string,
  password: string
) {
  // Authenticate using better-auth
  const response = await auth.api.signInEmail({
    body: {
      email,
      password,
    },
    asResponse: true,
    headers: {
      "x-captcha-response": "test-captcha-response",
    },
  });

  if (response.status !== 200) {
    throw new Error(`Authentication failed with status ${response.status}`);
  }

  // Get cookies from response
  const cookies = response.headers.getSetCookie();
  const sessionTokenCookie = cookies.find((cookie: string) =>
    cookie.startsWith("better-auth.session_token=")
  );

  if (!sessionTokenCookie) {
    throw new Error("Session token not found in response cookies");
  }

  // Parse session token from cookie
  const sessionToken = sessionTokenCookie
    .split(";")[0]
    .replace("better-auth.session_token=", "");

  // Return a new client with the session token
  return createTestApiClient(sessionToken, "session");
}

/**
 * Creates an API client authenticated with an API key
 *
 * @param apiKey The API key to use for authentication
 * @returns Hono client for the API authenticated with the API key
 */
export function createApiKeyClient(apiKey: string) {
  return createTestApiClient(apiKey, "apiKey");
}
