// Seam 1: voice sessions through the core, with a fake voice engine, a shell state fed with
// T3 events, and a fake clock.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ShellState } from "../../../src/core/shellState.ts";
import { VoiceSessionManager } from "../../../src/core/voiceSessions.ts";
import type { Project, Thread } from "../../../src/ports/t3Backend.ts";
import { project, thread } from "../builders.ts";
import { FakeClock, FakeVoiceEngine } from "../fakePorts.ts";

function shellWith(projects: Project[], threads: Thread[] = []): ShellState {
  const state = new ShellState();
  state.apply({ type: "snapshot", sequence: 1, projects, threads });
  return state;
}

function setup({
  shell = shellWith([]) as ShellState | null,
  start = undefined as number | undefined,
} = {}) {
  const engine = new FakeVoiceEngine();
  const clock = new FakeClock(start);
  const logs: string[] = [];
  const revoked = new Set<string>();
  let connectedShell = shell;
  const sessions = new VoiceSessionManager({
    engine,
    shell: () => connectedShell,
    isRevoked: async (deviceId) => revoked.has(deviceId),
    clock,
    log: (line) => logs.push(line),
  });
  return {
    engine,
    clock,
    logs,
    sessions,
    revoke: (deviceId: string) => revoked.add(deviceId),
    disconnectT3: () => {
      connectedShell = null;
    },
  };
}

/** Lets the core answer a tool call: it checks the device first, which takes a turn. */
async function settle() {
  for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
}

async function openOne(
  sessions: VoiceSessionManager,
  { deviceId = "d1", timeZone = null as string | null } = {},
) {
  const result = await sessions.open(deviceId, { sdpOffer: "v=0 offer", timeZone });
  assert.equal(result.status, "opened");
  return result;
}

describe("opening a voice session", () => {
  test("the engine gets the offer, and the device gets its answer and a session id", async () => {
    const { engine, sessions } = setup();

    const result = await sessions.open("d1", { sdpOffer: "v=0 offer", timeZone: null });

    assert.equal(engine.last.request.sdpOffer, "v=0 offer");
    assert.deepEqual(result, {
      status: "opened",
      sessionId: (result as { sessionId: string }).sessionId,
      sdpAnswer: "answer to v=0 offer",
    });
    assert.match((result as { sessionId: string }).sessionId, /^[A-Za-z0-9_-]{16,}$/);
  });

  test("the instructions are in French and name the projects T3 knows", async () => {
    const { engine, sessions } = setup({
      shell: shellWith([project("p1", "Joombo"), project("p2", "t3code-voice")]),
    });

    await openOne(sessions);

    const { instructions } = engine.last.request;
    assert.match(instructions, /Tu es l'assistant vocal/);
    assert.match(instructions, /Joombo, t3code-voice/);
    assert.match(instructions, /N'invente jamais un statut/);
  });

  test("the model can list projects, read the activity and end the conversation", async () => {
    const { engine, sessions } = setup();

    await openOne(sessions);

    assert.deepEqual(
      engine.last.request.tools.map((tool) => tool.name),
      ["list_projects", "get_activity", "end_session"],
    );
  });
});

describe("tools", () => {
  test("list_projects answers with the project names T3 knows now", async () => {
    const { engine, sessions } = setup({
      shell: shellWith([project("p2", "t3code-voice"), project("p1", "Joombo")]),
    });
    await openOne(sessions);

    engine.last.emit({ type: "tool_call", callId: "c1", name: "list_projects", arguments: {} });

    await settle();

    assert.deepEqual(engine.last.toolResults, [
      { callId: "c1", result: { projects: ["Joombo", "t3code-voice"] } },
    ]);
  });

  test("while T3 is away, the tools say so instead of answering from stale data", async () => {
    const { engine, sessions, disconnectT3 } = setup({ shell: shellWith([project("p1")]) });
    await openOne(sessions);
    disconnectT3();

    engine.last.emit({ type: "tool_call", callId: "c1", name: "list_projects", arguments: {} });
    engine.last.emit({
      type: "tool_call",
      callId: "c2",
      name: "get_activity",
      arguments: { scope: "running" },
    });

    await settle();

    assert.deepEqual(engine.last.toolResults, [
      { callId: "c1", result: { error: "t3_unavailable" } },
      { callId: "c2", result: { error: "t3_unavailable" } },
    ]);
  });

  test("get_activity running lists the tasks T3 reports as running or waiting for the user", async () => {
    const { engine, sessions } = setup({
      shell: shellWith(
        [project("p1", "Joombo")],
        [
          thread("t1", { title: "Fix the Reviews tests", status: "running" }),
          thread("t2", {
            title: "Add dark mode",
            status: "running",
            pendingRequest: { id: "r1", kind: "command", blocking: true },
            updatedAt: "2026-10-26T09:00:00.000Z",
          }),
          thread("t3", { title: "Done earlier", status: "completed" }),
        ],
      ),
    });
    await openOne(sessions);

    engine.last.emit({
      type: "tool_call",
      callId: "c1",
      name: "get_activity",
      arguments: { scope: "running" },
    });

    await settle();

    assert.deepEqual(engine.last.toolResults[0]?.result, {
      tasks: [
        {
          title: "Fix the Reviews tests",
          project: "Joombo",
          status: "running",
          updatedAt: "2026-10-26T10:00:00.000Z",
        },
        {
          title: "Add dark mode",
          project: "Joombo",
          status: "waiting_for_approval",
          updatedAt: "2026-10-26T09:00:00.000Z",
        },
      ],
      total: 2,
    });
  });

  test("get_activity today and finished list what ended since midnight and in the last 24 hours", async () => {
    // 11:00 in Paris. "Today" is the device's day, not the server's (UTC).
    const { engine, sessions } = setup({
      shell: shellWith(
        [project("p1", "Joombo")],
        [
          thread("t1", { title: "Still running", status: "running" }),
          thread("t2", {
            title: "Just after midnight",
            status: "completed",
            updatedAt: "2026-10-25T23:30:00.000Z",
          }),
          thread("t3", {
            title: "Late yesterday",
            status: "failed",
            updatedAt: "2026-10-25T22:30:00.000Z",
          }),
          thread("t4", {
            title: "Two days ago",
            status: "completed",
            updatedAt: "2026-10-24T09:00:00.000Z",
          }),
        ],
      ),
    });
    await openOne(sessions, { timeZone: "Europe/Paris" });

    for (const scope of ["today", "finished"]) {
      engine.last.emit({
        type: "tool_call",
        callId: scope,
        name: "get_activity",
        arguments: { scope },
      });
    }

    await settle();

    const titles = engine.last.toolResults.map(({ callId, result }) => [
      callId,
      (result as { tasks: Array<{ title: string }> }).tasks.map((task) => task.title),
    ]);
    assert.deepEqual(titles, [
      ["today", ["Just after midnight"]],
      ["finished", ["Just after midnight", "Late yesterday"]],
    ]);
  });

  test("today counts by the device's calendar day, even on the 25-hour day when clocks go back", async () => {
    // 23:50 in Paris on 2026-10-25; the task finished at 00:10 that day, 24 h 40 min earlier.
    const { engine, sessions } = setup({
      start: Date.parse("2026-10-25T22:50:00.000Z"),
      shell: shellWith(
        [project("p1")],
        [
          thread("t1", {
            title: "Just after midnight",
            status: "completed",
            updatedAt: "2026-10-24T22:10:00.000Z",
          }),
        ],
      ),
    });
    await openOne(sessions, { timeZone: "Europe/Paris" });

    engine.last.emit({
      type: "tool_call",
      callId: "c1",
      name: "get_activity",
      arguments: { scope: "today" },
    });

    await settle();

    const result = engine.last.toolResults[0]?.result as { tasks: Array<{ title: string }> };
    assert.ok(result);
    const { tasks } = result;
    assert.deepEqual(
      tasks.map((task) => task.title),
      ["Just after midnight"],
    );
  });

  test("a long list gives the 10 latest tasks and the total, so the model can say there are more", async () => {
    const threads = Array.from({ length: 12 }, (_, index) =>
      thread(`t${index}`, {
        title: `Task ${index}`,
        status: "completed",
        updatedAt: `2026-10-26T09:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const { engine, sessions } = setup({ shell: shellWith([project("p1")], threads) });
    await openOne(sessions, { timeZone: "Europe/Paris" });

    engine.last.emit({
      type: "tool_call",
      callId: "c1",
      name: "get_activity",
      arguments: { scope: "today" },
    });

    await settle();

    const result = engine.last.toolResults[0]?.result as {
      tasks: Array<{ title: string }>;
      total: number;
    };
    assert.equal(result.total, 12);
    assert.deepEqual(
      result.tasks.map((task) => task.title),
      [
        "Task 11",
        "Task 10",
        "Task 9",
        "Task 8",
        "Task 7",
        "Task 6",
        "Task 5",
        "Task 4",
        "Task 3",
        "Task 2",
      ],
    );
  });

  test("an unknown time zone falls back to the server's own", async () => {
    const { engine, sessions } = setup({ shell: shellWith([project("p1")]) });
    await openOne(sessions, { timeZone: "Mars/Olympus_Mons" });

    engine.last.emit({
      type: "tool_call",
      callId: "c1",
      name: "get_activity",
      arguments: { scope: "today" },
    });

    await settle();

    assert.deepEqual(engine.last.toolResults, [{ callId: "c1", result: { tasks: [], total: 0 } }]);
  });

  test("a wrong scope or an unknown tool gets an error the model can read", async () => {
    const { engine, sessions } = setup();
    await openOne(sessions);

    engine.last.emit({ type: "tool_call", callId: "c1", name: "get_activity", arguments: null });
    engine.last.emit({ type: "tool_call", callId: "c2", name: "rm_rf", arguments: {} });

    await settle();

    assert.deepEqual(engine.last.toolResults, [
      { callId: "c1", result: { error: "invalid_arguments" } },
      { callId: "c2", result: { error: "unknown_tool" } },
    ]);
  });
});

describe("one session per device", () => {
  test("a new session from the same device closes the one it still had", async () => {
    const { engine, sessions } = setup();
    await openOne(sessions);

    await openOne(sessions);

    assert.deepEqual(
      engine.sessions.map((session) => session.closed),
      [true, false],
    );
  });

  test("sessions of different devices stay open side by side", async () => {
    const { engine, sessions } = setup();
    await openOne(sessions, { deviceId: "d1" });

    await openOne(sessions, { deviceId: "d2" });

    assert.deepEqual(
      engine.sessions.map((session) => session.closed),
      [false, false],
    );
  });
});

describe("ending a session", () => {
  test("the device that opened a session can end it, once", async () => {
    const { engine, sessions } = setup();
    const { sessionId } = await openOne(sessions);

    assert.equal(await sessions.close("d1", sessionId), true);
    assert.equal(engine.last.closed, true);
    assert.equal(await sessions.close("d1", sessionId), false);
  });

  test("another device, or an unknown id, cannot end it", async () => {
    const { engine, sessions } = setup();
    const { sessionId } = await openOne(sessions, { deviceId: "d1" });

    assert.equal(await sessions.close("d2", sessionId), false);
    assert.equal(await sessions.close("d1", "not-a-session"), false);
    assert.equal(engine.last.closed, false);
  });

  test("a session the engine ended is forgotten", async () => {
    const { engine, sessions } = setup();
    const { sessionId } = await openOne(sessions);

    engine.last.emit({ type: "closed", reason: "failed" });

    assert.equal(await sessions.close("d1", sessionId), false);
  });

  test("end_session lets the model say goodbye, then closes the session", async () => {
    const { engine, clock, sessions } = setup();
    const { sessionId } = await openOne(sessions);

    engine.last.emit({ type: "tool_call", callId: "c1", name: "end_session", arguments: {} });

    await settle();

    assert.deepEqual(engine.last.toolResults, [{ callId: "c1", result: { status: "ending" } }]);
    clock.advance(4_999);
    assert.equal(engine.last.closed, false);
    clock.advance(1);
    await new Promise(setImmediate);
    assert.equal(engine.last.closed, true);
    assert.equal(await sessions.close("d1", sessionId), false);
  });
});

describe("stopping the companion", () => {
  test("a session still opening when the companion stops is closed too, and no new one opens", async () => {
    const { engine, sessions } = setup();
    let answer = () => {};
    engine.answerGate = new Promise((resolve) => {
      answer = resolve;
    });
    const opening = sessions.open("d1", { sdpOffer: "v=0 offer", timeZone: null });
    await settle(); // the open now waits for the engine's answer

    const stopping = sessions.closeAll();
    answer();
    await opening;
    await stopping;

    assert.equal(engine.last.closed, true);
    engine.answerGate = null;
    assert.deepEqual(await sessions.open("d2", { sdpOffer: "v=0 offer", timeZone: null }), {
      status: "unavailable",
    });
    assert.equal(engine.sessions.length, 1);
  });

  test("closeAll ends every open session, so none keeps costing", async () => {
    const { engine, sessions } = setup();
    await openOne(sessions, { deviceId: "d1" });
    await openOne(sessions, { deviceId: "d2" });

    await sessions.closeAll();

    assert.deepEqual(
      engine.sessions.map((session) => session.closed),
      [true, true],
    );
  });
});

describe("revoked devices", () => {
  test("a revoked device gets no T3 data, and its session closes", async () => {
    const { engine, revoke, sessions } = setup({ shell: shellWith([project("p1", "Joombo")]) });
    await openOne(sessions);
    revoke("d1");

    engine.last.emit({ type: "tool_call", callId: "c1", name: "list_projects", arguments: {} });
    await settle();

    assert.deepEqual(engine.last.toolResults, [
      { callId: "c1", result: { error: "device_revoked" } },
    ]);
    assert.equal(engine.last.closed, true);
  });

  test("a revoked device's session closes within 30 seconds, even if no tool is called", async () => {
    const { engine, clock, revoke, sessions } = setup();
    await openOne(sessions, { deviceId: "d1" });
    await openOne(sessions, { deviceId: "d2" });
    revoke("d1");

    clock.advance(29_999);
    await settle();
    assert.equal(engine.sessions[0]?.closed, false);
    clock.advance(1);
    await settle();

    assert.deepEqual(
      engine.sessions.map((session) => session.closed),
      [true, false],
    );
  });

  test("a device list that cannot be read counts as revoked (fail closed)", async () => {
    const engine = new FakeVoiceEngine();
    const sessions = new VoiceSessionManager({
      engine,
      shell: () => shellWith([project("p1")]),
      isRevoked: async () => {
        throw new Error("devices.json is damaged.");
      },
      clock: new FakeClock(),
      log: () => {},
    });
    await openOne(sessions);

    engine.last.emit({ type: "tool_call", callId: "c1", name: "list_projects", arguments: {} });
    await settle();

    assert.deepEqual(engine.last.toolResults, [
      { callId: "c1", result: { error: "device_revoked" } },
    ]);
  });
});

describe("failures and logs", () => {
  test("an engine that refuses the offer gives a failed result and a log line", async () => {
    const { engine, logs, sessions } = setup();
    engine.failNextOpen = true;

    const result = await sessions.open("d1", { sdpOffer: "v=0 offer", timeZone: null });

    assert.deepEqual(result, { status: "failed" });
    assert.deepEqual(logs, [
      "t3-voice: voice session for device d1 failed to open: The engine answered 400.",
    ]);
  });

  test("with no engine configured, sessions are unavailable", async () => {
    const sessions = new VoiceSessionManager({
      engine: null,
      shell: () => null,
      isRevoked: async () => false,
      clock: new FakeClock(),
      log: () => {},
    });

    assert.deepEqual(await sessions.open("d1", { sdpOffer: "v=0", timeZone: null }), {
      status: "unavailable",
    });
  });

  test("logs say when sessions open and end, never what was said or answered", async () => {
    const { engine, clock, logs, sessions } = setup({
      shell: shellWith(
        [project("p1", "Joombo")],
        [thread("t1", { title: "Secret task", status: "running" })],
      ),
    });
    const { sessionId } = await openOne(sessions);
    engine.last.emit({
      type: "tool_call",
      callId: "c1",
      name: "get_activity",
      arguments: { scope: "running" },
    });
    clock.advance(90_000);
    await sessions.close("d1", sessionId);

    assert.deepEqual(logs, [
      "t3-voice: voice session opened for device d1.",
      "t3-voice: voice session of device d1 ended after 1.5 min.",
    ]);
  });
});
