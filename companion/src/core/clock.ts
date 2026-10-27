// The real clock, for main.ts and the defaults.

import type { Clock } from "../ports/clock.ts";

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
