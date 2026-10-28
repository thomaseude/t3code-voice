// Seam 1: reading a thread by voice, through the core. The voice model's tool calls
// get_recent_messages and summarize_thread go through the core, with a fake T3, a fake
// summarizer, a fake voice engine and a fake clock.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ShellState } from "../../../src/core/shellState.ts";
import { TaskSummaries } from "../../../src/core/taskSummaries.ts";
import { VoiceSessionManager } from "../../../src/core/voiceSessions.ts";
import { VoiceTasks } from "../../../src/core/voiceTasks.ts";
import type { Thread } from "../../../src/ports/t3Backend.ts";
import { followedTask, project, thread } from "../builders.ts";
import {
  FakeClock,
  FakeSummarizer,
  FakeT3Backend,
  FakeVoiceEngine,
  InMemoryTaskRegistry,
  settle,
  unusedAnnouncements,
} from "../fakePorts.ts";

const RUNNING = thread("t1", { status: "running", latestRunId: "run-2" });

async function setup({ threads = [RUNNING] as Thread[] } = {}) {
  const backend = new FakeT3Backend();
  backend.messages.set("t1", [
    {
      role: "user",
      text: "Corrige les tests des Reviews",
      runId: "run-1",
      createdAt: "2026-10-26T10:00:00.000Z",
    },
    {
      role: "assistant",
      text: "J'ai corrigé les tests.",
      runId: "run-1",
      createdAt: "2026-10-26T10:05:00.000Z",
    },
    {
      role: "user",
      text: "Ajoute un test pour les notes vides",
      runId: "run-2",
      createdAt: "2026-10-26T10:10:00.000Z",
    },
    {
      role: "assistant",
      text: "J'écris le test.",
      runId: "run-2",
      createdAt: "2026-10-26T10:11:00.000Z",
    },
  ]);
  const registry = new InMemoryTaskRegistry();
  registry.tasks = [followedTask("t1", { spokenName: "tests Reviews" })];
  const state = new ShellState();
  state.apply({ type: "snapshot", sequence: 1, projects: [project("p1", "Joombo")], threads });
  let connected = true;
  const shell = () => (connected ? state : null);
  const clock = new FakeClock();
  const summarizer = new FakeSummarizer();
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const summaries = new TaskSummaries({ backend, summarizer, registry, clock, log });
  const tasks = new VoiceTasks({
    backend,
    registry,
    shell,
    summaries,
    clock,
    newId: () => "id",
    log,
  });
  const engine = new FakeVoiceEngine();
  const sessions = new VoiceSessionManager({
    engine,
    shell,
    tasks,
    announcements: unusedAnnouncements(clock),
    isRevoked: async () => false,
    clock,
    log,
  });
  await sessions.open("d1", { sdpOffer: "v=0", timeZone: null });
  let calls = 0;
  /** Calls a tool as the voice model would, and returns what the core answered. */
  async function call(name: string, args: unknown) {
    const callId = `c${++calls}`;
    engine.last.emit({ type: "tool_call", callId, name, arguments: args });
    await settle();
    return engine.last.toolResults.find((each) => each.callId === callId)?.result;
  }
  return {
    backend,
    summarizer,
    state,
    engine,
    clock,
    logs,
    call,
    disconnect: () => {
      connected = false;
    },
  };
}

describe("get_recent_messages", () => {
  test("gives the last messages of a task, oldest first, as short spoken excerpts", async () => {
    const { call } = await setup();

    const result = await call("get_recent_messages", { task: "tests Reviews", count: 2 });

    assert.deepEqual(result, {
      task: "tests Reviews",
      project: "Joombo",
      status: "running",
      messages: [
        {
          from: "user",
          time: "2026-10-26T10:10:00.000Z",
          excerpt: "Ajoute un test pour les notes vides",
          cut: false,
        },
        {
          from: "agent",
          time: "2026-10-26T10:11:00.000Z",
          excerpt: "J'écris le test.",
          cut: false,
        },
      ],
      older: "m2",
    });
  });

  test("reads older messages with the cursor the last answer gave", async () => {
    const { call } = await setup();
    const newest = (await call("get_recent_messages", { task: "tests Reviews", count: 2 })) as {
      older: string;
    };

    const result = (await call("get_recent_messages", {
      task: "tests Reviews",
      count: 2,
      before: newest.older,
    })) as { messages: Array<{ excerpt: string }>; older: string | null };

    assert.deepEqual(
      result.messages.map((message) => message.excerpt),
      ["Corrige les tests des Reviews", "J'ai corrigé les tests."],
    );
    assert.equal(result.older, null);
  });

  test("reads 3 messages when the model does not say how many", async () => {
    const { call } = await setup();

    const result = (await call("get_recent_messages", { task: "tests Reviews" })) as {
      messages: unknown[];
    };

    assert.equal(result.messages.length, 3);
  });

  test("code, paths and links are named instead of read, and a long message is cut", async () => {
    const { call, backend } = await setup();
    backend.messages.set("t1", [
      {
        role: "assistant",
        text: [
          "## Fait",
          "J'ai modifié **/home/thomas/projects/joombo/app/models/review.rb** et `spec/models/review_spec.rb`.",
          "```ruby\ndef empty?\n  notes.blank?\nend\n```",
          "Voir [la PR](https://github.com/thomaseude/joombo/pull/12).",
        ].join("\n\n"),
        runId: "run-2",
        createdAt: "2026-10-26T10:11:00.000Z",
      },
      {
        role: "assistant",
        text: `Les tests passent. ${"Encore un détail. ".repeat(40)}`,
        runId: "run-2",
        createdAt: "2026-10-26T10:12:00.000Z",
      },
    ]);

    const result = (await call("get_recent_messages", { task: "tests Reviews", count: 2 })) as {
      messages: Array<{ excerpt: string; cut: boolean }>;
    };

    assert.deepEqual(result.messages[0], {
      from: "agent",
      time: "2026-10-26T10:11:00.000Z",
      excerpt: "Fait. J'ai modifié review.rb et review_spec.rb. (bloc de code) Voir la PR.",
      cut: false,
    });
    const long = result.messages[1];
    assert.equal(long?.cut, true);
    assert.ok(long !== undefined && long.excerpt.length <= 401, `${long?.excerpt.length}`);
    assert.ok(long?.excerpt.startsWith("Les tests passent. Encore un détail."));
  });

  test("works for a thread nobody follows, found by its title", async () => {
    const { call, backend } = await setup({
      threads: [RUNNING, thread("t2", { title: "Refonte page offre", status: "completed" })],
    });
    backend.messages.set("t2", [
      { role: "user", text: "Refais la page offre", runId: null, createdAt: "2026-10-26T09:00Z" },
    ]);

    const result = (await call("get_recent_messages", { task: "refonte page offre" })) as {
      task: string;
      messages: Array<{ excerpt: string }>;
    };

    assert.equal(result.task, "Refonte page offre");
    assert.deepEqual(
      result.messages.map((message) => message.excerpt),
      ["Refais la page offre"],
    );
  });

  test("when T3 does not answer, it says so and logs no message text", async () => {
    const { call, backend, logs } = await setup();
    backend.failNextCommand = "read";

    const result = await call("get_recent_messages", { task: "tests Reviews" });

    assert.deepEqual(result, { error: "t3_failed" });
    assert.ok(logs.length > 0);
    assert.ok(logs.every((line) => !line.includes("Reviews") && !line.includes("tests")));
  });

  test("an unknown task lists the followed ones", async () => {
    const { call } = await setup();

    const result = await call("get_recent_messages", { task: "migration base" });

    assert.deepEqual(result, { error: "unknown_task", followed: ["tests Reviews"] });
  });

  test("a count that is not a whole number above zero is refused", async () => {
    const { call } = await setup();

    for (const count of [0, -1, 2.5, "trois"]) {
      assert.deepEqual(await call("get_recent_messages", { task: "tests Reviews", count }), {
        error: "invalid_arguments",
      });
    }
  });

  test("while T3 is away, it says so", async () => {
    const { call, disconnect } = await setup();
    disconnect();

    assert.deepEqual(await call("get_recent_messages", { task: "tests Reviews" }), {
      error: "t3_unavailable",
    });
  });
});

describe("summarize_thread", () => {
  test("a running task gives T3's status and a summary of the whole conversation", async () => {
    const { call, summarizer } = await setup();

    const result = await call("summarize_thread", { task: "tests Reviews" });

    assert.deepEqual(summarizer.conversations, [
      {
        status: "running",
        messages: [
          { role: "user", text: "Corrige les tests des Reviews" },
          { role: "assistant", text: "J'ai corrigé les tests." },
          { role: "user", text: "Ajoute un test pour les notes vides" },
          { role: "assistant", text: "J'écris le test." },
        ],
        omitted: 0,
      },
    ]);
    assert.deepEqual(result, {
      task: "tests Reviews",
      project: "Joombo",
      status: "running",
      summary: "Résumé (running) de 4 messages, dont : J'écris le test.",
      too_long: false,
    });
  });

  test("asking again with no new message reads the summary already made", async () => {
    const { call, summarizer } = await setup();

    await call("summarize_thread", { task: "tests Reviews" });
    const again = (await call("summarize_thread", { task: "tests Reviews" })) as {
      summary: string;
    };

    assert.equal(summarizer.conversations.length, 1);
    assert.equal(again.summary, "Résumé (running) de 4 messages, dont : J'écris le test.");
  });

  test("a new message, a longer streamed message or a new status makes a new summary", async () => {
    const { call, summarizer, backend, state } = await setup();
    const messages = backend.messages.get("t1") ?? [];
    await call("summarize_thread", { task: "tests Reviews" });

    backend.messages.set("t1", [
      ...messages.slice(0, -1),
      { ...(messages.at(-1) as (typeof messages)[number]), text: "J'écris le test. Il passe." },
    ]);
    await call("summarize_thread", { task: "tests Reviews" });
    state.apply({
      type: "thread.updated",
      sequence: 2,
      thread: { ...RUNNING, status: "completed" },
    });
    await call("summarize_thread", { task: "tests Reviews" });
    backend.messages.set("t1", [
      ...(backend.messages.get("t1") ?? []),
      { role: "user", text: "Merci", runId: null, createdAt: "2026-10-26T10:20:00.000Z" },
    ]);
    await call("summarize_thread", { task: "tests Reviews" });

    assert.equal(summarizer.conversations.length, 4);
  });

  test("a failed task also gives its cause and when it can resume", async () => {
    const { call } = await setup({
      threads: [
        thread("t1", {
          status: "failed",
          latestRunId: "run-2",
          lastError: {
            message: "Usage limit reached",
            failureClass: "usage_limit",
            resumesAt: "2026-10-26T15:00:00.000Z",
            autoResume: false,
          },
        }),
      ],
    });

    const result = await call("summarize_thread", { task: "tests Reviews" });

    assert.deepEqual(result, {
      task: "tests Reviews",
      project: "Joombo",
      status: "failed",
      summary: "Résumé (failed) de 4 messages, dont : J'écris le test.",
      too_long: false,
      failure: "usage_limit",
      resumes_at: "2026-10-26T15:00:00.000Z",
    });
  });

  test("a long conversation keeps the first request and the latest messages, and says it is too long", async () => {
    const { call, summarizer, backend } = await setup();
    const filler = "x".repeat(3_000);
    backend.messages.set("t1", [
      { role: "user", text: "La demande de départ", runId: null, createdAt: "2026-10-26T09:00Z" },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "assistant" as const,
        text: `Étape ${index}. ${filler}`,
        runId: null,
        createdAt: `2026-10-26T10:0${index}Z`,
      })),
    ]);

    const result = (await call("summarize_thread", { task: "tests Reviews" })) as {
      too_long: boolean;
    };

    const request = summarizer.conversations[0];
    assert.equal(request?.messages[0]?.text, "La demande de départ");
    assert.ok(request?.messages.at(-1)?.text.startsWith("Étape 9."));
    assert.ok((request?.omitted ?? 0) > 0);
    const length = request?.messages.reduce((total, message) => total + message.text.length, 0);
    assert.ok(length !== undefined && length <= 16_000, `${length}`);
    assert.equal(result.too_long, true);
  });

  test("a thread with no message has no summary", async () => {
    const { call, summarizer, backend } = await setup();
    backend.messages.set("t1", []);

    const result = (await call("summarize_thread", { task: "tests Reviews" })) as {
      summary: unknown;
    };

    assert.equal(result.summary, null);
    assert.equal(summarizer.conversations.length, 0);
  });

  test("when the summarizer fails, T3's status still comes, and the log has no message text", async () => {
    const { call, summarizer, logs } = await setup();
    summarizer.failNext = true;

    const result = await call("summarize_thread", { task: "tests Reviews" });

    assert.deepEqual(result, {
      task: "tests Reviews",
      project: "Joombo",
      status: "running",
      summary: null,
      too_long: false,
    });
    assert.ok(logs.length > 0);
    assert.ok(logs.every((line) => !line.includes("test")));
  });

  test("a summary that takes too long is given up after 30 s", async () => {
    const { engine, summarizer, clock } = await setup();
    summarizer.gate = new Promise(() => {});

    engine.last.emit({
      type: "tool_call",
      callId: "slow",
      name: "summarize_thread",
      arguments: { task: "tests Reviews" },
    });
    await settle();
    assert.equal(engine.last.toolResults.length, 0);
    clock.advance(30_000);
    await settle();
    const result = engine.last.toolResults[0]?.result as { summary: unknown; status: string };

    assert.equal(result.summary, null);
    assert.equal(result.status, "running");
  });

  test("a thread nobody follows is found by its title", async () => {
    const { call, backend } = await setup({
      threads: [RUNNING, thread("t2", { title: "Refonte page offre", status: "completed" })],
    });
    backend.messages.set("t2", [
      { role: "assistant", text: "Page refaite.", runId: null, createdAt: "2026-10-26T09:00Z" },
    ]);

    const result = await call("summarize_thread", { task: "refonte page offre" });

    assert.deepEqual(result, {
      task: "Refonte page offre",
      project: "Joombo",
      status: "completed",
      summary: "Résumé (completed) de 1 messages, dont : Page refaite.",
      too_long: false,
    });
  });

  test("several threads with that title: the user picks one", async () => {
    const { call } = await setup({
      threads: [
        RUNNING,
        thread("t2", { title: "Page offre Joombo" }),
        thread("t3", { title: "Page offre Totem" }),
      ],
    });

    assert.deepEqual(await call("summarize_thread", { task: "page offre" }), {
      status: "ambiguous_task",
      choices: ["Page offre Joombo", "Page offre Totem"],
    });
  });

  test("an unknown task lists the followed ones", async () => {
    const { call } = await setup();

    assert.deepEqual(await call("summarize_thread", { task: "migration base" }), {
      error: "unknown_task",
      followed: ["tests Reviews"],
    });
  });

  test("while T3 is away, it says so instead of a stale status", async () => {
    const { call, disconnect } = await setup();
    disconnect();

    assert.deepEqual(await call("summarize_thread", { task: "tests Reviews" }), {
      error: "t3_unavailable",
    });
  });
});
