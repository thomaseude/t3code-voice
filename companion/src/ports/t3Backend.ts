// The T3 ports: everything the companion needs from a T3 Code server.
//
// These types belong to the companion. Adapters translate T3's wire format into them, so
// the rest of the companion never depends on T3's internal schemas, which change often.

export interface Project {
  id: string;
  title: string;
  workspaceRoot: string;
  /**
   * Where the project's T3 setting puts new threads: each in a new worktree, or in the
   * project folder. Null when T3 did not say.
   */
  newThreadWorkspace: LaunchWorkspace["type"] | null;
  /** The agent and model T3 picks for the project's new threads, or null for T3's default. */
  defaultModel: ModelSelection | null;
}

export interface ModelSelection {
  providerInstanceId: string;
  model: string;
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
  /** ISO date when a usage limit ends and the run can resume, or null. */
  resumesAt: string | null;
  /** True when T3 resumes the run by itself at `resumesAt`. */
  autoResume: boolean;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  status: ThreadStatus;
  /** Status of the run still doing work ("preparing" ... "waiting"), or null when none is. */
  activeRunStatus: string | null;
  /** The thread's last run, or null before its first one. Each run has its own id. */
  latestRunId: string | null;
  /**
   * Kinds of the work a finished run left behind ("subagent", "monitor", "command", ...).
   * Some of it wakes the agent again, so the run is not over yet.
   */
  backgroundTaskKinds: string[];
  /** The user dismissed the thread's result in T3 ("settled"): there is nothing to tell. */
  settled: boolean;
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

/** A message of a thread: the user's, the agent's, or T3's own. */
export interface ThreadMessage {
  role: "user" | "assistant" | "system";
  text: string;
  /** The run the message belongs to, or null. */
  runId: string | null;
  /** ISO date. */
  createdAt: string;
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
  defaultModel: ModelSelection | null;
}

/** What T3 reports about the folder of a project. */
export interface RepositoryInfo {
  isGitRepository: boolean;
  /** The branch origin/HEAD names ("main", "master"), or null when the repository has none. */
  defaultBranch: string | null;
}

/** Where a new thread works. */
export type LaunchWorkspace =
  | { type: "project_folder" }
  /** A new worktree, started from `baseBranch` as fetched from origin when there is one. */
  | { type: "new_worktree"; baseBranch: string };

export interface LaunchThreadRequest {
  /** Sending the same id again returns the same thread instead of starting another one. */
  commandId: string;
  projectId: string;
  /** A first title; T3 replaces it with one it writes from the prompt. */
  title: string;
  model: ModelSelection;
  runtimeMode: string;
  /** The user's request: the first message of the thread. */
  prompt: string;
  workspace: LaunchWorkspace;
}

export interface SendMessageRequest {
  /** Sending the same id again sends nothing more. */
  commandId: string;
  threadId: string;
  /** Chosen by the companion, to find the message again (to cancel it while it waits). */
  messageId: string;
  text: string;
  /** "queue": after the agent's current turn, or now when it has none. "steer": now, into the current turn. */
  mode: "queue" | "steer";
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
  /** Reads the folder of a project. Only `orchestration:read` is needed. */
  inspectRepository(path: string): Promise<RepositoryInfo>;
  /** The thread's messages, oldest first. Only `orchestration:read` is needed. */
  readThread(threadId: string): Promise<ThreadMessage[]>;
  launchThread(request: LaunchThreadRequest): Promise<{ threadId: string }>;
  sendMessage(request: SendMessageRequest): Promise<void>;
  /**
   * Takes a message back while it still waits in the thread's queue. True also when it was
   * taken back already. False when it no longer waits: the agent already has it.
   */
  cancelQueuedMessage(commandId: string, threadId: string, messageId: string): Promise<boolean>;
  /** Stops the thread's agent, whatever it is doing; nothing when no agent works on it. */
  stopThread(commandId: string, threadId: string): Promise<void>;
  archiveThread(commandId: string, threadId: string): Promise<void>;
  close(): void;
}

/** What a pairing gave the companion: a token (a secret), its server and its scopes. */
export interface T3Pairing {
  /** The T3 server that issued the token: the token is never sent anywhere else. */
  baseUrl: string;
  token: string;
  scopes: string[];
  /** ISO date, or null when T3 did not say. */
  expiresAt: string | null;
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
  /** Exchanges a one-time pairing link (or bare credential) for a token. */
  pair(baseUrl: string, pairingLink: string): Promise<T3Pairing>;
  /** Opens a backend on the pairing's server, after the same version check. */
  connect(pairing: T3Pairing, acceptedVersions?: string[]): Promise<T3Backend>;
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
