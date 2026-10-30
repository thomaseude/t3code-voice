// The Codex voice adapter through a fake app-server: which Codex it accepts, what it asks
// Codex and how it reads Codex's notifications.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CodexLiveEngine } from "../../../../src/adapters/codex-live/codexLiveEngine.ts";
import {
  VoiceEngineError,
  type VoiceEvent,
  type VoiceSessionRequest,
} from "../../../../src/ports/voiceEngine.ts";
import { FakeClock, settle } from "../../fakePorts.ts";
import { FakeCodexRpc, THREAD } from "./fakes.ts";

const REQUEST: VoiceSessionRequest = {
  sdpOffer: "v=0 offer",
  instructions: "Tu es l'assistant vocal.",
  tools: [
    {
      name: "list_projects",
      description: "List the projects.",
      parameters: { type: "object", properties: {} },
    },
  ],
};

function setup({ startAppServer = undefined as (() => FakeCodexRpc) | undefined } = {}) {
  const rpc = new FakeCodexRpc();
  const clock = new FakeClock();
  const engine = new CodexLiveEngine({
    startAppServer: startAppServer ?? (() => rpc),
    clock,
    acceptedVersions: ["0.163.0"],
    threadModel: "gpt-6.1-terra",
    threadReasoningEffort: "low",
  });
  const events: VoiceEvent[] = [];
  const open = () => engine.openSession(REQUEST, (event) => events.push(event));
  return { rpc, clock, engine, events, open };
}

describe("the Codex it runs on", () => {
  test("its minutes are billed to the ChatGPT plan, not in dollars", () => {
    const { engine } = setup();
    assert.equal(engine.billing, "plan_quota");
  });

  test("initializes the app-server before it starts a thread", async () => {
    const { rpc, open } = setup();
    await open();
    assert.deepEqual(
      rpc.requests.slice(0, 2).map((request) => request.method),
      ["initialize", "thread/start"],
    );
    assert.equal(rpc.sent("initialize")[0].capabilities.experimentalApi, true);
    assert.deepEqual(rpc.notifications, [{ method: "initialized", params: undefined }]);
  });

  test("refuses a Codex version that is not pinned, and stops its app-server", async () => {
    const { rpc, open } = setup();
    rpc.version = "0.166.0";
    await assert.rejects(open(), (error: Error) => {
      assert.ok(error instanceof VoiceEngineError);
      assert.match(error.message, /0\.166\.0 is not a tested version \(tested: 0\.163\.0\)/);
      return true;
    });
    assert.equal(rpc.closed, true);
    assert.deepEqual(rpc.sent("thread/start"), []);
  });

  test("fails when the app-server does not answer within 10 s, and stops it", async () => {
    const { rpc, clock, open } = setup();
    rpc.answersInitialize = false;
    const opening = open();
    await settle();
    clock.advance(10_000);
    await assert.rejects(opening, VoiceEngineError);
    assert.equal(rpc.closed, true);
  });

  test("fails when the codex binary cannot start", async () => {
    const { open } = setup({
      startAppServer: () => {
        throw new Error("spawn codex ENOENT");
      },
    });
    await assert.rejects(open(), VoiceEngineError);
  });
});

describe("opening a Codex voice session", () => {
  test("starts a Codex thread with no shell and the tools as dynamic tools", async () => {
    const { rpc, open } = setup();
    await open();
    const [thread] = rpc.sent("thread/start");
    assert.equal(thread.sandbox, "read-only");
    assert.equal(thread.approvalPolicy, "never");
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.model, "gpt-6.1-terra");
    assert.deepEqual(thread.config, {
      features: { shell_tool: false },
      model_reasoning_effort: "low",
    });
    assert.equal(thread.developerInstructions, REQUEST.instructions);
    assert.deepEqual(thread.dynamicTools, [
      {
        type: "function",
        name: "list_projects",
        description: "List the projects.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  test("starts realtime over WebRTC with the offer and returns Codex's SDP answer", async () => {
    const { rpc, open } = setup();
    const session = await open();
    const [realtime] = rpc.sent("thread/realtime/start");
    assert.equal(realtime.threadId, THREAD);
    assert.deepEqual(realtime.transport, { type: "webrtc", sdp: "v=0 offer" });
    assert.equal(realtime.version, "v3");
    assert.equal(realtime.clientManagedHandoffs, true);
    assert.equal(realtime.prompt, REQUEST.instructions);
    assert.equal(session.sdpAnswer, "v=0 answer");
  });

  test("fails and stops the app-server when no SDP answer comes in 15 s", async () => {
    const { rpc, clock, open } = setup();
    rpc.answersOffer = false;
    const opening = open();
    await settle();
    clock.advance(15_000);
    await assert.rejects(opening, VoiceEngineError);
    assert.equal(rpc.closed, true);
  });

  test("fails without reporting a closed session when Codex refuses the offer", async () => {
    const { rpc, events, open } = setup();
    rpc.answersOffer = false;
    const opening = open();
    await settle();
    rpc.notifyClient("thread/realtime/error", { threadId: THREAD, message: "invalid_offer" });
    await assert.rejects(opening, VoiceEngineError);
    assert.equal(rpc.closed, true);
    assert.deepEqual(events, []);
  });
});

describe("when Codex fails while a session opens", () => {
  test("a refused realtime start fails the open, and the companion keeps running", async () => {
    const { rpc, events, open } = setup();
    rpc.realtimeStartError = new Error("realtime call refused");
    await assert.rejects(open(), VoiceEngineError);
    await settle();
    assert.equal(rpc.closed, true);
    assert.deepEqual(events, []);
  });

  test("an app-server that exits during the realtime start fails the open", async () => {
    const { rpc, open } = setup();
    rpc.answersOffer = false;
    const opening = open();
    await settle();
    rpc.exit();
    await assert.rejects(opening, VoiceEngineError);
    await settle();
  });

  test("fails within 15 s when Codex does not answer the thread start, and stops it", async () => {
    const { rpc, clock, open } = setup();
    rpc.answersThread = false;
    const opening = open();
    await settle();
    clock.advance(15_000);
    await assert.rejects(opening, VoiceEngineError);
    assert.equal(rpc.closed, true);
  });

  test("fails within 15 s when Codex does not answer the realtime start, and stops it", async () => {
    const { rpc, clock, open } = setup();
    const opening = open();
    rpc.answersThread = false;
    await settle();
    clock.advance(15_000);
    await assert.rejects(opening, VoiceEngineError);
    assert.equal(rpc.closed, true);
  });
});

describe("during a Codex voice session", () => {
  test("hands a tool call of the Codex thread to the core and sends its result back", async () => {
    const { rpc, events, open } = setup();
    const session = await open();
    const call = rpc.ask("item/tool/call", {
      threadId: THREAD,
      turnId: "turn_1",
      callId: "call_1",
      namespace: null,
      tool: "list_projects",
      arguments: { all: true },
    });
    assert.deepEqual(events, [
      { type: "tool_call", callId: "call_1", name: "list_projects", arguments: { all: true } },
    ]);
    assert.equal(call.reply, undefined);
    session.resolveToolCall("call_1", { projects: ["t3code"] });
    assert.deepEqual(call.reply, {
      success: true,
      contentItems: [{ type: "inputText", text: '{"projects":["t3code"]}' }],
    });
  });

  test("declines any approval the Codex thread asks for", async () => {
    const { rpc, open } = setup();
    await open();
    const approval = rpc.ask("item/commandExecution/requestApproval", { threadId: THREAD });
    assert.deepEqual(approval.reply, { decision: "decline" });
  });

  test("speaks the Codex thread's final answer when its turn completes, not its commentary", async () => {
    const { rpc, open } = setup();
    await open();
    const item = (phase: string, text: string) => ({
      threadId: THREAD,
      turnId: "turn_1",
      item: { type: "agentMessage", id: phase, text, phase },
    });
    rpc.notifyClient("item/completed", item("commentary", "Je regarde."));
    rpc.notifyClient("item/completed", item("final_answer", "Deux tâches tournent."));
    assert.deepEqual(rpc.sent("thread/realtime/appendSpeech"), []);
    rpc.notifyClient("turn/completed", { threadId: THREAD, turn: { id: "turn_1" } });
    assert.deepEqual(rpc.sent("thread/realtime/appendSpeech"), [
      { threadId: THREAD, text: "Deux tâches tournent." },
    ]);
  });

  test("reports who speaks from the transcript", async () => {
    const { rpc, events, open } = setup();
    await open();
    rpc.notifyClient("thread/realtime/transcript/delta", {
      threadId: THREAD,
      role: "user",
      delta: "oui",
    });
    rpc.notifyClient("thread/realtime/transcript/delta", {
      threadId: THREAD,
      role: "assistant",
      delta: "Ok",
    });
    assert.deepEqual(events, [
      { type: "speech", speaker: "user", text: "oui" },
      { type: "speech", speaker: "assistant" },
    ]);
  });

  test("speak() appends speech to the realtime session", async () => {
    const { rpc, open } = setup();
    const session = await open();
    session.speak("La tâche est finie.");
    assert.deepEqual(rpc.sent("thread/realtime/appendSpeech"), [
      { threadId: THREAD, text: "La tâche est finie." },
    ]);
  });
});

describe("ending a Codex voice session", () => {
  test("close() stops realtime, stops the app-server and reports closed once", async () => {
    const { rpc, events, open } = setup();
    const session = await open();
    await session.close();
    await session.close();
    assert.deepEqual(rpc.sent("thread/realtime/stop"), [{ threadId: THREAD }]);
    assert.equal(rpc.closed, true);
    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
  });

  test("close() ends within 10 s when Codex does not answer the realtime stop", async () => {
    const { rpc, clock, events, open } = setup();
    const session = await open();
    rpc.answersStop = false;
    const closing = session.close();
    await settle();
    clock.advance(10_000);
    await closing;
    assert.equal(rpc.closed, true);
    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
  });

  test("an app-server that exits ends the session as failed", async () => {
    const { rpc, events, open } = setup();
    await open();
    rpc.exit();
    assert.deepEqual(events, [{ type: "closed", reason: "failed" }]);
  });
});
