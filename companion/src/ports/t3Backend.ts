// The T3 ports: everything the companion needs from a T3 Code server.
//
// These types belong to the companion. Adapters translate T3's wire format into them, so
// the rest of the companion never depends on T3's internal schemas, which change often.

export interface Project {
  id: string;
  title: string;
  workspaceRoot: string;
}

/** Raw run status reported by T3 for a thread ("idle", "running", "failed", ...). */
export type ThreadStatus = string;

export interface PendingRequest {
  id: string;
  /** "user_input" for a question, otherwise a permission kind ("command", "file-change", ...). */
  kind: string;
  /** False for async questions the agent keeps working past. */
  blocking: boolean;
}

export interface ThreadError {
  message: string;
  /** "usage_limit", "provider_error", ... or null when T3 did not classify it. */
  failureClass: string | null;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  status: ThreadStatus;
  /** Status of the run still doing work ("preparing" ... "waiting"), or null when none is. */
  activeRunStatus: string | null;
  providerInstanceId: string;
  model: string;
  branch: string | null;
  worktreePath: string | null;
  pendingRequest: PendingRequest | null;
  lastError: ThreadError | null;
  isSubagent: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface ProviderModel {
  slug: string;
  name: string;
}

export interface Provider {
  instanceId: string;
  /** Provider kind, e.g. "claudeAgent" or "codex". */
  driver: string;
  displayName: string;
  enabled: boolean;
  /** T3's health status for the provider, e.g. "ready", "error", "disabled". */
  status: string;
  models: ProviderModel[];
}

export interface T3Config {
  providers: Provider[];
  defaultRuntimeMode: string;
  defaultModel: { providerInstanceId: string; model: string } | null;
}

/** One change on the shell stream. `sequence` is T3's cursor; use it only to resume. */
export type ShellEvent =
  | { type: "snapshot"; sequence: number; projects: Project[]; threads: Thread[] }
  | { type: "project.updated"; sequence: number; project: Project }
  | { type: "project.removed"; sequence: number; projectId: string }
  | { type: "thread.updated"; sequence: number; thread: Thread }
  // A thread that gets archived leaves the active list and joins the archive, so a removal
  // says which list it left.
  | { type: "thread.removed"; sequence: number; threadId: string; fromArchive: boolean };

export interface ShellSubscriber {
  onEvent(event: ShellEvent): void;
  /** Connection state changes, for logs and health checks. */
  onConnectionChange?(state: "connected" | "reconnecting"): void;
  /** The subscription stopped for good (for example, T3 was upgraded to an untested version). */
  onFatalError?(error: Error): void;
}

export interface ShellSubscription {
  close(): void;
}

/** The T3 server the backend is connected to, as checked at startup. */
export interface ServerInfo {
  version: string;
  protocolVersion: number;
}

export interface T3Backend {
  serverInfo(): ServerInfo;
  listProjects(): Promise<Project[]>;
  getConfig(): Promise<T3Config>;
  /**
   * Streams a snapshot, then deltas. Reconnects by itself: it resumes after the last
   * sequence it saw, and falls back to a fresh snapshot when T3 cannot replay the gap.
   */
  subscribeShell(
    subscriber: ShellSubscriber,
    options?: { afterSequence?: number },
  ): ShellSubscription;
  close(): void;
}

/** A T3 session token and what it grants. `token` is a secret. */
export interface T3Session {
  token: string;
  scopes: string[];
  /** ISO date, or "" when T3 did not say. */
  expiresAt: string;
}

/** Scopes the companion needs; a pairing must grant both. */
export const REQUIRED_T3_SCOPES = ["orchestration:read", "orchestration:operate"];

/** Reaching a T3 server: version check, pairing, and opening a backend. */
export interface T3Connector {
  /**
   * Checks that the server is a version the companion was tested with.
   * Throws T3IncompatibleError otherwise.
   */
  checkServer(baseUrl: string, acceptedVersions?: string[]): Promise<ServerInfo>;
  /** Exchanges a one-time pairing link (or bare credential) for a session. */
  pair(baseUrl: string, pairingLink: string): Promise<T3Session>;
  /** Opens a backend after the same version check. */
  connect(baseUrl: string, token: string, acceptedVersions?: string[]): Promise<T3Backend>;
}

/** The T3 server is not a tested version: the companion must not run against it. */
export class T3IncompatibleError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `The T3 server does not match the version this companion was tested with:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        `\nUpdate t3-voice (or re-test it and add the version to "t3.acceptedServerVersions").`,
    );
    this.name = "T3IncompatibleError";
    this.problems = problems;
  }
}
