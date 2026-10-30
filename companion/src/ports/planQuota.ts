// The quota of the ChatGPT plan that the Codex voice engine draws from (#56). The coding
// agents share it, so voice must leave them enough: the core picks the API engine when
// too little is left.

/** What is left of the plan's quota, in whole percents (0 to 100). */
export interface PlanQuotaReading {
  /** Left in the 5-hour window, or null when the plan reports no such window. */
  fiveHourPercentLeft: number | null;
  /** Left in the weekly window, or null when the plan reports no such window. */
  weekPercentLeft: number | null;
  /** The plan says a limit is reached: no session may draw from it now. */
  limitReached: boolean;
}

export interface PlanQuota {
  /** Throws PlanQuotaError when the quota cannot be read. */
  read(): Promise<PlanQuotaReading>;
}

/** The quota could not be read. The message holds no secret. */
export class PlanQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanQuotaError";
  }
}
