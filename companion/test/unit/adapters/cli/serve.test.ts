import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runServe } from "../../../../src/adapters/cli/serve.ts";
import type { ApiServerOptions } from "../../../../src/ports/apiServer.ts";
import { T3IncompatibleError } from "../../../../src/ports/t3Backend.ts";
import { project, thread } from "../../builders.ts";
import { FakeT3Connector, InMemoryConfigStore } from "../../fakePorts.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function setUpStore(): InMemoryConfigStore {
  const store = new InMemoryConfigStore();
  store.config = { t3: { baseUrl: "http://127.0.0.1:3773" } };
  store.pairing = {
    baseUrl: "http://127.0.0.1:3773",
    token: "secret-pairing-token",
    scopes: ["orchestration:read", "orchestration:operate"],
    expiresAt: "2026-11-25T14:00:00.000Z",
  };
  return store;
}

function serve(store: InMemoryConfigStore, t3 = new FakeT3Connector()) {
  const lines: string[] = [];
  const started: ApiServerOptions[] = [];
  let closed = false;
  let stop = () => {};
  const done = runServe({
    store,
    t3,
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
    now: () => NOW,
  });
  const listenOptions = () => started.map(({ activity: _activity, ...rest }) => rest);
  const activity = () => started[0]?.activity();
  return {
    lines,
    started,
    listenOptions,
    activity,
    done,
    stop: () => stop(),
    isClosed: () => closed,
  };
}

/** Lets the fake T3 connect and send its snapshot. */
async function settle() {
  for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
}

describe("runServe", () => {
  test("connects to T3, then listens on loopback port 8787 by default, until asked to stop", async () => {
    const t3 = new FakeT3Connector();
    const run = serve(setUpStore(), t3);
    await settle();

    assert.deepEqual(run.listenOptions(), [{ host: "127.0.0.1", port: 8787 }]);
    assert.deepEqual(t3.calls, [
      "connect http://127.0.0.1:3773 with token",
      "checkServer http://127.0.0.1:3773",
    ]);
    assert.deepEqual(run.lines, [
      "Connected to T3 0.1.0 at http://127.0.0.1:3773.",
      "Listening on http://127.0.0.1:8787 (0 paired devices).",
    ]);
    assert.equal(run.isClosed(), false);
    run.stop();
    await run.done;
    assert.equal(run.isClosed(), true);
    assert.equal(t3.backend.closed, true);
  });

  test("uses the address and the client IP header from the config", async () => {
    const store = setUpStore();
    store.config = {
      t3: { baseUrl: "http://127.0.0.1:3773" },
      server: { host: "127.0.0.1", port: 9000, clientIpHeader: "cf-connecting-ip" },
    };

    const run = serve(store);
    await settle();
    run.stop();
    await run.done;

    assert.deepEqual(run.listenOptions(), [
      { host: "127.0.0.1", port: 9000, clientIpHeader: "cf-connecting-ip" },
    ]);
  });

  test("refuses to start before setup", async () => {
    const run = serve(new InMemoryConfigStore());

    await assert.rejects(run.done, /t3-voice setup/);
    assert.deepEqual(run.started, []);
  });

  test("refuses to start when T3 is not a tested version (fail closed)", async () => {
    const t3 = new FakeT3Connector();
    t3.serverVersion = "9.9.9";
    const run = serve(setUpStore(), t3);

    await assert.rejects(run.done, T3IncompatibleError);
    assert.deepEqual(run.started, []);
  });

  test("stops when T3 fails for good, for example after an upgrade to an untested version", async () => {
    const t3 = new FakeT3Connector();
    const run = serve(setUpStore(), t3);
    await settle();

    t3.backend.subscriber?.onFatalError?.(new T3IncompatibleError(["server version is 9.9.9"]));

    await assert.rejects(run.done, T3IncompatibleError);
    assert.equal(run.isClosed(), true);
    assert.equal(t3.backend.closed, true);
  });

  describe("activity", () => {
    test("lists running threads, and threads that finished in the last 24 hours", async () => {
      const t3 = new FakeT3Connector();
      t3.backend.projects = [project("p1", "Joombo")];
      t3.backend.threads = [
        thread("t1", {
          title: "Fix the Reviews tests",
          status: "running",
          activeRunStatus: "running",
          updatedAt: "2026-10-26T11:58:00.000Z",
        }),
        thread("t2", {
          title: "Bump Rails",
          pendingRequest: { id: "r1", kind: "command", blocking: true },
          activeRunStatus: "running",
          updatedAt: "2026-10-26T11:50:00.000Z",
        }),
        thread("t3", {
          title: "Which database?",
          pendingRequest: { id: "r2", kind: "user_input", blocking: true },
          updatedAt: "2026-10-26T11:40:00.000Z",
        }),
        thread("t4", { title: "Add a README", updatedAt: "2026-10-26T09:00:00.000Z" }),
        thread("t5", {
          title: "Deploy",
          status: "failed",
          lastError: { message: "usage limit", failureClass: "usage_limit" },
          updatedAt: "2026-10-26T10:00:00.000Z",
        }),
        thread("old", { title: "Yesterday's work", updatedAt: "2026-10-25T11:59:59.000Z" }),
        thread("archived", { archived: true, updatedAt: "2026-10-26T11:00:00.000Z" }),
        thread("sub", { isSubagent: true, updatedAt: "2026-10-26T11:00:00.000Z" }),
      ];
      const run = serve(setUpStore(), t3);
      await settle();

      assert.deepEqual(run.activity(), {
        running: [
          {
            threadId: "t1",
            title: "Fix the Reviews tests",
            project: "Joombo",
            state: "running",
            updatedAt: "2026-10-26T11:58:00.000Z",
          },
          {
            threadId: "t2",
            title: "Bump Rails",
            project: "Joombo",
            state: "waiting_for_approval",
            updatedAt: "2026-10-26T11:50:00.000Z",
          },
          {
            threadId: "t3",
            title: "Which database?",
            project: "Joombo",
            state: "waiting_for_input",
            updatedAt: "2026-10-26T11:40:00.000Z",
          },
        ],
        finished: [
          {
            threadId: "t5",
            title: "Deploy",
            project: "Joombo",
            state: "failed",
            updatedAt: "2026-10-26T10:00:00.000Z",
          },
          {
            threadId: "t4",
            title: "Add a README",
            project: "Joombo",
            state: "completed",
            updatedAt: "2026-10-26T09:00:00.000Z",
          },
        ],
      });
      run.stop();
      await run.done;
    });

    test("keeps the list small: 10 running and 10 finished threads at most, the latest first", async () => {
      const t3 = new FakeT3Connector();
      const minutesAgo = (minutes: number) =>
        new Date(NOW.getTime() - minutes * 60_000).toISOString();
      for (let index = 0; index < 12; index++) {
        t3.backend.threads.push(
          thread(`running-${index}`, { status: "running", updatedAt: minutesAgo(index) }),
          thread(`done-${index}`, { updatedAt: minutesAgo(index) }),
        );
      }
      const run = serve(setUpStore(), t3);
      await settle();

      const activity = run.activity();
      assert.equal(activity?.running.length, 10);
      assert.equal(activity?.finished.length, 10);
      assert.equal(activity?.running[0]?.threadId, "running-0");
      assert.equal(activity?.finished[9]?.threadId, "done-9");
      assert.equal(activity?.running[0]?.project, null, "T3 sent no project p1");
      run.stop();
      await run.done;
    });

    test("is unavailable while T3 reconnects", async () => {
      const t3 = new FakeT3Connector();
      const run = serve(setUpStore(), t3);
      await settle();
      assert.notEqual(run.activity(), null);

      t3.backend.subscriber?.onConnectionChange?.("reconnecting");
      assert.equal(run.activity(), null);
      t3.backend.subscriber?.onConnectionChange?.("connected");
      assert.notEqual(run.activity(), null);
      run.stop();
      await run.done;
    });
  });
});
