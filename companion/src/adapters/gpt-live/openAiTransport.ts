// The real GPT-Live transport: HTTPS and WebSocket calls to api.openai.com with the
// server's API key. The key goes only in the Authorization header, never in a URL or a
// message.

import { VoiceEngineError } from "../../ports/voiceEngine.ts";
import type { GptLiveTransport, LiveSocket, WireJson } from "./gptLiveEngine.ts";

const API = "https://api.openai.com/v1/live/sessions";
const REQUEST_TIMEOUT_MS = 15_000;
const ATTACH_TIMEOUT_MS = 10_000;

export function openAiTransport(apiKey: string): GptLiveTransport {
  const authorization = `Bearer ${apiKey}`;
  return {
    async createSession(body: WireJson) {
      let response: Response;
      try {
        response = await fetch(API, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new VoiceEngineError(`Cannot reach OpenAI: ${describe(error)}`);
      }
      let answer: WireJson = null;
      try {
        answer = await response.json();
      } catch {}
      return { status: response.status, body: answer };
    },

    attach(sessionId: string): Promise<LiveSocket> {
      const url = `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
      return new Promise((resolve, reject) => {
        // Node's WebSocket (undici) takes request headers, unlike the browser's.
        const socket = new WebSocket(url, { headers: { authorization } });
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("Timed out attaching to the GPT-Live session."));
        }, ATTACH_TIMEOUT_MS);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          resolve(socketAdapter(socket));
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          // Rejecting an already-resolved promise is a no-op, so this only reports open failures.
          reject(new Error("Could not attach to the GPT-Live session."));
        });
      });
    },
  };
}

function socketAdapter(socket: WebSocket): LiveSocket {
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    onMessage: (listener) => {
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") listener(event.data);
      });
    },
    onClose: (listener) => {
      socket.addEventListener("close", () => listener());
    },
    close: () => socket.close(),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return typeof code === "string" ? code : error.name;
  }
  return "unknown error";
}
