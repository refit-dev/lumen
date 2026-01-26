"use client";

// Lumen Billing pricing table component. Learn more at https://docs.getlumen.dev
import * as React from "react";
import { useState, useEffect, useRef } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, Stripe } from "@stripe/stripe-js";
import {
  AlertCircle,
  Check,
  Loader2,
  X,
  ChevronDown,
  Search,
  CreditCard,
  Plus,
  Coins,
  RefreshCw,
} from "lucide-react";
import { createPortal } from "react-dom";
import { DodoPayments } from "dodopayments-checkout";

// shadcn/ui components (only from same folder)
import { Badge } from "./badge";
import { Button } from "./button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";
import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { Label } from "./label";
import { Switch } from "./switch";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "./table";

// ----------------------------------------------------------------------------
// INLINE TYPES & SCHEMAS (self-contained)
// ----------------------------------------------------------------------------

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

export interface PricingTableProps {
  heading?: string;
  description?: string;
  plans: Plan[];
}

// ----------------------------------------------------------------------------
// CREDIT TOP-UP TYPES
// ----------------------------------------------------------------------------

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

export interface TopupPurchaseResult {
  success: boolean;
  creditGrant: {
    id: string;
    initialAmount: number;
    expiryDate: string | null;
  };
  invoice: {
    id: string;
    customerInvoiceNumber: string | null;
    totalAmountCents: number;
    status: string;
  };
  payment: {
    id: string | null;
    status: string;
  };
}

const clampTopupQuantity = (
  value: string | number,
  minQuantity: number,
  maxQuantity?: number | null
): number => {
  const parsed = parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return minQuantity;
  }
  const capped =
    typeof maxQuantity === "number" ? Math.min(parsed, maxQuantity) : parsed;
  return Math.max(minQuantity, capped);
};

// Simple validation function (replacing Zod)
const validatePricingTableData = (data: unknown): data is PricingTableProps => {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.plans)) return false;

  return d.plans.every((plan) => {
    if (!plan || typeof plan !== "object") return false;
    const p = plan as Record<string, unknown>;
    return (
      typeof p.title === "string" &&
      typeof p.buttonText === "string" &&
      typeof p.price === "number" &&
      typeof p.interval === "string"
    );
  });
};

// Sanitizes the initial customer data to prevent invalid data types from causing errors.
const sanitizeInitialCustomer = (
  customer: unknown
): InitialCustomer | undefined => {
  if (!customer || typeof customer !== "object") {
    return undefined;
  }

  const c = customer as Record<string, unknown>;
  const sanitized: InitialCustomer = {};

  if (typeof c.email === "string") sanitized.email = c.email;
  if (typeof c.name === "string") sanitized.name = c.name;
  if (typeof c.businessName === "string")
    sanitized.businessName = c.businessName;
  if (typeof c.address === "string") sanitized.address = c.address;
  if (typeof c.addressLine2 === "string")
    sanitized.addressLine2 = c.addressLine2;
  if (typeof c.zip === "string") sanitized.zip = c.zip;
  if (typeof c.city === "string") sanitized.city = c.city;
  if (typeof c.country === "string") sanitized.country = c.country;
  if (typeof c.stateProvince === "string")
    sanitized.stateProvince = c.stateProvince;
  if (typeof c.taxId === "string") sanitized.taxId = c.taxId;
  if (typeof c.isBusiness === "boolean") sanitized.isBusiness = c.isBusiness;

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

// ----------------------------------------------------------------------------
// INLINE COMPONENTS (self-contained)
// ----------------------------------------------------------------------------

// Simple Alert component (inline to avoid import issues)
const Alert: React.FC<{
  variant?: "destructive" | "default";
  className?: string;
  children: React.ReactNode;
}> = ({ variant = "default", className = "", children }) => (
  <div
    className={`relative w-full rounded-lg border p-4 ${
      variant === "destructive"
        ? "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive"
        : "border-border"
    } ${className}`}
  >
    {children}
  </div>
);

const AlertDescription: React.FC<{
  className?: string;
  children: React.ReactNode;
}> = ({ className = "", children }) => (
  <div className={`text-sm [&_p]:leading-relaxed ${className}`}>{children}</div>
);

const AlertTitle: React.FC<{
  className?: string;
  children: React.ReactNode;
}> = ({ className = "", children }) => (
  <h5 className={`mb-1 font-medium leading-none tracking-tight ${className}`}>
    {children}
  </h5>
);

// Simple Progress component (inline)
const Progress: React.FC<{
  value?: number;
  max?: number;
  className?: string;
}> = ({ value = 0, max = 100, className = "" }) => {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);
  return (
    <div
      className={`relative h-2 w-full overflow-hidden rounded-full bg-primary/20 ${className}`}
    >
      <div
        className="h-full bg-primary transition-all duration-300 ease-in-out"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
};

// Simple CloseButton component (inline)
const CloseButton: React.FC<{
  onClick?: () => void;
  "aria-label"?: string;
  children: React.ReactNode;
  className?: string;
}> = ({ onClick, "aria-label": ariaLabel, children, className = "" }) => (
  <button
    onClick={onClick}
    aria-label={ariaLabel}
    className={`absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none ${className}`}
  >
    <X className="h-4 w-4" />
    <span className="sr-only">{children}</span>
  </button>
);

// Added: stable overlay component to prevent remounting on each render
const Overlay: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
    {children}
  </div>
);

// (Removed top banner variant in favor of a centered result overlay)

// Result overlay shown after the Stripe modal closes to clearly communicate outcome
const ResultOverlay: React.FC<{
  type: "success" | "error";
  message: string;
  countdownSeconds?: number | null;
  onClose?: () => void;
}> = ({ type, message, countdownSeconds, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden border border-gray-100">
        <div
          className={cn(
            "px-6 py-5 flex items-center gap-3",
            type === "success" ? "bg-green-600" : "bg-red-600"
          )}
        >
          <div className="text-white">
            {type === "success" ? (
              <Check className="h-5 w-5" />
            ) : (
              <AlertCircle className="h-5 w-5" />
            )}
          </div>
          <h3 className="text-white font-medium text-base flex-1">
            {type === "success" ? "Payment Successful!" : "Payment Failed"}
          </h3>
          {onClose && (
            <button
              onClick={onClose}
              className="text-white/90 hover:text-white hover:bg-white/10 rounded-full p-1 transition-colors"
              aria-label="Close notification"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="px-6 py-5">
          <p className="text-gray-600 text-sm leading-relaxed">{message}</p>
          {typeof countdownSeconds === "number" && countdownSeconds >= 0 && (
            <p className="text-xs text-gray-500 mt-3 font-medium">
              Redirecting in {countdownSeconds} seconds...
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// UTILITY FUNCTIONS (inline)
// ----------------------------------------------------------------------------

// Utility function for merging class names
const cn = (...classes: (string | undefined | null | false)[]): string => {
  return classes.filter(Boolean).join(" ");
};

export const currencySymbol = (currency: string): string => {
  switch (currency.toLowerCase()) {
    case "usd":
      return "$";
    case "eur":
      return "€";
    case "gbp":
      return "£";
    case "cad":
      return "C$";
    case "aud":
      return "A$";
    default:
      return currency.toUpperCase();
  }
};

const validateEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Utility function to safely extract error message from various error types
const getErrorMessage = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    // Handle API error responses that might have different structures
    const errorObj = error as Record<string, unknown>;

    if (typeof errorObj.error === "string") {
      return errorObj.error;
    }

    if (typeof errorObj.message === "string") {
      return errorObj.message;
    }

    if (typeof errorObj.details === "string") {
      return errorObj.details;
    }

    // If error is an object but doesn't have expected string properties, stringify it
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error occurred";
    }
  }

  return "Unknown error occurred";
};

// ----------------------------------------------------------------------------
// COUNTRIES AND STATES DATA (inline)
// ----------------------------------------------------------------------------

const usStates = [
  { value: "AL", label: "Alabama" },
  { value: "AK", label: "Alaska" },
  { value: "AZ", label: "Arizona" },
  { value: "AR", label: "Arkansas" },
  { value: "CA", label: "California" },
  { value: "CO", label: "Colorado" },
  { value: "CT", label: "Connecticut" },
  { value: "DE", label: "Delaware" },
  { value: "FL", label: "Florida" },
  { value: "GA", label: "Georgia" },
  { value: "HI", label: "Hawaii" },
  { value: "ID", label: "Idaho" },
  { value: "IL", label: "Illinois" },
  { value: "IN", label: "Indiana" },
  { value: "IA", label: "Iowa" },
  { value: "KS", label: "Kansas" },
  { value: "KY", label: "Kentucky" },
  { value: "LA", label: "Louisiana" },
  { value: "ME", label: "Maine" },
  { value: "MD", label: "Maryland" },
  { value: "MA", label: "Massachusetts" },
  { value: "MI", label: "Michigan" },
  { value: "MN", label: "Minnesota" },
  { value: "MS", label: "Mississippi" },
  { value: "MO", label: "Missouri" },
  { value: "MT", label: "Montana" },
  { value: "NE", label: "Nebraska" },
  { value: "NV", label: "Nevada" },
  { value: "NH", label: "New Hampshire" },
  { value: "NJ", label: "New Jersey" },
  { value: "NM", label: "New Mexico" },
  { value: "NY", label: "New York" },
  { value: "NC", label: "North Carolina" },
  { value: "ND", label: "North Dakota" },
  { value: "OH", label: "Ohio" },
  { value: "OK", label: "Oklahoma" },
  { value: "OR", label: "Oregon" },
  { value: "PA", label: "Pennsylvania" },
  { value: "RI", label: "Rhode Island" },
  { value: "SC", label: "South Carolina" },
  { value: "SD", label: "South Dakota" },
  { value: "TN", label: "Tennessee" },
  { value: "TX", label: "Texas" },
  { value: "UT", label: "Utah" },
  { value: "VT", label: "Vermont" },
  { value: "VA", label: "Virginia" },
  { value: "WA", label: "Washington" },
  { value: "WV", label: "West Virginia" },
  { value: "WI", label: "Wisconsin" },
  { value: "WY", label: "Wyoming" },
  { value: "DC", label: "District of Columbia" },
];

export const customerCountries = [
  { value: "AL", label: "Albania" },
  { value: "AD", label: "Andorra" },
  { value: "AG", label: "Antigua and Barbuda" },
  { value: "AR", label: "Argentina" },
  { value: "AM", label: "Armenia" },
  { value: "AW", label: "Aruba" },
  { value: "AU", label: "Australia" },
  { value: "AT", label: "Austria" },
  { value: "AZ", label: "Azerbaijan" },
  { value: "BS", label: "Bahamas" },
  { value: "BH", label: "Bahrain" },
  { value: "BD", label: "Bangladesh" },
  { value: "BE", label: "Belgium" },
  { value: "BZ", label: "Belize" },
  { value: "BJ", label: "Benin" },
  { value: "BM", label: "Bermuda" },
  { value: "BT", label: "Bhutan" },
  { value: "BO", label: "Bolivia" },
  { value: "BA", label: "Bosnia and Herzegovina" },
  { value: "BW", label: "Botswana" },
  { value: "BR", label: "Brazil" },
  { value: "BN", label: "Brunei Darussalam" },
  { value: "BI", label: "Burundi" },
  { value: "KH", label: "Cambodia" },
  { value: "CA", label: "Canada" },
  { value: "CV", label: "Cape Verde" },
  { value: "TD", label: "Chad" },
  { value: "CL", label: "Chile" },
  { value: "CN", label: "China" },
  { value: "CO", label: "Colombia" },
  { value: "KM", label: "Comoros" },
  { value: "CR", label: "Costa Rica" },
  { value: "CW", label: "Curaçao" },
  { value: "CY", label: "Cyprus" },
  { value: "CZ", label: "Czech Republic" },
  { value: "DK", label: "Denmark" },
  { value: "DJ", label: "Djibouti" },
  { value: "DM", label: "Dominica" },
  { value: "DO", label: "Dominican Republic" },
  { value: "EC", label: "Ecuador" },
  { value: "EG", label: "Egypt" },
  { value: "SV", label: "El Salvador" },
  { value: "GQ", label: "Equatorial Guinea" },
  { value: "ER", label: "Eritrea" },
  { value: "EE", label: "Estonia" },
  { value: "ET", label: "Ethiopia" },
  { value: "FJ", label: "Fiji" },
  { value: "FI", label: "Finland" },
  { value: "FR", label: "France" },
  { value: "PF", label: "French Polynesia" },
  { value: "GA", label: "Gabon" },
  { value: "GM", label: "Gambia" },
  { value: "GE", label: "Georgia" },
  { value: "DE", label: "Germany" },
  { value: "GH", label: "Ghana" },
  { value: "GR", label: "Greece" },
  { value: "GL", label: "Greenland" },
  { value: "GD", label: "Grenada" },
  { value: "GT", label: "Guatemala" },
  { value: "GN", label: "Guinea" },
  { value: "GW", label: "Guinea-Bissau" },
  { value: "GY", label: "Guyana" },
  { value: "HK", label: "Hong Kong" },
  { value: "HN", label: "Honduras" },
  { value: "HU", label: "Hungary" },
  { value: "IS", label: "Iceland" },
  { value: "IN", label: "India" },
  { value: "ID", label: "Indonesia" },
  { value: "IQ", label: "Iraq" },
  { value: "IE", label: "Ireland" },
  { value: "IL", label: "Israel" },
  { value: "IT", label: "Italy" },
  { value: "JP", label: "Japan" },
  { value: "KZ", label: "Kazakhstan" },
  { value: "KI", label: "Kiribati" },
  { value: "KW", label: "Kuwait" },
  { value: "LA", label: "Laos" },
  { value: "LV", label: "Latvia" },
  { value: "LS", label: "Lesotho" },
  { value: "LR", label: "Liberia" },
  { value: "LI", label: "Liechtenstein" },
  { value: "LT", label: "Lithuania" },
  { value: "LU", label: "Luxembourg" },
  { value: "MK", label: "North Macedonia" },
  { value: "MO", label: "Macau" },
  { value: "MG", label: "Madagascar" },
  { value: "MW", label: "Malawi" },
  { value: "MY", label: "Malaysia" },
  { value: "MV", label: "Maldives" },
  { value: "MT", label: "Malta" },
  { value: "MH", label: "Marshall Islands" },
  { value: "MR", label: "Mauritania" },
  { value: "MU", label: "Mauritius" },
  { value: "MX", label: "Mexico" },
  { value: "FM", label: "Micronesia" },
  { value: "MN", label: "Mongolia" },
  { value: "ME", label: "Montenegro" },
  { value: "MA", label: "Morocco" },
  { value: "NR", label: "Nauru" },
  { value: "NP", label: "Nepal" },
  { value: "NL", label: "Netherlands" },
  { value: "NC", label: "New Caledonia" },
  { value: "NZ", label: "New Zealand" },
  { value: "NE", label: "Niger" },
  { value: "NG", label: "Nigeria" },
  { value: "NO", label: "Norway" },
  { value: "OM", label: "Oman" },
  { value: "PW", label: "Palau" },
  { value: "PG", label: "Papua New Guinea" },
  { value: "PY", label: "Paraguay" },
  { value: "PE", label: "Peru" },
  { value: "PH", label: "Philippines" },
  { value: "PL", label: "Poland" },
  { value: "PT", label: "Portugal" },
  { value: "PR", label: "Puerto Rico" },
  { value: "QA", label: "Qatar" },
  { value: "RO", label: "Romania" },
  { value: "RW", label: "Rwanda" },
  { value: "KN", label: "Saint Kitts and Nevis" },
  { value: "LC", label: "Saint Lucia" },
  { value: "VC", label: "Saint Vincent and the Grenadines" },
  { value: "WS", label: "Samoa" },
  { value: "SM", label: "San Marino" },
  { value: "ST", label: "Sao Tome and Principe" },
  { value: "SA", label: "Saudi Arabia" },
  { value: "RS", label: "Serbia" },
  { value: "SC", label: "Seychelles" },
  { value: "SL", label: "Sierra Leone" },
  { value: "SG", label: "Singapore" },
  { value: "SX", label: "Sint Maarten" },
  { value: "SK", label: "Slovakia" },
  { value: "SI", label: "Slovenia" },
  { value: "SB", label: "Solomon Islands" },
  { value: "KR", label: "South Korea" },
  { value: "ES", label: "Spain" },
  { value: "LK", label: "Sri Lanka" },
  { value: "SR", label: "Suriname" },
  { value: "SE", label: "Sweden" },
  { value: "CH", label: "Switzerland" },
  { value: "TW", label: "Taiwan" },
  { value: "TJ", label: "Tajikistan" },
  { value: "TZ", label: "Tanzania" },
  { value: "TH", label: "Thailand" },
  { value: "TL", label: "Timor-Leste" },
  { value: "TG", label: "Togo" },
  { value: "TO", label: "Tonga" },
  { value: "TN", label: "Tunisia" },
  { value: "TR", label: "Turkey" },
  { value: "TV", label: "Tuvalu" },
  { value: "AE", label: "United Arab Emirates" },
  { value: "GB", label: "United Kingdom" },
  { value: "US", label: "United States" },
  { value: "UY", label: "Uruguay" },
  { value: "UZ", label: "Uzbekistan" },
  { value: "SZ", label: "Eswatini" },
  { value: "ZM", label: "Zambia" },
];

interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  required?: boolean;
}

const SearchableSelect: React.FC<SearchableSelectProps> = ({
  options,
  value,
  onValueChange,
  placeholder,
  className,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredOptions = options.filter((option) =>
    option.label.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const selectedOption = options.find((option) => option.value === value);

  const checkDropdownPosition = () => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const dropdownMaxHeight = 350;
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;

    const openUp = spaceBelow < dropdownMaxHeight && spaceAbove > spaceBelow;

    const top = openUp
      ? Math.max(8, rect.top - dropdownMaxHeight)
      : rect.bottom;

    setDropdownStyle({
      position: "fixed",
      left: rect.left,
      top,
      width: rect.width,
      zIndex: 9999,
    });
  };

  const handleToggle = () => {
    if (!isOpen) {
      checkDropdownPosition();
    }
    setIsOpen(!isOpen);
    if (!isOpen) {
      setSearchTerm("");
      setHighlightedIndex(-1);
    }
  };

  const handleSelect = (selectedValue: string) => {
    onValueChange?.(selectedValue);
    setIsOpen(false);
    setSearchTerm("");
    setHighlightedIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "Escape":
        setIsOpen(false);
        setSearchTerm("");
        setHighlightedIndex(-1);
        break;
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < filteredOptions.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedIndex >= 0) {
          handleSelect(filteredOptions[highlightedIndex].value);
        }
        break;
    }
  };

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSearchTerm("");
        setHighlightedIndex(-1);
      }
    };

    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-white px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          !selectedOption && "text-muted-foreground"
        )}
        onClick={handleToggle}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <span className="truncate">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 opacity-50 transition-transform",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {isOpen &&
        createPortal(
          <div
            style={dropdownStyle}
            className="rounded-md border bg-white shadow-2xl"
          >
            <div className="flex items-center border-b px-3 py-2">
              <Search className="h-4 w-4 text-gray-400 mr-2" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setHighlightedIndex(-1);
                }}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
              />
            </div>
            <div className="max-h-[300px] overflow-y-auto">
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-2 text-sm text-gray-500">
                  No options found
                </div>
              ) : (
                filteredOptions.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      "flex w-full items-center px-3 py-2 text-sm text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none",
                      highlightedIndex === index && "bg-gray-100",
                      value === option.value &&
                        "bg-blue-50 text-blue-600 font-medium"
                    )}
                    onClick={() => handleSelect(option.value)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                  >
                    <span className="flex-1 truncate">{option.label}</span>
                    {value === option.value && (
                      <Check className="h-4 w-4 ml-2 text-blue-600" />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Helper: fetch pricing table data
// ----------------------------------------------------------------------------

export async function fetchPricingTable({
  slug,
  lumenPublishableKey,
  apiBaseUrl = "https://api.getlumen.dev/v1",
}: {
  slug?: string;
  lumenPublishableKey: string;
  apiBaseUrl?: string;
}): Promise<PricingTableProps> {
  try {
    const url = slug
      ? `${apiBaseUrl}/public/pricing-tables/${slug}`
      : `${apiBaseUrl}/public/pricing-tables`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Lumen-Key": lumenPublishableKey,
      },
    });

    if (!response.ok) {
      let errorMessage = `Failed to fetch pricing table (${response.status})`;
      try {
        const errorData = await response.json();
        errorMessage = getErrorMessage(errorData) || errorMessage;
      } catch {
        // If response body is not JSON, use the status-based message
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    return data.pricingTable;
  } catch (error) {
    console.error("Error fetching pricing table:", error);
    // Re-throw with consistent error message format
    throw new Error(getErrorMessage(error));
  }
}

export async function fetchSubscriptionStatus({
  externalCustomerId,
  lumenHandlerUrl,
}: {
  externalCustomerId: string;
  lumenHandlerUrl: string;
}) {
  try {
    const url = `${lumenHandlerUrl}/customers/subscription-status?externalCustomerId=${encodeURIComponent(externalCustomerId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include", // Include cookies and auth headers for session-based auth
    });

    if (!response.ok) {
      let errorMessage = `Failed to fetch subscription status (${response.status})`;
      try {
        const errorData = await response.json();
        errorMessage = getErrorMessage(errorData) || errorMessage;
      } catch {
        // If response body is not JSON, use the status-based message
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching subscription status:", error);
    return null;
  }
}

// ----------------------------------------------------------------------------
// PricingTableCards
// ----------------------------------------------------------------------------

interface Customer {
  id: string;
  name: string | null;
  email: string | null;
}

interface Subscription {
  id: string;
  planId: string;
  planName: string;
  status: string;
}

interface SubscriptionStatus {
  hasActiveSubscription: boolean;
  customer: Customer;
  subscription: Subscription;
}

interface PricingTableCardsProps {
  heading?: string;
  description?: string;
  plans: Plan[];
  className?: string;
  setSelectedPlan?: (plan: Plan) => void;
  subscriptionStatus?: SubscriptionStatus | null;
}

export const PricingTableCards = ({
  heading,
  description,
  plans,
  className,
  setSelectedPlan,
  subscriptionStatus,
}: PricingTableCardsProps) => {
  const [isYearly, setIsYearly] = useState(false);
  const initializedYearlyRef = useRef(false);

  const getGridColumnsClass = () => {
    const grid: Record<number, string> = {
      1: "grid-cols-1",
      2: "grid-cols-1 md:grid-cols-2",
      3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
      4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
    };
    return grid[plans.length] || "grid-cols-1 md:grid-cols-2 lg:grid-cols-3";
  };

  const nonEnterprisePlans = plans.filter((plan) => !plan.isEnterprisePlan);
  const usingPreviewData = !setSelectedPlan;
  const shouldShowYearlyToggle =
    nonEnterprisePlans.length > 0 &&
    nonEnterprisePlans.every(
      (plan) =>
        plan.priceMonthly !== undefined &&
        plan.priceYearly !== undefined &&
        (usingPreviewData || !!plan.priceIdYearly)
    );

  useEffect(() => {
    if (shouldShowYearlyToggle) {
      if (!initializedYearlyRef.current) {
        setIsYearly(true);
        initializedYearlyRef.current = true;
      }
    } else {
      setIsYearly(false);
      initializedYearlyRef.current = false;
    }
  }, [shouldShowYearlyToggle]);

  const discountPercentage = (plan: Plan) => {
    if (plan.isEnterprisePlan || !isYearly) return null;
    if (plan.priceMonthly && plan.priceYearly) {
      const yearlyMonthly = plan.priceYearly / 12;
      return Math.round(
        ((plan.priceMonthly - yearlyMonthly) / plan.priceMonthly) * 100
      );
    }
    return null;
  };

  const maxDiscountPercentage = Math.max(
    ...plans.map((p) => discountPercentage(p) || 0)
  );

  // Function to check if this plan is the user's current plan
  const isCurrentPlan = (plan: Plan) => {
    return (
      subscriptionStatus?.hasActiveSubscription &&
      subscriptionStatus.subscription.planId === plan.planId
    );
  };

  // Function to get button text based on subscription status and plan relationship
  const getButtonText = (plan: Plan) => {
    if (plan.isEnterprisePlan) {
      return plan.buttonText || "Contact Sales";
    }

    if (!subscriptionStatus?.hasActiveSubscription) {
      return plan.trial?.available ? "Start Free Trial" : plan.buttonText;
    }

    const currentPlan = isCurrentPlan(plan);
    if (currentPlan) {
      return "Current Plan";
    }

    // Could add logic here to determine if it's an upgrade or downgrade
    // For now, we'll use generic text
    return "Switch to Plan";
  };

  return (
    <div
      className={`container px-4 py-12 mx-auto max-w-6xl ${className ?? ""}`}
    >
      {heading && (
        <div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
            {heading}
          </h2>
          {description && (
            <p className="mt-4 text-lg text-muted-foreground max-w-2xl">
              {description}
            </p>
          )}
        </div>
      )}

      {shouldShowYearlyToggle && (
        <div className="relative w-full flex items-center justify-center mt-8 mb-8">
          <div className="relative inline-flex items-center space-x-3">
            <Switch checked={isYearly} onCheckedChange={setIsYearly} />
            <span
              className={`text-sm ${isYearly ? "text-foreground" : "text-muted-foreground"}`}
            >
              Pay yearly
            </span>
            {maxDiscountPercentage > 0 && (
              <Badge
                variant="secondary"
                className="absolute left-full ml-2 top-1/2 -translate-y-1/2"
              >
                Save {maxDiscountPercentage}%
              </Badge>
            )}
          </div>
        </div>
      )}

      <div
        className={`grid ${getGridColumnsClass()} gap-6 lg:gap-8 justify-center justify-items-center`}
      >
        {plans.map((plan, i) => {
          const currentPlan = isCurrentPlan(plan);

          return (
            <Card
              key={i}
              className={`flex flex-col justify-between relative min-h-[500px] ${
                currentPlan ? "ring-2 ring-blue-500 shadow-lg" : ""
              } w-full max-w-[560px] mx-auto`}
            >
              {plan.isPopular && !currentPlan && (
                <Badge className="absolute -top-2 right-4">
                  {plan.popularText || "Popular"}
                </Badge>
              )}
              {currentPlan && (
                <Badge className="absolute -top-2 right-4 bg-blue-500">
                  Current Plan
                </Badge>
              )}
              {plan.trial?.available && !currentPlan && (
                <Badge
                  variant="secondary"
                  className={`absolute -top-2 ${plan.isPopular ? "right-20" : "right-4"} bg-green-100 text-green-800 border-green-300`}
                >
                  {plan.trial.days}-day free trial
                </Badge>
              )}
              <CardHeader>
                <CardTitle className="text-xl">{plan.title}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
                {!plan.isEnterprisePlan && (
                  <div className="mt-4">
                    <div className="flex items-end space-x-2">
                      <span className="text-4xl font-bold">
                        {(() => {
                          const hasFixedPrice =
                            (plan.priceMonthly ?? plan.price) > 0 ||
                            (plan.priceYearly ?? 0) > 0;
                          const hasUsagePrice =
                            plan.pricingData?.components?.some(
                              (comp) => comp.type === "usage"
                            );

                          if (!hasFixedPrice && !hasUsagePrice) {
                            return "Free";
                          } else if (!hasFixedPrice && hasUsagePrice) {
                            return "Pay as you go";
                          } else {
                            return (
                              <>
                                {plan.currency
                                  ? currencySymbol(plan.currency)
                                  : "€"}
                                {isYearly && plan.priceYearly
                                  ? (plan.priceYearly / 12).toFixed(2)
                                  : (
                                      (plan.priceMonthly ?? plan.price) ||
                                      0
                                    ).toFixed(2)}
                              </>
                            );
                          }
                        })()}
                      </span>
                      <span className="text-xl text-muted-foreground mb-1">
                        {(() => {
                          const hasFixedPrice =
                            (plan.priceMonthly ?? plan.price) > 0 ||
                            (plan.priceYearly ?? 0) > 0;
                          const hasUsagePrice =
                            plan.pricingData?.components?.some(
                              (comp) => comp.type === "usage"
                            );

                          if (!hasFixedPrice && !hasUsagePrice) {
                            return "";
                          } else if (!hasFixedPrice && hasUsagePrice) {
                            return "";
                          } else if (hasFixedPrice && hasUsagePrice) {
                            return `/${plan.interval || "month"} + usage`;
                          } else {
                            return `/${plan.interval || "month"}`;
                          }
                        })()}
                      </span>
                    </div>
                    {/* Minimum seats & overage info for seat-based plans */}
                    {plan.interval?.includes("per seat") &&
                      plan.minSeats !== undefined &&
                      plan.minSeats > 1 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Minimum {plan.minSeats} seats,{" "}
                          {plan.currency ? currencySymbol(plan.currency) : "€"}
                          {(plan.priceMonthly ?? plan.price).toFixed(2)} extra
                          per seat
                        </p>
                      )}
                    {isYearly &&
                      plan.priceMonthly !== undefined &&
                      plan.priceYearly !== undefined &&
                      ((plan.priceMonthly ?? plan.price) > 0 ||
                        plan.priceYearly > 0) && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Billed annually (
                          {plan.currency ? currencySymbol(plan.currency) : "$"}
                          {plan.priceYearly}
                          {plan.interval?.includes("per seat")
                            ? "/year per seat"
                            : "/year"}
                          )
                        </p>
                      )}
                    {/* Trial information */}
                    {plan.trial?.available && (
                      <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                        <p className="text-sm text-green-800 font-medium">
                          🎉 Start with a {plan.trial.days}-day free trial
                        </p>
                        <p className="text-xs text-green-700 mt-1">
                          After trial:{" "}
                          {plan.currency ? currencySymbol(plan.currency) : "€"}
                          {isYearly && plan.priceYearly
                            ? (plan.priceYearly / 12).toFixed(2)
                            : (plan.priceMonthly ?? plan.price).toFixed(2)}
                          /{plan.interval || "month"} + taxes
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex-1">
                {plan.features && (
                  <ul className="space-y-2">
                    {plan.features.map((feature: Feature, idx: number) => {
                      // Split feature text to separate main text from trial info
                      const parts = feature.text.split(" • Trial: ");
                      const mainText = parts[0];
                      const trialText = parts[1];

                      // Check if this feature has corresponding usage pricing
                      const usageComponent = plan.pricingData?.components?.find(
                        (comp) => {
                          if (comp.type !== "usage") return false;

                          // Prefer slug-based matching to avoid prefix collisions
                          const slugify = (s: string) =>
                            s
                              .toLowerCase()
                              .trim()
                              .replace(/\s+/g, "-")
                              .replace(/[^a-z0-9-]/g, "-")
                              .replace(/-+/g, "-")
                              .replace(/^-|-$/g, "");

                          // Match feature with usage component using slug derived from text
                          const baseMainText = mainText
                            .replace(/\s*\(.*?\)\s*$/, "")
                            .trim();
                          const mainTextSlug = slugify(baseMainText);

                          let compSlug = "";
                          if (
                            typeof comp.component_name === "string" &&
                            comp.component_name
                          ) {
                            const raw = comp.component_name
                              .replace(/^usage[_-]?/i, "")
                              .replace(/[_-]?usage$/i, "");
                            compSlug = slugify(raw);
                          } else if (
                            typeof comp.unit_label === "string" &&
                            comp.unit_label
                          ) {
                            compSlug = slugify(comp.unit_label);
                          } else if (
                            typeof comp.label === "string" &&
                            comp.label
                          ) {
                            const raw = comp.label.replace(/\s+usage$/i, "");
                            compSlug = slugify(raw);
                          }

                          if (compSlug && mainTextSlug) {
                            return compSlug === mainTextSlug;
                          }

                          // Fallback to normalized name equality
                          let featureName = "";
                          if (comp.label) {
                            featureName = comp.label.replace(/\s+usage$/i, "");
                          } else if (comp.component_name) {
                            const name = comp.component_name.replace(
                              /^usage_/,
                              ""
                            );
                            featureName = name
                              .replace(/-/g, " ")
                              .replace(/\b\w/g, (l: string) => l.toUpperCase());
                          }
                          const normalize = (s: string) =>
                            s.toLowerCase().replace(/\s+/g, " ").trim();
                          return (
                            normalize(baseMainText) === normalize(featureName)
                          );
                        }
                      );

                      return (
                        <li key={idx} className="flex items-start">
                          <Check className="h-4 w-4 mr-2 mt-0.5 flex-shrink-0" />
                          <div className="flex-1">
                            <span>{mainText}</span>
                            {usageComponent && (
                              <div className="text-xs text-muted-foreground mt-1">
                                {(() => {
                                  const pricePerUnit =
                                    usageComponent.unit_cost_cents
                                      ? usageComponent.unit_cost_cents / 100
                                      : 0;
                                  const currency = plan.currency || "usd";
                                  const currencySymbol =
                                    currency === "usd"
                                      ? "$"
                                      : currency === "eur"
                                        ? "€"
                                        : currency.toUpperCase();

                                  // Check if this feature has credit allowances by looking for patterns like "(1000 per month)" or "(500 included)"
                                  const hasAllowance =
                                    /\(\d+\s+(per\s+(month|year)|included)\)/.test(
                                      mainText
                                    );
                                  const prefix = hasAllowance ? "Then " : "";

                                  return `${prefix}${currencySymbol}${pricePerUnit.toFixed(pricePerUnit < 0.01 ? 4 : 2)} per use`;
                                })()}
                              </div>
                            )}
                            {trialText && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                Trial: {trialText}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
              <CardFooter className="mt-auto">
                <Button
                  className="w-full"
                  variant={
                    currentPlan
                      ? "secondary"
                      : plan.buttonOutline
                        ? "outline"
                        : "default"
                  }
                  disabled={currentPlan}
                  onClick={() => {
                    if (currentPlan) return; // Don't do anything for current plan

                    if (plan.isEnterprisePlan && plan.enterpriseRedirectUrl) {
                      window.open(plan.enterpriseRedirectUrl, "_blank");
                    } else {
                      const allowYearly =
                        isYearly &&
                        plan.priceYearly !== undefined &&
                        !!plan.priceIdYearly;
                      const selected: Plan = {
                        ...plan,
                        selectedBillingInterval: allowYearly
                          ? "yearly"
                          : "monthly",
                        selectedPrice: allowYearly
                          ? plan.priceYearly!
                          : plan.priceMonthly || plan.price,
                      };
                      setSelectedPlan?.(selected);
                    }
                  }}
                >
                  {getButtonText(plan)}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// PaymentModal
// ----------------------------------------------------------------------------

interface PaymentModalProps {
  isOpen: boolean;
  lumenPublishableKey: string;
  plan: Plan | null;
  userEmail?: string;
  userId: string;
  organizationId?: string;
  apiBaseUrl?: string;
  onClose?: () => void;
  onPaymentSuccess?: (paymentIntentId?: string) => void;
  onPaymentError?: (error?: string) => void;
  requireBillingDetails?: boolean;
  initialCustomer?: InitialCustomer;
}

// Tax calculation result interface
interface TaxCalculationResult {
  success: boolean;
  taxCalculation: {
    subtotalCents: number;
    taxAmountCents: number;
    totalAmountCents: number;
    effectiveTaxRate: number;
    jurisdiction: string;
    calculationMethod: string;
    taxLineItems: Array<{
      type: "tax";
      description: string;
      subtotalCents: number;
      taxMetadata?: {
        taxAuthority?: string;
        taxType?: string;
        jurisdiction?: string;
        taxRate?: number;
        rateSource?: string;
        exemptionReason?: string;
        reasonCode?: number;
        fullDescription?: string;
      };
    }>;
    exemptionReason?: string;
  };
}

export const PaymentModal = ({
  isOpen,
  lumenPublishableKey,
  plan,
  userEmail,
  userId,
  organizationId,
  onClose,
  onPaymentSuccess,
  onPaymentError,
  requireBillingDetails = false,
  apiBaseUrl = "https://api.getlumen.dev/v1",
  initialCustomer,
}: PaymentModalProps) => {
  const [stripePromise, setStripePromise] =
    useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);

  const [intentId, setIntentId] = useState<string | null>(null);
  const [intentType, setIntentType] = useState<string | null>(null);

  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [customerEmail, setCustomerEmail] = useState<string>(
    initialCustomer?.email || userEmail || ""
  );
  const [customerName, setCustomerName] = useState<string>(
    initialCustomer?.name || ""
  );
  const [businessName, setBusinessName] = useState<string>(
    initialCustomer?.businessName || ""
  );
  const [customerAddress, setCustomerAddress] = useState<string>(
    initialCustomer?.address || ""
  );
  const [customerAddressLine2, setCustomerAddressLine2] = useState<string>(
    initialCustomer?.addressLine2 || ""
  );
  const [customerZip, setCustomerZip] = useState<string>(
    initialCustomer?.zip || ""
  );
  const [customerCity, setCustomerCity] = useState<string>(
    initialCustomer?.city || ""
  );
  const [customerCountry, setCustomerCountry] = useState<string>(
    initialCustomer?.country || ""
  );
  const [customerStateProvince, setCustomerStateProvince] = useState<string>(
    initialCustomer?.stateProvince || ""
  );
  const [taxId, setTaxId] = useState<string>(initialCustomer?.taxId || "");
  const [isBusiness, setIsBusiness] = useState<boolean>(
    initialCustomer?.isBusiness || false
  );
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [checkoutFormErrorMessage, setCheckoutFormErrorMessage] = useState<
    string | null
  >(null);

  // State for tax calculation result
  const [taxData, setTaxData] = useState<
    TaxCalculationResult["taxCalculation"] | null
  >(null);

  // Function to calculate taxes for a specific plan and customer details
  const calculateTaxesForSubmission = async (
    plan: Plan,
    customerCountry: string,
    customerStateProvince?: string,
    taxId?: string,
    businessName?: string
  ): Promise<TaxCalculationResult["taxCalculation"] | null> => {
    try {
      // Determine the correct price based on billing interval
      const isYearlyBilling = plan.selectedBillingInterval === "yearly";
      let selectedPriceId = plan.priceId;
      let subtotalCents = 0;

      if (isYearlyBilling && plan.priceIdYearly) {
        selectedPriceId = plan.priceIdYearly;
        subtotalCents = plan.selectedPrice ? plan.selectedPrice : 0;
      } else if (!isYearlyBilling && plan.priceIdMonthly) {
        selectedPriceId = plan.priceIdMonthly;
        subtotalCents = plan.priceMonthly ? plan.priceMonthly : plan.price || 0;
      } else {
        subtotalCents = plan.price || 0;
      }

      // Convert to cents
      subtotalCents = subtotalCents * 100;

      // Apply minimum seat multiplier for seat-based plans so tax is computed on correct amount
      const seatMultiplier = plan.interval?.includes("per seat")
        ? Math.max(1, plan.minSeats || 1)
        : 1;
      subtotalCents = subtotalCents * seatMultiplier;

      const response = await fetch(`${apiBaseUrl}/public/calculate-tax`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lumenPublishableKey,
          planId: plan.planId,
          priceId: selectedPriceId,
          subtotalCents,
          currency: plan.currency || "USD",
          customerCountry,
          customerStateProvince,
          taxId,
          businessName,
        }),
      });

      if (!response.ok) {
        let errorMessage = `Failed to calculate taxes (${response.status})`;
        try {
          const errorData = await response.json();
          errorMessage = getErrorMessage(errorData) || errorMessage;
        } catch {
          // If response body is not JSON, use the status-based message
        }
        throw new Error(errorMessage);
      }

      const result: TaxCalculationResult = await response.json();
      console.log("Tax calculation result:", result);
      return result.taxCalculation;
    } catch (error) {
      console.error("Error calculating taxes:", error);
      // Return null on error to continue with payment without taxes
      return null;
    }
  };

  useEffect(() => {
    if (plan && showPaymentForm) {
      setClientSecret(null);
      setIntentId(null);
      setIntentType(null);
      setShowPaymentForm(false);
      setIntegrationError(null);
      setCheckoutFormErrorMessage(null);
      setEmailSubmitting(false);
      setTaxData(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.selectedBillingInterval]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateEmail(customerEmail)) {
      setIntegrationError("Please enter a valid email address");
      return;
    }

    const missing: string[] = [];
    if (!customerName) missing.push("full name");
    if (!userId) missing.push("user ID");
    if (isBusiness) {
      if (!taxId) missing.push("tax ID");
      if (!businessName) missing.push("business name");
    }
    if (isBusiness || requireBillingDetails) {
      if (!customerAddress) missing.push("address");
      if (!customerZip) missing.push("ZIP code");
      if (!customerCity) missing.push("city");
      if (!customerCountry) missing.push("country");
      if (customerCountry === "US" && !customerStateProvince) {
        missing.push("state");
      }
    }
    if (missing.length) {
      setIntegrationError(
        `Please fill in all required fields: ${missing.join(", ")}`
      );
      return;
    }

    setEmailSubmitting(true);
    try {
      if (!plan) {
        setIntegrationError("No plan selected");
        return;
      }

      // Step 1: Calculate taxes if we have address information
      let taxCalculation: TaxCalculationResult["taxCalculation"] | null = null;

      const willStartTrial = !!plan.trial?.available;

      if (
        !willStartTrial &&
        customerCountry &&
        (isBusiness || requireBillingDetails)
      ) {
        console.log("Calculating taxes before payment initialization...");
        taxCalculation = await calculateTaxesForSubmission(
          plan,
          customerCountry,
          customerStateProvince,
          isBusiness ? taxId : undefined,
          isBusiness ? businessName : undefined
        );

        if (taxCalculation) {
          console.log("Tax calculation successful:", {
            subtotal: taxCalculation.subtotalCents,
            tax: taxCalculation.taxAmountCents,
            total: taxCalculation.totalAmountCents,
            jurisdiction: taxCalculation.jurisdiction,
          });
          // Store tax data for potential UI display
          setTaxData(taxCalculation);
        }
      }

      // Step 2: Determine the correct price based on billing interval
      const isYearly = plan.selectedBillingInterval === "yearly";

      // Determine the correct price ID based on billing interval
      let priceId = plan.priceId;
      if (isYearly && plan.priceIdYearly) {
        priceId = plan.priceIdYearly;
      } else if (!isYearly && plan.priceIdMonthly) {
        priceId = plan.priceIdMonthly;
      }

      // Step 3: Build request body with tax information
      const body: Record<string, unknown> = {
        lumenPublishableKey,
        priceId,
        planId: plan.planId,
        customerEmail,
        customerName,
        userId,
        ...(organizationId && { organizationId }),
        // Automatically start trial if available
        ...(plan.trial?.available && { startTrial: true }),
      };

      // Include tax data if available
      if (taxCalculation) {
        body.taxData = {
          taxableAmount: taxCalculation.subtotalCents,
          totalTaxCents: taxCalculation.taxAmountCents,
          effectiveTaxRate: taxCalculation.effectiveTaxRate,
          jurisdiction: taxCalculation.jurisdiction,
          calculationMethod: taxCalculation.calculationMethod,
          taxLineItems: taxCalculation.taxLineItems,
        };
      }

      // Only include business-related fields if buying as a business
      if (isBusiness) {
        body.businessName = businessName;
        body.taxId = taxId;
      }

      // Include address fields if business or billing details required
      if (isBusiness || requireBillingDetails) {
        body.customerAddress = customerAddress;
        body.customerAddressLine2 = customerAddressLine2;
        body.customerZip = customerZip;
        body.customerCity = customerCity;
        body.customerCountry = customerCountry;
        body.customerStateProvince = customerStateProvince;
      }

      const resp = await fetch(`${apiBaseUrl}/public/payment-init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // Robust handling for non-2xx responses and malformed JSON
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any = null;
      try {
        data = await resp.json();
      } catch {
        setIntegrationError(`Unexpected response (${resp.status})`);
        onPaymentError?.(`Unexpected response (${resp.status})`);
        setEmailSubmitting(false);
        return;
      }

      if (!resp.ok) {
        setIntegrationError(
          getErrorMessage(data) || `Request failed (${resp.status})`
        );
        setEmailSubmitting(false);
        return;
      }

      if (data.message && data.subscription_id && !data.clientSecret) {
        onPaymentSuccess?.();
        setEmailSubmitting(false);
        return;
      }

      if (!data.stripePublishableKey || !data.clientSecret || !data.intentId) {
        setIntegrationError(
          getErrorMessage(data) || "Failed to initialize payment"
        );
        setEmailSubmitting(false);
        return;
      }

      setClientSecret(data.clientSecret);
      setIntentId(data.intentId);
      setIntentType(data.intentType);
      setStripePromise(loadStripe(data.stripePublishableKey));
      setShowPaymentForm(true);
    } catch (err) {
      console.error(err);
      setIntegrationError(
        getErrorMessage(err) ||
          "Failed to initialize payment. Please try again."
      );
    } finally {
      setEmailSubmitting(false);
    }
  };

  const handleCheckoutAttempt = () => setCheckoutFormErrorMessage(null);

  useEffect(() => {
    if (!isOpen || !showPaymentForm || !intentId) return;

    let es: EventSource | null = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECTS = 3;
    let reconnectTimeout: NodeJS.Timeout;
    let eventReceived = false;
    let pollingInterval: NodeJS.Timeout;
    let timeoutId: NodeJS.Timeout;
    let pollingStarted = false;
    let successHandled = false; // Deduplicate success events

    // Polling fallback function
    const pollForPaymentStatus = async () => {
      try {
        console.log(`Polling payment status for ${intentId}...`);
        const res = await fetch(
          `${apiBaseUrl}/public/payment-status/${intentId}`
        );
        const data = await res.json();

        if (data.status === "succeeded" && !successHandled) {
          successHandled = true;
          console.log("Payment succeeded (via polling)");
          onPaymentSuccess?.(intentId);
          clearPolling();
        } else if (data.status === "failed") {
          console.log("Payment failed (via polling)");
          setCheckoutFormErrorMessage(
            data.error || "Payment failed. Please try again."
          );
          onPaymentError?.(data.error || "Payment failed");
          clearPolling();
        }
        // If still pending, continue polling
      } catch (err) {
        console.error("Polling failed:", err);
        // Continue polling despite error - network might recover
      }
    };

    const clearPolling = () => {
      if (pollingInterval) clearInterval(pollingInterval);
      if (timeoutId) clearTimeout(timeoutId);
      pollingStarted = false;
    };

    const connect = () => {
      // Clear any stale timers from previous attempts
      if (timeoutId) clearTimeout(timeoutId);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      eventReceived = false;
      console.log(
        `Connecting to SSE (attempt ${reconnectAttempts + 1}/${MAX_RECONNECTS + 1})...`
      );
      es = new EventSource(`${apiBaseUrl}/public/events/${intentId}`);

      es.addEventListener("stripe_event", (ev) => {
        try {
          eventReceived = true;
          clearTimeout(timeoutId); // Clear timeout on any event
          const evt = JSON.parse((ev as MessageEvent).data);
          console.log("Received SSE event:", evt.type);

          if (evt.type === "payment_intent.succeeded") {
            if (successHandled) {
              console.log("Duplicate payment success event ignored");
              return;
            }
            successHandled = true;
            console.log("Payment succeeded (via SSE)");
            onPaymentSuccess?.(evt.data.object.id);
            es?.close();
            clearPolling();
          } else if (evt.type === "payment_intent.payment_failed") {
            const msg =
              evt.data.object.last_payment_error?.message || "Payment failed";
            console.log("Payment failed (via SSE):", msg);
            setCheckoutFormErrorMessage(msg);
            onPaymentError?.(msg);
            clearPolling();
          } else if (evt.type === "setup_intent.succeeded") {
            if (successHandled) {
              console.log("Duplicate setup success event ignored");
              return;
            }
            successHandled = true;
            console.log("Setup succeeded (via SSE)");
            onPaymentSuccess?.();
            es?.close();
            clearPolling();
          } else if (evt.type === "setup_intent.setup_failed") {
            const msg =
              evt.data.object.last_setup_error?.message || "Setup failed";
            console.log("Setup failed (via SSE):", msg);
            setCheckoutFormErrorMessage(msg);
            onPaymentError?.(msg);
            clearPolling();
          }
        } catch (e) {
          console.error("Failed to parse SSE event", e);
        }
      });

      es.onerror = (e) => {
        console.error("SSE error", e);
        es?.close();

        // Attempt reconnection
        if (reconnectAttempts < MAX_RECONNECTS) {
          reconnectAttempts++;
          const delay = 2000 * reconnectAttempts;
          console.log(
            `SSE connection failed, reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECTS})...`
          );
          reconnectTimeout = setTimeout(connect, delay);
        } else {
          // Exhausted reconnection attempts, fall back to polling
          console.warn(
            "SSE reconnection failed after max attempts, falling back to polling..."
          );
          setCheckoutFormErrorMessage(
            "Connection issue detected. Checking payment status..."
          );
          if (!pollingStarted) {
            pollingStarted = true;
            pollingInterval = setInterval(pollForPaymentStatus, 3000);
            // Run immediately
            pollForPaymentStatus();
          }
        }
      };

      // Timeout: if no event received after 60 seconds, start polling
      timeoutId = setTimeout(() => {
        if (!eventReceived) {
          console.warn(
            "No SSE event received after 60s, starting polling fallback..."
          );
          setCheckoutFormErrorMessage(
            "Taking longer than expected. Checking payment status..."
          );
          if (!pollingStarted) {
            pollingStarted = true;
            pollingInterval = setInterval(pollForPaymentStatus, 3000);
            pollForPaymentStatus();
          }
        }
      }, 60000);
    };

    connect();

    return () => {
      console.log("Cleaning up SSE connection and polling...");
      es?.close();
      clearTimeout(reconnectTimeout);
      clearPolling();
    };
  }, [
    isOpen,
    showPaymentForm,
    intentId,
    apiBaseUrl,
    onPaymentSuccess,
    onPaymentError,
  ]);

  if (!isOpen) return null;

  if (!showPaymentForm) {
    return (
      <Overlay>
        <Card className="w-full max-w-lg max-h-[90vh] flex flex-col relative">
          <CardHeader className="flex-shrink-0">
            {onClose && (
              <CloseButton onClick={onClose} aria-label="Close modal">
                ×
              </CloseButton>
            )}
            <CardTitle>
              {plan?.trial?.available
                ? "Start your free trial"
                : "Enter your details"}
            </CardTitle>
            <CardDescription>
              {plan?.trial?.available
                ? `Start your ${plan.trial.days}-day free trial for ${plan.title}. You won't be charged today (taxes may apply after trial).`
                : `Please provide your information to proceed with the payment for ${plan?.title}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto">
            {emailSubmitting ? (
              <div className="flex items-center justify-center min-h-[200px]">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
              </div>
            ) : (
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <Input
                  type="email"
                  placeholder="Email address"
                  value={customerEmail}
                  onChange={(e) => {
                    setCustomerEmail(e.target.value);
                    setIntegrationError(null);
                  }}
                  required
                />
                <Input
                  type="text"
                  placeholder="Full name"
                  value={customerName}
                  onChange={(e) => {
                    setCustomerName(e.target.value);
                    setIntegrationError(null);
                  }}
                  required
                />
                <div className="flex items-center space-x-2 my-4">
                  <Checkbox
                    id="business-toggle"
                    checked={isBusiness}
                    onCheckedChange={(checked: boolean) =>
                      setIsBusiness(checked)
                    }
                  />
                  <Label htmlFor="business-toggle" className="cursor-pointer">
                    I&apos;m buying as a business
                  </Label>
                </div>
                {isBusiness && (
                  <>
                    <Input
                      type="text"
                      placeholder="Tax ID (VAT/EIN/GST/etc.)"
                      value={taxId}
                      onChange={(e) => setTaxId(e.target.value)}
                      required
                    />
                    <Input
                      type="text"
                      placeholder="Business name"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      required
                    />
                  </>
                )}
                {(isBusiness || requireBillingDetails) && (
                  <>
                    <Input
                      type="text"
                      placeholder="Address"
                      value={customerAddress}
                      onChange={(e) => setCustomerAddress(e.target.value)}
                      required
                    />
                    <Input
                      type="text"
                      placeholder="Address line 2 (Optional)"
                      value={customerAddressLine2}
                      onChange={(e) => setCustomerAddressLine2(e.target.value)}
                    />
                    <Input
                      type="text"
                      placeholder="ZIP code"
                      value={customerZip}
                      onChange={(e) => setCustomerZip(e.target.value)}
                      required
                    />
                    <Input
                      type="text"
                      placeholder="City"
                      value={customerCity}
                      onChange={(e) => setCustomerCity(e.target.value)}
                      required
                    />
                    <SearchableSelect
                      options={customerCountries}
                      value={customerCountry}
                      onValueChange={(value) => {
                        setCustomerCountry(value);
                        // Clear state/province when switching from US to non-US
                        if (value !== "US" && customerStateProvince) {
                          const isUSState = usStates.some(
                            (state) => state.value === customerStateProvince
                          );
                          if (isUSState) {
                            setCustomerStateProvince("");
                          }
                        }
                        setIntegrationError(null);
                      }}
                      placeholder="Select country"
                      required
                    />
                    {customerCountry === "US" ? (
                      <SearchableSelect
                        options={usStates}
                        value={customerStateProvince}
                        onValueChange={(value) => {
                          setCustomerStateProvince(value);
                          setIntegrationError(null);
                        }}
                        placeholder="Select state"
                        required
                      />
                    ) : (
                      <Input
                        type="text"
                        placeholder="State/Province (optional)"
                        value={customerStateProvince}
                        onChange={(e) =>
                          setCustomerStateProvince(e.target.value)
                        }
                      />
                    )}
                  </>
                )}
                {integrationError && (
                  <Alert variant="destructive">
                    <AlertDescription>{integrationError}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" className="w-full">
                  {plan?.trial?.available
                    ? "Start Free Trial"
                    : (plan?.selectedPrice ??
                          plan?.priceMonthly ??
                          plan?.price ??
                          0) === 0
                      ? "Start free subscription"
                      : "Continue to payment"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </Overlay>
    );
  }

  if (!stripePromise || !clientSecret) {
    return (
      <Overlay>
        <Card className="w-full max-w-lg max-h-[90vh] flex flex-col relative">
          <CardHeader className="flex-shrink-0">
            {onClose && (
              <CloseButton onClick={onClose} aria-label="Close modal">
                ×
              </CloseButton>
            )}
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto flex items-center justify-center">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
          </CardContent>
        </Card>
      </Overlay>
    );
  }

  return (
    <Overlay>
      <Elements stripe={stripePromise} options={{ clientSecret }}>
        <CheckoutForm
          onClose={onClose}
          plan={plan!}
          clientSecret={clientSecret}
          userEmail={customerEmail}
          apiUrl={`${apiBaseUrl}/public/payment-init`}
          onPaymentSuccess={onPaymentSuccess}
          onPaymentError={onPaymentError}
          intentType={intentType}
          taxData={taxData}
          initialError={checkoutFormErrorMessage}
          onAttemptSubmit={handleCheckoutAttempt}
        />
      </Elements>
    </Overlay>
  );
};

interface CheckoutFormProps {
  onClose?: () => void;
  plan: Plan;
  clientSecret: string;
  userEmail?: string;
  apiUrl: string;
  onPaymentSuccess?: (paymentIntentId?: string) => void;
  onPaymentError?: (error?: string) => void;
  intentType: string | null;
  taxData?: TaxCalculationResult["taxCalculation"] | null;
  initialError?: string | null;
  onAttemptSubmit?: () => void;
}

function CheckoutForm({
  onClose,
  plan,
  clientSecret,
  onPaymentError,
  intentType,
  taxData,
  initialError,
  onAttemptSubmit,
  apiUrl: _apiUrl,
  userEmail: _userEmail,
}: CheckoutFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [cardError, setCardError] = useState<string | null>(
    initialError || null
  );
  const [processing, setProcessing] = useState(false);
  // Suppress unused variable warnings for props not currently used
  void _apiUrl;
  void _userEmail;
  // Determine if we are confirming a Setup Intent (no immediate charge)
  const isSetupIntent =
    intentType === "setup_intent" || clientSecret?.startsWith("seti_");

  useEffect(() => {
    if (initialError) {
      setCardError(initialError);
      setProcessing(false);
    }
  }, [initialError]);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!stripe || !elements) return;
    setCardError(null);
    onAttemptSubmit?.();
    setProcessing(true);
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        const errorMessage =
          getErrorMessage(submitError) || "Form submission failed";
        setCardError(errorMessage);
        setProcessing(false);
        onPaymentError?.(errorMessage);
        return;
      }
      let confirmPromise;
      if (intentType === "payment_intent") {
        confirmPromise = stripe.confirmPayment({
          elements,
          clientSecret,
          confirmParams: { return_url: window.location.href.split("?")[0] },
          redirect: "if_required",
        });
      } else if (intentType === "setup_intent") {
        confirmPromise = stripe.confirmSetup({
          elements,
          clientSecret,
          confirmParams: { return_url: window.location.href.split("?")[0] },
          redirect: "if_required",
        });
      } else {
        setCardError("Invalid intent type.");
        setProcessing(false);
        onPaymentError?.("Invalid intent type.");
        return;
      }

      const result = await confirmPromise;
      if (result.error) {
        const errorMessage =
          getErrorMessage(result.error) || "An error occurred";
        setCardError(errorMessage);
        setProcessing(false);
        onPaymentError?.(errorMessage);
      }
    } catch (err) {
      console.error(err);
      const errorMessage = getErrorMessage(err) || "Unexpected error";
      setCardError(errorMessage);
      setProcessing(false);
      onPaymentError?.(errorMessage);
    }
  };

  return (
    <Card className="w-full max-w-lg max-h-[90vh] flex flex-col relative">
      <CardHeader className="flex-shrink-0">
        {onClose && (
          <CloseButton onClick={onClose} aria-label="Close modal">
            ×
          </CloseButton>
        )}
        <CardTitle>
          {plan.trial?.available
            ? `Start Free Trial - ${plan.title}`
            : plan.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto">
        {/* Price breakdown */}
        <div className="mb-4">
          {/* Subtotal */}
          <div className="flex justify-between text-base mb-1">
            <span>Subtotal</span>
            <span>
              {plan.currency ? currencySymbol(plan.currency) : "€"}
              {isSetupIntent
                ? "0.00"
                : (() => {
                    const unit =
                      plan.selectedBillingInterval === "yearly" &&
                      plan.selectedPrice
                        ? plan.selectedPrice
                        : ((plan.priceMonthly || plan.price) ?? 0);
                    const seatMultiplier = plan.interval?.includes("per seat")
                      ? Math.max(1, plan.minSeats || 1)
                      : 1;
                    return (unit * seatMultiplier).toFixed(2);
                  })()}
            </span>
          </div>

          {/* Tax */}
          {taxData &&
            taxData.taxAmountCents > 0 &&
            taxData.jurisdiction !== "payment_flow" &&
            !isSetupIntent && (
              <div className="flex justify-between text-base mb-1">
                <span>Tax ({taxData.jurisdiction})</span>
                <span>
                  {plan.currency ? currencySymbol(plan.currency) : "€"}
                  {(taxData.taxAmountCents / 100).toFixed(2)}
                </span>
              </div>
            )}

          {/* Total */}
          <div className="flex justify-between font-bold text-lg border-t pt-2">
            <span>Total due now</span>
            <span>
              {plan.currency ? currencySymbol(plan.currency) : "€"}
              {isSetupIntent
                ? "0.00"
                : taxData
                  ? (taxData.totalAmountCents / 100).toFixed(2)
                  : (() => {
                      const unit =
                        plan.selectedBillingInterval === "yearly" &&
                        plan.selectedPrice
                          ? plan.selectedPrice
                          : ((plan.priceMonthly || plan.price) ?? 0);
                      const seatMultiplier = plan.interval?.includes("per seat")
                        ? Math.max(1, plan.minSeats || 1)
                        : 1;
                      return (unit * seatMultiplier).toFixed(2);
                    })()}
            </span>
          </div>
        </div>

        {/* Inform the user if no charge will occur immediately */}
        {isSetupIntent && (
          <Alert className="mb-4 bg-blue-50 border-blue-200">
            <AlertDescription className="text-blue-900">
              You won&apos;t be charged today. Your payment method will be
              stored. Future charges will be{" "}
              {plan.currency ? currencySymbol(plan.currency) : "€"}
              {(() => {
                const amount =
                  plan.selectedBillingInterval === "yearly" && plan.priceYearly
                    ? plan.priceYearly
                    : (plan.priceMonthly ?? plan.price);
                return amount.toFixed(2);
              })()}{" "}
              {(() => {
                const seatSuffix = plan.interval?.includes("per seat")
                  ? " per seat"
                  : "";
                const period =
                  plan.selectedBillingInterval === "yearly" ? "year" : "month";
                return `per ${period}${seatSuffix} + taxes`;
              })()}
              .
            </AlertDescription>
          </Alert>
        )}
        <p className="text-muted-foreground mb-4">{plan.description}</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <PaymentElement id="payment-element" />
          <Button type="submit" disabled={processing} className="w-full mt-2">
            {processing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isSetupIntent ? (
              "Confirm payment method"
            ) : (
              "Pay now"
            )}
          </Button>
          {cardError && (
            <Alert variant="destructive">
              <AlertDescription>{cardError}</AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Main PricingTable component
// ----------------------------------------------------------------------------

export const PricingTable = ({
  pricingTableSlug,
  lumenPublishableKey = process.env.NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY ||
    process.env.REACT_APP_LUMEN_PUBLISHABLE_KEY,
  redirectUrl,
  apiBaseUrl = "https://api.getlumen.dev/v1",
  userId,
  loginRedirectUrl,
  pricingData,
  lumenHandlerUrl,
  paymentProvider = "stripe",
  environment = "live",
  initialCustomer,
  organizationId,
}: {
  pricingTableSlug?: string;
  lumenPublishableKey?: string;
  redirectUrl?: string;
  apiBaseUrl?: string;
  userId?: string;
  organizationId?: string;
  loginRedirectUrl: string;
  pricingData?: Partial<PricingTableProps>;
  lumenHandlerUrl?: string;
  paymentProvider?: "stripe" | "dodo";
  environment?: "test" | "live";
  initialCustomer?: InitialCustomer;
}) => {
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validatedPricingData, setValidatedPricingData] =
    useState<PricingTableProps | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus | null>(null);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
    countdown: number | null;
  } | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const autoDismissTimeoutRef = useRef<number | null>(null);

  const sanitizedInitialCustomer = React.useMemo(
    () => sanitizeInitialCustomer(initialCustomer),
    [initialCustomer]
  );

  useEffect(() => {
    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      if (autoDismissTimeoutRef.current) {
        clearTimeout(autoDismissTimeoutRef.current);
        autoDismissTimeoutRef.current = null;
      }
    };
  }, []);

  const dismissNotification = () => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (autoDismissTimeoutRef.current) {
      clearTimeout(autoDismissTimeoutRef.current);
      autoDismissTimeoutRef.current = null;
    }
    setNotification(null);
  };

  const handleStripePaymentSuccess = () => {
    setSelectedPlan(null);
    if (redirectUrl) {
      setNotification({
        type: "success",
        message: "Payment successful.",
        countdown: 5,
      });
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
      countdownIntervalRef.current = window.setInterval(() => {
        setNotification((prev) => {
          if (!prev || prev.countdown === null) return prev;
          if (prev.countdown <= 1) {
            // next tick: redirect and cleanup
            window.setTimeout(() => {
              if (countdownIntervalRef.current) {
                clearInterval(countdownIntervalRef.current);
                countdownIntervalRef.current = null;
              }
              window.location.href = redirectUrl;
            }, 0);
            return { ...prev, countdown: 0 };
          }
          return { ...prev, countdown: prev.countdown - 1 };
        });
      }, 1000);
    } else {
      setNotification({
        type: "success",
        message: "Payment successful.",
        countdown: null,
      });
      if (autoDismissTimeoutRef.current) {
        clearTimeout(autoDismissTimeoutRef.current);
      }
      autoDismissTimeoutRef.current = window.setTimeout(() => {
        setNotification(null);
        autoDismissTimeoutRef.current = null;
      }, 3000);
    }
  };

  const handleStripePaymentError = (err?: string) => {
    const msg = err || "Payment failed. Please try again.";
    setNotification({ type: "error", message: msg, countdown: null });
    if (autoDismissTimeoutRef.current) {
      clearTimeout(autoDismissTimeoutRef.current);
    }
    autoDismissTimeoutRef.current = window.setTimeout(() => {
      setNotification(null);
      autoDismissTimeoutRef.current = null;
    }, 3000);
  };

  useEffect(() => {
    if (lumenPublishableKey) {
      setLoading(true);
      setError(null);

      const fetchPromises: Promise<unknown>[] = [
        fetchPricingTable({
          slug: pricingTableSlug,
          lumenPublishableKey,
          apiBaseUrl,
        }),
      ];

      if (userId) {
        fetchPromises.push(
          fetchSubscriptionStatus({
            externalCustomerId: userId,
            lumenHandlerUrl:
              lumenHandlerUrl || `${window.location.origin}/api/lumen`,
          })
        );
      }

      Promise.all(fetchPromises)
        .then((results) => {
          const pricingTableData = results[0];
          const subscriptionStatusData = results[1]; // This will be undefined if userId wasn't provided

          if (validatePricingTableData(pricingTableData)) {
            setValidatedPricingData(pricingTableData);
          } else {
            setError("Invalid pricing table data received from server");
          }

          // Set subscription status if it was fetched and has the expected structure
          if (
            subscriptionStatusData &&
            typeof subscriptionStatusData === "object" &&
            "hasActiveSubscription" in subscriptionStatusData &&
            subscriptionStatusData.hasActiveSubscription &&
            "customer" in subscriptionStatusData &&
            "subscription" in subscriptionStatusData
          ) {
            setSubscriptionStatus(subscriptionStatusData as SubscriptionStatus);
          }
        })
        .catch((err) =>
          setError(`Failed to load pricing table: ${getErrorMessage(err)}`)
        )
        .finally(() => setLoading(false));
    } else if (pricingData) {
      if (validatePricingTableData(pricingData)) {
        setValidatedPricingData(pricingData);
      } else {
        setError("Invalid pricing table configuration");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingTableSlug, lumenPublishableKey, apiBaseUrl, pricingData, userId]);

  // Initialize Dodo Payments SDK when applicable
  useEffect(() => {
    if (paymentProvider !== "dodo" || !validatedPricingData) return;
    try {
      DodoPayments.Initialize({
        mode: environment,
        onEvent: (event) => console.log("Checkout event:", event),
        theme: "light",
        linkType: "dynamic",
        displayType: "overlay",
      });
    } catch (e) {
      console.error("Failed to initialize DodoPayments SDK", e);
    }
  }, [paymentProvider, validatedPricingData, environment]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2">Loading pricing information...</span>
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="destructive" className="max-w-2xl mx-auto my-8">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!lumenPublishableKey) {
    return (
      <Alert variant="destructive" className="max-w-2xl mx-auto my-8">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Missing API Key</AlertTitle>
        <AlertDescription>
          <div className="text-sm mt-2">
            <p>
              No publishable key found. Please set an environment variable or
              pass it as a prop:
            </p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>
                Next.js:{" "}
                <code className="bg-gray-100 px-1 rounded">
                  NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY
                </code>
              </li>
              <li>
                Create React App:{" "}
                <code className="bg-gray-100 px-1 rounded">
                  REACT_APP_LUMEN_PUBLISHABLE_KEY
                </code>
              </li>
              <li>
                Vite: Pass as prop{" "}
                <code className="bg-gray-100 px-1 rounded">
                  lumenPublishableKey=&quot;pk_...&quot;
                </code>
              </li>
              <li>
                Other: Pass as prop{" "}
                <code className="bg-gray-100 px-1 rounded">
                  lumenPublishableKey=&quot;pk_...&quot;
                </code>
              </li>
            </ul>
            <p className="mt-2">
              Get your API Key from{" "}
              <a
                href="https://getlumen.dev/developer/apikeys"
                target="_blank"
                className="underline"
                rel="noopener noreferrer"
              >
                https://getlumen.dev/developer/apikeys
              </a>
            </p>
          </div>
        </AlertDescription>
      </Alert>
    );
  }
  if (!validatedPricingData) {
    return (
      <Alert variant="destructive" className="max-w-2xl mx-auto my-8">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Missing Pricing Table Data</AlertTitle>
        <AlertDescription>
          <div className="text-sm mt-2">
            <p>No pricing table data found.</p>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const { heading, description, plans } = validatedPricingData;

  return (
    <div>
      {notification && selectedPlan === null && (
        <ResultOverlay
          type={notification.type}
          message={notification.message}
          countdownSeconds={notification.countdown}
          onClose={dismissNotification}
        />
      )}
      <PricingTableCards
        heading={heading}
        description={description}
        plans={plans}
        subscriptionStatus={subscriptionStatus}
        setSelectedPlan={
          userId
            ? setSelectedPlan
            : () => (window.location.href = loginRedirectUrl)
        }
      />
      {paymentProvider === "dodo" ? (
        <PaymentModalDodo
          isOpen={!!selectedPlan}
          lumenPublishableKey={lumenPublishableKey}
          userId={userId || ""}
          organizationId={organizationId}
          plan={selectedPlan}
          onClose={() => setSelectedPlan(null)}
          apiBaseUrl={apiBaseUrl}
          redirectUrl={redirectUrl}
          initialCustomer={sanitizedInitialCustomer}
        />
      ) : (
        <PaymentModal
          isOpen={!!selectedPlan}
          lumenPublishableKey={lumenPublishableKey}
          userId={userId || ""}
          organizationId={organizationId}
          plan={selectedPlan}
          onPaymentSuccess={handleStripePaymentSuccess}
          onPaymentError={handleStripePaymentError}
          onClose={() => setSelectedPlan(null)}
          apiBaseUrl={apiBaseUrl}
          initialCustomer={sanitizedInitialCustomer}
        />
      )}
    </div>
  );
};

// explicit re-exports
export {
  PricingTableCards as PricingTableShadcnCards,
  PaymentModal as PricingTableShadcnPaymentModal,
};

// --------------------------------------------------------------------------
// PaymentModal (Dodo)
// --------------------------------------------------------------------------

interface PaymentModalDodoProps {
  isOpen: boolean;
  lumenPublishableKey: string;
  plan: Plan | null;
  userEmail?: string;
  userId: string;
  organizationId?: string;
  apiBaseUrl?: string;
  onClose?: () => void;
  redirectUrl?: string;
  onPaymentError?: (error?: string) => void;
  initialCustomer?: InitialCustomer;
}

const PaymentModalDodo = ({
  isOpen,
  lumenPublishableKey,
  plan,
  userEmail,
  userId,
  organizationId,
  onClose,
  apiBaseUrl = "https://api.getlumen.dev/v1",
  redirectUrl,
  onPaymentError,
  initialCustomer,
}: PaymentModalDodoProps) => {
  const [loading, setLoading] = useState(false);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [customerEmail, setCustomerEmail] = useState<string>(
    initialCustomer?.email || userEmail || ""
  );
  const [customerName, setCustomerName] = useState<string>(
    initialCustomer?.name || ""
  );
  const [businessName, setBusinessName] = useState<string>(
    initialCustomer?.businessName || ""
  );
  const [customerAddress, setCustomerAddress] = useState<string>(
    initialCustomer?.address || ""
  );
  const [customerAddressLine2, setCustomerAddressLine2] = useState<string>(
    initialCustomer?.addressLine2 || ""
  );
  const [customerZip, setCustomerZip] = useState<string>(
    initialCustomer?.zip || ""
  );
  const [customerCity, setCustomerCity] = useState<string>(
    initialCustomer?.city || ""
  );
  const [customerCountry, setCustomerCountry] = useState<string>(
    initialCustomer?.country || ""
  );
  const [customerStateProvince, setCustomerStateProvince] = useState<string>(
    initialCustomer?.stateProvince || ""
  );
  const [taxId, setTaxId] = useState<string>(initialCustomer?.taxId || "");
  const [isBusiness, setIsBusiness] = useState<boolean>(
    initialCustomer?.isBusiness || false
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateEmail(customerEmail)) {
      setIntegrationError("Please enter a valid email address");
      return;
    }

    const missing: string[] = [];
    if (!customerName) missing.push("full name");
    if (!userId) missing.push("user ID");
    if (isBusiness) {
      if (!taxId) missing.push("tax ID");
      if (!businessName) missing.push("business name");
    }
    if (!customerAddress) missing.push("address");
    if (!customerZip) missing.push("ZIP code");
    if (!customerCity) missing.push("city");
    if (!customerCountry) missing.push("country");
    if (customerCountry === "US" && !customerStateProvince) {
      missing.push("state");
    }
    if (missing.length) {
      setIntegrationError(
        `Please fill in all required fields: ${missing.join(", ")}`
      );
      return;
    }

    setLoading(true);
    try {
      if (!plan) {
        setIntegrationError("No plan selected");
        return;
      }

      const isYearly = plan.selectedBillingInterval === "yearly";
      let priceId = plan.priceId;
      if (isYearly && plan.priceIdYearly) {
        priceId = plan.priceIdYearly;
      } else if (!isYearly && plan.priceIdMonthly) {
        priceId = plan.priceIdMonthly;
      }

      const body: Record<string, unknown> = {
        lumenPublishableKey,
        customerEmail,
        customerName,
        userId,
        ...(organizationId && { organizationId }),
        planId: plan.planId,
        priceId,
        currency: plan.currency || "USD",
        productName: plan.title,
        ...(plan.trial?.available && {
          startTrial: true,
        }),
      };

      if (isBusiness) {
        body.businessName = businessName;
        body.taxId = taxId;
      }

      body.customerAddress = customerAddress;
      body.customerAddressLine2 = customerAddressLine2;
      body.customerZip = customerZip;
      body.customerCity = customerCity;
      body.customerCountry = customerCountry;
      body.customerStateProvince = customerStateProvince;

      const resp = await fetch(`${apiBaseUrl}/public/payment-init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data = null;
      try {
        data = await resp.json();
      } catch {
        setIntegrationError(`Unexpected response (${resp.status})`);
        onPaymentError?.(`Unexpected response (${resp.status})`);
        return;
      }

      if (!resp.ok) {
        const message = getErrorMessage(data) || "Failed to create payment";
        setIntegrationError(message);
        onPaymentError?.(message);
        return;
      }

      if (data.success && data.payment_link) {
        DodoPayments.Checkout.open({
          paymentLink: data.payment_link,
          redirectUrl,
        });
        // Inject informational notice into Dodo overlay (outside the iframe)
        try {
          const injectNotice = () => {
            const inner = document.getElementById("dodo-checkout-inner-div");
            if (!inner) return false;

            const existing = document.getElementById(
              "lumen-dodo-overlay-notice"
            );
            if (existing) return true;

            const currency = plan.currency
              ? currencySymbol(plan.currency)
              : "€";
            const amount = (() => {
              const isYearly = plan.selectedBillingInterval === "yearly";
              const base =
                isYearly && plan.priceYearly
                  ? plan.priceYearly
                  : (plan.priceMonthly ?? plan.price);
              const seatMultiplier = plan.interval?.includes("per seat")
                ? Math.max(1, plan.minSeats || 1)
                : 1;
              return (base * seatMultiplier).toFixed(2);
            })();
            const period =
              plan.selectedBillingInterval === "yearly" ? "year" : "month";
            const seatSuffix = plan.interval?.includes("per seat")
              ? " per seat"
              : "";

            const wrapper = document.createElement("div");
            wrapper.id = "lumen-dodo-overlay-notice";
            wrapper.style.position = "fixed";
            wrapper.style.top = "16px";
            wrapper.style.left = "50%";
            wrapper.style.transform = "translateX(-50%)";
            wrapper.style.zIndex = "1001"; // above iframe (1000) but within overlay
            wrapper.style.maxWidth = "92vw";
            wrapper.style.pointerEvents = "none";

            const card = document.createElement("div");
            card.style.background = "#EFF6FF"; // blue-50
            card.style.border = "1px solid #BFDBFE"; // blue-200
            card.style.color = "#1E3A8A"; // blue-900
            card.style.borderRadius = "8px";
            card.style.padding = "12px 14px";
            card.style.boxShadow = "0 2px 6px rgba(0,0,0,0.08)";
            card.style.fontSize = "14px";
            card.style.lineHeight = "20px";
            card.style.pointerEvents = "auto";
            card.style.backdropFilter = "saturate(180%) blur(2px)";

            const headline = plan.trial?.available
              ? `You won't be charged today (taxes may apply after trial). Your payment method will be stored.`
              : `Review your payment details.`;
            const followup = plan.trial?.available
              ? `Future charges will be ${currency}${amount} per ${period}${seatSuffix} + taxes.`
              : ``;
            card.textContent = `${headline} ${followup}`.trim();

            wrapper.appendChild(card);
            inner.appendChild(wrapper);

            // Cleanup when Dodo overlay is removed
            const observer = new MutationObserver(() => {
              const outer = document.getElementById("dodo-checkout-outer-div");
              if (!outer) {
                wrapper.remove();
                observer.disconnect();
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            return true;
          };

          // Retry a few times until the overlay DOM is present
          let attempts = 0;
          const tryAttach = () => {
            if (injectNotice()) {
              // Close our own modal once Dodo overlay is mounted
              onClose?.();
              return;
            }
            if (attempts++ < 30) setTimeout(tryAttach, 100);
          };
          tryAttach();
          // Fallback close in case we couldn't detect overlay but it opened
          setTimeout(() => onClose?.(), 800);
        } catch (e) {
          console.warn("Failed to inject Dodo overlay notice", e);
        }
      } else {
        setIntegrationError("Failed to create payment link");
        onPaymentError?.("Failed to create payment link");
      }
    } catch (err) {
      console.error(err);
      setIntegrationError("Failed to initialize payment. Please try again.");
      onPaymentError?.("Failed to initialize payment. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Overlay>
      <Card className="w-full max-w-lg max-h-[90vh] flex flex-col relative">
        <CardHeader className="flex-shrink-0">
          {onClose && (
            <CloseButton onClick={onClose} aria-label="Close modal">
              ×
            </CloseButton>
          )}
          <CardTitle>
            {plan?.trial?.available
              ? "Start your free trial"
              : "Enter your details"}
          </CardTitle>
          <CardDescription>
            {plan?.trial?.available
              ? `Start your ${plan.trial.days}-day free trial for ${plan.title}. You won't be charged today (taxes may apply after trial).`
              : `Please provide your information to proceed with the payment for ${plan?.title}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center min-h-[200px]">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Email */}
              <Input
                type="email"
                placeholder="Email address"
                value={customerEmail}
                onChange={(e) => {
                  setCustomerEmail(e.target.value);
                  setIntegrationError(null);
                }}
                required
              />
              {/* Full name */}
              <Input
                type="text"
                placeholder="Full name"
                value={customerName}
                onChange={(e) => {
                  setCustomerName(e.target.value);
                  setIntegrationError(null);
                }}
                required
              />
              {/* Business toggle */}
              <div className="flex items-center space-x-2 my-4">
                <Checkbox
                  id="business-toggle"
                  checked={isBusiness}
                  onCheckedChange={(checked: boolean) => setIsBusiness(checked)}
                />
                <Label htmlFor="business-toggle" className="cursor-pointer">
                  I&apos;m buying as a business
                </Label>
              </div>
              {isBusiness && (
                <>
                  <Input
                    type="text"
                    placeholder="Tax ID (VAT/EIN/GST/etc.)"
                    value={taxId}
                    onChange={(e) => setTaxId(e.target.value)}
                    required
                  />
                  <Input
                    type="text"
                    placeholder="Business name"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    required
                  />
                </>
              )}
              {/* Address */}
              <Input
                type="text"
                placeholder="Address"
                value={customerAddress}
                onChange={(e) => setCustomerAddress(e.target.value)}
                required
              />
              <Input
                type="text"
                placeholder="Address line 2 (Optional)"
                value={customerAddressLine2}
                onChange={(e) => setCustomerAddressLine2(e.target.value)}
              />
              <Input
                type="text"
                placeholder="ZIP code"
                value={customerZip}
                onChange={(e) => setCustomerZip(e.target.value)}
                required
              />
              <Input
                type="text"
                placeholder="City"
                value={customerCity}
                onChange={(e) => setCustomerCity(e.target.value)}
                required
              />
              <SearchableSelect
                options={customerCountries}
                value={customerCountry}
                onValueChange={(value) => {
                  setCustomerCountry(value);
                  if (value !== "US" && customerStateProvince) {
                    const isUSState = usStates.some(
                      (s) => s.value === customerStateProvince
                    );
                    if (isUSState) setCustomerStateProvince("");
                  }
                  setIntegrationError(null);
                }}
                placeholder="Select country"
                required
              />
              {customerCountry === "US" ? (
                <SearchableSelect
                  options={usStates}
                  value={customerStateProvince}
                  onValueChange={(value) => {
                    setCustomerStateProvince(value);
                    setIntegrationError(null);
                  }}
                  placeholder="Select state"
                  required
                />
              ) : (
                <Input
                  type="text"
                  placeholder="State/Province (optional)"
                  value={customerStateProvince}
                  onChange={(e) => setCustomerStateProvince(e.target.value)}
                />
              )}
              {integrationError && (
                <Alert variant="destructive">
                  <AlertDescription>{integrationError}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : plan?.trial?.available ? (
                  "Start Free Trial"
                ) : (plan?.selectedPrice ??
                    plan?.priceMonthly ??
                    plan?.price ??
                    0) === 0 ? (
                  "Start free subscription"
                ) : (
                  "Continue to payment"
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </Overlay>
  );
};

// ----------------------------------------------------------------------------
// Customer Portal (Shadcn)
// ----------------------------------------------------------------------------

// Simple Tabs component (inline to avoid import issues)
type TabsInternalProps = {
  activeTab?: string;
  setActiveTab?: (value: string) => void;
};
interface TabsProps {
  defaultValue: string;
  children: React.ReactNode;
  className?: string;
}

interface TabsListProps {
  children: React.ReactNode;
  className?: string;
}

interface TabsTriggerProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  isActive?: boolean;
}

interface TabsContentProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  isActive?: boolean;
}

const Tabs: React.FC<TabsProps> = ({
  defaultValue,
  children,
  className = "",
}) => {
  const [activeTab, setActiveTab] = useState(defaultValue);

  return (
    <div className={className}>
      {React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          return React.cloneElement(
            child as React.ReactElement<TabsInternalProps>,
            {
              activeTab,
              setActiveTab,
            }
          );
        }
        return child;
      })}
    </div>
  );
};

const TabsList: React.FC<
  TabsListProps & { activeTab?: string; setActiveTab?: (value: string) => void }
> = ({ children, className = "", activeTab, setActiveTab }) => (
  <div
    className={`inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground ${className}`}
  >
    {React.Children.map(children, (child) => {
      if (React.isValidElement(child)) {
        return React.cloneElement(
          child as React.ReactElement<TabsInternalProps>,
          {
            activeTab,
            setActiveTab,
          }
        );
      }
      return child;
    })}
  </div>
);

const TabsTrigger: React.FC<
  TabsTriggerProps & {
    activeTab?: string;
    setActiveTab?: (value: string) => void;
  }
> = ({ value, children, className = "", activeTab, setActiveTab }) => {
  const isActive = activeTab === value;
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        isActive
          ? "bg-background text-foreground shadow-sm"
          : "hover:bg-background/50",
        className
      )}
      onClick={() => setActiveTab?.(value)}
    >
      {children}
    </button>
  );
};

const TabsContent: React.FC<TabsContentProps & { activeTab?: string }> = ({
  value,
  children,
  className = "",
  activeTab,
}) => {
  if (activeTab !== value) return null;
  return (
    <div
      className={cn(
        "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
    >
      {children}
    </div>
  );
};

interface PortalOverview {
  portal: {
    customer: { id: string; name: string | null; email: string | null };
    subscription: {
      id: string;
      stableSubscriptionId: string;
      status: string;
      planId: string;
      gracePeriodEndsAt: string | null;
      paymentMethodId: string | null;
    } | null;
    paymentMethods: Array<{
      id: string;
      provider: string | null;
      paymentType: string | null;
      status: string | null;
      cardBrand: string | null;
      cardLastFour: string | null;
      cardExpiryMonth: number | null;
      cardExpiryYear: number | null;
      linkedToSubscription: boolean;
    }>;
    invoices: Array<{
      id: string;
      number: string | null;
      status: string;
      totalAmountCents: number;
      currency: string;
      issueDate: string | null;
      paidDate: string | null;
      pdfUrl: string | null;
      paymentStatus: string | null;
      // Optional: refund document metadata
      documentType?: "standard" | "cancellation" | "credit_note" | null;
      originalInvoiceId?: string | null;
      originalInvoiceNumber?: string | null;
    }>;
    payments: Array<{
      id: string;
      amountCents: number;
      currency: string;
      status: string;
      createdAt: string;
      errorMessage: string | null;
      invoiceId: string | null;
    }>;
  };
}

type CreateSetupIntentResponse =
  | {
      provider: "stripe";
      stripe: {
        clientSecret: string;
        intentId: string;
        publishableKey: string;
      };
    }
  | {
      provider: "dodo";
      dodo: { paymentLink: string };
    };

export function CustomerPortal({
  lumenHandlerUrl,
  externalCustomerId,
  className,
  apiBaseUrl = "https://api.getlumen.dev/v1",
  environment = "live",
}: {
  lumenHandlerUrl: string;
  externalCustomerId: string;
  className?: string;
  apiBaseUrl?: string;
  environment?: "test" | "live";
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PortalOverview["portal"] | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<{
    hasActiveSubscription: boolean;
    subscription: {
      planName: string;
      planDescription: string | null;
      startTimestamp: string;
      currency: string;
    } | null;
  } | null>(null);
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const initialPmCountRef = useRef<number | null>(null);
  const dodoPollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Initialize Dodo overlay once if available; fallback handled in startAddPaymentMethod
    try {
      const mode =
        typeof window !== "undefined" &&
        window.location.hostname === "localhost"
          ? "test"
          : "live";
      DodoPayments.Initialize({
        mode,
        theme: "light",
        linkType: "dynamic",
        displayType: "overlay",
        onEvent: (ev) => console.log("Dodo checkout event", ev),
      });
    } catch {
      // ignore; we'll open in new tab as fallback
    }
  }, []);

  const [addingPm, setAddingPm] = useState(false);
  const [stripePromise, setStripePromise] =
    useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [pmRefreshing, setPmRefreshing] = useState(false);
  const [listeningForSetupEvent, setListeningForSetupEvent] = useState(false);

  // Credit top-up state
  const [availableTopups, setAvailableTopups] = useState<AvailableTopup[]>([]);
  const [topupsLoading, setTopupsLoading] = useState(false);
  const [topupsError, setTopupsError] = useState<string | null>(null);
  const [selectedTopup, setSelectedTopup] = useState<AvailableTopup | null>(
    null
  );
  const [topupQuantity, setTopupQuantity] = useState<string>("1");
  const [topupDialogOpen, setTopupDialogOpen] = useState(false);
  const [topupPurchasing, setTopupPurchasing] = useState(false);
  const [topupPurchaseError, setTopupPurchaseError] = useState<string | null>(
    null
  );

  const fetchOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const [portalRes, statusRes] = await Promise.all([
        fetch(
          `${lumenHandlerUrl}/customers/portal/overview?externalCustomerId=${encodeURIComponent(
            externalCustomerId
          )}`,
          { credentials: "include" }
        ),
        fetch(
          `${lumenHandlerUrl}/customers/subscription-status?externalCustomerId=${encodeURIComponent(
            externalCustomerId
          )}`,
          { credentials: "include" }
        ),
      ]);

      if (!portalRes.ok)
        throw new Error(`Failed to load (${portalRes.status})`);
      const portalJson: PortalOverview = await portalRes.json();
      setData(portalJson.portal);

      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        setSubscriptionStatus(statusJson);
      }
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  const fetchAvailableTopups = async () => {
    setTopupsLoading(true);
    setTopupsError(null);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/credits/available-topups?externalCustomerId=${encodeURIComponent(
          externalCustomerId
        )}`,
        { credentials: "include" }
      );
      if (!res.ok) {
        if (res.status === 404) {
          setAvailableTopups([]);
          return;
        }
        throw new Error(`Failed to load topups (${res.status})`);
      }
      const json = await res.json();
      setAvailableTopups(json.availableTopups || []);
    } catch (e) {
      setTopupsError(getErrorMessage(e) || "Failed to load available top-ups");
    } finally {
      setTopupsLoading(false);
    }
  };

  const handleTopupPurchase = async () => {
    if (!selectedTopup) return;
    setTopupPurchasing(true);
    setTopupPurchaseError(null);
    const normalizedQuantity = clampTopupQuantity(
      topupQuantity,
      selectedTopup.minQuantity,
      selectedTopup.maxQuantity
    );
    setTopupQuantity(String(normalizedQuantity));
    try {
      const res = await fetch(`${lumenHandlerUrl}/credits/topup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          externalCustomerId,
          creditDefinitionId: selectedTopup.creditDefinitionId,
          quantity: normalizedQuantity,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Purchase failed (${res.status})`);
      }

      const result: TopupPurchaseResult = await res.json();

      // Check payment status to determine if credits are available immediately
      const paymentStatus = result.payment?.status;
      const isPaymentPending =
        paymentStatus === "pending" ||
        paymentStatus === "processing" ||
        paymentStatus === "requires_action";

      if (isPaymentPending) {
        // Payment is pending - show message about webhook confirmation
        setTopupPurchaseError(
          `Payment initiated successfully. Credits will be added automatically once payment is confirmed. You'll receive an email notification when your credits are available.`
        );
        // Keep dialog open to show the message, but allow closing
        setTopupPurchasing(false);
        // Refresh overview to show pending payment/invoice
        await fetchOverview();
        return;
      }

      // Payment succeeded synchronously - credits should be granted
      // Close dialog and refresh
      setTopupDialogOpen(false);
      setSelectedTopup(null);
      setTopupQuantity("1");
      // Refresh both credits and overview (for invoices/payments)
      await Promise.all([fetchAvailableTopups(), fetchOverview()]);
    } catch (e) {
      setTopupPurchaseError(getErrorMessage(e) || "Failed to purchase credits");
    } finally {
      setTopupPurchasing(false);
    }
  };

  const openTopupDialog = (topup: AvailableTopup) => {
    setSelectedTopup(topup);
    setTopupQuantity(String(topup.minQuantity));
    setTopupPurchaseError(null);
    setTopupDialogOpen(true);
  };

  useEffect(() => {
    fetchOverview();
    fetchAvailableTopups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalCustomerId, lumenHandlerUrl]);

  const startAddPaymentMethod = async () => {
    setError(null);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/customers/portal/create-setup-intent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ externalCustomerId }),
        }
      );
      if (!res.ok)
        throw new Error(`Failed to create setup intent (${res.status})`);
      const json: CreateSetupIntentResponse = await res.json();
      if (json.provider === "stripe") {
        setClientSecret(json.stripe.clientSecret);
        setStripePromise(loadStripe(json.stripe.publishableKey));
        setSetupIntentId(json.stripe.intentId);
        setAddingPm(true);
        setListeningForSetupEvent(true);
      } else if (json.provider === "dodo") {
        try {
          const link = json.dodo.paymentLink;
          const mode = environment;
          DodoPayments.Initialize({
            mode,
            theme: "light",
            linkType: "dynamic",
            displayType: "overlay",
          });
          DodoPayments.Checkout.open({
            paymentLink: link,
            redirectUrl: window.location.href,
          });
        } catch (e) {
          console.warn(
            "Failed to initialize Dodo overlay, opening in new tab",
            e
          );
          window.open(json.dodo.paymentLink, "_blank");
        }
        // Start polling for PM change
        initialPmCountRef.current = data?.paymentMethods.length ?? 0;
        setPmRefreshing(true);
        let attempts = 0;
        const maxAttempts = 15;
        const poll = async () => {
          try {
            const portalRes = await fetch(
              `${lumenHandlerUrl}/customers/portal/overview?externalCustomerId=${encodeURIComponent(
                externalCustomerId
              )}`,
              { credentials: "include" }
            );
            if (portalRes.ok) {
              const portalJson: PortalOverview = await portalRes.json();
              setData(portalJson.portal);
              const newCount = portalJson.portal.paymentMethods.length;
              if (
                (initialPmCountRef.current ?? 0) < newCount ||
                portalJson.portal.subscription?.status === "active"
              ) {
                setPmRefreshing(false);
                if (dodoPollTimerRef.current) {
                  clearTimeout(dodoPollTimerRef.current);
                  dodoPollTimerRef.current = null;
                }
                return;
              }
            }
          } catch {
            // ignore network errors and continue polling
          }
          if (++attempts <= maxAttempts) {
            dodoPollTimerRef.current = window.setTimeout(poll, 2000);
          } else {
            setPmRefreshing(false);
          }
        };
        poll();
      }
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to start payment method setup");
    }
  };

  // Listen for setup intent completion to refresh immediately
  useEffect(() => {
    if (!listeningForSetupEvent || !setupIntentId) return;
    try {
      const es = new EventSource(
        `${apiBaseUrl}/public/events/${encodeURIComponent(setupIntentId)}`
      );
      es.addEventListener("stripe_event", async (ev: MessageEvent) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data);
          const type = data.type as string;
          if (type === "setup_intent.succeeded") {
            setAddingPm(false);
            setClientSecret(null);
            setSetupIntentId(null);
            setPmRefreshing(true);
            es.close();
            window.setTimeout(async () => {
              await fetchOverview();
              setPmRefreshing(false);
              setListeningForSetupEvent(false);
            }, 2000);
          }
        } catch {
          // ignore
        }
      });
      es.onerror = () => {
        es.close();
      };
      return () => es.close();
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listeningForSetupEvent, setupIntentId, apiBaseUrl]);

  const setDefaultPaymentMethod = async (paymentMethodId: string) => {
    setError(null);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/customers/portal/set-subscription-payment-method`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ externalCustomerId, paymentMethodId }),
        }
      );
      if (!res.ok)
        throw new Error(`Failed to set payment method (${res.status})`);
      await fetchOverview();
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to set default payment method");
    }
  };

  const removePaymentMethod = async (paymentMethodId: string) => {
    setError(null);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/customers/portal/payment-methods/${encodeURIComponent(paymentMethodId)}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!res.ok)
        throw new Error(`Failed to remove payment method (${res.status})`);
      await fetchOverview();
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to remove payment method");
    }
  };

  const formatCurrency = (amountCents: number, currency: string) => {
    const amount = (amountCents / 100).toFixed(2);
    const symbol = currencySymbol(currency);
    return `${symbol}${amount}`;
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "—";
    return new Date(dateString).toLocaleDateString();
  };

  const formatDateTime = (dateString: string | null) => {
    if (!dateString) return "—";
    try {
      const d = new Date(dateString);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      return formatDate(dateString);
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "active":
      case "paid":
      case "succeeded":
        return "bg-green-100 text-green-800 border-green-200";
      case "past_due":
      case "failed":
        return "bg-red-100 text-red-800 border-red-200";
      case "pending":
      case "processing":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "canceled":
      case "cancelled":
        return "bg-gray-100 text-gray-800 border-gray-200";
      default:
        return "bg-blue-100 text-blue-800 border-blue-200";
    }
  };

  const getCardBrandTheme = (brand?: string) => {
    const name = (brand || "").toLowerCase();
    switch (name) {
      case "visa":
        return { bg: "bg-blue-50 border-blue-200", fg: "text-blue-700" };
      case "mastercard":
        return { bg: "bg-amber-50 border-amber-200", fg: "text-amber-700" };
      case "amex":
      case "american express":
        return { bg: "bg-cyan-50 border-cyan-200", fg: "text-cyan-700" };
      case "discover":
        return { bg: "bg-orange-50 border-orange-200", fg: "text-orange-700" };
      case "diners":
      case "diners club":
        return { bg: "bg-pink-50 border-pink-200", fg: "text-pink-700" };
      case "jcb":
        return { bg: "bg-indigo-50 border-indigo-200", fg: "text-indigo-700" };
      default:
        return { bg: "bg-gray-50 border-gray-200", fg: "text-gray-700" };
    }
  };

  const toTitleCase = (value: string) =>
    value ? value.charAt(0).toUpperCase() + value.slice(1) : value;

  const formatPaymentMethodTitle = (pm: {
    cardBrand: string | null;
    paymentType: string | null;
    provider: string | null;
    cardLastFour: string | null;
  }) => {
    const name = toTitleCase(
      String(pm.cardBrand || pm.paymentType || pm.provider || "Card")
    );
    return pm.cardLastFour ? `${name} ending in ${pm.cardLastFour}` : name;
  };

  const BrandLogo: React.FC<{
    brand?: string | null;
    className?: string;
  }> = ({ brand, className = "" }) => {
    const b = (brand || "").toLowerCase();
    if (b === "mastercard") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <circle cx="15" cy="12" r="7.5" fill="#EB001B" />
          <circle cx="25" cy="12" r="7.5" fill="#F79E1B" />
        </svg>
      );
    }
    if (b === "visa") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <text
            x="4"
            y="16"
            fontSize="12"
            fontWeight="700"
            fill="#1A1F71"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
          >
            VISA
          </text>
        </svg>
      );
    }
    if (b === "amex" || b === "american express") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <rect x="3" y="5" width="34" height="14" rx="2" fill="#2E77BC" />
          <text
            x="20"
            y="16"
            fontSize="10"
            fontWeight="700"
            fill="#fff"
            textAnchor="middle"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
          >
            AMEX
          </text>
        </svg>
      );
    }
    if (b === "discover") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <circle cx="30" cy="12" r="6" fill="#F76B1C" />
          <text
            x="4"
            y="16"
            fontSize="10"
            fontWeight="700"
            fill="#111827"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
          >
            DISC
          </text>
        </svg>
      );
    }
    if (b === "jcb") {
      return (
        <svg viewBox="0 0 40 24" className={className} aria-hidden>
          <text
            x="8"
            y="16"
            fontSize="12"
            fontWeight="700"
            fill="#0B6BB8"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
          >
            JCB
          </text>
        </svg>
      );
    }
    return <CreditCard className={className} />;
  };

  const handleDownloadInvoice = async (invoiceId: string) => {
    setPdfLoadingId(invoiceId);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/invoices/${encodeURIComponent(invoiceId)}/pdf`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`Failed to get PDF URL (${res.status})`);
      const data = await res.json();
      if (!data?.pdfUrl) throw new Error("No PDF URL received");
      window.open(data.pdfUrl as string, "_blank");
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to download invoice");
    } finally {
      setPdfLoadingId(null);
    }
  };

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading Customer Portal
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-red-600 flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            Error Loading Portal
          </CardTitle>
          <CardDescription className="text-red-600">{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={fetchOverview} variant="outline">
            Try Again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card className={className}>
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>Account Overview</CardTitle>
            <CardDescription className="mt-1">
              {data.customer.name && (
                <span className="font-medium">{data.customer.name} • </span>
              )}
              {data.customer.email}
            </CardDescription>
            {subscriptionStatus?.hasActiveSubscription &&
              subscriptionStatus.subscription && (
                <div className="text-xs text-muted-foreground mt-1">
                  Plan: {subscriptionStatus.subscription.planName} • Active
                  since{" "}
                  {formatDateTime(
                    subscriptionStatus.subscription.startTimestamp
                  )}
                </div>
              )}
          </div>
          {data.subscription && (
            <Badge className={getStatusBadgeColor(data.subscription.status)}>
              {data.subscription.status}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="payment-methods" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="payment-methods">Payment Methods</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="payments">Payment History</TabsTrigger>
            <TabsTrigger value="credits">Credits</TabsTrigger>
          </TabsList>

          <TabsContent value="payment-methods" className="mt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">Payment Methods</h3>
                  <p className="text-sm text-muted-foreground">
                    Manage your saved payment methods
                  </p>
                </div>
                <Button onClick={startAddPaymentMethod} size="sm">
                  Add Payment Method
                </Button>
              </div>

              {pmRefreshing ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    Updating payment methods...
                  </span>
                </div>
              ) : data.paymentMethods.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-muted-foreground mb-2">
                    No payment methods found
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Add a payment method to manage your subscription
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {data.paymentMethods.map((pm) => (
                    <div
                      key={pm.id}
                      className="flex items-center justify-between p-4 border rounded-xl hover:bg-gray-50 shadow-sm hover:shadow transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            "h-10 w-16 rounded-md border flex items-center justify-center",
                            getCardBrandTheme(
                              pm.cardBrand || pm.provider || undefined
                            ).bg
                          )}
                        >
                          <BrandLogo
                            brand={pm.cardBrand || pm.provider}
                            className={cn(
                              "h-5 w-auto",
                              getCardBrandTheme(
                                pm.cardBrand || pm.provider || undefined
                              ).fg
                            )}
                          />
                        </div>
                        <div>
                          <div className="font-medium">
                            {formatPaymentMethodTitle(pm)}
                          </div>
                          {pm.cardExpiryMonth && pm.cardExpiryYear ? (
                            <div className="text-xs text-muted-foreground">
                              Expires{" "}
                              {pm.cardExpiryMonth.toString().padStart(2, "0")}/
                              {pm.cardExpiryYear}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {data.subscription?.paymentMethodId === pm.id ? (
                          <Badge className="bg-green-100 text-green-800 border-green-200">
                            Default
                          </Badge>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDefaultPaymentMethod(pm.id)}
                          >
                            Set as Default
                          </Button>
                        )}
                        {!(
                          pm.linkedToSubscription ||
                          data.subscription?.paymentMethodId === pm.id
                        ) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removePaymentMethod(pm.id)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="invoices" className="mt-6">
            <div className="space-y-4">
              <div>
                <h3 className="font-medium">Invoices</h3>
                <p className="text-sm text-muted-foreground">
                  View and download your invoices
                </p>
              </div>

              {data.invoices.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-muted-foreground mb-2">
                    No invoices found
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Your invoices will appear here once generated
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.invoices.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span>#{inv.number || inv.id.slice(-6)}</span>
                              {inv.documentType &&
                                inv.documentType !== "standard" && (
                                  <Badge variant="outline">
                                    {inv.documentType === "cancellation"
                                      ? "Cancellation"
                                      : "Credit Note"}
                                  </Badge>
                                )}
                            </div>
                            {inv.originalInvoiceId && (
                              <div className="text-xs text-muted-foreground mt-1">
                                Ref: #
                                {inv.originalInvoiceNumber ||
                                  inv.originalInvoiceId}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDateTime(inv.issueDate)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {formatCurrency(inv.totalAmountCents, inv.currency)}
                        </TableCell>
                        <TableCell>
                          <Badge className={getStatusBadgeColor(inv.status)}>
                            {inv.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDownloadInvoice(inv.id)}
                            disabled={!inv.pdfUrl || pdfLoadingId === inv.id}
                            aria-disabled={!inv.pdfUrl}
                          >
                            {pdfLoadingId === inv.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              "PDF"
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="payments" className="mt-6">
            <div className="space-y-4">
              <div>
                <h3 className="font-medium">Payment History</h3>
                <p className="text-sm text-muted-foreground">
                  View your recent payment transactions
                </p>
              </div>

              {data.payments.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-muted-foreground mb-2">
                    No payments found
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Your payment history will appear here
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Amount</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">
                          {formatCurrency(p.amountCents, p.currency)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDateTime(p.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div>
                            <Badge className={getStatusBadgeColor(p.status)}>
                              {p.status}
                            </Badge>
                            {p.errorMessage && (
                              <div className="text-xs text-red-600 mt-1">
                                {p.errorMessage}
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="credits" className="mt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">Credit Top-ups</h3>
                  <p className="text-sm text-muted-foreground">
                    Purchase additional credits for your features
                  </p>
                </div>
                {!topupsLoading && availableTopups.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={fetchAvailableTopups}
                    className="text-muted-foreground"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                )}
              </div>

              {topupsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    Loading available top-ups...
                  </span>
                </div>
              ) : topupsError ? (
                <div className="text-center py-8">
                  <div className="text-red-600 mb-2">{topupsError}</div>
                  <Button
                    onClick={fetchAvailableTopups}
                    variant="outline"
                    size="sm"
                  >
                    Try Again
                  </Button>
                </div>
              ) : availableTopups.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-muted-foreground mb-2">
                    No credit top-ups available
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Credit top-ups will appear here when enabled for your plan
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {availableTopups.map((topup) => {
                    const usagePercent =
                      topup.creditAllowance > 0
                        ? Math.round(
                            ((topup.creditAllowance - topup.creditsRemaining) /
                              topup.creditAllowance) *
                              100
                          )
                        : 0;
                    return (
                      <div
                        key={topup.creditDefinitionId}
                        className="border rounded-lg p-4 hover:border-primary/30 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
                              <Coins className="h-5 w-5 text-amber-600" />
                            </div>
                            <div>
                              <div className="font-medium">
                                {topup.featureName}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {formatCurrency(
                                  topup.topupPricePerCreditCents,
                                  topup.currency
                                )}{" "}
                                per credit
                                {topup.maxQuantity &&
                                  ` • Max ${topup.maxQuantity.toLocaleString()}`}
                              </div>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => openTopupDialog(topup)}
                          >
                            <Plus className="h-4 w-4 mr-1" />
                            Buy
                          </Button>
                        </div>

                        <div className="space-y-2">
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">
                              Credits Remaining
                            </span>
                            <span
                              className={`font-medium ${
                                topup.creditsRemaining === 0
                                  ? "text-red-600"
                                  : usagePercent >= 80
                                    ? "text-amber-600"
                                    : "text-green-600"
                              }`}
                            >
                              {topup.creditsRemaining.toLocaleString()}{" "}
                              <span className="text-muted-foreground font-normal">
                                / {topup.creditAllowance.toLocaleString()}
                              </span>
                            </span>
                          </div>
                          <Progress
                            value={100 - usagePercent}
                            className={`h-2 ${
                              topup.creditsRemaining === 0
                                ? "[&>div]:bg-red-500"
                                : usagePercent >= 80
                                  ? "[&>div]:bg-amber-500"
                                  : "[&>div]:bg-green-500"
                            }`}
                          />
                          {topup.creditsRemaining === 0 ? (
                            <div className="text-xs text-red-600 font-medium pt-1">
                              Credits depleted - purchase more to continue using
                              this feature
                            </div>
                          ) : usagePercent >= 80 ? (
                            <div className="text-xs text-amber-600 pt-1">
                              Running low -{" "}
                              {topup.creditsRemaining.toLocaleString()} credits
                              left
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground pt-1">
                              {topup.creditAllowance - topup.creditsRemaining}{" "}
                              of {topup.creditAllowance.toLocaleString()}{" "}
                              credits used
                            </div>
                          )}
                          {topup.expiryBehavior !== "never" &&
                            topup.estimatedExpiryDate && (
                              <div className="text-xs text-muted-foreground pt-1">
                                Expires{" "}
                                {new Date(
                                  topup.estimatedExpiryDate
                                ).toLocaleDateString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })}
                              </div>
                            )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {/* Credit Top-up Purchase Dialog */}
        {topupDialogOpen && selectedTopup && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white rounded-xl shadow-lg max-w-md w-full mx-4 p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-lg">Purchase Credits</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedTopup.featureName}
                  </p>
                </div>
                <button
                  onClick={() => setTopupDialogOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">
                    Number of credits
                  </label>
                  <input
                    type="number"
                    value={topupQuantity}
                    onChange={(e) => setTopupQuantity(e.target.value)}
                    onBlur={() => {
                      const normalized = clampTopupQuantity(
                        topupQuantity,
                        selectedTopup.minQuantity,
                        selectedTopup.maxQuantity
                      );
                      setTopupQuantity(String(normalized));
                    }}
                    min={selectedTopup.minQuantity}
                    max={selectedTopup.maxQuantity || undefined}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>
                      Min: {selectedTopup.minQuantity}
                      {selectedTopup.maxQuantity &&
                        ` • Max: ${selectedTopup.maxQuantity.toLocaleString()}`}
                    </span>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Price per credit
                    </span>
                    <span>
                      {formatCurrency(
                        selectedTopup.topupPricePerCreditCents,
                        selectedTopup.currency
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Quantity</span>
                    <span>{Number(topupQuantity || 0).toLocaleString()}</span>
                  </div>
                  <div className="border-t pt-2 flex justify-between font-semibold">
                    <span>Total</span>
                    <span>
                      {formatCurrency(
                        selectedTopup.topupPricePerCreditCents *
                          Number(topupQuantity),
                        selectedTopup.currency
                      )}
                    </span>
                  </div>
                </div>

                {selectedTopup.expiryBehavior !== "never" && (
                  <p className="text-xs text-muted-foreground">
                    {selectedTopup.expiryBehavior === "billing_cycle"
                      ? "Credits will expire at end of billing cycle"
                      : selectedTopup.estimatedExpiryDate
                        ? `Credits will expire on ${new Date(
                            selectedTopup.estimatedExpiryDate
                          ).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}`
                        : "Credits will expire after the configured period"}
                  </p>
                )}

                {topupPurchaseError && (
                  <div
                    className={`text-sm rounded-lg p-3 ${
                      topupPurchaseError.includes(
                        "Payment initiated successfully"
                      )
                        ? "text-blue-700 bg-blue-50 border border-blue-200"
                        : "text-red-600 bg-red-50"
                    }`}
                  >
                    {topupPurchaseError.includes(
                      "Payment initiated successfully"
                    ) && (
                      <div className="flex items-start gap-2">
                        <div className="flex-shrink-0 mt-0.5">
                          <svg
                            className="h-4 w-4 text-blue-600"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-blue-800 mb-1">
                            Payment Processing
                          </p>
                          <p className="text-blue-700">{topupPurchaseError}</p>
                        </div>
                      </div>
                    )}
                    {!topupPurchaseError.includes(
                      "Payment initiated successfully"
                    ) && topupPurchaseError}
                  </div>
                )}

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setTopupDialogOpen(false)}
                    disabled={topupPurchasing}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={handleTopupPurchase}
                    disabled={topupPurchasing}
                  >
                    {topupPurchasing ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        Purchase for{" "}
                        {formatCurrency(
                          selectedTopup.topupPricePerCreditCents *
                            Number(topupQuantity),
                          selectedTopup.currency
                        )}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {addingPm && stripePromise && clientSecret ? (
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <CustomerPortalAddPaymentMethodModal
              onClose={(reason) => {
                setAddingPm(false);
                setClientSecret(null);
                if (reason === "cancelled") {
                  setListeningForSetupEvent(false);
                  setSetupIntentId(null);
                }
              }}
            />
          </Elements>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CustomerPortalAddPaymentMethodModal({
  onClose,
}: {
  onClose: (reason: "submitted" | "cancelled") => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setError(null);
    setProcessing(true);
    try {
      const { error } = await elements.submit();
      if (error) throw new Error(error.message);
      const result = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
      });
      if (result.error) throw new Error(result.error.message);
      onClose("submitted");
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to confirm payment method");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <Overlay>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Add payment method</CardTitle>
          <CardDescription>
            Your card will be stored for future charges.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <PaymentElement id="payment-element" />
            {error ? <div className="text-sm text-red-600">{error}</div> : null}
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={() => onClose("cancelled")}
                disabled={processing}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={processing}>
                {processing ? "Processing..." : "Confirm"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </Overlay>
  );
}

export { CustomerPortal as CustomerPortalShadcn };

/**
 * Standalone Credit Top-up Component
 * Allows customers to purchase additional credits for enabled features.
 */
export function CreditTopup({
  lumenHandlerUrl,
  externalCustomerId,
  className,
}: {
  lumenHandlerUrl: string;
  externalCustomerId: string;
  className?: string;
}) {
  const [availableTopups, setAvailableTopups] = useState<AvailableTopup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTopup, setSelectedTopup] = useState<AvailableTopup | null>(
    null
  );
  const [topupQuantity, setTopupQuantity] = useState<string>("1");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const fetchAvailableTopups = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${lumenHandlerUrl}/credits/available-topups?externalCustomerId=${encodeURIComponent(
          externalCustomerId
        )}`,
        { credentials: "include" }
      );
      if (!res.ok) {
        if (res.status === 404) {
          setAvailableTopups([]);
          return;
        }
        throw new Error(`Failed to load topups (${res.status})`);
      }
      const json = await res.json();
      setAvailableTopups(json.availableTopups || []);
    } catch (e) {
      setError(getErrorMessage(e) || "Failed to load available top-ups");
    } finally {
      setLoading(false);
    }
  };

  const handlePurchase = async () => {
    if (!selectedTopup) return;
    setPurchasing(true);
    setPurchaseError(null);
    const normalizedQuantity = clampTopupQuantity(
      topupQuantity,
      selectedTopup.minQuantity,
      selectedTopup.maxQuantity
    );
    setTopupQuantity(String(normalizedQuantity));
    try {
      const res = await fetch(`${lumenHandlerUrl}/credits/topup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          externalCustomerId,
          creditDefinitionId: selectedTopup.creditDefinitionId,
          quantity: normalizedQuantity,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Purchase failed (${res.status})`);
      }

      const result: TopupPurchaseResult = await res.json();

      // Check payment status to determine if credits are available immediately
      const paymentStatus = result.payment?.status;
      const isPaymentPending =
        paymentStatus === "pending" ||
        paymentStatus === "processing" ||
        paymentStatus === "requires_action";

      if (isPaymentPending) {
        // Payment is pending - show message about webhook confirmation
        setPurchaseError(
          `Payment initiated successfully. Credits will be added automatically once payment is confirmed. You'll receive an email notification when your credits are available.`
        );
        setPurchasing(false);
        return;
      }

      // Payment succeeded synchronously - credits should be granted
      setDialogOpen(false);
      setSelectedTopup(null);
      setTopupQuantity("1");
      await fetchAvailableTopups();
    } catch (e) {
      setPurchaseError(getErrorMessage(e) || "Failed to purchase credits");
    } finally {
      setPurchasing(false);
    }
  };

  const openDialog = (topup: AvailableTopup) => {
    setSelectedTopup(topup);
    setTopupQuantity(String(topup.minQuantity));
    setPurchaseError(null);
    setDialogOpen(true);
  };

  useEffect(() => {
    fetchAvailableTopups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalCustomerId, lumenHandlerUrl]);

  const formatCurrency = (amountCents: number, currency: string) => {
    const amount = (amountCents / 100).toFixed(2);
    const symbol = currencySymbol(currency);
    return `${symbol}${amount}`;
  };

  const formatDateShort = (dateString: string | null) => {
    if (!dateString) return "—";
    return new Date(dateString).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading Credits
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-red-600 flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            Error Loading Credits
          </CardTitle>
          <CardDescription className="text-red-600">{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={fetchAvailableTopups} variant="outline">
            Try Again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (availableTopups.length === 0) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            Credits
          </CardTitle>
          <CardDescription>
            No credit top-ups available for your plan
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card className={className}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-5 w-5" />
              Credit Top-ups
            </CardTitle>
            <CardDescription>
              Purchase additional credits for your features
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchAvailableTopups}
            className="text-muted-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {availableTopups.map((topup) => {
              const usagePercent =
                topup.creditAllowance > 0
                  ? Math.round(
                      ((topup.creditAllowance - topup.creditsRemaining) /
                        topup.creditAllowance) *
                        100
                    )
                  : 0;
              return (
                <div
                  key={topup.creditDefinitionId}
                  className="border rounded-lg p-4 hover:border-primary/30 transition-colors"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
                        <Coins className="h-5 w-5 text-amber-600" />
                      </div>
                      <div>
                        <div className="font-medium">{topup.featureName}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatCurrency(
                            topup.topupPricePerCreditCents,
                            topup.currency
                          )}{" "}
                          per credit
                          {topup.maxQuantity &&
                            ` • Max ${topup.maxQuantity.toLocaleString()}`}
                        </div>
                      </div>
                    </div>
                    <Button size="sm" onClick={() => openDialog(topup)}>
                      <Plus className="h-4 w-4 mr-1" />
                      Buy
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Credits Remaining
                      </span>
                      <span
                        className={`font-medium ${
                          topup.creditsRemaining === 0
                            ? "text-red-600"
                            : usagePercent >= 80
                              ? "text-amber-600"
                              : "text-green-600"
                        }`}
                      >
                        {topup.creditsRemaining.toLocaleString()}{" "}
                        <span className="text-muted-foreground font-normal">
                          / {topup.creditAllowance.toLocaleString()}
                        </span>
                      </span>
                    </div>
                    <Progress
                      value={100 - usagePercent}
                      className={`h-2 ${
                        topup.creditsRemaining === 0
                          ? "[&>div]:bg-red-500"
                          : usagePercent >= 80
                            ? "[&>div]:bg-amber-500"
                            : "[&>div]:bg-green-500"
                      }`}
                    />
                    {topup.creditsRemaining === 0 ? (
                      <div className="text-xs text-red-600 font-medium pt-1">
                        Credits depleted - purchase more to continue using this
                        feature
                      </div>
                    ) : usagePercent >= 80 ? (
                      <div className="text-xs text-amber-600 pt-1">
                        Running low - {topup.creditsRemaining.toLocaleString()}{" "}
                        credits left
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground pt-1">
                        {topup.creditAllowance - topup.creditsRemaining} of{" "}
                        {topup.creditAllowance.toLocaleString()} credits used
                      </div>
                    )}
                    {topup.expiryBehavior !== "never" &&
                      topup.estimatedExpiryDate && (
                        <div className="text-xs text-muted-foreground pt-1">
                          Expires {formatDateShort(topup.estimatedExpiryDate)}
                        </div>
                      )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Purchase Dialog */}
      {dialogOpen && selectedTopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full mx-4 p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="font-semibold text-lg">Purchase Credits</h3>
                <p className="text-sm text-muted-foreground">
                  {selectedTopup.featureName}
                </p>
              </div>
              <button
                onClick={() => setDialogOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">
                  Number of credits
                </label>
                <input
                  type="number"
                  value={topupQuantity}
                  onChange={(e) => setTopupQuantity(e.target.value)}
                  onBlur={() => {
                    const normalized = clampTopupQuantity(
                      topupQuantity,
                      selectedTopup.minQuantity,
                      selectedTopup.maxQuantity
                    );
                    setTopupQuantity(String(normalized));
                  }}
                  min={selectedTopup.minQuantity}
                  max={selectedTopup.maxQuantity || undefined}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>
                    Min: {selectedTopup.minQuantity}
                    {selectedTopup.maxQuantity &&
                      ` • Max: ${selectedTopup.maxQuantity.toLocaleString()}`}
                  </span>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    Price per credit
                  </span>
                  <span>
                    {formatCurrency(
                      selectedTopup.topupPricePerCreditCents,
                      selectedTopup.currency
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Quantity</span>
                  <span>{Number(topupQuantity || 0).toLocaleString()}</span>
                </div>
                <div className="border-t pt-2 flex justify-between font-semibold">
                  <span>Total</span>
                  <span>
                    {formatCurrency(
                      selectedTopup.topupPricePerCreditCents *
                        Number(topupQuantity),
                      selectedTopup.currency
                    )}
                  </span>
                </div>
              </div>

              {selectedTopup.expiryBehavior !== "never" && (
                <p className="text-xs text-muted-foreground">
                  {selectedTopup.expiryBehavior === "billing_cycle"
                    ? "Credits will expire at end of billing cycle"
                    : selectedTopup.estimatedExpiryDate
                      ? `Credits will expire on ${formatDateShort(
                          selectedTopup.estimatedExpiryDate
                        )}`
                      : "Credits will expire after the configured period"}
                </p>
              )}

              {purchaseError && (
                <div
                  className={`text-sm rounded-lg p-3 ${
                    purchaseError.includes("Payment initiated successfully")
                      ? "text-blue-700 bg-blue-50 border border-blue-200"
                      : "text-red-600 bg-red-50"
                  }`}
                >
                  {purchaseError.includes("Payment initiated successfully") && (
                    <div className="flex items-start gap-2">
                      <div className="flex-shrink-0 mt-0.5">
                        <svg
                          className="h-4 w-4 text-blue-600"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-blue-800 mb-1">
                          Payment Processing
                        </p>
                        <p className="text-blue-700">{purchaseError}</p>
                      </div>
                    </div>
                  )}
                  {!purchaseError.includes("Payment initiated successfully") &&
                    purchaseError}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setDialogOpen(false)}
                  disabled={purchasing}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  onClick={handlePurchase}
                  disabled={purchasing}
                >
                  {purchasing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      Purchase for{" "}
                      {formatCurrency(
                        selectedTopup.topupPricePerCreditCents *
                          Number(topupQuantity),
                        selectedTopup.currency
                      )}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { CreditTopup as CreditTopupShadcn };
