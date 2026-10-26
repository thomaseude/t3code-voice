// The T3Backend port: everything the companion needs from a T3 Code server.
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

export interface T3Backend {
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
