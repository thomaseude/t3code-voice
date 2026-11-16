// `t3-voice serve`: runs the HTTP API the iPhone calls, until the process is asked to stop
// or T3 fails for good.

import { randomUUID } from "node:crypto";
import { activityOf } from "../../core/activity.ts";
import { AnnouncementQueue } from "../../core/announcementQueue.ts";
import { TaskWatcher } from "../../core/announcements.ts";
import { systemClock } from "../../core/clock.ts";
import { ShellState } from "../../core/shellState.ts";
import { TaskSummaries } from "../../core/taskSummaries.ts";
import { VoiceSessionManager } from "../../core/voiceSessions.ts";
import { VoiceTasks } from "../../core/voiceTasks.ts";
import type { ApiServerOptions, RunningApiServer } from "../../ports/apiServer.ts";
import type { Clock } from "../../ports/clock.ts";
import {
  type ConfigStore,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_SESSION_LIMITS,
  DEFAULT_VOICE,
} from "../../ports/configStore.ts";
import type { PlanQuota } from "../../ports/planQuota.ts";
import type { PushSender } from "../../ports/pushSender.ts";
import type { Summarizer } from "../../ports/summarizer.ts";
import type { T3Backend, T3Connector } from "../../ports/t3Backend.ts";
import type { TaskRegistry } from "../../ports/taskRegistry.ts";
import type { VoiceEngine } from "../../ports/voiceEngine.ts";
import { loadT3Setup } from "./t3Setup.ts";

/** What the voice engine is built with. `apiKey` is a secret: never print it. */
export interface VoiceEngineSettings {
  apiKey: string;
  model: string;
  voice: string;
  delegationModel: string;
}

/** What the Codex voice engine (on the ChatGPT plan) is built with. */
export interface CodexVoiceSettings {
  /** The model of the Codex thread. */
  model: string;
  reasoningEffort: string;
  /** Replaces the adapter's tested Codex versions when set. */
  acceptedVersions?: string[];
}

/** The Codex voice engine and the quota of the plan it draws from. */
export interface CodexVoice {
  engine: VoiceEngine;
  quota: PlanQuota;
}

/** What the summarizer is built with. `apiKey` is a secret: never print it. */
export interface SummarizerSettings {
  apiKey: string;
  model: string;
}

export interface ServeOptions {
  store: ConfigStore;
  t3: T3Connector;
  /** main.ts plugs the HTTP adapter in here. */
  startServer(options: ApiServerOptions): Promise<RunningApiServer>;
  /** main.ts plugs the GPT-Live adapter in here. */
  voiceEngine(settings: VoiceEngineSettings): VoiceEngine;
  /** main.ts plugs the Codex voice adapter in here. */
  codexVoice(settings: CodexVoiceSettings): CodexVoice;
  /** main.ts plugs the OpenAI summarizer in here. */
  summarizer(settings: SummarizerSettings): Summarizer;
  /** main.ts plugs the push adapter in here; `log` writes to the service's log. */
  pushSender(log: (line: string) => void): PushSender;
  /** main.ts plugs the SQLite registry in here. */
  openTaskRegistry(): TaskRegistry;
  /** Resolves when the process must stop (SIGTERM from systemd, Ctrl-C). */
  waitForStop(): Promise<void>;
  out(line: string): void;
  /** Injectable for tests. */
  clock?: Clock;
  /** Ids of the commands sent to T3. Injectable for tests. */
  newId?: () => string;
}

export async function runServe({
  store,
  t3,
  startServer,
  voiceEngine,
  codexVoice,
  summarizer,
  pushSender,
  openTaskRegistry,
  waitForStop,
  out,
  clock = systemClock,
  newId = randomUUID,
}: ServeOptions) {
  const { config, pairing } = await loadT3Setup(store);
  // Read once now, so a damaged or loose device list stops the start, not the first request.
  const devices = await store.loadDevices();
  const apiKey = await store.loadOpenAiKey();
  // Opened before T3, so a damaged or loose database stops the start.
  const registry = openTaskRegistry();

  // Fail closed: connect checks that T3 is a tested version, and throws otherwise.
  let backend: T3Backend;
  try {
    backend = await t3.connect(pairing, config.t3.acceptedServerVersions);
  } catch (error) {
    registry.close();
    throw error;
  }
  const state = new ShellState();
  let connected = true;
  const shell = () => (connected && state.hasSnapshot ? state : null);
  const {
    model,
    voice,
    delegationModel,
    summaryModel,
    codexModel,
    codexReasoningEffort,
    minPlanQuotaPercent,
    acceptedCodexVersions,
  } = { ...DEFAULT_VOICE, ...config.voice };
  const { idleMinutes, idleMinutesWhileTasksRun, dailyBudgetUsd } = {
    ...DEFAULT_SESSION_LIMITS,
    ...config.voice,
  };
  const queue = new AnnouncementQueue({ registry, shell, push: pushSender(out), clock, log: out });
  const summaries = new TaskSummaries({
    backend,
    summarizer: apiKey === null ? null : summarizer({ apiKey, model: summaryModel }),
    registry,
    clock,
    log: out,
  });
  const watcher = new TaskWatcher({ registry, shell, summaries, queue, clock, log: out });
  let fail: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  // Handled by the race below; this only keeps an early failure from crashing the process.
  failed.catch(() => {});
  const subscription = backend.subscribeShell({
    onEvent: (event) => {
      state.apply(event);
      watcher.check();
    },
    onConnectionChange: (change) => {
      connected = change === "connected";
    },
    // For example T3 came back as an untested version: stop rather than guess.
    onFatalError: (error) => fail(error),
  });

  // Without a key, serve still runs: pairing and GET /activity need no voice engine.
  if (apiKey === null) {
    out(
      `No OpenAI key in ${store.location}/openai.env: voice sessions open on Codex only, while ${minPlanQuotaPercent} % of the plan's quota is left.`,
    );
  }
  const engine = apiKey === null ? null : voiceEngine({ apiKey, model, voice, delegationModel });
  const codex = codexVoice({
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
    ...(acceptedCodexVersions === undefined ? {} : { acceptedVersions: acceptedCodexVersions }),
  });
  const voiceSessions = new VoiceSessionManager({
    engine,
    plan: { engine: codex.engine, quota: codex.quota, minPercentLeft: minPlanQuotaPercent },
    shell,
    tasks: new VoiceTasks({ backend, registry, shell, summaries, clock, newId, log: out }),
    announcements: queue,
    registry,
    limits: { idleMinutes, idleMinutesWhileTasksRun, dailyBudgetUsd },
    // `t3-voice devices revoke` writes the revocation; serve reads it from the store.
    isRevoked: async (deviceId) => {
      const device = (await store.loadDevices()).find((candidate) => candidate.id === deviceId);
      return device === undefined || device.revokedAt !== null;
    },
    clock,
    log: out,
  });

  let server: RunningApiServer | null = null;
  try {
    const {
      host = DEFAULT_SERVER_HOST,
      port = DEFAULT_SERVER_PORT,
      clientIpHeader,
    } = config.server ?? {};
    server = await startServer({
      host,
      port,
      ...(clientIpHeader ? { clientIpHeader } : {}),
      // While T3 is away, its last known state could be stale: say so instead.
      activity: () => {
        const current = shell();
        return current === null ? null : activityOf(current, new Date(clock.now()));
      },
      voiceSessions,
    });
    const { version } = backend.serverInfo();
    const paired = devices.filter((device) => device.revokedAt === null).length;
    out(`Connected to T3 ${version} at ${config.t3.baseUrl}.`);
    out(`Listening on ${server.url} (${paired} paired device${paired === 1 ? "" : "s"}).`);

    await Promise.race([waitForStop(), failed]);
  } finally {
    watcher.stop();
    // An open session keeps costing at OpenAI until it is closed.
    await voiceSessions.closeAll();
    await server?.close();
    subscription.close();
    backend.close();
    registry.close();
  }
}
