// The GPT-Live adapter through a fake OpenAI transport: what it sends and how it reads
// OpenAI's events. No real call: they cost money.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GptLiveEngine } from "../../../../src/adapters/gpt-live/gptLiveEngine.ts";
import type { VoiceEvent, VoiceSessionRequest } from "../../../../src/ports/voiceEngine.ts";
import { FakeClock } from "../../fakeClock.ts";
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
    transport.failAttach = true;

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
    transport.socket.receive({ type: "session.output_transcript.delta", delta: "Bonjour" });
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

  test("results go back as function outputs; the model resumes once every pending call has one", async () => {
    const { transport, open } = setup();
    const session = await open();
    transport.socket.receive(functionCall("call_1", "list_projects", "{}"));
    transport.socket.receive(functionCall("call_2", "get_activity", '{"scope":"today"}'));

    session.resolveToolCall("call_2", { tasks: [] });
    session.resolveToolCall("call_1", { projects: ["Joombo"] });
    // A call that is not pending (unknown, or already answered) is not sent.
    session.resolveToolCall("call_1", { projects: [] });

    const sent = transport.socket.sent.map(({ event_id: _id, ...event }) => event);
    assert.deepEqual(sent, [
      {
        type: "response.item.create",
        item: { type: "function_call_output", call_id: "call_2", output: '{"tasks":[]}' },
      },
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
    assert.equal(new Set(ids).size, 3);
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

  test("close gives up waiting after 5 seconds and drops the channel", async () => {
    const { transport, clock, events, open } = setup();
    const session = await open();

    const closing = session.close();
    clock.advance(5_000);
    await closing;

    assert.equal(transport.socket.closed, true);
    assert.deepEqual(events, [{ type: "closed", reason: "closed" }]);
  });

  test("OpenAI closing the session, or the channel dropping, ends it", async () => {
    const first = setup();
    await first.open();
    first.transport.socket.receive({ type: "session.closed" });
    assert.deepEqual(first.events, [{ type: "closed", reason: "closed" }]);
    assert.equal(first.transport.socket.closed, true);

    const second = setup();
    await second.open();
    second.transport.socket.drop();
    assert.deepEqual(second.events, [{ type: "closed", reason: "failed" }]);
  });
});
