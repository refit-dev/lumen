export * from "./UsageBadge";
export * from "./pricing-table";
export * from "./pricing-table-cards";
export * from "./PaymentModal";
export * from "./CustomerPortal";
export * from "./types";
export {
  currencySymbol,
  getErrorMessage,
  validateEmail,
  sanitizeInitialCustomer,
} from "../lib/utils";

// Helper functions
export { fetchPricingTable, fetchSubscriptionStatus } from "./pricing-table";

// Explicit re-exports for UI parity with shadcn component
export { PricingTableCards as PricingTableShadcnCards } from "./pricing-table-cards";
export { PaymentModal as PricingTableShadcnPaymentModal } from "./PaymentModal";
export { CustomerPortal as CustomerPortalShadcn } from "./CustomerPortal";

export type { InitialCustomer } from "./types";
