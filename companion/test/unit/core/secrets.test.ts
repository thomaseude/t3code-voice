import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scrubSecrets } from "../../../src/core/secrets.ts";

describe("scrubSecrets", () => {
  test("masks tickets, tokens and keys in text", () => {
    const text = [
      "ws://127.0.0.1:3773/ws?wsTicket=abc.def&orchestrationProtocol=2",
      "https://host/pair#token=PAIRCODE123",
      "Authorization: Bearer eyJhbGciOi.payload.sig",
      '{"access_token":"tok_123","scope":"orchestration:read"}',
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnop",
    ].join("\n");

    const scrubbed = scrubSecrets(text);

    for (const secret of [
      "abc.def",
      "PAIRCODE123",
      "eyJhbGciOi",
      "tok_123",
      "sk-proj-abcdefghijklmnop",
    ]) {
      assert.ok(!scrubbed.includes(secret), `${secret} leaked`);
    }
    assert.match(scrubbed, /orchestrationProtocol=2/);
    assert.match(scrubbed, /"scope":"orchestration:read"/);
  });
});
