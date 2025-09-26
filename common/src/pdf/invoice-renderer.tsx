import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Link,
} from "@react-pdf/renderer";
import { type CustomerFromApi } from "@lumen/common/schema";
import {
  getAddress,
  type CustomerWithBillingAddress,
  getAddressMerchant,
  type MerchantWithAddress,
  supportedCustomerCountries,
} from "@lumen/common/utils";
import { type MerchantFromApi } from "@lumen/common/schema";
export interface InvoiceItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
}

export interface InvoiceData {
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
  taxNote?: string; // Legacy fallback for custom tax notes
  // Tax fields for enhanced display
  subtotalCents?: number | null;
  taxAmountCents?: number | null;
  totalAmountCents?: number;
  effectiveTaxRate?: string | null;
  taxJurisdiction?: string | null;
  taxCalculationMethod?: string | null;
  exemptionReason?: string | null; // Legacy fallback for exemption cases
  // Tax line item descriptions (from database/API) - PRIMARY TAX DISPLAY
  taxLineItemDescriptions?: string[];
  // Enhanced tax reference system
  taxReferences?: Array<{
    referenceNumber: number;
    shortDescription: string;
    fullDescription: string;
  }>;
  // Raw tax line items (optional) to derive references when not provided
  taxLineItems?: Array<{
    type: "tax";
    description: string;
    subtotalCents: number;
    taxMetadata?: {
      fullDescription?: string;
    } | null;
  }>;
  // Reverse charge fields
  isReverseCharge?: boolean;
  reverseChargeMessage?: string;
  // Refund/correction document support
  documentType?: "standard" | "cancellation" | "credit_note";
  originalInvoiceNumber?: string;
  originalIssueDate?: string;
  adjustmentReason?: string;
}

// Define styles for the PDF document
const styles = StyleSheet.create({
  page: {
    flexDirection: "column",
    backgroundColor: "#FFFFFF",
    padding: 40,
    fontFamily: "Geist",
    fontSize: 10,
    color: "#333333",
  },
  headerSection: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 40,
  },
  headerText: {
    fontSize: 36,
    letterSpacing: -0.5,
    color: "#000000",
  },
  companyHeader: {
    fontSize: 14,
    color: "#666666",
    marginTop: 12,
  },
  threeColumnSection: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 40,
    borderBottomWidth: 1,
    borderBottomColor: "#EEEEEE",
    paddingBottom: 20,
  },
  column: {
    width: "30%",
  },
  columnHeader: {
    fontSize: 11,
    color: "#666666",
    marginBottom: 12,
    letterSpacing: 0.2,
    fontWeight: "bold",
  },
  columnText: {
    fontSize: 10,
    marginBottom: 4,
    lineHeight: 1.4,
  },
  table: {
    width: "100%",
    marginBottom: 30,
  },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#EEEEEE",
    paddingBottom: 8,
    marginBottom: 8,
  },
  tableHeaderText: {
    fontSize: 11,
    color: "#666666",
    letterSpacing: 0.2,
    fontWeight: "bold",
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#F6F6F6",
  },
  descriptionCol: {
    width: "60%",
  },
  quantityCol: {
    width: "20%",
    paddingRight: 8,
  },
  amountCol: {
    width: "20%",
    textAlign: "right",
  },
  totalSection: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#EEEEEE",
  },
  totalLabel: {
    fontSize: 12,
    fontWeight: "bold",
    marginRight: 60,
  },
  totalAmount: {
    fontSize: 12,
    fontWeight: "bold",
    textAlign: "right",
    width: "20%",
  },
  footer: {
    position: "absolute",
    bottom: 40,
    left: 40,
    right: 40,
    flexDirection: "column",
    borderTopWidth: 1,
    borderTopColor: "#EEEEEE",
    paddingTop: 20,
  },
  footerSection: {
    marginBottom: 16,
  },
  footerHeader: {
    fontSize: 11,
    color: "#666666",
    marginBottom: 6,
    letterSpacing: 0.2,
    fontWeight: "bold",
  },
  footerText: {
    fontSize: 10,
    lineHeight: 1.4,
    color: "#333333",
  },
});

// Component to handle notes with special formatting for checkout links
const NotesSection: React.FC<{ notes: string }> = ({ notes }) => {
  // Check if notes contain a checkout link
  const checkoutLinkMatch = notes.match(
    /https:\/\/checkout\.stripe\.com\/[^\s]+/
  );

  if (checkoutLinkMatch) {
    const checkoutLink = checkoutLinkMatch[0];
    const beforeLink = notes.substring(0, checkoutLinkMatch.index);
    const afterLink = notes.substring(
      checkoutLinkMatch.index! + checkoutLink.length
    );

    // Check if this is a payment completion note vs payment required note
    const isPaid = notes.includes("Paid online via checkout session");
    const isPaymentRequired = notes.includes("Payment required:");

    if (isPaid) {
      // For paid invoices, show a simple completion message
      return (
        <View style={{ marginBottom: 24 }}>
          <Text style={{ fontWeight: "bold", fontSize: 10, marginBottom: 4 }}>
            Notes
          </Text>
          <View
            style={{
              backgroundColor: "#f0f9f0",
              padding: 8,
              borderRadius: 4,
              borderLeft: "3px solid #22c55e",
            }}
          >
            <Text
              style={{ fontSize: 10, color: "#16a34a", fontWeight: "bold" }}
            >
              ✓ Payment Completed
            </Text>
            <Text style={{ fontSize: 9, color: "#15803d", marginTop: 2 }}>
              This invoice was paid online via Stripe checkout.
            </Text>
          </View>
        </View>
      );
    } else if (isPaymentRequired) {
      // For payment required notes, show formatted payment info
      return (
        <View style={{ marginBottom: 24 }}>
          <Text style={{ fontWeight: "bold", fontSize: 10, marginBottom: 4 }}>
            Payment Information
          </Text>
          <View
            style={{
              backgroundColor: "#fef3c7",
              padding: 8,
              borderRadius: 4,
              borderLeft: "3px solid #f59e0b",
            }}
          >
            <Text
              style={{
                fontSize: 10,
                color: "#92400e",
                fontWeight: "bold",
                marginBottom: 4,
              }}
            >
              Online Payment Required
            </Text>
            <Text style={{ fontSize: 9, color: "#78716c", marginBottom: 8 }}>
              Click the link below to pay this invoice securely online:
            </Text>
            <Link
              src={checkoutLink}
              style={{
                backgroundColor: "#ffffff",
                padding: 10,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: "#2563eb",
                textDecoration: "none",
              }}
            >
              <Text
                style={{
                  fontSize: 10,
                  color: "#2563eb",
                  fontWeight: "bold",
                  textAlign: "center",
                }}
              >
                → Pay Invoice Online ←
              </Text>
              <Text
                style={{
                  fontSize: 8,
                  color: "#4b5563",
                  textAlign: "center",
                  marginTop: 2,
                }}
              >
                Secure Stripe checkout
              </Text>
            </Link>
            <Text style={{ fontSize: 8, color: "#6b7280", marginTop: 6 }}>
              This secure link will take you to Stripe's checkout page where you
              can pay with a credit or debit card.
            </Text>
          </View>
        </View>
      );
    } else {
      // Generic case: format the link nicely
      return (
        <View style={{ marginBottom: 24 }}>
          <Text style={{ fontWeight: "bold", fontSize: 10, marginBottom: 2 }}>
            Notes
          </Text>
          <Text style={{ fontSize: 10 }}>{beforeLink}</Text>
          <Text style={{ fontSize: 9, color: "#1d4ed8", marginTop: 2 }}>
            Payment link: {checkoutLink}
          </Text>
          {afterLink && (
            <Text style={{ fontSize: 10, marginTop: 2 }}>{afterLink}</Text>
          )}
        </View>
      );
    }
  }

  // For notes without checkout links, render as plain text
  return (
    <View style={{ marginBottom: 24 }}>
      <Text style={{ fontWeight: "bold", fontSize: 10, marginBottom: 2 }}>
        Notes
      </Text>
      <Text style={{ fontSize: 10 }}>{notes}</Text>
    </View>
  );
};

// Define the Invoice Document Component
export const InvoiceDocument: React.FC<{ data: InvoiceData }> = ({ data }) => {
  // Build tax reference entries (use provided or derive from taxLineItems)
  const derivedTaxReferences: Array<{
    referenceNumber: number;
    shortDescription: string;
    fullDescription: string;
  }> =
    data.taxReferences && data.taxReferences.length > 0
      ? data.taxReferences
      : ((data.taxLineItems || [])
          .map((item, idx) => {
            const full = item.taxMetadata?.fullDescription;
            return full
              ? {
                  referenceNumber: idx + 1,
                  shortDescription: "", // optional
                  fullDescription: full,
                }
              : null;
          })
          .filter(Boolean) as Array<{
          referenceNumber: number;
          shortDescription: string;
          fullDescription: string;
        }>);

  console.log("[InvoiceDocument] Rendering invoice:", {
    invoiceNumber: data.invoiceNumber,
    taxReferencesCount: derivedTaxReferences.length,
    taxLineItemDescriptions: data.taxLineItemDescriptions,
  });

  const currencySymbol = data.currency === "USD" ? "$" : "€";

  const subtotal = data.subtotalCents || 0;
  const taxAmount = data.taxAmountCents || 0;
  const total = data.totalAmountCents || subtotal + taxAmount;
  const isExempt = data.taxCalculationMethod === "exempt";

  // Helper function to format currency amounts
  const formatAmount = (amount: number) => {
    return `${currencySymbol}${(amount / 100).toFixed(2)}`;
  };

  // Helper function to get the appropriate tax ID label based on customer's country
  const getTaxIdLabel = (customer: CustomerFromApi) => {
    if (!customer.billingCountry) {
      return "Tax ID"; // Default fallback
    }

    const countryConfig = supportedCustomerCountries.find(
      (c) => c.value === customer.billingCountry
    );

    return countryConfig?.taxLabel || "Tax ID";
  };

  // Helper function to get the appropriate tax ID label based on merchant's country
  const getMerchantTaxIdLabel = (merchant: MerchantFromApi) => {
    if (!merchant.country) {
      return "Tax ID"; // Default fallback
    }

    const countryConfig = supportedCustomerCountries.find(
      (c) => c.value === merchant.country
    );

    return countryConfig?.taxLabel || "Tax ID";
  };

  if (!data.customer) {
    return <Text>No customer selected</Text>;
  }

  const isCancellation = data.documentType === "cancellation";
  const isCreditNote = data.documentType === "credit_note";
  const headingText = isCancellation
    ? "Invoice Cancellation"
    : isCreditNote
      ? "Credit Note"
      : "Invoice";

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header: Invoice left, company name right */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 8,
          }}
        >
          <Text style={{ fontSize: 24, fontWeight: "bold", color: "#000" }}>
            {headingText}
          </Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#999" }}>
            {data.merchant.displayName || data.merchant.legalName}
          </Text>
        </View>

        {/* Invoice details block */}
        <View style={{ flexDirection: "row", marginBottom: 12 }}>
          <View style={{ flexDirection: "column" }}>
            <Text style={{ fontSize: 10, fontWeight: "bold" }}>
              Invoice number{" "}
              <Text style={{ fontWeight: "normal" }}>{data.invoiceNumber}</Text>
            </Text>
            <Text style={{ fontSize: 10 }}>
              Date of issue{" "}
              <Text style={{ fontWeight: "normal" }}>{data.issueDate}</Text>
            </Text>
            {!isCancellation && !isCreditNote && (
              <Text style={{ fontSize: 10 }}>
                Date due{" "}
                <Text style={{ fontWeight: "normal" }}>{data.dueDate}</Text>
              </Text>
            )}
          </View>
        </View>

        {(isCancellation || isCreditNote) && data.originalInvoiceNumber && (
          <View style={{ marginBottom: 8 }}>
            <Text style={{ fontSize: 10 }}>
              References invoice {data.originalInvoiceNumber}
              {data.originalIssueDate
                ? `, issued ${data.originalIssueDate}`
                : ""}
            </Text>
            {data.adjustmentReason && (
              <Text style={{ fontSize: 9, color: "#666" }}>
                Reason: {data.adjustmentReason}
              </Text>
            )}
          </View>
        )}

        {/* Reverse Charge Notice - Small note */}
        {/* Note: This is now handled by standardized tax descriptions like "0.00%: Reverse Charge [1]" */}
        {/* {data.isReverseCharge && (
          <View style={{ marginBottom: 8 }}>
            <Text
              style={{ fontSize: 9, color: "#666666", fontStyle: "italic" }}
            >
              Tax to be paid on a reverse charge basis
            </Text>
          </View>
        )} */}

        {/* Two-column: Company (left), Bill to (right) */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <View style={{ flexDirection: "column", width: "45%" }}>
            <Text style={{ fontWeight: "bold", fontSize: 11 }}>
              {data.merchant.displayName || data.merchant.legalName}
            </Text>
            <Text style={{ fontSize: 10 }}>
              {data.merchant.supportEmail || ""}
            </Text>
            {getAddressMerchant(data.merchant as MerchantWithAddress)
              .split("\n")
              .map((line, i) => (
                <Text key={i} style={{ fontSize: 10 }}>
                  {line}
                </Text>
              ))}
            {data.merchant.taxId && (
              <Text style={{ fontSize: 10 }}>
                {getMerchantTaxIdLabel(data.merchant)}: {data.merchant.taxId}
              </Text>
            )}
          </View>
          <View style={{ flexDirection: "column", width: "45%" }}>
            <Text style={{ fontWeight: "bold", fontSize: 11 }}>Bill to</Text>
            <Text style={{ fontSize: 10 }}>{data.customer.name}</Text>
            {data.customer.businessName && (
              <Text style={{ fontSize: 10 }}>{data.customer.businessName}</Text>
            )}
            {getAddress(data.customer as CustomerWithBillingAddress)
              .split("\n")
              .map((line: string, i: number) => (
                <Text key={i} style={{ fontSize: 10 }}>
                  {line}
                </Text>
              ))}
            <Text style={{ fontSize: 10 }}>{data.customer.email}</Text>
            {data.customer.taxId && (
              <Text style={{ fontSize: 10 }}>
                {getTaxIdLabel(data.customer)}: {data.customer.taxId}
              </Text>
            )}
          </View>
        </View>

        {/* Amount summary */}
        {isCancellation || isCreditNote ? (
          <Text style={{ fontSize: 18, fontWeight: "bold", marginBottom: 2 }}>
            {headingText === "Credit Note" ? "Total credit" : "Total refund"}:{" "}
            {formatAmount(total)}
          </Text>
        ) : (
          <Text style={{ fontSize: 18, fontWeight: "bold", marginBottom: 2 }}>
            {formatAmount(total)} due {data.dueDate}
          </Text>
        )}

        {/* Pay online link */}
        {/* <Text
          style={{
            color: "#2a5bd7",
            textDecoration: "underline",
            marginBottom: 16,
          }}
        >
          Pay online
        </Text> */}

        {/* Table */}
        <View style={{ width: "100%", marginBottom: 8 }}>
          <View
            style={{
              flexDirection: "row",
              borderBottomWidth: 1,
              borderBottomColor: "#EEE",
              paddingBottom: 4,
            }}
          >
            <Text style={{ width: "50%", fontWeight: "bold", fontSize: 10 }}>
              Description
            </Text>
            <Text style={{ width: "15%", fontWeight: "bold", fontSize: 10 }}>
              Qty
            </Text>
            <Text style={{ width: "15%", fontWeight: "bold", fontSize: 10 }}>
              Unit price
            </Text>
            <Text
              style={{
                width: "20%",
                fontWeight: "bold",
                fontSize: 10,
                textAlign: "right",
              }}
            >
              Amount
            </Text>
          </View>
          {data.items.map((item, idx) => (
            <View
              key={idx}
              style={{
                flexDirection: "row",
                borderBottomWidth: 1,
                borderBottomColor: "#F6F6F6",
                paddingVertical: 4,
              }}
            >
              <Text style={{ width: "50%", fontSize: 10 }}>
                {item.description}
              </Text>
              <Text style={{ width: "15%", fontSize: 10 }}>
                {item.quantity}
              </Text>
              <Text style={{ width: "15%", fontSize: 10 }}>
                {formatAmount(item.unitAmountCents)}
              </Text>
              <Text style={{ width: "20%", fontSize: 10, textAlign: "right" }}>
                {formatAmount(item.quantity * item.unitAmountCents)}
              </Text>
            </View>
          ))}
        </View>

        {/* Subtotal, Tax, Total, Amount summary */}
        <View
          style={{
            flexDirection: "column",
            alignItems: "flex-end",
            marginBottom: 24,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              width: "60%",
              justifyContent: "space-between",
            }}
          >
            <Text style={{ fontSize: 10 }}>Subtotal</Text>
            <Text style={{ fontSize: 10 }}>{formatAmount(subtotal)}</Text>
          </View>

          {/* Tax Line */}
          {data.taxLineItemDescriptions &&
          data.taxLineItemDescriptions.length > 0 ? (
            // Primary path: Use standardized tax descriptions
            <View
              style={{
                flexDirection: "row",
                width: "60%",
                justifyContent: "space-between",
              }}
            >
              <Text
                style={{
                  fontSize: 10,
                  color: taxAmount > 0 ? "#000" : "#666666",
                }}
              >
                {data.taxLineItemDescriptions[0]}
                {derivedTaxReferences.length > 0 && (
                  <Text style={{ fontSize: 8, color: "#666666" }}>
                    {" "}
                    [{derivedTaxReferences[0].referenceNumber}]
                  </Text>
                )}
              </Text>
              <Text
                style={{
                  fontSize: 10,
                  color: taxAmount > 0 ? "#000" : "#666666",
                }}
              >
                {formatAmount(taxAmount)}
              </Text>
            </View>
          ) : taxAmount === 0 && data.exemptionReason ? (
            // Zero tax with exemption reason
            <>
              <View
                style={{
                  flexDirection: "row",
                  width: "60%",
                  justifyContent: "space-between",
                }}
              >
                <Text style={{ fontSize: 10, color: "#666666" }}>
                  Tax (0%)
                  {derivedTaxReferences.length > 0 && (
                    <Text style={{ fontSize: 8, color: "#666666" }}>
                      {" "}
                      [{derivedTaxReferences[0].referenceNumber}]
                    </Text>
                  )}
                </Text>
                <Text style={{ fontSize: 10, color: "#666666" }}>
                  {formatAmount(0)}
                </Text>
              </View>
              <View style={{ flexDirection: "row", width: "60%" }}>
                <Text style={{ fontSize: 8, color: "#666666" }}>
                  {data.exemptionReason}
                </Text>
              </View>
            </>
          ) : (
            // Final fallback: Generic tax display
            <View
              style={{
                flexDirection: "row",
                width: "60%",
                justifyContent: "space-between",
              }}
            >
              <Text
                style={{
                  fontSize: 10,
                  color: taxAmount > 0 ? "#000" : "#666666",
                }}
              >
                Tax
                {data.effectiveTaxRate && (
                  <Text style={{ color: "#666666" }}>
                    {" "}
                    ({(parseFloat(data.effectiveTaxRate) * 100).toFixed(2)}%
                    {data.taxJurisdiction && ` - ${data.taxJurisdiction}`})
                  </Text>
                )}
                {derivedTaxReferences.length > 0 && (
                  <Text style={{ fontSize: 8, color: "#666666" }}>
                    {" "}
                    [{derivedTaxReferences[0].referenceNumber}]
                  </Text>
                )}
              </Text>
              <Text
                style={{
                  fontSize: 10,
                  color: taxAmount > 0 ? "#000" : "#666666",
                }}
              >
                {formatAmount(taxAmount)}
              </Text>
            </View>
          )}

          <View
            style={{
              flexDirection: "row",
              width: "60%",
              justifyContent: "space-between",
            }}
          >
            <Text style={{ fontSize: 10 }}>Total</Text>
            <Text style={{ fontSize: 10 }}>{formatAmount(total)}</Text>
          </View>
          {!isCancellation && !isCreditNote && (
            <View
              style={{
                flexDirection: "row",
                width: "60%",
                justifyContent: "space-between",
              }}
            >
              <Text style={{ fontWeight: "bold", fontSize: 11 }}>
                Amount due
              </Text>
              <Text style={{ fontWeight: "bold", fontSize: 11 }}>
                {formatAmount(total)}
              </Text>
            </View>
          )}
        </View>

        {/* Notes section, if present */}
        {data.notes && <NotesSection notes={data.notes} />}

        {/* Tax Reference Explanations */}
        {derivedTaxReferences.length > 0 && (
          <View style={styles.footerSection}>
            <Text style={styles.footerHeader}>Tax Information</Text>
            {derivedTaxReferences.map((ref, index) => (
              <Text key={index} style={styles.footerText}>
                [{ref.referenceNumber}] {ref.fullDescription}
              </Text>
            ))}
          </View>
        )}

        {/* Footer: invoice number, amount, due date left; page number right */}
        <View
          style={{
            position: "absolute",
            bottom: 24,
            left: 40,
            right: 40,
            flexDirection: "row",
            justifyContent: "space-between",
            fontSize: 9,
            color: "#888",
          }}
        >
          <Text>
            {data.invoiceNumber} ·{" "}
            {isCancellation || isCreditNote
              ? headingText === "Credit Note"
                ? "credit"
                : "refund"
              : "due"}{" "}
            {formatAmount(total)}
          </Text>
          <Text>Page 1 of 1</Text>
        </View>
      </Page>
    </Document>
  );
};
