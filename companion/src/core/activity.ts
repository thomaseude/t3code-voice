// The small task list the app shows (GET /activity): what runs now, and what finished
// in the last 24 hours. The voice tools read the full lists.

import type { Activity, ActivityItem } from "../ports/apiServer.ts";
import type { Thread } from "../ports/t3Backend.ts";
import type { ShellState } from "./shellState.ts";

/** Threads per list, the latest first. */
const MAX_PER_LIST = 10;
const FINISHED_SINCE_MS = 24 * 3_600_000;

/** Run statuses that upstream awareness reports as running. In `waiting`, only the checkpoint capture is left. */
export const LIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

export function activityOf(state: ShellState, now: Date): Activity {
  const { running, finished } = allActivity(state);
  return {
    running: running.slice(0, MAX_PER_LIST),
    finished: finishedSince24Hours(finished, now).slice(0, MAX_PER_LIST),
  };
}

/** The items that finished in the 24 hours before `now`. */
export function finishedSince24Hours(items: ActivityItem[], now: Date): ActivityItem[] {
  const since = new Date(now.getTime() - FINISHED_SINCE_MS).toISOString();
  return items.filter((item) => item.updatedAt >= since);
}

/** Every top-level thread T3's awareness rule reports, the latest first, with no limit. */
export function allActivity(state: ShellState): Activity {
  const running: ActivityItem[] = [];
  const finished: ActivityItem[] = [];
  for (const thread of state.topLevelThreads()) {
    const threadState = stateOf(thread);
    if (threadState === null) continue;
    const item: ActivityItem = {
      threadId: thread.id,
      title: thread.title,
      project: state.projects.get(thread.projectId)?.title ?? null,
      state: threadState,
      updatedAt: thread.updatedAt,
    };
    if (threadState === "completed" || threadState === "failed") finished.push(item);
    else running.push(item);
  }
  return { running, finished };
}

/**
 * T3's own awareness rule (upstream `projectThreadAwarenessV2`, see the research note
 * `research/agent-lifecycle-events.md`). Null for the states it keeps silent: idle (never
 * run), queued, interrupted, cancelled, rolled back.
 */
function stateOf(thread: Thread): ActivityItem["state"] | null {
  const runStatus = thread.activeRunStatus ?? thread.status;
  const live = LIVE_RUN_STATUSES.has(runStatus);
  const request = thread.pendingRequest;
  if (request?.kind === "user_input" && (request.blocking || !live)) return "waiting_for_input";
  if (request !== null && request.kind !== "user_input" && request.kind !== "auth_refresh") {
    return "waiting_for_approval";
  }
  if (live) return "running";
  if (runStatus === "completed") return "completed";
  if (runStatus === "failed") return "failed";
  return null;
}
