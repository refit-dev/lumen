export interface Feature {
  text: string;
}

export interface Plan {
  title: string;
  description?: string;
  price: number;
  priceMonthly?: number;
  priceYearly?: number;
  interval: string;
  // Optional: minimum number of seats billed up-front for seat-based plans
  minSeats?: number;
  features?: Feature[];
  buttonText: string;
  buttonOutline?: boolean;
  isPopular?: boolean;
  popularText?: string;
  currency?: string;
  planId?: string;
  priceId?: string;
  priceIdMonthly?: string;
  priceIdYearly?: string;
  isEnterprisePlan?: boolean;
  enterpriseRedirectUrl?: string;
  selectedBillingInterval?: "monthly" | "yearly";
  selectedPrice?: number;
  // Trial information
  trial?: {
    available: boolean;
    days: number;
    trialPlanId: string;
  };
  // Pricing data with components for detailed pricing information
  pricingData?: {
    components: Array<{
      type: "fixed" | "per_unit" | "usage";
      label?: string;
      amount_cents?: number; // for fixed/per_unit components
      unit_cost_cents?: number; // for usage components
      component_name?: string;
      unit_label?: string;
      metric_id?: string;
      [key: string]: unknown;
    }>;
    dsl_version?: number;
  };
  pspPlanId?: string;
}

export interface PricingTableProps {
  heading?: string;
  description?: string;
  plans: Plan[];
}

// Optional customer information that can be provided upfront to prefill the
// checkout/customer details form when the modal opens.
export interface InitialCustomer {
  email?: string;
  name?: string;
  businessName?: string;
  address?: string;
  addressLine2?: string;
  zip?: string;
  city?: string;
  country?: string; // ISO 2 code (e.g., "US", "DE")
  stateProvince?: string; // e.g., "CA" or state/province name
  taxId?: string;
  isBusiness?: boolean;
}
