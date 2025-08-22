/**
 * Generation templates for test data
 * Contains all data templates for the Lumen test data generator
 */

/**
 * Template interface that all templates must implement
 */
export interface DataTemplate {
  name: string;
  description: string;
  user: {
    name: string;
    email: string;
    password: string;
  };
  organization: {
    name: string;
    slug: string;
  };
  merchant: {
    legalName: string;
    displayName: string;
    supportEmail: string;
    billingEmail: string;
    defaultCurrency?: string;
    supportedCurrencies?: string[];
    timezone?: string;
    defaultPaymentTerms?: string;
    defaultPaymentMethods?: string[];
    taxId?: string;
    websiteUrl?: string;
    phoneNumber?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    stateProvince?: string;
    postalCode?: string;
    country?: string;
    invoicePrefix?: string;
    brandingSettings?: Record<string, string | number | boolean>;
    notificationPreferences?: Record<string, string | number | boolean>;
  };
  plans: PlanTemplate[];
}

/**
 * Feature definition interface for templates
 */
export interface FeatureDefinition {
  slug: string;
  displayName: string;
  featureValue: boolean | number | string;
  description?: string;
}

/**
 * Template for generating large-scale test data
 */
export interface LargeScaleTemplate extends Omit<DataTemplate, "plans"> {
  userTemplate: {
    name: string;
    email: string;
    password: string;
  };
  organizationTemplate: {
    name: string;
    slug: string;
  };
  merchantTemplate: {
    legalName: string;
    displayName: string;
    supportEmail: string;
    billingEmail: string;
    defaultCurrency?: string;
    supportedCurrencies?: string[];
    timezone?: string;
    defaultPaymentTerms?: string;
    defaultPaymentMethods?: string[];
  };
  planTemplates: {
    planName: string;
    planDescription: string;
    features: FeatureDefinition[];
    stablePlanId?: string;
    versionNumber?: number;
    commitMessage?: string;
  }[];
  priceTemplates: {
    currency: string;
    pricingData: {
      dsl_version: number;
      components: Array<
        | {
            type: "fixed";
            component_name: string;
            label: string;
            amount_cents: number;
            recurrence_rule: string;
            bill_immediately?: boolean;
          }
        | {
            type: "usage";
            component_name: string;
            label: string;
            unit_label: string;
            metric_id: string;
            unit_cost_cents: number;
            recurrence_rule: string;
            bill_immediately?: boolean;
          }
      >;
    };
    isOverridePrice?: boolean;
  }[];
  counts: {
    users: number;
    orgsPerUser: number;
    merchantsPerOrg: number;
    plansPerMerchant: number;
    pricesPerPlan: number;
  };
}

/**
 * Plan template interface
 */
export interface PlanTemplate {
  planName: string;
  planDescription: string;
  features: FeatureDefinition[];
  prices: PriceTemplate[];
  stablePlanId?: string;
  versionNumber?: number;
  commitMessage?: string;
}

/**
 * Price template interface
 */
export interface PriceTemplate {
  currency: string;
  pricingData: {
    dsl_version: number;
    components: Array<
      | {
          type: "fixed";
          component_name: string;
          label: string;
          amount_cents: number;
          recurrence_rule: string;
          bill_immediately?: boolean;
        }
      | {
          type: "usage";
          component_name: string;
          label: string;
          unit_label: string;
          metric_id: string;
          unit_cost_cents: number;
          recurrence_rule: string;
          bill_immediately?: boolean;
        }
    >;
  };
  isOverridePrice?: boolean;
}

/**
 * Minimal data template factory
 * Creates data for basic testing with three standard plans:
 * - One user
 * - One organization
 * - One merchant
 * - Three plans (Starter, Plus, Pro) with different prices
 */
export const getMinimalTemplate = (): DataTemplate => ({
  name: "minimal",
  description: "Minimal test data set with three standard pricing plans",

  // User options
  user: {
    name: "Test User",
    email: `test-user@withpretzel.com`,
    password: "password123!",
  },

  // Organization options
  organization: {
    name: `Test Organization ${Date.now()}`,
    slug: `test-org-${Date.now()}`,
  },

  // Merchant options
  merchant: {
    legalName: "Test Merchant Inc",
    displayName: "Test Merchant",
    supportEmail: "support@testmerchant.com",
    billingEmail: "billing@testmerchant.com",
    taxId: "DE123456789",
    websiteUrl: "https://testmerchant.com",
    phoneNumber: "+49 30 1234567",
    addressLine1: "Friedrichstraße 123",
    addressLine2: "Floor 4",
    city: "Berlin",
    stateProvince: "Berlin",
    postalCode: "10117",
    country: "Germany",
    defaultCurrency: "EUR",
    supportedCurrencies: ["EUR", "USD"],
    timezone: "Europe/Berlin",
    defaultPaymentTerms: "30",
    defaultPaymentMethods: ["card", "sepa_debit"],
    invoicePrefix: "TM",
    brandingSettings: {
      primaryColor: "#007AFF",
      logoUrl: "https://testmerchant.com/logo.png",
      companyName: "Test Merchant Inc",
    },
    notificationPreferences: {
      emailNotifications: true,
      smsNotifications: false,
      paymentReminders: true,
    },
  },

  // Plan options - FOUR plans (Free, Starter, Plus, Pro)
  plans: [
    {
      planName: "Free Plan",
      planDescription: "Get started with basic features at no cost",
      features: [
        {
          slug: "minimal-free-users",
          displayName: "Users",
          featureValue: 1,
        },
        {
          slug: "minimal-free-storage",
          displayName: "Storage",
          featureValue: "1GB",
        },
        {
          slug: "minimal-free-api-calls",
          displayName: "API Calls",
          featureValue: 100,
          description: "Monthly API call limit",
        },
        {
          slug: "minimal-free-premium",
          displayName: "Premium",
          featureValue: false,
        },
        {
          slug: "minimal-free-support",
          displayName: "Support",
          featureValue: "community",
        },
      ],
      prices: [
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "monthly_free_fee",
                label: "Monthly Free Plan",
                amount_cents: 0, // Free plan with zero cost
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
            ],
          },
        },
      ],
    },
    {
      planName: "Starter Plan",
      planDescription: "Perfect for getting started",
      features: [
        {
          slug: "minimal-starter-users",
          displayName: "Users",
          featureValue: 3,
        },
        {
          slug: "minimal-starter-storage",
          displayName: "Storage",
          featureValue: "5GB",
        },
        {
          slug: "minimal-starter-api-calls",
          displayName: "API Calls",
          featureValue: 1000,
          description: "Monthly API call limit",
        },
        {
          slug: "minimal-starter-premium",
          displayName: "Premium",
          featureValue: false,
        },
        {
          slug: "minimal-starter-support",
          displayName: "Support",
          featureValue: "email",
        },
      ],
      prices: [
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "monthly_starter_fee",
                label: "Monthly Starter Fee",
                amount_cents: 999,
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
              {
                type: "usage",
                component_name: "starter_api_calls",
                label: "API Calls",
                unit_label: "calls",
                metric_id: "api_calls_metric", // Will be created during generation
                unit_cost_cents: 1, // $0.01 per API call over the limit
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
            ],
          },
        },
      ],
    },
    {
      planName: "Plus Plan",
      planDescription: "More features for growing teams",
      features: [
        {
          slug: "minimal-plus-users",
          displayName: "Users",
          featureValue: 10,
        },
        {
          slug: "minimal-plus-storage",
          displayName: "Storage",
          featureValue: "20GB",
        },
        {
          slug: "minimal-plus-api-calls",
          displayName: "API Calls",
          featureValue: 5000,
          description: "Monthly API call limit",
        },
        {
          slug: "minimal-plus-premium",
          displayName: "Premium",
          featureValue: false,
        },
        {
          slug: "minimal-plus-support",
          displayName: "Support",
          featureValue: "priority",
        },
        {
          slug: "minimal-plus-integrations",
          displayName: "Integrations",
          featureValue: 3,
        },
      ],
      prices: [
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "monthly_plus_fee",
                label: "Monthly Plus Fee",
                amount_cents: 2999,
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
              {
                type: "usage",
                component_name: "plus_api_calls",
                label: "API Calls",
                unit_label: "calls",
                metric_id: "api_calls_metric", // Will be created during generation
                unit_cost_cents: 1, // $0.01 per API call over the limit
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
            ],
          },
        },
      ],
    },
    {
      planName: "Pro Plan",
      planDescription: "Advanced features for professional teams",
      features: [
        {
          slug: "minimal-pro-users",
          displayName: "Users",
          featureValue: 50,
        },
        {
          slug: "minimal-pro-storage",
          displayName: "Storage",
          featureValue: "100GB",
        },
        {
          slug: "minimal-pro-api-calls",
          displayName: "API Calls",
          featureValue: 25000,
          description: "Monthly API call limit",
        },
        {
          slug: "minimal-pro-premium",
          displayName: "Premium",
          featureValue: true,
        },
        {
          slug: "minimal-pro-support",
          displayName: "Support",
          featureValue: "dedicated",
        },
        {
          slug: "minimal-pro-integrations",
          displayName: "Integrations",
          featureValue: "unlimited",
        },
        {
          slug: "minimal-pro-analytics",
          displayName: "Advanced Analytics",
          featureValue: true,
        },
      ],
      prices: [
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "monthly_pro_fee",
                label: "Monthly Pro Fee",
                amount_cents: 9999,
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
                bill_immediately: false,
              },
              {
                type: "usage",
                component_name: "pro_api_calls",
                label: "API Calls",
                unit_label: "calls",
                metric_id: "api_calls_metric", // Will be created during generation
                unit_cost_cents: 1, // $0.01 per API call over the limit
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
            ],
          },
        },
      ],
    },
  ],
});

/**
 * Demo data template factory
 * Creates a more complete set of entities for demo purposes:
 * - One user
 * - One organization
 * - One merchant
 * - Three plans with multiple prices each
 */
export const getMediumTemplate = (): DataTemplate => ({
  name: "medium",
  description: "Medium dataset with multiple plans and pricing tiers",

  // User options
  user: {
    name: `Demo User ${Date.now()}`,
    email: `demo-${Date.now()}@example.com`,
    password: "password123!",
  },

  // Organization options
  organization: {
    name: `Demo Organization ${Date.now()}`,
    slug: `demo-org-${Date.now()}`,
  },

  // Merchant options
  merchant: {
    legalName: "Demo Merchant Inc",
    displayName: "Demo Merchant",
    supportEmail: "support@demomerchant.com",
    billingEmail: "billing@demomerchant.com",
    supportedCurrencies: ["USD", "EUR", "GBP"],
    defaultPaymentMethods: ["card", "bank_transfer"],
  },

  // Plan options
  plans: [
    {
      planName: `Basic Plan ${Date.now()}`,
      planDescription: "Perfect for individuals and small teams",
      stablePlanId: `basic-${Date.now()}`,
      features: [
        {
          slug: "medium-basic-users",
          displayName: "Users",
          featureValue: 5,
        },
        {
          slug: "medium-basic-storage",
          displayName: "Storage",
          featureValue: "10GB",
        },
        {
          slug: "medium-basic-premium",
          displayName: "Premium",
          featureValue: false,
        },
        {
          slug: "medium-basic-support",
          displayName: "Support",
          featureValue: "email",
        },
      ],
      prices: [
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "monthly_basic_fee_usd",
                label: "Monthly Basic Fee (USD)",
                amount_cents: 1999,
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
            ],
          },
        },
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "yearly_basic_fee_usd",
                label: "Annual Basic Fee (USD)",
                amount_cents: 19990,
                recurrence_rule:
                  "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
              },
            ],
          },
        },
        {
          currency: "EUR",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "monthly_basic_fee_eur",
                label: "Monthly Basic Fee (EUR)",
                amount_cents: 1799,
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
            ],
          },
        },
        {
          currency: "EUR",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "yearly_basic_fee_eur",
                label: "Annual Basic Fee (EUR)",
                amount_cents: 17990,
                recurrence_rule:
                  "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
              },
            ],
          },
        },
      ],
    },
    {
      planName: `Professional Plan ${Date.now()}`,
      planDescription: "Designed for growing businesses",
      stablePlanId: `pro-${Date.now()}`,
      features: [
        {
          slug: "medium-pro-users",
          displayName: "Users",
          featureValue: 10,
        },
        {
          slug: "medium-pro-storage",
          displayName: "Storage",
          featureValue: "50GB",
        },
        {
          slug: "medium-pro-premium",
          displayName: "Premium",
          featureValue: true,
        },
        {
          slug: "medium-pro-support",
          displayName: "Support",
          featureValue: "priority",
        },
      ],
      prices: [
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "monthly_pro_fee_usd",
                label: "Monthly Pro Fee (USD)",
                amount_cents: 4999,
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
            ],
          },
        },
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "yearly_pro_fee_usd",
                label: "Annual Pro Fee (USD)",
                amount_cents: 49990,
                recurrence_rule:
                  "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
              },
            ],
          },
        },
      ],
    },
    {
      planName: `Enterprise Plan ${Date.now()}`,
      planDescription: "For large organizations with advanced needs",
      stablePlanId: `enterprise-${Date.now()}`,
      features: [
        {
          slug: "medium-enterprise-users",
          displayName: "Users",
          featureValue: 50,
        },
        {
          slug: "medium-enterprise-storage",
          displayName: "Storage",
          featureValue: "500GB",
        },
        {
          slug: "medium-enterprise-premium",
          displayName: "Premium",
          featureValue: true,
        },
        {
          slug: "medium-enterprise-support",
          displayName: "Support",
          featureValue: "dedicated",
        },
        {
          slug: "medium-enterprise-integrations",
          displayName: "Custom Integrations",
          featureValue: true,
        },
      ],
      prices: [
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "monthly_enterprise_fee_usd",
                label: "Monthly Enterprise Fee (USD)",
                amount_cents: 19999,
                recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
              },
            ],
          },
        },
        {
          currency: "USD",
          pricingData: {
            dsl_version: 1,
            components: [
              {
                type: "fixed",
                component_name: "yearly_enterprise_fee_usd",
                label: "Annual Enterprise Fee (USD)",
                amount_cents: 199990,
                recurrence_rule:
                  "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
              },
            ],
          },
        },
      ],
    },
  ],
});

/**
 * Large-scale data template factory
 * Creates a large dataset for performance testing:
 * - Multiple users
 * - Multiple organizations per user
 * - Multiple merchants per organization
 * - Multiple plans per merchant
 * - Multiple prices per plan
 */
export const getLargeScaleTemplate = (): LargeScaleTemplate => ({
  name: "large-scale",
  description: "Large dataset for performance and scale testing",

  // User template
  user: {
    name: "Scale User",
    email: `scale-${Date.now()}@example.com`,
    password: "password123!",
  },

  userTemplate: {
    name: "Scale User",
    email: `scale-user-${Date.now()}@example.com`,
    password: "password123!",
  },

  // Organization template
  organization: {
    name: "Scale Organization",
    slug: `scale-org-${Date.now()}`,
  },

  organizationTemplate: {
    name: "Scale Organization",
    slug: `scale-org-${Date.now()}`,
  },

  // Merchant template
  merchant: {
    legalName: "Scale Merchant Inc",
    displayName: "Scale Merchant",
    supportEmail: "support@scalemerchant.com",
    billingEmail: "billing@scalemerchant.com",
    supportedCurrencies: ["USD", "EUR", "GBP", "JPY", "CAD"],
    defaultPaymentMethods: ["card", "bank_transfer", "paypal"],
  },

  merchantTemplate: {
    legalName: "Scale Merchant Inc",
    displayName: "Scale Merchant",
    supportEmail: "support@scalemerchant.com",
    billingEmail: "billing@scalemerchant.com",
    supportedCurrencies: ["USD", "EUR", "GBP", "JPY", "CAD"],
    defaultPaymentMethods: ["card", "bank_transfer", "paypal"],
  },

  // Plan templates
  planTemplates: [
    {
      planName: "Basic Scale",
      planDescription: "Entry level plan for scale testing",
      features: [
        {
          slug: "scale-basic-users",
          displayName: "Users",
          featureValue: 5,
        },
        {
          slug: "scale-basic-storage",
          displayName: "Storage",
          featureValue: "10GB",
        },
        {
          slug: "scale-basic-premium",
          displayName: "Premium",
          featureValue: false,
        },
      ],
    },
    {
      planName: "Pro Scale",
      planDescription: "Mid-tier plan for scale testing",
      features: [
        {
          slug: "scale-pro-users",
          displayName: "Users",
          featureValue: 20,
        },
        {
          slug: "scale-pro-storage",
          displayName: "Storage",
          featureValue: "100GB",
        },
        {
          slug: "scale-pro-premium",
          displayName: "Premium",
          featureValue: true,
        },
        {
          slug: "scale-pro-api",
          displayName: "API Calls",
          featureValue: 10000,
        },
      ],
    },
    {
      planName: "Enterprise Scale",
      planDescription: "Top-tier plan for scale testing",
      features: [
        {
          slug: "scale-enterprise-users",
          displayName: "Users",
          featureValue: 100,
        },
        {
          slug: "scale-enterprise-storage",
          displayName: "Storage",
          featureValue: "1TB",
        },
        {
          slug: "scale-enterprise-premium",
          displayName: "Premium",
          featureValue: true,
        },
        {
          slug: "scale-enterprise-api",
          displayName: "API Calls",
          featureValue: "unlimited",
        },
        {
          slug: "scale-enterprise-support",
          displayName: "Dedicated Support",
          featureValue: true,
        },
      ],
    },
  ],

  // Price templates
  priceTemplates: [
    {
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            component_name: "monthly_fee_usd",
            label: "Monthly Fee (USD)",
            amount_cents: 1999,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
          },
        ],
      },
    },
    {
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            component_name: "yearly_fee_usd",
            label: "Annual Fee (USD)",
            amount_cents: 19990,
            recurrence_rule:
              "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTHDAY=1;BYMONTH=1",
          },
        ],
      },
    },
    {
      currency: "EUR",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            component_name: "monthly_fee_eur",
            label: "Monthly Fee (EUR)",
            amount_cents: 1799,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
          },
        ],
      },
    },
    {
      currency: "GBP",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            type: "fixed",
            component_name: "monthly_fee_gbp",
            label: "Monthly Fee (GBP)",
            amount_cents: 1499,
            recurrence_rule: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
          },
        ],
      },
    },
  ],

  // Scale counts
  counts: {
    users: 2,
    orgsPerUser: 2,
    merchantsPerOrg: 2,
    plansPerMerchant: 3,
    pricesPerPlan: 2,
  },
});

// Export all template factories
export const templates = {
  minimal: getMinimalTemplate,
  medium: getMediumTemplate,
  largeScale: getLargeScaleTemplate,
};

// Export a function to get a template by name
export function getTemplate(name: string): DataTemplate | LargeScaleTemplate {
  const templateName = name.toLowerCase();
  if (templateName === "minimal") return getMinimalTemplate();
  if (templateName === "medium") return getMediumTemplate();
  if (templateName === "large-scale") return getLargeScaleTemplate();

  throw new Error(`Unknown template: ${name}`);
}
