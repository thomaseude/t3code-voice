// In-memory implementations of the ports, to test the core and the CLI without T3 or files.

import type { Clock } from "../../src/ports/clock.ts";
import type { CompanionConfig, ConfigStore, PairingWindow } from "../../src/ports/configStore.ts";
import type { Device, DeviceAuth, PairedDevice } from "../../src/ports/deviceAuth.ts";
import {
  type Project,
  type ServerInfo,
  type ShellSubscriber,
  type ShellSubscription,
  type T3Backend,
  type T3Config,
  type T3Connector,
  T3IncompatibleError,
  type T3Pairing,
  type Thread,
} from "../../src/ports/t3Backend.ts";
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

export class FakeT3Backend implements T3Backend {
  projects: Project[] = [];
  threads: Thread[] = [];
  closed = false;

  serverInfo(): ServerInfo {
    return { version: "0.1.0", protocolVersion: 2 };
  }
  async listProjects() {
    return this.projects;
  }
  async getConfig(): Promise<T3Config> {
    return { providers: [], defaultRuntimeMode: "full-access", defaultModel: null };
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
  readonly spoken: string[];
  readonly toolResults: Array<{ callId: string; result: unknown }>;
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
      spoken: [],
      toolResults: [],
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
