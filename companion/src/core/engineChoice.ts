// Which engine a voice session opens on (#56). The plan engine draws from the ChatGPT plan's
// quota, which the coding agents share: voice must leave them enough of it.

import type { PlanQuotaReading } from "../ports/planQuota.ts";

/** Why the plan engine must not be used, or null when it may. */
export function planQuotaRefusal(reading: PlanQuotaReading, minPercentLeft: number): string | null {
  if (reading.limitReached) return "the plan says a limit is reached";
  const { fiveHourPercentLeft, weekPercentLeft } = reading;
  // Without both limits, the lower one is unknown.
  if (fiveHourPercentLeft === null || weekPercentLeft === null) {
    return "the plan does not report both of its limits";
  }
  const left = Math.min(fiveHourPercentLeft, weekPercentLeft);
  if (left < minPercentLeft) {
    return `${left} % of the plan's quota is left, under ${minPercentLeft} %`;
  }
  return null;
}
