// In-memory implementations of the ports, to test the core and the CLI without T3 or files.

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

export class InMemoryConfigStore implements ConfigStore {
  readonly location = "/home/me/.config/t3voice";
  config: CompanionConfig | null = null;
  pairing: T3Pairing | null = null;
  devices: PairedDevice[] = [];
  pairingWindow: PairingWindow | null = null;

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
  async loadDevices() {
    return this.devices;
  }
  async updateDevices(change: (devices: PairedDevice[]) => PairedDevice[]) {
    this.devices = change(this.devices);
    return this.devices;
  }
  async loadPairingWindow() {
    return this.pairingWindow;
  }
  async savePairingWindow(window: PairingWindow) {
    this.pairingWindow = window;
  }
  async clearPairingWindow() {
    this.pairingWindow = null;
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

/** Knows the tokens it was given or issued; anything else is rejected. */
export class FakeDeviceAuth implements DeviceAuth {
  readonly devices = new Map<string, Device>();
  private registered = 0;

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
  async register(name: string) {
    this.registered++;
    const token = `issued-token-${this.registered}`;
    return { device: this.addDevice(token, { id: `new${this.registered}`, name }), token };
  }
}
