// The voice engine: the speech model the iPhone streams audio to (GPT-Live today, the
// Realtime API later). The companion opens the session with the phone's SDP offer and keeps
// a control channel of its own, which carries the tool calls and the announcements.

/** A tool the voice model may call. `parameters` is a JSON Schema object. */
export interface VoiceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface VoiceSessionRequest {
  /** The iPhone's WebRTC SDP offer. */
  sdpOffer: string;
  /** French instructions for the conversation. They hold no secret. */
  instructions: string;
  tools: VoiceTool[];
}

/**
 * What the engine reports during a session. Arguments of a tool call are the parsed JSON
 * the model sent, or null when it was not valid JSON: the core checks every field.
 */
export type VoiceEvent =
  | { type: "tool_call"; callId: string; name: string; arguments: unknown }
  /**
   * Someone is speaking now. The engine has no "done speaking" event: a silence is the
   * absence of these events for a while. For the user, `text` is the next piece of the
   * transcript: the core checks a spoken "oui" with it. It stays in memory, never in a log.
   */
  | { type: "speech"; speaker: "user"; text: string }
  | { type: "speech"; speaker: "assistant" }
  /** The session ended, by the companion, the phone or the engine. Sent once. */
  | { type: "closed"; reason: "closed" | "failed" };

export interface VoiceSession {
  /** The SDP answer the iPhone applies to its peer connection. */
  readonly sdpAnswer: string;
  /** Says `text` to the user now, outside of any tool call. */
  speak(text: string): void;
  /** Sends the result of a tool call back to the model. `result` must be JSON-serializable. */
  resolveToolCall(callId: string, result: unknown): void;
  /** Ends the session at the engine, which stops billing it. */
  close(): Promise<void>;
}

/**
 * Who pays for the minutes: the OpenAI API key in dollars, or the quota of a ChatGPT plan
 * (no money leaves, and the daily dollar budget does not count them).
 */
export type VoiceBilling = "usd" | "plan_quota";

export interface VoiceEngine {
  /** The model sessions run on, for the usage records. */
  readonly model: string;
  readonly billing: VoiceBilling;
  /** What one minute of open session costs, in US dollars, silence included. Unused on a plan. */
  readonly usdPerMinute: number;
  /** Throws VoiceEngineError when the engine refuses or cannot be reached. */
  openSession(
    request: VoiceSessionRequest,
    onEvent: (event: VoiceEvent) => void,
  ): Promise<VoiceSession>;
}

/** The engine could not open a session. The message holds no secret and no audio or text. */
export class VoiceEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceEngineError";
  }
}
