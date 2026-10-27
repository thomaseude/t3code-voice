// Translation from T3's wire shapes (orchestration protocol 2) to the companion's own types.
//
// T3 adds fields often and marks many as optional ("absent from older servers"), so every
// reader below tolerates missing fields and ignores unknown ones.

import { LIVE_RUN_STATUSES } from "../../core/activity.ts";
import type {
  LaunchThreadRequest,
  ModelSelection,
  Project,
  RepositoryInfo,
  SendMessageRequest,
  ShellEvent,
  T3Config,
  Thread,
} from "../../ports/t3Backend.ts";

/** T3's `defaultThreadEnvMode` values, in the companion's words. */
const THREAD_ENV_MODES: Record<string, Project["newThreadWorkspace"]> = {
  local: "project_folder",
  worktree: "new_worktree",
};

/** What T3 records as the origin of the threads and messages the companion sends. */
const CREATION_SOURCE = "mobile";

/** Untyped JSON as received from T3. Readers check each field they use. */
// biome-ignore lint/suspicious/noExplicitAny: wire JSON is checked field by field.
export type WireJson = any;

export function toProject(wire: WireJson): Project {
  return {
    id: String(wire.id),
    title: String(wire.title ?? ""),
    workspaceRoot: String(wire.workspaceRoot ?? ""),
    newThreadWorkspace: THREAD_ENV_MODES[wire.defaultThreadEnvMode] ?? null,
    defaultModel: toModelSelection(wire.defaultModelSelection),
  };
}

function toModelSelection(wire: WireJson): ModelSelection | null {
  // Older servers name the instance `provider`.
  const instanceId = wire?.instanceId ?? wire?.provider;
  if (typeof instanceId !== "string" || typeof wire?.model !== "string") return null;
  return { providerInstanceId: instanceId, model: wire.model };
}

export function toThread(wire: WireJson, location: "active" | "archive" = "active"): Thread {
  const pending = wire.pendingRuntimeRequest;
  return {
    id: String(wire.id),
    projectId: String(wire.projectId),
    title: String(wire.title ?? ""),
    status: String(wire.status ?? "idle"),
    activeRunStatus: wire.activityRunStatus ?? null,
    providerInstanceId: String(wire.providerInstanceId ?? wire.modelSelection?.instanceId ?? ""),
    model: String(wire.modelSelection?.model ?? ""),
    branch: wire.branch ?? null,
    worktreePath: wire.worktreePath ?? null,
    pendingRequest: pending
      ? { id: String(pending.id), kind: String(pending.kind), blocking: pending.blocking !== false }
      : null,
    lastError: wire.lastError
      ? { message: String(wire.lastError), failureClass: wire.lastErrorClass ?? null }
      : null,
    isSubagent: wire.lineage?.relationshipToParent === "subagent",
    archived: location === "archive" || wire.archivedAt != null,
    updatedAt: String(wire.updatedAt ?? ""),
  };
}

export function toConfig(wire: WireJson): T3Config {
  const settings = wire.settings ?? {};
  const providers = Array.isArray(wire.providers) ? wire.providers : [];
  return {
    providers: providers.map((provider: WireJson) => ({
      instanceId: String(provider.instanceId),
      driver: String(provider.driver ?? ""),
      displayName: String(provider.displayName ?? provider.instanceId),
      enabled: provider.enabled !== false,
      status: String(provider.status ?? "unknown"),
      models: (Array.isArray(provider.models) ? provider.models : []).map((model: WireJson) => ({
        slug: String(model.slug),
        name: String(model.name ?? model.slug),
      })),
    })),
    defaultRuntimeMode: String(settings.defaultRuntimeMode ?? "full-access"),
    defaultModel: toModelSelection(settings.defaultModelSelection),
  };
}

/** Returns null for items the companion does not use ("synchronized", unknown kinds). */
export function toShellEvent(item: WireJson): ShellEvent | null {
  switch (item?.kind) {
    case "snapshot": {
      // A snapshot naming `resolvedRepositoryIdentityRoots` is not a full snapshot: it only
      // refreshes repository metadata for a few projects and lists no threads. The companion
      // does not use that metadata, so it skips it.
      if (item.resolvedRepositoryIdentityRoots !== undefined) return null;
      const snapshot = item.snapshot ?? {};
      return {
        type: "snapshot",
        sequence: Number(snapshot.snapshotSequence ?? 0),
        projects: (snapshot.projects ?? []).map(toProject),
        threads: [
          ...(snapshot.threads ?? []).map((thread: WireJson) => toThread(thread, "active")),
          ...(snapshot.archivedThreads ?? []).map((thread: WireJson) =>
            toThread(thread, "archive"),
          ),
        ],
      };
    }
    case "project.updated":
      return { type: "project.updated", sequence: item.sequence, project: toProject(item.project) };
    case "project.removed":
      return {
        type: "project.removed",
        sequence: item.sequence,
        projectId: String(item.projectId),
      };
    case "thread.updated":
      return {
        type: "thread.updated",
        sequence: item.sequence,
        thread: toThread(item.thread, item.location === "archive" ? "archive" : "active"),
      };
    case "thread.removed":
      return {
        type: "thread.removed",
        sequence: item.sequence,
        threadId: String(item.threadId),
        fromArchive: item.location === "archive",
      };
    default:
      return null;
  }
}

/**
 * Reads `vcs.listRefs`. The default branch is the one origin/HEAD names (T3 marks it
 * `isDefault`), else main or master, else the current branch.
 */
export function toRepositoryInfo(wire: WireJson): RepositoryInfo {
  if (wire?.isRepo !== true) return { isGitRepository: false, defaultBranch: null };
  const refs: WireJson[] = Array.isArray(wire.refs) ? wire.refs : [];
  const local = refs.filter((ref) => ref?.isRemote !== true && typeof ref?.name === "string");
  const remoteDefault = refs.find((ref) => ref?.isRemote === true && ref.isDefault === true);
  const fromRemote =
    typeof remoteDefault?.name === "string"
      ? remoteDefault.name.slice(String(remoteDefault.remoteName ?? "origin").length + 1)
      : undefined;
  const branch =
    local.find((ref) => ref.isDefault === true)?.name ??
    (fromRemote || undefined) ??
    local.find((ref) => ref.name === "main" || ref.name === "master")?.name ??
    local.find((ref) => ref.current === true)?.name ??
    null;
  return { isGitRepository: true, defaultBranch: branch };
}

export function toLaunchThreadInput(request: LaunchThreadRequest): WireJson {
  const { workspace } = request;
  return {
    commandId: request.commandId,
    creationSource: CREATION_SOURCE,
    projectId: request.projectId,
    title: request.title,
    // The title is a seed: T3 writes the real one from the prompt.
    generateTitle: true,
    modelSelection: { instanceId: request.model.providerInstanceId, model: request.model.model },
    runtimeMode: request.runtimeMode,
    interactionMode: "default",
    workspaceStrategy:
      workspace.type === "new_worktree"
        ? // From origin's copy of the branch, fetched first; the local one when there is no remote.
          { type: "worktree", baseRef: workspace.baseBranch, startFromOrigin: true }
        : { type: "root" },
    initialMessage: { text: request.prompt, attachments: [] },
  };
}

export function toMessageDispatch(request: SendMessageRequest): WireJson {
  return {
    type: "message.dispatch",
    commandId: request.commandId,
    threadId: request.threadId,
    messageId: request.messageId,
    text: request.text,
    attachments: [],
    // T3 overwrites createdBy with "user" for every client.
    createdBy: "user",
    creationSource: CREATION_SOURCE,
    // T3 starts the message now on an idle thread, and queues it after an active run.
    // "steer" asks it to deliver the message into the active run instead.
    dispatchMode: { type: "start_immediately" },
    ...(request.mode === "steer" ? { deliveryIntent: "steer" } : {}),
  };
}

/**
 * The runs to stop on a thread, from a thread projection: the one an agent works on now,
 * and those still waiting in the queue, which would start after it.
 */
export function runsToStop(projection: WireJson): { active: string | null; queued: string[] } {
  const runs: WireJson[] = Array.isArray(projection?.runs) ? projection.runs : [];
  const ids = (keep: (run: WireJson) => boolean) =>
    runs.filter((run) => keep(run) && typeof run.id === "string").map((run) => String(run.id));
  return {
    active: ids((run) => LIVE_RUN_STATUSES.has(run?.status))[0] ?? null,
    queued: ids((run) => run?.status === "queued"),
  };
}

/** The run that delivers the message, from a thread projection, or null. */
export function runOfMessage(
  projection: WireJson,
  messageId: string,
): { id: string; status: string } | null {
  const runs: WireJson[] = Array.isArray(projection?.runs) ? projection.runs : [];
  const run = runs.find((each) => each?.userMessageId === messageId);
  return typeof run?.id === "string" ? { id: run.id, status: String(run.status) } : null;
}
