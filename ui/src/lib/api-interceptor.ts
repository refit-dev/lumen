/**
 * Global API interceptor for handling authentication errors
 * Automatically redirects to login on 401 responses
 */

let isRedirecting = false;

const API_URL = process.env.NEXT_PUBLIC_API_URL;

/**
 * Determine if the session is still valid by calling the auth endpoint.
 */
const isSessionAlive = async (): Promise<boolean> => {
  if (typeof window === "undefined" || !API_URL) return false;
  try {
    const res = await fetch(`${API_URL}/api/auth/get-session`, {
      credentials: "include",
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data?.user;
  } catch {
    return false;
  }
};

export const handleAuthError = async (
  response: Response
): Promise<Response> => {
  if (response.status === 401 && !isRedirecting) {
    // Check if the session is actually gone
    const alive = await isSessionAlive();
    if (!alive) {
      isRedirecting = true;
      console.warn("Authentication failed - redirecting to login");
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      setTimeout(() => {
        isRedirecting = false;
      }, 1000);
    }
  }
  return response;
};

/**
 * Enhanced fetch wrapper that intercepts 401 responses
 */
export const fetchWithAuthInterceptor = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  try {
    const response = await fetch(input, {
      credentials: "include",
      ...init,
    });
    return handleAuthError(response);
  } catch (error) {
    // Re-throw network errors
    throw error;
  }
};

/**
 * Create a fetch interceptor for external libraries that accept custom fetch
 */
export const createFetchInterceptor = (originalFetch = fetch) => {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    try {
      const response = await originalFetch(input, {
        credentials: "include",
        ...init,
      });
      return handleAuthError(response);
    } catch (error) {
      throw error;
    }
  };
};

/**
 * Utility function for components making direct fetch calls
 * Use this instead of the native fetch for better error handling
 */
export const safeFetch = fetchWithAuthInterceptor;
export const interceptedFetch = createFetchInterceptor();
