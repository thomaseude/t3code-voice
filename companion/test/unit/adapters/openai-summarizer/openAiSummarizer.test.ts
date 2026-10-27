// The OpenAI summarizer through a fake transport: what it asks the model, and how it reads
// the answer. No real call: they cost money.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  OpenAiSummarizer,
  type ResponsesTransport,
  type WireJson,
} from "../../../../src/adapters/openai-summarizer/openAiSummarizer.ts";

class FakeResponsesTransport implements ResponsesTransport {
  readonly bodies: WireJson[] = [];
  answer: { status: number; body: WireJson } = answerWith({
    short: "Les tests passent.",
    long: "L'agent a corrigé deux tests et tout passe.",
  });

  async createResponse(body: WireJson) {
    this.bodies.push(body);
    return this.answer;
  }
}

function answerWith(summary: unknown) {
  return {
    status: 200,
    body: {
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(summary) }],
        },
      ],
    },
  };
}

function setup() {
  const transport = new FakeResponsesTransport();
  const summarizer = new OpenAiSummarizer({ transport, model: "gpt-5.4-mini" });
  return { transport, summarizer };
}

const REQUEST = {
  request: "Corrige les tests des Reviews",
  output: "J'ai corrigé `reviews_test.rb`.",
  outcome: "completed" as const,
};

describe("OpenAiSummarizer", () => {
  test("asks the configured model for a short and a long summary, as JSON", async () => {
    const { transport, summarizer } = setup();

    await summarizer.summarize(REQUEST);

    const [body] = transport.bodies;
    assert.equal(body.model, "gpt-5.4-mini");
    assert.equal(body.store, false);
    assert.match(body.instructions, /French/);
    assert.match(body.input, /Outcome: completed/);
    assert.match(body.input, /Corrige les tests des Reviews/);
    assert.match(body.input, /J'ai corrigé `reviews_test.rb`./);
    assert.equal(body.text.format.type, "json_schema");
    assert.deepEqual(body.text.format.schema.required, ["short", "long"]);
  });

  test("a thread with no request says so instead of an empty one", async () => {
    const { transport, summarizer } = setup();

    await summarizer.summarize({ ...REQUEST, request: null });

    assert.match(transport.bodies[0].input, /User's request: unknown/);
  });

  test("returns the two summaries the model wrote", async () => {
    const { summarizer } = setup();

    assert.deepEqual(await summarizer.summarize(REQUEST), {
      short: "Les tests passent.",
      long: "L'agent a corrigé deux tests et tout passe.",
    });
  });

  test("an error status fails with its code only, never the message", async () => {
    const { transport, summarizer } = setup();
    transport.answer = {
      status: 429,
      body: { error: { code: "rate_limit_exceeded", message: "J'ai corrigé reviews_test.rb" } },
    };

    await assert.rejects(summarizer.summarize(REQUEST), (error: Error) => {
      assert.equal(error.message, "OpenAI refused the summary (429 rate_limit_exceeded).");
      return true;
    });
  });

  test("an answer that is not the expected JSON fails", async () => {
    const { transport, summarizer } = setup();
    for (const answer of [
      answerWith({ short: "Seulement court." }),
      answerWith({ short: "", long: "Long." }),
      { status: 200, body: { output: [] } },
      {
        status: 200,
        body: { output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }] },
      },
    ]) {
      transport.answer = answer;
      await assert.rejects(summarizer.summarize(REQUEST), /unexpected answer/);
    }
  });
});
