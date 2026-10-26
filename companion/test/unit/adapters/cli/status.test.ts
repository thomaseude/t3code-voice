import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatStatus, runStatus } from "../../../../src/adapters/cli/status.ts";
import { ShellState } from "../../../../src/core/shellState.ts";
import { ConfigError } from "../../../../src/ports/configStore.ts";
import { T3IncompatibleError, type Thread } from "../../../../src/ports/t3Backend.ts";
import { project, thread } from "../../builders.ts";
import { FakeT3Connector, InMemoryConfigStore } from "../../fakePorts.ts";

const SERVER = { version: "0.1.0", protocolVersion: 2 };

function stateWith(projects = [project("p1")], threads: Thread[] = []): ShellState {
  const state = new ShellState();
  state.apply({ type: "snapshot", sequence: 1, projects, threads });
  return state;
}

describe("formatStatus", () => {
  test("prints the server, projects and running threads", () => {
    const state = stateWith(
      [project("p1", "joombo"), project("p2", "blog")],
      [
        thread("t1", { title: "Fix the Reviews tests", status: "running" }),
        thread("t2", {
          projectId: "p2",
          title: "Deploy",
          status: "running",
          pendingRequest: { id: "r1", kind: "command", blocking: true },
          providerInstanceId: "codex",
          model: "gpt-6",
        }),
      ],
    );

    const lines = formatStatus({
      baseUrl: "http://127.0.0.1:3773",
      server: SERVER,
      tokenExpiresAt: "2026-11-25T14:00:00.000Z",
      state,
      now: new Date("2026-10-26T14:00:00.000Z"),
    });

    assert.deepEqual(lines, [
      "T3 0.1.0, protocol 2 at http://127.0.0.1:3773: connected.",
      "T3 session expires on 2026-11-25 (in 30 days).",
      "",
      "Projects (2):",
      "  - blog  /home/me/blog",
      "  - joombo  /home/me/joombo",
      "",
      "Running threads (2):",
      "  - Fix the Reviews tests  [joombo]  running  (claudeAgent / claude-opus-5-5)",
      "  - Deploy  [blog]  waiting for approval (command)  (codex / gpt-6)",
    ]);
  });

  test("says when nothing runs and when the session expired", () => {
    const lines = formatStatus({
      baseUrl: "http://127.0.0.1:3773",
      server: SERVER,
      tokenExpiresAt: "2026-10-01T00:00:00.000Z",
      state: stateWith([]),
      now: new Date("2026-10-26T14:00:00.000Z"),
    });

    assert.ok(lines.includes('T3 session expires on 2026-10-01 (expired; run "t3-voice setup").'));
    assert.deepEqual(lines.slice(-5), [
      "Projects (0):",
      "  (none)",
      "",
      "Running threads (0):",
      "  (none)",
    ]);
  });
});

describe("session expiry", () => {
  const expiryLine = (expiresAt: string) =>
    formatStatus({
      baseUrl: "http://127.0.0.1:3773",
      server: SERVER,
      tokenExpiresAt: expiresAt,
      state: stateWith([]),
      now: new Date("2026-10-26T14:00:00.000Z"),
    })[1];

  test("warns when less than a day is left", () => {
    assert.equal(
      expiryLine("2026-10-26T19:00:00.000Z"),
      'T3 session expires on 2026-10-26 (in less than a day; run "t3-voice setup" soon).',
    );
  });

  test("says when T3 gave no expiry", () => {
    assert.equal(expiryLine(""), "T3 session expires at an unknown date.");
  });
});

describe("runStatus", () => {
  test("asks to run setup first", async () => {
    await assert.rejects(
      runStatus({ store: new InMemoryConfigStore(), t3: new FakeT3Connector(), out: () => {} }),
      ConfigError,
    );
  });

  test("connects with the saved session and prints the shell", async () => {
    const store = new InMemoryConfigStore();
    store.config = { t3: { baseUrl: "http://127.0.0.1:3773" } };
    store.session = {
      token: "secret-session-token",
      scopes: [],
      expiresAt: "2026-11-25T14:00:00.000Z",
    };
    const t3 = new FakeT3Connector();
    t3.backend.projects = [project("p1", "joombo")];
    t3.backend.threads = [thread("t1", { title: "Fix tests", status: "running" })];
    const lines: string[] = [];

    await runStatus({
      store,
      t3,
      out: (line) => lines.push(line),
      now: new Date("2026-10-26T14:00:00Z"),
    });

    assert.ok(lines.includes("  - joombo  /home/me/joombo"));
    assert.ok(lines.some((line) => line.startsWith("  - Fix tests  [joombo]  running")));
    assert.ok(t3.calls.includes("connect http://127.0.0.1:3773 with token"));
    assert.ok(t3.backend.closed);
    assert.ok(!lines.join("\n").includes("secret-session-token"));
  });

  test("fails closed on an untested T3 version", async () => {
    const store = new InMemoryConfigStore();
    store.config = { t3: { baseUrl: "http://127.0.0.1:3773" } };
    store.session = {
      token: "secret-session-token",
      scopes: [],
      expiresAt: "2026-11-25T14:00:00.000Z",
    };
    const t3 = new FakeT3Connector();
    t3.serverVersion = "0.2.0";

    await assert.rejects(runStatus({ store, t3, out: () => {} }), T3IncompatibleError);
  });
});
