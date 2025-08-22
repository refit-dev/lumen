import { hc } from "hono/client";
import type { AppType } from "../../../api/src/routes";
import { interceptedFetch } from "./api-interceptor";

// Use the same URL as your API client
const API_URL = process.env.NEXT_PUBLIC_API_URL;
if (!API_URL) {
  throw new Error("NEXT_PUBLIC_API_URL environment variable is not set");
}

// Create fetch interceptor for 401 handling
// Create Hono client with RPC type inference and auth error handling
export const apiClient = hc<AppType>(`${API_URL}/v1`, {
  headers: {
    "Content-Type": "application/json",
  },
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    return interceptedFetch(input, init);
  },
});
