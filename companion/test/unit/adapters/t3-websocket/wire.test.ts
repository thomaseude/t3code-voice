import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toProject, toShellEvent } from "../../../../src/adapters/t3-websocket/wire.ts";
import { shellSnapshot, wireProject, wireThread } from "./fakes.ts";

describe("toShellEvent", () => {
  test("translates a snapshot, including archived threads", () => {
    const item = shellSnapshot(
      7,
      [wireProject("p1", "joombo")],
      [wireThread("t1", { status: "running" })],
    );
    item.snapshot.archivedThreads = [
      wireThread("t2", { archivedAt: "2026-10-26T09:00:00.000Z" }),
    ] as never[];

    const event = toShellEvent(item);

    assert.equal(event?.type, "snapshot");
    if (event?.type !== "snapshot") return;
    assert.equal(event.sequence, 7);
    assert.deepEqual(event.projects, [
      {
        id: "p1",
        title: "joombo",
        workspaceRoot: "/home/me/joombo",
        newThreadWorkspace: null,
        defaultModel: null,
      },
    ]);
    assert.deepEqual(
      event.threads.map((each) => [each.id, each.status, each.archived]),
      [
        ["t1", "running", false],
        ["t2", "idle", true],
      ],
    );
  });

  test("translates a thread with a pending question and an error", () => {
    const event = toShellEvent({
      kind: "thread.updated",
      sequence: 3,
      location: "active",
      thread: wireThread("t1", {
        status: "running",
        activityRunStatus: "running",
        pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: "x", blocking: false },
        lastError: "Provider hiccup",
        lastErrorClass: "provider_error",
        lineage: { parentThreadId: "t0", relationshipToParent: "subagent", rootThreadId: "t0" },
      }),
    });

    assert.equal(event?.type, "thread.updated");
    if (event?.type !== "thread.updated") return;
    assert.deepEqual(event.thread.pendingRequest, {
      id: "r1",
      kind: "user_input",
      blocking: false,
    });
    assert.deepEqual(event.thread.lastError, {
      message: "Provider hiccup",
      failureClass: "provider_error",
      resumesAt: null,
      autoResume: false,
    });
    assert.equal(event.thread.activeRunStatus, "running");
    assert.equal(event.thread.isSubagent, true);
    assert.equal(event.thread.model, "claude-opus-5-5");
  });

  test("reads the latest run, the work it left behind, and whether the user dismissed it", () => {
    const event = toShellEvent({
      kind: "thread.updated",
      sequence: 5,
      location: "active",
      thread: wireThread("t1", {
        status: "completed",
        latestRunId: "run-2",
        pendingBackgroundTasks: [
          { taskId: "a", kind: "command", description: "npm run dev" },
          { taskId: "b", kind: "subagent" },
        ],
        settledOverride: "settled",
      }),
    });

    assert.equal(event?.type, "thread.updated");
    if (event?.type !== "thread.updated") return;
    assert.equal(event.thread.latestRunId, "run-2");
    assert.deepEqual(event.thread.backgroundTaskKinds, ["command", "subagent"]);
    assert.equal(event.thread.settled, true);
  });

  test("an older server without these fields reads as no run, no work left, not dismissed", () => {
    const event = toShellEvent({
      kind: "thread.updated",
      sequence: 5,
      location: "active",
      thread: wireThread("t1", { status: "completed" }),
    });

    if (event?.type !== "thread.updated") return assert.fail("not a thread update");
    assert.equal(event.thread.latestRunId, null);
    assert.deepEqual(event.thread.backgroundTaskKinds, []);
    assert.equal(event.thread.settled, false);
  });

  test("reads when a usage limit ends, and whether T3 resumes the run by itself", () => {
    const failed = (fields: Record<string, unknown>) => {
      const event = toShellEvent({
        kind: "thread.updated",
        sequence: 6,
        location: "active",
        thread: wireThread("t1", {
          status: "failed",
          lastError: "Usage limit reached",
          lastErrorClass: "usage_limit",
          ...fields,
        }),
      });
      if (event?.type !== "thread.updated") throw new Error("not a thread update");
      return event.thread.lastError;
    };

    assert.deepEqual(failed({ usageLimitResetAt: "2026-10-26T15:00:00.000Z" }), {
      message: "Usage limit reached",
      failureClass: "usage_limit",
      resumesAt: "2026-10-26T15:00:00.000Z",
      autoResume: false,
    });
    assert.deepEqual(
      failed({
        usageLimitResetAt: "2026-10-26T15:00:00.000Z",
        limitRecovery: { runId: "run-1", resetAt: "2026-10-26T16:00:00.000Z", autoResume: true },
      }),
      {
        message: "Usage limit reached",
        failureClass: "usage_limit",
        resumesAt: "2026-10-26T16:00:00.000Z",
        autoResume: true,
      },
    );
  });

  test("says which list a removed thread left", () => {
    assert.deepEqual(
      toShellEvent({ kind: "thread.removed", sequence: 4, location: "active", threadId: "t1" }),
      {
        type: "thread.removed",
        sequence: 4,
        threadId: "t1",
        fromArchive: false,
      },
    );
  });

  test("skips repository-metadata refreshes, which are partial snapshots", () => {
    const refresh = {
      ...shellSnapshot(1, [wireProject("p2")]),
      resolvedRepositoryIdentityRoots: ["/home/me/p2"],
    };

    assert.equal(toShellEvent(refresh), null);
  });

  test("skips items the companion does not use", () => {
    assert.equal(toShellEvent({ kind: "synchronized" }), null);
    assert.equal(toShellEvent({ kind: "something.new", sequence: 9 }), null);
  });
});

describe("toProject", () => {
  test("reads the project's setting for new threads and its default model", () => {
    const project = toProject({
      ...wireProject("p1", "joombo"),
      defaultThreadEnvMode: "worktree",
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-codex" },
    });

    assert.equal(project.newThreadWorkspace, "new_worktree");
    assert.deepEqual(project.defaultModel, { providerInstanceId: "codex", model: "gpt-5.6-codex" });
  });

  test("an unknown setting or a missing model reads as null", () => {
    const project = toProject({ ...wireProject("p1"), defaultThreadEnvMode: "cloud" });

    assert.equal(project.newThreadWorkspace, null);
    assert.equal(project.defaultModel, null);
  });
});
