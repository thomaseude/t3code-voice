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
