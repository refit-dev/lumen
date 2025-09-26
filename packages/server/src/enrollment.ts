export interface EnrollUserParams {
  email: string;
  name: string;
  userId: string;
  planId?: string;
  billingAddressLine1?: string;
  billingAddressLine2?: string;
  billingCity?: string;
  billingPostalCode?: string;
  billingCountry?: string;
  taxId?: string;
  apiUrl?: string;
}

/**
 * Enroll a user into a plan based on Enrollment Rules, with automatic
 * fallback to the latest free plan if no rule matches. Mirrors the
 * behavior of built-in Clerk/Supabase/Better Auth webhooks.
 */
export const enrollUser = async (params: EnrollUserParams) => {
  const apiKey = process.env.LUMEN_API_KEY;
  if (typeof window !== "undefined") {
    throw new Error(
      "enrollUser should be called from server. You are calling it from the browser"
    );
  }
  if (!apiKey) {
    throw new Error(
      "Lumen API key is not set. Visit https://getlumen.dev/developer/apikeys to get one"
    );
  }

  const apiUrl = params.apiUrl ?? "https://api.getlumen.dev";

  const response = await fetch(apiUrl + "/v1/enrollment/enroll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      customerEmail: params.email,
      customerName: params.name,
      userId: params.userId,
      planId: params.planId,
      billingAddressLine1: params.billingAddressLine1,
      billingAddressLine2: params.billingAddressLine2,
      billingCity: params.billingCity,
      billingPostalCode: params.billingPostalCode,
      billingCountry: params.billingCountry,
      taxId: params.taxId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to enroll user: ${response.statusText}`);
  }

  return response.json();
};
