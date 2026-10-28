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
  answer: { status: number; body: WireJson } = answerWith({ short: "Les tests passent." });

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
};

describe("OpenAiSummarizer", () => {
  test("asks the configured model for a short summary, as JSON", async () => {
    const { transport, summarizer } = setup();

    await summarizer.summarize(REQUEST);

    const [body] = transport.bodies;
    assert.equal(body.model, "gpt-5.4-mini");
    assert.equal(body.store, false);
    assert.match(body.instructions, /French/);
    assert.match(body.input, /Corrige les tests des Reviews/);
    assert.match(body.input, /J'ai corrigé `reviews_test.rb`./);
    assert.equal(body.text.format.type, "json_schema");
    assert.deepEqual(body.text.format.schema.required, ["short"]);
  });

  test("a thread with no request says so instead of an empty one", async () => {
    const { transport, summarizer } = setup();

    await summarizer.summarize({ ...REQUEST, request: null });

    assert.match(transport.bodies[0].input, /User's request: unknown/);
  });

  test("returns the summary the model wrote", async () => {
    const { summarizer } = setup();

    assert.deepEqual(await summarizer.summarize(REQUEST), { short: "Les tests passent." });
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
      answerWith({ long: "Seulement long." }),
      answerWith({ short: " " }),
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

const CONVERSATION = {
  status: "running",
  messages: [
    { role: "user" as const, text: "Corrige les tests des Reviews" },
    { role: "assistant" as const, text: "Je lance `bin/rails test`." },
  ],
  omitted: 3,
};

describe("OpenAiSummarizer.summarizeConversation", () => {
  test("asks for a spoken summary of the conversation, with T3's status", async () => {
    const { transport, summarizer } = setup();
    transport.answer = answerWith({ summary: "Il corrige les tests ; il travaille encore." });

    const summary = await summarizer.summarizeConversation(CONVERSATION);

    assert.equal(summary, "Il corrige les tests ; il travaille encore.");
    const [body] = transport.bodies;
    assert.equal(body.model, "gpt-5.4-mini");
    assert.equal(body.store, false);
    assert.match(body.instructions, /French/);
    assert.match(body.instructions, /still running/);
    assert.match(body.instructions, /waiting_for_input/);
    assert.match(body.instructions, /queued/);
    assert.match(body.input, /Status: running/);
    assert.match(body.input, /User: Corrige les tests des Reviews/);
    assert.match(body.input, /Agent: Je lance `bin\/rails test`./);
    assert.match(body.input, /3 messages left out/);
    assert.deepEqual(body.text.format.schema.required, ["summary"]);
  });

  test("an answer with no summary fails", async () => {
    const { transport, summarizer } = setup();
    transport.answer = answerWith({ summary: "" });

    await assert.rejects(summarizer.summarizeConversation(CONVERSATION), /unexpected answer/);
  });

  test("an error status fails with its code only, never the message", async () => {
    const { transport, summarizer } = setup();
    transport.answer = { status: 500, body: { error: { message: "Corrige les tests" } } };

    await assert.rejects(summarizer.summarizeConversation(CONVERSATION), (error: Error) => {
      assert.equal(error.message, "OpenAI refused the summary (500).");
      return true;
    });
  });
});
