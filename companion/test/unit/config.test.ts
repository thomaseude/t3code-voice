import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  ConfigError,
  loadConfig,
  loadT3Session,
  saveConfig,
  saveT3Session,
} from "../../src/config.ts";
import { scrubSecrets } from "../../src/secrets.ts";

async function tempDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "t3voice-test-")), "t3voice");
}

const SESSION = {
  token: "secret-token-value",
  scopes: ["orchestration:read", "orchestration:operate"],
  expiresAt: "2026-11-25T14:00:00.000Z",
};

describe("config and secrets", () => {
  test("writes files readable by the owner only", async () => {
    const dir = await tempDir();
    await saveConfig(dir, { t3: { baseUrl: "http://127.0.0.1:3773" } });
    await saveT3Session(dir, SESSION);

    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "config.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "t3-session.json"))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).sort(), ["config.json", "t3-session.json"]);
  });

  test("reads back what it saved", async () => {
    const dir = await tempDir();
    await saveConfig(dir, { t3: { baseUrl: "http://127.0.0.1:3773" } });
    await saveT3Session(dir, SESSION);

    assert.deepEqual(await loadConfig(dir), { t3: { baseUrl: "http://127.0.0.1:3773" } });
    assert.deepEqual(await loadT3Session(dir), SESSION);
  });

  test("returns null before setup", async () => {
    const dir = await tempDir();
    assert.equal(await loadConfig(dir), null);
    assert.equal(await loadT3Session(dir), null);
  });

  test("refuses a secret file other users can read, without printing its content", async () => {
    const dir = await tempDir();
    await saveT3Session(dir, SESSION);
    await chmod(join(dir, "t3-session.json"), 0o644);

    await assert.rejects(loadT3Session(dir), (error: Error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /chmod 600/);
      assert.doesNotMatch(error.message, /secret-token-value/);
      return true;
    });
  });

  test("tightens an existing session file when saving again", async () => {
    const dir = await tempDir();
    await saveT3Session(dir, SESSION);
    await writeFile(join(dir, "t3-session.json"), "{}", { mode: 0o644 });
    await chmod(join(dir, "t3-session.json"), 0o644);

    await saveT3Session(dir, SESSION);

    assert.equal((await stat(join(dir, "t3-session.json"))).mode & 0o777, 0o600);
  });
});

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
