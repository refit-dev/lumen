import { formatCurrency } from "@lumen/common/utils";
import { Info, Receipt } from "lucide-react";

interface TaxSummaryProps {
  invoice: {
    subtotalCents: number | null;
    taxAmountCents: number | null;
    totalAmountCents: number;
    effectiveTaxRate: string | null;
    taxJurisdiction: string | null;
    taxCalculationMethod: string | null;
    currency: string;
    // Enhanced tax information
    taxLineItemDescriptions?: string[];
    exemptionReason?: string | null;
    taxFullDescription?: string | null;
  };
}

export function TaxSummary({ invoice }: TaxSummaryProps) {
  const subtotalCents = invoice.subtotalCents || 0;
  const taxAmountCents = invoice.taxAmountCents || 0;
  const isExempt = invoice.taxCalculationMethod === "exempt";
  const hasZeroTax = taxAmountCents === 0 && !isExempt;

  // Careful currency fallback - only when absolutely no currency data exists
  const displayCurrency = invoice.currency || "USD";

  // Get tax description - use line item descriptions when available, otherwise build from rate
  const getTaxDescription = () => {
    // First priority: Use tax line item descriptions from auto-calculation
    if (
      invoice.taxLineItemDescriptions &&
      invoice.taxLineItemDescriptions.length > 0
    ) {
      return `Tax: ${invoice.taxLineItemDescriptions[0]}`;
    }

    if (isExempt) {
      return "Tax (Exempt)";
    }

    if (hasZeroTax) {
      // For reverse charge, show as "0%: Reverse Charge"
      if (invoice.exemptionReason === "reverse_charge") {
        return "0%: Reverse Charge";
      }
      return "Tax (0%)";
    }

    if (invoice.effectiveTaxRate) {
      const rate = (parseFloat(invoice.effectiveTaxRate) * 100).toFixed(2);
      return `Tax (${rate}%${invoice.taxJurisdiction ? ` - ${invoice.taxJurisdiction}` : ""})`;
    }

    return "Tax";
  };

  const getExemptionOrZeroReason = () => {
    if (invoice.exemptionReason) {
      return invoice.exemptionReason;
    }

    // Use tax line item description as the explanation if available
    if (
      invoice.taxLineItemDescriptions &&
      invoice.taxLineItemDescriptions.length > 0
    ) {
      return invoice.taxLineItemDescriptions[0];
    }

    if (isExempt) {
      return "Customer is tax exempt";
    }

    if (hasZeroTax && invoice.taxJurisdiction) {
      return `No tax applicable in ${invoice.taxJurisdiction}`;
    }

    return null;
  };

  return (
    <div className="bg-gray-50/50 rounded-lg p-6 space-y-4">
      {/* Subtotal */}
      <div className="flex justify-between items-center">
        <div className="text-sm font-medium text-gray-700">Subtotal</div>
        <div className="text-sm font-semibold text-gray-900">
          {formatCurrency(subtotalCents, displayCurrency)}
        </div>
      </div>

      {/* Tax Line */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <div className="flex items-center space-x-2">
            <Receipt className="h-4 w-4 text-blue-500" />
            <div className="text-sm font-medium text-gray-700">
              {getTaxDescription()}
            </div>
          </div>
          <div
            className={`text-sm font-semibold ${
              taxAmountCents > 0 ? "text-gray-900" : "text-gray-500"
            }`}
          >
            {formatCurrency(taxAmountCents, displayCurrency)}
          </div>
        </div>

        {/* Tax reason/explanation */}
        {(isExempt || hasZeroTax) && getExemptionOrZeroReason() && (
          <div className="flex items-start space-x-2 ml-6 pl-2 border-l-2 border-blue-200">
            <Info className="h-3 w-3 text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-blue-700 leading-relaxed">
              {getExemptionOrZeroReason()}
            </div>
          </div>
        )}
      </div>

      {/* Tax Information Section */}
      {invoice.taxFullDescription && (
        <div className="pt-3 border-t border-gray-100">
          <div className="mb-2">
            <p className="text-sm font-medium text-gray-700">Tax Information</p>
          </div>
          <div className="text-xs text-gray-600 leading-relaxed">
            [1] {invoice.taxFullDescription}
          </div>
        </div>
      )}

      {/* Total */}
      <div className="flex justify-between items-center pt-4 border-t border-gray-200">
        <div className="text-base font-semibold text-gray-900">Total</div>
        <div className="text-base font-bold text-gray-900">
          {formatCurrency(invoice.totalAmountCents, displayCurrency)}
        </div>
      </div>
    </div>
  );
}
