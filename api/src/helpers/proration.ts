import { differenceInCalendarDays } from "date-fns";

/**
 * Calculates a prorated amount for the remainder of a billing period.
 *
 * amountCents  – full-period price in cents for one unit
 * periodStart  – start of the current billing period
 * periodEnd    – end of the current billing period
 * prorationStart – when the usage starts inside the period (usually now)
 */
export function prorateAmountCents(
  amountCents: number,
  periodStart: Date,
  periodEnd: Date,
  prorationStart: Date
): number {
  if (amountCents <= 0) return 0;

  const totalDays = Math.max(
    1,
    differenceInCalendarDays(periodEnd, periodStart)
  );
  const remainingDays = Math.max(
    0,
    differenceInCalendarDays(periodEnd, prorationStart)
  );

  return Math.round((amountCents * remainingDays) / totalDays);
}
