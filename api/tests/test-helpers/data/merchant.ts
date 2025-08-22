/**
 * Merchant helper functions for tests
 */
import { db } from "../../../src/db/client";
import { merchants } from "@lumen/common/schema";
import { MerchantUpdate, MerchantInsert } from "../types";

/**
 * Creates a test merchant directly in the database
 */
export async function createTestMerchant({
  id,
  organizationId,
  userId,
  legalName = "Test Merchant Inc",
  displayName = "Test Merchant",
  defaultCurrency = "USD",
  supportedCurrencies = ["USD", "EUR"],
  timezone = "UTC",
  defaultPaymentTerms = "30",
  defaultPaymentMethods = ["card"],
  supportEmail = "support@testmerchant.com",
  billingEmail = "billing@testmerchant.com",
  stateProvince = "CA", // Default to California for US test merchants
  country = "US",
}: MerchantUpdate & { organizationId: string; userId: string }) {
  // Create merchant data
  const merchantData: MerchantInsert = {
    addressLine1: "123 Main St",
    city: "Anytown",
    stateProvince,
    postalCode: "12345",
    country,
    organizationId,
    userId,
    legalName,
    displayName,
    defaultCurrency,
    supportedCurrencies,
    timezone,
    defaultPaymentTerms,
    defaultPaymentMethods,
    supportEmail,
    billingEmail,
  };

  if (id) {
    merchantData.id = id;
  }

  // Insert merchant record directly
  const [merchant] = await db
    .insert(merchants)
    .values(merchantData)
    .returning();

  return merchant;
}
