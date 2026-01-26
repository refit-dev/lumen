import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import Dinero, { Currency } from "dinero.js";
import { apiClient } from "./hono-client";

export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "1x00000000000000000000AA";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format monetary amount in cents to currency string using Dinero.js
 * @param amountInCents - Amount in smallest currency unit (cents)
 * @param currency - Currency code (USD, EUR, etc.)
 * @returns Formatted currency string (e.g., "$25.00", "€25,00")
 */
export function formatCurrency(
  amountInCents: number,
  currency: string = "USD"
): string {
  // Dinero.js expects the amount to be an integer representing the smallest
  // currency unit (e.g. cents). Ensure we always pass a safe integer here to
  // avoid runtime errors when a float or NaN slips through business logic.
  const safeAmount = Number.isFinite(amountInCents)
    ? Math.round(amountInCents)
    : 0;

  try {
    return Dinero({
      amount: safeAmount,
      currency: currency as Currency,
    }).toFormat();
  } catch {
    // Fallback to USD if the provided currency is not supported by Dinero.js
    return Dinero({
      amount: safeAmount,
      currency: "USD",
    }).toFormat();
  }
}

/**
 * Parse currency input string to cents with validation
 * @param input - User input string (e.g., "25.99", "25,99")
 * @returns Object with amount in cents and validation info
 */
export function parseCurrencyToCents(input: string): {
  amount: number;
  isValid: boolean;
  error?: string;
} {
  // Handle empty input
  if (!input || input.trim() === "") {
    return { amount: 0, isValid: true };
  }

  // Remove any whitespace
  const trimmedInput = input.trim();

  // Check for invalid characters (allow digits, one decimal separator, and common currency symbols)
  const validCharPattern = /^[\d.,€$£¥₹]+$/;
  if (!validCharPattern.test(trimmedInput)) {
    return {
      amount: 0,
      isValid: false,
      error: "Contains invalid characters",
    };
  }

  // Remove currency symbols
  const withoutSymbols = trimmedInput.replace(/[€$£¥₹]/g, "");

  // Check for multiple decimal separators
  const decimalCount = (withoutSymbols.match(/[.,]/g) || []).length;
  if (decimalCount > 1) {
    return {
      amount: 0,
      isValid: false,
      error: "Multiple decimal separators",
    };
  }

  // Handle different decimal separators (. or ,)
  const normalizedInput = withoutSymbols.replace(",", ".");

  // Validate decimal places (max 2 for currency)
  const decimalParts = normalizedInput.split(".");
  if (decimalParts.length === 2 && decimalParts[1].length > 2) {
    return {
      amount: 0,
      isValid: false,
      error: "Maximum 2 decimal places allowed",
    };
  }

  const parsed = parseFloat(normalizedInput);

  if (isNaN(parsed)) {
    return {
      amount: 0,
      isValid: false,
      error: "Invalid number format",
    };
  }

  // Check for reasonable limits (0 to 1 million)
  if (parsed < 0) {
    return {
      amount: 0,
      isValid: false,
      error: "Amount cannot be negative",
    };
  }

  if (parsed > 1000000) {
    return {
      amount: 0,
      isValid: false,
      error: "Amount too large (max 1,000,000)",
    };
  }

  // Convert to cents and round to handle floating point precision
  const cents = Math.round(parsed * 100);

  return { amount: cents, isValid: true };
}

/**
 * Legacy function for backward compatibility
 * @param input - User input string
 * @returns Amount in cents (0 if invalid)
 */
export function parseCurrencyToCentsLegacy(input: string): number {
  const result = parseCurrencyToCents(input);
  return result.amount;
}

/**
 * Get currency symbol for display in input fields
 * @param currency - Currency code
 * @returns Currency symbol
 */
export function getCurrencySymbol(currency: string): string {
  const symbols: Record<string, string> = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    CAD: "C$",
    AUD: "A$",
    JPY: "¥",
  };

  return symbols[currency] || "$";
}

/**
 * Check if Stripe configuration is in test mode by calling the API
 * @returns Promise<boolean> - true if Stripe/Dodo keys are in test mode, false otherwise
 */
export async function checkTestMode(): Promise<boolean> {
  try {
    const [stripeResponse, dodoResponse] = await Promise.all([
      apiClient.stripe.config.$get(),
      apiClient.dodo.config.$get(),
    ]);

    const stripeData = await stripeResponse.json();
    const dodoData = await dodoResponse.json();

    let isStripeTest = false;
    let isDodoTest = false;

    if (!("error" in stripeData)) {
      const { publicKey, secretKey } = stripeData;
      const isPublicKeyTest = !!(publicKey && publicKey.startsWith("pk_test_"));
      const isSecretKeyTest = !!(secretKey && secretKey.startsWith("sk_test_"));
      isStripeTest = isPublicKeyTest || isSecretKeyTest;
    }

    if (!("error" in dodoData)) {
      isDodoTest = dodoData.environment === "test";
    }

    return isStripeTest || isDodoTest;
  } catch (error) {
    console.error("Failed to check test mode:", error);
    return false;
  }
}

/**
 * Generate a random user ID for testing purposes
 * @returns Random user ID string
 */
export function generateRandomUserId(): string {
  return `test_user_${Math.random().toString(36).substr(2, 9)}`;
}
