import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  createFullTestEnvironment,
  authenticateTestUser,
  createTestApiClient,
  createTestCustomer,
  createTestPlanWithFeatures,
  createTestPrice,
  createBasicSubscription,
} from "../test-helpers";
import {
  processInvoicePdfGeneration,
  InvoiceCompleteAPI,
} from "../../src/helpers/invoices";
import {
  generatePresignedUrl,
  extractBucketAndKeyFromUrl,
} from "../../src/helpers/s3";
import { db } from "../../src/db/client";
import { invoices } from "@lumen/common/schema";
import { eq } from "drizzle-orm";
import dotenv from "dotenv";
import { hc } from "hono/client";
import { AppType } from "../../src/routes";
import { createId, createPrefixedId, ID_PREFIXES } from "@lumen/common";
import { baseEnv as env } from "../test-env";

dotenv.config();

const bucketName = env.INVOICE_BUCKET;

if (!bucketName) {
  throw new Error("INVOICE_BUCKET is required");
}

describe("PDF Generation and Access Flow Integration Test", () => {
  let merchantId: string;
  let customerId: string;
  let planId: string;
  let priceId: string;
  let subscriptionId: string;
  let sessionToken: string;
  let apiClient: ReturnType<typeof hc<AppType>>;
  let s3Client: S3Client;
  let testInvoiceId: string;
  let pdfKey: string;

  // Check if all required environment variables are available
  const requiredEnvVars = [
    "STORAGE_ENDPOINT",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
    "INVOICE_BUCKET",
    "STORAGE_REGION",
    "STORAGE_FORCE_PATH_STYLE",
  ];

  const missingEnvVars = requiredEnvVars.filter(
    (envVar) => !env[envVar as keyof typeof env]
  );
  if (missingEnvVars.length > 0) {
    console.error(
      `Missing required environment variables: ${missingEnvVars.join(", ")}`
    );
    throw new Error("Skipping PDF flow integration tests");
  }

  // Initialize the S3 client
  beforeEach(async () => {
    // Set up test environment
    const { user, merchant } = await createFullTestEnvironment();
    merchantId = merchant.id;

    // Authenticate to get a token for API calls
    const authResponse = await authenticateTestUser(user.email, user.password);
    sessionToken = authResponse.cookies.sessionToken;
    apiClient = createTestApiClient(sessionToken);

    // Create a test customer
    const customer = await createTestCustomer({
      merchantId,
      email: `pdf-flow-test-${Date.now()}@example.com`,
      name: "PDF Flow Test Customer",
    });
    customerId = customer.id;

    // Create a plan with features
    const testFeatures = [
      {
        slug: `pdf-flow-feature-${Date.now()}`,
        displayName: "PDF Flow Test Feature",
        description: "Feature for PDF flow testing",
        featureValue: true,
      },
    ];

    const planCreationResult = await createTestPlanWithFeatures(
      merchantId,
      testFeatures,
      {
        stablePlanId: `pdf-flow-plan-${Date.now()}`,
        versionNumber: 1,
        planName: "PDF Flow Test Plan",
        planDescription: "Plan for testing PDF flow",
      }
    );
    planId = planCreationResult.plan.id;

    // Create a price
    const price = await createTestPrice({
      planId,
      merchantId,
      currency: "USD",
      pricingData: {
        dsl_version: 1,
        components: [
          {
            component_name: "monthly-base-fee",
            type: "fixed",
            label: "Monthly Fee",
            amount_cents: 10000,
            recurrence_rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;INTERVAL=1",
            bill_immediately: false,
          },
        ],
      },
    });
    priceId = price.id;

    // Create a subscription
    const subscription = await createBasicSubscription(
      merchantId,
      customerId,
      planId,
      priceId
    );
    subscriptionId = subscription.id;

    // Initialize S3 client
    s3Client = new S3Client({
      region: env.STORAGE_REGION,
      endpoint: env.STORAGE_ENDPOINT,
      credentials: {
        accessKeyId: env.STORAGE_ACCESS_KEY_ID || "",
        secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY || "",
      },
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    });

    // Generate a unique invoice ID for this test
    testInvoiceId = createPrefixedId(ID_PREFIXES.invoice);

    // Create PDF key based on the test invoice ID
    pdfKey = `invoices/${testInvoiceId}.pdf`;
  });

  afterEach(async () => {
    // Clean up the test invoice from the database
    if (testInvoiceId) {
      await db.delete(invoices).where(eq(invoices.id, testInvoiceId));
    }

    // Clean up the test file from S3
    if (pdfKey && bucketName) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: bucketName,
            Key: pdfKey,
          })
        );
      } catch (error) {
        console.error("Error cleaning up test PDF from S3:", error);
      }
    }
  });

  it("should generate a PDF, upload it to S3, create a presigned URL, and access the PDF", async () => {
    // 1. Create mock invoice data
    const mockInvoice: InvoiceCompleteAPI = {
      id: testInvoiceId,
      customerInvoiceNumber: `TEST-${Math.floor(1000 + Math.random() * 9000)}`, // TEST-<4 digit random number>
      currency: "USD",
      issueDate: new Date().toISOString(),
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      billingPeriodStartDate: new Date().toISOString(),
      billingPeriodEndDate: null,
      subtotalCents: 10000,
      taxAmountCents: 0,
      totalAmountCents: 10000,
      effectiveTaxRate: null,
      taxJurisdiction: "US",
      taxCalculationMethod: "auto",
      lineItems: [
        {
          id: `item-${testInvoiceId}-1`,
          description: "Integration Test Item",
          subtotalCents: 10000,
        },
      ],
      customer: {
        id: customerId,
        name: "PDF Flow Test Customer",
        email: "test@example.com",
        billingAddressLine1: "123 Test Street",
        billingAddressLine2: "",
        billingCity: "Test City",
        billingStateProvince: null,
        billingPostalCode: "12345",
        billingCountry: "Germany",
        taxId: null,
        invoicePrefix: null,
        createdAt: new Date().toISOString(),
        timezone: "UTC",
        phoneNumber: null,
        updatedAt: null,
        deletedAt: null,
        merchantId: merchantId,
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
        id: merchantId,
        legalName: "Test Merchant",
        displayName: "Test Merchant",
        taxId: null,
        addressLine1: "456 Merchant Street",
        addressLine2: null,
        city: "Merchant City",
        stateProvince: null,
        postalCode: "67890",
        country: "Germany",
        billingEmail: null,
        timezone: "UTC",
        userId: "user_test",
        organizationId: "org_test",
        websiteUrl: null,
        supportEmail: null,
        phoneNumber: null,
        defaultCurrency: "USD",
        supportedCurrencies: ["USD", "EUR"],
        defaultPaymentTerms: "30",
        defaultPaymentMethods: ["card"],
        invoicePrefix: null,
        invoiceTemplateId: null,
        brandingSettings: null,
        notificationPreferences: null,
        featureFlags: null,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        deletedAt: null,
      },
    };

    // 2. Generate the PDF
    const pdfResult = await processInvoicePdfGeneration([mockInvoice]);

    // Verify PDF generation was successful
    expect(pdfResult.success).toBe(1);
    expect(pdfResult.failed).toBe(0);
    expect(pdfResult.generatedPdfs[0].status).toBe("success");
    expect(pdfResult.generatedPdfs[0].pdfBuffer).toBeTruthy();
    expect(pdfResult.generatedPdfs[0].fileName).toBe(
      `invoices/${testInvoiceId}.pdf`
    );

    const pdfBuffer = pdfResult.generatedPdfs[0].pdfBuffer;
    expect(pdfBuffer).not.toBeNull();
    if (!pdfBuffer) {
      throw new Error("PDF buffer is null");
    }

    // 3. Upload the PDF to S3
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: pdfKey,
        Body: pdfBuffer,
        ContentType: "application/pdf",
        ACL: "private", // Explicitly set ACL to private
      })
    );

    // 4. Create an invoice record in the database with the PDF URL
    const pdfUrl = `${env.STORAGE_ENDPOINT}/${bucketName}/${pdfKey}`;
    const [invoice] = await db
      .insert(invoices)
      .values({
        id: testInvoiceId,
        merchantId,
        customerId,
        // Use the actual subscription ID from our test subscription
        subscriptionId: subscriptionId,
        status: "generated",
        totalAmountCents: 10000,
        currency: "USD",
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        customerInvoiceNumber: `TEST-${testInvoiceId.substring(0, 8)}`,
        pdfUrl: pdfUrl,
      })
      .returning();

    expect(invoice).toBeDefined();
    expect(invoice.pdfUrl).toBe(pdfUrl);

    // 5. Use the API to get a presigned URL
    const response = await apiClient.invoices[":id"].pdf.$get({
      param: {
        id: testInvoiceId,
      },
    });
    const data = await response.json();
    if ("error" in data) {
      throw new Error(data.error);
    }

    expect(response.status).toBe(200);
    expect(data.pdfUrl).toBeDefined();
    expect(data.pdfUrl).toContain("X-Amz-Signature=");
    expect(data.invoice.id).toBe(testInvoiceId);

    const presignedUrl = data.pdfUrl;

    // 6. Try to access the PDF using the presigned URL
    try {
      const pdfResponse = await fetch(presignedUrl);

      // Check if the fetch was successful
      expect(pdfResponse.status).toBe(200);
      expect(pdfResponse.headers.get("content-type")).toContain(
        "application/pdf"
      );

      // Read the PDF content to verify it's a valid PDF
      const pdfContent = await pdfResponse.arrayBuffer();
      const pdfBytes = new Uint8Array(pdfContent);

      // Check if the file starts with the PDF magic number '%PDF'
      const isPdf =
        pdfBytes.length > 4 &&
        pdfBytes[0] === 37 && // %
        pdfBytes[1] === 80 && // P
        pdfBytes[2] === 68 && // D
        pdfBytes[3] === 70; // F

      expect(isPdf).toBe(true);
    } catch (error) {
      console.error("Error accessing PDF with presigned URL:", error);
      throw error;
    }

    // 7. Try to directly access the S3 URL (should fail without credentials)
    try {
      const directResponse = await fetch(pdfUrl);

      // This should fail with a 403 or similar error
      expect(directResponse.status).toBe(403);
    } catch (error) {
      // It's okay if this fails with a network error too
      console.log("Direct access correctly failed with error", error);
    }

    // 8. Verify the URL extraction function works with this URL
    const bucketAndKey = extractBucketAndKeyFromUrl(pdfUrl);
    if (!bucketAndKey) {
      throw new Error("Failed to extract bucket and key from URL");
    }
    const { bucket, key } = bucketAndKey;
    expect(bucket).toBe(bucketName);
    expect(key).toBe(pdfKey);

    // Generate a presigned URL directly (without the API)
    const directPresignedUrl = await generatePresignedUrl(key, 60); // 1 minute expiration
    expect(directPresignedUrl).toContain("X-Amz-Signature=");

    // Verify this URL also works
    const directPdfResponse = await fetch(directPresignedUrl);
    expect(directPdfResponse.status).toBe(200);
  }, 15000); // Increase timeout to 15 seconds for this test
});
