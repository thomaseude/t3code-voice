// The Codex voice adapter (spike) through a fake app-server: what it asks Codex and how it
// reads Codex's notifications. No real Codex: a session draws from the user's plan quota.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CodexLiveEngine,
  type CodexRpc,
  type WireJson,
} from "../../../../src/adapters/codex-live/codexLiveEngine.ts";
import {
  VoiceEngineError,
  type VoiceEvent,
  type VoiceSessionRequest,
} from "../../../../src/ports/voiceEngine.ts";
import { FakeClock, settle } from "../../fakePorts.ts";

const THREAD = "thr_1";

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

class FakeCodexRpc implements CodexRpc {
  readonly requests: Array<{ method: string; params: WireJson }> = [];
  /** Whether `thread/realtime/start` is followed by Codex's SDP answer. */
  answersOffer = true;
  closed = false;
  private notificationListeners: Array<(method: string, params: WireJson) => void> = [];
  private requestListeners: Array<
    (method: string, params: WireJson, reply: (result: WireJson) => void) => void
  > = [];
  private exitListeners: Array<() => void> = [];

  async request(method: string, params: WireJson): Promise<WireJson> {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: THREAD } };
    if (method === "thread/realtime/start" && this.answersOffer) {
      setImmediate(() =>
        this.notify("thread/realtime/sdp", { threadId: THREAD, sdp: "v=0 answer" }),
      );
    }
    return {};
  }

  onNotification(listener: (method: string, params: WireJson) => void) {
    this.notificationListeners.push(listener);
  }
  onRequest(
    listener: (method: string, params: WireJson, reply: (result: WireJson) => void) => void,
  ) {
    this.requestListeners.push(listener);
  }
  onExit(listener: () => void) {
    this.exitListeners.push(listener);
  }
  close() {
    this.closed = true;
  }

  notify(method: string, params: WireJson) {
    for (const listener of this.notificationListeners) listener(method, params);
  }

  /** Sends a request to the client and returns what it replied, or undefined. */
  ask(method: string, params: WireJson): { reply: WireJson } {
    const answer: { reply: WireJson } = { reply: undefined };
    for (const listener of this.requestListeners) {
      listener(method, params, (result) => {
        answer.reply = result;
      });
    }
    return answer;
  }

  exit() {
    for (const listener of this.exitListeners) listener();
  }

  sent(method: string): WireJson[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}

function setup() {
  const rpc = new FakeCodexRpc();
  const clock = new FakeClock();
  const engine = new CodexLiveEngine({
    startAppServer: async () => rpc,
    clock,
    brainModel: "gpt-6.1-terra",
    brainEffort: "low",
  });
  const events: VoiceEvent[] = [];
  const open = () => engine.openSession(REQUEST, (event) => events.push(event));
  return { rpc, clock, events, open };
}

describe("opening a Codex voice session", () => {
  test("starts a brain thread with no shell and the tools as dynamic tools", async () => {
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
    rpc.notify("thread/realtime/error", { threadId: THREAD, message: "invalid_offer" });
    await assert.rejects(opening, VoiceEngineError);
    assert.equal(rpc.closed, true);
    assert.deepEqual(events, []);
  });
});

describe("during a Codex voice session", () => {
  test("hands a brain tool call to the core and sends its result back", async () => {
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

  test("declines any approval the brain asks for", async () => {
    const { rpc, open } = setup();
    await open();
    const approval = rpc.ask("item/commandExecution/requestApproval", { threadId: THREAD });
    assert.deepEqual(approval.reply, { decision: "decline" });
  });

  test("speaks the brain's final answer when its turn completes, not its commentary", async () => {
    const { rpc, open } = setup();
    await open();
    const item = (phase: string, text: string) => ({
      threadId: THREAD,
      turnId: "turn_1",
      item: { type: "agentMessage", id: phase, text, phase },
    });
    rpc.notify("item/completed", item("commentary", "Je regarde."));
    rpc.notify("item/completed", item("final_answer", "Deux tâches tournent."));
    assert.deepEqual(rpc.sent("thread/realtime/appendSpeech"), []);
    rpc.notify("turn/completed", { threadId: THREAD, turn: { id: "turn_1" } });
    assert.deepEqual(rpc.sent("thread/realtime/appendSpeech"), [
      { threadId: THREAD, text: "Deux tâches tournent." },
    ]);
  });

  test("reports who speaks from the transcript", async () => {
    const { rpc, events, open } = setup();
    await open();
    rpc.notify("thread/realtime/transcript/delta", {
      threadId: THREAD,
      role: "user",
      delta: "oui",
    });
    rpc.notify("thread/realtime/transcript/delta", {
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

  test("an app-server that exits ends the session as failed", async () => {
    const { rpc, events, open } = setup();
    await open();
    rpc.exit();
    assert.deepEqual(events, [{ type: "closed", reason: "failed" }]);
  });
});
