/**
 * @fileoverview Seat-based pricing SDK functions for managing user seats in subscriptions.
 *
 * This module provides functions to add and remove users from seat-based subscriptions,
 * as well as query current seat usage. All operations are performed using your backend
 * user IDs and are designed to be called from server-side code only.
 */

/**
 * Add a user to a seat-based subscription.
 *
 * @param params - The parameters for adding a seat
 * @param params.organisationUserId - User ID (on your backend) of the organization owner.
 *   This must match the User ID you used in the PricingTable component when the user first
 *   paid for the subscription. Used as a fallback if organizationId is not provided.
 * @param params.organizationId - Your organization/team/workspace ID (on your backend).
 *   This must match the organizationId you passed to PricingTable when the subscription
 *   was created. This is the preferred way to identify the subscription.
 * @param params.newUserId - User ID (on your backend) of the new user being added to
 *   the seat
 * @param params.metadata - Optional metadata to attach to the seat addition event
 * @param params.idempotencyKey - Optional idempotency key to prevent duplicate operations
 * @param params.timestamp - Optional UTC timestamp in ISO format ending with 'Z'
 * @param params.apiUrl - Optional API URL override (defaults to production)
 * @param params.apiKey - Optional API key override (defaults to LUMEN_API_KEY env var)
 * @returns Promise resolving to success response or error object
 */
export const addSeat = async (params: {
  organisationUserId?: string;
  organizationId?: string;
  newUserId: string;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
  timestamp?: string;
  apiUrl?: string;
  apiKey?: string;
}) => {
  try {
    const apiKey = params.apiKey ?? process.env.LUMEN_API_KEY;

    if (typeof window !== "undefined") {
      const error =
        "Error: addSeat should be called from server. You are calling it from the browser";
      console.error(error);
      return { error };
    }

    if (!apiKey) {
      const error =
        "Error: Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one";
      console.error(error);
      return { error };
    }

    // Validate that either organizationId or organisationUserId is provided
    if (!params.organizationId && !params.organisationUserId) {
      const error =
        "Either organizationId or organisationUserId must be provided";
      console.error(error);
      return { error };
    }

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";

    const response = await fetch(apiUrl + "/v1/seats/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        user_id: params.organisationUserId,
        organization_id: params.organizationId,
        created_user_id: params.newUserId,
        metadata: params.metadata,
        idempotency_key: params.idempotencyKey,
        timestamp: params.timestamp,
      }),
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      console.error("Error: Failed to add seat", response.status, errorData);
      return {
        error: errorData.error || `Failed to add seat: ${response.statusText}`,
      };
    }

    return response.json();
  } catch (error) {
    const errorMessage = "Catch error: Failed to add seat";
    console.error(errorMessage, error);
    return { error: errorMessage };
  }
};

/**
 * Remove a user from a seat-based subscription.
 *
 * @param params - The parameters for removing a seat
 * @param params.organisationUserId - User ID (on your backend) of the organization owner.
 *   This must match the User ID you used in the PricingTable component when the user first
 *   paid for the subscription. Used as a fallback if organizationId is not provided.
 * @param params.organizationId - Your organization/team/workspace ID (on your backend).
 *   This must match the organizationId you passed to PricingTable when the subscription
 *   was created. This is the preferred way to identify the subscription.
 * @param params.removedUserId - User ID (on your backend) of the user being removed from the seat
 * @param params.metadata - Optional metadata to attach to the seat removal event
 * @param params.idempotencyKey - Optional idempotency key to prevent duplicate operations
 * @param params.timestamp - Optional UTC timestamp in ISO format ending with 'Z'
 * @param params.apiUrl - Optional API URL override (defaults to production)
 * @param params.apiKey - Optional API key override (defaults to LUMEN_API_KEY env var)
 * @returns Promise resolving to success response or error object
 */
export const removeSeat = async (params: {
  organisationUserId?: string;
  organizationId?: string;
  removedUserId: string;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
  timestamp?: string;
  apiUrl?: string;
  apiKey?: string;
}) => {
  try {
    const apiKey = params.apiKey ?? process.env.LUMEN_API_KEY;

    if (typeof window !== "undefined") {
      const error =
        "Error: removeSeat should be called from server. You are calling it from the browser";
      console.error(error);
      return { error };
    }

    if (!apiKey) {
      const error =
        "Error: Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one";
      console.error(error);
      return { error };
    }

    // Validate that either organizationId or organisationUserId is provided
    if (!params.organizationId && !params.organisationUserId) {
      const error =
        "Either organizationId or organisationUserId must be provided";
      console.error(error);
      return { error };
    }

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";

    const response = await fetch(apiUrl + "/v1/seats/remove", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        user_id: params.organisationUserId,
        organization_id: params.organizationId,
        removed_user_id: params.removedUserId,
        metadata: params.metadata,
        idempotency_key: params.idempotencyKey,
        timestamp: params.timestamp,
      }),
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      console.error("Error: Failed to remove seat", response.status, errorData);
      return {
        error:
          errorData.error || `Failed to remove seat: ${response.statusText}`,
      };
    }

    return response.json();
  } catch (error) {
    const errorMessage = "Catch error: Failed to remove seat";
    console.error(errorMessage, error);
    return { error: errorMessage };
  }
};

/**
 * Get current seat usage for a customer.
 *
 * @param params - The parameters for getting seat usage
 * @param params.customerId - Lumen customer ID to get seat usage for
 * @param params.apiUrl - Optional API URL override (defaults to production)
 * @param params.apiKey - Optional API key override (defaults to LUMEN_API_KEY env var)
 * @returns Promise resolving to seat usage data or error object
 */
export const getSeatUsage = async (params: {
  customerId: string;
  apiUrl?: string;
  apiKey?: string;
}) => {
  try {
    const apiKey = params.apiKey ?? process.env.LUMEN_API_KEY;

    if (typeof window !== "undefined") {
      const error =
        "Error: getSeatUsage should be called from server. You are calling it from the browser";
      console.error(error);
      return { error };
    }

    if (!apiKey) {
      const error =
        "Error: Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one";
      console.error(error);
      return { error };
    }

    const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";

    const response = await fetch(
      apiUrl + `/v1/seats/usage/${params.customerId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      console.error(
        "Error: Failed to get seat usage",
        response.status,
        errorData
      );
      return {
        error:
          errorData.error || `Failed to get seat usage: ${response.statusText}`,
      };
    }

    return response.json();
  } catch (error) {
    const errorMessage = "Catch error: Failed to get seat usage";
    console.error(errorMessage, error);
    return { error: errorMessage };
  }
};
