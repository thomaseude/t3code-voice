// The real clock, used wherever a test does not inject a fake one.

import type { Clock } from "../ports/clock.ts";

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
