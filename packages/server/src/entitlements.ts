const getEndpoint = (
  endpoint: string,
  params: any,
  customerId: string,
  isExtCustId: boolean
) => {
  const apiEndpoint = endpoint.replace(/{([^}]+)}/g, (match, key) => {
    if (key === "customerId") {
      return customerId;
    } else {
      if (!(key in params)) {
        throw new Error(`Parameter "${key}" not found in params object`);
      }

      if (typeof params[key] !== "string") {
        throw new Error(`Parameter "${key}" must be a string`);
      }

      return params[key];
    }
  });
  return apiEndpoint + `?isExtCustId=${isExtCustId}`;
};

const callAPI = async (params: any, endpoint: string) => {
  try {
    if (typeof window !== "undefined") {
      const error =
        "Error: getUsage should be called from server. You are calling it from the browser";
      console.error(error);
      return { error };
    }
    const apiKey = process.env.LUMEN_API_KEY;
    if (!apiKey) {
      const error =
        "Error: Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one";
      console.error(error);
      return { error };
    }
    let isExtCustId: boolean;
    let customerId: string;

    if ("userId" in params) {
      isExtCustId = true;
      customerId = params.userId;
    } else {
      isExtCustId = false;
      customerId = params.lumenCustomerId;
    }

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";

    const apiEndpoint = getEndpoint(endpoint, params, customerId, isExtCustId);
    const fullUrl = apiUrl + apiEndpoint;

    const response = await fetch(fullUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const error = `Error: Failed to fetch ${fullUrl}`;
      console.error(error, response);
      return { error };
    }

    return response.json();
  } catch (error) {
    const errorMessage = `Catch error: Failed to fetch ${endpoint}`;
    console.error(errorMessage, error);
    return { error: errorMessage };
  }
};

/**
 * Get current usage and entitlements for a customer.
 *
 * Returns detailed information about a customer's current usage against their subscription limits,
 * including feature entitlements and usage metrics.
 *
 * @param params - The parameters for getting usage data
 * @param params.userId - User ID from your backend system. Required if lumenCustomerId is not provided.
 * @param params.lumenCustomerId - Lumen customer ID. Required if userId is not provided.
 * @param params.apiUrl - Optional API URL override (defaults to production)
 * @returns Promise resolving to usage data including entitlements array with feature details, usage, and limits
 *
 * @example
 * ```typescript
 * const usage = await getUsage({
 *   userId: "user_123"
 * });
 *
 * // Returns:
 * // {
 * //   entitlements: [
 * //     {
 * //       feature: { slug: 'api_calls', name: 'API Calls' },
 * //       entitled: true,
 * //       usage: 150,
 * //       limit: 1000
 * //     }
 * //   ]
 * // }
 * ```
 */
export const getUsage = async (
  params: {
    apiUrl?: string;
  } & (
    | {
        userId: string;
      }
    | {
        lumenCustomerId: string;
      }
  )
) => {
  return await callAPI(params, "/v1/entitlements/{customerId}");
};

/**
 * Get feature entitlements for a customer as a simple key-value object.
 *
 * Returns a simplified object where keys are feature slugs and values are boolean entitlements.
 * This is useful for quick feature flag checks in your application.
 *
 * @param params - The parameters for getting feature data
 * @param params.userId - User ID from your backend system. Required if lumenCustomerId is not provided.
 * @param params.lumenCustomerId - Lumen customer ID. Required if userId is not provided.
 * @param params.apiUrl - Optional API URL override (defaults to production)
 * @returns Promise resolving to an object with feature slugs as keys and boolean entitlements as values
 *
 * @example
 * ```typescript
 * const features = await getFeatures({
 *   userId: "user_123"
 * });
 *
 * // Returns:
 * // {
 * //   api_calls: true,
 * //   premium_feature: false,
 * //   advanced_analytics: true
 * // }
 * ```
 */
export const getFeatures = async (
  params: {
    apiUrl?: string;
  } & (
    | {
        userId: string;
      }
    | {
        lumenCustomerId: string;
      }
  )
) => {
  const { entitlements } = await callAPI(
    params,
    "/v1/entitlements/{customerId}"
  );
  if (!entitlements) {
    return {};
  }
  return entitlements.reduce((acc: any, e: any) => {
    acc[e.feature.slug] = e.entitled;
    return acc;
  }, {});
};

/**
 * Check if a customer is entitled to a specific feature.
 *
 * This is a convenience function for checking a single feature entitlement.
 * Returns a boolean indicating whether the customer has access to the specified feature.
 *
 * @param params - The parameters for checking feature entitlement
 * @param params.feature - The feature slug to check entitlement for
 * @param params.userId - User ID from your backend system. Required if lumenCustomerId is not provided.
 * @param params.lumenCustomerId - Lumen customer ID. Required if userId is not provided.
 * @param params.apiUrl - Optional API URL override (defaults to production)
 * @returns Promise resolving to a boolean indicating whether the customer is entitled to the feature
 *
 * @example
 * ```typescript
 * const canUseFeature = await isFeatureEntitled({
 *   userId: "user_123",
 *   feature: "premium_feature"
 * });
 *
 * if (canUseFeature) {
 *   // Allow access to premium feature
 * } else {
 *   // Show upgrade prompt
 * }
 * ```
 */
export const isFeatureEntitled = async (
  params: {
    feature: string;
    apiUrl?: string;
  } & (
    | {
        userId: string;
      }
    | {
        lumenCustomerId: string;
      }
  )
) => {
  const entitlement = await callAPI(
    params,
    "/v1/entitlements/{customerId}/feature/{feature}"
  );
  return entitlement.entitled;
};
