// Translation from T3's wire shapes (orchestration protocol 2) to the companion's own types.
//
// T3 adds fields often and marks many as optional ("absent from older servers"), so every
// reader below tolerates missing fields and ignores unknown ones.

import type { Project, ShellEvent, T3Config, Thread } from "./backend.ts";

/** Untyped JSON as received from T3. Readers check each field they use. */
// biome-ignore lint/suspicious/noExplicitAny: wire JSON is checked field by field.
export type WireJson = any;

export function toProject(wire: WireJson): Project {
  return {
    id: String(wire.id),
    title: String(wire.title ?? ""),
    workspaceRoot: String(wire.workspaceRoot ?? ""),
  };
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
  const defaultSelection = settings.defaultModelSelection;
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
    defaultModel: defaultSelection?.instanceId
      ? { providerInstanceId: defaultSelection.instanceId, model: String(defaultSelection.model) }
      : null,
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
