// Seam 3: the WebSocket adapter against a real `t3 serve` at a pinned version.
// Shows when a new T3 version changes the protocol. Skipped when no T3 binary is installed.
//
//   npm run test:integration                   (~/.t3/runtime/versions/<newest pinned>/t3)
//   T3_VERSION=0.1.2 npm run test:integration  (~/.t3/runtime/versions/0.1.2/t3)
//   T3_BIN=/path/to/t3 npm run test:integration

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runSetup } from "../../src/adapters/cli/setup.ts";
import { formatStatus, runStatus } from "../../src/adapters/cli/status.ts";
import { FileConfigStore } from "../../src/adapters/config/fileConfigStore.ts";
import { DEFAULT_T3_PIN } from "../../src/adapters/t3-websocket/compatibility.ts";
import { WebSocketT3Connector } from "../../src/adapters/t3-websocket/connector.ts";
import {
  makeHttpTransport,
  WebSocketT3Backend,
} from "../../src/adapters/t3-websocket/webSocketBackend.ts";
import { awarenessOf, eventKeyOf } from "../../src/core/awareness.ts";
import { isRunning, ShellState } from "../../src/core/shellState.ts";
import { type ShellEvent, T3IncompatibleError, type Thread } from "../../src/ports/t3Backend.ts";
import { findT3Binary, T3TestServer } from "./t3Server.ts";

const binary = findT3Binary();

describe("T3Backend WebSocket adapter against a real T3", {
  skip: binary ? false : "no T3 binary found (set T3_BIN)",
}, () => {
  let server: T3TestServer;
  let configDir: string;
  let token: string;

  before(async () => {
    server = await T3TestServer.start(binary as string);
    configDir = join(await mkdtemp(join(tmpdir(), "t3voice-it-config-")), "t3voice");
  });

  after(async () => {
    await server?.stop();
  });

  function connect(pin = DEFAULT_T3_PIN) {
    return WebSocketT3Backend.connect({
      transport: makeHttpTransport(server.baseUrl, token),
      pin,
      reconnectDelaysMs: [250, 500, 1000],
    });
  }

  test("setup exchanges a pairing link and stores a scoped token privately", async () => {
    const link = await server.createPairingLink();
    const lines: string[] = [];

    await runSetup({
      store: new FileConfigStore(configDir),
      t3: new WebSocketT3Connector(),
      t3Url: server.baseUrl,
      readPairingLink: async () => link,
      out: (line) => lines.push(line),
    });

    const pairing = await new FileConfigStore(configDir).loadT3Pairing();
    assert.ok(pairing);
    token = pairing.token;
    assert.equal(pairing.baseUrl, server.baseUrl);
    assert.deepEqual(pairing.scopes.sort(), ["orchestration:operate", "orchestration:read"]);
    assert.equal((await stat(join(configDir, "t3-pairing.json"))).mode & 0o777, 0o600);
    assert.ok(lines.some((line) => line.startsWith("Connected: 0 project(s)")));

    const output = lines.join("\n");
    const credential = new URL(link).hash.replace("#token=", "");
    assert.ok(!output.includes(token), "the token is never printed");
    assert.ok(!output.includes(credential), "the pairing credential is never printed");
    assert.ok(!(await readFile(join(configDir, "config.json"), "utf8")).includes(token));
  });

  test("a pairing link is single use", async () => {
    const link = await server.createPairingLink();
    const dir = join(await mkdtemp(join(tmpdir(), "t3voice-it-config-")), "t3voice");
    const setup = (target: string) =>
      runSetup({
        store: new FileConfigStore(target),
        t3: new WebSocketT3Connector(),
        t3Url: server.baseUrl,
        readPairingLink: async () => link,
        out: () => {},
      });

    await setup(dir);
    await assert.rejects(setup(`${dir}-again`), /401|400|auth_invalid|invalid/);
  });

  test("fails closed when the server is not the pinned version", async () => {
    const pin = { ...DEFAULT_T3_PIN, serverVersions: ["0.0.0-untested"] };
    const connector = new WebSocketT3Connector();

    await assert.rejects(connect(pin), T3IncompatibleError);
    await assert.rejects(
      connector.checkServer(server.baseUrl, ["0.0.0-untested"]),
      T3IncompatibleError,
    );
    await assert.rejects(
      connector.connect({ baseUrl: server.baseUrl, token, scopes: [], expiresAt: null }, [
        "0.0.0-untested",
      ]),
      T3IncompatibleError,
    );
  });

  test("getConfig returns T3's providers and default runtime mode", async () => {
    const backend = await connect();
    try {
      const config = await backend.getConfig();
      const drivers = config.providers.map((provider) => provider.driver);
      assert.ok(drivers.includes("claudeAgent"), `drivers: ${drivers.join(", ")}`);
      assert.ok(drivers.includes("codex"), `drivers: ${drivers.join(", ")}`);
      assert.ok(
        ["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
          config.defaultRuntimeMode,
        ),
      );
    } finally {
      backend.close();
    }
  });

  test("subscribeShell follows projects and a thread's run, and resumes after a T3 restart", async () => {
    const backend = await connect();
    const events: ShellEvent[] = [];
    const connectionStates: string[] = [];
    const state = new ShellState();
    // What `t3-voice status` would print while a thread runs: the run is too short to poll for.
    let statusWhileRunning: string[] = [];
    const subscription = backend.subscribeShell({
      onEvent: (event) => {
        events.push(event);
        state.apply(event);
        if (statusWhileRunning.length === 0 && state.runningThreads().length > 0) {
          statusWhileRunning = formatStatus({
            baseUrl: server.baseUrl,
            server: backend.serverInfo(),
            tokenExpiresAt: null,
            state,
            now: new Date(),
          });
        }
      },
      onConnectionChange: (change) => connectionStates.push(change),
      onFatalError: (error) => assert.fail(error),
    });

    try {
      await waitFor(() => state.hasSnapshot, "first snapshot");

      await server.addProject("alpha");
      await waitFor(() => findProject(state, "alpha"), "project.updated for alpha");
      const alpha = findProject(state, "alpha");
      assert.ok(alpha);
      assert.deepEqual(await backend.listProjects(), [...state.projects.values()]);

      // HOME has no Claude login, so the run starts, then fails quickly and for free.
      const { threadId } = await backend.launchThread({
        commandId: `t3voice-it-${Date.now()}`,
        projectId: alpha.id,
        title: "Integration probe",
        model: { providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" },
        runtimeMode: "full-access",
        prompt: "Say hello.",
        workspace: { type: "project_folder" },
      });
      await waitFor(() => state.threads.has(threadId), "thread.updated for the new thread");
      await waitFor(() => state.threads.get(threadId)?.status === "failed", "the run to fail");
      const seen = events
        .filter((event) => event.type === "thread.updated" && event.thread.id === threadId)
        .map((event) => (event.type === "thread.updated" ? event.thread.status : ""));
      assert.ok(
        seen.some((status) => ["preparing", "starting", "running"].includes(status)),
        `statuses seen: ${seen.join(", ")}`,
      );
      assert.ok(statusWhileRunning.includes("Running threads (1):"), statusWhileRunning.join("\n"));
      assert.ok(
        statusWhileRunning.some((line) => line.startsWith("  - Integration probe  [alpha]  ")),
        statusWhileRunning.join("\n"),
      );
      const thread = state.threads.get(threadId);
      assert.equal(thread?.projectId, alpha.id);
      assert.equal(thread?.providerInstanceId, "claudeAgent");
      assert.ok(thread?.lastError?.message, "a failed thread carries T3's error");
      // What announcements rely on: the run's id, T3's awareness, and the thread's messages.
      assert.equal(typeof thread?.latestRunId, "string");
      assert.deepEqual(thread?.backgroundTaskKinds, []);
      assert.equal(thread?.settled, false);
      assert.equal(awarenessOf(thread as Thread), "failed");
      assert.equal(eventKeyOf(thread as Thread), `failed:${thread?.latestRunId}`);
      const messages = await backend.readThread(threadId);
      const request = messages.find((message) => message.role === "user");
      assert.equal(request?.text, "Say hello.");
      assert.equal(request?.runId, thread?.latestRunId);

      const sequences = events
        .filter((event) => event.type !== "snapshot")
        .map((event) => event.sequence);
      assert.deepEqual(
        sequences,
        [...sequences].sort((a, b) => a - b),
        "deltas arrive in order, once",
      );
      assert.equal(new Set(sequences).size, sequences.length);

      await server.restart();
      await waitFor(() => connectionStates.includes("reconnecting"), "the adapter to notice");
      await waitFor(
        () => connectionStates.at(-1) === "connected",
        "the adapter to reconnect",
        60_000,
      );

      await server.addProject("beta");
      await waitFor(() => findProject(state, "beta"), "project.updated for beta after the restart");
      assert.ok(findProject(state, "alpha"), "state from before the restart is kept");
      assert.equal(
        events.filter((event) => event.type === "snapshot").length,
        1,
        "the stream resumed from its cursor instead of starting over",
      );
      assert.equal(state.threads.get(threadId)?.status, "failed");
    } finally {
      subscription.close();
      backend.close();
    }
  });

  test("inspectRepository tells a git repository and its main branch from a plain folder", async () => {
    const backend = await connect();
    try {
      const repository = await server.addGitProject("repo");
      const folder = await server.addProject("folder");

      assert.deepEqual(await backend.inspectRepository(repository), {
        isGitRepository: true,
        defaultBranch: "main",
      });
      assert.deepEqual(await backend.inspectRepository(folder), {
        isGitRepository: false,
        defaultBranch: null,
      });
    } finally {
      backend.close();
    }
  });

  test("a voice task: launched once in a new worktree, sent a message, then archived", async () => {
    const backend = await connect();
    const state = new ShellState();
    const subscription = backend.subscribeShell({
      onEvent: (event) => state.apply(event),
      onFatalError: (error) => assert.fail(error),
    });
    try {
      await waitFor(() => state.hasSnapshot, "first snapshot");
      await server.addGitProject("gamma");
      await waitFor(() => findProject(state, "gamma"), "project.updated for gamma");
      const gamma = findProject(state, "gamma");
      assert.ok(gamma);
      const request = {
        commandId: `t3voice-it-worktree-${Date.now()}`,
        projectId: gamma.id,
        title: "Worktree probe",
        model: { providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" },
        runtimeMode: "full-access",
        prompt: "Say hello.",
        workspace: { type: "new_worktree" as const, baseBranch: "main" },
      };

      const { threadId } = await backend.launchThread(request);
      const again = await backend.launchThread(request);

      assert.equal(again.threadId, threadId, "the same command id starts one thread");
      await waitFor(() => state.threads.get(threadId)?.worktreePath, "the new worktree");
      const thread = state.threads.get(threadId);
      assert.notEqual(thread?.worktreePath, gamma.workspaceRoot);

      await waitFor(() => !isRunning(state.threads.get(threadId) as Thread), "the run to end");
      const messageId = `t3voice-it-message-${Date.now()}`;
      await backend.sendMessage({
        commandId: `${messageId}-send`,
        threadId,
        messageId,
        text: "Say goodbye.",
        mode: "queue",
      });
      assert.equal(
        typeof (await backend.cancelQueuedMessage(`${messageId}-cancel`, threadId, messageId)),
        "boolean",
      );
      await backend.archiveThread(`${messageId}-archive`, threadId);

      // An archived thread leaves the active list of the shell stream.
      await waitFor(
        () => !state.threads.has(threadId) || state.threads.get(threadId)?.archived,
        "the thread to be archived",
      );
    } finally {
      subscription.close();
      backend.close();
    }
  });

  test("stopThread interrupts a run that is still starting", async () => {
    const backend = await connect();
    const state = new ShellState();
    const subscription = backend.subscribeShell({
      onEvent: (event) => state.apply(event),
      onFatalError: (error) => assert.fail(error),
    });
    try {
      await waitFor(() => state.hasSnapshot, "first snapshot");
      const gamma = findProject(state, "gamma");
      assert.ok(gamma);

      const { threadId } = await backend.launchThread({
        commandId: `t3voice-it-stop-${Date.now()}`,
        projectId: gamma.id,
        title: "Stop probe",
        model: { providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" },
        runtimeMode: "full-access",
        prompt: "Say hello.",
        workspace: { type: "new_worktree", baseBranch: "main" },
      });
      await backend.stopThread(`t3voice-it-stop-${Date.now()}`, threadId);

      await waitFor(
        () => ["interrupted", "cancelled"].includes(state.threads.get(threadId)?.status ?? ""),
        "the run to be interrupted",
      );
    } finally {
      subscription.close();
      backend.close();
    }
  });

  test("t3-voice status lists the projects from a live T3", async () => {
    const lines: string[] = [];

    await runStatus({
      store: new FileConfigStore(configDir),
      t3: new WebSocketT3Connector(),
      out: (line) => lines.push(line),
    });

    assert.match(lines[0] ?? "", /^T3 \S+, protocol 2 at http:\/\/127\.0\.0\.1:\d+: connected\.$/);
    assert.ok(lines.includes("Projects (5):"), lines.join("\n"));
    assert.ok(lines.some((line) => line.startsWith("  - alpha  ")));
    assert.ok(lines.includes("Running threads (0):"), lines.join("\n"));
  });
});

function findProject(state: ShellState, title: string) {
  return [...state.projects.values()].find((project) => project.title === title);
}

async function waitFor(check: () => unknown, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
