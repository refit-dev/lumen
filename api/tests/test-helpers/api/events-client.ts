import { baseEnv } from "../../test-env";

/**
 * Creates a simple events API client
 * @param authHeader Authorization header value (typically Bearer token)
 */
export function createEventsClient(authHeader: string) {
  const apiUrl = baseEnv.API_URL || "http://localhost:8000";

  return {
    /**
     * Submit a single event
     */
    submitEvent: async (event: any) => {
      const response = await fetch(`${apiUrl}/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(event),
      });

      return {
        status: response.status,
        json: async () => response.json(),
      };
    },

    /**
     * Submit a batch of events
     */
    submitBatch: async (events: any[]) => {
      const response = await fetch(`${apiUrl}/events/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({ events }),
      });

      return {
        status: response.status,
        json: async () => response.json(),
      };
    },
  };
}
