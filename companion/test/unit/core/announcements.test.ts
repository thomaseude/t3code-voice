// Seam 1: spoken announcements for followed tasks, through the core. T3 events feed a shell
// state, a fake clock drives the 5 s settle and the quiet gaps, and fake ports record what is
// spoken, pushed and summarized.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AnnouncementQueue } from "../../../src/core/announcementQueue.ts";
import { TaskWatcher } from "../../../src/core/announcements.ts";
import { ShellState } from "../../../src/core/shellState.ts";
import { TaskSummaries } from "../../../src/core/taskSummaries.ts";
import { VoiceSessionManager } from "../../../src/core/voiceSessions.ts";
import { VoiceTasks } from "../../../src/core/voiceTasks.ts";
import type { Thread } from "../../../src/ports/t3Backend.ts";
import type { FollowedTask } from "../../../src/ports/taskRegistry.ts";
import { followedTask, project, thread } from "../builders.ts";
import {
  FakeClock,
  FakePushSender,
  FakeSummarizer,
  FakeT3Backend,
  FakeVoiceEngine,
  InMemoryTaskRegistry,
  settle,
} from "../fakePorts.ts";

const RUNNING = thread("t1", { status: "running", latestRunId: "run-1" });

function setup({
  followed = [followedTask("t1", { spokenName: "tests Reviews" })] as FollowedTask[],
  threads = [RUNNING] as Thread[],
  registry = new InMemoryTaskRegistry(),
  clock = new FakeClock(),
} = {}) {
  if (registry.tasks.length === 0) registry.tasks = [...followed];
  const backend = new FakeT3Backend();
  backend.messages.set("t1", [
    { role: "user", text: "Corrige les tests", runId: "run-1", createdAt: "2026-10-26T10:00:00Z" },
    {
      role: "assistant",
      text: "J'ai corrigé les tests.",
      runId: "run-1",
      createdAt: "2026-10-26T10:05:00Z",
    },
  ]);
  const summarizer = new FakeSummarizer();
  const push = new FakePushSender();
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const state = new ShellState();
  state.apply({ type: "snapshot", sequence: 1, projects: [project("p1", "Joombo")], threads });
  let connected = true;
  const shell = () => (connected ? state : null);
  const queue = new AnnouncementQueue({ registry, shell, push, clock, log });
  const summaries = new TaskSummaries({ backend, summarizer, registry, clock, log });
  const watcher = new TaskWatcher({ registry, shell, summaries, queue, clock, log });
  const engine = new FakeVoiceEngine();
  const tasks = new VoiceTasks({
    backend,
    registry,
    shell,
    summaries,
    clock,
    newId: () => "id",
    log,
  });
  const sessions = new VoiceSessionManager({
    engine,
    shell,
    tasks,
    announcements: queue,
    isRevoked: async () => false,
    clock,
    log,
  });
  let sequence = 1;
  /** T3 reports a change of the thread, and the watcher looks at it. */
  const update = (id: string, fields: Partial<Thread>) => {
    const current = state.threads.get(id) ?? thread(id);
    sequence++;
    state.apply({ type: "thread.updated", sequence, thread: { ...current, ...fields } });
    watcher.check();
  };
  /** Opens a voice session on a device in Paris and returns it. */
  const open = async (deviceId = "d1") => {
    await sessions.open(deviceId, { sdpOffer: "v=0", timeZone: "Europe/Paris" });
    return engine.last;
  };
  /** Moves time forward and lets the summaries and pushes finish. */
  const wait = async (ms: number) => {
    clock.advance(ms);
    await settle();
  };
  return {
    backend,
    summarizer,
    push,
    logs,
    registry,
    state,
    clock,
    queue,
    watcher,
    engine,
    sessions,
    update,
    open,
    wait,
    disconnect: () => {
      connected = false;
    },
    reconnect: (threadsNow: Thread[]) => {
      connected = true;
      sequence++;
      state.apply({
        type: "snapshot",
        sequence,
        projects: [project("p1", "Joombo")],
        threads: threadsNow,
      });
      watcher.check();
    },
  };
}

const FINISHED = "«tests Reviews» sur Joombo est terminée : Résumé de : J'ai corrigé les tests.";

describe("a followed task that completes", () => {
  test("is announced with its summary once it stayed completed for 5 seconds", async () => {
    const { open, update, wait, summarizer } = setup();
    const session = await open();

    update("t1", { status: "completed" });
    await wait(4_999);
    assert.deepEqual(session.spoken, []);
    await wait(1);

    assert.deepEqual(session.spoken, [FINISHED]);
    assert.deepEqual(summarizer.requests, [
      { request: "Corrige les tests", output: "J'ai corrigé les tests.", outcome: "completed" },
    ]);
  });

  test("is not announced when the agent continues within 5 seconds", async () => {
    const { open, update, wait, summarizer } = setup();
    const session = await open();

    update("t1", { status: "completed" });
    await wait(3_000);
    update("t1", { status: "running", latestRunId: "run-2" });
    await wait(10_000);

    assert.deepEqual(session.spoken, []);
    assert.deepEqual(summarizer.requests, []);
  });

  test("a queued follow-up that starts cancels it too", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    update("t1", { status: "completed" });
    await wait(2_000);
    update("t1", { status: "queued" });
    await wait(10_000);

    assert.deepEqual(session.spoken, []);
  });

  test("the run that follows is announced when it completes in turn", async () => {
    const { open, update, wait, backend } = setup();
    const session = await open();
    backend.messages.set("t1", [
      { role: "assistant", text: "Tout est fait.", runId: "run-2", createdAt: "2026-10-26T11:00Z" },
    ]);

    update("t1", { status: "completed" });
    await wait(1_000);
    update("t1", { status: "running", latestRunId: "run-2" });
    await wait(1_000);
    update("t1", { status: "completed" });
    await wait(5_000);

    assert.deepEqual(session.spoken, [
      "«tests Reviews» sur Joombo est terminée : Résumé de : Tout est fait.",
    ]);
  });

  test("a run that only captures its checkpoint is still running, not waiting for the user", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    update("t1", { status: "waiting" });
    await wait(10_000);

    assert.deepEqual(session.spoken, []);
  });

  test("background work that wakes the agent holds the announcement", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    update("t1", { status: "completed", backgroundTaskKinds: ["subagent"] });
    await wait(10_000);
    assert.deepEqual(session.spoken, []);
    update("t1", { backgroundTaskKinds: [] });
    await wait(5_000);

    assert.deepEqual(session.spoken, [FINISHED]);
  });

  test("without a summary, the announcement still says the task is finished", async () => {
    const { open, update, wait, summarizer } = setup();
    const session = await open();
    summarizer.failNext = true;

    update("t1", { status: "completed" });
    await wait(5_000);

    assert.deepEqual(session.spoken, ["«tests Reviews» sur Joombo est terminée."]);
  });

  test("a summary that takes more than 30 seconds is given up", async () => {
    const { open, update, wait, summarizer } = setup();
    const session = await open();
    summarizer.gate = new Promise(() => {});

    update("t1", { status: "completed" });
    await wait(5_000);
    await wait(29_999);
    assert.deepEqual(session.spoken, []);
    await wait(1);

    assert.deepEqual(session.spoken, ["«tests Reviews» sur Joombo est terminée."]);
  });

  test("a thread T3 cannot read is announced without a summary", async () => {
    const { open, update, wait, backend } = setup();
    const session = await open();
    backend.failNextCommand = "read";

    update("t1", { status: "completed" });
    await wait(5_000);

    assert.deepEqual(session.spoken, ["«tests Reviews» sur Joombo est terminée."]);
  });
});

describe("an announcement that is no longer true", () => {
  test("a completion whose summary arrives after the run went on is never told", async () => {
    const { open, update, wait, summarizer } = setup();
    const session = await open();
    let release = () => {};
    summarizer.gate = new Promise((resolve) => {
      release = resolve;
    });

    update("t1", { status: "completed" });
    await wait(5_000);
    update("t1", {
      status: "running",
      latestRunId: "run-2",
      pendingRequest: { id: "r2", kind: "command", blocking: true },
    });
    await wait(0);
    release();
    await wait(0);
    update("t1", { updatedAt: "2026-10-26T10:10:00.000Z" });
    await wait(10_000);

    assert.deepEqual(session.spoken, ["«tests Reviews» sur Joombo demande une autorisation."]);
  });

  test("an announcement waiting for a gap is dropped when its event is over", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    session.emit({ type: "speech", speaker: "user", text: "Bonjour" });
    update("t1", { pendingRequest: { id: "r1", kind: "user_input", blocking: true } });
    await wait(500);
    // Answered in the T3 app before the user stopped talking.
    update("t1", { pendingRequest: null });
    await wait(10_000);

    assert.deepEqual(session.spoken, []);
  });
});

describe("a followed task that fails or needs the user", () => {
  test("a failure is announced at once, with its cause and when the run can resume", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    update("t1", {
      status: "failed",
      lastError: {
        message: "Usage limit reached",
        failureClass: "usage_limit",
        resumesAt: "2026-10-26T15:00:00.000Z",
        autoResume: false,
      },
    });
    await wait(0);

    // The device is in Paris, one hour ahead of UTC on that day.
    assert.deepEqual(session.spoken, [
      "«tests Reviews» sur Joombo a échoué : limite d'utilisation atteinte. Elle pourra reprendre à 16 h 00.",
    ]);
  });

  test("a failure's summary is made right after it is told, for get_task_details", async () => {
    const { open, update, wait, summarizer, registry } = setup();
    await open();

    update("t1", { status: "failed" });
    await wait(0);

    assert.deepEqual(summarizer.requests, [
      { request: "Corrige les tests", output: "J'ai corrigé les tests.", outcome: "failed" },
    ]);
    assert.notEqual(registry.summaryOf("t1", "failed:run-1"), null);
  });

  test("a failure's late summary does not replace the summary of the run after it", async () => {
    const { open, update, wait, summarizer, registry, backend, engine } = setup();
    await open();
    let release = () => {};
    summarizer.nextGates.push(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    update("t1", { status: "failed" });
    await wait(0);
    backend.messages.set("t1", [
      { role: "assistant", text: "Tout est fait.", runId: "run-2", createdAt: "2026-10-26T11:00Z" },
    ]);
    update("t1", { status: "running", latestRunId: "run-2" });
    update("t1", { status: "completed" });
    await wait(5_000);
    release();
    await wait(0);

    assert.deepEqual(registry.summaryOf("t1", "completed:run-2"), {
      short: "Résumé de : Tout est fait.",
      long: "Résumé long de : Tout est fait.",
    });
    const session = engine.last;
    session.emit({
      type: "tool_call",
      callId: "c1",
      name: "get_task_details",
      arguments: { task: "tests Reviews" },
    });
    await settle();
    assert.equal(
      (session.toolResults[0]?.result as { summary?: string } | undefined)?.summary,
      "Résumé long de : Tout est fait.",
    );
    assert.equal(summarizer.requests.length, 2);
  });

  test("a summary that lands while T3 is away is kept all the same", async () => {
    const { open, update, wait, summarizer, registry, disconnect } = setup();
    await open();
    let release = () => {};
    summarizer.nextGates.push(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    update("t1", { status: "failed" });
    await wait(0);
    disconnect();
    release();
    await wait(0);

    assert.notEqual(registry.summaryOf("t1", "failed:run-1"), null);
  });

  test("a run T3 resumes by itself, on another day, says so", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    update("t1", {
      status: "failed",
      lastError: {
        message: "Usage limit reached",
        failureClass: "usage_limit",
        resumesAt: "2026-10-27T08:30:00.000Z",
        autoResume: true,
      },
    });
    await wait(0);

    assert.deepEqual(session.spoken, [
      "«tests Reviews» sur Joombo a échoué : limite d'utilisation atteinte. Elle reprendra toute seule le 27 octobre à 09 h 30.",
    ]);
  });

  test("a failure with no known cause says so plainly", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    update("t1", { status: "failed", lastError: null });
    await wait(0);

    assert.deepEqual(session.spoken, ["«tests Reviews» sur Joombo a échoué : erreur inconnue."]);
  });

  test("a question and a permission request are announced at once", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    update("t1", { pendingRequest: { id: "r1", kind: "user_input", blocking: true } });
    await wait(0);
    update("t1", { pendingRequest: null });
    update("t1", { pendingRequest: { id: "r2", kind: "command", blocking: true } });
    await wait(3_000);

    assert.deepEqual(session.spoken, [
      "«tests Reviews» sur Joombo attend ta réponse.",
      "«tests Reviews» sur Joombo demande une autorisation.",
    ]);
  });

  test("a thread nobody follows is never announced", async () => {
    const { open, update, wait } = setup({ followed: [followedTask("t9")] });
    const session = await open();

    update("t1", { status: "failed" });
    update("t1", { status: "completed" });
    await wait(10_000);

    assert.deepEqual(session.spoken, []);
  });

  test("a task unfollowed while its completion settles is not announced", async () => {
    const { open, update, wait, registry } = setup();
    const session = await open();

    update("t1", { status: "completed" });
    await wait(1_000);
    registry.unfollow("t1");
    update("t1", { updatedAt: "2026-10-26T10:01:00.000Z" });
    await wait(10_000);

    assert.deepEqual(session.spoken, []);
  });
});

describe("each event is announced once", () => {
  test("the same event seen again after a reconnect is not announced again", async () => {
    const { open, update, wait, disconnect, reconnect, state } = setup();
    const session = await open();
    update("t1", { status: "failed" });
    await wait(5_000);

    disconnect();
    reconnect([...state.threads.values()]);
    await wait(10_000);

    assert.equal(session.spoken.length, 1);
  });

  test("a completion that was settling when T3 dropped is announced once T3 is back", async () => {
    const { open, update, wait, disconnect, reconnect, state } = setup();
    const session = await open();
    update("t1", { status: "completed" });
    await wait(2_000);

    disconnect();
    await wait(10_000);
    assert.deepEqual(session.spoken, []);
    reconnect([...state.threads.values()]);
    await wait(5_000);

    assert.deepEqual(session.spoken, [FINISHED]);
  });

  test("after a restart, an event already announced is not told again", async () => {
    const registry = new InMemoryTaskRegistry();
    const first = setup({ registry });
    const session = await first.open();
    first.update("t1", { status: "failed" });
    await first.wait(0);
    assert.equal(session.spoken.length, 1);

    // A new companion process: same database, fresh snapshot from T3.
    const second = setup({ registry, threads: [...first.state.threads.values()] });
    const again = await second.open();
    second.watcher.check();
    await second.wait(10_000);

    assert.deepEqual(again.spoken, []);
  });

  test("after a restart, an event that happened while the companion was down is announced", async () => {
    const registry = new InMemoryTaskRegistry();
    registry.tasks = [
      followedTask("t1", {
        spokenName: "tests Reviews",
        lastAnnouncedState: "waiting_for_input",
        lastEventKey: "waiting_for_input:r1",
      }),
    ];
    const done = thread("t1", { status: "completed", latestRunId: "run-1" });
    const { open, watcher, wait } = setup({ registry, threads: [done] });
    const session = await open();

    watcher.check();
    await wait(5_000);

    assert.deepEqual(session.spoken, [FINISHED]);
  });

  test("an announcement is recorded in the registry once spoken", async () => {
    const { open, update, wait, registry } = setup();
    await open();

    update("t1", { status: "completed" });
    await wait(5_000);

    const [task] = registry.followedTasks();
    assert.equal(task?.lastAnnouncedState, "completed");
    assert.equal(task?.lastEventKey, "completed:run-1");
  });

  test("following a thread that already finished does not announce its past", async () => {
    const done = thread("t2", { title: "Page offre", status: "completed", latestRunId: "r" });
    const { open, wait, engine, watcher } = setup({ followed: [], threads: [RUNNING, done] });
    const session = await open();

    session.emit({
      type: "tool_call",
      callId: "c1",
      name: "follow_thread",
      arguments: { task: "Page offre", spoken_name: "page offre" },
    });
    await settle();
    watcher.check();
    await wait(10_000);

    assert.deepEqual(engine.last.toolResults[0]?.result, {
      status: "followed",
      task: "page offre",
      project: "Joombo",
      state: "completed",
    });
    assert.deepEqual(session.spoken, []);
  });
});

describe("when the companion stops", () => {
  test("a completion settling, or one T3 reports afterwards, is never announced", async () => {
    const { open, update, wait, watcher } = setup({
      followed: [
        followedTask("t1", { spokenName: "tests Reviews" }),
        followedTask("t2", { spokenName: "page offre" }),
      ],
      threads: [RUNNING, thread("t2", { status: "running" })],
    });
    const session = await open();
    update("t1", { status: "completed" });

    watcher.stop();
    update("t2", { status: "completed" });
    await wait(10_000);

    assert.deepEqual(session.spoken, []);
  });
});

describe("speaking at the next gap", () => {
  test("an announcement waits while the user speaks, then 2 quiet seconds", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    session.emit({ type: "speech", speaker: "user", text: "Bonjour" });
    update("t1", { status: "failed" });
    await wait(1_500);
    session.emit({ type: "speech", speaker: "user", text: "Bonjour" });
    await wait(1_999);
    assert.deepEqual(session.spoken, []);
    await wait(1);

    assert.equal(session.spoken.length, 1);
  });

  test("an announcement waits while the assistant speaks", async () => {
    const { open, update, wait } = setup();
    const session = await open();

    session.emit({ type: "speech", speaker: "assistant" });
    update("t1", { status: "failed" });
    await wait(1_000);
    assert.deepEqual(session.spoken, []);
    await wait(1_000);

    assert.equal(session.spoken.length, 1);
  });

  test("an announcement waits for a tool call to be answered, then for the read-back", async () => {
    const { open, update, wait, summarizer } = setup({
      threads: [thread("t1", { status: "completed", latestRunId: "run-1" })],
      followed: [followedTask("t1", { spokenName: "tests Reviews" })],
    });
    const session = await open();
    let release = () => {};
    summarizer.gate = new Promise((resolve) => {
      release = resolve;
    });
    session.emit({
      type: "tool_call",
      callId: "c1",
      name: "get_task_details",
      arguments: { task: "tests Reviews" },
    });
    await settle();

    update("t1", { pendingRequest: { id: "r1", kind: "command", blocking: true } });
    await wait(10_000);
    assert.deepEqual(session.spoken, []);
    release();
    await settle();
    assert.equal(session.toolResults.length, 1);
    await wait(1_999);
    assert.deepEqual(session.spoken, []);
    await wait(1);

    assert.deepEqual(session.spoken, ["«tests Reviews» sur Joombo demande une autorisation."]);
  });

  test("announcements queued during speech are spoken together, in order", async () => {
    const { open, update, wait } = setup({
      followed: [
        followedTask("t1", { spokenName: "tests Reviews" }),
        followedTask("t2", { spokenName: "page offre" }),
      ],
      threads: [RUNNING, thread("t2", { status: "running" })],
    });
    const session = await open();

    session.emit({ type: "speech", speaker: "user", text: "Bonjour" });
    update("t2", { status: "failed" });
    update("t1", { pendingRequest: { id: "r1", kind: "user_input", blocking: true } });
    await wait(0);
    assert.deepEqual(session.spoken, []);
    await wait(2_000);

    assert.deepEqual(session.spoken, [
      "«page offre» sur Joombo a échoué : erreur inconnue. «tests Reviews» sur Joombo attend ta réponse.",
    ]);
  });

  test("a muted session still hears announcements", async () => {
    // Mute happens on the phone: the companion never holds announcements for it.
    const { open, update, wait } = setup();
    const session = await open();

    update("t1", { status: "failed" });
    await wait(0);

    assert.equal(session.spoken.length, 1);
  });
});

describe("when no voice session can speak", () => {
  test("with no session open, the announcement is pushed at once and recorded", async () => {
    const { update, wait, push, registry } = setup();

    update("t1", { status: "completed" });
    await wait(5_000);

    assert.deepEqual(push.sent, [
      { threadId: "t1", spokenName: "tests Reviews", project: "Joombo", state: "completed" },
    ]);
    assert.equal(registry.followedTasks()[0]?.lastEventKey, "completed:run-1");
  });

  test("a pushed announcement is not spoken in a session opened later", async () => {
    const { update, wait, push, open } = setup();
    update("t1", { status: "failed" });
    await wait(0);

    const session = await open();
    await wait(10_000);

    assert.equal(push.sent.length, 1);
    assert.deepEqual(session.spoken, []);
  });

  test("a session that ends with announcements still waiting pushes them", async () => {
    const { open, update, wait, push, sessions } = setup();
    const session = await open();
    session.emit({ type: "speech", speaker: "user", text: "Bonjour" });
    update("t1", { status: "failed" });
    await wait(500);

    await sessions.closeAll();
    await wait(10_000);

    assert.deepEqual(session.spoken, []);
    assert.deepEqual(push.sent, [
      { threadId: "t1", spokenName: "tests Reviews", project: "Joombo", state: "failed" },
    ]);
  });

  test("a push that fails is logged, without the task's name", async () => {
    const { update, wait, push, logs } = setup();
    push.failNext = true;

    update("t1", { status: "failed" });
    await wait(0);

    assert.ok(logs.some((line) => /could not push/.test(line)));
    assert.ok(logs.every((line) => !line.includes("tests Reviews")));
  });
});

describe("get_task_details", () => {
  async function details(
    context: Awaited<ReturnType<typeof setup>>,
    args: unknown = { task: "tests Reviews" },
  ) {
    const session = await context.open();
    session.emit({ type: "tool_call", callId: "c1", name: "get_task_details", arguments: args });
    await settle();
    return session.toolResults.at(-1)?.result;
  }

  test("a finished task gives T3's status and the long summary already made", async () => {
    const context = setup();
    context.update("t1", { status: "completed" });
    await context.wait(5_000);

    const result = await details(context);

    assert.deepEqual(result, {
      task: "tests Reviews",
      project: "Joombo",
      status: "completed",
      summary: "Résumé long de : J'ai corrigé les tests.",
    });
    assert.equal(context.summarizer.requests.length, 1);
  });

  test("a finished task with no summary yet is summarized now", async () => {
    const context = setup({
      threads: [thread("t1", { status: "completed", latestRunId: "run-1" })],
    });

    const result = await details(context);

    assert.equal(
      (result as { summary: string }).summary,
      "Résumé long de : J'ai corrigé les tests.",
    );
  });

  test("a failed task also gives its cause and when it can resume", async () => {
    const context = setup({
      threads: [
        thread("t1", {
          status: "failed",
          latestRunId: "run-1",
          lastError: {
            message: "Usage limit reached",
            failureClass: "usage_limit",
            resumesAt: "2026-10-26T15:00:00.000Z",
            autoResume: false,
          },
        }),
      ],
    });

    const result = await details(context);

    assert.deepEqual(result, {
      task: "tests Reviews",
      project: "Joombo",
      status: "failed",
      summary: "Résumé long de : J'ai corrigé les tests.",
      failure: "usage_limit",
      resumes_at: "2026-10-26T15:00:00.000Z",
    });
  });

  test("a running task gives its status and no summary", async () => {
    const result = await details(setup());

    assert.deepEqual(result, {
      task: "tests Reviews",
      project: "Joombo",
      status: "running",
      summary: null,
    });
  });

  test("a thread nobody follows is found by its title, and summarized without being kept", async () => {
    const offer = thread("t2", {
      title: "Refonte page offre",
      status: "completed",
      latestRunId: "run-9",
    });
    const context = setup({ threads: [RUNNING, offer] });
    context.backend.messages.set("t2", [
      { role: "assistant", text: "Page refaite.", runId: "run-9", createdAt: "2026-10-26T09:00Z" },
    ]);

    const result = await details(context, { task: "refonte page offre" });

    assert.deepEqual(result, {
      task: "Refonte page offre",
      project: "Joombo",
      status: "completed",
      summary: "Résumé long de : Page refaite.",
    });
    assert.equal(context.registry.summaryOf("t2", "completed:run-9"), null);
  });

  test("several threads with that title: the user picks one", async () => {
    const context = setup({
      threads: [
        RUNNING,
        thread("t2", { title: "Page offre Joombo" }),
        thread("t3", { title: "Page offre Totem" }),
      ],
    });

    const result = await details(context, { task: "page offre" });

    assert.deepEqual(result, {
      status: "ambiguous_task",
      choices: ["Page offre Joombo", "Page offre Totem"],
    });
  });

  test("two threads with the same title are told apart by their project", async () => {
    const context = setup({
      threads: [
        RUNNING,
        thread("t2", { title: "Fix tests", projectId: "p1" }),
        thread("t3", { title: "Fix tests", projectId: "p2" }),
      ],
    });
    context.state.apply({ type: "project.updated", sequence: 50, project: project("p2", "Totem") });

    assert.deepEqual(await details(context, { task: "fix tests" }), {
      status: "ambiguous_task",
      choices: ["Fix tests sur Joombo", "Fix tests sur Totem"],
    });
    assert.deepEqual(await details(context, { task: "Fix tests sur Totem" }), {
      task: "Fix tests",
      project: "Totem",
      status: "idle",
      summary: null,
    });
  });

  test("an unknown task lists the followed ones", async () => {
    const result = await details(setup(), { task: "migration base" });

    assert.deepEqual(result, { error: "unknown_task", followed: ["tests Reviews"] });
  });

  test("while T3 is away, it says so instead of a stale status", async () => {
    const context = setup();
    context.disconnect();

    assert.deepEqual(await details(context), { error: "t3_unavailable" });
  });
});
