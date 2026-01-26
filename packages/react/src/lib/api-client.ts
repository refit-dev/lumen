/**
 * API client for making requests through the Lumen proxy handler
 *
 * This client handles all communication with your backend's Lumen proxy,
 * which securely forwards requests to the Lumen API.
 */

import type {
  LumenConfig,
  AvailableTopupsResponse,
  TopupPurchaseResult,
} from "../types";

export class LumenAPIError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: any
  ) {
    super(message);
    this.name = "LumenAPIError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: any;
  signal?: AbortSignal;
}

export class LumenAPIClient {
  private config: Required<LumenConfig>;

  constructor(config: LumenConfig) {
    this.config = {
      apiProxyUrl: config.apiProxyUrl,
      disableRetry: config.disableRetry ?? false,
      retryCount: config.retryCount ?? 2,
      retryDelay: config.retryDelay ?? 1000,
    };
  }

  /**
   * Make a request through the Lumen proxy handler
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, signal } = options;

    const url = `${this.config.apiProxyUrl}/${path}`;

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      signal,
    };

    if (body && method !== "GET") {
      fetchOptions.body = JSON.stringify(body);
    }

    let lastError: Error | null = null;
    const maxAttempts = this.config.disableRetry
      ? 1
      : this.config.retryCount + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new LumenAPIError(
            errorData.error || `Request failed: ${response.statusText}`,
            response.status,
            errorData
          );
        }

        return await response.json();
      } catch (error) {
        lastError = error as Error;

        // Don't retry on abort
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }

        // Don't retry on client errors (4xx)
        if (
          error instanceof LumenAPIError &&
          error.status &&
          error.status < 500
        ) {
          throw error;
        }

        // Retry on network errors or 5xx errors
        if (attempt < maxAttempts - 1) {
          await this.delay(this.config.retryDelay * (attempt + 1));
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error("Request failed");
  }

  /**
   * Get subscription status for a user
   */
  async getSubscriptionStatus(userId: string, signal?: AbortSignal) {
    return this.request<any>(
      `customers/subscription-status?externalCustomerId=${encodeURIComponent(userId)}`,
      { signal }
    );
  }

  /**
   * Get all entitlements for a user
   */
  async getEntitlements(userId: string, signal?: AbortSignal) {
    return this.request<any>(
      `entitlements/${encodeURIComponent(userId)}?isExtCustId=true`,
      { signal }
    );
  }

  /**
   * Get customer portal overview
   */
  async getCustomerOverview(userId: string, signal?: AbortSignal) {
    return this.request<any>(
      `customers/portal/overview?externalCustomerId=${encodeURIComponent(userId)}`,
      { signal }
    );
  }

  /**
   * Get invoice PDF URL
   */
  async getInvoicePdf(invoiceId: string, signal?: AbortSignal) {
    return this.request<any>(`invoices/${encodeURIComponent(invoiceId)}/pdf`, {
      signal,
    });
  }

  /**
   * Create a setup intent for adding payment method
   */
  async createSetupIntent(userId: string, signal?: AbortSignal) {
    return this.request<any>(`customers/portal/create-setup-intent`, {
      method: "POST",
      body: { externalCustomerId: userId },
      signal,
    });
  }

  /**
   * Set subscription payment method
   */
  async setSubscriptionPaymentMethod(
    userId: string,
    paymentMethodId: string,
    signal?: AbortSignal
  ) {
    return this.request<any>(
      `customers/portal/set-subscription-payment-method`,
      {
        method: "POST",
        body: {
          externalCustomerId: userId,
          paymentMethodId,
        },
        signal,
      }
    );
  }

  /**
   * Delete a payment method
   */
  async deletePaymentMethod(
    userId: string,
    paymentMethodId: string,
    signal?: AbortSignal
  ) {
    return this.request<any>(
      `customers/portal/payment-methods/${encodeURIComponent(paymentMethodId)}`,
      {
        method: "DELETE",
        body: { externalCustomerId: userId },
        signal,
      }
    );
  }

  /**
   * Get available credit top-ups for a user
   */
  async getAvailableTopups(
    userId: string,
    signal?: AbortSignal
  ): Promise<AvailableTopupsResponse> {
    return this.request<AvailableTopupsResponse>(
      `credits/available-topups?externalCustomerId=${encodeURIComponent(userId)}`,
      { signal }
    );
  }

  /**
   * Purchase credit top-up
   */
  async purchaseTopup(
    userId: string,
    creditDefinitionId: string,
    quantity: number,
    signal?: AbortSignal
  ): Promise<TopupPurchaseResult> {
    return this.request<TopupPurchaseResult>("credits/topup", {
      method: "POST",
      body: {
        externalCustomerId: userId,
        creditDefinitionId,
        quantity,
      },
      signal,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Default API client instance
 * This will be configured by the LumenProvider
 */
let defaultClient: LumenAPIClient | null = null;

export function setDefaultClient(client: LumenAPIClient) {
  defaultClient = client;
}

export function getDefaultClient(): LumenAPIClient {
  if (!defaultClient) {
    throw new Error(
      "Lumen API client not configured. Please wrap your app with <LumenProvider>"
    );
  }
  return defaultClient;
}
