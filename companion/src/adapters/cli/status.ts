// `t3-voice status`: prints the T3 server, its projects and the threads agents work on.

import { ShellState } from "../../core/shellState.ts";
import { ConfigError, type ConfigStore } from "../../ports/configStore.ts";
import type { ServerInfo, T3Backend, T3Connector, Thread } from "../../ports/t3Backend.ts";

const SNAPSHOT_TIMEOUT_MS = 15_000;

export interface StatusOptions {
  store: ConfigStore;
  t3: T3Connector;
  out(line: string): void;
  now?: Date;
}

export async function runStatus({ store, t3, out, now = new Date() }: StatusOptions) {
  const config = await store.loadConfig();
  const pairing = await store.loadT3Pairing();
  if (!config || !pairing) {
    throw new ConfigError('The companion is not set up yet; run "t3-voice setup".');
  }

  const { baseUrl, acceptedServerVersions } = config.t3;
  if (pairing.baseUrl !== baseUrl) {
    // Setup writes the URL and the token in two files, so they disagree if one write failed.
    throw new ConfigError(
      `The saved T3 token is for ${pairing.baseUrl}, not ${baseUrl}; run "t3-voice setup" again.`,
    );
  }
  const backend = await t3.connect(baseUrl, pairing.token, acceptedServerVersions);
  try {
    const state = await readShell(backend);
    const report = formatStatus({
      baseUrl,
      server: backend.serverInfo(),
      tokenExpiresAt: pairing.expiresAt,
      state,
      now,
    });
    for (const line of report) out(line);
  } finally {
    backend.close();
  }
}

/** Subscribes until the first snapshot arrives, then stops. */
function readShell(backend: T3Backend): Promise<ShellState> {
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
  server: ServerInfo;
  tokenExpiresAt: string | null;
  state: ShellState;
  now: Date;
}

export function formatStatus({
  baseUrl,
  server,
  tokenExpiresAt,
  state,
  now,
}: StatusReport): string[] {
  const lines: string[] = [];
  const version = `T3 ${server.version}, protocol ${server.protocolVersion}`;
  lines.push(`${version} at ${baseUrl}: connected.`);
  lines.push(`T3 token expires ${describeExpiry(tokenExpiresAt, now)}.`);

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
  const request = thread.pendingRequest;
  const runStatus = thread.activeRunStatus ?? thread.status;
  if (request?.kind === "user_input" && !request.blocking) return `${runStatus}, question pending`;
  if (request?.kind === "user_input") return "waiting for your answer";
  if (request) return `waiting for approval (${request.kind})`;
  return runStatus;
}

function describeExpiry(expiresAt: string | null, now: Date): string {
  if (expiresAt === null) return "at an unknown date";
  const remainingMs = Date.parse(expiresAt) - now.getTime();
  if (Number.isNaN(remainingMs)) return "at an unknown date";
  const date = expiresAt.slice(0, 10);
  if (remainingMs <= 0) return `on ${date} (expired; run "t3-voice setup")`;
  const days = Math.floor(remainingMs / 86_400_000);
  if (days === 0) return `on ${date} (in less than a day; run "t3-voice setup" soon)`;
  return `on ${date} (in ${days} day${days === 1 ? "" : "s"})`;
}
