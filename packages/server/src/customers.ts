export const getSubscriptionStatus = async (params: {
  userId: string;
  apiUrl?: string;
  apiKey?: string;
}) => {
  try {
    const apiKey = params.apiKey ?? process.env.LUMEN_API_KEY;
    if (typeof window !== "undefined") {
      return {
        error:
          "Error: getSubscriptionStatus should be called from server. You are calling it from the browser",
      };
    }
    if (!apiKey) {
      return {
        error:
          "Error: Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one",
      };
    }

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";
    const url =
      apiUrl +
      `/v1/customers/subscription-status?externalCustomerId=${encodeURIComponent(
        params.userId
      )}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      return {
        error:
          errorData.error ||
          `Failed to fetch subscription status: ${response.statusText}`,
      };
    }

    return response.json();
  } catch (error) {
    return { error: "Catch error: Failed to fetch subscription status" };
  }
};

export const getCustomerOverview = async (params: {
  userId: string;
  apiUrl?: string;
  apiKey?: string;
}) => {
  try {
    const apiKey = params.apiKey ?? process.env.LUMEN_API_KEY;
    if (typeof window !== "undefined") {
      return {
        error:
          "Error: getCustomerOverview should be called from server. You are calling it from the browser",
      };
    }
    if (!apiKey) {
      return {
        error:
          "Error: Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one",
      };
    }

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";
    const url =
      apiUrl +
      `/v1/customers/portal/overview?externalCustomerId=${encodeURIComponent(
        params.userId
      )}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      return {
        error:
          errorData.error ||
          `Failed to fetch customer overview: ${response.statusText}`,
      };
    }

    return response.json();
  } catch (error) {
    return { error: "Catch error: Failed to fetch customer overview" };
  }
};

export const getSeatUsageByUser = async (params: {
  userId: string;
  apiUrl?: string;
  apiKey?: string;
}) => {
  try {
    const apiKey = params.apiKey ?? process.env.LUMEN_API_KEY;
    if (typeof window !== "undefined") {
      return {
        error:
          "Error: getSeatUsageByUser should be called from server. You are calling it from the browser",
      };
    }
    if (!apiKey) {
      return {
        error:
          "Error: Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one",
      };
    }

    const status = await getSubscriptionStatus({
      userId: params.userId,
      apiUrl: params.apiUrl,
      apiKey: apiKey,
    });

    if ((status as any).error) {
      return status;
    }

    const customerId = (status as any)?.customer?.id;
    const hasActive = (status as any)?.hasActiveSubscription === true;
    if (!customerId) {
      return { error: "Customer not found" };
    }
    if (!hasActive) {
      return { error: "No active subscription" };
    }

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";
    const url = apiUrl + `/v1/seats/usage/${encodeURIComponent(customerId)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      return {
        error:
          errorData.error ||
          `Failed to fetch seat usage: ${response.statusText}`,
      };
    }

    return response.json();
  } catch (error) {
    return { error: "Catch error: Failed to fetch seat usage by user" };
  }
};
