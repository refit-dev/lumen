import {
  createCreditDefinition,
  createCreditGrant,
} from "../../../src/helpers/credits";
import {
  CreditApplicationType,
  CreditScope,
  CreditGrantSource,
  TopupExpiryBehavior,
} from "@lumen/common/schema";

/**
 * Helper function to create a test credit definition
 */
export async function createTestCreditDefinition(params: {
  merchantId: string;
  scope: CreditScope;
  applicationType: CreditApplicationType;
  name: string;
  description?: string;
  planId?: string;
  featureId?: string;
  featureSlug?: string;
  priceId?: string;
  priceComponentId?: string;
  currency?: string;
  defaultAmount: number;
  refillAmount?: number;
  expiryDays?: number;
  refillRrule?: string;
  renewOnBilling?: boolean;
  priority?: number;
  billingVisible?: boolean;
  billingDescription?: string;
  // Top-up configuration fields
  enableTopups?: boolean;
  topupPricePerCreditCents?: number;
  topupMinQuantity?: number;
  topupMaxQuantity?: number;
  topupExpiryBehavior?: TopupExpiryBehavior;
  topupCustomExpiryDays?: number;
}) {
  return await createCreditDefinition(params);
}

/**
 * Helper function to create a test credit grant
 */
export async function createTestCreditGrant(params: {
  merchantId: string;
  customerId: string;
  creditDefinitionId: string;
  initialAmount?: number;
  startDate?: Date;
  expiryDate?: Date;
  priority?: number;
  source: CreditGrantSource;
  referenceCode?: string;
  notes?: string;
}) {
  return await createCreditGrant(params);
}

/**
 * Helper function to create a usage-based credit definition for testing
 * Creates a credit definition that grants free usage for a specific feature
 */
export async function createTestUsageCreditDefinition(params: {
  merchantId: string;
  planId: string;
  featureId?: string;
  featureSlug?: string;
  priceId: string;
  priceComponentId: string;
  currency: string;
  creditAmount: number;
  refillAmount?: number;
  name: string;
  description?: string;
  expiryDays?: number;
  renewOnBilling?: boolean;
  billingVisible?: boolean;
  applicationType?: CreditApplicationType;
}) {
  return await createCreditDefinition({
    merchantId: params.merchantId,
    scope: "plan",
    applicationType: params.applicationType || "usage",
    planId: params.planId,
    featureId: params.featureId,
    featureSlug: params.featureSlug,
    priceId: params.priceId,
    priceComponentId: params.priceComponentId,
    currency: params.currency,
    name: params.name,
    description:
      params.description ||
      `Free ${params.creditAmount} ${params.featureSlug} credits`,
    defaultAmount: params.creditAmount,
    refillAmount: params.refillAmount,
    expiryDays: params.expiryDays,
    renewOnBilling: params.renewOnBilling || false,
    billingVisible: params.billingVisible || false,
    priority: 100,
  });
}

/**
 * Helper function to create a monetary credit definition for testing
 * Creates a credit definition that provides monetary credits toward a price component
 */
export async function createTestMonetaryCreditDefinition(params: {
  merchantId: string;
  planId: string;
  priceId: string;
  priceComponentId?: string; // If provided, credits only apply to this component
  creditAmountCents: number;
  currency: string;
  name: string;
  description?: string;
  expiryDays?: number;
  renewOnBilling?: boolean;
}) {
  return await createCreditDefinition({
    merchantId: params.merchantId,
    scope: "plan",
    applicationType: "monetary",
    planId: params.planId,
    priceId: params.priceId,
    priceComponentId: params.priceComponentId,
    currency: params.currency,
    name: params.name,
    description:
      params.description ||
      `$${params.creditAmountCents / 100} credit toward ${params.priceComponentId || "plan"}`,
    defaultAmount: params.creditAmountCents,
    expiryDays: params.expiryDays,
    renewOnBilling: params.renewOnBilling || false,
    billingVisible: true, // Monetary credits are visible on invoices
    billingDescription: params.description,
    priority: 100,
  });
}
