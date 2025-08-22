import { ChildProcess, spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { testEnv } from "../test-env";
import { generateReturnObject } from "../../src/helpers/paymentprovider";
import { db } from "../../src/db/client";
import { payments as paymentsTable } from "@lumen/common/schema";
import { eq } from "drizzle-orm";
import { DodoPayments } from "dodopayments";

export type PaymentProviderName = "stripe" | "dodo";

export type IntentType = "payment_intent" | "setup_intent" | string;

export interface PaymentProviderAdapter {
  initialize(): Promise<void>;
  registerIntegration(merchantId: string): Promise<void>;
  startWebhookForwarder(merchantId: string): Promise<void>;
  completePaymentInit(
    paymentInitResponse: ReturnType<typeof generateReturnObject>
  ): Promise<void>;
  waitForWebhooks(ms?: number): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createPaymentProvider(
  providerName?: PaymentProviderName
): Promise<PaymentProviderAdapter> {
  const provider = providerName || process.env.PAYMENT_PROVIDER || "stripe";
  let adapter: PaymentProviderAdapter;

  switch (provider) {
    case "stripe":
      adapter = new StripeAdapter();
      break;
    case "dodo":
      adapter = new DodoAdapter();
      break;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }

  await adapter.initialize();
  return adapter;
}

class StripeAdapter implements PaymentProviderAdapter {
  private stripeClient: any;
  private webhookProcess: ChildProcess | null = null;
  private tempWebhookSecretFile = "/tmp/test_webhook_secret.txt";
  private tempMerchantIdFile = "/tmp/test_merchant_id.txt";

  async initialize(): Promise<void> {
    const secretKey = testEnv.TEST_STRIPE_SECRET_KEY;
    const Stripe = (await import("stripe")).default;
    this.stripeClient = new Stripe(secretKey, {
      apiVersion: "2025-02-24.acacia",
    });
  }

  async registerIntegration(merchantId: string): Promise<void> {
    const { createTestStripe } = await import("./data/stripe");
    await createTestStripe({
      merchantId,
      secretKey: testEnv.TEST_STRIPE_SECRET_KEY,
      publicKey: testEnv.TEST_STRIPE_PUBLIC_KEY,
      webhookSecret: testEnv.TEST_STRIPE_WEBHOOK_SECRET,
    });
  }

  async startWebhookForwarder(merchantId: string): Promise<void> {
    const stripeCLIPath = await resolveCliBinary(
      ["stripe"],
      [
        "/usr/local/bin/stripe",
        "/opt/homebrew/bin/stripe",
        path.join(process.env.HOME || "", ".local/bin/stripe"),
      ]
    );

    if (!stripeCLIPath) {
      console.log("Stripe CLI not found, webhook listener will not be started");
      return;
    }

    await fs.writeFile(this.tempMerchantIdFile, merchantId);

    const secretProcess = spawn(stripeCLIPath, [
      "listen",
      "--forward-to",
      `localhost:8000/v1/public/webhook/${merchantId}`,
      "--print-secret",
      "--api-key",
      testEnv.TEST_STRIPE_SECRET_KEY,
    ]);

    let secret = "";
    secretProcess.stdout.on("data", (data) => {
      secret += data.toString();
    });

    await new Promise<void>((resolve) => {
      secretProcess.on("close", async () => {
        secret = secret.trim();
        await fs.writeFile(this.tempWebhookSecretFile, secret);
        resolve();
      });
    });

    this.webhookProcess = spawn(
      stripeCLIPath,
      [
        "listen",
        "--forward-to",
        `localhost:8000/v1/public/webhook/${merchantId}`,
        "--api-key",
        testEnv.TEST_STRIPE_SECRET_KEY,
      ],
      { detached: true, stdio: "ignore" }
    );

    await this.waitForWebhooks(1000);
  }

  async completePaymentInit(
    paymentInitResponse: ReturnType<typeof generateReturnObject>
  ): Promise<void> {
    if (!this.stripeClient) throw new Error("Stripe client not initialized");
    if (
      !(
        "intentId" in paymentInitResponse && "intentType" in paymentInitResponse
      )
    ) {
      throw new Error("Invalid payment init response");
    }

    const { intentId, intentType } = paymentInitResponse;

    if (intentType === "payment_intent") {
      const res = await this.stripeClient.paymentIntents.confirm(intentId, {
        payment_method: "pm_card_visa",
      });
      if (res.status !== "succeeded") {
        throw new Error(`PaymentIntent not succeeded: ${res.status}`);
      }
      return;
    }

    if (intentType === "setup_intent") {
      const res = await this.stripeClient.setupIntents.confirm(intentId, {
        payment_method: "pm_card_visa",
      });
      if (res.status !== "succeeded") {
        throw new Error(`SetupIntent not succeeded: ${res.status}`);
      }
      return;
    }

    throw new Error(`Unsupported intent type for Stripe: ${intentType}`);
  }

  async waitForWebhooks(ms?: number): Promise<void> {
    const wait = typeof ms === "number" ? ms : 3000;
    console.log(`Waiting for webhooks ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }

  async cleanup(): Promise<void> {
    if (this.webhookProcess && !this.webhookProcess.killed) {
      try {
        this.webhookProcess.kill();
      } catch {}
      this.webhookProcess = null;
    }
    try {
      await fs.unlink(this.tempWebhookSecretFile);
    } catch {}
    try {
      await fs.unlink(this.tempMerchantIdFile);
    } catch {}
  }
}

class DodoAdapter implements PaymentProviderAdapter {
  private dodoClient: DodoPayments;
  private webhookProcess: ChildProcess | null = null;
  private redirectProcess: any = null;

  async initialize(): Promise<void> {
    this.dodoClient = new DodoPayments({
      bearerToken: testEnv.TEST_DODO_SECRET_KEY,
      environment: "test_mode",
    });
  }
  async registerIntegration(merchantId: string): Promise<void> {
    const { createTestDodo } = await import("./data/dodo");
    await createTestDodo({
      merchantId,
      secretKey: testEnv.TEST_DODO_SECRET_KEY,
    });
  }
  async startWebhookForwarder(merchantId: string): Promise<void> {
    const ngrokPath = await resolveCliBinary(
      ["ngrok"],
      [
        "/usr/local/bin/ngrok",
        "/opt/homebrew/bin/ngrok",
        path.join(process.env.HOME || "", ".local/bin/ngrok"),
      ]
    );

    if (!ngrokPath) {
      console.log("ngrok not found, webhook forwarder will not be started");
      return;
    }

    // receives ngrok webhook in port 8001 and forwards it to backend on port 8000 with the correct path
    // Why: couldn't find how to make grok redirect any traffic to a specific path
    console.log("Current directory:", process.cwd());
    this.redirectProcess = Bun.spawn(
      [
        "bun",
        "./tests/test-helpers/redirect-webhook-with-path.ts",
        `/v1/public/webhook-dodo/${merchantId}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Wait for the redirect server to start by reading initial output
    // The server logs startup messages and then runs indefinitely
    let startupOutput = "";
    const reader = this.redirectProcess.stdout.getReader();
    const decoder = new TextDecoder();

    // Read initial chunks until we see the success message
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      startupOutput += chunk;
      console.log("Redirect server output:", chunk);

      // Stop reading once we see the server is running
      if (chunk.includes("✅ Redirect server running")) {
        break;
      }

      // Also break if we see an error
      if (chunk.includes("Error starting redirect server")) {
        throw new Error(`Failed to start redirect server: ${startupOutput}`);
      }
    }

    // Release the reader so the process can continue running
    reader.releaseLock();

    console.log(
      `Successfully started webhook redirect process for merchant ${merchantId}`
    );

    // Kill any existing ngrok processes to avoid conflicts
    try {
      Bun.spawn(["killall", "ngrok"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for processes to terminate
    } catch (error) {
      // Ignore errors - ngrok might not be running
    }

    console.log(
      "Starting ngrok tunnel: ",
      [ngrokPath, "http", `--url=${testEnv.NGROK_URL}`, `8001`].join(" ")
    );

    this.webhookProcess = spawn(
      ngrokPath,
      ["http", `--url=${testEnv.NGROK_URL}`, `8001`],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"], // Capture stdout and stderr
      }
    );

    // Set up error handling for ngrok process
    let ngrokOutput = "";
    let ngrokError = "";

    if (this.webhookProcess.stdout) {
      this.webhookProcess.stdout.on("data", (data) => {
        const output = data.toString();
        ngrokOutput += output;
        console.log("ngrok stdout:", output.trim());
      });
    }

    if (this.webhookProcess.stderr) {
      this.webhookProcess.stderr.on("data", (data) => {
        const error = data.toString();
        ngrokError += error;
        console.error("ngrok stderr:", error.trim());
      });
    }

    // Handle process exit
    this.webhookProcess.on("exit", (code, signal) => {
      if (code !== 0) {
        console.error(
          `ngrok process exited with code ${code}, signal: ${signal}`
        );
        if (ngrokError) {
          console.error("ngrok error output:", ngrokError);
        }
      }
    });

    // Handle process errors (e.g., failed to start)
    this.webhookProcess.on("error", (error) => {
      console.error("Failed to start ngrok process:", error);
      throw new Error(`Failed to start ngrok: ${error.message}`);
    });

    console.log(
      `Started ngrok webhook forwarder with PID: ${this.webhookProcess.pid}`
    );

    // Wait a bit longer to allow ngrok to start and potentially report errors
    await this.waitForWebhooks(3000);

    // Check if the process is still running after startup
    if (this.webhookProcess.killed || this.webhookProcess.exitCode !== null) {
      const errorMsg = `ngrok process failed to start or exited early. Exit code: ${this.webhookProcess.exitCode}`;
      if (ngrokError) {
        throw new Error(`${errorMsg}\nError output: ${ngrokError}`);
      }
      throw new Error(errorMsg);
    }
  }
  async completePaymentInit(
    paymentInitResponse: ReturnType<typeof generateReturnObject>
  ): Promise<void> {
    if (
      !("id" in paymentInitResponse && "payment_link" in paymentInitResponse)
    ) {
      throw new Error("Invalid Dodo payment init response");
    }

    const subscriptionId = paymentInitResponse.id as string;

    const payment = await db.query.payments.findFirst({
      where: eq(paymentsTable.externalPaymentId, subscriptionId),
    });

    if (!payment) {
      throw new Error(
        `Payment not found for externalPaymentId: ${subscriptionId}`
      );
    }

    const dodoPaymentHardcoded = await this.dodoClient.payments.retrieve(
      testEnv.TEST_DODO_PAYMENT_ID
    );

    if (!dodoPaymentHardcoded.subscription_id) {
      throw new Error(
        `Dodo payment ${testEnv.TEST_DODO_PAYMENT_ID} has no subscription_id`
      );
    }

    const DODO_MINIMUM_AMOUNT_FOR_CHARGE = 100;

    if (payment.amountCents === 0) {
      // mock zero dollar webhook

      // We need this new mock fresh payment in case it gets refunded by mistake and becomes unusable
      const newMockPayment = await this.dodoClient.subscriptions.charge(
        dodoPaymentHardcoded.subscription_id,
        {
          product_description: `Mock payment for running zero dollar payments`,
          product_price: 42069,
        }
      );
      const merchantId = payment.merchantId;
      const payload = {
        business_id: "bus_FgLD2avSgucu2AchbABt4",
        data: {
          billing: {
            city: "berlin",
            country: "DE",
            state: "berlin",
            street: "mock street",
            zipcode: "10117",
          },
          brand_id: "bus_FgLD2avSgucu2AchbABt4",
          business_id: "bus_FgLD2avSgucu2AchbABt4",
          card_issuing_country: "GB",
          card_last_four: "4242",
          card_network: "VISA",
          card_type: "CREDIT",
          created_at: "2025-08-15T13:57:35.951521Z",
          currency: "USD",
          customer: {
            customer_id: "cus_SgDNU7d14OLv1jXj0tMCs",
            email: "mock@email.com",
            name: "mock name",
          },
          digital_products_delivered: false,
          discount_id: null,
          disputes: [],
          error_code: null,
          error_message: null,
          metadata: {
            lumen_payment_id: payment.id,
          },
          payload_type: "Payment",
          payment_id: newMockPayment.payment_id,
          payment_link:
            "https://test.checkout.dodopayments.com/mock-payment-link",
          payment_method: "card",
          payment_method_type: null,
          product_cart: null,
          refunds: [],
          settlement_amount: 0,
          settlement_currency: "USD",
          settlement_tax: null,
          status: "succeeded",
          subscription_id: dodoPaymentHardcoded.subscription_id,
          tax: null,
          total_amount: 0,
          updated_at: null,
        },
        timestamp: "2025-08-15T13:57:57.468483Z",
        type: "payment.succeeded",
      };
      const url = `http://localhost:8000/v1/public/webhook-dodo/${merchantId}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to POST Dodo webhook (${res.status}): ${text}`);
      }
    } else if (payment.amountCents >= DODO_MINIMUM_AMOUNT_FOR_CHARGE) {
      try {
        await this.dodoClient.subscriptions.charge(
          dodoPaymentHardcoded.subscription_id,
          {
            product_description: `New payment for running tests`,
            product_price: payment.amountCents,
            metadata: {
              lumen_payment_id: payment.id,
            },
          }
        );
      } catch (error) {
        console.error(
          `Error processing Dodo Payment. Charge payment amount: ${payment.amountCents}.
Possible cause: the stored TEST_DODO_PAYMENT_ID=${testEnv.TEST_DODO_PAYMENT_ID} got refunded or its behaviour is not valid for this type of test.`
        );
        throw error;
      }
    } else {
      throw new Error(
        `Dodo payment amount ${payment.amountCents} is less than minimum amount for charge ${DODO_MINIMUM_AMOUNT_FOR_CHARGE}`
      );
    }
  }
  async waitForWebhooks(ms?: number): Promise<void> {
    const wait = typeof ms === "number" ? ms : 3000;
    await new Promise((r) => setTimeout(r, wait));
  }
  async cleanup(): Promise<void> {
    if (this.webhookProcess && !this.webhookProcess.killed) {
      try {
        this.webhookProcess.kill();
      } catch {}
      this.webhookProcess = null;
    }
    if (this.redirectProcess) {
      try {
        this.redirectProcess.kill();
      } catch {}
      this.redirectProcess = null;
    }
  }
}

async function resolveCliBinary(
  namesToCheckOnPath: string[],
  fallbackPaths: string[]
): Promise<string | null> {
  for (const name of namesToCheckOnPath) {
    try {
      // Bun runtime provides Bun.spawn
      const proc = await Bun.spawn(["which", name], { stdout: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const result = stdout.trim();
      if (result) return result;
    } catch {}
  }
  for (const p of fallbackPaths) {
    try {
      await fs.access(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

export type { StripeAdapter };
