// VoiceEngine adapter for Codex's realtime voice, on the ChatGPT login of the user the
// companion runs as: its minutes draw from the plan's quota, not from the API key (#56).
//
// Each session runs its own `codex app-server`. The adapter starts an ephemeral Codex
// thread: no shell, read-only sandbox, and the companion's tools as Codex dynamic tools. It
// then starts a realtime session on that thread over WebRTC with the iPhone's SDP offer.
// The voice model can only hand requests to the Codex thread; the thread calls the
// companion's tools (`item/tool/call`), and its final answer is spoken back with
// `thread/realtime/appendSpeech`.

import {
  type VoiceEngine,
  VoiceEngineError,
  type VoiceEvent,
  type VoiceSession,
  type VoiceSessionRequest,
} from "../../ports/voiceEngine.ts";
import {
  type CodexAppServerOptions,
  type CodexRpc,
  startPinnedCodex,
  type WireJson,
} from "./codexRpc.ts";

export interface CodexLiveEngineOptions extends CodexAppServerOptions {
  /** The Codex model of the thread, e.g. "gpt-6.1-terra". */
  threadModel: string;
  /** The thread's reasoning effort, e.g. "low". */
  threadReasoningEffort: string;
}

/** OpenAI may take this long to answer the offer (spec #15, `POST /sessions`). */
const SDP_ANSWER_TIMEOUT_MS = 15_000;
/** Longer answers are not spoken: the voice model would read a wall of text. */
const MAX_SPOKEN_CHARS = 1_200;

export class CodexLiveEngine implements VoiceEngine {
  readonly model = "gpt-live-1-codex";
  readonly billing = "plan_quota";
  /** No money leaves: the minutes draw from the plan's quota. */
  readonly usdPerMinute = 0;
  private readonly options: CodexLiveEngineOptions;

  constructor(options: CodexLiveEngineOptions) {
    this.options = options;
  }

  async openSession(
    request: VoiceSessionRequest,
    onEvent: (event: VoiceEvent) => void,
  ): Promise<VoiceSession> {
    let rpc: CodexRpc;
    try {
      rpc = await startPinnedCodex(this.options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new VoiceEngineError(`Codex cannot be used: ${message}.`);
    }
    try {
      const started = await rpc.request("thread/start", {
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        model: this.options.threadModel,
        config: {
          features: { shell_tool: false },
          // Codex starts the delegated turns itself: the effort is set on the thread.
          model_reasoning_effort: this.options.threadReasoningEffort,
        },
        developerInstructions: request.instructions,
        dynamicTools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      });
      const threadId = started?.thread?.id;
      if (typeof threadId !== "string") throw new Error("no thread id");
      const session = new CodexLiveSession({ ...this.options, rpc, threadId, onEvent });
      await session.start(request);
      return session;
    } catch (error) {
      rpc.close();
      if (error instanceof VoiceEngineError) throw error;
      throw new VoiceEngineError("Codex refused the voice session.");
    }
  }
}

interface CodexLiveSessionOptions extends CodexLiveEngineOptions {
  rpc: CodexRpc;
  threadId: string;
  onEvent: (event: VoiceEvent) => void;
}

class CodexLiveSession implements VoiceSession {
  sdpAnswer = "";
  private readonly options: CodexLiveSessionOptions;
  private readonly rpc: CodexRpc;
  private readonly threadId: string;
  /** Tool calls of the Codex thread still waiting for a result, by call id. */
  private readonly pendingCalls = new Map<string, (result: WireJson) => void>();
  /** The last answer worth speaking in each running turn of the thread, by turn id. */
  private readonly answers = new Map<string, string>();
  private resolveSdp: (sdp: string) => void = () => {};
  private rejectSdp: (error: Error) => void = () => {};
  private ended = false;
  /** Whether openSession returned this session: only then does the core hear it closed. */
  private opened = false;

  constructor(options: CodexLiveSessionOptions) {
    this.options = options;
    this.rpc = options.rpc;
    this.threadId = options.threadId;
    this.rpc.onNotification((method, params) => this.receive(method, params));
    this.rpc.onRequest((method, params, reply) => this.answerRequest(method, params, reply));
    this.rpc.onExit(() => this.end("failed"));
  }

  async start(request: VoiceSessionRequest): Promise<void> {
    const sdp = new Promise<string>((resolve, reject) => {
      this.resolveSdp = resolve;
      this.rejectSdp = reject;
    });
    const cancelTimeout = this.options.clock.schedule(SDP_ANSWER_TIMEOUT_MS, () =>
      this.rejectSdp(new VoiceEngineError("Codex did not answer the voice offer in time.")),
    );
    try {
      await this.rpc.request("thread/realtime/start", {
        threadId: this.threadId,
        outputModality: "audio",
        transport: { type: "webrtc", sdp: request.sdpOffer },
        version: "v3",
        clientManagedHandoffs: true,
        includeStartupContext: false,
        // Replaces Codex's own voice prompt (a coding companion) with ours.
        prompt: request.instructions,
      });
      this.sdpAnswer = await sdp;
      this.opened = true;
    } finally {
      cancelTimeout();
    }
  }

  speak(text: string): void {
    if (this.ended) return;
    this.rpc
      .request("thread/realtime/appendSpeech", { threadId: this.threadId, text })
      .catch(() => {});
  }

  resolveToolCall(callId: string, result: unknown): void {
    const reply = this.pendingCalls.get(callId);
    if (reply === undefined) return;
    this.pendingCalls.delete(callId);
    reply({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] });
  }

  async close(): Promise<void> {
    if (this.ended) return;
    await this.rpc.request("thread/realtime/stop", { threadId: this.threadId }).catch(() => {});
    this.end("closed");
  }

  private end(reason: "closed" | "failed") {
    if (this.ended) return;
    this.ended = true;
    this.rejectSdp(new VoiceEngineError("The Codex app-server stopped."));
    this.rpc.close();
    if (this.opened) this.options.onEvent({ type: "closed", reason });
  }

  private answerRequest(method: string, params: WireJson, reply: (result: WireJson) => void) {
    if (method === "item/tool/call" && params?.threadId === this.threadId) {
      const callId = params.callId;
      if (typeof callId !== "string" || typeof params.tool !== "string") {
        return reply({ success: false, contentItems: [] });
      }
      this.pendingCalls.set(callId, reply);
      this.options.onEvent({
        type: "tool_call",
        callId,
        name: params.tool,
        arguments: params.arguments ?? null,
      });
      return;
    }
    // The thread has no shell and no approval to give: anything else is refused.
    reply({ decision: "decline" });
  }

  private receive(method: string, params: WireJson) {
    if (params?.threadId !== this.threadId) return;
    switch (method) {
      case "thread/realtime/sdp":
        if (typeof params.sdp === "string") this.resolveSdp(params.sdp);
        return;
      case "thread/realtime/transcript/delta":
        if (typeof params.delta !== "string" || params.delta === "") return;
        this.options.onEvent(
          params.role === "user"
            ? { type: "speech", speaker: "user", text: params.delta }
            : { type: "speech", speaker: "assistant" },
        );
        return;
      case "item/completed": {
        const spoken = speakableAnswer(params.item);
        if (spoken !== undefined && typeof params.turnId === "string") {
          this.answers.set(params.turnId, spoken);
        }
        return;
      }
      case "turn/completed": {
        const turnId = params.turn?.id;
        const answer = this.answers.get(turnId);
        this.answers.delete(turnId);
        if (answer !== undefined) this.speak(answer);
        return;
      }
      case "thread/realtime/error":
      case "thread/realtime/closed":
        this.end(method === "thread/realtime/error" ? "failed" : "closed");
        return;
    }
  }
}

/** The thread's final answer, without its commentary. */
function speakableAnswer(item: WireJson): string | undefined {
  if (item?.type !== "agentMessage" || typeof item.text !== "string") return undefined;
  if (item.phase === "commentary") return undefined;
  const text = item.text.trim();
  if (text === "" || text.length > MAX_SPOKEN_CHARS) return undefined;
  return text;
}
