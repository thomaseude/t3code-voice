// The GPT-Live adapter through a fake OpenAI transport: what it sends and how it reads
// OpenAI's events. No real call: they cost money.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GptLiveEngine } from "../../../../src/adapters/gpt-live/gptLiveEngine.ts";
import type { VoiceEvent, VoiceSessionRequest } from "../../../../src/ports/voiceEngine.ts";
import { FakeClock, settle } from "../../fakePorts.ts";
import { FakeGptLiveTransport } from "./fakes.ts";

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

function setup() {
  const transport = new FakeGptLiveTransport();
  const clock = new FakeClock();
  const engine = new GptLiveEngine({
    transport,
    clock,
    model: "gpt-live-1",
    voice: "brise",
    delegationModel: "gpt-5.6-terra",
  });
  const events: VoiceEvent[] = [];
  const open = () => engine.openSession(REQUEST, (event) => events.push(event));
  return { transport, clock, events, open };
}

describe("opening a GPT-Live session", () => {
  test("sends the offer with the model, the voice, and the tools for the delegation model", async () => {
    const { transport, open } = setup();

    const session = await open();

    assert.deepEqual(transport.created, [
      {
        session: {
          model: "gpt-live-1",
          instructions: "Tu es l'assistant vocal.",
          audio: { output: { voice: "brise" } },
          // The phone may only end the session or mute itself: tool results and settings
          // come from the companion alone.
          client: {
            data_channel: {
              allowed_client_events: [
                "session.close",
                "session.input_audio.mute",
                "session.input_audio.unmute",
              ],
            },
          },
          delegation: {
            type: "responses",
            responses: {
              model: "gpt-5.6-terra",
              instructions: "Tu es l'assistant vocal.",
              tools: [
                {
                  type: "function",
                  name: "list_projects",
                  description: "List the projects.",
                  parameters: { type: "object", properties: {} },
                },
              ],
              tool_choice: "auto",
              // One call per turn: the companion resumes the model after each result.
              parallel_tool_calls: false,
            },
          },
        },
        transport: { type: "webrtc", sdp: "v=0 offer" },
      },
    ]);
    assert.equal(session.sdpAnswer, "v=0 answer");
    assert.deepEqual(transport.attached, ["live_123"]);
  });
});

describe("when OpenAI refuses", () => {
  test("a refusal gives its status and OpenAI's error code, never the rest of the body", async () => {
    const { transport, open } = setup();
    transport.answer = {
      status: 400,
      body: {
        error: { code: "invalid_sdp", message: "Offer contains a=fingerprint:sha-256 AB:CD" },
      },
    };

    await assert.rejects(open(), {
      name: "VoiceEngineError",
      message: "OpenAI refused the voice session (400 invalid_sdp).",
    });
    assert.deepEqual(transport.attached, []);
  });

  test("a control channel that cannot attach fails the open", async () => {
    const { transport, open } = setup();
    transport.attachFailures = 1;

    await assert.rejects(open(), {
      name: "VoiceEngineError",
      message: "Could not attach the control channel to the GPT-Live session.",
    });
  });
});

/** A function call as the delegation model sends it, wrapped in a `response.event`. */
function functionCall(callId: string, name: string, args: string) {
  return {
    type: "response.event",
    delegation_id: "item_1",
    event: {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: callId, name, arguments: args },
    },
  };
}

describe("tool calls", () => {
  test("a function call of the delegation model becomes a tool call with parsed arguments", async () => {
    const { transport, events, open } = setup();
    await open();

    transport.socket.receive(functionCall("call_1", "get_activity", '{"scope":"running"}'));
    transport.socket.receive(functionCall("call_2", "get_activity", "{not json"));
    // Other events, finished items that are not calls, and unknown shapes are ignored.
    transport.socket.receive({ type: "session.usage.updated", usage: { seconds: 3 } });
    transport.socket.receive({
      type: "response.event",
      event: { type: "response.output_item.done", item: { type: "message" } },
    });
    transport.socket.receive({ type: "response.event" });

    assert.deepEqual(events, [
      {
        type: "tool_call",
        callId: "call_1",
        name: "get_activity",
        arguments: { scope: "running" },
      },
      { type: "tool_call", callId: "call_2", name: "get_activity", arguments: null },
    ]);
  });

  test("a result goes back as a function output, then the model resumes", async () => {
    const { transport, open } = setup();
    const session = await open();
    transport.socket.receive(functionCall("call_1", "list_projects", "{}"));

    session.resolveToolCall("call_1", { projects: ["Joombo"] });
    // A call that is not pending (unknown, or already answered) is not sent.
    session.resolveToolCall("call_1", { projects: [] });
    session.resolveToolCall("call_9", { projects: [] });

    const sent = transport.socket.sent.map(({ event_id: _id, ...event }) => event);
    assert.deepEqual(sent, [
      {
        type: "response.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"projects":["Joombo"]}',
        },
      },
      { type: "response.create" },
    ]);
    const ids = transport.socket.sent.map((event) => event.event_id);
    assert.equal(new Set(ids).size, 2);
  });
});

describe("speech activity", () => {
  test("a piece of transcript says who is speaking now, never what was said", async () => {
    const { transport, events, open } = setup();
    await open();

    transport.socket.receive({ type: "session.input_transcript.delta", delta: "Lance Claude" });
    transport.socket.receive({ type: "session.output_transcript.delta", delta: "C'est parti" });
    // An empty piece is no speech: GPT-Live streams silence too.
    transport.socket.receive({ type: "session.output_transcript.delta", delta: "" });

    assert.deepEqual(events, [
      { type: "speech", speaker: "user" },
      { type: "speech", speaker: "assistant" },
    ]);
  });
});

describe("speaking and closing", () => {
  test("speak appends session-wide commentary, outside any delegation", async () => {
    const { transport, open } = setup();
    const session = await open();

    session.speak("«Tests Reviews» sur Joombo est terminée.");

    assert.deepEqual(
      transport.socket.sent.map(({ event_id: _id, ...event }) => event),
      [
        {
          type: "session.commentary.append",
          delegation_id: null,
          content: "«Tests Reviews» sur Joombo est terminée.",
        },
      ],
    );
  });

  test("close asks OpenAI to close, waits for session.closed, then reports it once", async () => {
    const { transport, events, open } = setup();
    const session = await open();

    const closing = session.close();
    assert.deepEqual(transport.socket.sentTypes(), ["session.close"]);
    assert.equal(transport.socket.closed, false);
    transport.socket.receive({ type: "session.closed" });
    await closing;
    await session.close();

    assert.equal(transport.socket.closed, true);
    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
    assert.deepEqual(transport.socket.sentTypes(), ["session.close"]);
  });

  test("close gives up waiting 20 seconds after it was asked, and drops the channel", async () => {
    const { transport, clock, events, open } = setup();
    const session = await open();

    const closing = session.close();
    clock.advance(19_999);
    assert.deepEqual(events, []);
    clock.advance(1);
    await closing;

    assert.equal(transport.socket.closed, true);
    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
  });

  test("OpenAI closing the session ends it", async () => {
    const { transport, events, open } = setup();
    await open();

    transport.socket.receive({ type: "session.closed" });

    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
    assert.equal(transport.socket.closed, true);
  });
});

describe("when the control channel drops", () => {
  test("the adapter attaches again, and tool calls arrive on the new channel", async () => {
    const { transport, clock, events, open } = setup();
    await open();
    const first = transport.socket;

    first.drop();
    clock.advance(1_000);
    await settle();
    transport.socket.receive(functionCall("call_1", "list_projects", "{}"));

    assert.notEqual(transport.socket, first);
    assert.deepEqual(transport.attached, ["live_123", "live_123"]);
    assert.deepEqual(events, [
      { type: "tool_call", callId: "call_1", name: "list_projects", arguments: {} },
    ]);
  });

  test("after 3 failed attaches (1, 2 and 4 s apart) the session counts as failed", async () => {
    const { transport, clock, events, open } = setup();
    await open();
    transport.attachFailures = 3;

    transport.socket.drop();
    for (const delay of [1_000, 2_000, 4_000]) {
      assert.deepEqual(events, []);
      clock.advance(delay);
      await settle();
    }

    assert.equal(transport.attached.length, 4);
    assert.deepEqual(events, [{ type: "closed", reason: "failed" }]);
  });

  test("events sent while the channel is down go out once a new one has stayed up 10 s", async () => {
    const { transport, clock, open } = setup();
    const session = await open();
    transport.socket.receive(functionCall("call_1", "list_projects", "{}"));
    transport.socket.drop();

    session.resolveToolCall("call_1", { projects: ["Joombo"] });
    clock.advance(1_000);
    await settle();
    assert.deepEqual(transport.socket.sentTypes(), []);
    clock.advance(10_000);

    assert.deepEqual(transport.socket.sentTypes(), ["response.item.create", "response.create"]);
  });

  test("events stay queued when the new channel drops before it is usable", async () => {
    const { transport, clock, open } = setup();
    const session = await open();
    transport.socket.receive(functionCall("call_1", "list_projects", "{}"));
    transport.socket.drop();
    session.resolveToolCall("call_1", { projects: ["Joombo"] });

    clock.advance(1_000);
    await settle();
    // A short-lived channel: it even sends an event, then drops.
    transport.socket.receive({ type: "error", error: { code: "server_error" } });
    transport.socket.drop();
    clock.advance(2_000);
    await settle();
    clock.advance(10_000);

    assert.deepEqual(transport.socket.sentTypes(), ["response.item.create", "response.create"]);
  });

  test("a close asked while the channel is down goes out as soon as a channel attaches", async () => {
    const { transport, clock, events, open } = setup();
    const session = await open();
    transport.attachFailures = 1;
    transport.socket.drop();

    const closing = session.close();
    clock.advance(1_000);
    await settle();
    clock.advance(2_000);
    await settle();

    assert.deepEqual(transport.socket.sentTypes(), ["session.close"]);
    transport.socket.receive({ type: "session.closed" });
    await closing;
    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
  });

  test("the 20 s close deadline counts from the first close really sent", async () => {
    const { transport, clock, events, open } = setup();
    const session = await open();
    transport.attachFailures = 2;
    transport.socket.drop();

    void session.close();
    for (const delay of [1_000, 2_000, 4_000]) {
      clock.advance(delay);
      await settle();
    }
    // Sent at 7 s, on the channel that attached then.
    assert.deepEqual(transport.socket.sentTypes(), ["session.close"]);
    clock.advance(19_999);
    assert.deepEqual(events, []);
    clock.advance(1);

    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
  });

  test("a close lost with a dying channel is sent again on the next one", async () => {
    const { transport, clock, open } = setup();
    const session = await open();

    const closing = session.close();
    const first = transport.socket;
    first.drop();
    clock.advance(1_000);
    await settle();

    assert.deepEqual(first.sentTypes(), ["session.close"]);
    assert.deepEqual(transport.socket.sentTypes(), ["session.close"]);
    transport.socket.receive({ type: "session.closed" });
    await closing;
  });

  test("a channel that keeps flapping cannot hold a close past 20 seconds", async () => {
    const { transport, clock, events, open } = setup();
    const session = await open();

    const closing = session.close();
    // Each new channel drops 11 s after it attached, and OpenAI never confirms the close.
    for (let flap = 0; flap < 2; flap++) {
      transport.socket.drop();
      clock.advance(1_000);
      await settle();
      clock.advance(10_000);
    }
    await closing;

    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
  });

  test("while closing, a new channel sends the queued events, then the close, at once", async () => {
    const { transport, clock, open } = setup();
    const session = await open();
    transport.socket.receive(functionCall("call_1", "end_session", "{}"));
    transport.socket.drop();
    session.resolveToolCall("call_1", { status: "ending" });
    void session.close();

    clock.advance(1_000);
    await settle();

    assert.deepEqual(transport.socket.sentTypes(), [
      "response.item.create",
      "response.create",
      "session.close",
    ]);
  });

  test("if no channel ever attaches, the close is reported as failed", async () => {
    const { transport, clock, events, open } = setup();
    const session = await open();
    transport.attachFailures = 3;
    transport.socket.drop();

    const closing = session.close();
    for (const delay of [1_000, 2_000, 4_000]) {
      clock.advance(delay);
      await settle();
    }
    await closing;

    assert.deepEqual(events, [{ type: "closed", reason: "failed" }]);
  });

  test("channels that drop within 10 s count as failed attaches, even if they sent an event", async () => {
    const { transport, clock, events, open } = setup();
    await open();

    transport.socket.drop();
    for (const delay of [1_000, 2_000, 4_000]) {
      clock.advance(delay);
      await settle();
      transport.socket.receive({ type: "error", error: { code: "server_error" } });
      transport.socket.drop();
    }

    assert.deepEqual(events, [{ type: "closed", reason: "failed" }]);
    assert.equal(transport.attached.length, 4);
  });

  test("a quiet channel that stayed up 10 s counts as back, so drops hours apart never use up the attaches", async () => {
    const { transport, clock, events, open } = setup();
    await open();

    for (let drop = 0; drop < 5; drop++) {
      transport.socket.drop();
      clock.advance(1_000);
      await settle();
      clock.advance(30 * 60_000);
    }

    assert.deepEqual(events, []);
    assert.equal(transport.attached.length, 6);
  });
});
