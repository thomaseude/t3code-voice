// VoiceEngine adapter for OpenAI GPT-Live.
//
// The companion posts the iPhone's SDP offer to `POST /v1/live/sessions` with its own key,
// and gives the SDP answer back to the phone: the key never leaves the server. It then
// attaches its own control channel (`/v1/live/sessions/{id}/attach`). GPT-Live hands what
// the user asks to a Responses model ("responses" delegation), which calls the companion's
// tools by name; the calls and their results travel on that channel.

import type { Clock } from "../../ports/clock.ts";
import {
  type VoiceEngine,
  VoiceEngineError,
  type VoiceEvent,
  type VoiceSession,
  type VoiceSessionRequest,
} from "../../ports/voiceEngine.ts";

// biome-ignore lint/suspicious/noExplicitAny: OpenAI's JSON, checked field by field.
export type WireJson = any;

/** The two calls the adapter makes to OpenAI. The real one holds the API key. */
export interface GptLiveTransport {
  createSession(body: WireJson): Promise<{ status: number; body: WireJson }>;
  attach(sessionId: string): Promise<LiveSocket>;
}

export interface LiveSocket {
  send(text: string): void;
  onMessage(listener: (text: string) => void): void;
  /** Called once, when the socket closes for any reason. */
  onClose(listener: () => void): void;
  close(): void;
}

export interface GptLiveEngineOptions {
  transport: GptLiveTransport;
  clock: Clock;
  model: string;
  voice: string;
  /** The Responses model GPT-Live delegates the user's requests and the tool calls to. */
  delegationModel: string;
}

/** What the phone may send on its own data channel: nothing that answers a tool call. */
const PHONE_EVENTS = ["session.close", "session.input_audio.mute", "session.input_audio.unmute"];

export class GptLiveEngine implements VoiceEngine {
  private readonly options: GptLiveEngineOptions;

  constructor(options: GptLiveEngineOptions) {
    this.options = options;
  }

  async openSession(
    request: VoiceSessionRequest,
    onEvent: (event: VoiceEvent) => void,
  ): Promise<VoiceSession> {
    const { transport, model, voice, delegationModel } = this.options;
    const answer = await transport.createSession({
      session: {
        model,
        instructions: request.instructions,
        audio: { output: { voice } },
        client: { data_channel: { allowed_client_events: PHONE_EVENTS } },
        delegation: {
          type: "responses",
          responses: {
            model: delegationModel,
            // The delegation model decides which tool to call, so it needs the same rules.
            instructions: request.instructions,
            tools: request.tools.map((tool) => ({ type: "function", ...tool })),
            tool_choice: "auto",
          },
        },
      },
      transport: { type: "webrtc", sdp: request.sdpOffer },
    });
    if (answer.status < 200 || answer.status > 299) {
      // OpenAI's message may quote the offer: only its error code is kept.
      const code = answer.body?.error?.code;
      const detail =
        typeof code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(code) ? ` ${code}` : "";
      throw new VoiceEngineError(`OpenAI refused the voice session (${answer.status}${detail}).`);
    }
    const sessionId = answer.body?.session?.id;
    const sdpAnswer = answer.body?.transport?.sdp;
    if (typeof sessionId !== "string" || typeof sdpAnswer !== "string") {
      throw new VoiceEngineError("OpenAI answered the session request with an unexpected body.");
    }
    let socket: LiveSocket;
    try {
      socket = await transport.attach(sessionId);
    } catch {
      // Without the channel no tool would ever answer, so the phone must not use this
      // session. Its WebRTC peer then never connects, and OpenAI is expected to drop it.
      throw new VoiceEngineError("Could not attach the control channel to the GPT-Live session.");
    }
    return new LiveSession(sdpAnswer, socket, this.options.clock, onEvent);
  }
}

/** How long close() waits for OpenAI's `session.closed` before it drops the channel. */
const CLOSE_TIMEOUT_MS = 5_000;

class LiveSession implements VoiceSession {
  readonly sdpAnswer: string;
  private readonly socket: LiveSocket;
  private readonly clock: Clock;
  private readonly onEvent: (event: VoiceEvent) => void;
  private ended = false;
  private closing: Promise<void> | null = null;
  private resolveClosing: () => void = () => {};
  private cancelCloseTimeout: () => void = () => {};
  /** Calls of the delegation model still waiting for a result. */
  private readonly pendingCalls = new Set<string>();
  private nextEventId = 1;

  constructor(
    sdpAnswer: string,
    socket: LiveSocket,
    clock: Clock,
    onEvent: (event: VoiceEvent) => void,
  ) {
    this.sdpAnswer = sdpAnswer;
    this.socket = socket;
    this.clock = clock;
    this.onEvent = onEvent;
    socket.onMessage((text) => this.receive(text));
    // A channel that drops while we are not closing is a failure: tools can no longer answer.
    socket.onClose(() => this.end(this.closing === null ? "failed" : "closed"));
  }

  speak(text: string): void {
    // Without a delegation id, commentary is for the whole session: GPT-Live says it now.
    this.send({ type: "session.commentary.append", delegation_id: null, content: text });
  }

  resolveToolCall(callId: string, result: unknown): void {
    if (!this.pendingCalls.delete(callId)) return;
    this.send({
      type: "response.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
    });
    // Appending results does not resume the delegation model; it waits for every result.
    if (this.pendingCalls.size === 0) this.send({ type: "response.create" });
  }

  close(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.closing === null) {
      this.closing = new Promise((resolve) => {
        this.resolveClosing = resolve;
      });
      // OpenAI sends its final `session.closed` (with usage) before it lets go.
      this.send({ type: "session.close" });
      this.cancelCloseTimeout = this.clock.schedule(CLOSE_TIMEOUT_MS, () => this.end("closed"));
    }
    return this.closing;
  }

  private end(reason: "closed" | "failed") {
    if (this.ended) return;
    this.ended = true;
    this.cancelCloseTimeout();
    this.socket.close();
    this.resolveClosing();
    this.onEvent({ type: "closed", reason });
  }

  private send(event: WireJson) {
    if (this.ended) return;
    this.socket.send(JSON.stringify({ ...event, event_id: `t3voice_${this.nextEventId++}` }));
  }

  private receive(text: string) {
    let event: WireJson;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (event?.type === "session.closed") return this.end("closed");
    // The delegation model's events come wrapped; a finished function item is a tool call.
    // Its "arguments done" event alone does not identify the call.
    const item = event?.type === "response.event" ? event.event?.item : undefined;
    if (
      event?.event?.type === "response.output_item.done" &&
      item?.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      this.pendingCalls.add(item.call_id);
      this.onEvent({
        type: "tool_call",
        callId: item.call_id,
        name: item.name,
        arguments: parseArguments(item.arguments),
      });
    }
  }
}

function parseArguments(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
