// T3's awareness rule (upstream `projectThreadAwarenessV2`, T3 0.1.1), ported to the
// companion's Thread: which threads are running, finished, or wait for the user.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { awarenessOf, eventKeyOf } from "../../../src/core/awareness.ts";
import { thread } from "../builders.ts";

describe("awarenessOf", () => {
  test("a run being prepared, started, running or capturing its checkpoint is running", () => {
    for (const status of ["preparing", "starting", "running", "waiting"]) {
      assert.equal(awarenessOf(thread("t", { status })), "running", status);
      assert.equal(
        awarenessOf(thread("t", { status: "completed", activeRunStatus: status })),
        "running",
        `active ${status}`,
      );
    }
  });

  test("a run waiting for its checkpoint is not waiting for the user", () => {
    assert.equal(awarenessOf(thread("t", { status: "waiting" })), "running");
  });

  test("a completed or failed run is finished", () => {
    assert.equal(awarenessOf(thread("t", { status: "completed" })), "completed");
    assert.equal(awarenessOf(thread("t", { status: "failed" })), "failed");
  });

  test("idle, queued, interrupted, cancelled and rolled back threads say nothing", () => {
    for (const status of ["idle", "queued", "interrupted", "cancelled", "rolled_back"]) {
      assert.equal(awarenessOf(thread("t", { status })), null, status);
    }
  });

  test("background work that wakes the agent keeps a completed run running", () => {
    for (const kind of ["subagent", "monitor", "background_task", "a_kind_from_later"]) {
      assert.equal(
        awarenessOf(thread("t", { status: "completed", backgroundTaskKinds: [kind] })),
        "running",
        kind,
      );
    }
  });

  test("a command left running, like a dev server, does not hold the completion", () => {
    assert.equal(
      awarenessOf(thread("t", { status: "completed", backgroundTaskKinds: ["command"] })),
      "completed",
    );
  });

  test("a blocking question waits for input, even while the run is live", () => {
    const question = { id: "r1", kind: "user_input", blocking: true };
    assert.equal(
      awarenessOf(thread("t", { status: "running", pendingRequest: question })),
      "waiting_for_input",
    );
  });

  test("an async question waits for input only once the run is no longer live", () => {
    const question = { id: "r1", kind: "user_input", blocking: false };
    assert.equal(
      awarenessOf(thread("t", { status: "running", pendingRequest: question })),
      "running",
    );
    assert.equal(
      awarenessOf(thread("t", { status: "waiting", pendingRequest: question })),
      "waiting_for_input",
    );
  });

  test("a permission request waits for approval; an auth refresh does not", () => {
    const permission = { id: "r1", kind: "command", blocking: true };
    assert.equal(
      awarenessOf(thread("t", { status: "running", pendingRequest: permission })),
      "waiting_for_approval",
    );
    const refresh = { id: "r2", kind: "auth_refresh", blocking: true };
    assert.equal(
      awarenessOf(thread("t", { status: "running", pendingRequest: refresh })),
      "running",
    );
  });

  test("a result the user dismissed in T3 says nothing", () => {
    assert.equal(awarenessOf(thread("t", { status: "completed", settled: true })), null);
    assert.equal(awarenessOf(thread("t", { status: "failed", settled: true })), null);
    assert.equal(awarenessOf(thread("t", { status: "running", settled: true })), "running");
  });

  test("a subagent's thread says nothing", () => {
    assert.equal(awarenessOf(thread("t", { status: "completed", isSubagent: true })), null);
  });
});

describe("eventKeyOf", () => {
  test("a finished run is one event per run", () => {
    const done = thread("t", { status: "completed", latestRunId: "run-1" });
    assert.equal(eventKeyOf(done), "completed:run-1");
    assert.equal(eventKeyOf({ ...done, latestRunId: "run-2" }), "completed:run-2");
    assert.equal(eventKeyOf({ ...done, status: "failed" }), "failed:run-1");
  });

  test("a request that waits for the user is one event per request", () => {
    const question = { id: "r1", kind: "user_input", blocking: true };
    assert.equal(
      eventKeyOf(thread("t", { status: "running", pendingRequest: question })),
      "waiting_for_input:r1",
    );
  });

  test("a running or silent thread is no event", () => {
    assert.equal(eventKeyOf(thread("t", { status: "running" })), null);
    assert.equal(eventKeyOf(thread("t", { status: "idle" })), null);
  });
});
