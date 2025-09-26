// Tax reason code mappings - centralized source of truth
export const taxReasonCodes = {
  1: {
    snake_case: "reverse_charge",
    full_description: "Tax to be paid on reverse charge basis.",
    short_description: "Reverse Charge",
    tax_type: "reverse_charge",
  },
  2: {
    snake_case: "domestic_sale",
    full_description: "Domestic Sale: Seller charges local VAT/GST.",
    short_description: "Domestic Sale",
    tax_type: "domestic",
  },
  3: {
    snake_case: "no_vat_in_buyer_jurisdiction",
    full_description:
      "No VAT/GST in Buyer's Jurisdiction: No tax for foreign seller.",
    short_description: "No VAT/GST in Buyer's Jurisdiction",
    tax_type: "no_tax_jurisdiction",
  },
  4: {
    snake_case: "no_tax_on_digital_services",
    full_description:
      "No Tax on Cross-Border Digital Services: Buyer's country does not tax this type of import (e.g., Brazil).",
    short_description: "No Tax on Cross-Border Digital Services",
    tax_type: "no_tax_digital_services",
  },
  5: {
    snake_case: "foreign_seller_registration_required",
    full_description:
      "Foreign Seller Registration Required: Seller must register and charge local VAT (e.g., Mexico).",
    short_description: "Foreign Seller Registration Required",
    tax_type: "foreign_registration_required",
  },
  6: {
    snake_case: "us_domestic",
    full_description: "US Domestic: No federal VAT; state sales tax may apply.",
    short_description: "US Domestic",
    tax_type: "us_domestic",
  },
  7: {
    snake_case: "us_sales_tax",
    full_description:
      "US State Sales Tax: State-level sales tax applied to taxable transactions.",
    short_description: "Sales Tax",
    tax_type: "sales_tax",
  },
  8: {
    snake_case: "eu_vat_domestic",
    full_description:
      "EU VAT (Domestic): Value Added Tax for domestic transactions within EU member states.",
    short_description: "EU VAT",
    tax_type: "vat",
  },
  9: {
    snake_case: "uk_vat_domestic",
    full_description:
      "UK VAT (Domestic): Value Added Tax for domestic transactions within the United Kingdom.",
    short_description: "UK VAT",
    tax_type: "vat",
  },
  10: {
    snake_case: "canada_gst",
    full_description:
      "Canada GST: Federal Goods and Services Tax applied across Canada.",
    short_description: "GST",
    tax_type: "gst",
  },
  11: {
    snake_case: "canada_hst",
    full_description:
      "Canada HST: Harmonized Sales Tax combining federal and provincial taxes.",
    short_description: "HST",
    tax_type: "hst",
  },
  12: {
    snake_case: "canada_pst",
    full_description:
      "Canada PST/QST/RST: Provincial sales tax applied in addition to federal GST.",
    short_description: "PST",
    tax_type: "pst",
  },
  13: {
    snake_case: "switzerland_vat",
    full_description:
      "Switzerland VAT: Value Added Tax for domestic transactions within Switzerland.",
    short_description: "Swiss VAT",
    tax_type: "vat",
  },
  14: {
    snake_case: "manual_tax_rate",
    full_description:
      "Manual Tax Rate: Merchant-configured tax rate applied to transaction.",
    short_description: "Manual Tax",
    tax_type: "manual",
  },
  15: {
    snake_case: "tax_exempt_customer",
    full_description:
      "Tax Exempt: Customer is exempt from tax collection per exemption certificate.",
    short_description: "Tax Exempt",
    tax_type: "exempt",
  },
  16: {
    snake_case: "no_nexus_us",
    full_description:
      "No Nexus: Cross-state sale with no tax nexus established in customer's state.",
    short_description: "No Nexus",
    tax_type: "no_nexus",
  },
  17: {
    snake_case: "missing_address_data",
    full_description:
      "Missing Address Data: Insufficient address information for tax calculation.",
    short_description: "Missing Address",
    tax_type: "error",
  },
  18: {
    snake_case: "api_error_fallback",
    full_description:
      "API Error: Tax calculation service unavailable, using fallback rate.",
    short_description: "API Error",
    tax_type: "error",
  },
  19: {
    snake_case: "no_manual_rate_configured",
    full_description:
      "No Manual Rate: No manual tax rate configured for this transaction.",
    short_description: "No Manual Rate",
    tax_type: "no_rate",
  },
  20: {
    snake_case: "calculation_error",
    full_description:
      "Calculation Error: Tax calculation failed, no tax applied to avoid blocking transaction.",
    short_description: "Calculation Error",
    tax_type: "error",
  },
  21: {
    snake_case: "nonprofit_organization",
    full_description:
      "Nonprofit Organization: Customer is a qualified nonprofit organization exempt from tax collection.",
    short_description: "Nonprofit Exempt",
    tax_type: "exempt",
  },
  22: {
    snake_case: "government_entity",
    full_description:
      "Government Entity: Customer is a government entity exempt from tax collection.",
    short_description: "Government Exempt",
    tax_type: "exempt",
  },
  23: {
    snake_case: "educational_institution",
    full_description:
      "Educational Institution: Customer is an educational institution exempt from tax collection.",
    short_description: "Educational Exempt",
    tax_type: "exempt",
  },
  24: {
    snake_case: "resale_certificate",
    full_description:
      "Resale Certificate: Customer has provided a valid resale certificate for tax exemption.",
    short_description: "Resale Exempt",
    tax_type: "exempt",
  },
  25: {
    snake_case: "custom_exemption",
    full_description:
      "Custom Exemption: Customer is exempt from tax collection for other specified reasons.",
    short_description: "Custom Exempt",
    tax_type: "exempt",
  },
} as const;

export const taxMatrix = {
  legend: {
    "1": taxReasonCodes[1].full_description,
    "2": taxReasonCodes[2].full_description,
    "3": taxReasonCodes[3].full_description,
    "4": taxReasonCodes[4].full_description,
    "5": taxReasonCodes[5].full_description,
    "6": taxReasonCodes[6].full_description,
    "7": taxReasonCodes[7].full_description,
    "8": taxReasonCodes[8].full_description,
    "9": taxReasonCodes[9].full_description,
    "10": taxReasonCodes[10].full_description,
    "11": taxReasonCodes[11].full_description,
    "12": taxReasonCodes[12].full_description,
    "13": taxReasonCodes[13].full_description,
    "14": taxReasonCodes[14].full_description,
    "15": taxReasonCodes[15].full_description,
    "16": taxReasonCodes[16].full_description,
    "17": taxReasonCodes[17].full_description,
    "18": taxReasonCodes[18].full_description,
    "19": taxReasonCodes[19].full_description,
    "20": taxReasonCodes[20].full_description,
    "21": taxReasonCodes[21].full_description,
    "22": taxReasonCodes[22].full_description,
    "23": taxReasonCodes[23].full_description,
    "24": taxReasonCodes[24].full_description,
    "25": taxReasonCodes[25].full_description,
  },
  tax_matrix: {
    US: {
      CA: { rate: 0.0, reason_code: 1 },
      GB: { rate: 0.0, reason_code: 1 },
      EU: { rate: 0.0, reason_code: 1 },
      CH: { rate: 0.0, reason_code: 1 },
      IN: { rate: 0.0, reason_code: 1 },
      SG: { rate: 0.0, reason_code: 1 },
      MX: { rate: 0.16, reason_code: 5 },
      BR: { rate: 0.0, reason_code: 4 },
      JP: { rate: 0.0, reason_code: 1 },
      ID: { rate: 0.0, reason_code: 1 },
      TH: { rate: 0.0, reason_code: 1 },
      KR: { rate: 0.0, reason_code: 1 },
    },
    CA: {
      US: { rate: 0.0, reason_code: 3 },
      GB: { rate: 0.0, reason_code: 1 },
      EU: { rate: 0.0, reason_code: 1 },
      CH: { rate: 0.0, reason_code: 1 },
      IN: { rate: 0.0, reason_code: 1 },
      SG: { rate: 0.0, reason_code: 1 },
      MX: { rate: 0.16, reason_code: 5 },
      BR: { rate: 0.0, reason_code: 4 },
      JP: { rate: 0.0, reason_code: 1 },
      ID: { rate: 0.0, reason_code: 1 },
      TH: { rate: 0.0, reason_code: 1 },
      KR: { rate: 0.0, reason_code: 1 },
    },
    GB: {
      US: { rate: 0.0, reason_code: 3 },
      CA: { rate: 0.0, reason_code: 1 },
      EU: { rate: 0.0, reason_code: 1 },
      CH: { rate: 0.0, reason_code: 1 },
      IN: { rate: 0.0, reason_code: 1 },
      SG: { rate: 0.0, reason_code: 1 },
      MX: { rate: 0.16, reason_code: 5 },
      BR: { rate: 0.0, reason_code: 4 },
      JP: { rate: 0.0, reason_code: 1 },
      ID: { rate: 0.0, reason_code: 1 },
      TH: { rate: 0.0, reason_code: 1 },
      KR: { rate: 0.0, reason_code: 1 },
    },
    EU: {
      US: { rate: 0.0, reason_code: 1 },
      CA: { rate: 0.0, reason_code: 1 },
      GB: { rate: 0.0, reason_code: 1 },
      CH: { rate: 0.0, reason_code: 1 },
      IN: { rate: 0.0, reason_code: 1 },
      SG: { rate: 0.0, reason_code: 1 },
      MX: { rate: 0.16, reason_code: 5 },
      BR: { rate: 0.0, reason_code: 4 },
      JP: { rate: 0.0, reason_code: 1 },
      ID: { rate: 0.0, reason_code: 1 },
      TH: { rate: 0.0, reason_code: 1 },
      KR: { rate: 0.0, reason_code: 1 },
    },
    CH: {
      US: { rate: 0.0, reason_code: 3 },
      CA: { rate: 0.0, reason_code: 1 },
      GB: { rate: 0.0, reason_code: 1 },
      EU: { rate: 0.0, reason_code: 1 },
      IN: { rate: 0.0, reason_code: 1 },
      SG: { rate: 0.0, reason_code: 1 },
      MX: { rate: 0.16, reason_code: 5 },
      BR: { rate: 0.0, reason_code: 4 },
      JP: { rate: 0.0, reason_code: 1 },
      ID: { rate: 0.0, reason_code: 1 },
      TH: { rate: 0.0, reason_code: 1 },
      KR: { rate: 0.0, reason_code: 1 },
    },
    IN: {
      US: { rate: 0.0, reason_code: 3 },
      CA: { rate: 0.0, reason_code: 1 },
      GB: { rate: 0.0, reason_code: 1 },
      EU: { rate: 0.0, reason_code: 1 },
      CH: { rate: 0.0, reason_code: 1 },
      SG: { rate: 0.0, reason_code: 1 },
      MX: { rate: 0.16, reason_code: 5 },
      BR: { rate: 0.0, reason_code: 4 },
      JP: { rate: 0.0, reason_code: 1 },
      ID: { rate: 0.0, reason_code: 1 },
      TH: { rate: 0.0, reason_code: 1 },
      KR: { rate: 0.0, reason_code: 1 },
    },
    SG: {
      US: { rate: 0.0, reason_code: 3 },
      CA: { rate: 0.0, reason_code: 1 },
      GB: { rate: 0.0, reason_code: 1 },
      EU: { rate: 0.0, reason_code: 1 },
      CH: { rate: 0.0, reason_code: 1 },
      IN: { rate: 0.0, reason_code: 1 },
      MX: { rate: 0.16, reason_code: 5 },
      BR: { rate: 0.0, reason_code: 4 },
      JP: { rate: 0.0, reason_code: 1 },
      ID: { rate: 0.0, reason_code: 1 },
      TH: { rate: 0.0, reason_code: 1 },
      KR: { rate: 0.0, reason_code: 1 },
    },
  },
};

export const euVatTaxMatrix = {
  AT: 0.2,
  BE: 0.21,
  BG: 0.2,
  HR: 0.25,
  CY: 0.19,
  CZ: 0.21,
  DK: 0.25,
  EE: 0.22,
  FI: 0.255,
  FR: 0.2,
  GE: 0.18,
  DE: 0.19,
  GR: 0.24,
  HU: 0.27,
  IS: 0.24,
  IE: 0.23,
  IT: 0.22,
  LV: 0.21,
  LT: 0.21,
  LU: 0.17,
  MT: 0.18,
  MD: 0.2,
  NL: 0.21,
  NO: 0.25,
  PL: 0.23,
  PT: 0.23,
  RO: 0.19,
  SK: 0.23,
  SI: 0.22,
  ES: 0.21,
  SE: 0.25,
  CH: 0.081,
  TR: 0.2,
  UA: 0.2,
  GB: 0.2,
};

// -----------------------------
// Centralised domestic tax rates & helpers
// -----------------------------

// Country-level VAT/GST rates used in various calculations
export const UK_VAT_RATE = 0.2;
export const SWITZERLAND_VAT_RATE = 0.081;
export const NORWAY_VAT_RATE = 0.2; // standard rate for SaaS – may differ from general 25 %
export const ICELAND_VAT_RATE = 0.24;
export const TURKEY_VAT_RATE = 0.18;

// Canada – federal GST and province specific HST/PST/QST/RST
export const CANADA_GST_RATE = 0.05;

export const CANADA_HST_RATES: Record<string, number> = {
  ON: 0.13,
  NB: 0.15,
  NL: 0.15,
  NS: 0.15,
  PE: 0.15,
};

export const CANADA_PST_RATES: Record<
  string,
  { rate: number; type: "pst" | "qst" | "rst" }
> = {
  BC: { rate: 0.07, type: "pst" },
  SK: { rate: 0.06, type: "pst" },
  MB: { rate: 0.07, type: "rst" },
  QC: { rate: 0.09975, type: "qst" },
};

// US – temporary single default state tax rate placeholder
export const US_DEFAULT_STATE_TAX_RATE = 0.05;

// ---------------------------------------------------------------------------
// Helper utilities that encapsulate country / province level tax look-ups
// ---------------------------------------------------------------------------

// Simplified – returns GST or combined HST rate when province opts for HST
export function getCanadaGstRate(province?: string | null): number {
  if (!province) return CANADA_GST_RATE;
  const hstRate = CANADA_HST_RATES[province as keyof typeof CANADA_HST_RATES];
  return hstRate ?? CANADA_GST_RATE;
}

export function getCanadaPstRate(province?: string | null): {
  rate: number;
  type: "pst" | "qst" | "rst" | null;
} {
  if (!province) return { rate: 0, type: null };
  return (
    CANADA_PST_RATES[province as keyof typeof CANADA_PST_RATES] || {
      rate: 0,
      type: null,
    }
  );
}

// ---------------------------------------------------------------------------
// Tax Exemption Reason Mapping
// ---------------------------------------------------------------------------

/**
 * Map customer exemption reasons to their corresponding tax reason codes
 * This provides a centralized mapping for all tax exemption scenarios
 */
export const exemptionReasonMapping = {
  // System-level exemptions (automatic/calculated)
  reverse_charge: 1,
  calculation_error: 20,

  // Customer-specific exemptions (user-selected)
  nonprofit_organization: 21,
  government_entity: 22,
  educational_institution: 23,
  resale: 24,

  // Fallbacks
  other: 25, // Custom exemption text
} as const;

/**
 * Get the appropriate reason code for a given exemption reason
 * @param exemptionReason - The exemption reason string
 * @returns The corresponding tax reason code
 */
export function getExemptionReasonCode(
  exemptionReason: string
): keyof typeof taxReasonCodes {
  // Check if it's a predefined exemption reason
  if (exemptionReason in exemptionReasonMapping) {
    return exemptionReasonMapping[
      exemptionReason as keyof typeof exemptionReasonMapping
    ];
  }

  // For any custom text or unknown reasons, use the custom exemption code
  return exemptionReasonMapping.other;
}

/**
 * Get enhanced full description for exemption reasons, including custom text when applicable
 * @param exemptionReason - The original exemption reason (e.g., "nonprofit_organization" or custom text)
 * @param reasonCode - The tax reason code
 * @returns Enhanced description that includes custom reason when applicable
 */
export function getExemptionFullDescription(
  exemptionReason: string,
  reasonCode: keyof typeof taxReasonCodes
): string {
  const reasonInfo = getTaxReasonInfo(reasonCode);

  if (reasonCode === 25) {
    // custom_exemption code
    // For custom exemptions, include the actual reason in the description
    return `Custom Exemption: ${exemptionReason}`;
  }

  // For all other cases, use the standard description
  return reasonInfo.full_description;
}

// ---------------------------------------------------------------------------
// Tax Description Formatting Helpers
// ---------------------------------------------------------------------------

/**
 * Format tax description in standardized format: "X.XX%: Reason"
 * @param taxRate - Tax rate as decimal (e.g., 0.0825 for 8.25%)
 * @param reasonCode - Tax reason code from taxReasonCodes
 * @returns Formatted description string
 */
export function formatTaxDescription(
  taxRate: number,
  reasonCode: keyof typeof taxReasonCodes
): string {
  const reasonInfo = taxReasonCodes[reasonCode];
  if (!reasonInfo) {
    throw new Error(`Invalid reason code: ${reasonCode}`);
  }

  const percentage = (taxRate * 100).toFixed(2);
  return `${percentage}%: ${reasonInfo.short_description}`;
}

/**
 * Format zero tax description in standardized format: "0%: Reason"
 * @param reasonCode - Tax reason code from taxReasonCodes
 * @returns Formatted description string for zero tax
 */
export function formatZeroTaxDescription(
  reasonCode: keyof typeof taxReasonCodes
): string {
  const reasonInfo = taxReasonCodes[reasonCode];
  if (!reasonInfo) {
    throw new Error(`Invalid reason code: ${reasonCode}`);
  }

  return `0%: ${reasonInfo.short_description}`;
}

/**
 * Get tax reason information by code
 * @param reasonCode - Tax reason code from taxReasonCodes
 * @returns Tax reason information object
 */
export function getTaxReasonInfo(reasonCode: keyof typeof taxReasonCodes) {
  const reasonInfo = taxReasonCodes[reasonCode];
  if (!reasonInfo) {
    throw new Error(`Invalid reason code: ${reasonCode}`);
  }
  return reasonInfo;
}

/**
 * Format tax description for specific tax types (handles special cases)
 * @param taxRate - Tax rate as decimal
 * @param reasonCode - Tax reason code
 * @param taxType - Optional tax type override (e.g., "PST", "QST", "RST")
 * @param jurisdiction - Optional jurisdiction (e.g., "CA", "ON")
 * @returns Formatted description string
 */
export function formatSpecificTaxDescription(
  taxRate: number,
  reasonCode: keyof typeof taxReasonCodes,
  taxType?: string,
  jurisdiction?: string
): string {
  const reasonInfo = taxReasonCodes[reasonCode];
  if (!reasonInfo) {
    throw new Error(`Invalid reason code: ${reasonCode}`);
  }

  const percentage = (taxRate * 100).toFixed(2);

  // Handle special cases for Canada PST/QST/RST
  if (taxType && ["PST", "QST", "RST"].includes(taxType.toUpperCase())) {
    return `${percentage}%: ${taxType.toUpperCase()}`;
  }

  // Handle jurisdiction-specific cases (e.g., "CA Sales Tax")
  if (jurisdiction && reasonCode === 7) {
    return `${percentage}%: ${jurisdiction} Sales Tax`;
  }

  // Default to standard format
  return `${percentage}%: ${reasonInfo.short_description}`;
}
