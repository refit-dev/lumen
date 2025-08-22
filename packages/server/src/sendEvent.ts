/**
 * Send usage events to track customer activity and usage.
 *
 * Events are used to track customer usage for billing, entitlements, and analytics.
 * You can send numeric values for usage-based billing or string values for categorical tracking.
 *
 * @param params - The parameters for sending an event
 * @param params.name - The name of the event to track. Should match the event-name in the Plan > Features
 * @param params.value - The value associated with the event. Can be a number for usage or string for categorical data. Defaults to 1 if not provided.
 * @param params.userId - User ID from your backend system. Required if lumenCustomerId is not provided.
 * @param params.lumenCustomerId - Lumen customer ID. Required if userId is not provided.
 * @param params.idempotencyKey - Optional idempotency key to prevent duplicate events
 * @param params.apiUrl - Optional API URL override (defaults to production)
 * @param params.apiKey - Optional API key override (defaults to LUMEN_API_KEY env var)
 * @returns Promise resolving to the HTTP response object, or undefined on error
 *
 * @example
 * ```typescript
 * // Send a numeric usage event
 * await sendEvent({
 *   name: "api_call",
 *   value: 1,
 *   userId: "user_123"
 * });
 *
 * // Send a string categorical event
 * await sendEvent({
 *   name: "feature_used",
 *   value: "premium_feature",
 *   userId: "user_123"
 * });
 * ```
 */
export const sendEvent = async (
  params: {
    name: string;
    value?: number | string;
    idempotencyKey?: string;
    apiUrl?: string;
    apiKey?: string;
  } & (
    | {
        userId: string;
        lumenCustomerId?: string;
      }
    | {
        userId?: string;
        lumenCustomerId: string;
      }
  )
) => {
  try {
    const apiKey = params.apiKey ?? process.env.LUMEN_API_KEY;
    if (typeof window !== "undefined") {
      console.error(
        "Error: sendEvent should be called from server. You are calling it from the browser"
      );
      return;
    }
    if (!apiKey) {
      console.error(
        "Error: Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one"
      );
      return;
    }

    const { name, value, userId, idempotencyKey, lumenCustomerId } = params;

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";

    let eventValue: number | undefined;
    let eventString: string | undefined;

    if (typeof value === "string") {
      eventString = value;
    } else if (typeof value === "number") {
      eventValue = value;
    } else {
      eventValue = 1;
    }

    const response = await fetch(apiUrl + "/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        eventName: name,
        eventValue,
        eventString,
        customerId: lumenCustomerId ?? undefined,
        extCustomerId: userId ?? undefined,
        idempotencyKey,
      }),
    });

    if (!response.ok) {
      console.error("Error: Failed to send event", response);
    }

    return response;
  } catch (error) {
    console.error("Catch error: Failed to send event", error);
  }
};
