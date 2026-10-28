// Voice sessions: opens one per device with the voice engine and answers the tools the voice
// model calls, from the companion's view of T3.

import type {
  ActivityItem,
  OpenSessionRequest,
  OpenSessionResult,
  VoiceSessions,
} from "../ports/apiServer.ts";
import type { Clock } from "../ports/clock.ts";
import type { VoiceEngine, VoiceEvent, VoiceSession } from "../ports/voiceEngine.ts";
import { allActivity, finishedSince24Hours } from "./activity.ts";
import type { AnnouncementQueue } from "./announcementQueue.ts";
import { Confirmations } from "./confirmations.ts";
import { errorKind, randomSecret, scrubSecrets } from "./secrets.ts";
import type { ShellState } from "./shellState.ts";
import { VOICE_TOOLS, voiceInstructions } from "./voiceConversation.ts";
import type { ToolOutcome, Undo, VoiceTasks } from "./voiceTasks.ts";

export interface VoiceSessionManagerOptions {
  /** Null when no engine is configured (no OpenAI key): every open answers "unavailable". */
  engine: VoiceEngine | null;
  /** The current T3 state, or null while the companion is not connected to T3. */
  shell(): ShellState | null;
  /** The tools that start and steer T3 tasks. */
  tasks: VoiceTasks;
  /** Speaks the news of followed tasks in the open sessions. */
  announcements: AnnouncementQueue;
  /**
   * Whether the device was revoked (`t3-voice devices revoke` runs in another process).
   * A device that is not paired counts as revoked. A failure counts as revoked too.
   */
  isRevoked(deviceId: string): Promise<boolean>;
  clock: Clock;
  /** Operational lines only: never audio, transcripts, prompts or tool results. */
  log(line: string): void;
}

interface ActiveSession {
  id: string;
  deviceId: string;
  engineSession: VoiceSession;
  /** IANA time zone of the device. */
  timeZone: string;
  /** Clock time when the engine answered. */
  openedAt: number;
  /** Cancels the close that end_session scheduled, if any. */
  cancelEnd?: () => void;
  /** How to take back the session's last start or message, and until when (clock time). */
  lastAction?: { undo: Undo; until: number };
  /** The question the user must answer "oui" to, before a risky action runs. */
  confirmations: Confirmations;
}

/** How often open sessions are checked for a revoked device, when no tool is called. */
const REVOCATION_CHECK_MS = 30_000;

/** Tasks per tool answer: a longer list is too long to listen to. */
const SPOKEN_TASKS = 10;

/** Time the model gets to say goodbye after end_session, before the session closes. */
const GOODBYE_MS = 5_000;

/** How long "non, arrête" can still cancel a start or a message after its read-back. */
const CANCEL_WINDOW_MS = 60_000;

export class VoiceSessionManager implements VoiceSessions {
  private readonly options: VoiceSessionManagerOptions;
  /** The open session of each device, by device id. */
  private readonly byDevice = new Map<string, ActiveSession>();
  /** Per device, the open or close in progress: they run one at a time. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Set by closeAll: the companion is stopping, so no session opens any more. */
  private stopping = false;
  private cancelRevocationCheck: (() => void) | null = null;

  constructor(options: VoiceSessionManagerOptions) {
    this.options = options;
  }

  open(deviceId: string, request: OpenSessionRequest): Promise<OpenSessionResult> {
    return this.inTurn(deviceId, () => this.openNow(deviceId, request));
  }

  close(deviceId: string, sessionId: string): Promise<boolean> {
    return this.inTurn(deviceId, async () => {
      const session = this.byDevice.get(deviceId);
      if (session === undefined || session.id !== sessionId) return false;
      await this.end(session);
      return true;
    });
  }

  /** Ends every session, those still opening included: `serve` calls it before it stops. */
  async closeAll(): Promise<void> {
    this.stopping = true;
    this.cancelRevocationCheck?.();
    this.cancelRevocationCheck = null;
    await Promise.all([...this.queues.values()]);
    await Promise.all(
      [...this.byDevice.values()].map((session) =>
        this.close(session.deviceId, session.id).catch(() => {}),
      ),
    );
  }

  private async openNow(deviceId: string, request: OpenSessionRequest): Promise<OpenSessionResult> {
    const engine = this.options.engine;
    if (engine === null || this.stopping) return { status: "unavailable" };
    // One session per device: a new start (after an app crash, say) replaces the old one,
    // which would otherwise keep costing until it ends on its own.
    const previous = this.byDevice.get(deviceId);
    if (previous !== undefined) await this.end(previous);

    const timeZone =
      request.timeZone !== null && isTimeZone(request.timeZone)
        ? request.timeZone
        : serverTimeZone();
    // Events can only arrive once the engine answered, so `session` is set by then.
    let session: ActiveSession | null = null;
    let engineSession: VoiceSession;
    try {
      engineSession = await engine.openSession(
        {
          sdpOffer: request.sdpOffer,
          instructions: voiceInstructions(this.projectNames()),
          tools: VOICE_TOOLS,
        },
        (event) => {
          if (session !== null) this.onEvent(session, event);
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(
        `t3-voice: voice session for device ${deviceId} failed to open: ${scrubSecrets(message)}`,
      );
      return { status: "failed" };
    }
    const id = randomSecret(16);
    session = {
      id,
      deviceId,
      engineSession,
      timeZone,
      openedAt: this.options.clock.now(),
      confirmations: new Confirmations(this.options.clock, (open) =>
        this.options.announcements.questionOpen(id, open),
      ),
    };
    this.byDevice.set(deviceId, session);
    this.options.announcements.openSession(session.id, {
      speak: (text) => engineSession.speak(text),
      timeZone,
    });
    this.options.log(`t3-voice: voice session opened for device ${deviceId}.`);
    this.watchRevocations();
    return { status: "opened", sessionId: session.id, sdpAnswer: engineSession.sdpAnswer };
  }

  private async end(session: ActiveSession) {
    this.forget(session);
    await session.engineSession.close();
  }

  private forget(session: ActiveSession) {
    session.cancelEnd?.();
    this.options.announcements.closeSession(session.id);
    session.confirmations.close();
    if (this.byDevice.get(session.deviceId) === session) this.byDevice.delete(session.deviceId);
  }

  /** While a session is open, checks every 30 s that no open session's device was revoked. */
  private watchRevocations() {
    if (this.cancelRevocationCheck !== null || this.stopping || this.byDevice.size === 0) return;
    this.cancelRevocationCheck = this.options.clock.schedule(REVOCATION_CHECK_MS, () => {
      this.cancelRevocationCheck = null;
      this.closeRevoked().finally(() => this.watchRevocations());
    });
  }

  private async closeRevoked() {
    for (const session of [...this.byDevice.values()]) {
      if (await this.revoked(session.deviceId)) await this.closeAsRevoked(session);
    }
  }

  private async revoked(deviceId: string): Promise<boolean> {
    try {
      return await this.options.isRevoked(deviceId);
    } catch {
      // Fail closed: a device list we cannot read must not let a device through.
      return true;
    }
  }

  private async closeAsRevoked(session: ActiveSession) {
    this.options.log(`t3-voice: device ${session.deviceId} is revoked; closing its voice session.`);
    await this.close(session.deviceId, session.id).catch(() => {});
  }

  private inTurn<T>(deviceId: string, step: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(deviceId) ?? Promise.resolve()).then(step);
    const settled = run.catch(() => {});
    this.queues.set(deviceId, settled);
    // Forget the queue once it is empty, so it does not grow with every device ever seen.
    settled.then(() => {
      if (this.queues.get(deviceId) === settled) this.queues.delete(deviceId);
    });
    return run;
  }

  private onEvent(session: ActiveSession, event: VoiceEvent) {
    if (event.type === "closed") {
      this.forget(session);
      const minutes = (this.options.clock.now() - session.openedAt) / 60_000;
      this.options.log(
        `t3-voice: voice session of device ${session.deviceId} ${event.reason === "failed" ? "failed" : "ended"} after ${minutes.toFixed(1)} min.`,
      );
      return;
    }
    if (event.type === "speech") {
      if (event.speaker === "user") session.confirmations.heard(event.text);
      else session.confirmations.assistantSpoke();
      this.options.announcements.heardSpeech(session.id);
      return;
    }
    if (event.type === "tool_call") {
      const { announcements } = this.options;
      // The model speaks the result next: announcements wait until it is done.
      announcements.toolCallStarted(session.id);
      this.answerToolCall(session, event.callId, event.name, event.arguments)
        .catch(() => {})
        .finally(() => announcements.toolCallEnded(session.id));
    }
  }

  private async answerToolCall(
    session: ActiveSession,
    callId: string,
    name: string,
    args: unknown,
  ) {
    // Checked on every call: a revoked phone must not hear one more thing about T3.
    if (await this.revoked(session.deviceId)) {
      session.engineSession.resolveToolCall(callId, { error: "device_revoked" });
      await this.closeAsRevoked(session);
      return;
    }
    let result: unknown;
    try {
      result = await this.runTool(session, name, args);
    } catch (error) {
      // The model must get an answer, or it waits for one.
      this.options.log(`t3-voice: tool ${name} failed (${errorKind(error)}).`);
      result = { error: "internal_error" };
    }
    session.engineSession.resolveToolCall(callId, result);
  }

  private async runTool(session: ActiveSession, name: string, args: unknown): Promise<unknown> {
    const shell = this.options.shell();
    const { tasks } = this.options;
    switch (name) {
      case "start_task":
        return this.act(session, name, args, () => tasks.startTask(args));
      case "interrupt_task":
        return this.act(session, name, args, async () => tasks.interruptTask(args));
      case "send_message":
        return this.answer(session, name, await tasks.sendMessage(args));
      case "follow_thread":
        return tasks.followThread(args);
      case "unfollow_thread":
        return tasks.unfollowThread(args);
      case "get_task_details":
        return tasks.taskDetails(args);
      case "cancel_last_action": {
        const last = session.lastAction;
        if (last === undefined || this.options.clock.now() > last.until) {
          return { error: "nothing_to_cancel" };
        }
        session.lastAction = undefined;
        const result = await last.undo();
        // A failed undo can be asked again: each step is safe to send twice.
        if ("error" in result && session.lastAction === undefined) session.lastAction = last;
        return result;
      }
      case "list_projects":
      case "get_activity":
        // T3's last known state could be stale: the model must not present it as current.
        if (shell === null) return { error: "t3_unavailable" };
        if (name === "list_projects") return { projects: projectNamesOf(shell) };
        return this.activity(session, shell, args);
      case "end_session":
        session.cancelEnd?.();
        session.cancelEnd = this.options.clock.schedule(GOODBYE_MS, () => {
          this.close(session.deviceId, session.id).catch(() => {});
        });
        return { status: "ending" };
      default:
        return { error: "unknown_tool" };
    }
  }

  /**
   * Runs a tool whose action may need the user's "oui". Without a confirmation, the tool
   * acts or asks its question. With one, the action the question read back runs, and only
   * if the user answered it with a clear yes.
   */
  private async act(
    session: ActiveSession,
    tool: string,
    args: unknown,
    call: () => Promise<ToolOutcome>,
  ): Promise<unknown> {
    const token = (args as { confirmation?: unknown } | null)?.confirmation;
    if (typeof token !== "string") return this.answer(session, tool, await call());
    const taken = await session.confirmations.take(tool, token);
    if (taken.kind === "refused") return taken.result;
    return this.answer(session, tool, await taken.run());
  }

  /**
   * Keeps the undo of a start or a message, or asks the outcome's question. Every action or
   * question replaces the undo before, also one that did nothing: "non, arrête" never
   * reaches past it.
   */
  private answer(session: ActiveSession, tool: string, outcome: ToolOutcome): unknown {
    if ("confirm" in outcome) {
      session.lastAction = undefined;
      return session.confirmations.ask({ tool, ...outcome.confirm });
    }
    session.lastAction =
      outcome.undo === undefined
        ? undefined
        : { undo: outcome.undo, until: this.options.clock.now() + CANCEL_WINDOW_MS };
    return outcome.result;
  }

  private activity(session: ActiveSession, shell: ShellState, args: unknown): unknown {
    const now = new Date(this.options.clock.now());
    const { running, finished } = allActivity(shell);
    const scope = (args as { scope?: unknown } | null)?.scope;
    switch (scope) {
      case "running":
        return spokenList(running);
      case "finished":
        return spokenList(finishedSince24Hours(finished, now));
      case "today": {
        // The device's calendar day, which can last 23 or 25 hours.
        const today = dayIn(session.timeZone, now);
        return spokenList(
          finished.filter((item) => dayIn(session.timeZone, new Date(item.updatedAt)) === today),
        );
      }
      default:
        return { error: "invalid_arguments" };
    }
  }

  private projectNames(): string[] {
    const shell = this.options.shell();
    return shell === null ? [] : projectNamesOf(shell);
  }
}

function projectNamesOf(shell: ShellState): string[] {
  return [...shell.projects.values()].map((project) => project.title).sort();
}

/**
 * The latest tasks, and how many there are in all: the model can then say there are more
 * instead of presenting a short list as the whole.
 */
function spokenList(items: ActivityItem[]) {
  return { tasks: items.slice(0, SPOKEN_TASKS).map(spokenTask), total: items.length };
}

/** A task as the voice model gets it: no ids, it only speaks about tasks. */
function spokenTask(item: ActivityItem) {
  return {
    title: item.title,
    project: item.project,
    status: item.state,
    updatedAt: item.updatedAt,
  };
}

function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The calendar day ("2026-10-26") of `date` in `timeZone`. */
function dayIn(timeZone: string, date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
