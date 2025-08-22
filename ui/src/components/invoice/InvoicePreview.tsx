import React from "react";
import { type CustomerFromApi } from "@lumen/common/schema";
import {
  getAddress,
  type CustomerWithBillingAddress,
  getAddressMerchant,
  type MerchantWithAddress,
  supportedCustomerCountries,
} from "@lumen/common/utils";
import { type MerchantFromApi } from "@lumen/common/schema";
import { formatCurrency } from "@lumen/common/utils";

export interface InvoiceItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
}

export interface InvoicePreviewData {
  invoiceNumber: string;
  customer?: CustomerFromApi;
  businessName?: string;
  issueDate: string;
  dueDate: string;
  billingPeriod?: string | null;
  items: InvoiceItem[];
  notes?: string;
  merchant: MerchantFromApi;
  currency?: "EUR" | "USD";
  taxNote?: string;
  subtotalCents?: number | null;
  taxAmountCents?: number | null;
  totalAmountCents?: number;
  effectiveTaxRate?: string | null;
  taxJurisdiction?: string | null;
  taxCalculationMethod?: string | null;
  exemptionReason?: string | null;
  taxLineItemDescriptions?: string[];
  taxReferences?: Array<{
    referenceNumber: number;
    shortDescription: string;
    fullDescription: string;
  }>;
  taxDescription?: string;
  // Raw tax line items (optional) to extract full descriptions when references are not pre-computed
  taxLineItems?: Array<{
    type: "tax";
    description: string;
    subtotalCents: number;
    taxMetadata?: {
      fullDescription?: string;
    } | null;
  }>;
}

export const InvoicePreview: React.FC<{ data: InvoicePreviewData }> = ({
  data,
}) => {
  const subtotal = data.subtotalCents || 0;
  const taxAmount = data.taxAmountCents || 0;
  const total = data.totalAmountCents || subtotal + taxAmount;

  // Careful currency fallback - only when absolutely no currency data exists
  const getDisplayCurrency = (): string => {
    // First priority: Use the invoice currency if specified
    if (data.currency) {
      return data.currency;
    }

    // Final fallback only when absolutely no currency data exists
    // Note: This should ideally come from merchant settings or system configuration
    return "USD";
  };

  const displayCurrency = getDisplayCurrency();

  // Helper function to format currency amounts
  const formatAmount = (amount: number) => {
    return formatCurrency(amount, displayCurrency);
  };

  // Build tax reference entries. Prioritise pre-computed taxReferences, else derive
  const derivedTaxReferences: Array<{
    referenceNumber: number;
    fullDescription: string;
  }> =
    data.taxReferences && data.taxReferences.length > 0
      ? data.taxReferences
      : ((data.taxLineItems || [])
          .map((item, idx) => {
            const full = item.taxMetadata?.fullDescription;
            return full
              ? { referenceNumber: idx + 1, fullDescription: full }
              : null;
          })
          .filter(Boolean) as Array<{
          referenceNumber: number;
          fullDescription: string;
        }>);

  // Helper function to get the appropriate tax ID label based on customer's country
  const getTaxIdLabel = (customer: CustomerFromApi) => {
    if (!customer.billingCountry) {
      return "Tax ID";
    }

    const countryConfig = supportedCustomerCountries.find(
      (c) => c.value === customer.billingCountry
    );

    return countryConfig?.taxLabel || "Tax ID";
  };

  // Helper function to get the appropriate tax ID label based on merchant's country
  const getMerchantTaxIdLabel = (merchant: MerchantFromApi) => {
    if (!merchant.country) {
      return "Tax ID";
    }

    const countryConfig = supportedCustomerCountries.find(
      (c) => c.value === merchant.country
    );

    return countryConfig?.taxLabel || "Tax ID";
  };

  if (!data.customer) {
    return (
      <div className="text-center py-8 text-gray-500">No customer selected</div>
    );
  }

  const customer = data.customer;

  return (
    <div className="w-full h-full bg-white p-8 rounded-lg overflow-auto text-sm flex flex-col">
      {/* Header: Invoice left, company name right */}
      <div className="flex justify-between items-start mb-3">
        <h1 className="text-3xl font-bold text-black">Invoice</h1>
        <h2 className="text-2xl font-bold text-gray-500">
          {data.merchant.displayName || data.merchant.legalName}
        </h2>
      </div>

      {/* Invoice details block */}
      <div className="mb-3">
        <div className="text-sm">
          <div className="mb-1">
            <span className="font-bold">Invoice number </span>
            <span>{data.invoiceNumber}</span>
          </div>
          <div className="mb-1">
            <span className="font-bold">Date of issue </span>
            <span>{data.issueDate}</span>
          </div>
          <div className="mb-1">
            <span className="font-bold">Date due </span>
            <span>{data.dueDate}</span>
          </div>
        </div>
      </div>

      {/* Two-column: Company (left), Bill to (right) */}
      <div className="grid grid-cols-2 gap-8 mb-4">
        <div>
          <h3 className="font-bold text-sm mb-2">
            {data.merchant.displayName || data.merchant.legalName}
          </h3>
          <div className="text-sm space-y-1">
            {data.merchant.supportEmail && (
              <div>{data.merchant.supportEmail}</div>
            )}
            {getAddressMerchant(data.merchant as MerchantWithAddress)
              .split("\n")
              .map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            {data.merchant.taxId && (
              <div>
                {getMerchantTaxIdLabel(data.merchant)}: {data.merchant.taxId}
              </div>
            )}
          </div>
        </div>
        <div>
          <h3 className="font-bold text-sm mb-2">Bill to</h3>
          <div className="text-sm space-y-1">
            <div>{customer.name}</div>
            {customer.businessName && <div>{customer.businessName}</div>}
            {getAddress(customer as CustomerWithBillingAddress)
              .split("\n")
              .map((line: string, i: number) => (
                <div key={i}>{line}</div>
              ))}
            <div>{customer.email}</div>
            {customer.taxId && (
              <div>
                {getTaxIdLabel(customer)}: {customer.taxId}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Amount due and due date */}
      <div className="mb-4">
        <h2 className="text-lg font-bold">
          {formatAmount(total)} due {data.dueDate}
        </h2>
      </div>

      {/* Table */}
      <div className="mb-2">
        <div className="border-b border-gray-200 pb-2 mb-2">
          <div className="grid grid-cols-12 gap-4 font-bold">
            <div className="col-span-6">Description</div>
            <div className="col-span-2">Qty</div>
            <div className="col-span-2">Unit price</div>
            <div className="col-span-2 text-right">Amount</div>
          </div>
        </div>
        {data.items.map((item, idx) => (
          <div
            key={idx}
            className="grid grid-cols-12 gap-4 py-2 border-b border-gray-100"
          >
            <div className="col-span-6">{item.description}</div>
            <div className="col-span-2">{item.quantity}</div>
            <div className="col-span-2">
              {formatAmount(item.unitAmountCents)}
            </div>
            <div className="col-span-2 text-right">
              {formatAmount(item.quantity * item.unitAmountCents)}
            </div>
          </div>
        ))}
      </div>

      {/* Subtotal, Tax, Total, Amount due summary */}
      <div className="flex justify-end mb-6">
        <div className="w-80 space-y-2">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatAmount(subtotal)}</span>
          </div>

          {/* Tax Line */}
          {data.taxLineItemDescriptions &&
          data.taxLineItemDescriptions.length > 0 ? (
            <div className="flex justify-between">
              <span className={taxAmount > 0 ? "text-black" : "text-gray-500"}>
                Tax: {data.taxLineItemDescriptions[0]}
                {derivedTaxReferences.length > 0 && (
                  <span className="text-xs text-gray-500">
                    {" "}
                    [{derivedTaxReferences[0].referenceNumber}]
                  </span>
                )}
              </span>
              <span className={taxAmount > 0 ? "text-black" : "text-gray-500"}>
                {formatAmount(taxAmount)}
              </span>
            </div>
          ) : taxAmount === 0 && data.exemptionReason ? (
            <>
              <div className="flex justify-between">
                <span className="text-gray-500">
                  Tax (0%)
                  {derivedTaxReferences.length > 0 && (
                    <span className="text-xs text-gray-500">
                      {" "}
                      [{derivedTaxReferences[0].referenceNumber}]
                    </span>
                  )}
                </span>
                <span className="text-gray-500">{formatAmount(0)}</span>
              </div>
              <div className="text-right">
                <div className="text-xs text-gray-600">
                  {data.exemptionReason}
                </div>
              </div>
            </>
          ) : (
            <div className="flex justify-between">
              <span className={taxAmount > 0 ? "text-black" : "text-gray-500"}>
                {data.taxDescription && data.taxCalculationMethod === "manual"
                  ? `Tax: ${data.taxDescription}`
                  : "Tax"}
                {!data.taxDescription && data.effectiveTaxRate && (
                  <span className="text-gray-500">
                    {" "}
                    ({(parseFloat(data.effectiveTaxRate) * 100).toFixed(2)}%
                    {data.taxJurisdiction && ` - ${data.taxJurisdiction}`})
                  </span>
                )}
                {derivedTaxReferences.length > 0 && (
                  <span className="text-xs text-gray-500">
                    {" "}
                    [{derivedTaxReferences[0].referenceNumber}]
                  </span>
                )}
              </span>
              <span className={taxAmount > 0 ? "text-black" : "text-gray-500"}>
                {formatAmount(taxAmount)}
              </span>
            </div>
          )}

          <div className="flex justify-between">
            <span>Total</span>
            <span>{formatAmount(total)}</span>
          </div>
          <div className="flex justify-between font-bold">
            <span>Amount due</span>
            <span>{formatAmount(total)}</span>
          </div>
        </div>
      </div>

      {/* Notes section, if present */}
      {data.notes && (
        <div className="mb-6">
          <h3 className="font-bold mb-2">Notes</h3>
          <div>{data.notes}</div>
        </div>
      )}

      {/* Tax Reference Explanations */}
      {derivedTaxReferences.length > 0 && (
        <div className="mb-6">
          <h3 className="font-bold mb-2">Tax Information</h3>
          {derivedTaxReferences.map((ref, index) => (
            <div key={index} className="text-xs mb-1 leading-relaxed">
              [{ref.referenceNumber}] {ref.fullDescription}
            </div>
          ))}
        </div>
      )}

      {/* Footer: invoice number, amount, due date left; page number right */}
      <div className="flex justify-between text-xs text-gray-500 mt-auto pt-4 border-t">
        <div>
          {data.invoiceNumber} · {formatAmount(total)} due {data.dueDate}
        </div>
        <div>Page 1 of 1</div>
      </div>
    </div>
  );
};
