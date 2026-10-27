// Starting and steering T3 tasks by voice: the tools start_task, send_message,
// follow_thread, unfollow_thread, and the undo behind cancel_last_action.
//
// Every tool checks its arguments, finds the project or task the user named, and acts on
// T3 only when exactly one fits. Several fits return the choices; nothing is guessed.

import type { Clock } from "../ports/clock.ts";
import type {
  LaunchWorkspace,
  ModelSelection,
  Project,
  Provider,
  T3Backend,
  T3Config,
  Thread,
} from "../ports/t3Backend.ts";
import type { FollowedTask, TaskRegistry } from "../ports/taskRegistry.ts";
import { isRunning, type ShellState } from "./shellState.ts";
import { chooseSpokenName, findByName, keyOf } from "./spokenNames.ts";

export interface VoiceTasksOptions {
  backend: T3Backend;
  registry: TaskRegistry;
  /** The current T3 state, or null while the companion is not connected to T3. */
  shell(): ShellState | null;
  clock: Clock;
  /** A new unique id, for T3 command and message ids. */
  newId(): string;
  /** Operational lines only: never prompts, messages or titles. */
  log(line: string): void;
}

/** What a tool answers the voice model. It must be JSON-serializable. */
export type ToolResult = Record<string, unknown>;

/** How to take back the action a tool just did, while "non, arrête" can still undo it. */
export type Undo = () => Promise<ToolResult>;

export interface ToolOutcome {
  result: ToolResult;
  /** Set when the action can be cancelled right after its read-back. */
  undo?: Undo;
}

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"];

/** T3 driver kinds and the name the user says for them. */
const DRIVER_NAMES: Record<string, string> = { claudeAgent: "claude", codex: "codex" };

/** Longest first title sent to T3, which writes the real one from the prompt. */
const TITLE_LENGTH = 80;

export class VoiceTasks {
  private readonly options: VoiceTasksOptions;

  constructor(options: VoiceTasksOptions) {
    this.options = options;
  }

  async startTask(args: unknown): Promise<ToolOutcome> {
    const input = args as Record<string, unknown> | null;
    const projectName = text(input?.project);
    const prompt = text(input?.prompt);
    const runtimeMode = input?.runtime_mode;
    const workspace = input?.workspace;
    if (
      projectName === null ||
      prompt === null ||
      !optionalText(input?.agent) ||
      !optionalText(input?.model) ||
      !optionalText(input?.folder) ||
      !optionalText(input?.spoken_name) ||
      !(runtimeMode === undefined || RUNTIME_MODES.includes(runtimeMode as string)) ||
      !(workspace === undefined || workspace === "new_worktree")
    ) {
      return { result: { error: "invalid_arguments" } };
    }
    const shell = this.options.shell();
    if (shell === null) return { result: { error: "t3_unavailable" } };

    const projectMatch = findProject(shell, projectName, text(input?.folder));
    if (projectMatch.kind !== "found") return { result: projectMatch.result };
    const project = projectMatch.project;

    let config: T3Config;
    try {
      config = await this.options.backend.getConfig();
    } catch (error) {
      return { result: this.failed("start_task", error) };
    }
    const selection = chooseModel(config, project, text(input?.agent), text(input?.model));
    if (selection.kind !== "found") return { result: selection.result };

    const place = await this.chooseWorkspace(shell, project, workspace === "new_worktree");
    if (place.kind === "error") return { result: place.result };

    let threadId: string;
    try {
      ({ threadId } = await this.options.backend.launchThread({
        commandId: this.options.newId(),
        projectId: project.id,
        title: prompt.slice(0, TITLE_LENGTH),
        model: selection.model,
        runtimeMode: (runtimeMode as string | undefined) ?? config.defaultRuntimeMode,
        prompt,
        workspace: place.workspace,
      }));
    } catch (error) {
      return { result: this.failed("start_task", error) };
    }
    // Chosen with no wait before it is stored, so two starts never take the same name.
    const spokenName = chooseSpokenName({
      proposed: text(input?.spoken_name),
      source: prompt,
      project: project.title,
      taken: this.options.registry.followedTasks().map((task) => task.spokenName),
    });
    this.follow({ threadId, projectId: project.id, spokenName, origin: "voice" });
    this.options.log(`t3-voice: started a voice task in project ${project.id}.`);

    return {
      result: {
        status: "started",
        task: spokenName,
        agent: selection.provider.displayName,
        model: modelName(selection.provider, selection.model.model),
        project: spokenProject(shell, project),
        workspace: place.workspace.type,
        request: prompt,
      },
      undo: () => this.cancelStart(threadId, spokenName),
    };
  }

  async sendMessage(args: unknown): Promise<ToolOutcome> {
    const input = args as Record<string, unknown> | null;
    const reference = text(input?.task);
    const message = text(input?.message);
    const mode = input?.mode ?? "queue";
    if (reference === null || message === null || !(mode === "queue" || mode === "steer")) {
      return { result: { error: "invalid_arguments" } };
    }
    const shell = this.options.shell();
    if (shell === null) return { result: { error: "t3_unavailable" } };
    const match = this.findFollowed(reference);
    if (match.kind !== "found") return { result: match.result };
    const task = match.task;

    const thread = shell.threads.get(task.threadId);
    // Queued on an idle thread, the message starts a new run at once.
    const wasRunning = thread !== undefined && isRunning(thread);
    const commandId = this.options.newId();
    const messageId = this.options.newId();
    try {
      await this.options.backend.sendMessage({
        commandId,
        threadId: task.threadId,
        messageId,
        text: message,
        mode,
      });
    } catch (error) {
      return { result: this.failed("send_message", error) };
    }
    return {
      result: { status: "sent", task: task.spokenName, mode, message },
      undo: () => this.cancelMessage(task, messageId, mode, wasRunning),
    };
  }

  followThread(args: unknown): ToolResult {
    const input = args as Record<string, unknown> | null;
    const reference = text(input?.task);
    if (reference === null || !optionalText(input?.spoken_name)) {
      return { error: "invalid_arguments" };
    }
    const shell = this.options.shell();
    if (shell === null) return { error: "t3_unavailable" };

    const followed = this.findFollowed(reference);
    if (followed.kind === "found") {
      return { status: "already_followed", task: followed.task.spokenName };
    }
    const threads = [...shell.threads.values()]
      .filter((thread) => !thread.archived && !thread.isSubagent)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const match = findByName(reference, threads, (thread) => thread.title);
    if (match.kind === "none") return { error: "unknown_task" };
    if (match.kind === "ambiguous") {
      return { status: "ambiguous_task", choices: match.items.map((thread) => thread.title) };
    }
    const thread: Thread = match.item;
    const already = this.options.registry
      .followedTasks()
      .find((task) => task.threadId === thread.id);
    if (already !== undefined) return { status: "already_followed", task: already.spokenName };

    const projectTitle = shell.projects.get(thread.projectId)?.title ?? "";
    const spokenName = chooseSpokenName({
      proposed: text(input?.spoken_name),
      source: thread.title,
      project: projectTitle,
      taken: this.options.registry.followedTasks().map((task) => task.spokenName),
    });
    this.follow({
      threadId: thread.id,
      projectId: thread.projectId,
      spokenName,
      origin: "followed",
    });
    return { status: "followed", task: spokenName, project: projectTitle };
  }

  unfollowThread(args: unknown): ToolResult {
    const reference = text((args as Record<string, unknown> | null)?.task);
    if (reference === null) return { error: "invalid_arguments" };
    const match = this.findFollowed(reference);
    if (match.kind !== "found") return match.result;
    this.options.registry.unfollow(match.task.threadId);
    return { status: "unfollowed", task: match.task.spokenName };
  }

  /** "non, arrête" after a start: stop the agent, archive the thread, stop following it. */
  private async cancelStart(threadId: string, spokenName: string): Promise<ToolResult> {
    try {
      await this.options.backend.stopThread(this.options.newId(), threadId);
      await this.options.backend.archiveThread(this.options.newId(), threadId);
    } catch (error) {
      return this.failed("cancel_last_action", error);
    }
    this.options.registry.unfollow(threadId);
    return { status: "cancelled", action: "start_task", task: spokenName };
  }

  /**
   * "non, arrête" after a message. A queued message is taken back if it still waits. A
   * message that started an idle thread stops its agent. A steered one was already read.
   */
  private async cancelMessage(
    task: FollowedTask,
    messageId: string,
    mode: "queue" | "steer",
    wasRunning: boolean,
  ): Promise<ToolResult> {
    const tooLate = { status: "too_late", task: task.spokenName };
    if (mode === "steer") return tooLate;
    const { backend } = this.options;
    try {
      if (wasRunning) {
        const cancelled = await backend.cancelQueuedMessage(
          this.options.newId(),
          task.threadId,
          messageId,
        );
        if (!cancelled) return tooLate;
      } else {
        await backend.stopThread(this.options.newId(), task.threadId);
      }
    } catch (error) {
      return this.failed("cancel_last_action", error);
    }
    return { status: "cancelled", action: "send_message", task: task.spokenName };
  }

  /** Where the new thread works: the project folder, or a new worktree when it must or was asked. */
  private async chooseWorkspace(
    shell: ShellState,
    project: Project,
    worktreeAsked: boolean,
  ): Promise<{ kind: "ok"; workspace: LaunchWorkspace } | { kind: "error"; result: ToolResult }> {
    const folderBusy = [...shell.threads.values()].some(
      (thread) =>
        thread.projectId === project.id &&
        thread.worktreePath === null &&
        !thread.archived &&
        !thread.isSubagent &&
        isRunning(thread),
    );
    const projectFolder = { kind: "ok" as const, workspace: { type: "project_folder" as const } };
    if (!(worktreeAsked || folderBusy || project.newThreadWorkspace === "worktree")) {
      return projectFolder;
    }
    let baseBranch: string | null;
    try {
      const repository = await this.options.backend.inspectRepository(project.workspaceRoot);
      baseBranch = repository.isGitRepository ? repository.defaultBranch : null;
    } catch (error) {
      return { kind: "error", result: this.failed("start_task", error) };
    }
    if (baseBranch !== null) {
      return { kind: "ok", workspace: { type: "new_worktree", baseBranch } };
    }
    // No worktree without git. Sharing a busy folder needs a spoken "oui" (ticket #21).
    if (folderBusy) return { kind: "error", result: { error: "project_busy_not_git" } };
    return projectFolder;
  }

  private findFollowed(
    reference: string,
  ): { kind: "found"; task: FollowedTask } | { kind: "other"; result: ToolResult } {
    const tasks = this.options.registry.followedTasks();
    const match = findByName(reference, tasks, (task) => task.spokenName);
    if (match.kind === "found") return { kind: "found", task: match.item };
    if (match.kind === "ambiguous") {
      return {
        kind: "other",
        result: { status: "ambiguous_task", choices: match.items.map((task) => task.spokenName) },
      };
    }
    return {
      kind: "other",
      result: { error: "unknown_task", followed: tasks.map((task) => task.spokenName) },
    };
  }

  private follow(task: Pick<FollowedTask, "threadId" | "projectId" | "spokenName" | "origin">) {
    this.options.registry.follow({
      ...task,
      lastAnnouncedState: null,
      lastEventKey: null,
      cursor: null,
      followedAt: new Date(this.options.clock.now()).toISOString(),
    });
  }

  private failed(tool: string, error: unknown): ToolResult {
    // The error's message could quote the request: only its kind is logged.
    const kind = error instanceof Error ? error.name : "unknown error";
    this.options.log(`t3-voice: T3 refused ${tool} (${kind}).`);
    return { error: "t3_failed" };
  }
}

type ProjectMatch = { kind: "found"; project: Project } | { kind: "other"; result: ToolResult };

/**
 * The project the user named, by its title or its folder's name. Several projects can share
 * a title (three "joombo"): the user then picks one by its folder name.
 */
function findProject(shell: ShellState, name: string, folder: string | null): ProjectMatch {
  const projects = [...shell.projects.values()];
  if (folder !== null) {
    const inFolder = projects.filter((project) => keyOf(folderOf(project)) === keyOf(folder));
    const [only] = inFolder;
    if (inFolder.length === 1 && only !== undefined) return { kind: "found", project: only };
  }
  const byTitle = findByName(name, projects, (project) => project.title);
  const match = byTitle.kind === "none" ? findByName(name, projects, folderOf) : byTitle;
  if (match.kind === "found") return { kind: "found", project: match.item };
  if (match.kind === "ambiguous") {
    return {
      kind: "other",
      result: { status: "ambiguous_project", choices: match.items.map(folderOf) },
    };
  }
  const titles = [...new Set(projects.map((project) => project.title))].sort();
  return { kind: "other", result: { error: "unknown_project", projects: titles } };
}

type ModelMatch =
  | { kind: "found"; provider: Provider; model: ModelSelection }
  | { kind: "other"; result: ToolResult };

/**
 * The agent and model the user named. What they did not name comes from the project's
 * default, then T3's default, then the agent's first model.
 */
function chooseModel(
  config: T3Config,
  project: Project,
  agentName: string | null,
  modelName: string | null,
): ModelMatch {
  const providers = config.providers.filter((provider) => provider.enabled);
  const defaults = [project.defaultModel, config.defaultModel].filter(
    (selection): selection is ModelSelection => selection !== null,
  );
  let provider: Provider | undefined;
  if (agentName === null) {
    provider = defaults
      .map((selection) =>
        providers.find((each) => each.instanceId === selection.providerInstanceId),
      )
      .find((each) => each !== undefined);
  } else {
    const match = findByName(
      agentName,
      providers,
      (candidate) =>
        `${candidate.displayName} ${DRIVER_NAMES[candidate.driver] ?? candidate.driver}`,
    );
    // Two instances of one agent: the one the defaults use, or else the first.
    provider =
      match.kind === "found"
        ? match.item
        : match.kind === "ambiguous"
          ? (match.items.find((candidate) =>
              defaults.some((selection) => selection.providerInstanceId === candidate.instanceId),
            ) ?? match.items[0])
          : undefined;
  }
  if (provider === undefined) {
    return {
      kind: "other",
      result: { error: "unknown_agent", agents: providers.map((each) => each.displayName) },
    };
  }

  const models = provider.models;
  let slug: string | undefined;
  if (modelName === null) {
    const instanceId = provider.instanceId;
    slug =
      defaults.find((selection) => selection.providerInstanceId === instanceId)?.model ??
      models[0]?.slug;
  } else {
    const match = findByName(modelName, models, (model) => `${model.name} ${model.slug}`);
    slug = match.kind === "found" ? match.item.slug : undefined;
  }
  if (slug === undefined) {
    return { kind: "other", result: { error: "unknown_model", models: models.map((m) => m.name) } };
  }
  return {
    kind: "found",
    provider,
    model: { providerInstanceId: provider.instanceId, model: slug },
  };
}

function modelName(provider: Provider, slug: string): string {
  return provider.models.find((model) => model.slug === slug)?.name ?? slug;
}

/** The project's title, or its folder's name when another project has the same title. */
function spokenProject(shell: ShellState, project: Project): string {
  const shared = [...shell.projects.values()].some(
    (other) => other.id !== project.id && keyOf(other.title) === keyOf(project.title),
  );
  return shared ? folderOf(project) : project.title;
}

/** The last part of the project's folder ("joombo-ux-dev"): what tells same-titled projects apart. */
function folderOf(project: Project): string {
  return project.workspaceRoot.split("/").filter(Boolean).at(-1) ?? project.title;
}

/** A non-empty string, trimmed, or null. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function optionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}
