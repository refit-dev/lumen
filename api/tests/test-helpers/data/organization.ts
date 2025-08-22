/**
 * Organization helper functions for tests
 */
import { auth } from "../../../src/auth";
import { createId } from "@lumen/common";
import { authenticateTestUser } from "./auth";
import { OrganizationUpdate } from "../types";

/**
 * Creates a test organization using better-auth and adds the user as a member
 */
export async function createTestOrganization({
  name = `Test Organization ${Date.now()}`,
  slug = `test-org-${createId().substring(0, 8)}`,
  logo,
  userId,
  email,
  password,
}: OrganizationUpdate & {
  userId: string;
  email?: string;
  password?: string;
}): Promise<{
  id: string;
  name: string;
  slug: string;
}> {
  // Get user auth data
  const userEmail = email || `test-${userId}@example.com`;
  const userPassword = password || "password123!";
  const orgSlug = slug || `test-org-${createId().substring(0, 8)}`;

  // Authenticate user
  const authData = await authenticateTestUser(userEmail, userPassword);

  // Set up headers with cookies
  const headers = {
    Cookie: `better-auth.session_token=${authData.cookies.sessionToken}`,
  };

  // Create organization using better-auth
  // this also adds the user as a member
  const org = await auth.api.createOrganization({
    headers,
    body: {
      name,
      slug: orgSlug,
      logo: logo ?? undefined, // force 'string | null | undefined' -> 'string | undefined'
    },
  });

  if (!org) {
    console.error("Failed to create organization", org);
    throw new Error("Failed to create organization");
  }

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
  };
}
