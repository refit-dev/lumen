import { customAlphabet } from "nanoid";

// Use a custom alphabet with 58 characters (similar to base58)
// Excludes similar-looking characters: 0, O, I, l
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Length of the random part of the ID
export const ID_LENGTH = 22;

// Generate a nanoid with our custom alphabet and specified length
const nanoid = customAlphabet(ALPHABET, ID_LENGTH);

// ID prefix constants - each table gets its own prefix for readability
export const ID_PREFIXES = {
  // Core business entities (customer-facing, more descriptive)
  merchant: "mer_",
  customer: "cus_",
  subscription: "sub_int_",
  stableSubscription: "sub_",
  plan: "plan_int_",
  stablePlan: "plan_",
  price: "price_",

  // Features
  feature: "feat_",
  planFeature: "plan_feat_",
  subscriptionFeature: "sub_feat_",

  // Billing entities (customer sees these)
  invoice: "inv_",
  invoiceLineItem: "inv_item_",
  payment: "pay_",
  paymentMethod: "pm_",
  refund: "refund_",

  // Usage tracking
  metric: "met_",
  event: "evt_",
  featureMetric: "feat_met_",

  // Authentication and integration
  apiKey: "api_key_",
  stripe: "stripe_",
  dodo: "dodo_",

  // Subscription modifications and details
  subscriptionPriceOverride: "sub_price_override_",
  subscriptionFeatureOverride: "sub_feat_override_",
  subscriptionScheduledChange: "sub_sched_change_",
  subscriptionChange: "sub_change_",
  subscriptionDetail: "sub_detail_",

  // Credit notes and items
  creditNote: "cred_note_",
  creditNoteItem: "cred_note_item_",

  // Price components
  fixedComponent: "price_comp_fix_",
  perUnitComponent: "price_comp_unit_",
  usageComponent: "price_comp_usage_",

  // Pricing tables
  pricingTable: "price_table_",
  pricingTablePlan: "price_table_plan_",

  // Credit definitions
  creditDefinition: "cred_def_",
  creditGrant: "cred_",
  creditUsageTransaction: "cred_usage_",

  // Billing session for transaction tracking
  billingSession: "bill_sess_",

  // Tax configuration
  merchantTaxConfig: "mer_tax_cfg_",
  taxRegistration: "tax_reg_",
  usNexusConfig: "us_nexus_cfg_",
  taxRateDefinition: "tax_rate_def_",
  billingTask: "bill_task_",
} as const;

/**
 * Creates a prefixed ID for the given entity type
 * @param prefix The prefix to use for the ID
 * @returns A prefixed nanoid
 */
export const createPrefixedId = (prefix: string) => `${prefix}${nanoid()}`;

/**
 * Creates a generic ID (without prefix)
 * @returns A nanoid
 */
export const createId = () => nanoid();

/**
 * Validates the format of an ID with a specific prefix
 * @param id The ID to validate
 * @param prefix The expected prefix
 * @returns True if the ID has the correct prefix and length
 */
export const validatePrefixedId = (id: string, prefix: string): boolean => {
  if (!id.startsWith(prefix)) return false;
  const randomPart = id.substring(prefix.length);
  return randomPart.length === ID_LENGTH;
};

/**
 * Creates a custom zod validator for a prefixed ID
 * Used for validating IDs in API requests
 *
 * @param prefix The expected prefix
 * @param errorMessage Optional custom error message
 * @returns A zod refinement that validates the ID format
 */
export const createPrefixValidator = (
  prefix: string,
  errorMessage?: string
) => {
  return (schema: any) =>
    schema
      .startsWith(prefix, {
        message: errorMessage || `ID must start with ${prefix}`,
      })
      .refine((id: string) => validatePrefixedId(id, prefix), {
        message:
          errorMessage ||
          `ID must have exactly ${ID_LENGTH} characters after the prefix`,
      });
};
