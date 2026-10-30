// A fake `codex app-server`: it records what the adapter asks and answers like Codex 0.163.
// No test runs the real Codex: a voice session or a quota read draws on the user's plan.

import type { CodexRpc, WireJson } from "../../../../src/adapters/codex-live/codexRpc.ts";

export const THREAD = "thr_1";

/** The rate limits of a Plus plan, as `account/rateLimits/read` returns them. */
export function rateLimits({
  fiveHourUsed = 38,
  weekUsed = 25,
  reachedType = null as string | null,
  ordinaryUsageAllowed = true as boolean | null,
} = {}): WireJson {
  const snapshot = {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: fiveHourUsed, windowDurationMins: 300, resetsAt: 1_793_000_000 },
    secondary: { usedPercent: weekUsed, windowDurationMins: 10_080, resetsAt: 1_793_500_000 },
    credits: null,
    planType: "plus",
    rateLimitReachedType: reachedType,
  };
  return {
    ordinaryUsageAllowed,
    rateLimits: snapshot,
    rateLimitsByLimitId: { codex: snapshot },
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  };
}

export class FakeCodexRpc implements CodexRpc {
  readonly requests: Array<{ method: string; params: WireJson }> = [];
  readonly notifications: Array<{ method: string; params: WireJson }> = [];
  /** The Codex version `initialize` reports. */
  version = "0.163.0";
  /** While false, `initialize` never answers, like a stuck app-server. */
  answersInitialize = true;
  /** Whether `thread/realtime/start` is followed by Codex's SDP answer. */
  answersOffer = true;
  /** While set, `thread/realtime/start` fails with this error, like a refused offer. */
  realtimeStartError: Error | null = null;
  /** While false, `thread/start` and `thread/realtime/start` never answer, like a stuck Codex. */
  answersThread = true;
  /** While false, `thread/realtime/stop` never answers. */
  answersStop = true;
  /** What `account/rateLimits/read` answers (a promise that never settles: no answer), or an Error it fails with. */
  limits: WireJson | Error = rateLimits();
  closed = false;
  private notificationListeners: Array<(method: string, params: WireJson) => void> = [];
  private requestListeners: Array<
    (method: string, params: WireJson, reply: (result: WireJson) => void) => void
  > = [];
  private exitListeners: Array<() => void> = [];

  async request(method: string, params: WireJson): Promise<WireJson> {
    this.requests.push({ method, params });
    switch (method) {
      case "initialize":
        if (!this.answersInitialize) return new Promise(() => {});
        return {
          userAgent: `t3-voice/${this.version} (Ubuntu 22.4.0; x86_64) unknown (t3-voice; 0.1.0)`,
          codexHome: "/home/thomas/.codex",
          platformFamily: "unix",
          platformOs: "linux",
        };
      case "account/rateLimits/read":
        if (this.limits instanceof Error) throw this.limits;
        return await this.limits;
      case "thread/start":
        if (!this.answersThread) return new Promise(() => {});
        return { thread: { id: THREAD } };
      case "thread/realtime/stop":
        if (!this.answersStop) return new Promise(() => {});
        return {};
      case "thread/realtime/start":
        if (!this.answersThread) return new Promise(() => {});
        if (this.realtimeStartError !== null) throw this.realtimeStartError;
        if (this.answersOffer) {
          setImmediate(() =>
            this.notifyClient("thread/realtime/sdp", { threadId: THREAD, sdp: "v=0 answer" }),
          );
        }
        return {};
      default:
        return {};
    }
  }

  notify(method: string, params?: WireJson) {
    this.notifications.push({ method, params });
  }

  onNotification(listener: (method: string, params: WireJson) => void) {
    this.notificationListeners.push(listener);
  }
  onRequest(
    listener: (method: string, params: WireJson, reply: (result: WireJson) => void) => void,
  ) {
    this.requestListeners.push(listener);
  }
  onExit(listener: () => void) {
    this.exitListeners.push(listener);
  }
  /** Like the real child: a killed app-server exits, once. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.exit();
  }

  /** Sends a notification to the adapter, as Codex would. */
  notifyClient(method: string, params: WireJson) {
    for (const listener of this.notificationListeners) listener(method, params);
  }

  /** Sends a request to the adapter and returns what it replied, or undefined. */
  ask(method: string, params: WireJson): { reply: WireJson } {
    const answer: { reply: WireJson } = { reply: undefined };
    for (const listener of this.requestListeners) {
      listener(method, params, (result) => {
        answer.reply = result;
      });
    }
    return answer;
  }

  exit() {
    for (const listener of this.exitListeners) listener();
  }

  sent(method: string): WireJson[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}
