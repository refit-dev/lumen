import Stripe from "stripe";
import { setTimeout } from "timers/promises";

export const sleep = (
  ms: number,
  { alsoSleepInStripeMock = false }: { alsoSleepInStripeMock?: boolean } = {}
): Promise<void> => {
  // @ts-ignore
  if (Stripe.isMock) {
    if (alsoSleepInStripeMock) {
      setTimeout(ms);
    } else {
      return Promise.resolve();
    }
  }

  return setTimeout(ms);
};
