// The current list of projects and threads, kept up to date from shell events.

import type { Project, ShellEvent, Thread } from "./backend.ts";

/** Run statuses during which an agent is still working on the thread. */
const LIVE_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

export class ShellState {
  readonly projects = new Map<string, Project>();
  readonly threads = new Map<string, Thread>();
  hasSnapshot = false;

  apply(event: ShellEvent): void {
    switch (event.type) {
      case "snapshot":
        this.projects.clear();
        this.threads.clear();
        for (const project of event.projects) this.projects.set(project.id, project);
        for (const thread of event.threads) this.threads.set(thread.id, thread);
        this.hasSnapshot = true;
        break;
      case "project.updated":
        this.projects.set(event.project.id, event.project);
        break;
      case "project.removed":
        this.projects.delete(event.projectId);
        break;
      case "thread.updated":
        this.threads.set(event.thread.id, event.thread);
        break;
      case "thread.removed": {
        // Ignore the removal from the list the thread just moved out of.
        const thread = this.threads.get(event.threadId);
        if (thread && thread.archived === event.fromArchive) this.threads.delete(event.threadId);
        break;
      }
    }
  }

  /** Top-level threads an agent is working on, including those waiting for the user. */
  runningThreads(): Thread[] {
    return [...this.threads.values()]
      .filter((thread) => !thread.archived && !thread.isSubagent && isRunning(thread))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export function isRunning(thread: Thread): boolean {
  return (
    LIVE_STATUSES.has(thread.status) ||
    thread.activeRunStatus !== null ||
    thread.pendingRequest !== null
  );
}
