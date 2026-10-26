import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FileConfigStore } from "../../../../src/adapters/config/fileConfigStore.ts";
import { ConfigError } from "../../../../src/ports/configStore.ts";

async function tempDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "t3voice-test-")), "t3voice");
}

const PAIRING = {
  baseUrl: "http://127.0.0.1:3773",
  token: "secret-token-value",
  scopes: ["orchestration:read", "orchestration:operate"],
  expiresAt: "2026-11-25T14:00:00.000Z",
};

describe("FileConfigStore", () => {
  test("writes files readable by the owner only", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" } });
    await new FileConfigStore(dir).saveT3Pairing(PAIRING);

    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "config.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "t3-pairing.json"))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).sort(), ["config.json", "t3-pairing.json"]);
  });

  test("reads back what it saved", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" } });
    await new FileConfigStore(dir).saveT3Pairing(PAIRING);

    assert.deepEqual(await new FileConfigStore(dir).loadConfig(), {
      t3: { baseUrl: "http://127.0.0.1:3773" },
    });
    assert.deepEqual(await new FileConfigStore(dir).loadT3Pairing(), PAIRING);
  });

  test("returns null before setup", async () => {
    const dir = await tempDir();
    assert.equal(await new FileConfigStore(dir).loadConfig(), null);
    assert.equal(await new FileConfigStore(dir).loadT3Pairing(), null);
  });

  test("refuses a secret file other users can read, without printing its content", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveT3Pairing(PAIRING);
    await chmod(join(dir, "t3-pairing.json"), 0o644);

    await assert.rejects(new FileConfigStore(dir).loadT3Pairing(), (error: Error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /chmod 600/);
      assert.doesNotMatch(error.message, /secret-token-value/);
      return true;
    });
  });

  test("tightens an existing pairing file when saving again", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveT3Pairing(PAIRING);
    await writeFile(join(dir, "t3-pairing.json"), "{}", { mode: 0o644 });
    await chmod(join(dir, "t3-pairing.json"), 0o644);

    await new FileConfigStore(dir).saveT3Pairing(PAIRING);

    assert.equal((await stat(join(dir, "t3-pairing.json"))).mode & 0o777, 0o600);
  });

  test("refuses a malformed list of accepted T3 versions", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" } });
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ t3: { baseUrl: "http://127.0.0.1:3773", acceptedServerVersions: "0.2.0" } }),
    );

    await assert.rejects(new FileConfigStore(dir).loadConfig(), /must be a list of versions/);
  });

  test("refuses an existing directory other users can open, and leaves it alone", async () => {
    const dir = await tempDir();
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);

    await assert.rejects(new FileConfigStore(dir).saveT3Pairing(PAIRING), /chmod 700/);
    assert.equal((await stat(dir)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(dir), []);
  });

  test("refuses to read a secret from a directory other users can open", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveT3Pairing(PAIRING);
    await chmod(dir, 0o755);

    await assert.rejects(new FileConfigStore(dir).loadT3Pairing(), /chmod 700/);
  });

  test("refuses a loose directory before any file is in it, so setup stops before pairing", async () => {
    const dir = await tempDir();
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);

    await assert.rejects(new FileConfigStore(dir).loadConfig(), /chmod 700/);
  });

  test("uses an existing private directory", async () => {
    const dir = await tempDir();
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);

    await new FileConfigStore(dir).saveT3Pairing(PAIRING);

    assert.deepEqual(await new FileConfigStore(dir).loadT3Pairing(), PAIRING);
  });

  test("reads a pairing whose expiry T3 did not give", async () => {
    const dir = await tempDir();
    const pairing = { ...PAIRING, expiresAt: null };
    await new FileConfigStore(dir).saveT3Pairing(pairing);

    assert.deepEqual(await new FileConfigStore(dir).loadT3Pairing(), pairing);
  });

  test("refuses a pairing file without its server URL", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveT3Pairing(PAIRING);
    const { baseUrl: _, ...withoutUrl } = PAIRING;
    await writeFile(join(dir, "t3-pairing.json"), JSON.stringify(withoutUrl));

    await assert.rejects(new FileConfigStore(dir).loadT3Pairing(), /damaged/);
  });
});
