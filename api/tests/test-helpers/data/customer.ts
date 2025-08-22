/**
 * Customer helper functions for tests
 */
import { db } from "../../../src/db/client";
import { customers } from "@lumen/common/schema";
import { Customer } from "../types";

interface CreateTestCustomerParams {
  merchantId: string;
  email: string;
  name: string;
  businessName?: string;
  phoneNumber?: string;
  pspCustomerId?: string;
  externalCustomerId?: string;
  billingAddressLine1?: string;
  billingAddressLine2?: string;
  billingCity?: string;
  billingStateProvince?: string;
  billingPostalCode?: string;
  billingCountry?: string;
  taxId?: string;
  taxExempt?: boolean;
  taxExemptionCertificate?: string;
  invoicePrefix?: string;
  preferredLanguage?: string;
  timezone?: string;
  preferredCurrency?: string;
  metadata?: Record<string, unknown>;
}

export async function createTestCustomer({
  merchantId,
  email,
  name,
  businessName,
  phoneNumber,
  pspCustomerId,
  externalCustomerId,
  billingAddressLine1,
  billingAddressLine2,
  billingCity,
  billingStateProvince,
  billingPostalCode,
  billingCountry,
  taxId,
  taxExempt,
  taxExemptionCertificate,
  invoicePrefix,
  preferredLanguage,
  timezone,
  preferredCurrency,
  metadata,
}: CreateTestCustomerParams): Promise<Customer> {
  const [customer] = await db
    .insert(customers)
    .values({
      merchantId,
      email,
      name,
      businessName: businessName ?? "Test Business",
      phoneNumber,
      pspCustomerId,
      externalCustomerId,
      billingAddressLine1,
      billingAddressLine2,
      billingCity,
      billingStateProvince,
      billingPostalCode,
      billingCountry,
      taxId,
      taxExempt,
      taxExemptionCertificate,
      invoicePrefix,
      preferredLanguage,
      timezone,
      preferredCurrency,
      metadata,
    })
    .returning();

  return customer;
}
