/**
 * Authentication data generation helpers
 */
import { auth } from "../../../src/auth";
import { TestUserProps } from "../types";
import { db } from "../../../src/db/client";
import { session, user } from "@lumen/common/schema";
import { eq } from "drizzle-orm";
import { testEnv } from "../../test-env";

/**
 * Creates a test user using better-auth
 *
 * @returns The created user including password for testing
 */
export async function createTestUser({
  name = "Test User",
  email = `test-${Date.now()}@example.com`,
  password = testEnv.DEV_PASSWORD,
}: TestUserProps = {}): Promise<{
  id: string;
  name: string;
  email: string;
  password: string;
}> {
  // Use better-auth to create a user
  const { user } = await auth.api.signUpEmail({
    body: {
      name,
      email,
      password,
    },
    headers: {
      "x-captcha-response": "test-captcha-response",
    },
  });

  // Return the user with password for test purposes
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    password,
  };
}

/**
 * Authenticates a test user and retrieves the session token
 *
 * @returns The session token and user details for authenticated requests
 */
export async function authenticateTestUser(email: string, password: string) {
  // 1. Sign in the user to create a session
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

  // Check for cookies
  if (!response.headers.get("set-cookie")) {
    console.error(await response.json());
    throw new Error("Sign In Failed: No session cookie set");
  }

  // 2. Parse cookies to extract session token
  const cookies = response.headers.getSetCookie();

  // Extract session token cookie
  const sessionTokenCookie = cookies.find((cookie: string) =>
    cookie.startsWith("better-auth.session_token=")
  );
  const sessionDataCookie = cookies.find((cookie: string) =>
    cookie.startsWith("better-auth.session_data=")
  );

  if (!sessionTokenCookie) {
    throw new Error("Sign In Failed: No session token cookie");
  }
  if (!sessionDataCookie) {
    throw new Error("Sign In Failed: No session data cookie");
  }

  // Parse all cookie attributes
  const parseCookieWithAttributes = (cookieStr: string) => {
    const [nameValue, ...attributes] = cookieStr
      .split(";")
      .map((s) => s.trim());
    const [name, value] = nameValue.split("=").map((s) => s.trim());

    const parsedCookie = {
      name,
      value,
      attributes: {} as Record<string, string | boolean>,
    };

    attributes.forEach((attr) => {
      const [key, val] = attr.split("=").map((s) => s.trim());
      parsedCookie.attributes[key.toLowerCase()] = val || true;
    });

    return parsedCookie;
  };

  const parsedSessionTokenCookie =
    parseCookieWithAttributes(sessionTokenCookie);
  const parsedSessionDataCookie = parseCookieWithAttributes(sessionDataCookie);

  // 3. Get the user information from database using the session
  const sessionRecord = await db.query.session.findFirst({
    where: eq(session.token, parsedSessionTokenCookie.value.split(".")[0]),
  });

  if (!sessionRecord) {
    throw new Error("Failed to find session in database");
  }

  // 4. Get user data from the database to ensure we have complete information
  const userData = await db.query.user.findFirst({
    where: eq(user.email, email),
  });

  if (!userData) {
    throw new Error("Failed to find user in database");
  }

  // 5. Return token and user information
  return {
    status: response.status,
    body: {
      user: userData,
    },
    session: {
      id: sessionRecord.id,
      token: sessionRecord.token,
      userId: sessionRecord.userId,
      expires: sessionRecord.expiresAt,
    },
    // Include cookies for clients that need to set them
    cookies: {
      sessionToken: parsedSessionTokenCookie.value,
      sessionData: parsedSessionDataCookie.value,
    },
  };
}
