import { RRule, Options as RRuleOptions } from "rrule";
import { PriceComponentSchemaType } from "@lumen/common";
import {
  convertToTimezoneFromUTC as convertToTimezoneStrippedFromUTC,
  convertToUTCFromServerTz,
  isSameDay,
} from "./utils";

/**
 * Calculate the next billing date for a specific price component
 *
 * @param component The price component to calculate billing date for
 * @param currentTimestamp The timestamp to calculate from (usually current date or previous billing date)
 * @param subscriptionStartTimestamp The original subscription start timestamp
 * @param timezone The timezone to use for calculation
 * @returns The next billing date as a UTC Date
 */
export function calculateNextBillingDate(
  component: PriceComponentSchemaType,
  currentTimestamp: Date,
  subscriptionStartTimestamp: Date,
  timezone: string = "UTC"
): Date {
  const rruleStr = component.recurrence_rule;

  const currentTimestampInTzStripped = convertToTimezoneStrippedFromUTC(
    currentTimestamp,
    timezone
  );
  const subscriptionStartTimestampInTzStripped =
    convertToTimezoneStrippedFromUTC(subscriptionStartTimestamp, timezone);

  // Parse the RRULE string into options
  const options: Partial<RRuleOptions> = RRule.parseString(rruleStr);

  // Check if BYMONTHDAY is explicitly set and handle edge cases
  if (
    options.bymonthday &&
    Array.isArray(options.bymonthday) &&
    options.bymonthday.length === 1
  ) {
    const day = options.bymonthday[0];
    if ([29, 30, 31].includes(day)) {
      options.bymonthday = [day, -1];
      options.bysetpos = 1;
    }
  } else if (options.bymonthday && typeof options.bymonthday === "number") {
    // Handle the case where bymonthday is a single number
    const day = options.bymonthday;
    if ([29, 30, 31].includes(day)) {
      options.bymonthday = [day, -1];
      options.bysetpos = 1;
    }
  } else if (!options.bymonthday && options.freq === RRule.MONTHLY) {
    // Anniversary billing for MONTHLY frequency: derive the day from the original start timestamp
    const anniversaryDay = subscriptionStartTimestampInTzStripped.getDate();

    // Apply edge-case handling for anniversary days 29, 30, 31
    if ([29, 30, 31].includes(anniversaryDay)) {
      options.bymonthday = [anniversaryDay, -1];
      options.bysetpos = 1;
    } else {
      options.bymonthday = anniversaryDay;
    }
  }
  // NOTE: For YEARLY anniversary billing (or other frequencies without BYMONTHDAY),
  // we intentionally DO NOT set bymonthday. RRule handles this correctly based on dtstart and freq.

  // Finalize options for RRule constructor
  const finalOptions: RRuleOptions = {
    ...options,
    dtstart: currentTimestampInTzStripped,
    tzid: timezone,
    count: (options as RRuleOptions).count || 2,
  } as RRuleOptions;

  const rule = new RRule(finalOptions);
  const dates = rule.all().map((date) => convertToUTCFromServerTz(date));

  const nextDateUTC = isSameDay(dates[0], currentTimestamp, timezone)
    ? dates[1]
    : dates[0];

  return nextDateUTC;
}


