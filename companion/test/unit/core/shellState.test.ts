import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ShellState } from "../../../src/core/shellState.ts";
import type { ShellEvent } from "../../../src/ports/t3Backend.ts";
import { project, thread } from "../builders.ts";

function stateFrom(...events: ShellEvent[]): ShellState {
  const state = new ShellState();
  for (const event of events) state.apply(event);
  return state;
}

describe("ShellState", () => {
  test("lists the threads an agent works on, newest first", () => {
    const state = stateFrom({
      type: "snapshot",
      sequence: 1,
      projects: [project("p1")],
      threads: [
        thread("idle"),
        thread("done", { status: "completed" }),
        thread("failed", {
          status: "failed",
          lastError: {
            message: "Usage limit reached",
            failureClass: "usage_limit",
            resumesAt: null,
            autoResume: false,
          },
        }),
        thread("running", { status: "running", updatedAt: "2026-10-26T10:01:00.000Z" }),
        thread("checkpoint", { status: "waiting", updatedAt: "2026-10-26T10:02:00.000Z" }),
        thread("question", {
          status: "running",
          updatedAt: "2026-10-26T10:03:00.000Z",
          pendingRequest: { id: "r1", kind: "user_input", blocking: true },
        }),
        thread("subagent", { status: "running", isSubagent: true }),
        thread("archived", { status: "running", archived: true }),
      ],
    });

    assert.deepEqual(
      state.runningThreads().map((each) => each.id),
      ["question", "checkpoint", "running"],
    );
  });

  test("follows deltas after the snapshot", () => {
    const state = stateFrom(
      {
        type: "snapshot",
        sequence: 1,
        projects: [project("p1")],
        threads: [thread("t1", { status: "running" })],
      },
      { type: "project.updated", sequence: 2, project: project("p2") },
      { type: "thread.updated", sequence: 3, thread: thread("t1", { status: "completed" }) },
      { type: "thread.updated", sequence: 4, thread: thread("t2", { status: "starting" }) },
    );

    assert.deepEqual([...state.projects.keys()], ["p1", "p2"]);
    assert.deepEqual(
      state.runningThreads().map((each) => each.id),
      ["t2"],
    );
  });

  test("keeps a thread that moved to the archive", () => {
    const state = stateFrom(
      { type: "snapshot", sequence: 1, projects: [], threads: [thread("t1")] },
      { type: "thread.updated", sequence: 2, thread: thread("t1", { archived: true }) },
      { type: "thread.removed", sequence: 3, threadId: "t1", fromArchive: false },
    );
    assert.equal(state.threads.get("t1")?.archived, true);

    const removed = stateFrom(
      { type: "snapshot", sequence: 1, projects: [], threads: [thread("t1")] },
      { type: "thread.removed", sequence: 2, threadId: "t1", fromArchive: false },
    );
    assert.equal(removed.threads.size, 0);
  });

  test("a later snapshot replaces everything", () => {
    const state = stateFrom(
      { type: "snapshot", sequence: 1, projects: [project("p1")], threads: [thread("t1")] },
      { type: "snapshot", sequence: 9, projects: [project("p2")], threads: [] },
    );

    assert.deepEqual([...state.projects.keys()], ["p2"]);
    assert.equal(state.threads.size, 0);
  });
});
