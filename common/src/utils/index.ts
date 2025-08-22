import { getCountryFromCode } from "./countries";
import { CustomerFromApi } from "../db/schema/customer";
import Dinero, { Currency } from "dinero.js";

export * from "./countries";

export function formatCurrency(amount: number, currency: string): string {
  // Ensure the amount is an integer as required by Dinero.js. If a float or
  // NaN sneaks in (e.g. from averaging), default to a rounded integer or 0.
  const safeAmount = Number.isFinite(amount) ? Math.round(amount) : 0;

  try {
    return Dinero({
      amount: safeAmount,
      currency: (currency?.toUpperCase() || "USD") as Currency,
    }).toFormat();
  } catch {
    // Fallback to USD if currency is not supported by Dinero.js or other error
    return Dinero({
      amount: safeAmount,
      currency: "USD" as Currency,
    }).toFormat();
  }
}

export const hasBillingAddress = (customer: {
  billingAddressLine1?: string | null;
  billingCity?: string | null;
  billingPostalCode?: string | null;
  billingCountry?: string | null;
}) => {
  return (
    customer.billingAddressLine1 &&
    customer.billingCity &&
    customer.billingPostalCode &&
    customer.billingCountry
  );
};

export type CustomerWithBillingAddress = {
  billingAddressLine1: string;
  billingAddressLine2?: string | null;
  billingCity: string;
  billingPostalCode: string;
  billingCountry: string;
  billingStateProvince?: string | null;
};

export const getAddress = (customer: CustomerWithBillingAddress) => {
  const addressParts: string[] = [];

  if (customer?.billingAddressLine1) {
    addressParts.push(customer.billingAddressLine1);
  }

  if (customer?.billingAddressLine2) {
    addressParts.push(customer.billingAddressLine2);
  }

  // Build city/state/postal line
  const cityStatePostal: string[] = [];
  if (customer?.billingCity) {
    cityStatePostal.push(customer.billingCity);
  }
  if (customer?.billingStateProvince) {
    cityStatePostal.push(customer.billingStateProvince);
  }
  if (customer?.billingPostalCode) {
    cityStatePostal.push(customer.billingPostalCode);
  }

  if (cityStatePostal.length > 0) {
    addressParts.push(cityStatePostal.join(", "));
  }

  const country = getCountryFromCode(customer?.billingCountry)?.label;
  if (country) {
    addressParts.push(country);
  }

  return addressParts.join("\n");
};

export type MerchantWithAddress = {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  stateProvince?: string | null;
  postalCode: string;
  country: string;
};

export const getAddressMerchant = (merchant: MerchantWithAddress) => {
  const addressParts: string[] = [];

  if (merchant?.addressLine1) {
    addressParts.push(merchant.addressLine1);
  }

  if (merchant?.addressLine2) {
    addressParts.push(merchant.addressLine2);
  }

  // Build city/state/postal line
  const cityStatePostal: string[] = [];
  if (merchant?.city) {
    cityStatePostal.push(merchant.city);
  }
  if (merchant?.stateProvince) {
    cityStatePostal.push(merchant.stateProvince);
  }
  if (merchant?.postalCode) {
    cityStatePostal.push(merchant.postalCode);
  }

  if (cityStatePostal.length > 0) {
    addressParts.push(cityStatePostal.join(", "));
  }

  const country = getCountryFromCode(merchant?.country)?.label;
  if (country) {
    addressParts.push(country);
  }

  return addressParts.join("\n");
};

export const getInvoicePrefix = (customer: CustomerFromApi) => {
  if (customer.invoicePrefix) {
    return customer.invoicePrefix;
  }
  // remove "cus_" and take the first 8 characters
  return customer.id.slice(4, 12).toUpperCase();
};
