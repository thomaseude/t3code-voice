// The real summarizer transport: one HTTPS call to OpenAI's Responses API with the server's
// API key. The key goes only in the Authorization header, never in a URL or a message.

import type { ResponsesTransport, WireJson } from "./openAiSummarizer.ts";

const API = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 30_000;

export function openAiResponsesTransport(apiKey: string): ResponsesTransport {
  return {
    async createResponse(body: WireJson) {
      let response: Response;
      try {
        response = await fetch(API, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(`Cannot reach OpenAI: ${describe(error)}`);
      }
      let answer: WireJson = null;
      try {
        answer = await response.json();
      } catch {}
      return { status: response.status, body: answer };
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return typeof code === "string" ? code : error.name;
  }
  return "unknown error";
}
