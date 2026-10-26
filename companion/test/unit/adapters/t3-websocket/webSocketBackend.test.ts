import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_T3_PIN } from "../../../../src/adapters/t3-websocket/compatibility.ts";
import { T3HttpError } from "../../../../src/adapters/t3-websocket/http.ts";
import { RpcError } from "../../../../src/adapters/t3-websocket/rpcConnection.ts";
import { WebSocketT3Backend } from "../../../../src/adapters/t3-websocket/webSocketBackend.ts";
import type { ShellEvent } from "../../../../src/ports/t3Backend.ts";
import { T3IncompatibleError } from "../../../../src/ports/t3Backend.ts";
import { FakeTransport, settle, shellSnapshot, wireProject, wireThread } from "./fakes.ts";

function makeBackend(transport: FakeTransport) {
  // Retries wait one turn of the event loop instead of real seconds.
  const wait = () => new Promise<void>((resolve) => setImmediate(resolve));
  return new WebSocketT3Backend({ transport, pin: DEFAULT_T3_PIN, wait });
}

function recordShell(backend: WebSocketT3Backend, options?: { afterSequence?: number }) {
  const events: ShellEvent[] = [];
  const fatalErrors: Error[] = [];
  const subscription = backend.subscribeShell(
    { onEvent: (event) => events.push(event), onFatalError: (error) => fatalErrors.push(error) },
    options,
  );
  return { events, fatalErrors, subscription };
}

describe("startup check", () => {
  test("refuses a server with another protocol version before opening a socket", async () => {
    const transport = new FakeTransport();
    transport.descriptor = { ...transport.descriptor, orchestrationProtocolVersion: 3 };

    await assert.rejects(
      WebSocketT3Backend.connect({ transport, pin: DEFAULT_T3_PIN }),
      T3IncompatibleError,
    );
    assert.equal(transport.connections.length, 0);
  });

  test("refuses an untested server version", async () => {
    const transport = new FakeTransport();
    transport.descriptor = { ...transport.descriptor, serverVersion: "0.2.0" };

    await assert.rejects(
      WebSocketT3Backend.connect({ transport, pin: DEFAULT_T3_PIN }),
      /server version is 0\.2\.0/,
    );
    assert.equal(transport.connections.length, 0);
  });

  test("refuses a server missing a required capability", async () => {
    const transport = new FakeTransport();
    const pin = { ...DEFAULT_T3_PIN, requiredCapabilities: ["threadSettlement", "voiceFriendly"] };

    await assert.rejects(
      WebSocketT3Backend.connect({ transport, pin }),
      /required capability "voiceFriendly" is missing/,
    );
  });

  test("connects to a tested server", async () => {
    const transport = new FakeTransport();
    const backend = await WebSocketT3Backend.connect({ transport, pin: DEFAULT_T3_PIN });

    assert.equal(transport.connections.length, 1);
    assert.deepEqual(backend.serverInfo(), { version: "0.1.0", protocolVersion: 2 });
  });
});

describe("getConfig", () => {
  test("returns providers, models and the default runtime mode", async () => {
    const transport = new FakeTransport();
    const backend = makeBackend(transport);
    await backend.connection();
    transport.lastConnection().responses.set("server.getConfig", {
      providers: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: true,
          status: "ready",
          models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false }],
          slashCommands: [],
        },
        {
          instanceId: "cursor",
          driver: "cursor",
          displayName: "Cursor",
          enabled: false,
          models: [],
        },
      ],
      settings: {
        defaultRuntimeMode: "approval-required",
        defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      },
    });

    const config = await backend.getConfig();

    assert.deepEqual(config, {
      providers: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: true,
          status: "ready",
          models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }],
        },
        {
          instanceId: "cursor",
          driver: "cursor",
          displayName: "Cursor",
          enabled: false,
          status: "unknown",
          models: [],
        },
      ],
      defaultRuntimeMode: "approval-required",
      defaultModel: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" },
    });
  });
});

describe("listProjects", () => {
  test("reads the projects from the shell snapshot, then stops the stream", async () => {
    const transport = new FakeTransport();
    const backend = makeBackend(transport);

    const projects = backend.listProjects();
    await settle();
    const stream = transport.lastConnection().lastStream();
    stream.push({ kind: "synchronized" }, shellSnapshot(4, [wireProject("p1", "joombo")]));

    assert.deepEqual(await projects, [
      { id: "p1", title: "joombo", workspaceRoot: "/home/me/joombo" },
    ]);
    assert.equal(stream.tag, "orchestration.subscribeShell");
    assert.equal(stream.cancelled, true);
  });

  test("gives up when T3 sends no full snapshot in time", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const transport = new FakeTransport();
    const backend = makeBackend(transport);

    const projects = backend.listProjects();
    await settle();
    const stream = transport.lastConnection().lastStream();
    stream.push({ kind: "synchronized" });
    t.mock.timers.tick(15_000);

    await assert.rejects(projects, /did not send the project list in time/);
    assert.equal(stream.cancelled, true);
  });
});

describe("answer timeout", () => {
  test("getConfig gives up when T3 never answers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const transport = new FakeTransport();
    const backend = makeBackend(transport);
    await backend.connection();
    transport.lastConnection().silent = true;

    const config = backend.getConfig();
    await settle();
    t.mock.timers.tick(15_000);

    await assert.rejects(config, /did not send its configuration in time/);
  });
});

describe("subscribeShell", () => {
  test("delivers the snapshot, then deltas in order", async () => {
    const transport = new FakeTransport();
    const { events } = recordShell(makeBackend(transport));
    await settle();
    const stream = transport.lastConnection().lastStream();

    stream.push(
      shellSnapshot(10, [wireProject("p1")]),
      { kind: "synchronized" },
      { kind: "thread.updated", sequence: 11, location: "active", thread: wireThread("t1") },
      { kind: "project.removed", sequence: 12, projectId: "p1" },
    );

    assert.deepEqual(
      events.map((event) => [event.type, event.sequence]),
      [
        ["snapshot", 10],
        ["thread.updated", 11],
        ["project.removed", 12],
      ],
    );
  });

  test("drops events replayed with a sequence it already delivered", async () => {
    const transport = new FakeTransport();
    const { events } = recordShell(makeBackend(transport));
    await settle();
    const stream = transport.lastConnection().lastStream();

    stream.push(
      shellSnapshot(10, []),
      { kind: "thread.updated", sequence: 12, location: "active", thread: wireThread("t1") },
      { kind: "thread.updated", sequence: 11, location: "active", thread: wireThread("t1") },
      { kind: "thread.updated", sequence: 12, location: "active", thread: wireThread("t1") },
      { kind: "thread.updated", sequence: 13, location: "active", thread: wireThread("t1") },
    );

    assert.deepEqual(
      events.map((event) => event.sequence),
      [10, 12, 13],
    );
  });

  test("starts from the given cursor", async () => {
    const transport = new FakeTransport();
    recordShell(makeBackend(transport), { afterSequence: 42 });
    await settle();

    assert.deepEqual(transport.lastConnection().lastStream().payload, { afterSequence: 42 });
  });

  test("after a disconnect, resumes after the last sequence on a new socket", async () => {
    const transport = new FakeTransport();
    const { events } = recordShell(makeBackend(transport));
    await settle();
    transport
      .lastConnection()
      .lastStream()
      .push(shellSnapshot(10, []), {
        kind: "thread.updated",
        sequence: 11,
        location: "active",
        thread: wireThread("t1"),
      });

    transport.lastConnection().close();
    await settle();

    assert.equal(transport.connections.length, 2);
    assert.equal(transport.descriptorChecks, 2, "every new socket repeats the startup check");
    const resumed = transport.lastConnection().lastStream();
    assert.deepEqual(resumed.payload, { afterSequence: 11 });

    resumed.push({
      kind: "thread.updated",
      sequence: 12,
      location: "active",
      thread: wireThread("t1", { status: "running" }),
    });
    assert.deepEqual(
      events.map((event) => event.sequence),
      [10, 11, 12],
    );
  });

  test("falls back to a fresh snapshot when T3 refuses to resume from the cursor", async () => {
    const transport = new FakeTransport();
    const { events } = recordShell(makeBackend(transport), { afterSequence: 99 });
    await settle();
    const first = transport.lastConnection().lastStream();

    first.fail(new RpcError("cursor is ahead of the server"));
    await settle();

    const second = transport.lastConnection().lastStream();
    assert.notEqual(first, second);
    assert.deepEqual(second.payload, {});
    second.push(shellSnapshot(5, [wireProject("p1")]));
    assert.deepEqual(
      events.map((event) => [event.type, event.sequence]),
      [["snapshot", 5]],
    );
  });

  test("resumes from its cursor when T3 ends a working stream with an error", async () => {
    const transport = new FakeTransport();
    const { events, fatalErrors } = recordShell(makeBackend(transport));
    await settle();
    const first = transport.lastConnection().lastStream();
    first.push(shellSnapshot(10, []));

    first.fail(new RpcError("Failed while streaming the application shell"));
    await settle();

    const second = transport.lastConnection().lastStream();
    assert.notEqual(first, second);
    assert.deepEqual(second.payload, { afterSequence: 10 });
    assert.equal(fatalErrors.length, 0);
    assert.equal(events.length, 1);
  });

  test("stops for good when T3 refuses a plain subscription", async () => {
    const transport = new FakeTransport();
    const { fatalErrors } = recordShell(makeBackend(transport));
    await settle();

    transport.lastConnection().lastStream().fail(new RpcError("missing scope"));
    await settle();

    assert.equal(transport.lastConnection().streams.length, 1);
    assert.match(fatalErrors[0]?.message ?? "", /refused the shell subscription: missing scope/);
  });

  test("stops for good when T3 was upgraded to an untested version while disconnected", async () => {
    const transport = new FakeTransport();
    const { fatalErrors } = recordShell(makeBackend(transport));
    await settle();
    transport.lastConnection().lastStream().push(shellSnapshot(10, []));

    transport.descriptor = { ...transport.descriptor, serverVersion: "9.9.9" };
    transport.lastConnection().close();
    await settle();

    assert.equal(transport.connections.length, 1, "no socket is opened to the untested server");
    assert.equal(fatalErrors.length, 1);
    assert.ok(fatalErrors[0] instanceof T3IncompatibleError);
  });

  test("stops for good when T3 refuses the token after a disconnect", async () => {
    const transport = new FakeTransport();
    const { fatalErrors } = recordShell(makeBackend(transport));
    await settle();
    transport.lastConnection().lastStream().push(shellSnapshot(10, []));

    transport.openError = new T3HttpError("T3 answered 401 on /api/auth/websocket-ticket", 401);
    transport.lastConnection().close();
    await settle();

    assert.equal(transport.openAttempts, 2, "no retry once the token is refused");
    assert.equal(fatalErrors.length, 1);
    assert.match(fatalErrors[0]?.message ?? "", /run "t3-voice setup" again/);
  });

  test("keeps retrying while T3 is unreachable", async () => {
    const transport = new FakeTransport();
    const { fatalErrors } = recordShell(makeBackend(transport));
    await settle();
    transport.lastConnection().lastStream().push(shellSnapshot(10, []));

    transport.openError = new T3HttpError("Cannot reach T3 at http://127.0.0.1:3773");
    transport.lastConnection().close();
    await settle();
    assert.ok(transport.openAttempts > 2, `attempts: ${transport.openAttempts}`);

    transport.openError = null;
    await settle();
    assert.deepEqual(transport.lastConnection().lastStream().payload, { afterSequence: 10 });
    assert.equal(fatalErrors.length, 0);
  });

  test("close() stops the stream and reconnects no more", async () => {
    const transport = new FakeTransport();
    const backend = makeBackend(transport);
    const { subscription } = recordShell(backend);
    await settle();
    const stream = transport.lastConnection().lastStream();

    subscription.close();
    transport.lastConnection().close();
    await settle();

    assert.equal(stream.cancelled, true);
    assert.equal(transport.connections.length, 1);
  });
});
