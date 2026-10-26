import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
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
    const { revokedAt: _, ...withoutRevocation } = DEVICE;
    await writeFile(join(dir, "devices.json"), JSON.stringify({ devices: [withoutRevocation] }), {
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

    test("changes made at the same time by `serve` and the CLI are all kept", async () => {
      const dir = await tempDir();
      // Two stores on one directory, like two processes.
      const serve = new FileConfigStore(dir);
      const cli = new FileConfigStore(dir);

      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? serve : cli).updateDevices((devices) => [
            ...devices,
            pairedDevice({ id: `d${index}` }),
          ]),
        ),
      );

      const ids = (await serve.loadDevices()).map((device) => device.id).sort();
      assert.equal(ids.length, 20);
    });

    test("takes over a lock left by a process that died", async () => {
      const dir = await privateDir();
      const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
      await writeFile(join(dir, "devices.json.lock"), String(deadPid), { mode: 0o600 });

      await new FileConfigStore(dir).updateDevices((devices) => [...devices, DEVICE]);

      assert.deepEqual(await new FileConfigStore(dir).loadDevices(), [DEVICE]);
    });

    test("waits for the lock of a running process, however old the lock is", async () => {
      const dir = await privateDir();
      const lock = join(dir, "devices.json.lock");
      await writeFile(lock, String(process.pid), { mode: 0o600 });
      const longAgo = new Date(Date.now() - 60_000);
      await utimes(lock, longAgo, longAgo);
      let released = false;
      setTimeout(async () => {
        released = true;
        await rm(lock);
      }, 100);

      await new FileConfigStore(dir).updateDevices((devices) => {
        assert.ok(released, "the change ran while the other process held the lock");
        return [...devices, DEVICE];
      });

      assert.deepEqual(await new FileConfigStore(dir).loadDevices(), [DEVICE]);
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

  describe("the pairing window", () => {
    const WINDOW = { codeSha256: "c".repeat(64), expiresAt: "2026-10-26T12:05:00.000Z" };

    test("is closed when nothing opened it", async () => {
      assert.equal(await new FileConfigStore(await tempDir()).loadPairingWindow(), null);
    });

    test("is saved readable by the owner only, read back, then cleared", async () => {
      const dir = await tempDir();
      await new FileConfigStore(dir).savePairingWindow(WINDOW);

      assert.equal((await stat(join(dir, "pairing-window.json"))).mode & 0o777, 0o600);
      assert.deepEqual(await new FileConfigStore(dir).loadPairingWindow(), WINDOW);
      await new FileConfigStore(dir).clearPairingWindow(WINDOW.codeSha256);
      assert.equal(await new FileConfigStore(dir).loadPairingWindow(), null);
      await new FileConfigStore(dir).clearPairingWindow(WINDOW.codeSha256);
    });

    test("clearing leaves alone a window that holds another code", async () => {
      const dir = await tempDir();
      const newer = { ...WINDOW, codeSha256: "d".repeat(64) };
      await new FileConfigStore(dir).savePairingWindow(newer);

      await new FileConfigStore(dir).clearPairingWindow(WINDOW.codeSha256);

      assert.deepEqual(await new FileConfigStore(dir).loadPairingWindow(), newer);
    });

    test("refuses a damaged window rather than opening it", async () => {
      const dir = await privateDir();
      await writeFile(join(dir, "pairing-window.json"), JSON.stringify({ expiresAt: "x" }), {
        mode: 0o600,
      });

      await assert.rejects(new FileConfigStore(dir).loadPairingWindow(), /damaged/);
    });
  });
});

async function privateDir(): Promise<string> {
  const dir = await tempDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}
