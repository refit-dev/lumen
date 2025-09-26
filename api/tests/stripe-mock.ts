import { mock } from "bun:test";
import fs from "fs";
import crypto from "crypto";

type JsonObject = Record<string, any>;

const STORE_PATH =
  process.env.STRIPE_MOCK_STORE || "/tmp/stripe_mock_store.json";
const LOCK_PATH = `${STORE_PATH}.lock`;
const MERCHANT_ID_PATH = "/tmp/test_merchant_id.txt";
const WEBHOOK_SECRET_ENV = process.env.TEST_STRIPE_WEBHOOK_SECRET || "";
const WEBHOOK_SECRET_FILE = "/tmp/test_webhook_secret.txt";

function ensureStoreFile(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      fs.writeFileSync(STORE_PATH, JSON.stringify({}), { encoding: "utf8" });
    }
  } catch (e) {
    console.error("[stripe-mock] Failed to initialize store file", e);
  }
}

function readStore(): JsonObject {
  try {
    ensureStoreFile();
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("[stripe-mock] Failed to read store, returning empty", e);
    return {};
  }
}

function writeStore(store: JsonObject): void {
  try {
    acquireLock(LOCK_PATH);
    try {
      ensureStoreFile();
      const onDiskRaw = fs.readFileSync(STORE_PATH, "utf8");
      const onDisk = onDiskRaw ? (JSON.parse(onDiskRaw) as JsonObject) : {};
      const merged: JsonObject = { ...onDisk, ...store };
      atomicWriteJson(STORE_PATH, merged);
    } finally {
      releaseLock(LOCK_PATH);
    }
  } catch (e) {
    console.error("[stripe-mock] Failed to write store", e);
  }
}

function sleepMs(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch {
    // Fallback best-effort busy wait if SharedArrayBuffer is unavailable
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function acquireLock(lockPath: string, timeoutMs = 5000): void {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (err: any) {
      if (err && err.code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error("[stripe-mock] Timeout acquiring store lock");
      }
      sleepMs(10);
    }
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch {}
}

function atomicWriteJson(path: string, data: JsonObject): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8" });
  fs.renameSync(tmp, path);
}

function randomIdBody(length = 24): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "mock";
  for (let i = 4; i < length; i++) {
    const index = Math.floor(Math.random() * alphabet.length);
    out += alphabet[index];
  }
  return out;
}

function genId(prefix: string): string {
  return `${prefix}${randomIdBody()}`;
}

function getMerchantId(): string | null {
  try {
    const content = fs.readFileSync(MERCHANT_ID_PATH, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function getWebhookSecret(): string | null {
  if (WEBHOOK_SECRET_ENV) return WEBHOOK_SECRET_ENV;
  try {
    const content = fs.readFileSync(WEBHOOK_SECRET_FILE, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function signStripeBody(
  rawBody: string,
  secret: string
): { header: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  const header = `t=${timestamp},v1=${hmac}`;
  return { header, timestamp };
}

async function sendWebhook(eventType: string, object: any): Promise<void> {
  const merchantId = getMerchantId();
  if (!merchantId) {
    console.warn(
      "[stripe-mock] No merchant id found at /tmp/test_merchant_id.txt; skipping webhook"
    );
    return;
  }
  const secret = getWebhookSecret();
  if (!secret) {
    console.warn(
      "[stripe-mock] No webhook secret available; skipping webhook signature (will likely fail verification)"
    );
  }

  const event = {
    id: genId("evt_"),
    object: "event",
    api_version: "2025-02-24.acacia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: eventType,
    data: { object },
  };

  const rawBody = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) {
    const { header } = signStripeBody(rawBody, secret);
    headers["stripe-signature"] = header;
  } else {
    headers["stripe-signature"] = `t=${Math.floor(Date.now() / 1000)},v1=dummy`;
  }

  const url = `http://localhost:8000/v1/public/webhook/${merchantId}`;
  try {
    await fetch(url, { method: "POST", headers, body: rawBody });
  } catch (e) {
    console.error("[stripe-mock] Failed to POST webhook:", e);
  }
}

function createPaymentIntent(params: any) {
  const id = genId("pi_");
  const clientSecret = `${id}_secret_${randomIdBody(16)}`;
  return {
    id,
    object: "payment_intent",
    amount: params.amount ?? 0,
    currency: params.currency ?? "USD",
    customer: params.customer ?? null,
    payment_method: params.payment_method ?? null,
    description: params.description ?? null,
    setup_future_usage: params.setup_future_usage,
    status:
      params.confirm && params.payment_method
        ? "succeeded"
        : params.payment_method
          ? "requires_confirmation"
          : "requires_payment_method",
    client_secret: clientSecret,
    metadata: { ...(params.metadata || {}) },
  } as any;
}

function createSetupIntent(params: any) {
  const id = genId("seti_");
  const clientSecret = `${id}_secret_${randomIdBody(16)}`;
  return {
    id,
    object: "setup_intent",
    customer: params.customer ?? null,
    payment_method_types: params.payment_method_types ?? ["card"],
    payment_method: params.payment_method ?? null,
    usage: params.usage ?? "off_session",
    status:
      params.confirm && params.payment_method
        ? "succeeded"
        : params.payment_method
          ? "requires_confirmation"
          : "requires_payment_method",
    client_secret: clientSecret,
    metadata: { ...(params.metadata || {}) },
  } as any;
}

function createCheckoutSession(params: any) {
  const id = genId("cs_");
  return {
    id,
    object: "checkout.session",
    url: params.success_url || `https://checkout.example/${id}`,
    mode: params.mode || "payment",
    customer: params.customer ?? null,
    line_items: params.line_items ?? [],
    payment_intent: null,
    payment_status: "unpaid",
    metadata: params.metadata || {},
  } as any;
}

class MockStripe {
  constructor(_secretKey: string, _options?: any) {}

  private _read() {
    return readStore();
  }
  private _write(s: JsonObject) {
    writeStore(s);
  }

  static isMock = true;

  paymentIntents = {
    create: async (params: any) => {
      console.log("[stripe-mock] createPaymentIntent");
      const intent = createPaymentIntent({ ...params, confirm: false });
      const store = this._read();
      store[intent.id] = intent;
      this._write(store);
      if (params.confirm) {
        return await this.paymentIntents.confirm(intent.id, {
          payment_method: params.payment_method,
          customer: params.customer,
        });
      }
      return intent;
    },
    retrieve: async (id: string) => {
      console.log("[stripe-mock] retrievePaymentIntent");
      const store = this._read();
      return store[id] ?? null;
    },
    confirm: async (id: string, params?: any) => {
      console.log("[stripe-mock] confirmPaymentIntent");
      const store = this._read();
      const intent = store[id];
      if (!intent) {
        throw new Error(`No such payment_intent: ${id}`);
      }
      // Allow passing payment_method in confirm params
      if (params && params.payment_method) {
        intent.payment_method = params.payment_method;
      }

      const pmId: string | null = intent.payment_method || null;
      // Determine success based on attached/known payment method
      let shouldSucceed = true;
      if (!pmId) {
        shouldSucceed = false;
      } else {
        const pmObj = store[pmId];
        // Known failing test ids
        const failing =
          pmId === "pm_card_chargeCustomerFail" ||
          pmId === "pm_card_visa_chargeDeclined";
        shouldSucceed = !failing;
        // If PM not in store and it's one of our known tokens, upsert a default
        if (!pmObj) {
          const card = resolveTestCard(pmId);
          if (card) {
            store[pmId] = {
              id: pmId,
              object: "payment_method",
              type: "card",
              card,
              customer: params?.customer || null,
              metadata: {},
            };
          }
        }
      }

      if (!shouldSucceed) {
        intent.last_payment_error = {
          message: "Your card was declined.",
        };
      }
      intent.status = shouldSucceed ? "succeeded" : "requires_payment_method";
      store[id] = intent;
      this._write(store);
      if (shouldSucceed) {
        await sendWebhook("payment_intent.succeeded", intent);
      } else {
        await sendWebhook("payment_intent.payment_failed", {
          ...intent,
          status: "failed",
        });
      }
      return intent;
    },
  };

  setupIntents = {
    create: async (params: any) => {
      console.log("[stripe-mock] createSetupIntent");
      const intent = createSetupIntent({ ...params, confirm: false });
      const store = this._read();
      store[intent.id] = intent;
      this._write(store);
      if (params.confirm) {
        return await this.setupIntents.confirm(intent.id, {
          payment_method: params.payment_method,
          customer: params.customer,
        });
      }
      return intent;
    },
    retrieve: async (id: string) => {
      console.log("[stripe-mock] retrieveSetupIntent");
      const store = this._read();
      return store[id] ?? null;
    },
    confirm: async (id: string, params?: any) => {
      console.log("[stripe-mock] confirmSetupIntent: ", id);
      const store = this._read();
      const intent = store[id];
      if (!intent) {
        throw new Error(`No such setup_intent: ${id}`);
      }
      // Allow passing payment_method in confirm params
      if (params && params.payment_method) {
        intent.payment_method = params.payment_method;
      }

      const pmId: string | null = intent.payment_method || null;
      // Determine success based on attached/known payment method
      let shouldSucceed = true;
      if (!pmId) {
        shouldSucceed = false;
      } else {
        const pmObj = store[pmId];
        // Known failing test ids
        const failing =
          pmId === "pm_card_chargeCustomerFail" ||
          pmId === "pm_card_visa_chargeDeclined";
        shouldSucceed = !failing;
        // If PM not in store and it's one of our known tokens, upsert a default
        if (!pmObj) {
          const card = resolveTestCard(pmId);
          if (card) {
            store[pmId] = {
              id: pmId,
              object: "payment_method",
              type: "card",
              card,
              customer: params?.customer || null,
              metadata: {},
            };
          }
        }
      }

      if (!shouldSucceed) {
        intent.last_setup_error = {
          message: "Your card was declined.",
        };
      }
      intent.status = shouldSucceed ? "succeeded" : "requires_payment_method";
      store[id] = intent;
      this._write(store);
      if (shouldSucceed) {
        await sendWebhook("setup_intent.succeeded", intent);
      } else {
        await sendWebhook("setup_intent.setup_failed", {
          ...intent,
          status: "failed",
        });
      }
      return intent;
    },
  };

  checkout = {
    sessions: {
      create: async (params: any) => {
        console.log("[stripe-mock] createCheckoutSession");
        const session = createCheckoutSession(params);
        const store = this._read();
        store[session.id] = session;
        this._write(store);
        return session;
      },
      retrieve: async (id: string) => {
        console.log("[stripe-mock] retrieveCheckoutSession");
        const store = this._read();
        return store[id] ?? null;
      },
    },
  };

  sessions = this.checkout.sessions;

  customers = {
    create: async (params: any) => {
      console.log("[stripe-mock] createCustomer");
      const id = genId("cus_");
      const customer = {
        id,
        object: "customer",
        name: params.name ?? null,
        email: params.email ?? null,
        metadata: { ...(params.metadata || {}) },
      };
      const store = this._read();
      store[id] = customer;
      this._write(store);
      return customer;
    },
    retrieve: async (id: string) => {
      console.log("[stripe-mock] retrieveCustomer", id);
      const store = this._read();
      return store[id] ?? null;
    },
  };

  paymentMethods = {
    retrieve: async (id: string) => {
      console.log("[stripe-mock] retrievePaymentMethod: ", id);
      const store = this._read();
      const existing = store[id];
      if (existing) return existing as any;
      const card = resolveTestCard(id) || {
        brand: "visa",
        country: "US",
        exp_month: 12,
        exp_year: new Date().getFullYear() + 2,
        last4: "4242",
      };
      const pm = {
        id: id || genId("pm_"),
        object: "payment_method",
        type: "card",
        card,
        customer: null,
        metadata: {},
      } as any;
      // Cache it for subsequent retrievals
      store[id] = pm;
      this._write(store);
      return pm;
    },
    attach: async (id: string, params: { customer: string }) => {
      if (!id) {
        throw new Error(
          "[stripe-mock] id is required to attach a payment method"
        );
      }
      console.log("[stripe-mock] attachPaymentMethod");
      if (!params || !params.customer) {
        throw new Error(
          "[stripe-mock] customer is required to attach a payment method"
        );
      }
      const store = this._read();
      const card = resolveTestCard(id); // dictionary of test cards

      if (!card) {
        throw new Error(`[stripe-mock] No test card found for ID: ${id}.`);
      }
      const paymentMethod = {
        id,
        object: "payment_method",
        type: "card",
        card,
        customer: params.customer,
        metadata: {},
      } as any;
      store[id] = paymentMethod;
      this._write(store);
      return paymentMethod;
    },
  };

  refunds = {
    create: async (params: any) => {
      console.log("[stripe-mock] createRefund");
      const id = genId("re_");
      const refund = {
        id,
        object: "refund",
        status: "succeeded",
        amount: params.amount ?? null,
        payment_intent: params.payment_intent ?? null,
      };
      const store = this._read();
      store[id] = refund;
      this._write(store);
      return refund;
    },
  };

  webhooks = {
    constructEventAsync: async (
      rawBody: string,
      signatureHeader: string,
      secret: string
    ) => {
      try {
        console.log("[stripe-mock] constructEventAsync");
        const parts = (signatureHeader || "").split(",");
        const map: Record<string, string> = {};
        for (const p of parts) {
          const [k, v] = p.split("=");
          if (k && v) map[k.trim()] = v.trim();
        }
        const t = map["t"];
        const v1 = map["v1"];
        if (!t || !v1) throw new Error("Missing t or v1 in signature header");
        const payload = `${t}.${rawBody}`;
        const hmac = crypto
          .createHmac("sha256", secret)
          .update(payload)
          .digest("hex");
        if (hmac !== v1) throw new Error("Invalid signature");
        return JSON.parse(rawBody);
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
  };
}

function resolveTestCard(id: string): {
  brand: string;
  country: string;
  exp_month: number;
  exp_year: number;
  last4: string;
} | null {
  const expMonth = 12;
  const expYear = new Date().getFullYear() + 2;
  if (id === "pm_card_visa") {
    return {
      brand: "visa",
      country: "US",
      exp_month: expMonth,
      exp_year: expYear,
      last4: "4242",
    };
  }
  if (id === "pm_card_visa_chargeDeclined") {
    return {
      brand: "visa",
      country: "US",
      exp_month: expMonth,
      exp_year: expYear,
      last4: "0002",
    };
  }
  if (id === "pm_card_chargeCustomerFail") {
    return {
      brand: "visa",
      country: "US",
      exp_month: expMonth,
      exp_year: expYear,
      last4: "0341",
    };
  }
  if (id.startsWith("pm_card_")) {
    return {
      brand: "visa",
      country: "US",
      exp_month: expMonth,
      exp_year: expYear,
      last4: "4242",
    };
  }
  return null;
}

mock.module("stripe", () => {
  return {
    default: MockStripe,
  };
});
