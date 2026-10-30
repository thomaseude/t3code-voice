// Voice sessions: opens one per device with the voice engine and answers the tools the voice
// model calls, from the companion's view of T3. A session stops by itself after a silence or
// once the day's sessions cost the daily budget, and records what it cost.

import type {
  ActivityItem,
  OpenSessionRequest,
  OpenSessionResult,
  SessionEvent,
  VoiceSessions,
} from "../ports/apiServer.ts";
import type { Clock } from "../ports/clock.ts";
import type { SessionLimits } from "../ports/configStore.ts";
import type { PlanQuota } from "../ports/planQuota.ts";
import type { TaskRegistry, UsageRecord } from "../ports/taskRegistry.ts";
import type { VoiceEngine, VoiceEvent, VoiceSession } from "../ports/voiceEngine.ts";
import { allActivity, finishedSince24Hours } from "./activity.ts";
import type { AnnouncementQueue } from "./announcementQueue.ts";
import { awarenessOf } from "./awareness.ts";
import { Confirmations } from "./confirmations.ts";
import { planQuotaRefusal } from "./engineChoice.ts";
import { errorKind, randomSecret, scrubSecrets } from "./secrets.ts";
import type { ShellState } from "./shellState.ts";
import { VOICE_TOOLS, voiceInstructions } from "./voiceConversation.ts";
import type { ToolOutcome, Undo, VoiceTasks } from "./voiceTasks.ts";

/** A voice engine that draws from a plan's quota instead of the API key (#56). */
export interface PlanVoice {
  engine: VoiceEngine;
  quota: PlanQuota;
  /** Below this share of the quota left (0 to 100), sessions open on the API engine. */
  minPercentLeft: number;
}

export interface VoiceSessionManagerOptions {
  /**
   * The engine billed to the OpenAI API key. Null when no key is set up: sessions then
   * open on the plan engine only, and answer "unavailable" when it cannot be used.
   */
  engine: VoiceEngine | null;
  /** Tried first when a session opens, while enough of its quota is left. */
  plan?: PlanVoice;
  /** The current T3 state, or null while the companion is not connected to T3. */
  shell(): ShellState | null;
  /** The tools that start and steer T3 tasks. */
  tasks: VoiceTasks;
  /** Speaks the news of followed tasks in the open sessions. */
  announcements: AnnouncementQueue;
  /** The followed tasks, which make a silence last longer, and the usage records. */
  registry: TaskRegistry;
  limits: SessionLimits;
  /** IANA time zone whose calendar day the daily budget counts; the server's by default. */
  budgetTimeZone?: string;
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
  engine: VoiceEngine;
  engineSession: VoiceSession;
  /** IANA time zone of the device. */
  timeZone: string;
  /** Clock time when the engine answered. */
  openedAt: number;
  /** The budget's calendar day the session opened on: its whole cost counts on that day. */
  day: string;
  /** Clock time the usage was last saved. */
  usageSavedAt: number;
  /** Clock time of the last activity: user speech, a tool call, an announcement or unmuting. */
  lastActivityAt: number;
  /** Whether the app says its microphone is off: the silence warning then says how to go on. */
  muted: boolean;
  /** Clock time of the "je coupe dans 30 secondes" warning, or null since the last activity. */
  idleWarnedAt: number | null;
  /** Whether the session already heard the 80 % warning. */
  budgetWarned: boolean;
  /** Set once the session said it stops: it closes after the goodbye. */
  stopping: boolean;
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

const MINUTE_MS = 60_000;

/** How often open sessions are checked for a silence and for the budget. */
const LIMIT_CHECK_MS = 5_000;

/** How often an open session saves its usage, so a crash loses little of it. */
const USAGE_SAVE_MS = 60_000;

/** The warning comes this long before a silence stops the session (decided by Thomas in #24). */
const IDLE_WARNING_MS = 30_000;

/** Share of the daily budget at which the assistant warns once per session. */
const BUDGET_WARNING_SHARE = 0.8;

const IDLE_WARNING = "Je n'entends plus rien : je coupe dans 30 secondes si tu ne dis rien.";
const MUTED_IDLE_WARNING =
  "Tu es en sourdine depuis un moment : je coupe dans 30 secondes. Réactive le micro pour continuer.";
const IDLE_STOP = "Je coupe la conversation. Relance-moi quand tu veux.";
const BUDGET_WARNING = "Attention : tu as utilisé 80 % du budget voix du jour.";
const BUDGET_STOP = "Le budget voix du jour est atteint : je coupe la conversation.";

export class VoiceSessionManager implements VoiceSessions {
  private readonly options: VoiceSessionManagerOptions;
  /** The open session of each device, by device id. */
  private readonly byDevice = new Map<string, ActiveSession>();
  /** Per device, the open or close in progress: they run one at a time. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Set by closeAll: the companion is stopping, so no session opens any more. */
  private stopping = false;
  private cancelRevocationCheck: (() => void) | null = null;
  private cancelLimitCheck: (() => void) | null = null;
  /** Whether a followed task ran when T3 was last reachable: kept while T3 is away. */
  private taskRanWhenLastSeen = false;

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

  handleEvent(deviceId: string, sessionId: string, event: SessionEvent): boolean {
    const session = this.byDevice.get(deviceId);
    if (session === undefined || session.id !== sessionId) return false;
    session.muted = event === "mute";
    if (event === "unmute") this.markActivity(session);
    return true;
  }

  /** Ends every session, those still opening included: `serve` calls it before it stops. */
  async closeAll(): Promise<void> {
    this.stopping = true;
    this.cancelRevocationCheck?.();
    this.cancelRevocationCheck = null;
    this.cancelLimitCheck?.();
    this.cancelLimitCheck = null;
    await Promise.all([...this.queues.values()]);
    await Promise.all(
      [...this.byDevice.values()].map((session) =>
        this.close(session.deviceId, session.id).catch(() => {}),
      ),
    );
  }

  private async openNow(deviceId: string, request: OpenSessionRequest): Promise<OpenSessionResult> {
    const { engine: apiEngine, plan } = this.options;
    if ((apiEngine === null && plan === undefined) || this.stopping) {
      return { status: "unavailable" };
    }
    // One session per device: a new start (after an app crash, say) replaces the old one,
    // which would otherwise keep costing until it ends on its own.
    const previous = this.byDevice.get(deviceId);
    if (previous !== undefined) await this.end(previous);

    const timeZone =
      request.timeZone !== null && isTimeZone(request.timeZone)
        ? request.timeZone
        : serverTimeZone();
    const voiceRequest = {
      sdpOffer: request.sdpOffer,
      instructions: voiceInstructions(this.projectNames()),
      tools: VOICE_TOOLS,
    };
    // Events can only arrive once an engine answered, so `session` is set by then.
    let session: ActiveSession | null = null;
    const onEvent = (event: VoiceEvent) => {
      if (session !== null) this.onEvent(session, event);
    };

    // The engine is picked once, here: an open session stays on its engine.
    let chosen: { engine: VoiceEngine; engineSession: VoiceSession } | null = null;
    if (plan !== undefined && (await this.planAllows(deviceId, plan))) {
      try {
        chosen = {
          engine: plan.engine,
          engineSession: await plan.engine.openSession(voiceRequest, onEvent),
        };
      } catch (error) {
        this.options.log(
          `t3-voice: the plan engine failed to open a session for device ${deviceId} (${scrubSecrets(messageOf(error))}).`,
        );
      }
    }
    if (chosen === null) {
      if (apiEngine === null) return { status: "unavailable" };
      if (this.spentToday() >= this.options.limits.dailyBudgetUsd) {
        this.options.log(
          `t3-voice: the daily voice budget is reached; no session for ${deviceId}.`,
        );
        return { status: "budget_reached" };
      }
      try {
        chosen = {
          engine: apiEngine,
          engineSession: await apiEngine.openSession(voiceRequest, onEvent),
        };
      } catch (error) {
        this.options.log(
          `t3-voice: voice session for device ${deviceId} failed to open: ${scrubSecrets(messageOf(error))}`,
        );
        return { status: "failed" };
      }
    }
    const { engine, engineSession } = chosen;
    const id = randomSecret(16);
    const openedAt = this.options.clock.now();
    const opened: ActiveSession = {
      id,
      deviceId,
      engine,
      engineSession,
      timeZone,
      openedAt,
      confirmations: new Confirmations(this.options.clock, (open) =>
        this.options.announcements.questionOpen(id, open),
      ),
      day: this.dayOf(openedAt),
      usageSavedAt: openedAt,
      lastActivityAt: openedAt,
      muted: false,
      idleWarnedAt: null,
      budgetWarned: false,
      stopping: false,
    };
    session = opened;
    this.byDevice.set(deviceId, opened);
    this.options.announcements.openSession(opened.id, {
      // An announcement counts as activity: the silence starts again after it.
      speak: (text) => {
        engineSession.speak(text);
        this.markActivity(opened);
      },
      timeZone,
    });
    this.saveUsage(opened);
    this.options.log(`t3-voice: voice session opened for device ${deviceId} on ${engine.model}.`);
    this.watchRevocations();
    this.watchLimits();
    return { status: "opened", sessionId: opened.id, sdpAnswer: engineSession.sdpAnswer };
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

  /** Whether the plan's quota lets this session open on the plan engine. */
  private async planAllows(deviceId: string, plan: PlanVoice): Promise<boolean> {
    let refusal: string | null;
    try {
      refusal = planQuotaRefusal(await plan.quota.read(), plan.minPercentLeft);
    } catch (error) {
      refusal = `the quota is unreadable: ${scrubSecrets(messageOf(error))}`;
    }
    if (refusal !== null) {
      this.options.log(`t3-voice: no plan engine for device ${deviceId}: ${refusal}.`);
    }
    return refusal === null;
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

  /** While a session is open, checks every 5 s for a silence and for the daily budget. */
  private watchLimits() {
    if (this.cancelLimitCheck !== null || this.stopping || this.byDevice.size === 0) return;
    this.cancelLimitCheck = this.options.clock.schedule(LIMIT_CHECK_MS, () => {
      this.cancelLimitCheck = null;
      this.checkLimits();
      this.watchLimits();
    });
  }

  private checkLimits() {
    const now = this.options.clock.now();
    const sessions = [...this.byDevice.values()].filter((session) => !session.stopping);
    for (const session of sessions) {
      if (now - session.usageSavedAt >= USAGE_SAVE_MS) this.saveUsage(session);
    }
    const budget = this.options.limits.dailyBudgetUsd;
    const today = this.dayOf(now);
    const silenceLimitMs = this.silenceLimitMs();
    for (const session of sessions) {
      // A session on a plan spends no money: only the silence stops it.
      if (session.engine.billing !== "usd") {
        this.checkSilence(session, silenceLimitMs);
        continue;
      }
      // A session still open after midnight also counts against the day it started on.
      const spent = Math.max(this.spentOn(today), this.spentOn(session.day));
      if (spent >= budget) {
        this.stop(session, BUDGET_STOP, "the daily budget is reached");
        continue;
      }
      if (
        spent >= budget * BUDGET_WARNING_SHARE &&
        !session.budgetWarned &&
        this.options.announcements.isQuiet(session.id)
      ) {
        session.budgetWarned = true;
        this.say(session, BUDGET_WARNING);
      }
      this.checkSilence(session, silenceLimitMs);
    }
  }

  /** Warns 30 s before the limit, and stops only 30 s after the warning. */
  private checkSilence(session: ActiveSession, limitMs: number) {
    const now = this.options.clock.now();
    const silentFor = now - session.lastActivityAt;
    if (silentFor < limitMs - IDLE_WARNING_MS) {
      session.idleWarnedAt = null;
      return;
    }
    if (session.idleWarnedAt === null) {
      session.idleWarnedAt = now;
      this.say(session, session.muted ? MUTED_IDLE_WARNING : IDLE_WARNING);
      return;
    }
    if (silentFor >= limitMs && now - session.idleWarnedAt >= IDLE_WARNING_MS) {
      this.stop(session, IDLE_STOP, "silence");
    }
  }

  /**
   * The longer limit while a followed task runs. While T3 is away, the last known answer
   * holds (decided by Thomas in #24): a short restart of T3 does not cut a wait.
   */
  private silenceLimitMs(): number {
    const { idleMinutes, idleMinutesWhileTasksRun } = this.options.limits;
    const shell = this.options.shell();
    if (shell !== null) {
      this.taskRanWhenLastSeen = this.options.registry.followedTasks().some((task) => {
        const thread = shell.threads.get(task.threadId);
        return thread !== undefined && awarenessOf(thread) === "running";
      });
    }
    return (this.taskRanWhenLastSeen ? idleMinutesWhileTasksRun : idleMinutes) * MINUTE_MS;
  }

  /** Says why the session stops, then closes it after a short goodbye. */
  private stop(session: ActiveSession, text: string, reason: string) {
    session.stopping = true;
    this.say(session, text);
    this.options.log(`t3-voice: voice session of device ${session.deviceId} stops: ${reason}.`);
    this.closeAfterGoodbye(session);
  }

  private closeAfterGoodbye(session: ActiveSession) {
    session.cancelEnd?.();
    session.cancelEnd = this.options.clock.schedule(GOODBYE_MS, () => {
      this.close(session.deviceId, session.id).catch(() => {});
    });
  }

  private say(session: ActiveSession, text: string) {
    session.engineSession.speak(text);
    this.options.announcements.heardSpeech(session.id);
  }

  /** The user is there, or just heard news: the silence starts again. */
  private markActivity(session: ActiveSession) {
    session.lastActivityAt = this.options.clock.now();
    session.idleWarnedAt = null;
  }

  private saveUsage(session: ActiveSession) {
    const now = this.options.clock.now();
    session.usageSavedAt = now;
    this.options.registry.saveUsage(usageOf(session, now));
  }

  private spentToday(): number {
    return this.spentOn(this.dayOf(this.options.clock.now()));
  }

  /** What the sessions of a day cost: the saved ones, and the open ones until now. */
  private spentOn(day: string): number {
    const now = this.options.clock.now();
    const open = [...this.byDevice.values()];
    const openIds = new Set(open.map((session) => session.id));
    let spent = 0;
    for (const record of this.options.registry.usageOn(day)) {
      if (!openIds.has(record.sessionId)) spent += record.estimatedCostUsd;
    }
    for (const session of open) {
      if (session.day === day) spent += usageOf(session, now).estimatedCostUsd;
    }
    return roundUsd(spent);
  }

  private dayOf(time: number): string {
    return dayIn(this.options.budgetTimeZone ?? serverTimeZone(), new Date(time));
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
      this.saveUsage(session);
      const { minutes, estimatedCostUsd } = usageOf(session, this.options.clock.now());
      const budget = this.options.limits.dailyBudgetUsd;
      const cost =
        session.engine.billing === "usd"
          ? ` (~$${estimatedCostUsd.toFixed(2)}; today ~$${this.spentToday().toFixed(2)} of the $${budget.toFixed(2)} budget)`
          : " on the plan's quota";
      this.options.log(
        `t3-voice: voice session of device ${session.deviceId} ${event.reason === "failed" ? "failed" : "ended"} after ${minutes.toFixed(1)} min${cost}.`,
      );
      return;
    }
    if (event.type === "speech") {
      // The assistant speaking alone, its own warnings included, does not show the user is
      // there. A muted phone sends no audio, so a user transcript means the user speaks.
      if (event.speaker === "user") {
        session.confirmations.heard(event.text);
        this.markActivity(session);
      } else {
        session.confirmations.assistantSpoke();
      }
      this.options.announcements.heardSpeech(session.id);
      return;
    }
    if (event.type === "tool_call") {
      this.markActivity(session);
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
      case "summarize_thread":
        return tasks.summarizeThread(args);
      case "get_recent_messages":
        return tasks.recentMessages(args);
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
        this.closeAfterGoodbye(session);
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
    const code = (args as { confirmation?: unknown } | null)?.confirmation;
    // The model may send the code as a number.
    if (typeof code !== "string" && typeof code !== "number") {
      return this.answer(session, tool, await call());
    }
    // A code before any question is made up: the model filled the optional field. The call
    // then runs as a first call, so a risky action still asks its question.
    if (!session.confirmations.hasAsked()) {
      this.options.log(
        `t3-voice: ${tool} confirmation ignored (no question was asked in this session).`,
      );
      return this.answer(session, tool, await call());
    }
    const taken = await session.confirmations.take(tool, code);
    if (taken.kind === "refused") {
      this.options.log(`t3-voice: ${tool} confirmation refused (${taken.why}).`);
      return taken.result;
    }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageOf(session: ActiveSession, now: number): UsageRecord {
  const minutes = (now - session.openedAt) / MINUTE_MS;
  const billing = session.engine.billing;
  return {
    sessionId: session.id,
    engine: session.engine.model,
    billing,
    day: session.day,
    startedAt: new Date(session.openedAt).toISOString(),
    minutes,
    estimatedCostUsd: billing === "usd" ? roundUsd(minutes * session.engine.usdPerMinute) : 0,
  };
}

/** To a millionth of a dollar: sums of floating-point prices must reach the budget exactly. */
function roundUsd(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
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
