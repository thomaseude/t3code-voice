// In-memory implementations of the ports, to test the core and the CLI without T3 or files.

import { AnnouncementQueue } from "../../src/core/announcementQueue.ts";
import { TaskSummaries } from "../../src/core/taskSummaries.ts";
import { VoiceTasks } from "../../src/core/voiceTasks.ts";
import type { Clock } from "../../src/ports/clock.ts";
import type { CompanionConfig, ConfigStore, PairingWindow } from "../../src/ports/configStore.ts";
import type { Device, DeviceAuth, PairedDevice } from "../../src/ports/deviceAuth.ts";
import type { PushNotification, PushSender } from "../../src/ports/pushSender.ts";
import type {
  ConversationSummaryRequest,
  Summarizer,
  SummaryRequest,
  TaskSummary,
} from "../../src/ports/summarizer.ts";
import {
  type LaunchThreadRequest,
  type Project,
  type ReadThreadOptions,
  type RepositoryInfo,
  type SendMessageRequest,
  type ServerInfo,
  type ShellSubscriber,
  type ShellSubscription,
  type T3Backend,
  type T3Config,
  type T3Connector,
  T3IncompatibleError,
  type T3Pairing,
  type Thread,
  type ThreadMessage,
  type ThreadPage,
} from "../../src/ports/t3Backend.ts";
import type { FollowedTask, TaskRegistry } from "../../src/ports/taskRegistry.ts";
import {
  type VoiceEngine,
  VoiceEngineError,
  type VoiceEvent,
  type VoiceSession,
  type VoiceSessionRequest,
} from "../../src/ports/voiceEngine.ts";
import { pairedDevice } from "./builders.ts";

export class InMemoryConfigStore implements ConfigStore {
  readonly location = "/home/me/.config/t3voice";
  config: CompanionConfig | null = null;
  pairing: T3Pairing | null = null;
  openAiKey: string | null = null;
  devices: PairedDevice[] = [];
  /** Open pairing windows, by code hash. */
  readonly pairingWindows = new Map<string, PairingWindow>();

  async loadConfig() {
    return this.config;
  }
  async saveConfig(config: CompanionConfig) {
    this.config = config;
  }
  async loadT3Pairing() {
    return this.pairing;
  }
  async saveT3Pairing(pairing: T3Pairing) {
    this.pairing = pairing;
  }
  async loadOpenAiKey() {
    return this.openAiKey;
  }
  async loadDevices() {
    return this.devices;
  }
  /** Like the file store, it keeps revocations as they were: only revokeDevice revokes. */
  async updateDevices(change: (devices: PairedDevice[]) => PairedDevice[]) {
    const revoked = new Map(this.devices.map((device) => [device.id, device.revokedAt]));
    this.devices = change(this.devices).map((device) => ({
      ...device,
      revokedAt: revoked.get(device.id) ?? null,
    }));
    return this.devices;
  }
  async revokeDevice(id: string, revokedAt: string) {
    this.devices = this.devices.map((device) =>
      device.id === id && device.revokedAt === null ? { ...device, revokedAt } : device,
    );
  }
  async loadPairingWindow(codeSha256: string) {
    return this.pairingWindows.get(codeSha256) ?? null;
  }
  async savePairingWindow(window: PairingWindow) {
    this.pairingWindows.set(window.codeSha256, window);
  }
  async clearPairingWindow(codeSha256: string) {
    this.pairingWindows.delete(codeSha256);
  }
}

/** A command the fake T3 received, with the request it came with. */
export type T3Command =
  | ({ type: "launch" } & LaunchThreadRequest)
  | ({ type: "send" } & SendMessageRequest)
  | { type: "cancel_queued"; commandId: string; threadId: string; messageId: string }
  | { type: "stop"; commandId: string; threadId: string }
  | { type: "archive"; commandId: string; threadId: string };

export class FakeT3Backend implements T3Backend {
  projects: Project[] = [];
  threads: Thread[] = [];
  config: T3Config = { providers: [], defaultRuntimeMode: "full-access", defaultModel: null };
  /** By folder; a folder not listed is a git repository whose default branch is "main". */
  readonly repositories = new Map<string, RepositoryInfo>();
  readonly commands: T3Command[] = [];
  /** Makes the next command (or the next one of this type) fail, like T3 refusing it. */
  failNextCommand: boolean | T3Command["type"] | "read" = false;
  /** While set, launchThread waits for it, like a T3 slow to answer. */
  launchGate: Promise<void> | null = null;
  /** What cancelQueuedMessage answers: false once the agent has the message. */
  messageStillQueued = true;
  closed = false;
  private launched = 0;

  serverInfo(): ServerInfo {
    return { version: "0.1.0", protocolVersion: 2 };
  }
  async listProjects() {
    return this.projects;
  }
  async getConfig(): Promise<T3Config> {
    return this.config;
  }
  async inspectRepository(path: string): Promise<RepositoryInfo> {
    return this.repositories.get(path) ?? { isGitRepository: true, defaultBranch: "main" };
  }
  /** Messages of each thread, by thread id. A message with no id gets "m<its index>". */
  readonly messages = new Map<string, Array<Omit<ThreadMessage, "id"> & { id?: string }>>();
  /** While set, readThread waits for it, like a T3 slow to answer. */
  readGate: Promise<void> | null = null;
  async readThread(threadId: string, options: ReadThreadOptions = {}): Promise<ThreadPage> {
    if (this.readGate !== null) await this.readGate;
    if (this.failNextCommand === "read") {
      this.failNextCommand = false;
      throw new Error("T3 did not answer.");
    }
    const all = (this.messages.get(threadId) ?? []).map((message, index) => ({
      ...message,
      id: message.id ?? `m${index}`,
    }));
    const end =
      options.before == null ? all.length : all.findIndex((each) => each.id === options.before);
    if (end === -1) return { messages: [], olderCursor: null };
    const start = options.limit === undefined ? 0 : Math.max(end - options.limit, 0);
    const messages = all.slice(start, end);
    return { messages, olderCursor: start > 0 ? (messages[0]?.id ?? null) : null };
  }
  async launchThread(request: LaunchThreadRequest) {
    if (this.launchGate !== null) await this.launchGate;
    this.record({ type: "launch", ...request });
    this.launched++;
    return { threadId: `launched-${this.launched}` };
  }
  async sendMessage(request: SendMessageRequest) {
    this.record({ type: "send", ...request });
  }
  async cancelQueuedMessage(commandId: string, threadId: string, messageId: string) {
    this.record({ type: "cancel_queued", commandId, threadId, messageId });
    return this.messageStillQueued;
  }
  async stopThread(commandId: string, threadId: string) {
    this.record({ type: "stop", commandId, threadId });
  }
  async archiveThread(commandId: string, threadId: string) {
    this.record({ type: "archive", commandId, threadId });
  }
  private record(command: T3Command) {
    if (this.failNextCommand === true || this.failNextCommand === command.type) {
      this.failNextCommand = false;
      throw new Error("T3 refused the command.");
    }
    this.commands.push(command);
  }
  /** The last subscriber, to push events, reconnections and failures to it. */
  subscriber: ShellSubscriber | null = null;

  subscribeShell(subscriber: ShellSubscriber): ShellSubscription {
    this.subscriber = subscriber;
    setImmediate(() =>
      subscriber.onEvent({
        type: "snapshot",
        sequence: 1,
        projects: this.projects,
        threads: this.threads,
      }),
    );
    return { close: () => {} };
  }
  close() {
    this.closed = true;
  }
}

export class FakeT3Connector implements T3Connector {
  readonly backend = new FakeT3Backend();
  serverVersion = "0.1.0";
  grantedScopes = ["orchestration:read", "orchestration:operate"];
  readonly calls: string[] = [];
  expiresAt: string | null = "2026-11-25T14:00:00.000Z";

  async checkServer(baseUrl: string, acceptedVersions = ["0.1.0"]): Promise<ServerInfo> {
    this.calls.push(`checkServer ${baseUrl}`);
    if (!acceptedVersions.includes(this.serverVersion)) {
      throw new T3IncompatibleError([`server version is ${this.serverVersion}`]);
    }
    return { version: this.serverVersion, protocolVersion: 2 };
  }
  async pair(baseUrl: string, pairingLink: string): Promise<T3Pairing> {
    this.calls.push(`pair ${baseUrl} ${pairingLink}`);
    return {
      baseUrl,
      token: "secret-pairing-token",
      scopes: this.grantedScopes,
      expiresAt: this.expiresAt,
    };
  }
  async connect(pairing: T3Pairing): Promise<T3Backend> {
    const { baseUrl, token } = pairing;
    this.calls.push(
      `connect ${baseUrl} ${token === "secret-pairing-token" ? "with token" : "BAD TOKEN"}`,
    );
    await this.checkServer(baseUrl);
    return this.backend;
  }
}

/**
 * Knows the tokens it was given or issued; anything else is rejected. With a store, a
 * device it registers also goes in the store's device list, as the real one does.
 */
export class FakeDeviceAuth implements DeviceAuth {
  readonly devices = new Map<string, Device>();
  private readonly store: InMemoryConfigStore | null;
  private registered = 0;
  /** Makes the next register() fail, like a device list that cannot be saved. */
  failNextRegister = false;

  constructor(store: InMemoryConfigStore | null = null) {
    this.store = store;
  }

  addDevice(token: string, device: Device = { id: "d1", name: "iPhone" }): Device {
    this.devices.set(token, device);
    return device;
  }
  revoke(token: string) {
    this.devices.delete(token);
  }
  async authenticate(token: string) {
    const device = this.devices.get(token);
    return device === undefined ? null : { device, replacementToken: null };
  }
  async register(name: string, pairingCodeSha256: string) {
    if (this.failNextRegister) {
      this.failNextRegister = false;
      throw new Error("devices.json could not be saved.");
    }
    this.registered++;
    const token = `issued-token-${this.registered}`;
    const device = this.addDevice(token, { id: `new${this.registered}`, name });
    this.store?.devices.push(pairedDevice({ ...device, pairingCodeSha256 }));
    return { device, token };
  }
}

/** A voice session the fake engine opened: what the core sent to it. */
export interface FakeVoiceSession extends VoiceSession {
  readonly request: VoiceSessionRequest;
  readonly toolResults: Array<{ callId: string; result: unknown }>;
  /** What the core asked the engine to say, in order. */
  readonly spoken: string[];
  closed: boolean;
  /** Sends an event to the core, as the engine would. */
  emit(event: VoiceEvent): void;
}

export class FakeVoiceEngine implements VoiceEngine {
  readonly sessions: FakeVoiceSession[] = [];
  /** Makes the next openSession() fail, like an engine that refuses the offer. */
  failNextOpen = false;
  /** While set, openSession() waits for it, like an engine slow to answer. */
  answerGate: Promise<void> | null = null;

  get last(): FakeVoiceSession {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error("No voice session was opened.");
    return session;
  }

  async openSession(request: VoiceSessionRequest, onEvent: (event: VoiceEvent) => void) {
    if (this.failNextOpen) {
      this.failNextOpen = false;
      throw new VoiceEngineError("The engine answered 400.");
    }
    if (this.answerGate !== null) await this.answerGate;
    const session: FakeVoiceSession = {
      request,
      sdpAnswer: `answer to ${request.sdpOffer}`,
      toolResults: [],
      spoken: [],
      closed: false,
      emit: onEvent,
      speak: (text) => {
        session.spoken.push(text);
      },
      resolveToolCall: (callId, result) => {
        session.toolResults.push({ callId, result });
      },
      close: async () => {
        if (session.closed) return;
        session.closed = true;
        onEvent({ type: "closed", reason: "closed" });
      },
    };
    this.sessions.push(session);
    return session;
  }
}

/** Like the SQLite registry, without the file: a thread or a name is followed once. */
export class InMemoryTaskRegistry implements TaskRegistry {
  tasks: FollowedTask[] = [];
  /** Makes the next follow() fail, like a database that cannot be written. */
  failNextFollow = false;

  followedTasks() {
    return [...this.tasks];
  }
  follow(task: FollowedTask) {
    if (this.failNextFollow) {
      this.failNextFollow = false;
      throw new Error("The database is locked.");
    }
    if (this.tasks.some((other) => other.threadId === task.threadId)) {
      throw new Error("The thread is already followed.");
    }
    if (this.tasks.some((other) => other.spokenName === task.spokenName)) {
      throw new Error("The spoken name is taken.");
    }
    this.tasks.push(task);
  }
  unfollow(threadId: string) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.threadId !== threadId);
    for (const key of this.summaries.keys()) {
      if (key.startsWith(`${threadId}|`)) this.summaries.delete(key);
    }
    return this.tasks.length < before;
  }
  markAnnounced(threadId: string, state: string, eventKey: string) {
    this.tasks = this.tasks.map((task) =>
      task.threadId === threadId
        ? { ...task, lastAnnouncedState: state, lastEventKey: eventKey }
        : task,
    );
  }
  /** By "thread|event key". */
  readonly summaries = new Map<string, TaskSummary>();
  saveSummary(threadId: string, eventKey: string, summary: TaskSummary) {
    this.summaries.set(`${threadId}|${eventKey}`, summary);
  }
  summaryOf(threadId: string, eventKey: string) {
    return this.summaries.get(`${threadId}|${eventKey}`) ?? null;
  }
  close() {}
}

/** Answers with a summary built from the request, or fails or waits when told to. */
export class FakeSummarizer implements Summarizer {
  readonly requests: SummaryRequest[] = [];
  /** Makes the next summarize() fail, like OpenAI down. */
  failNext = false;
  /** While set, summarize() waits for it, like a slow model. */
  gate: Promise<void> | null = null;
  /** Waits for the next calls only, one each, in order. */
  readonly nextGates: Promise<void>[] = [];

  async summarize(request: SummaryRequest) {
    this.requests.push(request);
    const own = this.nextGates.shift();
    if (own !== undefined) await own;
    if (this.gate !== null) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("OpenAI did not answer.");
    }
    return { short: `Résumé de : ${request.output}` };
  }

  readonly conversations: ConversationSummaryRequest[] = [];

  async summarizeConversation(request: ConversationSummaryRequest) {
    this.conversations.push(request);
    if (this.gate !== null) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("OpenAI did not answer.");
    }
    const last = request.messages.at(-1)?.text ?? "";
    return `Résumé (${request.status}) de ${request.messages.length} messages, dont : ${last}`;
  }
}

export class FakePushSender implements PushSender {
  readonly sent: PushNotification[] = [];
  failNext = false;

  async send(notification: PushNotification) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("ntfy did not answer.");
    }
    this.sent.push(notification);
  }
}

/** A clock the test moves by hand: scheduled callbacks run only when `advance` passes them. */
export class FakeClock implements Clock {
  private time: number;
  private timers: Array<{ at: number; callback: () => void }> = [];

  constructor(start = Date.parse("2026-10-26T10:00:00.000Z")) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const timer = { at: this.time + delayMs, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((other) => other !== timer);
    };
  }

  /** How many callbacks are still scheduled: a timer left behind keeps a real process alive. */
  pendingTimers(): number {
    return this.timers.length;
  }

  /** Moves time forward and runs, in order, the callbacks that fall due. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.time = next.at;
      next.callback();
    }
    this.time = end;
  }
}

/** Lets pending promises and callbacks run, as several turns of the event loop. */
export async function settle() {
  for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
}

/** Summaries with no summarizer, for tests that do not use them. */
export function unusedSummaries(
  clock: Clock = new FakeClock(),
  registry: TaskRegistry = new InMemoryTaskRegistry(),
): TaskSummaries {
  return new TaskSummaries({
    backend: new FakeT3Backend(),
    summarizer: null,
    registry,
    clock,
    log: () => {},
  });
}

/** An announcement queue nothing is announced to, for tests that do not use it. */
export function unusedAnnouncements(clock: Clock = new FakeClock()): AnnouncementQueue {
  return new AnnouncementQueue({
    registry: new InMemoryTaskRegistry(),
    shell: () => null,
    push: new FakePushSender(),
    clock,
    log: () => {},
  });
}

/** Task tools on a fake T3 with no project, for tests that do not use them. */
export function unusedVoiceTasks(clock: Clock = new FakeClock()): VoiceTasks {
  return new VoiceTasks({
    backend: new FakeT3Backend(),
    registry: new InMemoryTaskRegistry(),
    shell: () => null,
    summaries: unusedSummaries(clock),
    clock,
    newId: () => "id",
    log: () => {},
  });
}
