import { createAuthClient } from "better-auth/react";
import { organizationClient, adminClient } from "better-auth/client/plugins";
import {
  ac,
  ownerRole,
  adminRole,
  memberRole,
  developerRole,
} from "@lumen/common";
import { EnhancedSession } from "@lumen/common";
import { fetchWithAuthInterceptor } from "./api-interceptor";

const API_URL = process.env.NEXT_PUBLIC_API_URL;
if (!API_URL) {
  throw new Error("NEXT_PUBLIC_API_URL environment variable is not set");
}

const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [
    organizationClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ac: ac as any,
      roles: {
        owner: ownerRole,
        admin: adminRole,
        member: memberRole,
        developer: developerRole,
      },
    }),
    adminClient(),
  ],
});

export const {
  signIn,
  signUp,
  signOut,
  getSession,
  useSession: useSessionDefault,
  organization,
  useActiveOrganization,
  useListOrganizations,
  admin,
  $ERROR_CODES: ERROR_CODES,
} = authClient;

// Export the full auth client for accessing all methods
export { authClient };

export const useSession = () => {
  const session = useSessionDefault();
  return {
    ...session,
    data: session.data as unknown as EnhancedSession,
  };
};

// Helper function to make authenticated API requests
export const apiClient = {
  baseURL: API_URL,

  fetch: async (endpoint: string, options: RequestInit = {}) => {
    const incomingHeaders = options.headers as HeadersInit | undefined;
    const mergedHeaders = new Headers(incomingHeaders);
    if (!mergedHeaders.has("Content-Type")) {
      mergedHeaders.set("Content-Type", "application/json");
    }
    const response = await fetchWithAuthInterceptor(
      `${apiClient.baseURL}${endpoint}`,
      {
        ...options,
        headers: mergedHeaders,
      }
    );
    return response;
  },

  get: async (endpoint: string, options: RequestInit = {}) => {
    return apiClient.fetch(endpoint, { ...options, method: "GET" });
  },

  post: async <T>(endpoint: string, data: T) => {
    return apiClient.fetch(endpoint, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  put: async <T>(endpoint: string, data: T) => {
    return apiClient.fetch(endpoint, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete: async (endpoint: string) => {
    return apiClient.fetch(endpoint, { method: "DELETE" });
  },
};
