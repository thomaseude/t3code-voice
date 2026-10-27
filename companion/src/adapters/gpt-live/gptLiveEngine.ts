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
            // One call per turn, so each result can resume the model at once. With parallel
            // calls, a result sent before the turn's other calls arrived would resume it early.
            parallel_tool_calls: false,
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
    return new LiveSession({
      sdpAnswer,
      sessionId,
      socket,
      transport,
      clock: this.options.clock,
      onEvent,
    });
  }
}

/** How long close() waits for OpenAI's `session.closed` before it drops the channel. */
const CLOSE_TIMEOUT_MS = 5_000;
/**
 * Waits before each new attach when the control channel drops. Only the companion's channel
 * dropped: the phone's call goes on, and only this channel can still close it.
 */
const REATTACH_DELAYS_MS = [1_000, 2_000, 4_000];
/**
 * A new channel becomes usable once it has stayed up this long: OpenAI may accept a socket
 * and close it at once. Until then, outgoing events wait, and a drop counts as a failed attach.
 */
const USABLE_AFTER_MS = 10_000;

interface LiveSessionOptions {
  sdpAnswer: string;
  sessionId: string;
  socket: LiveSocket;
  transport: GptLiveTransport;
  clock: Clock;
  onEvent: (event: VoiceEvent) => void;
}

class LiveSession implements VoiceSession {
  readonly sdpAnswer: string;
  private readonly sessionId: string;
  private readonly transport: GptLiveTransport;
  private readonly clock: Clock;
  private readonly onEvent: (event: VoiceEvent) => void;
  /** The attached control channel, or null while it is attached again. */
  private socket: LiveSocket | null = null;
  /** Whether `socket` is usable: outgoing events go out only then. */
  private usable = false;
  private cancelUsable: () => void = () => {};
  private ended = false;
  private closing: Promise<void> | null = null;
  private resolveClosing: () => void = () => {};
  private cancelCloseTimeout: (() => void) | null = null;
  private cancelReattach: () => void = () => {};
  /** Attaches tried since the last usable channel. */
  private reattaches = 0;
  /** Events sent while no channel is usable, in order: they go out once one is. */
  private readonly unsent: string[] = [];
  /** Calls of the delegation model still waiting for a result (one at most per turn). */
  private readonly pendingCalls = new Set<string>();
  private nextEventId = 1;

  constructor(options: LiveSessionOptions) {
    this.sdpAnswer = options.sdpAnswer;
    this.sessionId = options.sessionId;
    this.transport = options.transport;
    this.clock = options.clock;
    this.onEvent = options.onEvent;
    // The first channel attached right after OpenAI created the session: it is usable now.
    this.use(options.socket, 0);
  }

  private use(socket: LiveSocket, usableAfterMs: number) {
    this.socket = socket;
    socket.onMessage((text) => {
      if (this.socket === socket) this.receive(text);
    });
    socket.onClose(() => {
      if (this.socket !== socket) return;
      // Everything the channel armed waits for the next usable one.
      this.socket = null;
      this.usable = false;
      this.cancelUsable();
      this.cancelCloseTimeout?.();
      this.cancelCloseTimeout = null;
      this.reattach();
    });
    if (usableAfterMs === 0) this.becomeUsable();
    else this.cancelUsable = this.clock.schedule(usableAfterMs, () => this.becomeUsable());
  }

  private becomeUsable() {
    this.usable = true;
    this.reattaches = 0;
    for (const text of this.unsent.splice(0)) this.socket?.send(text);
    if (this.closing !== null) this.startCloseTimeout();
  }

  private reattach() {
    if (this.ended) return;
    const delay = REATTACH_DELAYS_MS[this.reattaches];
    if (delay === undefined) {
      this.end(this.closing === null ? "failed" : "closed");
      return;
    }
    this.reattaches++;
    this.cancelReattach = this.clock.schedule(delay, () => {
      this.transport.attach(this.sessionId).then(
        (socket) => {
          if (this.ended) return socket.close();
          this.use(socket, USABLE_AFTER_MS);
        },
        () => this.reattach(),
      );
    });
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
    // Appending a result does not resume the delegation model: response.create does.
    this.send({ type: "response.create" });
  }

  close(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.closing === null) {
      this.closing = new Promise((resolve) => {
        this.resolveClosing = resolve;
      });
      // OpenAI sends its final `session.closed` (with usage) before it lets go.
      this.send({ type: "session.close" });
      // Without a usable channel, the close waits for one: only it can stop billing.
      if (this.usable) this.startCloseTimeout();
    }
    return this.closing;
  }

  private startCloseTimeout() {
    this.cancelCloseTimeout ??= this.clock.schedule(CLOSE_TIMEOUT_MS, () => this.end("closed"));
  }

  private end(reason: "closed" | "failed") {
    if (this.ended) return;
    this.ended = true;
    this.cancelCloseTimeout?.();
    this.cancelUsable();
    this.cancelReattach();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.resolveClosing();
    this.onEvent({ type: "closed", reason });
  }

  private send(event: WireJson) {
    if (this.ended) return;
    const text = JSON.stringify({ ...event, event_id: `t3voice_${this.nextEventId++}` });
    if (this.usable && this.socket !== null) this.socket.send(text);
    else this.unsent.push(text);
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
