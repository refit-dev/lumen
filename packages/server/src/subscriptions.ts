/**
 * Create a free subscription for a customer if they don't already have one.
 *
 * This function is useful for onboarding new users with a free tier or trial subscription.
 * It will only create a subscription if the customer doesn't already have an active subscription.
 *
 * @param params - The parameters for creating a free subscription
 * @param params.email - Customer's email address
 * @param params.name - Customer's full name
 * @param params.userId - User ID from your backend system to identify the customer
 * @param params.billingAddressLine1 - Optional billing address line 1
 * @param params.billingAddressLine2 - Optional billing address line 2
 * @param params.billingCity - Optional billing city
 * @param params.billingPostalCode - Optional billing postal/zip code
 * @param params.billingCountry - Optional billing country code (ISO 3166-1 alpha-2)
 * @param params.taxId - Optional tax ID for the customer
 * @param params.apiUrl - Optional API URL override (defaults to production)
 * @returns Promise resolving to the created subscription data
 * @throws Error if the subscription creation fails or if called from browser environment
 *
 * @example
 * ```typescript
 * const subscription = await createFreeSubscriptionIfNoneExists({
 *   email: "user@example.com",
 *   name: "John Doe",
 *   userId: "user_123",
 *   billingAddressLine1: "123 Main St",
 *   billingCity: "New York",
 *   billingCountry: "US",
 *   billingPostalCode: "10001"
 * });
 * ```
 */
export const createFreeSubscriptionIfNoneExists = async (params: {
  email: string;
  name: string;
  userId: string;
  billingAddressLine1?: string;
  billingAddressLine2?: string;
  billingCity?: string;
  billingPostalCode?: string;
  billingCountry?: string;
  taxId?: string;
  apiUrl?: string;
}) => {
  try {
    const apiKey = process.env.LUMEN_API_KEY;
    if (typeof window !== "undefined") {
      throw new Error(
        "createFreeSubscription should be called from server. You are calling it from the browser"
      );
    }
    if (!apiKey) {
      throw new Error(
        "Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one"
      );
    }

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";

    const response = await fetch(
      apiUrl + "/v1/subscriptions/create-free-subscription",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          customerEmail: params.email,
          customerName: params.name,
          userId: params.userId,
          billingAddressLine1: params.billingAddressLine1,
          billingAddressLine2: params.billingAddressLine2,
          billingCity: params.billingCity,
          billingPostalCode: params.billingPostalCode,
          billingCountry: params.billingCountry,
          taxId: params.taxId,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to create free subscription: ${response.statusText}`
      );
    }

    return response.json();
  } catch (error) {
    console.error("Error creating free subscription:", error);
    throw error;
  }
};
