import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FileConfigStore } from "../../../../src/adapters/config/fileConfigStore.ts";
import { ConfigError } from "../../../../src/ports/configStore.ts";

async function tempDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "t3voice-test-")), "t3voice");
}

const SESSION = {
  token: "secret-token-value",
  scopes: ["orchestration:read", "orchestration:operate"],
  expiresAt: "2026-11-25T14:00:00.000Z",
};

describe("FileConfigStore", () => {
  test("writes files readable by the owner only", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" } });
    await new FileConfigStore(dir).saveT3Session(SESSION);

    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "config.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "t3-session.json"))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).sort(), ["config.json", "t3-session.json"]);
  });

  test("reads back what it saved", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" } });
    await new FileConfigStore(dir).saveT3Session(SESSION);

    assert.deepEqual(await new FileConfigStore(dir).loadConfig(), {
      t3: { baseUrl: "http://127.0.0.1:3773" },
    });
    assert.deepEqual(await new FileConfigStore(dir).loadT3Session(), SESSION);
  });

  test("returns null before setup", async () => {
    const dir = await tempDir();
    assert.equal(await new FileConfigStore(dir).loadConfig(), null);
    assert.equal(await new FileConfigStore(dir).loadT3Session(), null);
  });

  test("refuses a secret file other users can read, without printing its content", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveT3Session(SESSION);
    await chmod(join(dir, "t3-session.json"), 0o644);

    await assert.rejects(new FileConfigStore(dir).loadT3Session(), (error: Error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /chmod 600/);
      assert.doesNotMatch(error.message, /secret-token-value/);
      return true;
    });
  });

  test("tightens an existing session file when saving again", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveT3Session(SESSION);
    await writeFile(join(dir, "t3-session.json"), "{}", { mode: 0o644 });
    await chmod(join(dir, "t3-session.json"), 0o644);

    await new FileConfigStore(dir).saveT3Session(SESSION);

    assert.equal((await stat(join(dir, "t3-session.json"))).mode & 0o777, 0o600);
  });
});
