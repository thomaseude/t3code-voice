// Seam 3: the WebSocket adapter against a real `t3 serve` at the pinned version.
// Detects protocol drift when T3 is upgraded. Skipped when no T3 binary is installed.
//
//   npm run test:integration            (uses ~/.t3/runtime/versions/<pinned>/t3)
//   T3_BIN=/path/to/t3 npm run test:integration

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runSetup } from "../../src/commands/setup.ts";
import { runStatus } from "../../src/commands/status.ts";
import { loadT3Session } from "../../src/config.ts";
import type { ShellEvent } from "../../src/t3/backend.ts";
import { DEFAULT_T3_PIN, T3IncompatibleError } from "../../src/t3/compatibility.ts";
import { issueWebSocketTicket } from "../../src/t3/http.ts";
import { openRpcConnection } from "../../src/t3/rpcConnection.ts";
import { ShellState } from "../../src/t3/shellState.ts";
import { makeHttpTransport, WebSocketT3Backend } from "../../src/t3/webSocketBackend.ts";
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

  test("setup exchanges a pairing link and stores a scoped session privately", async () => {
    const link = await server.createPairingLink();
    const lines: string[] = [];

    await runSetup({
      dir: configDir,
      t3Url: server.baseUrl,
      readPairingLink: async () => link,
      out: (line) => lines.push(line),
    });

    const session = await loadT3Session(configDir);
    assert.ok(session);
    token = session.token;
    assert.deepEqual(session.scopes.sort(), ["orchestration:operate", "orchestration:read"]);
    assert.equal((await stat(join(configDir, "t3-session.json"))).mode & 0o777, 0o600);
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
        dir: target,
        t3Url: server.baseUrl,
        readPairingLink: async () => link,
        out: () => {},
      });

    await setup(dir);
    await assert.rejects(setup(`${dir}-again`), /401|400|auth_invalid|invalid/);
  });

  test("fails closed when the server is not the pinned version", async () => {
    const pin = { ...DEFAULT_T3_PIN, serverVersions: ["0.0.0-untested"] };

    await assert.rejects(connect(pin), T3IncompatibleError);
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
    const subscription = backend.subscribeShell({
      onEvent: (event) => {
        events.push(event);
        state.apply(event);
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
      const threadId = await launchThread(alpha.id, "Integration probe");
      await waitFor(() => state.threads.has(threadId), "thread.updated for the new thread");
      await waitFor(() => state.threads.get(threadId)?.status === "failed", "the run to fail");
      const seen = events
        .filter((event) => event.type === "thread.updated" && event.thread.id === threadId)
        .map((event) => (event.type === "thread.updated" ? event.thread.status : ""));
      assert.ok(
        seen.some((status) => ["preparing", "starting", "running"].includes(status)),
        `statuses seen: ${seen.join(", ")}`,
      );
      const thread = state.threads.get(threadId);
      assert.equal(thread?.projectId, alpha.id);
      assert.equal(thread?.providerInstanceId, "claudeAgent");
      assert.ok(thread?.lastError?.message, "a failed thread carries T3's error");

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

  test("t3-voice status lists the projects from a live T3", async () => {
    const lines: string[] = [];

    await runStatus({ dir: configDir, out: (line) => lines.push(line) });

    assert.match(lines[0] ?? "", /^T3 \S+, protocol 2 at http:\/\/127\.0\.0\.1:\d+: connected\.$/);
    assert.ok(lines.includes("Projects (2):"), lines.join("\n"));
    assert.ok(lines.some((line) => line.startsWith("  - alpha  ")));
    assert.ok(lines.includes("Running threads (0):"), lines.join("\n"));
  });

  /** Starts a thread through the raw protocol; launching is not part of the port yet. */
  async function launchThread(projectId: string, title: string): Promise<string> {
    const ticket = await issueWebSocketTicket(server.baseUrl, token);
    const url = `${server.baseUrl.replace("http", "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`;
    const connection = await openRpcConnection(url);
    try {
      const result = (await connection.request("orchestration.launchThread", {
        commandId: `t3voice-it-${Date.now()}`,
        projectId,
        title,
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: "Say hello.", attachments: [] },
      })) as { threadId: string };
      return result.threadId;
    } finally {
      connection.close();
    }
  }
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
