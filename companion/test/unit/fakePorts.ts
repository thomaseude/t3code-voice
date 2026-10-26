// In-memory implementations of the ports, to test the core and the CLI without T3 or files.

import type { CompanionConfig, ConfigStore } from "../../src/ports/configStore.ts";
import {
  type Project,
  type ServerInfo,
  type ShellSubscriber,
  type ShellSubscription,
  type T3Backend,
  type T3Config,
  type T3Connector,
  T3IncompatibleError,
  type T3Session,
  type Thread,
} from "../../src/ports/t3Backend.ts";

export class InMemoryConfigStore implements ConfigStore {
  readonly location = "/home/me/.config/t3voice";
  config: CompanionConfig | null = null;
  session: T3Session | null = null;

  async loadConfig() {
    return this.config;
  }
  async saveConfig(config: CompanionConfig) {
    this.config = config;
  }
  async loadT3Session() {
    return this.session;
  }
  async saveT3Session(session: T3Session) {
    this.session = session;
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
  subscribeShell(subscriber: ShellSubscriber): ShellSubscription {
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

  async checkServer(baseUrl: string, acceptedVersions = ["0.1.0"]): Promise<ServerInfo> {
    this.calls.push(`checkServer ${baseUrl}`);
    if (!acceptedVersions.includes(this.serverVersion)) {
      throw new T3IncompatibleError([`server version is ${this.serverVersion}`]);
    }
    return { version: this.serverVersion, protocolVersion: 2 };
  }
  async pair(baseUrl: string, pairingLink: string): Promise<T3Session> {
    this.calls.push(`pair ${baseUrl} ${pairingLink}`);
    return {
      token: "secret-session-token",
      scopes: this.grantedScopes,
      expiresAt: "2026-11-25T14:00:00.000Z",
    };
  }
  async connect(baseUrl: string, token: string): Promise<T3Backend> {
    this.calls.push(
      `connect ${baseUrl} ${token === "secret-session-token" ? "with token" : "BAD TOKEN"}`,
    );
    await this.checkServer(baseUrl);
    return this.backend;
  }
}
