import { describe, it, beforeEach, expect } from "bun:test";
import { db } from "../../src/db/client";
import { internalKeyValues } from "@lumen/common/schema";
import { eq } from "drizzle-orm";
import {
  EMAIL_DENYLIST_DOMAINS_KEY,
  EMAIL_DENYLIST_ADDRESSES_KEY,
} from "@lumen/common/utils";
import { env } from "../../src/env";
import { hc } from "hono/client";
import type { AppType } from "../../src/routes";

describe("Email Denylist Management", () => {
  const TEST_INTERNAL_API_KEY =
    process.env.INTERNAL_API_KEY || "test-internal-key";

  function createInternalApiClient(apiKey: string = TEST_INTERNAL_API_KEY) {
    return hc<AppType>(env.API_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  beforeEach(async () => {
    await db
      .delete(internalKeyValues)
      .where(eq(internalKeyValues.key, EMAIL_DENYLIST_DOMAINS_KEY));
    await db
      .delete(internalKeyValues)
      .where(eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY));
  });

  describe("POST /denylist/check-email", () => {
    it("should check if an email is denylisted", async () => {
      await db.insert(internalKeyValues).values({
        key: EMAIL_DENYLIST_ADDRESSES_KEY,
        value: ["blocked@testing-domain.com"],
      });

      const client = createInternalApiClient();
      const response = await client.denylist["check-email"].$post({
        json: { email: "blocked@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.isDenylisted).toBe(true);
    });

    it("should return false for non-denylisted emails", async () => {
      const client = createInternalApiClient();
      const response = await client.denylist["check-email"].$post({
        json: { email: "allowed@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.isDenylisted).toBe(false);
    });

    it("should require internal API key", async () => {
      const client = createInternalApiClient("invalid-key");
      const response = await client.denylist["check-email"].$post({
        json: { email: "test@testing-domain.com" },
      });

      expect(response.status).toBe(401);
    });
  });

  describe("POST /denylist/add-email", () => {
    it("should add an email address to the denylist", async () => {
      const client = createInternalApiClient();
      const response = await client.denylist["add-email"].$post({
        json: { email: "spam@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.added).toBe(true);
      expect(data.message).toContain("Email added to denylist");

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      });
      expect(dbEntry).not.toBeNull();
      expect(dbEntry!.value).toEqual(["spam@testing-domain.com"]);
    });

    it("should add a domain to the denylist", async () => {
      const client = createInternalApiClient();
      const response = await client.denylist["add-email"].$post({
        json: { email: "spam-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.added).toBe(true);
      expect(data.message).toContain("Domain added to denylist");

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_DOMAINS_KEY),
      });
      expect(dbEntry).not.toBeNull();
      expect(dbEntry!.value).toEqual(["spam-domain.com"]);
    });

    it("should normalize emails to lowercase", async () => {
      const client = createInternalApiClient();
      const response = await client.denylist["add-email"].$post({
        json: { email: "SPAM@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.added).toBe(true);

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      });
      expect(dbEntry!.value).toEqual(["spam@testing-domain.com"]);
    });

    it("should not add duplicate emails", async () => {
      const client = createInternalApiClient();

      const firstResponse = await client.denylist["add-email"].$post({
        json: { email: "spam@testing-domain.com" },
      });
      expect(firstResponse.status).toBe(200);

      const secondResponse = await client.denylist["add-email"].$post({
        json: { email: "spam@testing-domain.com" },
      });
      expect(secondResponse.status).toBe(200);
      const data = await secondResponse.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.added).toBe(false);
      expect(data.message).toContain("already in denylist");

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      });
      expect(dbEntry!.value).toEqual(["spam@testing-domain.com"]);
    });

    it("should append to existing denylist", async () => {
      await db.insert(internalKeyValues).values({
        key: EMAIL_DENYLIST_ADDRESSES_KEY,
        value: ["existing@testing-domain.com"],
      });

      const client = createInternalApiClient();
      const response = await client.denylist["add-email"].$post({
        json: { email: "new@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.added).toBe(true);

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      });
      expect(dbEntry!.value).toContain("existing@testing-domain.com");
      expect(dbEntry!.value).toContain("new@testing-domain.com");
      expect((dbEntry!.value as string[]).length).toBe(2);
    });

    it("should require internal API key", async () => {
      const client = createInternalApiClient("invalid-key");
      const response = await client.denylist["add-email"].$post({
        json: { email: "spam@testing-domain.com" },
      });

      expect(response.status).toBe(401);
    });

    it("should handle multiple domains separately from emails", async () => {
      const client = createInternalApiClient();

      await client.denylist["add-email"].$post({
        json: { email: "spam@testing-domain.com" },
      });

      await client.denylist["add-email"].$post({
        json: { email: "spam-domain.com" },
      });

      const emailEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      });
      const domainEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_DOMAINS_KEY),
      });

      expect(emailEntry!.value).toEqual(["spam@testing-domain.com"]);
      expect(domainEntry!.value).toEqual(["spam-domain.com"]);
    });
  });

  describe("POST /denylist/remove-email", () => {
    it("should remove an email address from the denylist", async () => {
      await db.insert(internalKeyValues).values({
        key: EMAIL_DENYLIST_ADDRESSES_KEY,
        value: ["spam@testing-domain.com", "other@testing-domain.com"],
      });

      const client = createInternalApiClient();
      const response = await client.denylist["remove-email"].$post({
        json: { email: "spam@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.removed).toBe(true);
      expect(data.message).toContain("Email removed from denylist");

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      });
      expect(dbEntry!.value).toEqual(["other@testing-domain.com"]);
    });

    it("should remove a domain from the denylist", async () => {
      await db.insert(internalKeyValues).values({
        key: EMAIL_DENYLIST_DOMAINS_KEY,
        value: ["spam-domain.com", "other-domain.com"],
      });

      const client = createInternalApiClient();
      const response = await client.denylist["remove-email"].$post({
        json: { email: "spam-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.removed).toBe(true);
      expect(data.message).toContain("Domain removed from denylist");

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_DOMAINS_KEY),
      });
      expect(dbEntry!.value).toEqual(["other-domain.com"]);
    });

    it("should normalize emails to lowercase when removing", async () => {
      await db.insert(internalKeyValues).values({
        key: EMAIL_DENYLIST_ADDRESSES_KEY,
        value: ["spam@testing-domain.com"],
      });

      const client = createInternalApiClient();
      const response = await client.denylist["remove-email"].$post({
        json: { email: "SPAM@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.removed).toBe(true);

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      });
      expect(dbEntry!.value).toEqual([]);
    });

    it("should return false when email not in denylist", async () => {
      await db.insert(internalKeyValues).values({
        key: EMAIL_DENYLIST_ADDRESSES_KEY,
        value: ["other@testing-domain.com"],
      });

      const client = createInternalApiClient();
      const response = await client.denylist["remove-email"].$post({
        json: { email: "notfound@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.removed).toBe(false);
      expect(data.message).toContain("not found in denylist");
    });

    it("should return false when denylist does not exist", async () => {
      const client = createInternalApiClient();
      const response = await client.denylist["remove-email"].$post({
        json: { email: "test@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.removed).toBe(false);
      expect(data.message).toContain("not found in denylist");
    });

    it("should require internal API key", async () => {
      const client = createInternalApiClient("invalid-key");
      const response = await client.denylist["remove-email"].$post({
        json: { email: "spam@testing-domain.com" },
      });

      expect(response.status).toBe(401);
    });

    it("should handle removing from empty list correctly", async () => {
      await db.insert(internalKeyValues).values({
        key: EMAIL_DENYLIST_ADDRESSES_KEY,
        value: ["spam@testing-domain.com"],
      });

      const client = createInternalApiClient();

      const response = await client.denylist["remove-email"].$post({
        json: { email: "spam@testing-domain.com" },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.removed).toBe(true);

      const dbEntry = await db.query.internalKeyValues.findFirst({
        where: eq(internalKeyValues.key, EMAIL_DENYLIST_ADDRESSES_KEY),
      });
      expect(dbEntry!.value).toEqual([]);
    });
  });

  describe("Integration with check-email", () => {
    it("should be able to add and then check an email", async () => {
      const client = createInternalApiClient();

      await client.denylist["add-email"].$post({
        json: { email: "blocked@test.com" },
      });

      const checkResponse = await client.denylist["check-email"].$post({
        json: { email: "blocked@test.com" },
      });

      expect(checkResponse.status).toBe(200);
      const data = await checkResponse.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.isDenylisted).toBe(true);
    });

    it("should be able to add, remove, and then check an email", async () => {
      const client = createInternalApiClient();

      await client.denylist["add-email"].$post({
        json: { email: "blocked@test.com" },
      });

      await client.denylist["remove-email"].$post({
        json: { email: "blocked@test.com" },
      });

      const checkResponse = await client.denylist["check-email"].$post({
        json: { email: "blocked@test.com" },
      });

      expect(checkResponse.status).toBe(200);
      const data = await checkResponse.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.isDenylisted).toBe(false);
    });

    it("should check domain blocking after adding domain", async () => {
      const client = createInternalApiClient();

      await client.denylist["add-email"].$post({
        json: { email: "spam-domain.com" },
      });

      const checkResponse = await client.denylist["check-email"].$post({
        json: { email: "user@spam-domain.com" },
      });

      expect(checkResponse.status).toBe(200);
      const data = await checkResponse.json();
      if ("error" in data) {
        throw new Error(`Unexpected error: ${data.error}`);
      }
      expect(data.isDenylisted).toBe(true);
    });
  });

  describe("Hardcoded denylist domains @getlumen.dev, @example.com", () => {
    it("should denylist emails from hardcoded domains even without database entries", async () => {
      const client = createInternalApiClient();

      const testEmails = [
        "admin@getlumen.dev",
        "support@example.com",
        "TEST@GETLUMEN.DEV",
        "User@Example.Com",
      ];

      for (const email of testEmails) {
        const checkResponse = await client.denylist["check-email"].$post({
          json: { email },
        });

        expect(checkResponse.status).toBe(200);
        const data = await checkResponse.json();
        if ("error" in data) {
          throw new Error(`Unexpected error for ${email}: ${data.error}`);
        }
        expect(data.isDenylisted).toBe(true);
      }
    });
  });
});
