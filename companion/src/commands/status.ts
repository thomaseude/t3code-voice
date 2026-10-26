// `t3-voice status`: prints the T3 server, its projects and the threads agents work on.

import type { Thread } from "../t3/backend.ts";
import type { EnvironmentDescriptor } from "../t3/compatibility.ts";
import { ShellState } from "../t3/shellState.ts";
import type { WebSocketT3Backend } from "../t3/webSocketBackend.ts";
import { connectBackend, loadSavedSetup } from "./connect.ts";

const SNAPSHOT_TIMEOUT_MS = 15_000;

export interface StatusOptions {
  dir: string;
  out(line: string): void;
  now?: Date;
}

export async function runStatus({ dir, out, now = new Date() }: StatusOptions): Promise<void> {
  const setup = await loadSavedSetup(dir);
  const backend = await connectBackend(setup);
  try {
    const state = await readShell(backend);
    const report = formatStatus({
      baseUrl: setup.config.t3.baseUrl,
      descriptor: backend.descriptor,
      tokenExpiresAt: setup.session.expiresAt,
      state,
      now,
    });
    for (const line of report) out(line);
  } finally {
    backend.close();
  }
}

/** Subscribes until the first snapshot arrives, then stops. */
function readShell(backend: WebSocketT3Backend): Promise<ShellState> {
  const state = new ShellState();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.close();
      reject(new Error("T3 did not send the project list in time."));
    }, SNAPSHOT_TIMEOUT_MS);
    const subscription = backend.subscribeShell({
      onEvent(event) {
        state.apply(event);
        if (!state.hasSnapshot) return;
        clearTimeout(timer);
        subscription.close();
        resolve(state);
      },
      onFatalError(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

export interface StatusReport {
  baseUrl: string;
  descriptor: EnvironmentDescriptor | null;
  tokenExpiresAt: string;
  state: ShellState;
  now: Date;
}

export function formatStatus({
  baseUrl,
  descriptor,
  tokenExpiresAt,
  state,
  now,
}: StatusReport): string[] {
  const lines: string[] = [];
  const version = descriptor
    ? `T3 ${descriptor.serverVersion}, protocol ${descriptor.orchestrationProtocolVersion}`
    : "T3";
  lines.push(`${version} at ${baseUrl}: connected.`);
  lines.push(`T3 session expires ${describeExpiry(tokenExpiresAt, now)}.`);

  const projects = [...state.projects.values()].sort((a, b) => a.title.localeCompare(b.title));
  lines.push("", `Projects (${projects.length}):`);
  if (projects.length === 0) lines.push("  (none)");
  for (const project of projects) lines.push(`  - ${project.title}  ${project.workspaceRoot}`);

  const running = state.runningThreads();
  lines.push("", `Running threads (${running.length}):`);
  if (running.length === 0) lines.push("  (none)");
  for (const thread of running) {
    const project = state.projects.get(thread.projectId)?.title ?? "unknown project";
    const agent = [thread.providerInstanceId, thread.model].filter(Boolean).join(" / ");
    lines.push(
      `  - ${thread.title || "(untitled)"}  [${project}]  ${describeState(thread)}  (${agent})`,
    );
  }
  return lines;
}

function describeState(thread: Thread): string {
  if (thread.pendingRequest?.kind === "user_input") return "waiting for your answer";
  if (thread.pendingRequest) return `waiting for approval (${thread.pendingRequest.kind})`;
  return thread.activeRunStatus ?? thread.status;
}

function describeExpiry(expiresAt: string, now: Date): string {
  const days = Math.floor((Date.parse(expiresAt) - now.getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "at an unknown date";
  if (days < 0) return `on ${expiresAt.slice(0, 10)} (expired; run "t3-voice setup")`;
  return `on ${expiresAt.slice(0, 10)} (in ${days} day${days === 1 ? "" : "s"})`;
}
