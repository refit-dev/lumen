import { describe, it, expect, beforeAll } from "bun:test";
import { Font } from "@react-pdf/renderer";
import { writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import {
  processInvoicePdfGeneration,
  InvoiceCompleteAPI,
} from "../../src/helpers/invoices";

// Configure React-PDF before tests run
beforeAll(() => {
  // Set test environment
  process.env.NODE_ENV = "test";

  // Get absolute path to fonts directory relative to this test file
  const fontsDir = resolve(
    __dirname,
    "../../trigger/assets/fonts/Geist/static"
  );

  // Register Geist font for consistent rendering in tests
  Font.register({
    family: "Geist",
    fonts: [
      {
        src: join(fontsDir, "Geist-Regular.ttf"),
        fontWeight: "normal",
        fontStyle: "normal",
      },
      {
        src: join(fontsDir, "Geist-Bold.ttf"),
        fontWeight: "bold",
        fontStyle: "normal",
      },
      {
        src: join(fontsDir, "Geist-Light.ttf"),
        fontWeight: "normal",
        fontStyle: "italic",
      },
      {
        src: join(fontsDir, "Geist-SemiBold.ttf"),
        fontWeight: "bold",
        fontStyle: "italic",
      },
    ],
  });

  // Also register hyphenation callback for better text wrapping
  Font.registerHyphenationCallback((word) => [word]);

  // Suppress noisy console output during tests
  const originalConsole = {
    warn: console.warn,
    error: console.error,
    log: console.log,
  };

  console.warn = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("Warning:")) return;
    originalConsole.warn.apply(console, args);
  };

  console.error = (...args) => {
    if (args[0]?.includes?.("Failed to generate PDF")) return;
    originalConsole.error.apply(console, args);
  };

  console.log = (...args) => {
    // Skip logging "Attempting to generate PDF" and "Successfully generated" messages
    if (
      args[0]?.includes?.("Attempting to generate PDF") ||
      args[0]?.includes?.("Successfully generated") ||
      args[0]?.includes?.("Final results")
    )
      return;
    originalConsole.log.apply(console, args);
  };
});

// Mock data for testing - based on real invoice data structure
const createMockInvoice = (id: string, overrides = {}): InvoiceCompleteAPI => {
  return {
    id,
    customerInvoiceNumber: `TEST-000${id}`,
    currency: "EUR",
    issueDate: "2025-06-06T13:15:25.984Z",
    dueDate: "2025-06-06T13:15:25.984Z",
    billingPeriodStartDate: "2025-06-06T13:15:25.984Z",
    billingPeriodEndDate: null,
    // Tax fields for enhanced PDF display
    subtotalCents: 10000,
    taxAmountCents: 1900, // 19% German VAT
    totalAmountCents: 11900,
    effectiveTaxRate: "0.19",
    taxJurisdiction: "DE",
    taxCalculationMethod: "auto",
    lineItems: [
      {
        id: `inv_item_${id}_1`,
        description: "€ 100.00 per month",
        subtotalCents: 10000,
      },
    ],
    customer: {
      id: `cus_${id}`,
      name: "Test Customer",
      email: "test@example.com",
      billingAddressLine1: "123 Test Street",
      billingAddressLine2: "",
      billingCity: "Test City",
      billingStateProvince: null,
      billingPostalCode: "12345",
      billingCountry: "US",
      taxId: "12-3456789",
      invoicePrefix: null,
      createdAt: "2025-06-06T13:15:18.059Z",
      timezone: "UTC",
      phoneNumber: null,
      updatedAt: null,
      deletedAt: null,
      merchantId: `mer_${id}`,
      pspCustomerId: null,
      externalCustomerId: null,
      businessName: null,
      taxExempt: null,
      taxExemptionReason: null,
      taxExemptionCertificate: null,
      preferredLanguage: null,
      preferredCurrency: null,
      metadata: null,
      taxRateDefinitionId: null,
      taxCalculationMethod: "auto",
    },
    merchant: {
      id: `mer_${id}`,
      legalName: "Test Merchant GmbH",
      displayName: "Test Merchant GmbH",
      taxId: "DE123456789",
      addressLine1: "123 Test Street",
      addressLine2: "c/o Test Person",
      city: "Berlin",
      stateProvince: "",
      postalCode: "10115",
      country: "DE",
      billingEmail: null,
      timezone: "UTC",
      userId: `user_${id}`,
      organizationId: `org_${id}`,
      websiteUrl: null,
      supportEmail: null,
      phoneNumber: null,
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR", "USD"],
      defaultPaymentTerms: "30",
      defaultPaymentMethods: ["card"],
      invoicePrefix: null,
      invoiceTemplateId: null,
      brandingSettings: null,
      notificationPreferences: null,
      featureFlags: null,
      createdAt: "2025-06-06T13:15:18.059Z",
      updatedAt: null,
      deletedAt: null,
    },
    ...overrides,
  };
};

describe("processInvoicePdfGeneration", () => {
  it("should generate PDFs for valid invoices", async () => {
    const mockInvoices = [
      createMockInvoice("123", {
        billingPeriodStartDate: "2024-04-01T00:00:00Z",
        billingPeriodEndDate: "2024-04-30T23:59:59Z",
      }),
      createMockInvoice("456"),
    ];
    const result = await processInvoicePdfGeneration(mockInvoices);

    expect(result.success).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.generatedPdfs.length).toBe(2);

    const firstPdf = result.generatedPdfs[0];
    expect(firstPdf.invoiceId).toBe("123");
    expect(firstPdf.status).toBe("success");
    expect(firstPdf.pdfBuffer).toBeTruthy();
    if (firstPdf.pdfBuffer) {
      expect(firstPdf.pdfBuffer instanceof Buffer).toBe(true);
      expect(firstPdf.pdfBuffer.length).toBeGreaterThan(0);

      // Save PDF for inspection - navigate up one level for project root
      const tempDir = join(process.cwd(), "..", "tmp");
      const pdfPath = join(tempDir, "test-invoice.pdf");

      // Create tmp directory if it doesn't exist
      mkdirSync(tempDir, { recursive: true });

      // Write the PDF
      writeFileSync(pdfPath, firstPdf.pdfBuffer);
      console.log("\n✨ PDF saved for inspection at:", pdfPath, "\n");
    }
    expect(firstPdf.fileName).toBe("invoices/123.pdf");
    expect(firstPdf.invoiceNumber).toBe("TEST-000123");

    const secondPdf = result.generatedPdfs[1];
    expect(secondPdf.invoiceId).toBe("456");
    expect(secondPdf.status).toBe("success");
    expect(secondPdf.pdfBuffer).toBeTruthy();
    if (secondPdf.pdfBuffer) {
      expect(secondPdf.pdfBuffer instanceof Buffer).toBe(true);
      expect(secondPdf.pdfBuffer.length).toBeGreaterThan(0);
    }
    expect(secondPdf.fileName).toBe("invoices/456.pdf");
    expect(secondPdf.invoiceNumber).toBe("TEST-000456");
  });

  it("should handle invalid invoice data gracefully", async () => {
    const mockInvoices = [
      createMockInvoice("123"),
      { id: "invalid" } as unknown as InvoiceCompleteAPI,
    ];

    const result = await processInvoicePdfGeneration(mockInvoices);

    expect(result.success).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.generatedPdfs.length).toBe(2);

    const validPdf = result.generatedPdfs[0];
    expect(validPdf.status).toBe("success");
    expect(validPdf.pdfBuffer).toBeTruthy();

    const invalidPdf = result.generatedPdfs[1];
    expect(invalidPdf.status).toBe("failed");
    expect(invalidPdf.pdfBuffer).toBeNull();
    expect(invalidPdf.error).toBeTruthy();
  });

  it("should fail missing customer and merchant data", async () => {
    const mockInvoice = createMockInvoice("123", {
      customer: null,
      merchant: null,
    });

    const result = await processInvoicePdfGeneration([mockInvoice]);

    expect(result.success).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.generatedPdfs[0].status).not.toBe("success");
    expect(result.generatedPdfs[0].pdfBuffer).not.toBeTruthy();
  });

  it("should handle different currencies correctly", async () => {
    const mockInvoices = [
      createMockInvoice("123", { currency: "EUR" }),
      createMockInvoice("456", { currency: "USD" }),
    ];

    const result = await processInvoicePdfGeneration(mockInvoices);

    expect(result.success).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("should handle address construction correctly", async () => {
    const mockInvoice = createMockInvoice("123", {
      customer: {
        id: "cus_address_test",
        name: "Address Test Customer",
        email: "address@example.com",
        billingAddressLine1: "Test Building",
        billingAddressLine2: "Suite 100",
        billingCity: "Berlin",
        billingStateProvince: "Berlin",
        billingPostalCode: "10115",
        billingCountry: "DE",
        taxId: "DE123456789",
        invoicePrefix: null,
        createdAt: "2025-06-06T13:15:18.059Z",
        timezone: "UTC",
        phoneNumber: null,
        updatedAt: null,
        deletedAt: null,
        merchantId: "mer_address_test",
        pspCustomerId: null,
        externalCustomerId: null,
        businessName: null,
        taxExempt: null,
        taxExemptionReason: null,
        taxExemptionCertificate: null,
        preferredLanguage: null,
        preferredCurrency: null,
        metadata: null,
      },
      merchant: {
        id: "mer_address_test",
        legalName: "Address Test Corp",
        displayName: "Address Test",
        addressLine1: "Corporate Tower",
        addressLine2: "Floor 25",
        city: "Hamburg",
        stateProvince: "Hamburg",
        postalCode: "20095",
        country: "DE",
        taxId: "DE987654321",
        billingEmail: null,
        timezone: "UTC",
        userId: "user_address_test",
        organizationId: "org_address_test",
        websiteUrl: null,
        supportEmail: null,
        phoneNumber: null,
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR", "USD"],
        defaultPaymentTerms: "30",
        defaultPaymentMethods: ["card"],
        invoicePrefix: null,
        invoiceTemplateId: null,
        brandingSettings: null,
        notificationPreferences: null,
        featureFlags: null,
        createdAt: "2025-06-06T13:15:18.059Z",
        updatedAt: null,
        deletedAt: null,
      },
    });

    const result = await processInvoicePdfGeneration([mockInvoice]);

    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.generatedPdfs[0].status).toBe("success");
    expect(result.generatedPdfs[0].pdfBuffer).toBeTruthy();
  });

  it("should format dates using en-GB locale", async () => {
    const issueDateUTC = "2024-07-15T02:00:00Z"; // July 15 UTC
    const dueDateUTC = "2024-08-14T23:00:00Z"; // Aug 14 UTC
    const mockInvoice = createMockInvoice("date-format", {
      issueDate: issueDateUTC,
      dueDate: dueDateUTC,
    });

    const result = await processInvoicePdfGeneration([mockInvoice]);
    expect(result.success).toBe(1);
    const pdfResult = result.generatedPdfs[0];
    expect(pdfResult.status).toBe("success");
    expect(pdfResult.pdfData).toBeTruthy();

    // Dates formatted with en-GB locale
    expect(pdfResult.pdfData?.issueDate).toBe("15 July 2024");
    expect(pdfResult.pdfData?.dueDate).toBe("14 August 2024");
  });

  it("should handle invalid date strings gracefully", async () => {
    const mockInvoice = createMockInvoice("invalid-date", {
      issueDate: "invalid-date-string",
      dueDate: null,
    });

    const result = await processInvoicePdfGeneration([mockInvoice]);
    expect(result.success).toBe(1);
    const pdfResult = result.generatedPdfs[0];
    expect(pdfResult.status).toBe("success");
    expect(pdfResult.pdfData).toBeTruthy();

    // Check for fallback formatting
    expect(pdfResult.pdfData?.issueDate).toBe("N/A"); // Should be N/A now
    expect(pdfResult.pdfData?.dueDate).toBe("N/A"); // Handled by formatDate helper
  });

  // Tax-related tests
  it("should generate PDF with standard tax breakdown", async () => {
    const mockInvoice = createMockInvoice("tax-standard", {
      subtotalCents: 10000,
      taxAmountCents: 825, // 8.25% California sales tax
      totalAmountCents: 10825,
      effectiveTaxRate: "0.0825",
      taxJurisdiction: "US-CA",
      taxCalculationMethod: "auto",
    });

    const result = await processInvoicePdfGeneration([mockInvoice]);
    expect(result.success).toBe(1);
    const pdfResult = result.generatedPdfs[0];
    expect(pdfResult.status).toBe("success");
    expect(pdfResult.pdfBuffer).toBeTruthy();

    if (pdfResult.pdfBuffer) {
      expect(pdfResult.pdfBuffer instanceof Buffer).toBe(true);
      expect(pdfResult.pdfBuffer.length).toBeGreaterThan(0);

      // Save PDF for inspection
      const tempDir = join(process.cwd(), "..", "tmp");
      const pdfPath = join(tempDir, "test-invoice-with-tax.pdf");
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(pdfPath, pdfResult.pdfBuffer);
      console.log(
        "\n✨ Tax invoice PDF saved for inspection at:",
        pdfPath,
        "\n"
      );
    }
  });

  it("should generate PDF with tax-exempt status", async () => {
    const mockInvoice = createMockInvoice("tax-exempt", {
      subtotalCents: 10000,
      taxAmountCents: 0,
      totalAmountCents: 10000,
      effectiveTaxRate: null,
      taxJurisdiction: "US-CA",
      taxCalculationMethod: "exempt",
    });

    const result = await processInvoicePdfGeneration([mockInvoice]);
    expect(result.success).toBe(1);
    const pdfResult = result.generatedPdfs[0];
    expect(pdfResult.status).toBe("success");
    expect(pdfResult.pdfBuffer).toBeTruthy();

    if (pdfResult.pdfBuffer) {
      expect(pdfResult.pdfBuffer instanceof Buffer).toBe(true);
      expect(pdfResult.pdfBuffer.length).toBeGreaterThan(0);

      // Save PDF for inspection
      const tempDir = join(process.cwd(), "..", "tmp");
      const pdfPath = join(tempDir, "test-invoice-tax-exempt.pdf");
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(pdfPath, pdfResult.pdfBuffer);
      console.log(
        "\n✨ Tax-exempt invoice PDF saved for inspection at:",
        pdfPath,
        "\n"
      );
    }
  });

  it("should generate PDF with zero tax rate", async () => {
    const mockInvoice = createMockInvoice("zero-tax", {
      subtotalCents: 10000,
      taxAmountCents: 0,
      totalAmountCents: 10000,
      effectiveTaxRate: "0.00",
      taxJurisdiction: "US-DE", // Delaware has no sales tax
      taxCalculationMethod: "auto",
    });

    const result = await processInvoicePdfGeneration([mockInvoice]);
    expect(result.success).toBe(1);
    const pdfResult = result.generatedPdfs[0];
    expect(pdfResult.status).toBe("success");
    expect(pdfResult.pdfBuffer).toBeTruthy();

    if (pdfResult.pdfBuffer) {
      expect(pdfResult.pdfBuffer instanceof Buffer).toBe(true);
      expect(pdfResult.pdfBuffer.length).toBeGreaterThan(0);

      // Save PDF for inspection
      const tempDir = join(process.cwd(), "..", "tmp");
      const pdfPath = join(tempDir, "test-invoice-zero-tax.pdf");
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(pdfPath, pdfResult.pdfBuffer);
      console.log(
        "\n✨ Zero-tax invoice PDF saved for inspection at:",
        pdfPath,
        "\n"
      );
    }
  });

  it("should generate PDF with EU VAT", async () => {
    const mockInvoice = createMockInvoice("eu-vat", {
      currency: "EUR",
      subtotalCents: 10000,
      taxAmountCents: 1900, // 19% German VAT
      totalAmountCents: 11900,
      effectiveTaxRate: "0.19",
      taxJurisdiction: "DE",
      taxCalculationMethod: "auto",
      merchant: {
        id: "mer_eu_vat",
        legalName: "Test EU Merchant GmbH",
        displayName: "Test EU Merchant",
        taxId: "DE123456789",
        addressLine1: "Hauptstraße 123",
        addressLine2: null,
        city: "Berlin",
        stateProvince: "Berlin",
        postalCode: "10115",
        country: "DE",
        billingEmail: null,
        timezone: "UTC",
        userId: "user_eu_vat",
        organizationId: "org_eu_vat",
        websiteUrl: null,
        supportEmail: "support@test.de",
        phoneNumber: null,
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR", "USD"],
        defaultPaymentTerms: "30",
        defaultPaymentMethods: ["card"],
        invoicePrefix: null,
        invoiceTemplateId: null,
        brandingSettings: null,
        notificationPreferences: null,
        featureFlags: null,
        createdAt: "2025-06-06T13:15:18.059Z",
        updatedAt: null,
        deletedAt: null,
      },
    });

    const result = await processInvoicePdfGeneration([mockInvoice]);
    expect(result.success).toBe(1);
    const pdfResult = result.generatedPdfs[0];
    expect(pdfResult.status).toBe("success");
    expect(pdfResult.pdfBuffer).toBeTruthy();

    if (pdfResult.pdfBuffer) {
      expect(pdfResult.pdfBuffer instanceof Buffer).toBe(true);
      expect(pdfResult.pdfBuffer.length).toBeGreaterThan(0);

      // Save PDF for inspection
      const tempDir = join(process.cwd(), "..", "tmp");
      const pdfPath = join(tempDir, "test-invoice-eu-vat.pdf");
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(pdfPath, pdfResult.pdfBuffer);
      console.log(
        "\n✨ EU VAT invoice PDF saved for inspection at:",
        pdfPath,
        "\n"
      );
    }
  });

  it("should handle multiple tax scenarios in batch generation", async () => {
    const mockInvoices = [
      createMockInvoice("batch-1", {
        subtotalCents: 5000,
        taxAmountCents: 412, // 8.25% CA tax
        totalAmountCents: 5412,
        effectiveTaxRate: "0.0825",
        taxJurisdiction: "US-CA",
        taxCalculationMethod: "auto",
      }),
      createMockInvoice("batch-2", {
        subtotalCents: 7500,
        taxAmountCents: 0,
        totalAmountCents: 7500,
        effectiveTaxRate: null,
        taxJurisdiction: "US-NY",
        taxCalculationMethod: "exempt",
      }),
      createMockInvoice("batch-3", {
        currency: "EUR",
        subtotalCents: 12000,
        taxAmountCents: 2280, // 19% German VAT
        totalAmountCents: 14280,
        effectiveTaxRate: "0.19",
        taxJurisdiction: "DE",
        taxCalculationMethod: "auto",
      }),
    ];

    const result = await processInvoicePdfGeneration(mockInvoices);
    expect(result.success).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.generatedPdfs.length).toBe(3);

    // Verify all PDFs generated successfully
    for (const pdf of result.generatedPdfs) {
      expect(pdf.status).toBe("success");
      expect(pdf.pdfBuffer).toBeTruthy();
      if (pdf.pdfBuffer) {
        expect(pdf.pdfBuffer instanceof Buffer).toBe(true);
        expect(pdf.pdfBuffer.length).toBeGreaterThan(0);
      }
    }
  });
});
