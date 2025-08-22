import { describe, it, expect } from "bun:test";
import { sendEvent } from "../../src/index"; // Adjust path relative to tests directory

const API_URL = "localhost:8000"; // local
// const API_URL = "https://api-staging.getlumen.dev"; // staging

describe("sendEvent basic call", () => {
  it("should send an event with userId and return a 202 status", async () => {
    const params = {
      name: "simpleTestEvent",
      value: 1,
      userId: "user_id_1234567890",
      apiUrl: API_URL,
    };

    const response = await sendEvent(params);

    expect(response?.status).toBe(202);
  });
  it("should send an event with lumenCustomerId and return a 202 status", async () => {
    const params = {
      name: "simpleTestEvent",
      value: 2,
      lumenCustomerId: "lumen_customer_id_1234567890",
      apiUrl: API_URL,
    };

    const response = await sendEvent(params);

    expect(response?.status).toBe(202);
  });
  it("should send an event with userId and idempotencyKey and return a 202 status", async () => {
    const params = {
      name: "simpleTestEvent",
      value: 3,
      userId: "user_id_1234567890",
      idempotencyKey: `manual_idempotency_key_${Date.now()}`,
      apiUrl: API_URL,
    };

    const response = await sendEvent(params);

    expect(response?.status).toBe(202);
  });
  it("value is number", async () => {
    const params = {
      name: "simpleTestEvent",
      value: 420,
      userId: "user_id_1234567890",
      apiUrl: API_URL,
    };

    const response = await sendEvent(params);

    expect(response?.status).toBe(202);
  });
  it("value is string", async () => {
    const params = {
      name: "simpleTestEvent",
      value: "hello world!",
      userId: "user_id_1234567890",
      apiUrl: API_URL,
    };

    const response = await sendEvent(params);

    expect(response?.status).toBe(202);
  });
});
