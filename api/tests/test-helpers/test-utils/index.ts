export * from "./setup";

export async function retryWithSleep<T>({
  fn,
  validate = (result) => result !== undefined && result !== null,
  maxAttempts = 3,
  sleepMs = 3000,
}: {
  fn: () => Promise<T>;
  validate: (val: T) => boolean;
  maxAttempts?: number;
  sleepMs?: number;
}): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (validate(result)) return result;
      lastError = new Error("Validation failed on result");
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, sleepMs));
  }
  throw lastError;
}

/**
 * Checks if two dates are within an acceptable time margin.
 * Useful for testing time-sensitive operations where exact matches are unreliable.
 *
 * @param actual - The actual date to compare
 * @param expected - The expected date to compare against
 * @param marginSeconds - The acceptable margin in seconds (default: 60)
 * @returns true if the dates are within the acceptable margin
 */
export function expectDateWithinMargin(
  actual: Date | null | undefined,
  expected: Date | null | undefined,
  marginSeconds: number = 60
): void {
  if (actual === null && expected === null) return;
  if (actual === undefined && expected === undefined) return;

  if (!actual || !expected) {
    throw new Error(
      `Date comparison failed: actual=${actual}, expected=${expected}`
    );
  }

  const actualTime = actual.getTime();
  const expectedTime = expected.getTime();
  const marginMs = marginSeconds * 1000;
  const diff = Math.abs(actualTime - expectedTime);

  if (diff > marginMs) {
    throw new Error(
      `Date difference exceeded margin: ${diff}ms > ${marginMs}ms ` +
        `(actual: ${actual.toISOString()}, expected: ${expected.toISOString()})`
    );
  }
}
