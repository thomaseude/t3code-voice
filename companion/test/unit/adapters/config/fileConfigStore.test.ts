import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FileConfigStore } from "../../../../src/adapters/config/fileConfigStore.ts";
import { ConfigError } from "../../../../src/ports/configStore.ts";
import { pairedDevice } from "../../builders.ts";

const DEVICE = pairedDevice();

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

  test("has no device before the first pairing", async () => {
    const dir = await tempDir();
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" } });

    assert.deepEqual(await new FileConfigStore(dir).loadDevices(), []);
  });

  test("reads the paired devices", async () => {
    const dir = await privateDir();
    await writeFile(join(dir, "devices.json"), JSON.stringify({ devices: [DEVICE] }), {
      mode: 0o600,
    });

    assert.deepEqual(await new FileConfigStore(dir).loadDevices(), [DEVICE]);
  });

  test("refuses a device list other users can read", async () => {
    const dir = await privateDir();
    await writeFile(join(dir, "devices.json"), JSON.stringify({ devices: [DEVICE] }), {
      mode: 0o644,
    });

    await assert.rejects(new FileConfigStore(dir).loadDevices(), /chmod 600/);
  });

  test("refuses a damaged device list rather than letting a device through", async () => {
    const dir = await privateDir();
    const { tokenSha256: _, ...withoutHash } = DEVICE;
    await writeFile(join(dir, "devices.json"), JSON.stringify({ devices: [withoutHash] }), {
      mode: 0o600,
    });

    await assert.rejects(new FileConfigStore(dir).loadDevices(), /damaged/);
  });

  test("reads the HTTP server settings", async () => {
    const dir = await tempDir();
    const server = { host: "127.0.0.1", port: 8787, clientIpHeader: "cf-connecting-ip" };
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" }, server });

    assert.deepEqual((await new FileConfigStore(dir).loadConfig())?.server, server);
  });

  test("refuses a port that is not a port number", async () => {
    for (const port of ["8787", 0, 70000, 87.5]) {
      const dir = await privateDir();
      const config = { t3: { baseUrl: "http://127.0.0.1:3773" }, server: { port } };
      await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });

      await assert.rejects(new FileConfigStore(dir).loadConfig(), /"server.port"/, String(port));
    }
  });

  test("refuses an empty host, which would listen on every interface", async () => {
    const dir = await privateDir();
    const config = { t3: { baseUrl: "http://127.0.0.1:3773" }, server: { host: "" } };
    await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });

    await assert.rejects(new FileConfigStore(dir).loadConfig(), /"server.host"/);
  });

  test("reads the public URL of the companion", async () => {
    const dir = await tempDir();
    const server = { publicUrl: "https://voice.example.com" };
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" }, server });

    assert.deepEqual((await new FileConfigStore(dir).loadConfig())?.server, server);
  });

  test("refuses a public URL that is not HTTPS: the device token would travel in clear", async () => {
    for (const publicUrl of ["http://voice.example.com", "voice.example.com", 42]) {
      const dir = await privateDir();
      const config = { t3: { baseUrl: "http://127.0.0.1:3773" }, server: { publicUrl } };
      await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });

      await assert.rejects(
        new FileConfigStore(dir).loadConfig(),
        /"server.publicUrl" must be an https:\/\/ address/,
        String(publicUrl),
      );
    }
  });

  test("reads a device with a pending replacement token", async () => {
    const dir = await privateDir();
    const device = pairedDevice({
      nextToken: { sha256: "b".repeat(64), issuedAt: "2026-10-26T11:00:00.000Z" },
    });
    await writeFile(join(dir, "devices.json"), JSON.stringify({ devices: [device] }), {
      mode: 0o600,
    });

    assert.deepEqual(await new FileConfigStore(dir).loadDevices(), [device]);
  });

  test("refuses a device without the date of its token", async () => {
    const dir = await privateDir();
    const { tokenIssuedAt: _, ...withoutDate } = DEVICE;
    await writeFile(join(dir, "devices.json"), JSON.stringify({ devices: [withoutDate] }), {
      mode: 0o600,
    });

    await assert.rejects(new FileConfigStore(dir).loadDevices(), /damaged/);
  });

  describe("updating the device list", () => {
    test("saves the changed list, readable by the owner only", async () => {
      const dir = await tempDir();
      const store = new FileConfigStore(dir);

      const result = await store.updateDevices((devices) => [...devices, DEVICE]);

      assert.deepEqual(result, [DEVICE]);
      assert.deepEqual(await new FileConfigStore(dir).loadDevices(), [DEVICE]);
      assert.equal((await stat(join(dir, "devices.json"))).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(dir), ["devices.json"], "no lock file left behind");
    });

    test("changes `serve` makes at the same time are all kept", async () => {
      const dir = await tempDir();
      const serve = new FileConfigStore(dir);

      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          serve.updateDevices((devices) => [...devices, pairedDevice({ id: `d${index}` })]),
        ),
      );

      assert.equal((await serve.loadDevices()).length, 20);
    });

    test("a revocation the CLI writes while `serve` changes the list is kept", async () => {
      const dir = await tempDir();
      // Two stores on one directory, like the two processes.
      const serve = new FileConfigStore(dir);
      const cli = new FileConfigStore(dir);
      await serve.updateDevices(() => [DEVICE]);

      await Promise.all([
        ...Array.from({ length: 10 }, () =>
          serve.updateDevices((devices) => devices.map((device) => ({ ...device }))),
        ),
        cli.revokeDevice(DEVICE.id, "2026-10-26T12:00:00.000Z"),
      ]);

      const [device] = await serve.loadDevices();
      assert.equal(device?.revokedAt, "2026-10-26T12:00:00.000Z");
    });

    test("does not save a list the change cannot read", async () => {
      const dir = await privateDir();
      await writeFile(join(dir, "devices.json"), "{oops", { mode: 0o600 });

      await assert.rejects(
        new FileConfigStore(dir).updateDevices(() => [DEVICE]),
        /not valid JSON/,
      );
      assert.equal(await readFile(join(dir, "devices.json"), "utf8"), "{oops");
    });
  });

  describe("revocations", () => {
    test("are saved one file per device, readable by the owner only; the first date counts", async () => {
      const dir = await tempDir();
      const store = new FileConfigStore(dir);
      await store.updateDevices(() => [DEVICE, pairedDevice({ id: "d2" })]);

      await store.revokeDevice(DEVICE.id, "2026-10-26T12:00:00.000Z");
      await store.revokeDevice(DEVICE.id, "2026-10-27T12:00:00.000Z");

      assert.equal((await stat(join(dir, "revoked"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(dir, "revoked", `${DEVICE.id}.json`))).mode & 0o777, 0o600);
      const devices = await new FileConfigStore(dir).loadDevices();
      assert.deepEqual(
        devices.map((device) => device.revokedAt),
        ["2026-10-26T12:00:00.000Z", null],
      );
    });

    test("a revocation date in the device list is ignored: only revokeDevice revokes", async () => {
      const dir = await tempDir();
      const store = new FileConfigStore(dir);

      await store.updateDevices(() => [{ ...DEVICE, revokedAt: "2026-10-26T12:00:00.000Z" }]);

      assert.equal((await store.loadDevices())[0]?.revokedAt, null);
    });

    test("a damaged revocation, for example cut short by a full disk, still revokes its device and only it", async () => {
      const dir = await tempDir();
      const store = new FileConfigStore(dir);
      await store.updateDevices(() => [DEVICE, pairedDevice({ id: "d2" })]);
      await mkdir(join(dir, "revoked"), { mode: 0o700 });
      await writeFile(join(dir, "revoked", `${DEVICE.id}.json`), '{"revo', { mode: 0o600 });

      const [revoked, other] = await store.loadDevices();

      assert.equal(typeof revoked?.revokedAt, "string");
      assert.equal(other?.revokedAt, null);
    });

    test("refuses a revoke for an id that is not a device id, which could name another file", async () => {
      const store = new FileConfigStore(await tempDir());

      await assert.rejects(
        store.revokeDevice("../config", "2026-10-26T12:00:00.000Z"),
        /device id/,
      );
    });
  });

  describe("pairing windows", () => {
    const WINDOW = { codeSha256: "c".repeat(64), expiresAt: "2026-10-26T12:05:00.000Z" };
    const NEWER = { codeSha256: "d".repeat(64), expiresAt: "2026-10-26T12:06:00.000Z" };

    test("none is open when nothing opened one", async () => {
      const store = new FileConfigStore(await tempDir());
      assert.equal(await store.loadPairingWindow(WINDOW.codeSha256), null);
    });

    test("a window is saved readable by the owner only, read back by its code, then cleared", async () => {
      const dir = await tempDir();
      await new FileConfigStore(dir).savePairingWindow(WINDOW);

      assert.equal((await stat(join(dir, "pairing-windows"))).mode & 0o777, 0o700);
      assert.deepEqual(await new FileConfigStore(dir).loadPairingWindow(WINDOW.codeSha256), WINDOW);
      assert.equal(await new FileConfigStore(dir).loadPairingWindow(NEWER.codeSha256), null);
      await new FileConfigStore(dir).clearPairingWindow(WINDOW.codeSha256);
      assert.equal(await new FileConfigStore(dir).loadPairingWindow(WINDOW.codeSha256), null);
      await new FileConfigStore(dir).clearPairingWindow(WINDOW.codeSha256);
    });

    test("opening a window leaves the others open", async () => {
      const dir = await tempDir();
      const store = new FileConfigStore(dir);
      await store.savePairingWindow(WINDOW);

      await store.savePairingWindow(NEWER);

      assert.deepEqual(await store.loadPairingWindow(WINDOW.codeSha256), WINDOW);
      assert.deepEqual(await store.loadPairingWindow(NEWER.codeSha256), NEWER);
    });

    test("clearing an old window leaves a newer one alone", async () => {
      const dir = await tempDir();
      const store = new FileConfigStore(dir);
      await store.savePairingWindow(NEWER);

      await store.clearPairingWindow(WINDOW.codeSha256);

      assert.deepEqual(await store.loadPairingWindow(NEWER.codeSha256), NEWER);
    });

    test("refuses a damaged window rather than opening it", async () => {
      const dir = await privateDir();
      await mkdir(join(dir, "pairing-windows"), { mode: 0o700 });
      await writeFile(
        join(dir, "pairing-windows", `${WINDOW.codeSha256}.json`),
        JSON.stringify({ expiresAt: "x" }),
        { mode: 0o600 },
      );

      await assert.rejects(
        new FileConfigStore(dir).loadPairingWindow(WINDOW.codeSha256),
        /damaged/,
      );
    });
  });
});

async function privateDir(): Promise<string> {
  const dir = await tempDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

describe("OpenAI key and voice settings", () => {
  test("reads the key from openai.env; none when the file is missing", async () => {
    const dir = await privateDir();
    assert.equal(await new FileConfigStore(dir).loadOpenAiKey(), null);

    await writeFile(join(dir, "openai.env"), '# OpenAI\nOPENAI_API_KEY="sk-test-key-123456"\n', {
      mode: 0o600,
    });
    assert.equal(await new FileConfigStore(dir).loadOpenAiKey(), "sk-test-key-123456");
  });

  test("refuses a key file other users can read, or one without the key, without printing it", async () => {
    const dir = await privateDir();
    await writeFile(join(dir, "openai.env"), "OPENAI_API_KEY=sk-test-key-123456\n", {
      mode: 0o644,
    });
    await chmod(join(dir, "openai.env"), 0o644);
    await assert.rejects(new FileConfigStore(dir).loadOpenAiKey(), (error: Error) => {
      assert.match(error.message, /chmod 600/);
      assert.doesNotMatch(error.message, /sk-test/);
      return true;
    });

    await writeFile(join(dir, "openai.env"), "OPENAI_KEY=sk-test-key-123456\n", { mode: 0o600 });
    await chmod(join(dir, "openai.env"), 0o600);
    await assert.rejects(new FileConfigStore(dir).loadOpenAiKey(), (error: Error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /no OPENAI_API_KEY/);
      assert.doesNotMatch(error.message, /sk-test/);
      return true;
    });
  });

  test("reads the voice settings, and refuses one that is not a name", async () => {
    const dir = await privateDir();
    const voice = {
      model: "gpt-live-1",
      voice: "brise",
      delegationModel: "gpt-5.6-terra",
      summaryModel: "gpt-5.4-mini",
    };
    await new FileConfigStore(dir).saveConfig({ t3: { baseUrl: "http://127.0.0.1:3773" }, voice });
    assert.deepEqual((await new FileConfigStore(dir).loadConfig())?.voice, voice);

    const config = { t3: { baseUrl: "http://127.0.0.1:3773" }, voice: { voice: "" } };
    await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(
      new FileConfigStore(dir).loadConfig(),
      /"voice.voice" must be a name, e.g. "brise"/,
    );

    const delegation = {
      t3: { baseUrl: "http://127.0.0.1:3773" },
      voice: { delegationModel: "a b" },
    };
    await writeFile(join(dir, "config.json"), JSON.stringify(delegation), { mode: 0o600 });
    await assert.rejects(
      new FileConfigStore(dir).loadConfig(),
      /"voice.delegationModel" must be a name, e.g. "gpt-5.6-terra"/,
    );

    const summary = { t3: { baseUrl: "http://127.0.0.1:3773" }, voice: { summaryModel: 5 } };
    await writeFile(join(dir, "config.json"), JSON.stringify(summary), { mode: 0o600 });
    await assert.rejects(
      new FileConfigStore(dir).loadConfig(),
      /"voice.summaryModel" must be a name, e.g. "gpt-5.4-mini"/,
    );
  });
});
