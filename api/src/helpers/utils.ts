import { db } from "../db/client";
import { customers, subscriptions } from "@lumen/common/schema";
import { merchants } from "@lumen/common/schema";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { datetime } from "rrule";

/**
 * Map the subscription object stableSubscriptionId and map it to id
 * @param subscription - The subscription object to map
 * @returns The mapped subscription object
 */
export const mapStableSubIdToId = (
  subscription: typeof subscriptions.$inferSelect
) => {
  const { id, stableSubscriptionId, ...rest } = subscription;
  return {
    ...rest,
    id: stableSubscriptionId,
  };
};
/**
 * Check if two dates match (same year, month, and day)
 * This is useful for checking if a subscription is due for billing
 *
 * @deprecated Use timezone-aware date comparison instead
 */
export const isDateMatching = (
  nowDate: Date,
  nextBillingDate: Date
): boolean => {
  const billingTimezone = nextBillingDate.getTimezoneOffset();
  const now = new Date(nowDate);
  now.setMinutes(now.getMinutes() + billingTimezone);

  return (
    now.getFullYear() === nextBillingDate.getFullYear() &&
    now.getMonth() === nextBillingDate.getMonth() &&
    now.getDate() === nextBillingDate.getDate()
  );
};

/**
 * Get the effective timezone to use for a customer based on the hierarchy:
 * 1. Customer timezone
 * 2. Merchant timezone
 * 3. UTC (default)
 *
 * @param customerId - The ID of the customer
 * @param merchantId - The ID of the merchant
 * @returns The timezone identifier to use (IANA timezone format)
 */
export async function getEffectiveTimezone(
  customerId: string,
  merchantId: string
): Promise<string> {
  // Get customer timezone
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
    columns: {
      timezone: true,
    },
  });

  if (customer?.timezone) {
    return customer.timezone;
  }

  // If no customer timezone, get merchant timezone
  const merchant = await db.query.merchants.findFirst({
    where: eq(merchants.id, merchantId),
    columns: {
      timezone: true,
    },
  });

  if (merchant?.timezone) {
    return merchant.timezone;
  }

  // Default to UTC
  return "UTC";
}

/**
 * Convert a date to a specific timezone's local time with timezone information stripped
 * This strictly for use in RRule which expects a date to be stripped of timezone information
 *
 * @param date - The date to convert in UTC
 * @param timezone - The timezone to convert to (IANA timezone format)
 * @returns A date object representing the date in the specified timezone
 */

export function convertToTimezoneFromUTC(date: Date, timezone: string): Date {
  // Use Luxon to convert the date to the specified timezone
  const dateTime = DateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone);

  // Use rrule's datetime helper to make sure DST doesn't change the time
  return datetime(
    dateTime.year,
    dateTime.month,
    dateTime.day,
    dateTime.hour,
    dateTime.minute,
    dateTime.second
  );
}

/**
 * Convert a date from server local TZ to UTC. This is used for RRule dates
 * that are returned in the server's local timezone but their TZ info is
 * stripped out (i.e., the offset is set to `Z` but it's not actually UTC, it's the
 * server's local timezone).
 *
 * @param date - The date with the offset set to `Z` but which is actually in the server's local timezone
 * @returns A date object representing the date in UTC
 */
export function convertToUTCFromServerTz(date: Date): Date {
  return DateTime.fromJSDate(date)
    .toUTC()
    .setZone("local", { keepLocalTime: true })
    .toJSDate();
}

/**
 * Format a date in a specific timezone
 *
 * @param date - The date to format
 * @param timezone - The timezone to use (IANA timezone format)
 * @param format - Optional format options
 * @returns Formatted date string in the specified timezone
 */
export function formatDateInTimezone(
  date: Date,
  timezone: string,
  format: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "long",
    day: "numeric",
  }
): string {
  return new Intl.DateTimeFormat("en-US", {
    ...format,
    timeZone: timezone,
  }).format(date);
}

/**
 * Compare two dates in a specific timezone to determine if one is same or before the other
 *
 * @param date1 - The first date
 * @param date2 - The second date
 * @param timezone - The timezone to use for comparison
 * @returns True if date1 is same or before date2 in the specified timezone
 */
export function isSameOrBefore(
  date1: Date,
  date2: Date,
  timezone: string
): boolean {
  // Convert both dates to the same timezone for comparison
  const date1InTz = convertToTimezoneFromUTC(date1, timezone);
  const date2InTz = convertToTimezoneFromUTC(date2, timezone);

  // Compare the dates
  return date1InTz <= date2InTz;
}

/**
 * Compare two dates in a specific timezone to determine if they are the same day
 *
 * @param date1 - The first date
 * @param date2 - The second date
 * @param timezone - The timezone to use for comparison
 * @returns True if both dates represent the same day in the specified timezone
 */
export function isSameDay(date1: Date, date2: Date, timezone: string): boolean {
  // Format both dates to YYYY-MM-DD in the specified timezone
  const format: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  };

  const date1Str = new Intl.DateTimeFormat("en-CA", format).format(date1);
  const date2Str = new Intl.DateTimeFormat("en-CA", format).format(date2);

  // Compare the date strings
  return date1Str === date2Str;
}

/**
 * Get the current date and time in a specific timezone
 *
 * @param timezone - The timezone to get the current time in (IANA timezone format)
 * @returns A date object representing the current time in the specified timezone
 */
export function getCurrentDateInTimezone(timezone: string): Date {
  const now = new Date();
  return convertToTimezoneFromUTC(now, timezone);
}

/**
 * Omit a key from an object and return the rest of the object
 *
 * @param obj - The object to omit the key from
 * @param key - The key to omit
 * @returns The object with the key omitted
 */
export function omitKeyNoTypeError<T, K extends keyof T>(
  obj: T,
  key: K
): Omit<T, K> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [key]: _, ...rest } = obj;
  return rest;
}
