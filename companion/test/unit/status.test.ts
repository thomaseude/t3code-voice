import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatStatus } from "../../src/commands/status.ts";
import { ShellState } from "../../src/t3/shellState.ts";
import { toShellEvent } from "../../src/t3/wire.ts";
import { COMPATIBLE_DESCRIPTOR, shellSnapshot, wireProject, wireThread } from "./fakes.ts";

function stateFrom(...items: unknown[]): ShellState {
  const state = new ShellState();
  for (const item of items) {
    const event = toShellEvent(item);
    if (event) state.apply(event);
  }
  return state;
}

describe("ShellState", () => {
  test("lists the threads an agent works on, newest first", () => {
    const state = stateFrom(
      shellSnapshot(
        1,
        [wireProject("p1")],
        [
          wireThread("idle", { status: "idle" }),
          wireThread("done", { status: "completed" }),
          wireThread("failed", { status: "failed", lastError: "Usage limit reached" }),
          wireThread("running", { status: "running", updatedAt: "2026-10-26T10:01:00.000Z" }),
          wireThread("checkpoint", { status: "waiting", updatedAt: "2026-10-26T10:02:00.000Z" }),
          wireThread("question", {
            status: "running",
            updatedAt: "2026-10-26T10:03:00.000Z",
            pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: "x" },
          }),
          wireThread("subagent", {
            status: "running",
            lineage: { parentThreadId: "running", relationshipToParent: "subagent" },
          }),
          wireThread("archived", { status: "running", archivedAt: "2026-10-26T09:00:00.000Z" }),
        ],
      ),
    );

    assert.deepEqual(
      state.runningThreads().map((thread) => thread.id),
      ["question", "checkpoint", "running"],
    );
  });

  test("follows deltas after the snapshot", () => {
    const state = stateFrom(
      shellSnapshot(1, [wireProject("p1")], [wireThread("t1", { status: "running" })]),
      { kind: "project.updated", sequence: 2, project: wireProject("p2") },
      {
        kind: "thread.updated",
        sequence: 3,
        location: "active",
        thread: wireThread("t1", { status: "completed" }),
      },
      {
        kind: "thread.updated",
        sequence: 4,
        location: "active",
        thread: wireThread("t2", { status: "starting" }),
      },
    );

    assert.deepEqual([...state.projects.keys()], ["p1", "p2"]);
    assert.deepEqual(
      state.runningThreads().map((thread) => thread.id),
      ["t2"],
    );
  });

  test("keeps a thread that moved to the archive", () => {
    const state = stateFrom(
      shellSnapshot(1, [], [wireThread("t1")]),
      {
        kind: "thread.updated",
        sequence: 2,
        location: "archive",
        thread: wireThread("t1", { archivedAt: "2026-10-26T11:00:00.000Z" }),
      },
      { kind: "thread.removed", sequence: 3, location: "active", threadId: "t1" },
    );

    assert.equal(state.threads.get("t1")?.archived, true);

    const removed = stateFrom(shellSnapshot(1, [], [wireThread("t1")]), {
      kind: "thread.removed",
      sequence: 2,
      location: "active",
      threadId: "t1",
    });
    assert.equal(removed.threads.size, 0);
  });

  test("ignores repository-metadata refreshes, which are partial snapshots", () => {
    const refresh = {
      ...shellSnapshot(1, [wireProject("p2")]),
      resolvedRepositoryIdentityRoots: ["/home/me/p2"],
    };
    const state = stateFrom(
      shellSnapshot(1, [wireProject("p1"), wireProject("p2")], [wireThread("t1")]),
      refresh,
    );

    assert.deepEqual([...state.projects.keys()], ["p1", "p2"]);
    assert.equal(state.threads.size, 1);
  });

  test("a later snapshot replaces everything", () => {
    const state = stateFrom(
      shellSnapshot(1, [wireProject("p1")], [wireThread("t1", { status: "running" })]),
      shellSnapshot(9, [wireProject("p2")]),
    );

    assert.deepEqual([...state.projects.keys()], ["p2"]);
    assert.equal(state.threads.size, 0);
  });
});

describe("formatStatus", () => {
  test("prints the server, projects and running threads", () => {
    const state = stateFrom(
      shellSnapshot(
        1,
        [wireProject("p1", "joombo"), wireProject("p2", "blog")],
        [
          wireThread("t1", { title: "Fix the Reviews tests", status: "running" }),
          wireThread("t2", {
            projectId: "p2",
            title: "Deploy",
            status: "running",
            pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: "x" },
            modelSelection: { instanceId: "codex", model: "gpt-6" },
            providerInstanceId: "codex",
          }),
        ],
      ),
    );

    const lines = formatStatus({
      baseUrl: "http://127.0.0.1:3773",
      descriptor: COMPATIBLE_DESCRIPTOR,
      tokenExpiresAt: "2026-11-25T14:00:00.000Z",
      state,
      now: new Date("2026-10-26T14:00:00.000Z"),
    });

    assert.deepEqual(lines, [
      "T3 0.1.0, protocol 2 at http://127.0.0.1:3773: connected.",
      "T3 session expires on 2026-11-25 (in 30 days).",
      "",
      "Projects (2):",
      "  - blog  /home/me/blog",
      "  - joombo  /home/me/joombo",
      "",
      "Running threads (2):",
      "  - Fix the Reviews tests  [joombo]  running  (claudeAgent / claude-opus-5-5)",
      "  - Deploy  [blog]  waiting for approval (command)  (codex / gpt-6)",
    ]);
  });

  test("says when nothing runs and when the session expired", () => {
    const lines = formatStatus({
      baseUrl: "http://127.0.0.1:3773",
      descriptor: COMPATIBLE_DESCRIPTOR,
      tokenExpiresAt: "2026-10-01T00:00:00.000Z",
      state: stateFrom(shellSnapshot(1, [])),
      now: new Date("2026-10-26T14:00:00.000Z"),
    });

    assert.ok(lines.includes('T3 session expires on 2026-10-01 (expired; run "t3-voice setup").'));
    assert.deepEqual(lines.slice(-5), [
      "Projects (0):",
      "  (none)",
      "",
      "Running threads (0):",
      "  (none)",
    ]);
  });
});
