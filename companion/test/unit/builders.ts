// Builders for the companion's own types (ports), for tests of the core and the CLI.

import type { Project, Thread } from "../../src/ports/t3Backend.ts";

export function project(id: string, title = id): Project {
  return { id, title, workspaceRoot: `/home/me/${title}` };
}

export function thread(id: string, fields: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: "p1",
    title: `Thread ${id}`,
    status: "idle",
    activeRunStatus: null,
    providerInstanceId: "claudeAgent",
    model: "claude-opus-5-5",
    branch: null,
    worktreePath: null,
    pendingRequest: null,
    lastError: null,
    isSubagent: false,
    archived: false,
    updatedAt: "2026-10-26T10:00:00.000Z",
    ...fields,
  };
}
