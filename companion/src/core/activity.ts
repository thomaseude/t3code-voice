// The small task list the app shows (GET /activity): what runs now, and what finished
// in the last 24 hours.

import type { Activity, ActivityItem } from "../ports/apiServer.ts";
import type { Thread } from "../ports/t3Backend.ts";
import { isRunning, type ShellState } from "./shellState.ts";

/** Threads per list, the latest first. */
const MAX_PER_LIST = 10;
const FINISHED_SINCE_MS = 24 * 3_600_000;

export function activityOf(state: ShellState, now: Date): Activity {
  const since = new Date(now.getTime() - FINISHED_SINCE_MS).toISOString();
  const finished = [...state.threads.values()]
    .filter((thread) => !thread.archived && !thread.isSubagent && !isRunning(thread))
    .filter((thread) => thread.updatedAt >= since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const item = (thread: Thread): ActivityItem => ({
    threadId: thread.id,
    title: thread.title,
    project: state.projects.get(thread.projectId)?.title ?? null,
    state: stateOf(thread),
    updatedAt: thread.updatedAt,
  });
  return {
    running: state.runningThreads().slice(0, MAX_PER_LIST).map(item),
    finished: finished.slice(0, MAX_PER_LIST).map(item),
  };
}

function stateOf(thread: Thread): ActivityItem["state"] {
  const request = thread.pendingRequest;
  if (request?.kind === "user_input" && request.blocking) return "waiting_for_input";
  if (request !== null && request.kind !== "user_input") return "waiting_for_approval";
  if (isRunning(thread)) return "running";
  return thread.status === "failed" || thread.lastError !== null ? "failed" : "completed";
}
