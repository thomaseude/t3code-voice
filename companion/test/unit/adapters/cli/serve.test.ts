import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runServe, type VoiceEngineSettings } from "../../../../src/adapters/cli/serve.ts";
import type { ActivityItem, ApiServerOptions } from "../../../../src/ports/apiServer.ts";
import { T3IncompatibleError } from "../../../../src/ports/t3Backend.ts";
import { pairedDevice, project, thread } from "../../builders.ts";
import {
  FakeClock,
  FakeT3Connector,
  FakeVoiceEngine,
  InMemoryConfigStore,
  settle,
} from "../../fakePorts.ts";

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
  store.openAiKey = "sk-test-key-123456";
  return store;
}

function serve(store: InMemoryConfigStore, t3 = new FakeT3Connector()) {
  const lines: string[] = [];
  const engines: VoiceEngineSettings[] = [];
  const engine = new FakeVoiceEngine();
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
    voiceEngine: (settings) => {
      engines.push(settings);
      return engine;
    },
    out: (line) => lines.push(line),
    clock: new FakeClock(NOW.getTime()),
  });
  const listenOptions = () =>
    started.map(({ activity: _activity, voiceSessions: _voiceSessions, ...rest }) => rest);
  const activity = () => started[0]?.activity();
  return {
    lines,
    engines,
    engine,
    started,
    listenOptions,
    activity,
    done,
    stop: () => stop(),
    isClosed: () => closed,
  };
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
        thread("t4", {
          title: "Add a README",
          status: "completed",
          updatedAt: "2026-10-26T09:00:00.000Z",
        }),
        thread("t5", {
          title: "Deploy",
          status: "failed",
          lastError: { message: "usage limit", failureClass: "usage_limit" },
          updatedAt: "2026-10-26T10:00:00.000Z",
        }),
        thread("old", {
          title: "Yesterday's work",
          status: "completed",
          updatedAt: "2026-10-25T11:59:59.000Z",
        }),
        thread("archived", {
          status: "completed",
          archived: true,
          updatedAt: "2026-10-26T11:00:00.000Z",
        }),
        thread("sub", {
          status: "completed",
          isSubagent: true,
          updatedAt: "2026-10-26T11:00:00.000Z",
        }),
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

    test("follows T3's awareness rule: interrupted, cancelled, queued and never-run threads are left out", async () => {
      const t3 = new FakeT3Connector();
      const recent = "2026-10-26T11:00:00.000Z";
      t3.backend.threads = [
        thread("done", { status: "completed", updatedAt: recent }),
        thread("never-run", { status: "idle", updatedAt: recent }),
        thread("interrupted", { status: "interrupted", updatedAt: recent }),
        thread("cancelled", { status: "cancelled", updatedAt: recent }),
        thread("rolled-back", { status: "rolled_back", updatedAt: recent }),
        thread("queued", { status: "queued", updatedAt: recent }),
        thread("starting", { status: "starting", updatedAt: recent }),
        thread("checkpoint", { status: "waiting", updatedAt: recent }),
        thread("auth", {
          status: "running",
          pendingRequest: { id: "r1", kind: "auth_refresh", blocking: true },
          updatedAt: recent,
        }),
        thread("async-question", {
          status: "running",
          pendingRequest: { id: "r2", kind: "user_input", blocking: false },
          updatedAt: recent,
        }),
        thread("question-after-run", {
          status: "completed",
          pendingRequest: { id: "r3", kind: "user_input", blocking: false },
          updatedAt: recent,
        }),
      ];
      const run = serve(setUpStore(), t3);
      await settle();

      const states = (items: ActivityItem[] = []) =>
        Object.fromEntries(items.map((item) => [item.threadId, item.state]));
      assert.deepEqual(states(run.activity()?.running), {
        starting: "running",
        checkpoint: "running",
        auth: "running",
        "async-question": "running",
        "question-after-run": "waiting_for_input",
      });
      assert.deepEqual(states(run.activity()?.finished), { done: "completed" });
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
          thread(`done-${index}`, { status: "completed", updatedAt: minutesAgo(index) }),
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

describe("voice sessions", () => {
  test("with an OpenAI key, sessions open with GPT-Live and the configured settings", async () => {
    const store = setUpStore();
    store.config = { t3: { baseUrl: "http://127.0.0.1:3773" }, voice: { voice: "cedar" } };
    const run = serve(store);
    await settle();

    const result = await run.started[0]?.voiceSessions.open("d1", {
      sdpOffer: "v=0",
      timeZone: null,
    });

    assert.equal(result?.status, "opened");
    assert.deepEqual(run.engines, [
      {
        apiKey: "sk-test-key-123456",
        model: "gpt-live-1",
        voice: "cedar",
        delegationModel: "gpt-5.6-terra",
      },
    ]);
    assert.ok(run.lines.every((line) => !line.includes("sk-test")));
    run.stop();
    await run.done;
  });

  test("without an OpenAI key, serve still starts, says so, and sessions are unavailable", async () => {
    const store = setUpStore();
    store.openAiKey = null;
    const run = serve(store);
    await settle();

    const result = await run.started[0]?.voiceSessions.open("d1", {
      sdpOffer: "v=0",
      timeZone: null,
    });

    assert.deepEqual(result, { status: "unavailable" });
    assert.ok(
      run.lines.includes(
        "No OpenAI key in /home/me/.config/t3voice/openai.env: voice sessions are off.",
      ),
    );
    run.stop();
    await run.done;
  });

  test("stopping serve ends the open sessions, so none keeps costing", async () => {
    const run = serve(setUpStore());
    await settle();
    await run.started[0]?.voiceSessions.open("d1", { sdpOffer: "v=0", timeZone: null });

    run.stop();
    await run.done;

    assert.equal(run.engine.last.closed, true);
  });

  test("while T3 reconnects, the voice tools say T3 is unavailable", async () => {
    const store = setUpStore();
    store.devices = [pairedDevice({ id: "d1" })];
    const t3 = new FakeT3Connector();
    t3.backend.projects = [project("p1", "Joombo")];
    const run = serve(store, t3);
    await settle();
    await run.started[0]?.voiceSessions.open("d1", { sdpOffer: "v=0", timeZone: null });

    t3.backend.subscriber?.onConnectionChange?.("reconnecting");
    run.engine.last.emit({ type: "tool_call", callId: "c1", name: "list_projects", arguments: {} });
    await settle();

    assert.deepEqual(run.engine.last.toolResults, [
      { callId: "c1", result: { error: "t3_unavailable" } },
    ]);
    run.stop();
    await run.done;
  });

  test("a device revoked by the CLI gets no T3 data from its open session", async () => {
    const store = setUpStore();
    store.devices = [pairedDevice({ id: "d1" })];
    const run = serve(store);
    await settle();
    await run.started[0]?.voiceSessions.open("d1", { sdpOffer: "v=0", timeZone: null });

    await store.revokeDevice("d1", "2026-10-26T12:00:00.000Z");
    run.engine.last.emit({ type: "tool_call", callId: "c1", name: "list_projects", arguments: {} });
    await settle();

    assert.deepEqual(run.engine.last.toolResults, [
      { callId: "c1", result: { error: "device_revoked" } },
    ]);
    assert.equal(run.engine.last.closed, true);
    run.stop();
    await run.done;
  });
});
