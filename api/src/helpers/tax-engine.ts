import { db } from "../db/client";
import {
  merchants,
  customers,
  merchantTaxConfig,
  taxRegistrations,
  usNexusConfig,
  taxRateDefinitions,
} from "@lumen/common/schema";
import { eq, and, isNull } from "drizzle-orm";
import {
  taxMatrix,
  taxReasonCodes,
  euVatTaxMatrix,
  UK_VAT_RATE,
  SWITZERLAND_VAT_RATE,
  CANADA_GST_RATE,
  getCanadaGstRate,
  getCanadaPstRate,
  formatTaxDescription,
  formatZeroTaxDescription,
  formatSpecificTaxDescription,
  getTaxReasonInfo,
} from "./tax-rates";
import { getSecret } from "./secrets";
import { env } from "../env";

// Core interfaces for tax calculation
export interface TaxCalculationContext {
  merchantId: string;
  customerId: string;
  subtotalAfterCredits: number;
  lineItems: TaxableLineItem[];
  currency: string;
  billingDate: Date;
}

export interface TaxableLineItem {
  type: string;
  description: string;
  subtotalCents: number;
  componentId?: string;
  priceId?: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
}

export interface TaxCalculationResult {
  taxableAmount: number;
  totalTaxCents: number;
  effectiveTaxRate: number;
  taxLineItems: TaxLineItem[];
  jurisdiction: string;
  calculationMethod: "auto" | "manual" | "exempt";
  taxBreakdown: {
    federalTax?: number;
    stateTax?: number;
    vatTax?: number;
    gstTax?: number;
  };
  exemptionReason?: string;
}

export interface TaxLineItem {
  type: "tax";
  description: string;
  subtotalCents: number;
  taxMetadata: {
    taxAuthority?: string;
    taxType?: string;
    jurisdiction?: string;
    taxRate?: number;
    rateSource?: string;
    exemptionReason?: string;
    reasonCode?: number;
    fullDescription?: string;
  };
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
}

interface MerchantTaxData {
  merchant: typeof merchants.$inferSelect;
  taxConfig: typeof merchantTaxConfig.$inferSelect | null;
  taxRegistrations: (typeof taxRegistrations.$inferSelect)[];
  nexusConfigs: (typeof usNexusConfig.$inferSelect)[];
  taxRateDefinitions: (typeof taxRateDefinitions.$inferSelect)[];
}

interface CustomerTaxData {
  customer: typeof customers.$inferSelect;
}

/**
 * Main tax calculation function
 * Determines applicable taxes based on merchant/customer locations and configuration
 */
export async function calculateTaxes(
  context: TaxCalculationContext
): Promise<TaxCalculationResult> {
  console.log(`[calculateTaxes] Starting tax calculation`, {
    merchantId: context.merchantId,
    customerId: context.customerId,
    subtotalAfterCredits: context.subtotalAfterCredits,
    currency: context.currency,
  });

  try {
    // 1. Fetch merchant and customer data with tax configuration
    const [merchantData, customerData] = await Promise.all([
      getMerchantWithTaxConfig(context.merchantId),
      getCustomerWithTaxInfo(context.customerId),
    ]);

    if (!merchantData.merchant || !customerData.customer) {
      throw new Error("Merchant or customer not found");
    }

    // 2. Check for tax exemptions first
    if (customerData.customer.taxExempt) {
      console.log(`[calculateTaxes] Customer is tax exempt`, {
        customerId: context.customerId,
        exemptionReason: customerData.customer.taxExemptionReason,
      });

      return createExemptTaxResult(
        context.subtotalAfterCredits,
        customerData.customer.taxExemptionReason || "customer_exempt",
        context.lineItems[0]?.billingPeriodStart || context.billingDate,
        context.lineItems[0]?.billingPeriodEnd || context.billingDate
      );
    }

    // 3. B2C guard: if customer lacks business identifiers, return 0 tax (no tax line item)
    const isBusinessCustomer = Boolean(
      customerData.customer.taxId || customerData.customer.businessName
    );
    if (!isBusinessCustomer) {
      return {
        taxableAmount: context.subtotalAfterCredits,
        totalTaxCents: 0,
        effectiveTaxRate: 0,
        taxLineItems: [], // No tax line items for B2C
        jurisdiction: "",
        calculationMethod: "auto",
        taxBreakdown: {},
      };
    }

    // 4. Determine tax jurisdiction and applicable rates
    const jurisdiction = await determineJurisdiction(
      merchantData,
      customerData
    );

    // 5. Determine tax calculation method (customer override > merchant default)
    let useAutoCalculation =
      merchantData.taxConfig?.autoTaxCalculation || false;

    // Check for customer-specific tax calculation method override
    if (customerData.customer.taxCalculationMethod) {
      console.log(`[calculateTaxes] Customer has tax calculation override`, {
        customerId: context.customerId,
        override: customerData.customer.taxCalculationMethod,
      });
      useAutoCalculation =
        customerData.customer.taxCalculationMethod === "auto";
    }

    // 6. Calculate taxes based on determined method
    let result: TaxCalculationResult;
    if (useAutoCalculation) {
      console.log(`[calculateTaxes] Using automatic tax calculation`);
      result = await calculateAutoTax(
        context,
        jurisdiction,
        merchantData,
        customerData
      );
    } else {
      console.log(`[calculateTaxes] Using manual tax calculation`);
      result = await calculateManualTax(
        context,
        jurisdiction,
        merchantData,
        customerData
      );
    }

    console.log(`[calculateTaxes] Tax calculation completed:`, {
      calculationMethod: result.calculationMethod,
      totalTaxCents: result.totalTaxCents,
      effectiveTaxRate: result.effectiveTaxRate,
      jurisdiction: result.jurisdiction,
      taxLineItemsCount: result.taxLineItems.length,
      taxLineItems: result.taxLineItems.map((item) => ({
        type: item.type,
        description: item.description,
        subtotalCents: item.subtotalCents,
        taxMetadata: {
          taxType: item.taxMetadata.taxType,
          reasonCode: item.taxMetadata.reasonCode,
          fullDescription: item.taxMetadata.fullDescription,
        },
      })),
    });

    return result;
  } catch (error) {
    console.error(`[calculateTaxes] Error calculating taxes`, {
      error: error instanceof Error ? error.message : String(error),
      merchantId: context.merchantId,
      customerId: context.customerId,
    });

    // Fallback to no tax on error to avoid blocking billing
    return createExemptTaxResult(
      context.subtotalAfterCredits,
      "calculation_error",
      context.lineItems[0]?.billingPeriodStart || context.billingDate,
      context.lineItems[0]?.billingPeriodEnd || context.billingDate
    );
  }
}

/**
 * Calculate taxes for payment flow with minimal customer data
 * This is used during payment-init to determine tax amounts before subscription creation
 */
export async function calculateTaxesForPaymentFlow({
  merchantId,
  subtotalCents,
  currency,
  billingDate,
  customerCountry,
  customerStateProvince,
  taxId,
  businessName,
}: {
  merchantId: string;
  subtotalCents: number;
  currency: string;
  billingDate: Date;
  customerCountry?: string;
  customerStateProvince?: string;
  taxId?: string;
  businessName?: string;
}): Promise<TaxCalculationResult> {
  console.log(`[calculateTaxesForPaymentFlow] Starting tax calculation`, {
    merchantId,
    subtotalCents,
    currency,
    customerCountry,
    customerStateProvince,
    taxId,
    businessName,
  });

  try {
    // 1. Fetch merchant data with tax configuration
    const merchantData = await getMerchantWithTaxConfig(merchantId);

    if (!merchantData.merchant) {
      throw new Error("Merchant not found");
    }

    // 2. Check if merchant has auto tax calculation enabled
    const useAutoCalculation =
      merchantData.taxConfig?.autoTaxCalculation || false;

    if (!useAutoCalculation) {
      // For manual tax, we need to use default rate since we don't have customer-specific rates yet
      const defaultTaxRate = merchantData.taxConfig?.defaultTaxRate
        ? parseFloat(merchantData.taxConfig.defaultTaxRate)
        : 0;

      if (defaultTaxRate === 0) {
        return createZeroTaxResult(
          subtotalCents,
          "payment_flow",
          "no_manual_rate_configured",
          "manual",
          billingDate,
          billingDate
        );
      }

      const taxAmount = Math.round(subtotalCents * defaultTaxRate);

      const reasonCode = 14; // manual_tax_rate
      const reasonInfo = getTaxReasonInfo(reasonCode);

      return {
        taxableAmount: subtotalCents,
        totalTaxCents: taxAmount,
        effectiveTaxRate: defaultTaxRate,
        taxLineItems:
          taxAmount > 0
            ? [
                {
                  type: "tax",
                  description: formatTaxDescription(defaultTaxRate, reasonCode),
                  subtotalCents: taxAmount,
                  taxMetadata: {
                    taxType: "manual",
                    taxRate: defaultTaxRate,
                    jurisdiction: "payment_flow",
                    rateSource: "default",
                    reasonCode,
                    fullDescription: reasonInfo.full_description,
                  },
                  billingPeriodStart: billingDate,
                  billingPeriodEnd: billingDate,
                },
              ]
            : [],
        jurisdiction: "payment_flow",
        calculationMethod: "manual",
        taxBreakdown: {},
      };
    }

    // 3. B2C guard for payment flow: if no business identifiers, return 0 tax (no tax line item)
    const isBusinessCustomer = Boolean(taxId || businessName);
    if (!isBusinessCustomer) {
      return {
        taxableAmount: subtotalCents,
        totalTaxCents: 0,
        effectiveTaxRate: 0,
        taxLineItems: [], // No tax line items for B2C
        jurisdiction: "payment_flow",
        calculationMethod: "auto",
        taxBreakdown: {},
      };
    }

    // 4. For auto calculation, proceed with jurisdiction-based calculation
    if (!customerCountry) {
      return createZeroTaxResult(
        subtotalCents,
        "payment_flow",
        "no_customer_country",
        "auto",
        billingDate,
        billingDate
      );
    }

    // Create a temporary customer data structure for tax calculation
    const tempCustomerData: CustomerTaxData = {
      customer: {
        id: "temp_payment_flow",
        merchantId,
        name: businessName || null,
        email: null,
        phoneNumber: null,
        timezone: null,
        invoicePrefix: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        pspCustomerId: null,
        externalCustomerId: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingCity: null,
        billingPostalCode: null,
        billingCountry: customerCountry,
        billingStateProvince: customerStateProvince ?? null,
        businessName: businessName || null,
        taxId: taxId || null,
        taxExempt: false,
        taxExemptionReason: null,
        taxExemptionCertificate: null,
        taxCalculationMethod: null,
        taxRateDefinitionId: null,
        preferredLanguage: null,
        preferredCurrency: null,
        metadata: null,
      },
    };

    // Determine jurisdiction
    const jurisdiction = await determineJurisdiction(
      merchantData,
      tempCustomerData
    );

    // Calculate taxes based on merchant and customer locations
    const merchantCountry = merchantData.merchant.country;
    const taxCalculationResult = await calculateAutoTaxForPaymentFlow(
      subtotalCents,
      currency,
      billingDate,
      jurisdiction,
      merchantData,
      tempCustomerData
    );

    console.log(`[calculateTaxesForPaymentFlow] Tax calculation completed`, {
      taxableAmount: taxCalculationResult.taxableAmount,
      totalTaxCents: taxCalculationResult.totalTaxCents,
      effectiveTaxRate: taxCalculationResult.effectiveTaxRate,
      jurisdiction: taxCalculationResult.jurisdiction,
    });

    return taxCalculationResult;
  } catch (error) {
    console.error(`[calculateTaxesForPaymentFlow] Error calculating taxes`, {
      error: error instanceof Error ? error.message : String(error),
      merchantId,
      customerCountry,
    });

    // Fallback to no tax on error to avoid blocking payment
    return createZeroTaxResult(
      subtotalCents,
      "payment_flow",
      "calculation_error",
      "auto",
      billingDate,
      billingDate
    );
  }
}

/**
 * Fetch merchant data with tax configuration
 */
async function getMerchantWithTaxConfig(
  merchantId: string
): Promise<MerchantTaxData> {
  const merchant = await db.query.merchants.findFirst({
    where: eq(merchants.id, merchantId),
  });

  if (!merchant) {
    throw new Error(`Merchant not found: ${merchantId}`);
  }

  // Fetch tax configuration (optional)
  const taxConfig = await db.query.merchantTaxConfig.findFirst({
    where: eq(merchantTaxConfig.merchantId, merchantId),
  });

  // Fetch tax registrations
  const merchantTaxRegistrations = await db.query.taxRegistrations.findMany({
    where: and(
      eq(taxRegistrations.merchantId, merchantId),
      eq(taxRegistrations.isActive, true)
    ),
  });

  // Fetch US nexus configurations
  const nexusConfigs = await db.query.usNexusConfig.findMany({
    where: eq(usNexusConfig.merchantId, merchantId),
  });

  // Fetch tax rate definitions
  const merchantTaxRateDefinitions = await db.query.taxRateDefinitions.findMany(
    {
      where: and(
        eq(taxRateDefinitions.merchantId, merchantId),
        eq(taxRateDefinitions.isActive, true)
      ),
    }
  );

  return {
    merchant,
    taxConfig: taxConfig || null,
    taxRegistrations: merchantTaxRegistrations,
    nexusConfigs,
    taxRateDefinitions: merchantTaxRateDefinitions,
  };
}

/**
 * Fetch customer data with tax information
 */
async function getCustomerWithTaxInfo(
  customerId: string
): Promise<CustomerTaxData> {
  const customer = await db.query.customers.findFirst({
    where: and(eq(customers.id, customerId), isNull(customers.deletedAt)),
  });

  if (!customer) {
    throw new Error(`Customer not found: ${customerId}`);
  }

  return { customer };
}

/**
 * Determine tax jurisdiction based on merchant and customer locations
 */
async function determineJurisdiction(
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): Promise<string> {
  const merchantCountry = merchantData.merchant.country;
  const customerCountry = customerData.customer.billingCountry;

  // For US-based merchants, include state information
  if (merchantCountry === "US" && customerCountry === "US") {
    const merchantState = merchantData.merchant.stateProvince;
    const customerState = customerData.customer.billingStateProvince;

    if (merchantState && customerState) {
      return `${customerCountry}-${customerState}`;
    }
  }

  // For EU countries, use country code for VAT jurisdiction
  if (isEuCountry(customerCountry || "")) {
    return customerCountry || "";
  }

  return customerCountry || "";
}

/**
 * Calculate taxes automatically based on jurisdiction rules
 */
async function calculateAutoTax(
  context: TaxCalculationContext,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): Promise<TaxCalculationResult> {
  const merchantCountry = merchantData.merchant.country;
  const customerCountry = customerData.customer.billingCountry;

  // US tax calculation
  if (merchantCountry === "US" && customerCountry === "US") {
    return await calculateUsTax(
      context,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // EU VAT calculation
  if (isEuCountry(merchantCountry) && isEuCountry(customerCountry || "")) {
    return await calculateEuVat(
      context,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // UK VAT calculation (post-Brexit domestic)
  if (merchantCountry === "GB" && customerCountry === "GB") {
    return calculateUkVat(context, jurisdiction, merchantData, customerData);
  }

  // Canada GST/HST calculation
  if (merchantCountry === "CA" && customerCountry === "CA") {
    return calculateCanadaGst(
      context,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // Switzerland VAT calculation
  if (merchantCountry === "CH" && customerCountry === "CH") {
    return calculateSwitzerlandVat(
      context,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // Cross-border calculation using tax matrix
  return calculateCrossBorderTax(
    context,
    jurisdiction,
    merchantCountry,
    customerCountry || ""
  );
}

/**
 * Calculate taxes automatically for payment flow (simplified version of calculateAutoTax)
 */
async function calculateAutoTaxForPaymentFlow(
  subtotalCents: number,
  currency: string,
  billingDate: Date,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): Promise<TaxCalculationResult> {
  const merchantCountry = merchantData.merchant.country;
  const customerCountry = customerData.customer.billingCountry;

  // US tax calculation
  if (merchantCountry === "US" && customerCountry === "US") {
    return await calculateUsTaxForPaymentFlow(
      subtotalCents,
      billingDate,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // EU VAT calculation
  if (isEuCountry(merchantCountry) && isEuCountry(customerCountry || "")) {
    return calculateEuVatForPaymentFlow(
      subtotalCents,
      billingDate,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // UK VAT calculation (post-Brexit domestic)
  if (merchantCountry === "GB" && customerCountry === "GB") {
    return calculateUkVatForPaymentFlow(
      subtotalCents,
      billingDate,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // Canada GST/HST calculation
  if (merchantCountry === "CA" && customerCountry === "CA") {
    return calculateCanadaGstForPaymentFlow(
      subtotalCents,
      billingDate,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // Switzerland VAT calculation
  if (merchantCountry === "CH" && customerCountry === "CH") {
    return calculateSwitzerlandVatForPaymentFlow(
      subtotalCents,
      billingDate,
      jurisdiction,
      merchantData,
      customerData
    );
  }

  // Cross-border calculation using tax matrix
  return calculateCrossBorderTaxForPaymentFlow(
    subtotalCents,
    billingDate,
    jurisdiction,
    merchantCountry,
    customerCountry || ""
  );
}

/**
 * Calculate US state sales tax
 */
async function calculateUsTax(
  context: TaxCalculationContext,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): Promise<TaxCalculationResult> {
  const merchantState = merchantData.merchant.stateProvince;
  const customerState = customerData.customer.billingStateProvince;

  if (!merchantState || !customerState) {
    console.log(`[calculateUsTax] Missing state info`, {
      merchantState,
      customerState,
    });
    return createZeroTaxResult(
      context.subtotalAfterCredits,
      "US",
      "missing_state_info",
      "auto",
      context.lineItems[0]?.billingPeriodStart || context.billingDate,
      context.lineItems[0]?.billingPeriodEnd || context.billingDate
    );
  }

  // Check if cross-state sale requires nexus
  if (merchantState !== customerState) {
    console.log(`[calculateUsTax] Cross-state sale requires nexus`, {
      merchantState,
      customerState,
    });
    const nexusConfig = merchantData.nexusConfigs.find(
      (config) => config.state === customerState
    );

    if (!nexusConfig?.hasNexus) {
      return createZeroTaxResult(
        context.subtotalAfterCredits,
        jurisdiction,
        "no_nexus",
        "auto",
        context.lineItems[0]?.billingPeriodStart || context.billingDate,
        context.lineItems[0]?.billingPeriodEnd || context.billingDate
      );
    }
  }

  const stateTaxRate = await getUsStateTaxRate(customerData.customer);
  const taxAmount = Math.round(context.subtotalAfterCredits * stateTaxRate);

  const reasonCode = 7; // us_sales_tax
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: context.subtotalAfterCredits,
    totalTaxCents: taxAmount,
    effectiveTaxRate: stateTaxRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatSpecificTaxDescription(
                stateTaxRate,
                reasonCode,
                undefined,
                customerState
              ),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxAuthority: `US-${customerState}`,
                taxType: "sales_tax",
                jurisdiction,
                taxRate: stateTaxRate,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart:
                context.lineItems[0]?.billingPeriodStart || context.billingDate,
              billingPeriodEnd:
                context.lineItems[0]?.billingPeriodEnd || context.billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: {
      stateTax: taxAmount,
    },
  };
}

/**
 * Calculate EU VAT
 */
async function calculateEuVat(
  context: TaxCalculationContext,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): Promise<TaxCalculationResult> {
  const merchantCountry = merchantData.merchant.country;
  const customerCountry = customerData.customer.billingCountry;
  const customerVatId = customerData.customer.taxId;

  // B2B reverse charge scenario
  if (merchantCountry !== customerCountry && customerVatId) {
    console.log(`[calculateEuVat] B2B reverse charge applies`, {
      merchantCountry,
      customerCountry,
      customerVatId,
    });

    const reasonCode = 1; // reverse_charge
    const reasonInfo = getTaxReasonInfo(reasonCode);

    return {
      taxableAmount: context.subtotalAfterCredits,
      totalTaxCents: 0,
      effectiveTaxRate: 0,
      taxLineItems: [
        {
          type: "tax",
          description: formatZeroTaxDescription(reasonCode),
          subtotalCents: 0,
          taxMetadata: {
            taxAuthority: customerCountry || "",
            taxType: "reverse_charge",
            jurisdiction,
            taxRate: 0,
            exemptionReason: "reverse_charge",
            reasonCode,
            fullDescription: reasonInfo.full_description,
          },
          billingPeriodStart:
            context.lineItems[0]?.billingPeriodStart || context.billingDate,
          billingPeriodEnd:
            context.lineItems[0]?.billingPeriodEnd || context.billingDate,
        },
      ],
      jurisdiction,
      calculationMethod: "auto",
      taxBreakdown: { vatTax: 0 },
      exemptionReason: "reverse_charge",
    };
  }
  console.log(
    `[calculateEuVat] Merchant and customer countries differ OR customer doesn't have a VAT ID`,
    {
      customerCountry,
      merchantCountry,
      customerVatId,
    }
  );

  const vatRate =
    euVatTaxMatrix[customerCountry as keyof typeof euVatTaxMatrix];
  const taxAmount = Math.round(context.subtotalAfterCredits * vatRate);

  const reasonCode = 8; // eu_vat_domestic
  const reasonInfo = getTaxReasonInfo(reasonCode);

  console.log(`[calculateEuVat] Calculated EU VAT`, {
    taxAmount,
    vatRate,
    reasonCode,
    reasonInfo,
  });

  return {
    taxableAmount: context.subtotalAfterCredits,
    totalTaxCents: taxAmount,
    effectiveTaxRate: vatRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatTaxDescription(vatRate, reasonCode),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxAuthority: customerCountry || "",
                taxType: "vat",
                jurisdiction,
                taxRate: vatRate,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart:
                context.lineItems[0]?.billingPeriodStart || context.billingDate,
              billingPeriodEnd:
                context.lineItems[0]?.billingPeriodEnd || context.billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: { vatTax: taxAmount },
  };
}

/**
 * Calculate cross-border taxes using tax matrix
 */
function calculateCrossBorderTax(
  context: TaxCalculationContext,
  jurisdiction: string,
  merchantCountry: string,
  customerCountry: string
): TaxCalculationResult {
  // Map individual EU countries to "EU" for tax matrix lookup
  const merchantCountryKey = isEuCountry(merchantCountry)
    ? "EU"
    : merchantCountry;
  const customerCountryKey = isEuCountry(customerCountry)
    ? "EU"
    : customerCountry;

  console.log(`[calculateCrossBorderTax] Cross-border tax lookup`, {
    originalMerchantCountry: merchantCountry,
    originalCustomerCountry: customerCountry,
    merchantCountryKey,
    customerCountryKey,
    jurisdiction,
  });

  const merchantTaxData =
    taxMatrix.tax_matrix[
      merchantCountryKey as keyof typeof taxMatrix.tax_matrix
    ];
  const taxInfo =
    merchantTaxData?.[customerCountryKey as keyof typeof merchantTaxData];

  if (!taxInfo) {
    console.log(`[calculateCrossBorderTax] No tax rule found`, {
      merchantCountryKey,
      customerCountryKey,
      availableMerchantCountries: Object.keys(taxMatrix.tax_matrix),
      availableCustomerCountries: merchantTaxData
        ? Object.keys(merchantTaxData)
        : [],
    });

    return createZeroTaxResult(
      context.subtotalAfterCredits,
      jurisdiction,
      "no_tax_rule",
      "auto",
      context.lineItems[0]?.billingPeriodStart || context.billingDate,
      context.lineItems[0]?.billingPeriodEnd || context.billingDate
    );
  }

  const taxRate = taxInfo.rate;
  const taxAmount = Math.round(context.subtotalAfterCredits * taxRate);
  const reasonCode = taxInfo.reason_code as keyof typeof taxReasonCodes;
  const reasonInfo = taxReasonCodes[reasonCode];
  const reasonDescription =
    reasonInfo?.snake_case || `unknown_reason_${reasonCode}`;
  const taxType = reasonInfo?.tax_type || "cross_border";

  console.log(`[calculateCrossBorderTax] Applied cross-border tax`, {
    taxRate,
    taxAmount,
    reasonCode: taxInfo.reason_code,
    reasonDescription,
    taxType,
  });

  // Use standardized description formatting
  const description =
    taxAmount > 0
      ? formatTaxDescription(taxRate, reasonCode)
      : formatZeroTaxDescription(reasonCode);

  return {
    taxableAmount: context.subtotalAfterCredits,
    totalTaxCents: taxAmount,
    effectiveTaxRate: taxRate,
    taxLineItems: [
      {
        type: "tax",
        description,
        subtotalCents: taxAmount,
        taxMetadata: {
          taxAuthority: customerCountry,
          taxType,
          jurisdiction,
          taxRate: taxRate,
          rateSource: `matrix-${merchantCountryKey}-${customerCountryKey}`,
          reasonCode,
          fullDescription: reasonInfo.full_description,
          ...(taxAmount === 0 && { exemptionReason: reasonDescription }),
        },
        billingPeriodStart:
          context.lineItems[0]?.billingPeriodStart || context.billingDate,
        billingPeriodEnd:
          context.lineItems[0]?.billingPeriodEnd || context.billingDate,
      },
    ],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: {},
    ...(taxAmount === 0 && { exemptionReason: reasonDescription }),
  };
}

/**
 * Calculate manual tax using reusable tax rate definitions
 * Manual tax means the merchant has created tax rate definitions (templates) that customers reference
 * Priority: Customer's assigned tax rate definition > Merchant default rate
 * Note: No jurisdiction fallback - if merchants want jurisdiction-specific rates, use auto-calculation mode
 */
async function calculateManualTax(
  context: TaxCalculationContext,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): Promise<TaxCalculationResult> {
  console.log(
    `[calculateManualTax] Looking up manual tax rate for customer/jurisdiction`,
    {
      customerId: context.customerId,
      jurisdiction,
    }
  );

  // Step 1: Try to find customer-specific tax rate definition
  let customerTaxRate: number | null = null;
  let customerTaxRateDef: typeof taxRateDefinitions.$inferSelect | null = null;

  if (customerData.customer.taxRateDefinitionId) {
    customerTaxRateDef =
      merchantData.taxRateDefinitions.find(
        (def) => def.id === customerData.customer.taxRateDefinitionId
      ) || null;

    if (customerTaxRateDef) {
      customerTaxRate = parseFloat(customerTaxRateDef.taxRate); // internally stored as decimal but inferSelect returns string type
    }
  }

  // Step 2: Fall back to merchant default rate
  const defaultTaxRate = merchantData.taxConfig?.defaultTaxRate
    ? parseFloat(merchantData.taxConfig.defaultTaxRate)
    : 0;

  // Determine which rate to use (priority: customer tax rate definition > default)
  let taxRate = defaultTaxRate;
  let rateSource = "default";

  // Use customer-specific rate if available (highest priority)
  if (customerTaxRate !== null && customerTaxRateDef) {
    taxRate = customerTaxRate;
    rateSource = `customer-${customerTaxRateDef.name}`;
  }

  console.log(`[calculateManualTax] Using manual tax rate`, {
    taxRate,
    rateSource,
    jurisdiction,
  });

  if (taxRate === 0) {
    return createZeroTaxResult(
      context.subtotalAfterCredits,
      jurisdiction,
      "no_manual_rate_configured",
      "manual",
      context.lineItems[0]?.billingPeriodStart || context.billingDate,
      context.lineItems[0]?.billingPeriodEnd || context.billingDate
    );
  }

  const taxAmount = Math.round(context.subtotalAfterCredits * taxRate);

  const reasonCode = 14; // manual_tax_rate
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: context.subtotalAfterCredits,
    totalTaxCents: taxAmount,
    effectiveTaxRate: taxRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatTaxDescription(taxRate, reasonCode),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxType: "manual",
                taxRate,
                jurisdiction,
                rateSource,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart:
                context.lineItems[0]?.billingPeriodStart || context.billingDate,
              billingPeriodEnd:
                context.lineItems[0]?.billingPeriodEnd || context.billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "manual",
    taxBreakdown: {},
  };
}

/**
 * Create exempt tax result
 */
function createExemptTaxResult(
  subtotalAfterCredits: number,
  exemptionReason: string,
  billingPeriodStart: Date,
  billingPeriodEnd: Date
): TaxCalculationResult {
  const reasonCode = 15; // tax_exempt_customer
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: subtotalAfterCredits,
    totalTaxCents: 0,
    effectiveTaxRate: 0,
    taxLineItems: [
      {
        type: "tax",
        description: formatZeroTaxDescription(reasonCode),
        subtotalCents: 0,
        taxMetadata: {
          taxType: "exempt",
          jurisdiction: "exempt",
          taxRate: 0,
          exemptionReason,
          reasonCode,
          fullDescription: reasonInfo.full_description,
        },
        billingPeriodStart,
        billingPeriodEnd,
      },
    ],
    jurisdiction: "exempt",
    calculationMethod: "exempt",
    taxBreakdown: {},
    exemptionReason,
  };
}

/**
 * Create zero tax result
 */
function createZeroTaxResult(
  subtotalAfterCredits: number,
  jurisdiction: string,
  reason: string,
  calculationMethod: "auto" | "manual" | "exempt" = "auto",
  billingPeriodStart?: Date,
  billingPeriodEnd?: Date
): TaxCalculationResult {
  const defaultDate = new Date();

  // Map reason strings to appropriate reason codes
  const reasonCodeMap: Record<string, keyof typeof taxReasonCodes> = {
    no_nexus: 16,
    missing_state_info: 17,
    no_manual_rate_configured: 19,
    no_customer_country: 17,
    no_tax_rule: 20,
    calculation_error: 20,
    api_error: 18,
    missing_address_info: 17,
  };

  const reasonCode = (reasonCodeMap[reason] ||
    20) as keyof typeof taxReasonCodes; // default to calculation_error
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: subtotalAfterCredits,
    totalTaxCents: 0,
    effectiveTaxRate: 0,
    taxLineItems: [
      {
        type: "tax",
        description: formatZeroTaxDescription(reasonCode),
        subtotalCents: 0,
        taxMetadata: {
          taxType: "zero",
          jurisdiction,
          taxRate: 0,
          exemptionReason: reason,
          reasonCode,
          fullDescription: reasonInfo.full_description,
        },
        billingPeriodStart: billingPeriodStart || defaultDate,
        billingPeriodEnd: billingPeriodEnd || defaultDate,
      },
    ],
    jurisdiction,
    calculationMethod,
    taxBreakdown: {},
    exemptionReason: reason,
  };
}

/**
 * Get the Sales Tax Calculator API key from AWS Secrets Manager
 * Only available in production environment
 */
export async function getSalesTaxCalculatorApiKey(): Promise<string> {
  // Only allow production environment
  if (env.NODE_ENV !== "production") {
    throw new Error(
      "Sales Tax Calculator API is only available in production environment"
    );
  }

  // Get from Secrets Manager
  const secretName = "lumen/production/sales-tax-calculator-api-key";
  const secret = await getSecret(secretName);
  if (!secret) {
    throw new Error(
      "Sales Tax Calculator API key not found in Secrets Manager"
    );
  }
  return secret;
}

// Interface for RapidAPI Sales Tax Calculator response
interface SalesTaxCalculatorResponse {
  tax_rate: number;
  rate_details: Array<{
    tax_agency: string;
    tax_rate: number;
  }>;
}

/**
 * Get US state tax rate using RapidAPI Sales Tax Calculator
 * Falls back to 5% default rate if API is unavailable or fails
 */
async function getUsStateTaxRate(
  customer: typeof customers.$inferSelect
): Promise<number> {
  // Check if we have required address data
  if (
    !customer.billingCity ||
    !customer.billingStateProvince ||
    !customer.billingPostalCode
  ) {
    console.log(`[getUsStateTaxRate] Missing required address fields`, {
      customerId: customer.id,
      hasCity: !!customer.billingCity,
      hasState: !!customer.billingStateProvince,
      hasZip: !!customer.billingPostalCode,
    });
    // Return default 5% rate for incomplete addresses
    return 0.05;
  }

  // Only call API in production environment
  if (env.NODE_ENV !== "production") {
    console.log(
      `[getUsStateTaxRate] Using default rate in non-production environment`
    );
    return 0.05;
  }

  try {
    // Get API key
    const apiKey = await getSalesTaxCalculatorApiKey();

    // Prepare request payload
    const requestPayload = {
      city: customer.billingCity,
      state: customer.billingStateProvince,
      street: customer.billingAddressLine1 || "N/A", // Use address line 1 or default
      zip: customer.billingPostalCode,
    };

    console.log(`[getUsStateTaxRate] Calling RapidAPI for tax rate`, {
      customerId: customer.id,
      city: requestPayload.city,
      state: requestPayload.state,
      zip: requestPayload.zip,
    });

    // Make API call
    const response = await fetch(
      "https://sales-tax-calculator.p.rapidapi.com/rates",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-host": "sales-tax-calculator.p.rapidapi.com",
          "x-rapidapi-key": apiKey,
        },
        body: JSON.stringify(requestPayload),
      }
    );

    if (!response.ok) {
      throw new Error(
        `API request failed with status ${response.status}: ${response.statusText}`
      );
    }

    const responseJson = await response.json();
    const data = responseJson as SalesTaxCalculatorResponse;

    // Validate response
    if (typeof data.tax_rate !== "number" || data.tax_rate < 0) {
      throw new Error(`Invalid API response: tax_rate is ${data.tax_rate}`);
    }

    // Convert percentage to decimal (API returns percentage, we need decimal)
    const taxRate = data.tax_rate / 100;

    console.log(
      `[getUsStateTaxRate] Successfully retrieved tax rate from API`,
      {
        customerId: customer.id,
        tax_rate: data.tax_rate,
        taxRateDecimal: taxRate,
        rate_details: data.rate_details,
      }
    );

    return taxRate;
  } catch (error) {
    console.error(
      `[getUsStateTaxRate] Error retrieving tax rate from API, falling back to default`,
      {
        customerId: customer.id,
        error: error instanceof Error ? error.message : String(error),
      }
    );

    // Fallback to default 5% rate on any error
    return 0.05;
  }
}

/**
 * Check if a country is in the EU for VAT purposes
 */
function isEuCountry(country: string): boolean {
  return Object.keys(euVatTaxMatrix).includes(country);
}

/**
 * Calculate UK VAT (post-Brexit domestic)
 */
function calculateUkVat(
  context: TaxCalculationContext,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): TaxCalculationResult {
  // UK domestic transactions: Always charge 20% VAT
  // B2B customers can claim input VAT credit, but seller still charges VAT
  // Reverse charge is NOT used for standard UK domestic B2B transactions
  const vatRate = UK_VAT_RATE;
  const taxAmount = Math.round(context.subtotalAfterCredits * vatRate);

  const reasonCode = 9; // uk_vat_domestic
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: context.subtotalAfterCredits,
    totalTaxCents: taxAmount,
    effectiveTaxRate: vatRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatTaxDescription(vatRate, reasonCode),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxAuthority: customerData.customer.billingCountry || "GB",
                taxType: "vat",
                jurisdiction,
                taxRate: vatRate,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart:
                context.lineItems[0]?.billingPeriodStart || context.billingDate,
              billingPeriodEnd:
                context.lineItems[0]?.billingPeriodEnd || context.billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: { vatTax: taxAmount },
  };
}

/**
 * Calculate Canada GST/HST and stand-alone provincial taxes (PST/QST/RST)
 */
function calculateCanadaGst(
  context: TaxCalculationContext,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): TaxCalculationResult {
  const customerProvince = customerData.customer.billingStateProvince;
  const subtotal = context.subtotalAfterCredits;

  // Determine if the customer is in an HST province (single combined tax)
  const hstProvinces = ["ON", "NB", "NL", "NS", "PE"];
  const isHstProvince = customerProvince
    ? hstProvinces.includes(customerProvince)
    : false;

  let totalTaxCents = 0;
  const taxLineItems: TaxLineItem[] = [];

  // 1. HST provinces – single combined rate replaces GST
  if (isHstProvince) {
    const hstRate = getCanadaGstRate(customerProvince); // returns combined HST rate
    const hstAmount = Math.round(subtotal * hstRate);

    if (hstAmount > 0) {
      const reasonCode = 11; // canada_hst
      const reasonInfo = getTaxReasonInfo(reasonCode);

      totalTaxCents += hstAmount;
      taxLineItems.push({
        type: "tax",
        description: formatTaxDescription(hstRate, reasonCode),
        subtotalCents: hstAmount,
        taxMetadata: {
          taxAuthority: `CA-${customerProvince}`,
          taxType: "hst",
          jurisdiction,
          taxRate: hstRate,
          reasonCode,
          fullDescription: reasonInfo.full_description,
        },
        billingPeriodStart:
          context.lineItems[0]?.billingPeriodStart || context.billingDate,
        billingPeriodEnd:
          context.lineItems[0]?.billingPeriodEnd || context.billingDate,
      });
    }
  } else {
    // 2. All other provinces – federal GST always applies
    const gstRate = CANADA_GST_RATE;
    const gstAmount = Math.round(subtotal * gstRate);

    if (gstAmount > 0) {
      const reasonCode = 10; // canada_gst
      const reasonInfo = getTaxReasonInfo(reasonCode);

      totalTaxCents += gstAmount;
      taxLineItems.push({
        type: "tax",
        description: formatTaxDescription(gstRate, reasonCode),
        subtotalCents: gstAmount,
        taxMetadata: {
          taxAuthority: "CA",
          taxType: "gst",
          jurisdiction,
          taxRate: gstRate,
          reasonCode,
          fullDescription: reasonInfo.full_description,
        },
        billingPeriodStart:
          context.lineItems[0]?.billingPeriodStart || context.billingDate,
        billingPeriodEnd:
          context.lineItems[0]?.billingPeriodEnd || context.billingDate,
      });
    }

    // 3. Province-specific stand-alone taxes (PST/QST/RST)
    const pstInfo = getCanadaPstRate(customerProvince);
    if (pstInfo.rate > 0) {
      const pstAmount = Math.round(subtotal * pstInfo.rate);
      const reasonCode = 12; // canada_pst
      const reasonInfo = getTaxReasonInfo(reasonCode);

      totalTaxCents += pstAmount;
      taxLineItems.push({
        type: "tax",
        description: formatSpecificTaxDescription(
          pstInfo.rate,
          reasonCode,
          pstInfo.type || "PST"
        ),
        subtotalCents: pstAmount,
        taxMetadata: {
          taxAuthority: customerProvince ? `CA-${customerProvince}` : "CA",
          taxType: pstInfo.type || "pst",
          jurisdiction,
          taxRate: pstInfo.rate,
          reasonCode,
          fullDescription: reasonInfo.full_description,
        },
        billingPeriodStart:
          context.lineItems[0]?.billingPeriodStart || context.billingDate,
        billingPeriodEnd:
          context.lineItems[0]?.billingPeriodEnd || context.billingDate,
      });
    }
  }

  const effectiveTaxRate = subtotal === 0 ? 0 : totalTaxCents / subtotal;

  return {
    taxableAmount: subtotal,
    totalTaxCents,
    effectiveTaxRate,
    taxLineItems,
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: { gstTax: totalTaxCents },
  };
}

/**
 * Calculate Switzerland VAT
 */
function calculateSwitzerlandVat(
  context: TaxCalculationContext,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): TaxCalculationResult {
  const vatRate = SWITZERLAND_VAT_RATE;
  const taxAmount = Math.round(context.subtotalAfterCredits * vatRate);

  const reasonCode = 13; // switzerland_vat
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: context.subtotalAfterCredits,
    totalTaxCents: taxAmount,
    effectiveTaxRate: vatRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatTaxDescription(vatRate, reasonCode),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxAuthority: "CH",
                taxType: "vat",
                jurisdiction,
                taxRate: vatRate,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart:
                context.lineItems[0]?.billingPeriodStart || context.billingDate,
              billingPeriodEnd:
                context.lineItems[0]?.billingPeriodEnd || context.billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: { vatTax: taxAmount },
  };
}

/**
 * Calculate US state sales tax for payment flow
 */
async function calculateUsTaxForPaymentFlow(
  subtotalCents: number,
  billingDate: Date,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): Promise<TaxCalculationResult> {
  const merchantState = merchantData.merchant.stateProvince;
  const customerState = customerData.customer.billingStateProvince;

  if (!merchantState || !customerState) {
    console.log(`[calculateUsTaxForPaymentFlow] Missing state info`, {
      merchantState,
      customerState,
    });
    return createZeroTaxResult(
      subtotalCents,
      "US",
      "missing_state_info",
      "auto",
      billingDate,
      billingDate
    );
  }

  // Check if cross-state sale requires nexus
  if (merchantState !== customerState) {
    console.log(
      `[calculateUsTaxForPaymentFlow] Cross-state sale requires nexus`,
      {
        merchantState,
        customerState,
      }
    );
    const nexusConfig = merchantData.nexusConfigs.find(
      (config) => config.state === customerState
    );

    if (!nexusConfig?.hasNexus) {
      return createZeroTaxResult(
        subtotalCents,
        jurisdiction,
        "no_nexus",
        "auto",
        billingDate,
        billingDate
      );
    }
  }

  const stateTaxRate = await getUsStateTaxRate(customerData.customer);
  const taxAmount = Math.round(subtotalCents * stateTaxRate);

  const reasonCode = 7; // us_sales_tax
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: subtotalCents,
    totalTaxCents: taxAmount,
    effectiveTaxRate: stateTaxRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatSpecificTaxDescription(
                stateTaxRate,
                reasonCode,
                undefined,
                customerState
              ),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxAuthority: `US-${customerState}`,
                taxType: "sales_tax",
                jurisdiction,
                taxRate: stateTaxRate,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart: billingDate,
              billingPeriodEnd: billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: {
      stateTax: taxAmount,
    },
  };
}

/**
 * Calculate EU VAT for payment flow
 */
function calculateEuVatForPaymentFlow(
  subtotalCents: number,
  billingDate: Date,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): TaxCalculationResult {
  const merchantCountry = merchantData.merchant.country;
  const customerCountry = customerData.customer.billingCountry;
  const customerVatId = customerData.customer.taxId;

  // B2B reverse charge scenario
  if (merchantCountry !== customerCountry && customerVatId) {
    console.log(`[calculateEuVatForPaymentFlow] B2B reverse charge applies`, {
      merchantCountry,
      customerCountry,
      customerVatId,
    });

    const reasonCode = 1; // reverse_charge
    const reasonInfo = getTaxReasonInfo(reasonCode);

    return {
      taxableAmount: subtotalCents,
      totalTaxCents: 0,
      effectiveTaxRate: 0,
      taxLineItems: [
        {
          type: "tax",
          description: formatZeroTaxDescription(reasonCode),
          subtotalCents: 0,
          taxMetadata: {
            taxAuthority: customerCountry || "",
            taxType: "reverse_charge",
            jurisdiction,
            taxRate: 0,
            exemptionReason: "reverse_charge",
            reasonCode,
            fullDescription: reasonInfo.full_description,
          },
          billingPeriodStart: billingDate,
          billingPeriodEnd: billingDate,
        },
      ],
      jurisdiction,
      calculationMethod: "auto",
      taxBreakdown: { vatTax: 0 },
      exemptionReason: "reverse_charge",
    };
  }

  const vatRate =
    euVatTaxMatrix[customerCountry as keyof typeof euVatTaxMatrix];
  const taxAmount = Math.round(subtotalCents * vatRate);

  const reasonCode = 8; // eu_vat_domestic
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: subtotalCents,
    totalTaxCents: taxAmount,
    effectiveTaxRate: vatRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatTaxDescription(vatRate, reasonCode),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxAuthority: customerCountry || "",
                taxType: "vat",
                jurisdiction,
                taxRate: vatRate,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart: billingDate,
              billingPeriodEnd: billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: { vatTax: taxAmount },
  };
}

/**
 * Calculate UK VAT for payment flow
 */
function calculateUkVatForPaymentFlow(
  subtotalCents: number,
  billingDate: Date,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): TaxCalculationResult {
  const vatRate = UK_VAT_RATE;
  const taxAmount = Math.round(subtotalCents * vatRate);

  const reasonCode = 9; // uk_vat_domestic
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: subtotalCents,
    totalTaxCents: taxAmount,
    effectiveTaxRate: vatRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatTaxDescription(vatRate, reasonCode),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxAuthority: customerData.customer.billingCountry || "GB",
                taxType: "vat",
                jurisdiction,
                taxRate: vatRate,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart: billingDate,
              billingPeriodEnd: billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: { vatTax: taxAmount },
  };
}

/**
 * Calculate Canada GST/HST for payment flow
 */
function calculateCanadaGstForPaymentFlow(
  subtotalCents: number,
  billingDate: Date,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): TaxCalculationResult {
  const customerProvince = customerData.customer.billingStateProvince;

  // Determine if the customer is in an HST province (single combined tax)
  const hstProvinces = ["ON", "NB", "NL", "NS", "PE"];
  const isHstProvince = customerProvince
    ? hstProvinces.includes(customerProvince)
    : false;

  let totalTaxCents = 0;
  const taxLineItems: TaxLineItem[] = [];

  // 1. HST provinces – single combined rate replaces GST
  if (isHstProvince) {
    const hstRate = getCanadaGstRate(customerProvince); // returns combined HST rate
    const hstAmount = Math.round(subtotalCents * hstRate);

    if (hstAmount > 0) {
      const reasonCode = 11; // canada_hst
      const reasonInfo = getTaxReasonInfo(reasonCode);

      totalTaxCents += hstAmount;
      taxLineItems.push({
        type: "tax",
        description: formatTaxDescription(hstRate, reasonCode),
        subtotalCents: hstAmount,
        taxMetadata: {
          taxAuthority: `CA-${customerProvince}`,
          taxType: "hst",
          jurisdiction,
          taxRate: hstRate,
          reasonCode,
          fullDescription: reasonInfo.full_description,
        },
        billingPeriodStart: billingDate,
        billingPeriodEnd: billingDate,
      });
    }
  } else {
    // 2. All other provinces – federal GST always applies
    const gstRate = CANADA_GST_RATE;
    const gstAmount = Math.round(subtotalCents * gstRate);

    if (gstAmount > 0) {
      const reasonCode = 10; // canada_gst
      const reasonInfo = getTaxReasonInfo(reasonCode);

      totalTaxCents += gstAmount;
      taxLineItems.push({
        type: "tax",
        description: formatTaxDescription(gstRate, reasonCode),
        subtotalCents: gstAmount,
        taxMetadata: {
          taxAuthority: "CA",
          taxType: "gst",
          jurisdiction,
          taxRate: gstRate,
          reasonCode,
          fullDescription: reasonInfo.full_description,
        },
        billingPeriodStart: billingDate,
        billingPeriodEnd: billingDate,
      });
    }

    // 3. Province-specific stand-alone taxes (PST/QST/RST)
    const pstInfo = getCanadaPstRate(customerProvince);
    if (pstInfo.rate > 0) {
      const pstAmount = Math.round(subtotalCents * pstInfo.rate);
      const reasonCode = 12; // canada_pst
      const reasonInfo = getTaxReasonInfo(reasonCode);

      totalTaxCents += pstAmount;
      taxLineItems.push({
        type: "tax",
        description: formatSpecificTaxDescription(
          pstInfo.rate,
          reasonCode,
          pstInfo.type || "PST"
        ),
        subtotalCents: pstAmount,
        taxMetadata: {
          taxAuthority: customerProvince ? `CA-${customerProvince}` : "CA",
          taxType: pstInfo.type || "pst",
          jurisdiction,
          taxRate: pstInfo.rate,
          reasonCode,
          fullDescription: reasonInfo.full_description,
        },
        billingPeriodStart: billingDate,
        billingPeriodEnd: billingDate,
      });
    }
  }

  const effectiveTaxRate =
    subtotalCents === 0 ? 0 : totalTaxCents / subtotalCents;

  return {
    taxableAmount: subtotalCents,
    totalTaxCents,
    effectiveTaxRate,
    taxLineItems,
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: { gstTax: totalTaxCents },
  };
}

/**
 * Calculate Switzerland VAT for payment flow
 */
function calculateSwitzerlandVatForPaymentFlow(
  subtotalCents: number,
  billingDate: Date,
  jurisdiction: string,
  merchantData: MerchantTaxData,
  customerData: CustomerTaxData
): TaxCalculationResult {
  const vatRate = SWITZERLAND_VAT_RATE;
  const taxAmount = Math.round(subtotalCents * vatRate);

  const reasonCode = 13; // switzerland_vat
  const reasonInfo = getTaxReasonInfo(reasonCode);

  return {
    taxableAmount: subtotalCents,
    totalTaxCents: taxAmount,
    effectiveTaxRate: vatRate,
    taxLineItems:
      taxAmount > 0
        ? [
            {
              type: "tax",
              description: formatTaxDescription(vatRate, reasonCode),
              subtotalCents: taxAmount,
              taxMetadata: {
                taxAuthority: "CH",
                taxType: "vat",
                jurisdiction,
                taxRate: vatRate,
                reasonCode,
                fullDescription: reasonInfo.full_description,
              },
              billingPeriodStart: billingDate,
              billingPeriodEnd: billingDate,
            },
          ]
        : [],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: { vatTax: taxAmount },
  };
}

/**
 * Calculate cross-border taxes for payment flow
 */
function calculateCrossBorderTaxForPaymentFlow(
  subtotalCents: number,
  billingDate: Date,
  jurisdiction: string,
  merchantCountry: string,
  customerCountry: string
): TaxCalculationResult {
  // Map individual EU countries to "EU" for tax matrix lookup
  const merchantCountryKey = isEuCountry(merchantCountry)
    ? "EU"
    : merchantCountry;
  const customerCountryKey = isEuCountry(customerCountry)
    ? "EU"
    : customerCountry;

  console.log(
    `[calculateCrossBorderTaxForPaymentFlow] Cross-border tax lookup`,
    {
      originalMerchantCountry: merchantCountry,
      originalCustomerCountry: customerCountry,
      merchantCountryKey,
      customerCountryKey,
      jurisdiction,
    }
  );

  const merchantTaxData =
    taxMatrix.tax_matrix[
      merchantCountryKey as keyof typeof taxMatrix.tax_matrix
    ];
  const taxInfo =
    merchantTaxData?.[customerCountryKey as keyof typeof merchantTaxData];

  if (!taxInfo) {
    console.log(`[calculateCrossBorderTaxForPaymentFlow] No tax rule found`, {
      merchantCountryKey,
      customerCountryKey,
      availableMerchantCountries: Object.keys(taxMatrix.tax_matrix),
      availableCustomerCountries: merchantTaxData
        ? Object.keys(merchantTaxData)
        : [],
    });

    return createZeroTaxResult(
      subtotalCents,
      jurisdiction,
      "no_tax_rule",
      "auto",
      billingDate,
      billingDate
    );
  }

  const taxRate = taxInfo.rate;
  const taxAmount = Math.round(subtotalCents * taxRate);
  const reasonCode = taxInfo.reason_code as keyof typeof taxReasonCodes;
  const reasonInfo = taxReasonCodes[reasonCode];
  const reasonDescription =
    reasonInfo?.snake_case || `unknown_reason_${reasonCode}`;
  const taxType = reasonInfo?.tax_type || "cross_border";

  console.log(
    `[calculateCrossBorderTaxForPaymentFlow] Applied cross-border tax`,
    {
      taxRate,
      taxAmount,
      reasonCode: taxInfo.reason_code,
      reasonDescription,
      taxType,
    }
  );

  // Use standardized description formatting
  const description =
    taxAmount > 0
      ? formatTaxDescription(taxRate, reasonCode)
      : formatZeroTaxDescription(reasonCode);

  return {
    taxableAmount: subtotalCents,
    totalTaxCents: taxAmount,
    effectiveTaxRate: taxRate,
    taxLineItems: [
      {
        type: "tax",
        description,
        subtotalCents: taxAmount,
        taxMetadata: {
          taxAuthority: customerCountry,
          taxType,
          jurisdiction,
          taxRate: taxRate,
          rateSource: `matrix-${merchantCountryKey}-${customerCountryKey}`,
          reasonCode,
          fullDescription: reasonInfo.full_description,
          ...(taxAmount === 0 && { exemptionReason: reasonDescription }),
        },
        billingPeriodStart: billingDate,
        billingPeriodEnd: billingDate,
      },
    ],
    jurisdiction,
    calculationMethod: "auto",
    taxBreakdown: {},
    ...(taxAmount === 0 && { exemptionReason: reasonDescription }),
  };
}
