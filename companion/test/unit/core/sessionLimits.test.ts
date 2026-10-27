// Seam 1: when a voice session stops by itself (silence, daily budget) and what it costs,
// through the session manager with a fake voice engine, a fake registry and a fake clock.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AnnouncementQueue } from "../../../src/core/announcementQueue.ts";
import { ShellState } from "../../../src/core/shellState.ts";
import { VoiceSessionManager } from "../../../src/core/voiceSessions.ts";
import type { SessionLimits } from "../../../src/ports/configStore.ts";
import type { Thread } from "../../../src/ports/t3Backend.ts";
import type { UsageRecord } from "../../../src/ports/taskRegistry.ts";
import { followedTask, project, thread } from "../builders.ts";
import {
  FakeClock,
  FakePushSender,
  FakeVoiceEngine,
  InMemoryTaskRegistry,
  settle,
  unusedVoiceTasks,
} from "../fakePorts.ts";

const SECOND = 1_000;
const MINUTE = 60_000;
const TODAY = "2026-10-26";

function shellWith(threads: Thread[]): ShellState {
  const state = new ShellState();
  state.apply({ type: "snapshot", sequence: 1, projects: [project("p1", "Joombo")], threads });
  return state;
}

const running = (id: string) => thread(id, { status: "running", latestRunId: "r1" });
const completed = (id: string) => thread(id, { status: "completed", latestRunId: "r1" });

function setup({
  limits = {} as Partial<SessionLimits>,
  usage = [] as UsageRecord[],
  followed = [] as string[],
  threads = [] as Thread[],
} = {}) {
  const clock = new FakeClock();
  const engine = new FakeVoiceEngine();
  const registry = new InMemoryTaskRegistry();
  for (const record of usage) registry.saveUsage(record);
  for (const threadId of followed) registry.follow(followedTask(threadId));
  let shell: ShellState | null = shellWith(threads);
  const logs: string[] = [];
  const announcements = new AnnouncementQueue({
    registry,
    shell: () => shell,
    push: new FakePushSender(),
    clock,
    log: () => {},
  });
  const sessions = new VoiceSessionManager({
    engine,
    shell: () => shell,
    tasks: unusedVoiceTasks(clock),
    announcements,
    registry,
    limits: { idleMinutes: 3, idleMinutesWhileTasksRun: 20, dailyBudgetUsd: 10, ...limits },
    budgetTimeZone: "Europe/Paris",
    isRevoked: async () => false,
    clock,
    log: (line) => logs.push(line),
  });
  return {
    clock,
    engine,
    registry,
    announcements,
    sessions,
    logs,
    setThreads: (next: Thread[] | null) => {
      shell = next === null ? null : shellWith(next);
    },
    async open(deviceId = "d1") {
      const result = await sessions.open(deviceId, { sdpOffer: "v=0 offer", timeZone: null });
      assert.equal(result.status, "opened");
      return (result as { sessionId: string }).sessionId;
    },
  };
}

function usageRecord(fields: Partial<UsageRecord>): UsageRecord {
  return {
    sessionId: "earlier",
    engine: "fake-live",
    day: TODAY,
    startedAt: "2026-10-26T08:00:00.000Z",
    minutes: 10,
    estimatedCostUsd: 0.5,
    ...fields,
  };
}

const WARNING = /je coupe dans 30 secondes/;
const IDLE_STOP = /Je coupe la conversation/;

describe("stopping after a silence", () => {
  test("warns after 2 min 30 of silence, then stops at 3 min", async () => {
    const { clock, engine, open } = setup();
    await open();

    clock.advance(150 * SECOND - 1);
    assert.deepEqual(engine.last.spoken, []);

    clock.advance(1);
    assert.equal(engine.last.spoken.length, 1);
    assert.match(engine.last.spoken[0] ?? "", WARNING);

    clock.advance(30 * SECOND);
    assert.match(engine.last.spoken[1] ?? "", IDLE_STOP);
    assert.equal(engine.last.closed, false);

    // A short goodbye, then the session closes.
    clock.advance(5 * SECOND);
    await settle();
    assert.equal(engine.last.closed, true);
  });

  test("the user speaking starts the silence again", async () => {
    const { clock, engine, open } = setup();
    await open();

    clock.advance(140 * SECOND);
    engine.last.emit({ type: "speech", speaker: "user", text: "Je suis là." });
    clock.advance(150 * SECOND - 1);
    assert.deepEqual(engine.last.spoken, []);

    clock.advance(1);
    assert.match(engine.last.spoken[0] ?? "", WARNING);
  });

  test("speaking after the warning keeps the session open", async () => {
    const { clock, engine, open } = setup();
    await open();

    clock.advance(150 * SECOND);
    engine.last.emit({ type: "speech", speaker: "user", text: "Je suis là." });
    clock.advance(60 * SECOND);
    await settle();

    assert.equal(engine.last.spoken.length, 1);
    assert.equal(engine.last.closed, false);
  });

  test("the assistant speaking alone does not start the silence again", async () => {
    // Its own warning is spoken too: it must not keep the session open.
    const { clock, engine, open } = setup();
    await open();

    clock.advance(150 * SECOND);
    engine.last.emit({ type: "speech", speaker: "assistant" });
    clock.advance(30 * SECOND);

    assert.match(engine.last.spoken[1] ?? "", IDLE_STOP);
  });

  test("a tool call starts the silence again", async () => {
    const { clock, engine, open } = setup();
    await open();

    clock.advance(140 * SECOND);
    engine.last.emit({ type: "tool_call", callId: "c1", name: "list_projects", arguments: {} });
    await settle();
    clock.advance(150 * SECOND - 1);

    assert.deepEqual(engine.last.spoken, []);
  });

  test("an announcement starts the silence again", async () => {
    const { clock, engine, announcements, open } = setup({
      followed: ["t1"],
      threads: [completed("t1")],
    });
    await open();

    clock.advance(140 * SECOND);
    announcements.announce({
      threadId: "t1",
      eventKey: "completed:r1",
      state: "completed",
      spokenName: "tâche t1",
      project: "Joombo",
      summary: null,
      error: null,
    });
    assert.equal(engine.last.spoken.length, 1);
    clock.advance(150 * SECOND - 1);

    assert.equal(engine.last.spoken.length, 1);
    clock.advance(1);
    assert.match(engine.last.spoken[1] ?? "", WARNING);
  });

  test("waits 20 minutes while a followed task runs", async () => {
    const { clock, engine, open } = setup({ followed: ["t1"], threads: [running("t1")] });
    await open();

    clock.advance(19 * MINUTE + 30 * SECOND - 1);
    assert.deepEqual(engine.last.spoken, []);

    clock.advance(1);
    assert.match(engine.last.spoken[0] ?? "", WARNING);
    clock.advance(30 * SECOND);
    assert.match(engine.last.spoken[1] ?? "", IDLE_STOP);
  });

  test("a task nobody follows does not keep the session open", async () => {
    const { clock, engine, open } = setup({ threads: [running("t1")] });
    await open();

    clock.advance(150 * SECOND);

    assert.match(engine.last.spoken[0] ?? "", WARNING);
  });

  test("when the followed task stops running, it still warns 30 s before it stops", async () => {
    const { clock, engine, open, setThreads } = setup({
      followed: ["t1"],
      threads: [running("t1")],
    });
    await open();

    clock.advance(5 * MINUTE);
    // Interrupted in T3: nothing to announce, and the session is already silent for 5 min.
    setThreads([thread("t1", { status: "interrupted", latestRunId: "r1" })]);
    clock.advance(5 * SECOND);
    assert.match(engine.last.spoken[0] ?? "", WARNING);

    clock.advance(30 * SECOND - 1);
    assert.equal(engine.last.spoken.length, 1);
    clock.advance(1);
    assert.match(engine.last.spoken[1] ?? "", IDLE_STOP);
  });

  test("while T3 is away, it waits 20 minutes: a followed task may be running", async () => {
    const { clock, engine, open, setThreads } = setup({ followed: ["t1"] });
    await open();
    setThreads(null);

    clock.advance(10 * MINUTE);

    assert.deepEqual(engine.last.spoken, []);
  });

  test("the durations come from the settings", async () => {
    const { clock, engine, open } = setup({ limits: { idleMinutes: 1 } });
    await open();

    clock.advance(30 * SECOND);

    assert.match(engine.last.spoken[0] ?? "", WARNING);
  });
});

describe("mute", () => {
  test("muted time counts as silence, and the warning says how to go on", async () => {
    const { clock, engine, sessions, open } = setup();
    const sessionId = await open();

    assert.equal(sessions.signal("d1", sessionId, "mute"), true);
    clock.advance(100 * SECOND);
    // What the engine may still hear does not count while the app says it is muted.
    engine.last.emit({ type: "speech", speaker: "user", text: "Je suis là." });
    clock.advance(50 * SECOND);

    assert.match(engine.last.spoken[0] ?? "", /sourdine/);
    assert.match(engine.last.spoken[0] ?? "", /Réactive le micro/);
  });

  test("unmuting starts the silence again", async () => {
    const { clock, engine, sessions, open } = setup();
    const sessionId = await open();
    sessions.signal("d1", sessionId, "mute");

    clock.advance(160 * SECOND);
    sessions.signal("d1", sessionId, "unmute");
    clock.advance(60 * SECOND);
    await settle();

    assert.equal(engine.last.spoken.length, 1);
    assert.equal(engine.last.closed, false);
  });

  test("announcements are still spoken while muted", async () => {
    const { engine, sessions, announcements, open } = setup({
      followed: ["t1"],
      threads: [completed("t1")],
    });
    const sessionId = await open();
    sessions.signal("d1", sessionId, "mute");

    announcements.announce({
      threadId: "t1",
      eventKey: "completed:r1",
      state: "completed",
      spokenName: "tâche t1",
      project: "Joombo",
      summary: null,
      error: null,
    });

    assert.equal(engine.last.spoken.length, 1);
  });

  test("a signal for another device's session, or an ended one, is refused", async () => {
    const { sessions, open } = setup();
    const sessionId = await open("d1");

    assert.equal(sessions.signal("d2", sessionId, "mute"), false);
    assert.equal(sessions.signal("d1", "unknown", "mute"), false);
    await sessions.close("d1", sessionId);
    assert.equal(sessions.signal("d1", sessionId, "mute"), false);
  });
});

describe("usage", () => {
  test("each session records its minutes and estimated cost for the day", async () => {
    const { clock, engine, registry, sessions, open } = setup();
    const sessionId = await open();

    clock.advance(2 * MINUTE);
    engine.last.emit({ type: "speech", speaker: "user", text: "Je suis là." });
    await sessions.close("d1", sessionId);

    assert.deepEqual(registry.usageOn(TODAY), [
      {
        sessionId,
        engine: "fake-live",
        day: TODAY,
        startedAt: "2026-10-26T10:00:00.000Z",
        minutes: 2,
        estimatedCostUsd: 0.1,
      },
    ]);
  });

  test("an open session's usage is saved every minute, so a crash loses little", async () => {
    const { clock, engine, registry, open } = setup();
    await open();

    clock.advance(MINUTE);
    engine.last.emit({ type: "speech", speaker: "user", text: "Je suis là." });

    assert.equal(registry.usageOn(TODAY)[0]?.minutes, 1);
  });

  test("a session the engine or the phone ended is recorded too", async () => {
    const { clock, engine, registry, open } = setup();
    await open();

    clock.advance(30 * SECOND);
    engine.last.emit({ type: "closed", reason: "closed" });

    assert.equal(registry.usageOn(TODAY)[0]?.minutes, 0.5);
  });

  test("the log tells the session's cost and the day's", async () => {
    const { clock, logs, sessions, open } = setup({ usage: [usageRecord({})] });
    const sessionId = await open();

    clock.advance(2 * MINUTE);
    await sessions.close("d1", sessionId);

    assert.ok(
      logs.some((line) =>
        line.includes("ended after 2.0 min (~$0.10; today ~$0.60 of the $10.00 budget)"),
      ),
      logs.join("\n"),
    );
  });
});

describe("the daily budget", () => {
  test("no session opens once today's sessions cost the budget", async () => {
    const { engine, sessions } = setup({ usage: [usageRecord({ estimatedCostUsd: 10 })] });

    const result = await sessions.open("d1", { sdpOffer: "v=0 offer", timeZone: null });

    assert.deepEqual(result, { status: "budget_reached" });
    assert.equal(engine.sessions.length, 0);
  });

  test("yesterday's sessions do not count", async () => {
    const { sessions } = setup({
      usage: [usageRecord({ day: "2026-10-25", estimatedCostUsd: 10 })],
    });

    const result = await sessions.open("d1", { sdpOffer: "v=0 offer", timeZone: null });

    assert.equal(result.status, "opened");
  });

  test("warns once at 80 %, at a gap in the conversation", async () => {
    const { clock, engine, open } = setup({
      usage: [usageRecord({ estimatedCostUsd: 7.9 })],
    });
    await open();

    // $7.90 + 2 min at $0.05 = $8.00, while the user speaks.
    clock.advance(2 * MINUTE - SECOND);
    engine.last.emit({ type: "speech", speaker: "user", text: "Je suis là." });
    clock.advance(SECOND);
    assert.deepEqual(engine.last.spoken, []);

    clock.advance(5 * SECOND);
    assert.equal(engine.last.spoken.length, 1);
    assert.match(engine.last.spoken[0] ?? "", /80 % du budget voix du jour/);

    engine.last.emit({ type: "speech", speaker: "user", text: "Je suis là." });
    clock.advance(MINUTE);
    assert.equal(engine.last.spoken.length, 1);
  });

  test("at 100 %, the session says so and stops, and no new one opens", async () => {
    const { clock, engine, sessions, open } = setup({
      usage: [usageRecord({ estimatedCostUsd: 9.95 })],
    });
    await open();

    clock.advance(MINUTE);
    assert.match(engine.last.spoken.at(-1) ?? "", /budget voix du jour est atteint/);
    clock.advance(5 * SECOND);
    await settle();
    assert.equal(engine.last.closed, true);

    const result = await sessions.open("d1", { sdpOffer: "v=0 offer", timeZone: null });
    assert.deepEqual(result, { status: "budget_reached" });
  });

  test("every open session counts toward the budget", async () => {
    const { clock, engine, open } = setup({ limits: { dailyBudgetUsd: 0.1 } });
    await open("d1");
    await open("d2");

    clock.advance(MINUTE);

    assert.ok(engine.sessions.every((session) => /atteint/.test(session.spoken.at(-1) ?? "")));
  });
});
