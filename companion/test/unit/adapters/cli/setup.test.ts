import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runSetup } from "../../../../src/adapters/cli/setup.ts";
import { T3IncompatibleError } from "../../../../src/ports/t3Backend.ts";
import { FakeT3Connector, InMemoryConfigStore } from "../../fakePorts.ts";

function setup(store: InMemoryConfigStore, t3: FakeT3Connector, t3Url?: string) {
  const lines: string[] = [];
  const done = runSetup({
    store,
    t3,
    ...(t3Url ? { t3Url } : {}),
    readPairingLink: async () => "http://127.0.0.1:3773/pair#token=PAIRCODE",
    out: (line) => lines.push(line),
  });
  return { lines, done };
}

describe("runSetup", () => {
  test("pairs with T3 on loopback by default and saves the session", async () => {
    const store = new InMemoryConfigStore();
    const t3 = new FakeT3Connector();

    const { lines, done } = setup(store, t3);
    await done;

    assert.deepEqual(store.config, { t3: { baseUrl: "http://127.0.0.1:3773" } });
    assert.equal(store.session?.token, "secret-session-token");
    assert.deepEqual(t3.calls, [
      "checkServer http://127.0.0.1:3773",
      "pair http://127.0.0.1:3773 http://127.0.0.1:3773/pair#token=PAIRCODE",
      "connect http://127.0.0.1:3773 with token",
      "checkServer http://127.0.0.1:3773",
    ]);
    const output = lines.join("\n");
    assert.ok(!output.includes("secret-session-token"), "the token is never printed");
    assert.ok(!output.includes("PAIRCODE"), "the pairing code is never printed");
  });

  test("keeps the saved T3 URL unless --t3-url overrides it", async () => {
    const store = new InMemoryConfigStore();
    store.config = { t3: { baseUrl: "http://10.0.0.5:3773", acceptedServerVersions: ["0.1.0"] } };
    const t3 = new FakeT3Connector();

    await setup(store, t3).done;
    assert.equal(store.config?.t3.baseUrl, "http://10.0.0.5:3773");
    assert.deepEqual(store.config?.t3.acceptedServerVersions, ["0.1.0"]);

    await setup(store, t3, "http://127.0.0.1:4000").done;
    assert.equal(store.config?.t3.baseUrl, "http://127.0.0.1:4000");
  });

  test("checks the T3 version before asking for a pairing link", async () => {
    const store = new InMemoryConfigStore();
    const t3 = new FakeT3Connector();
    t3.serverVersion = "0.2.0";

    await assert.rejects(setup(store, t3).done, T3IncompatibleError);
    assert.deepEqual(t3.calls, ["checkServer http://127.0.0.1:3773"]);
    assert.equal(store.session, null);
  });

  test("refuses a pairing that does not grant both orchestration scopes", async () => {
    const store = new InMemoryConfigStore();
    const t3 = new FakeT3Connector();
    t3.grantedScopes = ["orchestration:read"];

    await assert.rejects(setup(store, t3).done, /does not grant orchestration:operate/);
    assert.equal(store.session, null);
  });
});
