import { describe, it, expect } from "bun:test";
import { isDateMatching } from "../../src/helpers/billing";

describe("isDateMatching", () => {
  it("should match dates on the same day", () => {
    const nowDate = new Date("2024-03-15T10:00:00Z");
    const nextBillingDate = new Date("2024-03-15T15:00:00Z");

    expect(isDateMatching(nowDate, nextBillingDate)).toBe(true);
  });

  it("should not match dates on different days", () => {
    const nowDate = new Date("2024-03-15T10:00:00Z");
    const nextBillingDate = new Date("2024-03-16T10:00:00Z");

    expect(isDateMatching(nowDate, nextBillingDate)).toBe(false);
  });

  it("should handle different timezones correctly", () => {
    const nowDate = new Date("2024-03-15T23:00:00Z");
    const nextBillingDate = new Date("2024-03-16T00:00:00+01:00");

    expect(isDateMatching(nowDate, nextBillingDate)).toBe(true);
  });

  it("should not match dates in different months", () => {
    const nowDate = new Date("2024-03-15T10:00:00Z");
    const nextBillingDate = new Date("2024-04-15T10:00:00Z");

    expect(isDateMatching(nowDate, nextBillingDate)).toBe(false);
  });

  it("should not match dates in different years", () => {
    const nowDate = new Date("2024-03-15T10:00:00Z");
    const nextBillingDate = new Date("2025-03-15T10:00:00Z");

    expect(isDateMatching(nowDate, nextBillingDate)).toBe(false);
  });
});
