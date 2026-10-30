// PlanQuota adapter: reads the ChatGPT plan's quota with `account/rateLimits/read`, on a
// short-lived `codex app-server` (#56).

import { type PlanQuota, PlanQuotaError, type PlanQuotaReading } from "../../ports/planQuota.ts";
import {
  type CodexAppServerOptions,
  type CodexRpc,
  startPinnedCodex,
  type WireJson,
  withTimeout,
} from "./codexRpc.ts";

export class CodexPlanQuota implements PlanQuota {
  private readonly options: CodexAppServerOptions;

  constructor(options: CodexAppServerOptions) {
    this.options = options;
  }

  async read(): Promise<PlanQuotaReading> {
    let rpc: CodexRpc | null = null;
    try {
      rpc = await startPinnedCodex(this.options);
      const limits = await withTimeout(
        this.options.clock,
        rpc.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
        "codex did not return the quota in time",
      );
      return readingOf(limits);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PlanQuotaError(`Codex cannot read the plan's quota: ${message}`);
    } finally {
      rpc?.close();
    }
  }
}

function readingOf(limits: WireJson): PlanQuotaReading {
  // The `codex` bucket is the one voice and the coding agents draw from.
  const snapshot = limits?.rateLimitsByLimitId?.codex ?? limits?.rateLimits;
  const reachedType = snapshot?.rateLimitReachedType;
  return {
    // Codex sends the 5-hour window as `primary` and the week as `secondary`.
    fiveHourPercentLeft: percentLeft(snapshot?.primary),
    weekPercentLeft: percentLeft(snapshot?.secondary),
    limitReached:
      limits?.ordinaryUsageAllowed === false || (reachedType !== null && reachedType !== undefined),
  };
}

function percentLeft(window: WireJson): number | null {
  if (typeof window?.usedPercent !== "number") return null;
  return Math.min(100, Math.max(0, 100 - window.usedPercent));
}
