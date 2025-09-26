import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const currencySymbol = (currency: string): string => {
  switch (currency.toLowerCase()) {
    case "usd":
      return "$";
    case "eur":
      return "€";
    case "gbp":
      return "£";
    case "cad":
      return "C$";
    case "aud":
      return "A$";
    default:
      return currency.toUpperCase();
  }
};

export const validateEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Utility function to safely extract error message from various error types
export const getErrorMessage = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    // Handle API error responses that might have different structures
    const errorObj = error as Record<string, unknown>;

    if (typeof errorObj.error === "string") {
      return errorObj.error;
    }

    if (typeof errorObj.message === "string") {
      return errorObj.message;
    }

    if (typeof errorObj.details === "string") {
      return errorObj.details;
    }

    // If error is an object but doesn't have expected string properties, stringify it
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error occurred";
    }
  }

  return "Unknown error occurred";
};

// Sanitizes the initial customer data to prevent invalid data types from causing errors.
export const sanitizeInitialCustomer = (
  customer: unknown
): import("../src/types").InitialCustomer | undefined => {
  if (!customer || typeof customer !== "object") {
    return undefined;
  }

  const c = customer as Record<string, unknown>;
  const sanitized: import("../src/types").InitialCustomer = {};

  if (typeof c.email === "string") sanitized.email = c.email;
  if (typeof c.name === "string") sanitized.name = c.name;
  if (typeof c.businessName === "string")
    sanitized.businessName = c.businessName;
  if (typeof c.address === "string") sanitized.address = c.address;
  if (typeof c.addressLine2 === "string")
    sanitized.addressLine2 = c.addressLine2;
  if (typeof c.zip === "string") sanitized.zip = c.zip;
  if (typeof c.city === "string") sanitized.city = c.city;
  if (typeof c.country === "string") sanitized.country = c.country;
  if (typeof c.stateProvince === "string")
    sanitized.stateProvince = c.stateProvince;
  if (typeof c.taxId === "string") sanitized.taxId = c.taxId;
  if (typeof c.isBusiness === "boolean") sanitized.isBusiness = c.isBusiness;

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};
