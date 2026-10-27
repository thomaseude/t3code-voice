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
      {
        id: "p1",
        title: "joombo",
        workspaceRoot: "/home/me/joombo",
        newThreadWorkspace: null,
        defaultModel: null,
      },
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

describe("inspectRepository", () => {
  async function inspect(answer: unknown) {
    const transport = new FakeTransport();
    const backend = makeBackend(transport);
    await backend.connection();
    transport.lastConnection().responses.set("vcs.listRefs", answer);
    const info = await backend.inspectRepository("/home/me/joombo");
    return { info, requests: transport.lastConnection().requests };
  }
  const ref = (name: string, fields: Record<string, unknown> = {}) => ({
    name,
    current: false,
    isDefault: false,
    worktreePath: null,
    ...fields,
  });

  test("asks T3 for the folder's refs, and returns the branch origin/HEAD names", async () => {
    const { info, requests } = await inspect({
      isRepo: true,
      hasPrimaryRemote: true,
      refs: [
        ref("feat/onboarding", { current: true }),
        ref("master", { isDefault: true }),
        ref("origin/master", { isRemote: true, remoteName: "origin", isDefault: true }),
      ],
      nextCursor: null,
      totalCount: 3,
    });

    assert.deepEqual(requests, [{ tag: "vcs.listRefs", payload: { cwd: "/home/me/joombo" } }]);
    assert.deepEqual(info, { isGitRepository: true, defaultBranch: "master" });
  });

  test("a default branch known only on the remote gives its local name", async () => {
    const { info } = await inspect({
      isRepo: true,
      refs: [ref("origin/main", { isRemote: true, remoteName: "origin", isDefault: true })],
    });

    assert.deepEqual(info, { isGitRepository: true, defaultBranch: "main" });
  });

  test("without origin/HEAD: main or master, else the current branch", async () => {
    assert.deepEqual(
      (await inspect({ isRepo: true, refs: [ref("dev", { current: true }), ref("main")] })).info,
      { isGitRepository: true, defaultBranch: "main" },
    );
    assert.deepEqual(
      (await inspect({ isRepo: true, refs: [ref("dev", { current: true })] })).info,
      { isGitRepository: true, defaultBranch: "dev" },
    );
    assert.deepEqual((await inspect({ isRepo: true, refs: [] })).info, {
      isGitRepository: true,
      defaultBranch: null,
    });
  });

  test("a folder that is not a repository", async () => {
    const { info } = await inspect({ isRepo: false, hasPrimaryRemote: false, refs: [] });

    assert.deepEqual(info, { isGitRepository: false, defaultBranch: null });
  });
});

describe("commands", () => {
  async function connected() {
    const transport = new FakeTransport();
    const backend = makeBackend(transport);
    await backend.connection();
    const connection = transport.lastConnection();
    connection.responses.set("orchestration.dispatchCommand", { sequence: 5 });
    return { transport, backend, connection };
  }

  test("launchThread sends the request as T3's launch, from a mobile client", async () => {
    const { backend, connection } = await connected();
    connection.responses.set("orchestration.launchThread", {
      threadId: "t42",
      projection: {},
      resumed: false,
    });

    const result = await backend.launchThread({
      commandId: "cmd-1",
      projectId: "p1",
      title: "Corriger les tests",
      model: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "auto-accept-edits",
      prompt: "Corriger les tests des Reviews",
      workspace: { type: "new_worktree", baseBranch: "master" },
    });

    assert.deepEqual(result, { threadId: "t42" });
    assert.deepEqual(connection.requests, [
      {
        tag: "orchestration.launchThread",
        payload: {
          commandId: "cmd-1",
          creationSource: "mobile",
          projectId: "p1",
          title: "Corriger les tests",
          generateTitle: true,
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          workspaceStrategy: { type: "worktree", baseRef: "master", startFromOrigin: true },
          initialMessage: { text: "Corriger les tests des Reviews", attachments: [] },
        },
      },
    ]);
  });

  test("the project folder is T3's root workspace", async () => {
    const { backend, connection } = await connected();
    connection.responses.set("orchestration.launchThread", { threadId: "t42" });

    await backend.launchThread({
      commandId: "cmd-1",
      projectId: "p1",
      title: "x",
      model: { providerInstanceId: "codex", model: "gpt-5.6-codex" },
      runtimeMode: "full-access",
      prompt: "x",
      workspace: { type: "project_folder" },
    });

    const payload = connection.requests[0]?.payload as { workspaceStrategy: unknown };
    assert.deepEqual(payload.workspaceStrategy, { type: "root" });
  });

  test("when the socket drops before T3 answers, the launch is sent again with the same id", async () => {
    const { transport, backend, connection } = await connected();
    connection.dropOnNextRequest = true;
    transport.prepare = (next) =>
      next.responses.set("orchestration.launchThread", { threadId: "t42" });

    const launch = backend.launchThread({
      commandId: "cmd-1",
      projectId: "p1",
      title: "x",
      model: { providerInstanceId: "codex", model: "gpt-5.6-codex" },
      runtimeMode: "full-access",
      prompt: "x",
      workspace: { type: "project_folder" },
    });

    assert.deepEqual(await launch, { threadId: "t42" });
    const sent = transport.connections.flatMap((each) => each.requests);
    assert.deepEqual(
      sent.map((request) => (request.payload as { commandId: string }).commandId),
      ["cmd-1", "cmd-1"],
    );
  });

  test("a T3 answer without a thread id is an error", async () => {
    const { backend, connection } = await connected();
    connection.responses.set("orchestration.launchThread", {});

    await assert.rejects(
      backend.launchThread({
        commandId: "cmd-1",
        projectId: "p1",
        title: "x",
        model: { providerInstanceId: "codex", model: "gpt-5.6-codex" },
        runtimeMode: "full-access",
        prompt: "x",
        workspace: { type: "project_folder" },
      }),
      /thread id/,
    );
  });

  test("sendMessage: queue lets T3 run it after the current turn, steer delivers it now", async () => {
    const { backend, connection } = await connected();
    const base = { threadId: "t1", text: "Ajoute un test" };

    await backend.sendMessage({ ...base, commandId: "c1", messageId: "m1", mode: "queue" });
    await backend.sendMessage({ ...base, commandId: "c2", messageId: "m2", mode: "steer" });

    const common = {
      type: "message.dispatch",
      threadId: "t1",
      text: "Ajoute un test",
      attachments: [],
      createdBy: "user",
      creationSource: "mobile",
    };
    assert.deepEqual(connection.requests, [
      {
        tag: "orchestration.dispatchCommand",
        payload: {
          ...common,
          commandId: "c1",
          messageId: "m1",
          dispatchMode: { type: "start_immediately" },
        },
      },
      {
        tag: "orchestration.dispatchCommand",
        payload: {
          ...common,
          commandId: "c2",
          messageId: "m2",
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "steer",
        },
      },
    ]);
  });

  test("cancelQueuedMessage finds the queued run of the message and cancels it", async () => {
    const { backend, connection } = await connected();
    connection.answer = (tag) =>
      tag === "orchestration.getThreadProjection"
        ? {
            runs: [
              { id: "run-1", userMessageId: "m0", status: "running" },
              { id: "run-2", userMessageId: "m1", status: "queued" },
            ],
          }
        : { sequence: 6 };

    assert.equal(await backend.cancelQueuedMessage("c9", "t1", "m1"), true);
    assert.deepEqual(connection.requests, [
      { tag: "orchestration.getThreadProjection", payload: { threadId: "t1" } },
      {
        tag: "orchestration.dispatchCommand",
        payload: { type: "queued-run.cancel", commandId: "c9", threadId: "t1", runId: "run-2" },
      },
    ]);
  });

  test("cancelQueuedMessage answers true when an earlier try already took the message back", async () => {
    const { backend, connection } = await connected();
    connection.answer = () => ({
      runs: [{ id: "run-2", userMessageId: "m1", status: "cancelled" }],
    });

    assert.equal(await backend.cancelQueuedMessage("c9", "t1", "m1"), true);
    assert.equal(connection.requests.length, 1);
  });

  test("cancelQueuedMessage answers false once the message no longer waits", async () => {
    const { backend, connection } = await connected();
    connection.answer = () => ({
      runs: [{ id: "run-2", userMessageId: "m1", status: "running" }],
    });

    assert.equal(await backend.cancelQueuedMessage("c9", "t1", "m1"), false);
    assert.equal(connection.requests.length, 1);
  });

  test("stopThread interrupts the run the agent works on", async () => {
    const { backend, connection } = await connected();
    connection.answer = (tag) =>
      tag === "orchestration.getThreadProjection"
        ? {
            runs: [
              { id: "run-1", status: "completed" },
              { id: "run-2", status: "preparing" },
            ],
          }
        : { sequence: 6 };

    await backend.stopThread("c1", "t1");

    assert.deepEqual(connection.requests, [
      { tag: "orchestration.getThreadProjection", payload: { threadId: "t1" } },
      {
        tag: "orchestration.dispatchCommand",
        payload: { type: "run.interrupt", commandId: "c1", threadId: "t1", runId: "run-2" },
      },
    ]);
  });

  test("stopThread also cancels the runs still waiting in the queue", async () => {
    const { backend, connection } = await connected();
    connection.answer = (tag) =>
      tag === "orchestration.getThreadProjection"
        ? { runs: [{ id: "run-1", status: "queued" }] }
        : { sequence: 6 };

    await backend.stopThread("c1", "t1");

    assert.deepEqual(connection.requests.at(-1)?.payload, {
      type: "queued-run.cancel",
      commandId: "c1:run-1",
      threadId: "t1",
      runId: "run-1",
    });
  });

  test("when T3 does not answer a command in time, it is sent again with the same id", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { backend, connection } = await connected();
    connection.silent = true;

    const archive = backend.archiveThread("c2", "t1");
    await settle();
    connection.silent = false;
    t.mock.timers.tick(15_000);
    await archive;

    assert.deepEqual(
      connection.requests.map((request) => (request.payload as { commandId: string }).commandId),
      ["c2", "c2"],
    );
  });

  test("stopThread sends nothing when no run is active", async () => {
    const { backend, connection } = await connected();
    connection.answer = () => ({ runs: [{ id: "run-1", status: "failed" }] });

    await backend.stopThread("c1", "t1");

    assert.equal(connection.requests.length, 1);
  });

  test("readThread reads the thread's messages, oldest first, with their run", async () => {
    const { backend, connection } = await connected();
    connection.answer = () => ({
      runs: [],
      messages: [
        {
          id: "m2",
          runId: "run-1",
          role: "assistant",
          text: "J'ai corrigé les tests.",
          streaming: false,
          createdAt: "2026-10-26T10:05:00.000Z",
        },
        {
          id: "m1",
          runId: "run-1",
          role: "user",
          text: "Corrige les tests des Reviews",
          streaming: false,
          createdAt: "2026-10-26T10:00:00.000Z",
        },
        { id: "m3", role: "narrator", text: 42, createdAt: "2026-10-26T10:06:00.000Z" },
      ],
    });

    const messages = await backend.readThread("t1");

    assert.deepEqual(connection.requests, [
      { tag: "orchestration.getThreadProjection", payload: { threadId: "t1" } },
    ]);
    assert.deepEqual(messages, [
      {
        role: "user",
        text: "Corrige les tests des Reviews",
        runId: "run-1",
        createdAt: "2026-10-26T10:00:00.000Z",
      },
      {
        role: "assistant",
        text: "J'ai corrigé les tests.",
        runId: "run-1",
        createdAt: "2026-10-26T10:05:00.000Z",
      },
    ]);
  });

  test("archiveThread sends T3's command", async () => {
    const { backend, connection } = await connected();

    await backend.archiveThread("c2", "t1");

    assert.deepEqual(connection.requests, [
      {
        tag: "orchestration.dispatchCommand",
        payload: { type: "thread.archive", commandId: "c2", threadId: "t1" },
      },
    ]);
  });
});
