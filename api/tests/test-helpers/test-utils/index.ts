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
