"use client";
import { useAppForm } from "@/hooks/form";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { pdf, Font } from "@react-pdf/renderer";
import { apiClient } from "@/lib/hono-client";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import React from "react";
import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { InvoiceDocument } from "@lumen/common/pdf";
import { InvoicePreview } from "@/components/invoice/InvoicePreview";
import {
  parseStringToCents,
  formatCentsToString,
} from "@/components/form/Number2DecimalsField";
import { hasBillingAddress, getInvoicePrefix } from "@lumen/common/utils";
import { useRouter } from "next/navigation";

// Register Geist font for PDF generation
Font.register({
  family: "Geist",
  fonts: [
    {
      src: "/fonts/Geist/Geist-Regular.ttf",
      fontWeight: "normal",
      fontStyle: "normal",
    },
    {
      src: "/fonts/Geist/Geist-Bold.ttf",
      fontWeight: "bold",
      fontStyle: "normal",
    },
    {
      src: "/fonts/Geist/Geist-Light.ttf",
      fontWeight: "normal",
      fontStyle: "italic",
    },
    {
      src: "/fonts/Geist/Geist-SemiBold.ttf",
      fontWeight: "bold",
      fontStyle: "italic",
    },
  ],
});

const invoiceFormSchema = z.object({
  customerName: z.string().min(1, "Customer name is required"),
  customerEmail: z.string().email("Invalid email address"),
  customerAddress: z.string().min(1, "Customer address is required"),
  invoiceNumber: z.string().min(1, "Invoice number is required"),
  issueDate: z.string().min(1, "Issue date is required"),
  dueDate: z.string().min(1, "Due date is required"),
  items: z
    .array(
      z.object({
        description: z.string().min(1, "Description is required"),
        quantity: z.number().min(1, "Quantity must be at least 1"),
        unitAmountCents: z.number().min(0, "Unit price must be positive"),
      })
    )
    .min(1, "At least one item is required"),
  notes: z.string().optional(),
  taxCalculationMethod: z.enum(["auto", "manual", "exempt"]),
  manualTaxRate: z.number().min(0).max(1).optional(),
  manualTaxAmountCents: z.number().min(0).optional(),
  manualTaxDescription: z.string().optional(),
});

type InvoiceItem = {
  description: string;
  quantity: number;
  unitAmountCents: number;
};

interface TaxCalculationResult {
  taxableAmount: number;
  totalTaxCents: number;
  effectiveTaxRate: number;
  jurisdiction: string;
  calculationMethod: "auto" | "manual" | "exempt";
  exemptionReason?: string;
  taxDescription?: string;
  taxLineItems?: Array<{
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
  taxLineItemDescriptions?: string[];
}

function UnitPriceInput({
  initialValue,
  onChange,
}: {
  initialValue: number;
  onChange: (val: number) => void;
}) {
  const [displayValue, setDisplayValue] = useState(
    formatCentsToString(initialValue)
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // Allow only numbers, a single decimal point, and up to 2 decimal places
    if (value === "" || /^\d*\.?\d{0,2}$/.test(value)) {
      setDisplayValue(value);
      if (value === "") {
        onChange(0);
      } else {
        const cents = parseStringToCents(value);
        onChange(cents);
      }
    }
  };

  return (
    <div className="mb-4">
      <Input
        type="text"
        inputMode="decimal"
        pattern="\d*\.?\d{0,2}"
        placeholder="0.00"
        value={displayValue}
        onChange={handleChange}
      />
    </div>
  );
}

export default function InvoicesPage() {
  const searchParams = useSearchParams();
  const urlCustomerId = searchParams.get("customerId");
  const router = useRouter();
  const { data: customers } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const response = await apiClient.customers.$get();
      const data = await response.json();
      return data.customers.filter((c) => hasBillingAddress(c));
    },
  });

  const { data: merchant } = useQuery({
    queryKey: ["current-merchant"],
    queryFn: async () => {
      const response = await apiClient.merchants.current.$get();
      if (!response.ok) {
        throw new Error("Failed to fetch current merchant");
      }
      const data = await response.json();
      return data;
    },
  });

  const [items, setItems] = React.useState<InvoiceItem[]>([
    { description: "", quantity: 1, unitAmountCents: 0 },
  ]);

  const [taxCalculation, setTaxCalculation] = useState<TaxCalculationResult>({
    taxableAmount: 0,
    totalTaxCents: 0,
    effectiveTaxRate: 0,
    jurisdiction: "manual",
    calculationMethod: "manual",
  });

  const form = useAppForm({
    defaultValues: {
      customerId: "",
      issueDate: new Date().toISOString().split("T")[0],
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0],
      notes: "",
      taxCalculationMethod: "auto" as const,
      manualTaxRate: 0,
      manualTaxAmountCents: 0,
      manualTaxDescription: "",
    },
    onSubmit: async ({ value }) => {
      try {
        const subtotalCents = calculateSubtotal();
        const totalAmountCents = subtotalCents + taxCalculation.totalTaxCents;

        // Prepare charge line items
        const chargeLineItems = items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitAmountCents: item.unitAmountCents,
          type: "charge",
        }));

        // Append tax line items (if any)
        const allLineItems = [
          ...chargeLineItems,
          ...(taxCalculation.taxLineItems || []).map((taxItem) => ({
            description: taxItem.description,
            quantity: 1,
            unitAmountCents: taxItem.subtotalCents,
            type: "tax",
            taxMetadata: taxItem.taxMetadata,
          })),
        ];

        // First create the invoice in the database
        const response = await apiClient.invoices.$post({
          json: {
            ...value,
            status: "issued",
            currency: "EUR",
            customerId: value.customerId,
            issueDate: new Date(value.issueDate).toISOString(),
            dueDate: new Date(value.dueDate).toISOString(),
            subtotalCents,
            taxAmountCents: taxCalculation.totalTaxCents,
            totalAmountCents,
            effectiveTaxRate: taxCalculation.effectiveTaxRate.toString(),
            taxJurisdiction: taxCalculation.jurisdiction,
            taxCalculationMethod: taxCalculation.calculationMethod,
            manualTaxDescription: value.manualTaxDescription || undefined,
            lineItems: allLineItems,
          },
        });

        if (!response.ok) {
          throw new Error("Failed to create invoice");
        }

        // Poll until PDF url is available and download
        try {
          const invoiceId = (await response.json()).id;

          const fetchPdfUrl = async (): Promise<string | null> => {
            const resp = await apiClient.invoices[":id"].pdf.$get({
              param: { id: invoiceId },
            });
            if (!resp.ok) return null;
            const pdfData = (await resp.json()) as { pdfUrl?: string };
            return pdfData.pdfUrl || null;
          };

          let pdfUrl: string | null = null;
          for (let i = 0; i < 15; i++) {
            pdfUrl = await fetchPdfUrl();
            if (pdfUrl) break;
            await new Promise((r) => setTimeout(r, 2000));
          }

          if (pdfUrl) {
            const fileName = pdfUrl.split("/").pop() || "invoice.pdf";
            const link = document.createElement("a");
            link.href = pdfUrl;
            link.download = fileName;
            link.target = "_blank";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          }
        } catch (downloadErr) {
          console.error("Failed to download generated PDF", downloadErr);
        }

        toast.success("Invoice created successfully");
        router.push(`/invoices`);
      } catch (error) {
        console.error("Error creating invoice:", error);
        toast.error("Failed to create invoice");
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = invoiceFormSchema.safeParse({ ...value, items });
        if (!result.success) {
          const errors = result.error.issues.reduce(
            (acc, issue) => ({ ...acc, [issue.path[0]]: issue.message }),
            {}
          );
          return { fields: errors };
        }
        return undefined;
      },
    },
  });

  // Set customerId from URL when customers are loaded
  useEffect(() => {
    if (
      urlCustomerId &&
      customers &&
      customers.some((c) => c.id === urlCustomerId)
    ) {
      form.setFieldValue("customerId", urlCustomerId);
    }
  }, [urlCustomerId, customers, form]);

  const customer = useStore(form.store, (state) =>
    customers?.find((c) => c.id === state.values.customerId)
  );

  const taxCalculationMethod = useStore(
    form.store,
    (state) => state.values.taxCalculationMethod
  ) as "auto" | "manual" | "exempt";

  const manualTaxRate = useStore(
    form.store,
    (state) => state.values.manualTaxRate
  );

  const manualTaxAmountCents = useStore(
    form.store,
    (state) => state.values.manualTaxAmountCents
  );

  const manualTaxDescription = useStore(
    form.store,
    (state) => state.values.manualTaxDescription
  );

  // Access core values for preview/PDF generation
  const issueDateValue = useStore(
    form.store,
    (state) => state.values.issueDate
  );
  const dueDateValue = useStore(form.store, (state) => state.values.dueDate);
  const notesValue = useStore(form.store, (state) => state.values.notes);

  const addItem = () => {
    setItems([...items, { description: "", quantity: 1, unitAmountCents: 0 }]);
  };

  const calculateSubtotal = useCallback(() => {
    return items.reduce((total, item) => {
      return total + item.quantity * item.unitAmountCents;
    }, 0);
  }, [items]);

  // Download the current preview as PDF without saving invoice
  const handleDownloadPreviewPdf = async () => {
    if (!customer || !merchant) return;

    try {
      const subtotalCents = calculateSubtotal();
      const blob = await pdf(
        <InvoiceDocument
          data={{
            customer,
            invoiceNumber: getInvoicePrefix(customer) + "-DRAFT",
            items,
            merchant,
            dueDate: new Date(dueDateValue).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            }),
            issueDate: new Date(issueDateValue).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            }),
            notes: notesValue,
            currency: "EUR",
            subtotalCents,
            taxAmountCents: taxCalculation.totalTaxCents,
            totalAmountCents: subtotalCents + taxCalculation.totalTaxCents,
            effectiveTaxRate: taxCalculation.effectiveTaxRate.toString(),
            taxJurisdiction: taxCalculation.jurisdiction,
            taxCalculationMethod: taxCalculation.calculationMethod,
            exemptionReason: taxCalculation.exemptionReason,
            taxLineItemDescriptions: taxCalculation.taxLineItemDescriptions,
            taxLineItems: taxCalculation.taxLineItems,
          }}
        />
      ).toBlob();

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `invoice-${getInvoicePrefix(customer)}-DRAFT.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to generate preview PDF", err);
    }
  };

  // Calculate tax based on the selected method
  useEffect(() => {
    const subtotal = calculateSubtotal();

    if (taxCalculationMethod === "exempt") {
      setTaxCalculation({
        taxableAmount: subtotal,
        totalTaxCents: 0,
        effectiveTaxRate: 0,
        jurisdiction: "exempt",
        calculationMethod: "exempt",
        exemptionReason: "other",
      });
    } else if (taxCalculationMethod === "manual") {
      const taxAmount = manualTaxAmountCents || subtotal * (manualTaxRate || 0);
      setTaxCalculation({
        taxableAmount: subtotal,
        totalTaxCents: Math.round(taxAmount),
        effectiveTaxRate: subtotal > 0 ? taxAmount / subtotal : 0,
        jurisdiction: "manual",
        calculationMethod: "manual",
        // Include custom description for manual tax
        taxDescription: manualTaxDescription || undefined,
      });
    } else if (taxCalculationMethod === "auto" && customer) {
      // Auto-calculate tax using the API
      const calculateAutoTax = async () => {
        try {
          const response = await apiClient.tax["calculate-preview"].$post({
            json: {
              customerId: customer.id,
              amount: subtotal,
              currency: "EUR",
              lineItems: items.map((item) => ({
                type: "charge",
                description: item.description,
                subtotalCents: item.quantity * item.unitAmountCents,
                billingPeriodStart: new Date(),
                billingPeriodEnd: new Date(),
              })),
            },
          });

          if (response.ok) {
            const result = await response.json();
            console.log("[calculateAutoTax] API response:", result);

            const taxLineItemDescriptions = result.taxLineItems
              ? result.taxLineItems.map(
                  (item: { description: string }) => item.description
                )
              : [];

            setTaxCalculation({
              taxableAmount: result.taxableAmount,
              totalTaxCents: result.totalTaxCents,
              effectiveTaxRate: result.effectiveTaxRate,
              jurisdiction: result.jurisdiction,
              calculationMethod: "auto",
              exemptionReason: result.exemptionReason,
              taxLineItems: result.taxLineItems,
              taxLineItemDescriptions,
            });
          }
        } catch (error) {
          console.error("Error calculating auto tax:", error);
          // Fallback to no tax
          setTaxCalculation({
            taxableAmount: subtotal,
            totalTaxCents: 0,
            effectiveTaxRate: 0,
            jurisdiction: "auto",
            calculationMethod: "auto",
          });
        }
      };

      calculateAutoTax();
    }
  }, [
    items,
    taxCalculationMethod,
    manualTaxRate,
    manualTaxAmountCents,
    manualTaxDescription,
    customer,
    calculateSubtotal,
  ]);

  return (
    <div className="container mx-auto py-10">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <Card>
            <CardHeader>
              <CardTitle>Create Invoice</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  form.handleSubmit();
                }}
              >
                <form.AppField
                  name="customerId"
                  children={(field) => (
                    <field.Dropdown
                      label="Customer (with Billing Address completed)"
                      options={
                        customers?.map((customer) => ({
                          label: customer.name || customer.email || customer.id,
                          value: customer.id,
                        })) || []
                      }
                    />
                  )}
                />
                <form.AppField
                  name="issueDate"
                  children={(field) => <field.DatePicker label="Issue Date" />}
                />

                <form.AppField
                  name="dueDate"
                  children={(field) => <field.DatePicker label="Due Date" />}
                />

                <div className="space-y-4">
                  <Label>Items</Label>
                  {items.map((item, index) => (
                    <div key={index} className="grid grid-cols-3 gap-4">
                      <Input
                        value={item.description}
                        onChange={(e) => {
                          const newItems = [...items];
                          newItems[index].description = e.target.value;
                          setItems(newItems);
                        }}
                        placeholder="Description"
                      />
                      <Input
                        type="number"
                        value={item.quantity}
                        min={1}
                        onChange={(e) => {
                          const newItems = [...items];
                          newItems[index].quantity = Number(e.target.value);
                          setItems(newItems);
                        }}
                        placeholder="Quantity"
                      />
                      <UnitPriceInput
                        initialValue={item.unitAmountCents}
                        onChange={(val) => {
                          const newItems = [...items];
                          newItems[index].unitAmountCents = val;
                          setItems(newItems);
                        }}
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={addItem}
                    className="w-full"
                  >
                    <Plus className="mr-2 h-4 w-4" /> Add Item
                  </Button>
                </div>

                {/* Tax Configuration */}
                <div className="space-y-4 mt-6">
                  <Label className="text-base font-semibold">
                    Tax Configuration
                  </Label>

                  <form.AppField
                    name="taxCalculationMethod"
                    children={(field) => (
                      <field.Dropdown
                        label="Tax Calculation Method"
                        options={[
                          {
                            label: "Auto-calculate based on customer location",
                            value: "auto",
                          },
                          { label: "Manual tax entry", value: "manual" },
                          { label: "Tax exempt", value: "exempt" },
                        ]}
                      />
                    )}
                  />

                  {taxCalculationMethod === "manual" && (
                    <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
                      <form.AppField
                        name="manualTaxRate"
                        children={(field) => (
                          <field.Number2DecimalsField label="Tax Rate (e.g., 0.19 for 19%)" />
                        )}
                      />
                      <div className="text-sm text-gray-600">
                        Or enter a fixed tax amount:
                      </div>
                      <form.AppField
                        name="manualTaxAmountCents"
                        children={(field) => (
                          <field.Number2DecimalsField label="Tax Amount (€)" />
                        )}
                      />
                      <form.AppField
                        name="manualTaxDescription"
                        children={(field) => (
                          <field.TextField label="Tax Description (e.g., 'VAT', 'Sales Tax')" />
                        )}
                      />
                    </div>
                  )}

                  {taxCalculationMethod === "exempt" && (
                    <div className="p-4 bg-blue-50 rounded-lg">
                      <div className="text-sm text-blue-700">
                        This invoice will be marked as tax exempt. No tax will
                        be calculated or charged.
                      </div>
                    </div>
                  )}

                  {taxCalculationMethod === "auto" && !customer && (
                    <div className="p-4 bg-yellow-50 rounded-lg">
                      <div className="text-sm text-yellow-700">
                        Please select a customer to enable automatic tax
                        calculation.
                      </div>
                    </div>
                  )}
                </div>

                <form.AppField
                  name="notes"
                  children={(field) => <field.TextField label="Notes" />}
                />

                <form.AppForm>
                  <div className="flex gap-2">
                    <form.SubmitButton label="Create Invoice & Generate PDF" />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleDownloadPreviewPdf}
                    >
                      Download PDF Preview
                    </Button>
                  </div>
                </form.AppForm>
              </form>
            </CardContent>
          </Card>
        </div>

        {customer && merchant && (
          <div className="flex flex-col items-center">
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <div className="w-[210mm] h-[297mm] bg-white shadow-lg border rounded-lg">
                  <InvoicePreview
                    data={{
                      customer,
                      invoiceNumber: getInvoicePrefix(customer) + "-DRAFT",
                      items,
                      merchant,
                      dueDate: new Date(values.dueDate).toLocaleDateString(
                        "en-GB",
                        {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        }
                      ),
                      issueDate: new Date(values.issueDate).toLocaleDateString(
                        "en-GB",
                        {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        }
                      ),
                      notes: values.notes,
                      currency: "EUR",
                      subtotalCents: calculateSubtotal(),
                      taxAmountCents: taxCalculation.totalTaxCents,
                      totalAmountCents:
                        calculateSubtotal() + taxCalculation.totalTaxCents,
                      effectiveTaxRate:
                        taxCalculation.effectiveTaxRate.toString(),
                      taxJurisdiction: taxCalculation.jurisdiction,
                      taxCalculationMethod: taxCalculation.calculationMethod,
                      exemptionReason: taxCalculation.exemptionReason,
                      taxLineItemDescriptions:
                        taxCalculation.taxLineItemDescriptions,
                      taxLineItems: taxCalculation.taxLineItems,
                    }}
                  />
                </div>
              )}
            </form.Subscribe>
          </div>
        )}
      </div>
    </div>
  );
}
