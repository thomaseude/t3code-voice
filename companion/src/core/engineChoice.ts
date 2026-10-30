// Which engine a voice session opens on (#56). The plan engine draws from the ChatGPT plan's
// quota, which the coding agents share: voice must leave them enough of it.

import type { PlanQuotaReading } from "../ports/planQuota.ts";

/** Why the plan engine must not be used, or null when it may. */
export function planQuotaRefusal(reading: PlanQuotaReading, minPercentLeft: number): string | null {
  if (reading.limitReached) return "the plan says a limit is reached";
  const limits = [reading.fiveHourPercentLeft, reading.weekPercentLeft].filter(
    (percent) => percent !== null,
  );
  if (limits.length === 0) return "the plan reports no limit";
  // The limit that runs out first decides.
  const left = Math.min(...limits);
  if (left < minPercentLeft) {
    return `${left} % of the plan's quota is left, under ${minPercentLeft} %`;
  }
  return null;
}
