// PlanQuota adapter: reads the ChatGPT plan's quota with `account/rateLimits/read`, on a
// short-lived `codex app-server` (#56).

import { type PlanQuota, PlanQuotaError, type PlanQuotaReading } from "../../ports/planQuota.ts";
import {
  ANSWER_TIMEOUT_MS,
  type CodexAppServerOptions,
  type CodexRpc,
  CodexRpcError,
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
        ANSWER_TIMEOUT_MS,
        rpc.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
        "codex did not return the quota in time",
      );
      return readingOf(limits);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Codex starts without a login, then refuses the read with a code only.
      const hint = error instanceof CodexRpcError ? "; is `codex login` done for this user?" : "";
      throw new PlanQuotaError(`Codex cannot read the plan's quota: ${message}${hint}`);
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
    // Codex says null means "unknown": only an explicit true lets voice draw from the plan.
    limitReached:
      limits?.ordinaryUsageAllowed !== true || (reachedType !== null && reachedType !== undefined),
  };
}

function percentLeft(window: WireJson): number | null {
  if (typeof window?.usedPercent !== "number") return null;
  return Math.min(100, Math.max(0, 100 - window.usedPercent));
}
