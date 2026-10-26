import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runServe, type ServerOptions } from "../../../../src/adapters/cli/serve.ts";
import { InMemoryConfigStore } from "../../fakePorts.ts";

function serve(store: InMemoryConfigStore) {
  const lines: string[] = [];
  const started: ServerOptions[] = [];
  let closed = false;
  let stop = () => {};
  const done = runServe({
    store,
    startServer: async (options) => {
      started.push(options);
      return {
        url: `http://${options.host}:${options.port}`,
        close: async () => {
          closed = true;
        },
      };
    },
    waitForStop: () => new Promise<void>((resolve) => (stop = resolve)),
    out: (line) => lines.push(line),
  });
  return { lines, started, done, stop: () => stop(), isClosed: () => closed };
}

describe("runServe", () => {
  test("listens on loopback port 8787 by default, until asked to stop", async () => {
    const store = new InMemoryConfigStore();
    store.config = { t3: { baseUrl: "http://127.0.0.1:3773" } };

    const run = serve(store);
    await new Promise(setImmediate);

    assert.deepEqual(run.started, [{ host: "127.0.0.1", port: 8787 }]);
    assert.deepEqual(run.lines, ["Listening on http://127.0.0.1:8787 (0 paired devices)."]);
    assert.equal(run.isClosed(), false);
    run.stop();
    await run.done;
    assert.equal(run.isClosed(), true);
  });

  test("uses the address and the client IP header from the config", async () => {
    const store = new InMemoryConfigStore();
    store.config = {
      t3: { baseUrl: "http://127.0.0.1:3773" },
      server: { host: "127.0.0.1", port: 9000, clientIpHeader: "cf-connecting-ip" },
    };

    const run = serve(store);
    await new Promise(setImmediate);
    run.stop();
    await run.done;

    assert.deepEqual(run.started, [
      { host: "127.0.0.1", port: 9000, clientIpHeader: "cf-connecting-ip" },
    ]);
  });

  test("refuses to start before setup", async () => {
    const run = serve(new InMemoryConfigStore());

    await assert.rejects(run.done, /t3-voice setup/);
    assert.deepEqual(run.started, []);
  });
});
