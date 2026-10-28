// Seam 1: starting and steering T3 tasks by voice. The voice model's tool calls go through
// the core, with a fake T3, a fake task registry, a fake voice engine and a fake clock.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANSWER_QUIET_MS, TRANSCRIPT_WAIT_MS } from "../../../src/core/confirmations.ts";
import { ShellState } from "../../../src/core/shellState.ts";
import { VoiceSessionManager } from "../../../src/core/voiceSessions.ts";
import { VoiceTasks } from "../../../src/core/voiceTasks.ts";
import { DEFAULT_SESSION_LIMITS } from "../../../src/ports/configStore.ts";
import type { Project, Thread } from "../../../src/ports/t3Backend.ts";
import { followedTask, project, provider, thread } from "../builders.ts";
import {
  FakeClock,
  FakeT3Backend,
  FakeVoiceEngine,
  InMemoryTaskRegistry,
  settle,
  unusedAnnouncements,
  unusedSummaries,
} from "../fakePorts.ts";

const CLAUDE = provider("claudeAgent", {
  driver: "claudeAgent",
  displayName: "Claude",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  ],
});
const CODEX = provider("codex", {
  driver: "codex",
  displayName: "Codex",
  models: [{ slug: "gpt-5.6-codex", name: "GPT-5.6 Codex" }],
});

async function setup({
  projects = [project("p1", "joombo")] as Project[],
  threads = [] as Thread[],
} = {}) {
  const backend = new FakeT3Backend();
  backend.config = {
    providers: [CLAUDE, CODEX],
    defaultRuntimeMode: "auto-accept-edits",
    defaultModel: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" },
  };
  const shell = new ShellState();
  shell.apply({ type: "snapshot", sequence: 1, projects, threads });
  let connected = true;
  const registry = new InMemoryTaskRegistry();
  const engine = new FakeVoiceEngine();
  const clock = new FakeClock();
  const logs: string[] = [];
  let ids = 0;
  const tasks = new VoiceTasks({
    backend,
    registry,
    shell: () => (connected ? shell : null),
    summaries: unusedSummaries(clock, registry),
    clock,
    newId: () => `id-${++ids}`,
    log: (line) => logs.push(line),
  });
  const sessions = new VoiceSessionManager({
    engine,
    shell: () => (connected ? shell : null),
    tasks,
    announcements: unusedAnnouncements(),
    isRevoked: async () => false,
    registry: registry,
    limits: DEFAULT_SESSION_LIMITS,
    clock,
    log: (line) => logs.push(line),
  });
  await sessions.open("d1", { sdpOffer: "v=0", timeZone: null });
  let calls = 0;
  /**
   * Calls a tool as the voice model would, and returns what the core answered. A question
   * is read to the user, as the voice model does.
   */
  async function call(name: string, args: unknown = {}) {
    const callId = `c${++calls}`;
    engine.last.emit({ type: "tool_call", callId, name, arguments: args });
    await settle();
    const result = engine.last.toolResults.find((each) => each.callId === callId)?.result;
    if ((result as { needs_confirmation?: boolean } | undefined)?.needs_confirmation) {
      engine.last.emit({ type: "speech", speaker: "assistant" });
    }
    return result;
  }
  /** The user says `text`, as the engine's transcript of it. */
  async function say(text: string) {
    engine.last.emit({ type: "speech", speaker: "user", text });
    await settle();
  }
  /**
   * Calls the tool again with the confirmation the core gave, as the voice model does after
   * the user's answer, and waits as long as the core waits for the end of the answer.
   */
  async function confirm(name: string, question: unknown, args: unknown = {}) {
    const callId = `c${++calls}`;
    const { confirmation } = question as { confirmation: string };
    engine.last.emit({
      type: "tool_call",
      callId,
      name,
      arguments: { ...(args as object), confirmation },
    });
    await settle();
    clock.advance(TRANSCRIPT_WAIT_MS);
    await settle();
    clock.advance(ANSWER_QUIET_MS);
    await settle();
    return engine.last.toolResults.find((result) => result.callId === callId)?.result;
  }
  return {
    backend,
    shell,
    registry,
    engine,
    clock,
    logs,
    call,
    say,
    confirm,
    sessions,
    disconnectT3: () => {
      connected = false;
    },
  };
}

/** A question's answer without its token, which is random. */
function withoutToken(question: unknown) {
  const { confirmation, ...rest } = question as { confirmation: unknown };
  assert.equal(typeof confirmation, "string");
  return rest;
}

const startArgs = {
  agent: "Claude",
  project: "joombo",
  prompt: "Corriger les tests des Reviews",
  spoken_name: "tests Reviews",
};

describe("start_task", () => {
  test("starts the thread at once and reads back agent, model, project, request and name", async () => {
    const { backend, call } = await setup();

    const result = await call("start_task", startArgs);

    assert.deepEqual(backend.commands, [
      {
        type: "launch",
        commandId: "id-1",
        projectId: "p1",
        title: "Corriger les tests des Reviews",
        model: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" },
        runtimeMode: "auto-accept-edits",
        prompt: "Corriger les tests des Reviews",
        workspace: { type: "project_folder" },
      },
    ]);
    assert.deepEqual(result, {
      status: "started",
      task: "tests Reviews",
      agent: "Claude",
      model: "Claude Opus 5.5",
      project: "joombo",
      workspace: "project_folder",
      request: "Corriger les tests des Reviews",
    });
  });

  test("the started task is followed, under its spoken name", async () => {
    const { registry, call } = await setup();

    await call("start_task", startArgs);

    assert.deepEqual(registry.followedTasks(), [
      followedTask("launched-1", {
        projectId: "p1",
        spokenName: "tests Reviews",
        origin: "voice",
        followedAt: "2026-10-26T10:00:00.000Z",
      }),
    ]);
  });

  test("the agent and model can be named; T3's defaults fill what is not", async () => {
    const { backend, call } = await setup();

    await call("start_task", { ...startArgs, agent: "codex" });
    await call("start_task", { ...startArgs, model: "sonnet", spoken_name: "autre nom" });
    await call("start_task", {
      project: "joombo",
      prompt: "Mettre à jour le README",
      runtime_mode: "approval-required",
    });

    assert.deepEqual(
      backend.commands.map((command) => command.type === "launch" && command.model),
      [
        { providerInstanceId: "codex", model: "gpt-5.6-codex" },
        { providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" },
        { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" },
      ],
    );
    const last = backend.commands.at(-1);
    assert.equal(last?.type === "launch" && last.runtimeMode, "approval-required");
  });

  test("the project's own default model comes before T3's", async () => {
    const { backend, call } = await setup({
      projects: [
        project("p1", "joombo", {
          defaultModel: { providerInstanceId: "codex", model: "gpt-5.6-codex" },
        }),
      ],
    });

    await call("start_task", { project: "joombo", prompt: "Corriger le build" });

    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].model, {
      providerInstanceId: "codex",
      model: "gpt-5.6-codex",
    });
  });

  test("a model named alone picks its agent", async () => {
    const { backend, call } = await setup();

    await call("start_task", { project: "joombo", prompt: "Corriger le build", model: "codex" });

    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].model, {
      providerInstanceId: "codex",
      model: "gpt-5.6-codex",
    });
  });

  test("a model named alone that fits several models starts nothing and lists them", async () => {
    const { backend, call } = await setup();

    assert.deepEqual(
      await call("start_task", { ...startArgs, agent: undefined, model: "claude" }),
      {
        status: "ambiguous_model",
        choices: [
          { agent: "Claude", model: "Claude Opus 5.5" },
          { agent: "Claude", model: "Claude Sonnet 5.5" },
        ],
      },
    );
    assert.deepEqual(backend.commands, []);
  });

  test("a version tells two models apart: Opus 5.5 is not Opus 5", async () => {
    const { backend, call } = await setup();
    backend.config.providers = [
      provider("claudeAgent", {
        displayName: "Claude",
        models: [
          { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
          { slug: "claude-opus-5", name: "Claude Opus 5" },
        ],
      }),
    ];

    await call("start_task", { ...startArgs, agent: undefined, model: "Opus 5.5" });
    await call("start_task", { ...startArgs, model: "opus 5", spoken_name: "autre tâche" });

    assert.deepEqual(
      backend.commands.map((command) => command.type === "launch" && command.model.model),
      ["claude-opus-5-5", "claude-opus-5"],
    );
  });

  test("a model T3 names by its dated slug only is found by its version", async () => {
    const { backend, call } = await setup();
    backend.config.providers = [
      provider("claudeAgent", {
        displayName: "Claude",
        models: [
          { slug: "claude-sonnet-4-20250514", name: "claude-sonnet-4-20250514" },
          { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        ],
      }),
    ];

    await call("start_task", { ...startArgs, model: "Sonnet 4" });

    assert.equal(
      backend.commands[0]?.type === "launch" && backend.commands[0].model.model,
      "claude-sonnet-4-20250514",
    );
  });

  test("with the agent named, a model that fits several asks which one too", async () => {
    const { backend, call } = await setup();

    assert.deepEqual(await call("start_task", { ...startArgs, model: "claude" }), {
      status: "ambiguous_model",
      choices: [
        { agent: "Claude", model: "Claude Opus 5.5" },
        { agent: "Claude", model: "Claude Sonnet 5.5" },
      ],
    });
    assert.deepEqual(backend.commands, []);
  });

  test("project folders whose names differ only by punctuation can each be picked", async () => {
    const projects = [
      project("p1", "api", { workspaceRoot: "/home/me/api-5-5" }),
      project("p2", "api", { workspaceRoot: "/home/me/api-55" }),
    ];
    const { backend, call } = await setup({ projects });

    await call("start_task", { ...startArgs, project: "api", folder: "api-55" });

    assert.equal(backend.commands[0]?.type === "launch" && backend.commands[0].projectId, "p2");
  });

  test("an unknown agent or model starts nothing and lists the choices", async () => {
    const { backend, call } = await setup();

    assert.deepEqual(await call("start_task", { ...startArgs, agent: "Gemini" }), {
      error: "unknown_agent",
      agents: ["Claude", "Codex"],
    });
    assert.deepEqual(await call("start_task", { ...startArgs, model: "haiku" }), {
      error: "unknown_model",
      models: ["Claude Opus 5.5", "Claude Sonnet 5.5"],
    });
    assert.deepEqual(backend.commands, []);
  });

  test("an unknown project starts nothing and lists the projects", async () => {
    const { backend, call } = await setup();

    assert.deepEqual(await call("start_task", { ...startArgs, project: "locallab" }), {
      error: "unknown_project",
      projects: ["joombo"],
    });
    assert.deepEqual(backend.commands, []);
  });

  test("several projects with the title said: the assistant asks which, and nothing starts", async () => {
    const projects = [
      project("p1", "joombo", { workspaceRoot: "/home/me/projects/joombo" }),
      project("p2", "joombo", { workspaceRoot: "/home/me/projects/joombo-ux-dev" }),
      project("p3", "joombo", { workspaceRoot: "/home/me/projects/joombo-pta-dev" }),
    ];
    const { backend, call } = await setup({ projects });

    const result = await call("start_task", startArgs);

    assert.deepEqual(result, {
      status: "ambiguous_project",
      choices: ["joombo", "joombo-ux-dev", "joombo-pta-dev"],
    });
    assert.deepEqual(backend.commands, []);
  });

  test("the folder name the assistant offered picks one of those projects", async () => {
    const projects = [
      project("p1", "joombo", { workspaceRoot: "/home/me/projects/joombo" }),
      project("p2", "joombo", { workspaceRoot: "/home/me/projects/joombo-ux-dev" }),
    ];
    const { backend, call } = await setup({ projects });

    const result = await call("start_task", { ...startArgs, project: "joombo ux dev" });

    assert.equal((result as { project: string }).project, "joombo-ux-dev");
    assert.equal(backend.commands[0]?.type === "launch" && backend.commands[0].projectId, "p2");
  });

  test("the folder argument picks the project whose folder the title shares", async () => {
    const projects = [
      project("p1", "joombo", { workspaceRoot: "/home/me/projects/joombo" }),
      project("p2", "joombo", { workspaceRoot: "/home/me/projects/joombo-ux-dev" }),
    ];
    const { backend, call } = await setup({ projects });

    await call("start_task", { ...startArgs, folder: "joombo" });

    assert.equal(backend.commands[0]?.type === "launch" && backend.commands[0].projectId, "p1");
  });

  test("missing arguments start nothing", async () => {
    const { backend, call } = await setup();

    assert.deepEqual(await call("start_task", { project: "joombo" }), {
      error: "invalid_arguments",
    });
    assert.deepEqual(await call("start_task", null), { error: "invalid_arguments" });
    assert.deepEqual(backend.commands, []);
  });

  test("while T3 is away, nothing starts", async () => {
    const { backend, call, disconnectT3 } = await setup();
    disconnectT3();

    assert.deepEqual(await call("start_task", startArgs), { error: "t3_unavailable" });
    assert.deepEqual(backend.commands, []);
  });

  test("a launched thread nobody follows and that could not be stopped can still be cancelled", async () => {
    const { backend, registry, call } = await setup();
    registry.failNextFollow = true;
    backend.failNextCommand = "stop";

    assert.deepEqual(await call("start_task", startArgs), { error: "internal_error" });
    assert.equal(((await call("cancel_last_action")) as { status: string }).status, "cancelled");
    assert.deepEqual(
      backend.commands.map((command) => command.type),
      ["launch", "stop", "archive"],
    );
  });

  test("a launch T3 is slow to answer keeps the folder busy, however long it takes", async () => {
    const { backend, engine, clock, call } = await setup();
    let release = () => {};
    backend.launchGate = new Promise((resolve) => {
      release = resolve;
    });
    engine.last.emit({ type: "tool_call", callId: "a", name: "start_task", arguments: startArgs });
    await settle();
    clock.advance(60_000);

    engine.last.emit({
      type: "tool_call",
      callId: "b",
      name: "start_task",
      arguments: { ...startArgs, spoken_name: "autre tâche" },
    });
    await settle();
    release();
    await call("list_projects");

    assert.deepEqual(
      backend.commands
        .map((command) => (command.type === "launch" ? command.workspace.type : ""))
        .sort(),
      ["new_worktree", "project_folder"],
    );
  });

  test("a launched thread the registry cannot follow is stopped and archived", async () => {
    const { backend, registry, call } = await setup();
    registry.failNextFollow = true;

    assert.deepEqual(await call("start_task", startArgs), { error: "internal_error" });
    assert.deepEqual(
      backend.commands.map((command) => command.type),
      ["launch", "stop", "archive"],
    );
  });

  test("two starts at once in a free project: the second gets a new worktree", async () => {
    const { backend, engine, call } = await setup();
    let release = () => {};
    backend.launchGate = new Promise((resolve) => {
      release = resolve;
    });

    engine.last.emit({ type: "tool_call", callId: "a", name: "start_task", arguments: startArgs });
    engine.last.emit({
      type: "tool_call",
      callId: "b",
      name: "start_task",
      arguments: { ...startArgs, spoken_name: "autre tâche" },
    });
    await settle();
    release();
    await call("list_projects");

    assert.deepEqual(
      backend.commands
        .map((command) => (command.type === "launch" ? command.workspace.type : ""))
        .sort(),
      ["new_worktree", "project_folder"],
    );
  });

  test("when T3 refuses the launch, the assistant says it failed and nothing is followed", async () => {
    const { backend, registry, call } = await setup();
    backend.failNextCommand = true;

    assert.deepEqual(await call("start_task", startArgs), { error: "t3_failed" });
    assert.deepEqual(registry.followedTasks(), []);
  });
});

describe("start_task: where the agent works", () => {
  const busyRoot = thread("t1", { projectId: "p1", status: "running", worktreePath: null });

  test("a project set to worktree in T3 always gets a new worktree, from its default branch", async () => {
    const { backend, call } = await setup({
      projects: [project("p1", "joombo", { newThreadWorkspace: "new_worktree" })],
    });
    backend.repositories.set("/home/me/joombo", { isGitRepository: true, defaultBranch: "master" });

    const result = await call("start_task", startArgs);

    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].workspace, {
      type: "new_worktree",
      baseBranch: "master",
    });
    assert.equal((result as { workspace: string }).workspace, "new_worktree");
  });

  test("a local project whose folder an agent works in gets a new worktree", async () => {
    const { backend, call } = await setup({ threads: [busyRoot] });

    await call("start_task", startArgs);

    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].workspace, {
      type: "new_worktree",
      baseBranch: "main",
    });
  });

  test("agents in other worktrees, other projects or finished threads leave the folder free", async () => {
    const { backend, call } = await setup({
      threads: [
        thread("t1", { projectId: "p1", status: "running", worktreePath: "/wt/a" }),
        thread("t2", { projectId: "p2", status: "running", worktreePath: null }),
        thread("t3", { projectId: "p1", status: "completed", worktreePath: null }),
        thread("t4", { projectId: "p1", status: "running", worktreePath: null, archived: true }),
      ],
    });

    await call("start_task", startArgs);

    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].workspace, {
      type: "project_folder",
    });
  });

  test("the user can ask for a new worktree on a free project", async () => {
    const { backend, call } = await setup();

    await call("start_task", { ...startArgs, workspace: "new_worktree" });

    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].workspace, {
      type: "new_worktree",
      baseBranch: "main",
    });
  });

  test("a new worktree asked for in a repository with no branch: nothing starts", async () => {
    const { backend, call } = await setup();
    backend.repositories.set("/home/me/joombo", { isGitRepository: true, defaultBranch: null });

    assert.deepEqual(await call("start_task", { ...startArgs, workspace: "new_worktree" }), {
      error: "worktree_unavailable",
    });
    assert.deepEqual(backend.commands, []);
  });

  test("a busy project that is not a git repository: the assistant asks before sharing its folder", async () => {
    const { backend, call } = await setup({ threads: [busyRoot] });
    backend.repositories.set("/home/me/joombo", { isGitRepository: false, defaultBranch: null });

    const question = await call("start_task", startArgs);

    assert.deepEqual(withoutToken(question), {
      needs_confirmation: true,
      read_back: {
        action: "start_task",
        reason: "folder_busy_not_git",
        agent: "Claude",
        model: "Claude Opus 5.5",
        project: "joombo",
        workspace: "shared_folder",
        request: "Corriger les tests des Reviews",
      },
    });
    assert.deepEqual(backend.commands, []);
  });

  test("a worktree project that is not a git repository runs in its folder when it is free", async () => {
    const { backend, call } = await setup({
      projects: [project("p1", "notes", { newThreadWorkspace: "new_worktree" })],
    });
    backend.repositories.set("/home/me/notes", { isGitRepository: false, defaultBranch: null });

    await call("start_task", { ...startArgs, project: "notes" });

    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].workspace, {
      type: "project_folder",
    });
  });
});

describe("spoken names", () => {
  test("a name already followed gets the project's name", async () => {
    const { registry, call } = await setup();
    registry.follow(followedTask("old", { spokenName: "tests Reviews" }));

    const result = await call("start_task", startArgs);

    assert.equal((result as { task: string }).task, "tests Reviews joombo");
  });

  test("without a valid proposal, the name comes from the request", async () => {
    const { call } = await setup();

    const result = await call("start_task", { ...startArgs, spoken_name: "x" });

    assert.equal((result as { task: string }).task, "corriger tests Reviews");
  });
});

describe("send_message", () => {
  async function withFollowedTask(threadFields: Partial<Thread> = { status: "running" }) {
    const context = await setup({ threads: [thread("t1", { projectId: "p1", ...threadFields })] });
    context.registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));
    return context;
  }

  test("sends the message to the task's thread, after its current turn, and reads it back", async () => {
    const { backend, call } = await withFollowedTask();

    const result = await call("send_message", {
      task: "la tâche des tests reviews",
      message: "Ajoute un test pour le cas vide",
    });

    assert.deepEqual(backend.commands, [
      {
        type: "send",
        commandId: "id-1",
        threadId: "t1",
        messageId: "id-2",
        text: "Ajoute un test pour le cas vide",
        mode: "queue",
      },
    ]);
    assert.deepEqual(result, {
      status: "sent",
      task: "tests Reviews",
      mode: "queue",
      message: "Ajoute un test pour le cas vide",
    });
  });

  test("steer sends it into the current turn", async () => {
    const { backend, call } = await withFollowedTask();

    await call("send_message", { task: "tests reviews", message: "Stop", mode: "steer" });

    assert.equal(backend.commands[0]?.type === "send" && backend.commands[0].mode, "steer");
  });

  test("the project said with the name finds the task too", async () => {
    const { backend, call } = await withFollowedTask();

    await call("send_message", { task: "tests reviews de joombo", message: "Go" });

    assert.equal(backend.commands[0]?.type === "send" && backend.commands[0].threadId, "t1");
  });

  test("a reference that fits several tasks lists them, and sends nothing", async () => {
    const { backend, registry, call } = await withFollowedTask();
    registry.follow(followedTask("t2", { spokenName: "tests paiement" }));

    assert.deepEqual(await call("send_message", { task: "les tests", message: "Go" }), {
      status: "ambiguous_task",
      choices: ["tests Reviews", "tests paiement"],
    });
    assert.deepEqual(backend.commands, []);
  });

  test("a task nobody follows: nothing is sent, and the followed tasks are listed", async () => {
    const { backend, call } = await withFollowedTask();

    assert.deepEqual(await call("send_message", { task: "migration", message: "Go" }), {
      error: "unknown_task",
      followed: ["tests Reviews"],
    });
    assert.deepEqual(backend.commands, []);
  });
});

describe("follow_thread and unfollow_thread", () => {
  const appThread = thread("t9", {
    projectId: "p1",
    title: "Refonte de la page offre totem",
    status: "running",
  });

  test("any thread can be followed by its title, under a spoken name", async () => {
    const { registry, call } = await setup({ threads: [appThread] });

    const result = await call("follow_thread", {
      task: "page offre totem",
      spoken_name: "offre totem",
    });

    assert.deepEqual(result, {
      status: "followed",
      task: "offre totem",
      project: "joombo",
      state: "running",
    });
    assert.deepEqual(registry.followedTasks(), [
      followedTask("t9", { spokenName: "offre totem", origin: "followed" }),
    ]);
  });

  test("a thread already followed keeps its name", async () => {
    const { registry, call } = await setup({ threads: [appThread] });
    registry.follow(followedTask("t9", { spokenName: "offre totem" }));

    assert.deepEqual(await call("follow_thread", { task: "offre totem", spoken_name: "autre" }), {
      status: "already_followed",
      task: "offre totem",
    });
  });

  test("a title that fits several threads lists them, and follows none", async () => {
    const { registry, call } = await setup({
      threads: [appThread, thread("t8", { projectId: "p1", title: "Page offre pro" })],
    });

    assert.deepEqual(await call("follow_thread", { task: "page offre" }), {
      status: "ambiguous_task",
      choices: ["Refonte de la page offre totem", "Page offre pro"],
    });
    assert.deepEqual(registry.followedTasks(), []);
  });

  test("unfollow_thread stops following the task", async () => {
    const { registry, call } = await setup();
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));

    assert.deepEqual(await call("unfollow_thread", { task: "tests reviews" }), {
      status: "unfollowed",
      task: "tests Reviews",
    });
    assert.deepEqual(registry.followedTasks(), []);
  });
});

describe("cancel_last_action: « non, arrête » right after a read-back", () => {
  test("after a start, the agent is stopped, the thread archived and the task no longer followed", async () => {
    const { backend, registry, call } = await setup();
    await call("start_task", startArgs);

    const result = await call("cancel_last_action");

    assert.deepEqual(result, { status: "cancelled", action: "start_task", task: "tests Reviews" });
    assert.deepEqual(backend.commands.slice(1), [
      { type: "stop", commandId: "id-2", threadId: "launched-1" },
      { type: "archive", commandId: "id-3", threadId: "launched-1" },
    ]);
    assert.deepEqual(registry.followedTasks(), []);
  });

  test("after a queued message, the message is taken back from the queue", async () => {
    const { backend, registry, call } = await setup({
      threads: [thread("t1", { projectId: "p1", status: "running" })],
    });
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));
    await call("send_message", { task: "tests reviews", message: "Supprime le test" });

    const result = await call("cancel_last_action");

    assert.deepEqual(result, {
      status: "cancelled",
      action: "send_message",
      task: "tests Reviews",
    });
    assert.deepEqual(backend.commands.at(-1), {
      type: "cancel_queued",
      commandId: "id-3",
      threadId: "t1",
      messageId: "id-2",
    });
  });

  test("a queued message the agent already took cannot be cancelled", async () => {
    const { backend, registry, call } = await setup({
      threads: [thread("t1", { projectId: "p1", status: "running" })],
    });
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));
    await call("send_message", { task: "tests reviews", message: "Supprime le test" });
    backend.messageStillQueued = false;

    assert.deepEqual(await call("cancel_last_action"), {
      status: "too_late",
      task: "tests Reviews",
    });
  });

  test("a message that started an idle thread is cancelled by stopping the agent", async () => {
    const { backend, registry, call } = await setup({
      threads: [thread("t1", { projectId: "p1", status: "completed" })],
    });
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));
    await call("send_message", { task: "tests reviews", message: "Supprime le test" });

    await call("cancel_last_action");

    assert.deepEqual(backend.commands.at(-1), { type: "stop", commandId: "id-3", threadId: "t1" });
  });

  test("a thread with only a question pending has no run: the message starts one, and undo stops it", async () => {
    const pending = { id: "r1", kind: "user_input", blocking: false };
    const { backend, registry, call } = await setup({
      threads: [thread("t1", { projectId: "p1", status: "completed", pendingRequest: pending })],
    });
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));
    await call("send_message", { task: "tests reviews", message: "Supprime le test" });

    await call("cancel_last_action");

    assert.deepEqual(backend.commands.at(-1), { type: "stop", commandId: "id-3", threadId: "t1" });
  });

  test("a steered message cannot be cancelled: the agent already read it", async () => {
    const { backend, registry, call } = await setup({
      threads: [thread("t1", { projectId: "p1", status: "running" })],
    });
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));
    await call("send_message", { task: "tests reviews", message: "Supprime", mode: "steer" });

    assert.deepEqual(await call("cancel_last_action"), {
      status: "too_late",
      task: "tests Reviews",
    });
    assert.equal(backend.commands.length, 1);
  });

  test("after 60 seconds, or with nothing done, there is nothing to cancel", async () => {
    const { backend, clock, call } = await setup();
    assert.deepEqual(await call("cancel_last_action"), { error: "nothing_to_cancel" });

    await call("start_task", startArgs);
    clock.advance(60_001);

    assert.deepEqual(await call("cancel_last_action"), { error: "nothing_to_cancel" });
    assert.equal(backend.commands.length, 1);
  });

  test("a start that started nothing ends the window of the start before it", async () => {
    const { backend, call } = await setup();
    await call("start_task", startArgs);
    await call("start_task", { ...startArgs, project: "locallab" });

    assert.deepEqual(await call("cancel_last_action"), { error: "nothing_to_cancel" });
    assert.equal(backend.commands.length, 1);
  });

  test("an undo that failed halfway can be asked again", async () => {
    const { backend, registry, call } = await setup();
    await call("start_task", startArgs);
    backend.failNextCommand = "archive";

    assert.deepEqual(await call("cancel_last_action"), { error: "t3_failed" });
    assert.equal(((await call("cancel_last_action")) as { status: string }).status, "cancelled");
    assert.equal(backend.commands.at(-1)?.type, "archive");
    assert.deepEqual(registry.followedTasks(), []);
  });

  test("an action is cancelled once", async () => {
    const { call } = await setup();
    await call("start_task", startArgs);
    await call("cancel_last_action");

    assert.deepEqual(await call("cancel_last_action"), { error: "nothing_to_cancel" });
  });
});

describe("interrupt_task: only after the task is named and a clear « oui »", () => {
  async function withRunningTask() {
    const context = await setup({
      threads: [thread("t1", { projectId: "p1", status: "running", title: "Fix Reviews specs" })],
    });
    context.registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));
    return context;
  }

  test("asks first, with the task's name and project, and sends nothing to T3", async () => {
    const { backend, call } = await withRunningTask();

    const question = await call("interrupt_task", { task: "la tâche tests reviews" });

    assert.deepEqual(withoutToken(question), {
      needs_confirmation: true,
      read_back: { action: "interrupt_task", task: "tests Reviews", project: "joombo" },
    });
    assert.deepEqual(backend.commands, []);
  });

  test("after a clear « oui », the agent is stopped and the task stays followed", async () => {
    const { backend, registry, call, say, confirm } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });

    await say("Oui.");
    const result = await confirm("interrupt_task", question, { task: "tests reviews" });

    assert.deepEqual(result, { status: "interrupted", task: "tests Reviews" });
    assert.deepEqual(backend.commands, [{ type: "stop", commandId: "id-1", threadId: "t1" }]);
    assert.equal(registry.followedTasks().length, 1);
  });

  test("other clear answers count as yes", async () => {
    for (const answer of ["ouais vas-y", "Oui, confirme.", "d'accord", "OK"]) {
      const { backend, call, say, confirm } = await withRunningTask();
      const question = await call("interrupt_task", { task: "tests reviews" });
      await say(answer);

      await confirm("interrupt_task", question);

      assert.equal(backend.commands.length, 1, answer);
    }
  });

  test("anything unclear is not a yes, and nothing reaches T3", async () => {
    for (const answer of [
      "euh… attends, non laisse",
      "oui mais attends",
      "non",
      "hmm",
      "pas celle-là",
    ]) {
      const { backend, call, say, confirm } = await withRunningTask();
      const question = await call("interrupt_task", { task: "tests reviews" });
      await say(answer);

      assert.deepEqual(
        await confirm("interrupt_task", question),
        { error: "not_confirmed" },
        answer,
      );
      assert.deepEqual(backend.commands, [], answer);
    }
  });

  test("with no answer at all, nothing reaches T3", async () => {
    const { backend, call, confirm } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });

    assert.deepEqual(await confirm("interrupt_task", question), { error: "not_confirmed" });
    assert.deepEqual(backend.commands, []);
  });

  test("a « oui » said before the question does not count", async () => {
    const { backend, call, say, confirm } = await withRunningTask();
    await say("oui");
    const question = await call("interrupt_task", { task: "tests reviews" });

    assert.deepEqual(await confirm("interrupt_task", question), { error: "not_confirmed" });
    assert.deepEqual(backend.commands, []);
  });

  test("a « oui » whose transcript arrives just after the call still counts", async () => {
    const { backend, engine, clock, call, say } = await withRunningTask();
    const question = (await call("interrupt_task", { task: "tests reviews" })) as {
      confirmation: string;
    };

    engine.last.emit({
      type: "tool_call",
      callId: "late",
      name: "interrupt_task",
      arguments: { task: "tests reviews", confirmation: question.confirmation },
    });
    await settle();
    clock.advance(500);
    await say("oui");
    clock.advance(ANSWER_QUIET_MS);
    await settle();

    const result = engine.last.toolResults.find((each) => each.callId === "late")?.result;
    assert.deepEqual(result, { status: "interrupted", task: "tests Reviews" });
    assert.equal(backend.commands.length, 1);
  });

  test("the answer is judged whole, after the user paused: « oui… mais attends » is not a yes", async () => {
    const { backend, engine, clock, call, say } = await withRunningTask();
    const question = (await call("interrupt_task", { task: "tests reviews" })) as {
      confirmation: string;
    };
    await say("Oui");

    engine.last.emit({
      type: "tool_call",
      callId: "early",
      name: "interrupt_task",
      arguments: { task: "tests reviews", confirmation: question.confirmation },
    });
    await settle();
    clock.advance(ANSWER_QUIET_MS - 200);
    await say(" mais attends");
    clock.advance(ANSWER_QUIET_MS);
    await settle();

    const result = engine.last.toolResults.find((each) => each.callId === "early")?.result;
    assert.deepEqual(result, { error: "not_confirmed" });
    assert.deepEqual(backend.commands, []);
  });

  test("a yes word in the request, transcribed after the question, is not the answer", async () => {
    const { backend, engine, clock, say } = await withRunningTask();
    await say("Interromps tests reviews");
    clock.advance(300);
    engine.last.emit({
      type: "tool_call",
      callId: "ask",
      name: "interrupt_task",
      arguments: { task: "tests reviews" },
    });
    await settle();
    const question = engine.last.toolResults.find((each) => each.callId === "ask")?.result as {
      confirmation: string;
    };
    engine.last.emit({ type: "speech", speaker: "assistant" });
    clock.advance(200);
    await say(", OK ?");

    engine.last.emit({
      type: "tool_call",
      callId: "confirm",
      name: "interrupt_task",
      arguments: { task: "tests reviews", confirmation: question.confirmation },
    });
    await settle();
    clock.advance(TRANSCRIPT_WAIT_MS);
    await settle();

    const result = engine.last.toolResults.find((each) => each.callId === "confirm")?.result;
    assert.deepEqual(result, { error: "not_confirmed" });
    assert.deepEqual(backend.commands, []);
  });

  test("an answer still going at the end of the 60 s window is too late", async () => {
    const { backend, engine, clock, call, say } = await withRunningTask();
    const question = (await call("interrupt_task", { task: "tests reviews" })) as {
      confirmation: string;
    };
    clock.advance(59_000);
    await say("oui");
    engine.last.emit({
      type: "tool_call",
      callId: "long",
      name: "interrupt_task",
      arguments: { task: "tests reviews", confirmation: question.confirmation },
    });
    await settle();
    for (let second = 0; second < 5; second++) {
      clock.advance(500);
      await say(" et après tu regarderas les logs");
    }
    clock.advance(ANSWER_QUIET_MS);
    await settle();

    const result = engine.last.toolResults.find((each) => each.callId === "long")?.result;
    assert.deepEqual(result, { error: "confirmation_expired" });
    assert.deepEqual(backend.commands, []);
  });

  test("an answer cut by the end of the session runs nothing", async () => {
    const { backend, engine, clock, call, say } = await withRunningTask();
    const question = (await call("interrupt_task", { task: "tests reviews" })) as {
      confirmation: string;
    };
    await say("oui");
    engine.last.emit({
      type: "tool_call",
      callId: "cut",
      name: "interrupt_task",
      arguments: { task: "tests reviews", confirmation: question.confirmation },
    });
    await settle();
    engine.last.emit({ type: "closed", reason: "closed" });
    clock.advance(ANSWER_QUIET_MS);
    await settle();

    assert.deepEqual(backend.commands, []);
  });

  test("transcript pieces join as they come: « ou » + « ais » is « ouais »", async () => {
    const { backend, call, say, confirm } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });
    await say("Ou");
    await say("ais");

    await confirm("interrupt_task", question);

    assert.equal(backend.commands.length, 1);
  });

  test("a transcript piece that ends inside a word is not a doubt: « oui, n » + « ickel »", async () => {
    const { backend, call, say, confirm } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });
    await say(" oui,");
    await say(" n");
    await say("ickel");

    await confirm("interrupt_task", question);

    assert.equal(backend.commands.length, 1);
  });

  test("a confirmation works once", async () => {
    const { backend, call, say, confirm } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });
    await say("oui");
    await confirm("interrupt_task", question);

    assert.deepEqual(await confirm("interrupt_task", question), {
      error: "invalid_confirmation",
    });
    assert.equal(backend.commands.length, 1);
  });

  test("an answer refused uses the confirmation up: the assistant must ask again", async () => {
    const { backend, call, say, confirm } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });
    await say("hmm");
    await confirm("interrupt_task", question);
    await say("oui");

    assert.deepEqual(await confirm("interrupt_task", question), {
      error: "invalid_confirmation",
    });
    assert.deepEqual(backend.commands, []);
  });

  test("an answer more than 60 seconds after the question is too late", async () => {
    const { backend, clock, call, say, confirm } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });
    clock.advance(60_001);
    await say("oui");

    assert.deepEqual(await confirm("interrupt_task", question), {
      error: "confirmation_expired",
    });
    assert.deepEqual(backend.commands, []);
  });

  test("a confirmation given to another tool does nothing", async () => {
    const { backend, call, say, confirm } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });
    await say("oui");

    assert.deepEqual(await confirm("start_task", question, startArgs), {
      error: "invalid_confirmation",
    });
    assert.deepEqual(backend.commands, []);
  });

  test("a confirmation from another device's session does nothing", async () => {
    const { backend, call, say, confirm, sessions } = await withRunningTask();
    const question = await call("interrupt_task", { task: "tests reviews" });
    await sessions.open("d2", { sdpOffer: "v=0", timeZone: null });
    await say("oui");

    assert.deepEqual(await confirm("interrupt_task", question), {
      error: "invalid_confirmation",
    });
    assert.deepEqual(backend.commands, []);
  });

  test("a new question replaces the one before: its « oui » is for the new one only", async () => {
    const { backend, call, say, confirm } = await setup({
      threads: [
        thread("t1", { status: "running", title: "Fix Reviews specs" }),
        thread("t2", { status: "running", title: "Refonte accueil" }),
      ],
    });
    const first = await call("interrupt_task", { task: "Fix Reviews specs" });
    await call("interrupt_task", { task: "Refonte accueil" });
    await say("oui");

    assert.deepEqual(await confirm("interrupt_task", first), { error: "invalid_confirmation" });
    assert.deepEqual(backend.commands, []);
  });

  test("a thread nobody follows is found by its title", async () => {
    const { backend, call, say, confirm } = await setup({
      threads: [thread("t9", { status: "running", title: "Fix flaky Reviews specs" })],
    });

    const question = await call("interrupt_task", { task: "fix flaky reviews" });
    await say("oui");
    const result = await confirm("interrupt_task", question);

    assert.deepEqual(withoutToken(question), {
      needs_confirmation: true,
      read_back: { action: "interrupt_task", task: "Fix flaky Reviews specs", project: "joombo" },
    });
    assert.deepEqual(result, { status: "interrupted", task: "Fix flaky Reviews specs" });
    assert.deepEqual(backend.commands, [{ type: "stop", commandId: "id-1", threadId: "t9" }]);
  });

  test("a reference that fits several tasks lists them, and asks nothing", async () => {
    const { backend, registry, call } = await setup({
      threads: [thread("t1", { status: "running" }), thread("t2", { status: "running" })],
    });
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));
    registry.follow(followedTask("t2", { spokenName: "tests Reviews admin" }));

    assert.deepEqual(await call("interrupt_task", { task: "tests" }), {
      status: "ambiguous_task",
      choices: ["tests Reviews", "tests Reviews admin"],
    });
    assert.deepEqual(backend.commands, []);
  });

  test("an unknown task, or one with no agent at work, asks nothing", async () => {
    const { backend, registry, call } = await setup({
      threads: [thread("t1", { status: "completed" })],
    });
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));

    assert.deepEqual(await call("interrupt_task", { task: "tests reviews" }), {
      status: "not_running",
      task: "tests Reviews",
    });
    assert.equal(
      ((await call("interrupt_task", { task: "refonte accueil" })) as { error: string }).error,
      "unknown_task",
    );
    assert.deepEqual(await call("interrupt_task", {}), { error: "invalid_arguments" });
    assert.deepEqual(backend.commands, []);
  });

  test("after an interruption, « non, arrête » cancels nothing", async () => {
    const { backend, call, say, confirm } = await withRunningTask();
    await call("start_task", startArgs);
    const question = await call("interrupt_task", { task: "tests reviews" });
    await say("oui");
    await confirm("interrupt_task", question);

    assert.deepEqual(await call("cancel_last_action"), { error: "nothing_to_cancel" });
    assert.deepEqual(
      backend.commands.map((command) => command.type),
      ["launch", "stop"],
    );
  });

  test("while T3 is away, nothing is asked", async () => {
    const { call, disconnectT3 } = await withRunningTask();
    disconnectT3();

    assert.deepEqual(await call("interrupt_task", { task: "tests reviews" }), {
      error: "t3_unavailable",
    });
  });
});

describe("start_task in a folder another agent works in: only after a clear « oui »", () => {
  const busyRoot = thread("t1", { projectId: "p1", status: "running", worktreePath: null });

  test("a busy project that is not a git repository starts in its folder after « oui »", async () => {
    const { backend, registry, call, say, confirm } = await setup({ threads: [busyRoot] });
    backend.repositories.set("/home/me/joombo", { isGitRepository: false, defaultBranch: null });
    const question = await call("start_task", startArgs);

    await say("oui, lance-le");
    const result = await confirm("start_task", question, startArgs);

    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].workspace, {
      type: "project_folder",
    });
    assert.deepEqual(result, {
      status: "started",
      task: "tests Reviews",
      agent: "Claude",
      model: "Claude Opus 5.5",
      project: "joombo",
      workspace: "project_folder",
      request: "Corriger les tests des Reviews",
    });
    assert.equal(registry.followedTasks().length, 1);
  });

  test("a shared start that fails leaves the folder busy for a start still launching", async () => {
    const { backend, engine, call, say, confirm } = await setup();
    let releaseFirst = () => {};
    backend.launchGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    engine.last.emit({ type: "tool_call", callId: "a", name: "start_task", arguments: startArgs });
    await settle();
    const sharedArgs = { ...startArgs, workspace: "shared", spoken_name: "autre tâche" };
    const question = await call("start_task", sharedArgs);
    backend.launchGate = null;
    backend.failNextCommand = "launch";
    await say("oui");
    await confirm("start_task", question, sharedArgs);

    await call("start_task", { ...startArgs, spoken_name: "troisième tâche" });
    releaseFirst();
    await settle();

    assert.deepEqual(
      backend.commands.map((command) => (command.type === "launch" ? command.workspace.type : "")),
      ["new_worktree", "project_folder"],
    );
  });

  test("a shared folder asked for on a busy project needs a « oui » too", async () => {
    const { backend, call, say, confirm } = await setup({ threads: [busyRoot] });
    const args = { ...startArgs, workspace: "shared" };

    const question = await call("start_task", args);
    assert.equal(
      (withoutToken(question) as { read_back: { reason: string } }).read_back.reason,
      "folder_busy",
    );
    assert.deepEqual(backend.commands, []);

    await say("non");
    assert.deepEqual(await confirm("start_task", question, args), { error: "not_confirmed" });
    assert.deepEqual(backend.commands, []);
  });

  test("a shared folder asked for on a free project starts at once, even in a worktree project", async () => {
    const { backend, call } = await setup({
      projects: [project("p1", "joombo", { newThreadWorkspace: "new_worktree" })],
    });

    const result = await call("start_task", { ...startArgs, workspace: "shared" });

    assert.equal((result as { status: string }).status, "started");
    assert.deepEqual(backend.commands[0]?.type === "launch" && backend.commands[0].workspace, {
      type: "project_folder",
    });
  });

  test("what starts is what was read back, whatever the second call says", async () => {
    const { backend, call, say, confirm } = await setup({ threads: [busyRoot] });
    const args = { ...startArgs, workspace: "shared" };
    const question = await call("start_task", args);
    await say("oui");

    await confirm("start_task", question, { ...args, prompt: "Supprimer la base" });

    assert.equal(
      backend.commands[0]?.type === "launch" && backend.commands[0].prompt,
      "Corriger les tests des Reviews",
    );
  });

  test("a start confirmed by « oui » can still be cancelled by « non, arrête »", async () => {
    const { backend, call, say, confirm } = await setup({ threads: [busyRoot] });
    const args = { ...startArgs, workspace: "shared" };
    const question = await call("start_task", args);
    await say("oui");
    await confirm("start_task", question, args);

    assert.equal(((await call("cancel_last_action")) as { status: string }).status, "cancelled");
    assert.deepEqual(
      backend.commands.map((command) => command.type),
      ["launch", "stop", "archive"],
    );
  });

  test("a question ends the window of the start before it", async () => {
    const { backend, call } = await setup({ threads: [busyRoot] });
    await call("start_task", startArgs);
    await call("start_task", { ...startArgs, workspace: "shared" });

    assert.deepEqual(await call("cancel_last_action"), { error: "nothing_to_cancel" });
    assert.equal(backend.commands.length, 1);
  });
});
