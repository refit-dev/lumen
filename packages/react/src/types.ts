/**
 * Core types for Lumen React SDK
 */

// ============================================================================
// Subscription Types
// ============================================================================

export interface Customer {
  id: string;
  name: string | null;
  email: string | null;
  externalCustomerId: string | null;
}

export interface Subscription {
  id: string;
  planId: string;
  planName: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "paused";
  currentPeriodEnd: string | null;
  currentPeriodStart: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
}

export interface SubscriptionStatus {
  hasActiveSubscription: boolean;
  customer: Customer;
  subscription: Subscription;
}

// ============================================================================
// Entitlements Types
// ============================================================================

export type EntitlementSource = "plan" | "override" | "default" | "credits";

export interface Feature {
  slug: string;
  value: boolean | string | number | null;
}

export interface CreditInfo {
  creditAllowance: number;
  creditsRemaining: number;
  nextExpiryDate: Date | null;
}

export interface Usage {
  metricId: string;
  usage: number;
}

export interface FeatureEntitlement {
  entitled: boolean | null;
  feature: Feature | null;
  source: EntitlementSource | null;
  usages?: Usage[];
  creditInfo?: CreditInfo;
}

export interface EntitlementsResponse {
  entitlements: FeatureEntitlement[];
}

// ============================================================================
// Customer Portal Types
// ============================================================================

export interface PaymentMethod {
  id: string;
  type: string;
  last4?: string;
  brand?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault: boolean;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  dueDate: string | null;
  paidAt: string | null;
  invoiceDate: string;
  pdfUrl?: string;
}

export interface CustomerOverview {
  customer: Customer;
  subscription: Subscription | null;
  paymentMethods: PaymentMethod[];
  upcomingInvoice: Invoice | null;
  recentInvoices: Invoice[];
}

// ============================================================================
// Hook Configuration Types
// ============================================================================

export interface LumenConfig {
  /**
   * Base URL for the Lumen API proxy
   * Should point to your backend's Lumen handler endpoint
   * @example "/api/lumen"
   */
  apiProxyUrl: string;

  /**
   * Disable automatic retries on failed requests
   * @default false
   */
  disableRetry?: boolean;

  /**
   * Number of retries for failed requests
   * @default 2
   */
  retryCount?: number;

  /**
   * Delay between retries in milliseconds
   * @default 1000
   */
  retryDelay?: number;
}

export interface UseQueryOptions {
  /**
   * Enable automatic refetching
   * @default false
   */
  enabled?: boolean;

  /**
   * Refetch interval in milliseconds
   * @default undefined (no automatic refetching)
   */
  refetchInterval?: number;

  /**
   * Refetch on window focus
   * @default false
   */
  refetchOnWindowFocus?: boolean;

  /**
   * Callback when data is fetched successfully
   */
  onSuccess?: (data: any) => void;

  /**
   * Callback when an error occurs
   */
  onError?: (error: Error) => void;
}

// ============================================================================
// Utility Types
// ============================================================================

export interface FormattedUsage {
  used: number;
  limit: number | null;
  percentage: number | null;
  formatted: string;
  isUnlimited: boolean;
}

export interface UpgradeReason {
  reason: string;
  severity: "warning" | "critical" | "info";
  percentage?: number;
}

// ============================================================================
// Credit Top-Up Types
// ============================================================================

export type TopupExpiryBehavior = "billing_cycle" | "custom_days" | "never";

export interface AvailableTopup {
  creditDefinitionId: string;
  featureName: string;
  featureSlug: string;
  currentUsage: number;
  creditsRemaining: number;
  creditAllowance: number;
  topupPricePerCreditCents: number;
  minQuantity: number;
  maxQuantity: number | null;
  currency: string;
  expiryBehavior: TopupExpiryBehavior;
  estimatedExpiryDate: string | null;
}

export interface AvailableTopupsResponse {
  availableTopups: AvailableTopup[];
}

export interface TopupPurchaseResult {
  success: boolean;
  payment: {
    id: string;
    status: string;
  };
  // Credits are pending until webhook confirms payment
  expectedCredits: {
    quantity: number;
    expiryDate: string | null;
  };
  totalAmountCents: number;
  currency: string;
}
