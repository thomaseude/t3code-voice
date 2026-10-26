import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { runPair } from "../../../../src/adapters/cli/pair.ts";
import { pairedDevice } from "../../builders.ts";
import { InMemoryConfigStore } from "../../fakePorts.ts";

const START = Date.parse("2026-10-26T12:00:00.000Z");

function setUpStore(): InMemoryConfigStore {
  const store = new InMemoryConfigStore();
  store.config = {
    t3: { baseUrl: "http://127.0.0.1:3773" },
    server: { publicUrl: "https://voice.example.com" },
  };
  return store;
}

/**
 * Runs `t3-voice pair`. `onTick` runs at each poll, with the clock already moved one
 * second on; returning "stop" plays a Ctrl-C.
 */
function pair(store: InMemoryConfigStore, onTick: (clock: { now: number }) => "stop" | undefined) {
  const clock = { now: START };
  const lines: string[] = [];
  const qrTexts: string[] = [];
  const done = runPair({
    store,
    out: (line) => lines.push(line),
    now: () => clock.now,
    wait: async (ms) => {
      clock.now += ms;
      return onTick(clock) ?? "tick";
    },
    renderQr: (text) => {
      qrTexts.push(text);
      return "[QR]";
    },
  });
  return { done, lines, qrTexts, clock };
}

const codeOf = (qrText: string) => new URL(qrText).searchParams.get("code") ?? "";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("t3-voice pair", () => {
  test("shows a QR code with the public URL and a one-time code, never the code as text", async () => {
    const store = setUpStore();
    let windowWhileOpen = store.pairingWindow;
    const run = pair(store, () => {
      windowWhileOpen = store.pairingWindow;
      return "stop";
    });
    await run.done;

    assert.equal(run.qrTexts.length, 1);
    const qr = new URL(run.qrTexts[0] ?? "");
    assert.equal(qr.protocol, "t3voice:");
    assert.equal(qr.host, "pair");
    assert.equal(qr.searchParams.get("url"), "https://voice.example.com");
    const code = codeOf(run.qrTexts[0] ?? "");
    assert.ok(code.length >= 22, "128 bits at least");
    assert.equal(windowWhileOpen?.codeSha256, sha256(code));
    assert.equal(windowWhileOpen?.expiresAt, "2026-10-26T12:05:00.000Z");
    assert.equal(run.lines[0], "[QR]");
    assert.ok(run.lines.includes("Scan this QR code with T3 Voice. It works once, for 5 minutes."));
    assert.ok(!run.lines.join("\n").includes(code));
  });

  test("says which device paired, then stops", async () => {
    const store = setUpStore();
    const run = pair(store, () => {
      // What POST /pair does in `t3-voice serve`.
      store.pairingWindow = null;
      store.devices.push(pairedDevice({ id: "3f9a2c1b", name: "iPhone de Thomas" }));
      return undefined;
    });

    assert.equal(await run.done, 0);
    assert.equal(run.lines.at(-1), 'Paired "iPhone de Thomas" (3f9a2c1b).');
  });

  test("closes the window when it expires", async () => {
    const store = setUpStore();
    const run = pair(store, () => undefined);

    assert.equal(await run.done, 1);
    assert.equal(run.clock.now, START + 5 * 60_000);
    assert.equal(store.pairingWindow, null);
    assert.equal(run.lines.at(-1), 'The pairing window expired. Run "t3-voice pair" again.');
  });

  test("Ctrl-C closes the window", async () => {
    const store = setUpStore();
    const run = pair(store, () => "stop");

    assert.equal(await run.done, 1);
    assert.equal(store.pairingWindow, null);
    assert.equal(run.lines.at(-1), "Pairing cancelled.");
  });

  test("leaves alone a window that another `t3-voice pair` opened", async () => {
    const store = setUpStore();
    const other = { codeSha256: "c".repeat(64), expiresAt: "2026-10-26T12:06:00.000Z" };
    const run = pair(store, () => {
      store.pairingWindow = other;
      return "stop";
    });

    assert.equal(await run.done, 1);
    assert.equal(store.pairingWindow, other);
    assert.equal(run.lines.at(-1), 'Another "t3-voice pair" replaced this pairing window.');
  });

  test("needs the public URL of the companion", async () => {
    const store = setUpStore();
    store.config = { t3: { baseUrl: "http://127.0.0.1:3773" } };

    await assert.rejects(
      pair(store, () => "stop").done,
      /"server\.publicUrl".*config\.json.*https:\/\/voice\.example\.com/s,
    );
    assert.equal(store.pairingWindow, null);
  });
});
