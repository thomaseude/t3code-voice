// T3's own awareness rule: upstream `projectThreadAwarenessV2` at T3 0.1.1 (the research
// note `research/agent-lifecycle-events.md` explains it). It says whether a thread runs, has
// finished, or waits for the user. The app list (GET /activity), the voice tools and the
// announcements all use it, so they never disagree.

import type { Thread } from "../ports/t3Backend.ts";

export type Awareness =
  | "running"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "completed"
  | "failed";

/** Statuses of a run still doing work. In `waiting`, only the checkpoint capture is left. */
export const LIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/** Run statuses during which the agent's turn is still going: not `waiting`, where only the checkpoint is left. */
const LIVE_TURN_STATUSES = new Set(["preparing", "starting", "running"]);

/**
 * Null for what T3 keeps silent: a thread that never ran, a queued, interrupted, cancelled
 * or rolled back run, a result the user dismissed in T3, and subagent threads.
 * Upstream's "starting" is "running" here.
 */
export function awarenessOf(thread: Thread): Awareness | null {
  if (thread.isSubagent) return null;
  const state = stateOf(thread);
  const finished = state === "completed" || state === "failed";
  if (finished && thread.settled && !backgroundWorkHoldsCompletion(thread)) return null;
  return state;
}

/** What a thread is doing, for the tools that read it. */
export type ThreadStatus = Awareness | "queued" | "idle";

/**
 * T3's state of the thread, also for a result the user dismissed in T3: a tool that reads a
 * thread tells what it is, an announcement only what is news. A run waiting in T3's queue is
 * "queued"; a thread with no run, or whose run was stopped, is "idle".
 */
export function threadStatusOf(thread: Thread): ThreadStatus {
  const state = stateOf(thread);
  if (state !== null) return state;
  return (thread.activeRunStatus ?? thread.status) === "queued" ? "queued" : "idle";
}

/**
 * What one announcement is about: a run that finished, or a request that waits for the
 * user. Null when there is nothing to announce. The key comes from T3's ids, so it is the
 * same after a reconnect or a restart.
 */
export function eventKeyOf(thread: Thread): string | null {
  const state = awarenessOf(thread);
  switch (state) {
    case "completed":
    case "failed":
      return `${state}:${thread.latestRunId ?? thread.updatedAt}`;
    case "waiting_for_input":
    case "waiting_for_approval":
      return `${state}:${thread.pendingRequest?.id ?? thread.updatedAt}`;
    default:
      return null;
  }
}

function stateOf(thread: Thread): Awareness | null {
  const runStatus = thread.activeRunStatus ?? thread.status;
  const request = thread.pendingRequest;
  if (request?.kind === "user_input" && (request.blocking || !LIVE_TURN_STATUSES.has(runStatus))) {
    return "waiting_for_input";
  }
  if (request !== null && request.kind !== "user_input" && request.kind !== "auth_refresh") {
    return "waiting_for_approval";
  }
  if (LIVE_RUN_STATUSES.has(runStatus)) return "running";
  switch (runStatus) {
    case "completed":
      return backgroundWorkHoldsCompletion(thread) ? "running" : "completed";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Subagents, monitors and background tasks wake the agent again, so its run is not over.
 * A command (a dev server) does not: the agent is done and may leave it running for hours.
 * A kind this companion does not know holds, as upstream does.
 */
function backgroundWorkHoldsCompletion(thread: Thread): boolean {
  return thread.backgroundTaskKinds.some((kind) => kind !== "command");
}
