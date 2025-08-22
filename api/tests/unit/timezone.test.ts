import { describe, it, expect } from "bun:test";
import {
  convertToTimezoneFromUTC,
  convertToUTCFromServerTz,
  formatDateInTimezone,
  isSameOrBefore,
  isSameDay,
  getCurrentDateInTimezone,
} from "../../src/helpers/utils";

describe("Timezone Helper Functions", () => {
  // Reference date: January 15, 2023, 10:30:00 UTC
  const referenceDate = new Date("2023-01-15T10:30:00Z");

  describe("convertToTimezone", () => {
    it("should convert UTC date to New York time", () => {
      const nyDate = convertToTimezoneFromUTC(
        referenceDate,
        "America/New_York"
      );

      // In January, New York is UTC-5, so 10:30 UTC = 05:30 EST
      expect(nyDate.getHours()).toBe(5);
      expect(nyDate.getMinutes()).toBe(30);
      expect(nyDate.getDate()).toBe(15); // Same day
    });

    it("should convert UTC date to Tokyo time", () => {
      const tokyoDate = convertToTimezoneFromUTC(referenceDate, "Asia/Tokyo");

      // Tokyo is UTC+9, so 10:30 UTC = 19:30 JST
      expect(tokyoDate.getHours()).toBe(19);
      expect(tokyoDate.getMinutes()).toBe(30);
      expect(tokyoDate.getDate()).toBe(15); // Same day
    });

    it("should handle date line crossing correctly", () => {
      // Create a date that will cross the date line for some timezones
      const lateUTCDate = new Date("2023-01-15T23:30:00Z");
      const tokyoDate = convertToTimezoneFromUTC(lateUTCDate, "Asia/Tokyo");

      // Tokyo is UTC+9, so 23:30 UTC = 08:30 JST next day
      expect(tokyoDate.getHours()).toBe(8);
      expect(tokyoDate.getMinutes()).toBe(30);
      expect(tokyoDate.getDate()).toBe(16); // Next day in Tokyo
    });
  });

  describe("convertToUTC", () => {
    it("should convert New York time to UTC", () => {
      // Create a specific date in New York timezone: Jan 15, 2023, 05:30 AM EST
      const nyDate = new Date("2023-01-15T05:30:00-05:00");

      // When we pass this to convertToUTC, it should recognize the time as being in NY timezone
      // and convert to the equivalent UTC time (10:30 UTC)
      const utcDate = convertToUTCFromServerTz(nyDate);

      // Check the UTC hours and minutes directly
      expect(utcDate.getUTCHours()).toBe(10);
      expect(utcDate.getUTCMinutes()).toBe(30);
      expect(utcDate.getUTCDate()).toBe(15);
    });

    it("should convert Tokyo time to UTC", () => {
      // Create a specific date in Tokyo timezone: Jan 15, 2023, 19:30 JST
      const tokyoDate = new Date("2023-01-15T19:30:00+09:00");

      // When we pass this to convertToUTC, it should recognize the time as being in Tokyo timezone
      // and convert to the equivalent UTC time (10:30 UTC)
      const utcDate = convertToUTCFromServerTz(tokyoDate);

      // Check the UTC hours and minutes directly
      expect(utcDate.getUTCHours()).toBe(10);
      expect(utcDate.getUTCMinutes()).toBe(30);
      expect(utcDate.getUTCDate()).toBe(15);
    });
  });

  describe("formatDateInTimezone", () => {
    it("should format dates according to timezone", () => {
      // Late on January 15 in UTC, but will be January 16 in Tokyo
      const lateDate = new Date("2023-01-15T23:30:00Z");

      const utcFormatted = formatDateInTimezone(lateDate, "UTC");
      const nyFormatted = formatDateInTimezone(lateDate, "America/New_York");
      const tokyoFormatted = formatDateInTimezone(lateDate, "Asia/Tokyo");

      // The exact format might differ depending on the environment, so we check for the date
      expect(utcFormatted).toContain("January 15");
      expect(utcFormatted).toContain("2023");

      expect(nyFormatted).toContain("January 15"); // Still Jan 15 in NY
      expect(nyFormatted).toContain("2023");

      expect(tokyoFormatted).toContain("January 16"); // Jan 16 in Tokyo
      expect(tokyoFormatted).toContain("2023");
    });

    it("should respect format options", () => {
      const formatOptions: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      };

      const formatted = formatDateInTimezone(
        referenceDate,
        "America/New_York",
        formatOptions
      );

      // Should include date and time in the formatted output
      expect(formatted).toContain("Jan");
      expect(formatted).toContain("15");
      expect(formatted).toContain("2023");
      expect(formatted).toContain("5:30"); // 5:30 AM in New York time
    });
  });

  describe("isSameOrBefore", () => {
    it("should compare dates correctly in the same timezone", () => {
      const date1 = new Date("2023-01-15T10:30:00Z");
      const date2 = new Date("2023-01-15T12:30:00Z");

      expect(isSameOrBefore(date1, date2, "UTC")).toBe(true);
      expect(isSameOrBefore(date2, date1, "UTC")).toBe(false);
    });

    it("should handle timezone differences correctly", () => {
      // 23:30 UTC on Jan 15 is 08:30 JST on Jan 16
      const dateUTC = new Date("2023-01-15T23:30:00Z");
      // 01:30 UTC on Jan 16 is 10:30 JST on Jan 16
      const dateUTC2 = new Date("2023-01-16T01:30:00Z");

      // In UTC, dateUTC is before dateUTC2
      expect(isSameOrBefore(dateUTC, dateUTC2, "UTC")).toBe(true);

      // But when compared in Tokyo's timezone, they might both be on Jan 16,
      // but dateUTC (08:30 JST) is still before dateUTC2 (10:30 JST)
      expect(isSameOrBefore(dateUTC, dateUTC2, "Asia/Tokyo")).toBe(true);
    });
  });

  describe("isSameDay", () => {
    it("should determine same day correctly in the same timezone", () => {
      const date1 = new Date("2023-01-15T10:30:00Z");
      const date2 = new Date("2023-01-15T12:30:00Z");
      const date3 = new Date("2023-01-16T10:30:00Z");

      expect(isSameDay(date1, date2, "UTC")).toBe(true);
      expect(isSameDay(date1, date3, "UTC")).toBe(false);
    });

    it("should handle timezone differences when comparing days", () => {
      // 23:30 UTC on Jan 15 is 08:30 JST on Jan 16
      const dateUTC = new Date("2023-01-15T23:30:00Z");
      // 01:30 UTC on Jan 16 is 10:30 JST on Jan 16
      const dateUTC2 = new Date("2023-01-16T01:30:00Z");

      // In UTC, these dates are on different days
      expect(isSameDay(dateUTC, dateUTC2, "UTC")).toBe(false);

      // But in Tokyo's timezone, both are on Jan 16
      expect(isSameDay(dateUTC, dateUTC2, "Asia/Tokyo")).toBe(true);
    });
  });

  describe("getCurrentDateInTimezone", () => {
    it("should return dates with different hours but same minutes across timezones", () => {
      // Simple check to verify function returns timezone-adjusted times
      const utcDate = getCurrentDateInTimezone("UTC");
      const nyDate = getCurrentDateInTimezone("America/New_York");
      const tokyoDate = getCurrentDateInTimezone("Asia/Tokyo");

      // Verify we got valid dates back
      expect(utcDate instanceof Date).toBe(true);
      expect(nyDate instanceof Date).toBe(true);
      expect(tokyoDate instanceof Date).toBe(true);

      // The minutes should be very close (within 1-2 minutes) across timezones
      // due to test execution time
      const minuteDiff1 = Math.abs(utcDate.getMinutes() - nyDate.getMinutes());
      const minuteDiff2 = Math.abs(
        utcDate.getMinutes() - tokyoDate.getMinutes()
      );

      // Allow a bit of leeway for test execution time
      expect(minuteDiff1 <= 2 || minuteDiff1 >= 58).toBe(true);
      expect(minuteDiff2 <= 2 || minuteDiff2 >= 58).toBe(true);

      // Lastly, we can verify the function's implementation by checking
      // that we get current time in the timezone
      const now = new Date();
      const manualConversion = convertToTimezoneFromUTC(
        now,
        "America/New_York"
      );
      const functionResult = getCurrentDateInTimezone("America/New_York");

      // These should be very close except for test execution time
      const diffInMillis = Math.abs(
        manualConversion.getTime() - functionResult.getTime()
      );
      expect(diffInMillis).toBeLessThan(2000); // Less than 2 seconds difference
    });
  });
});
