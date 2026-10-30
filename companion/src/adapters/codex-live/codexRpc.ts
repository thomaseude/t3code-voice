// A JSON-RPC connection to one `codex app-server`, and the start every user of it goes
// through: initialize, then check that Codex is a pinned version (fail closed, #56).

import type { Clock } from "../../ports/clock.ts";
import { codexVersionOf, findCodexIncompatibility } from "./compatibility.ts";

// biome-ignore lint/suspicious/noExplicitAny: Codex's JSON, checked field by field.
export type WireJson = any;

/** A JSON-RPC connection to one `codex app-server` process. */
export interface CodexRpc {
  /** Rejects with a CodexRpcError when Codex answers an error. No message holds Codex text: it is logged. */
  request(method: string, params: WireJson): Promise<WireJson>;
  /** A notification to Codex, which answers nothing. */
  notify(method: string, params?: WireJson): void;
  onNotification(listener: (method: string, params: WireJson) => void): void;
  /** A request Codex sends to the client. `reply` must be called once. */
  onRequest(
    listener: (method: string, params: WireJson, reply: (result: WireJson) => void) => void,
  ): void;
  onExit(listener: () => void): void;
  close(): void;
}

/**
 * Codex answered a request with an error. Only its code is kept: Codex's text may quote the
 * request, our prompt included, and the message is logged.
 */
export class CodexRpcError extends Error {
  constructor(code: unknown) {
    super(`codex answered error ${typeof code === "number" ? code : "with no code"}`);
    this.name = "CodexRpcError";
  }
}

export interface CodexAppServerOptions {
  /** Spawns a fresh `codex app-server`. Throws when it cannot. */
  startAppServer(): CodexRpc;
  clock: Clock;
  /** The Codex versions the adapter was tested with. Never a range. */
  acceptedVersions: string[];
}

/** Codex answers a request within this time, or the app-server is not used. */
export const ANSWER_TIMEOUT_MS = 10_000;

/**
 * Starts an app-server and initializes it. Throws, with the app-server stopped, when it
 * cannot start, does not answer, or is not a pinned Codex version.
 */
export async function startPinnedCodex(options: CodexAppServerOptions): Promise<CodexRpc> {
  const rpc = options.startAppServer();
  try {
    const initialized = await withTimeout(
      options.clock,
      ANSWER_TIMEOUT_MS,
      rpc.request("initialize", {
        clientInfo: { name: "t3-voice", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      "the codex app-server did not answer in time",
    );
    const version = codexVersionOf(initialized?.userAgent);
    const problem = findCodexIncompatibility(version, options.acceptedVersions);
    if (problem !== null) throw new Error(problem);
    rpc.notify("initialized");
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
  }
}

/** Rejects with `message` when `promise` takes longer than `timeoutMs`. */
export async function withTimeout<T>(
  clock: Clock,
  timeoutMs: number,
  promise: Promise<T>,
  message: string,
) {
  let cancel = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    cancel = clock.schedule(timeoutMs, () => reject(new Error(message)));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    cancel();
  }
}
