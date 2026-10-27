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
import { activityOf } from "./activity.ts";
import { randomSecret, scrubSecrets } from "./secrets.ts";
import type { ShellState } from "./shellState.ts";
import { VOICE_TOOLS, voiceInstructions } from "./voiceConversation.ts";

export interface VoiceSessionManagerOptions {
  /** Null when no engine is configured (no OpenAI key): every open answers "unavailable". */
  engine: VoiceEngine | null;
  /** The current T3 state, or null while the companion is not connected to T3. */
  shell(): ShellState | null;
  clock: Clock;
  /** Operational lines only: never audio, transcripts, prompts or tool results. */
  log(line: string): void;
}

interface OpenSession {
  id: string;
  deviceId: string;
  engineSession: VoiceSession;
  /** IANA time zone of the device. */
  timeZone: string;
  /** Clock time when the engine answered. */
  openedAt: number;
  /** Cancels the close end_session scheduled, if any. */
  cancelEnd?: () => void;
}

/** Time the model gets to say goodbye after end_session, before the session closes. */
const GOODBYE_MS = 5_000;

export class VoiceSessionManager implements VoiceSessions {
  private readonly options: VoiceSessionManagerOptions;
  /** The open session of each device, by device id. */
  private readonly byDevice = new Map<string, OpenSession>();
  /** Per device, the open or close in progress: they run one at a time. */
  private readonly queues = new Map<string, Promise<unknown>>();

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

  /** Ends every open session: `serve` calls it before it stops. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.byDevice.values()].map((session) =>
        this.close(session.deviceId, session.id).catch(() => {}),
      ),
    );
  }

  private async openNow(deviceId: string, request: OpenSessionRequest): Promise<OpenSessionResult> {
    const engine = this.options.engine;
    if (engine === null) return { status: "unavailable" };
    // One session per device: a new start (after an app crash, say) replaces the old one,
    // which would otherwise keep costing until it ends on its own.
    const previous = this.byDevice.get(deviceId);
    if (previous !== undefined) await this.end(previous);

    const timeZone =
      request.timeZone !== null && isTimeZone(request.timeZone)
        ? request.timeZone
        : serverTimeZone();
    // Events can only arrive once the engine answered, so `session` is set by then.
    let session: OpenSession | null = null;
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
    session = {
      id: randomSecret(16),
      deviceId,
      engineSession,
      timeZone,
      openedAt: this.options.clock.now(),
    };
    this.byDevice.set(deviceId, session);
    this.options.log(`t3-voice: voice session opened for device ${deviceId}.`);
    return { status: "opened", sessionId: session.id, sdpAnswer: engineSession.sdpAnswer };
  }

  private async end(session: OpenSession) {
    session.cancelEnd?.();
    if (this.byDevice.get(session.deviceId) === session) this.byDevice.delete(session.deviceId);
    await session.engineSession.close();
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

  private onEvent(session: OpenSession, event: VoiceEvent) {
    if (event.type === "closed") {
      session.cancelEnd?.();
      if (this.byDevice.get(session.deviceId) === session) this.byDevice.delete(session.deviceId);
      const minutes = (this.options.clock.now() - session.openedAt) / 60_000;
      this.options.log(
        `t3-voice: voice session of device ${session.deviceId} ${event.reason === "failed" ? "failed" : "ended"} after ${minutes.toFixed(1)} min.`,
      );
      return;
    }
    if (event.type === "tool_call") {
      session.engineSession.resolveToolCall(
        event.callId,
        this.runTool(session, event.name, event.arguments),
      );
    }
  }

  private runTool(session: OpenSession, name: string, args: unknown): unknown {
    const shell = this.options.shell();
    switch (name) {
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

  private activity(session: OpenSession, shell: ShellState, args: unknown): unknown {
    const now = new Date(this.options.clock.now());
    const activity = activityOf(shell, now);
    const scope = (args as { scope?: unknown } | null)?.scope;
    switch (scope) {
      case "running":
        return { tasks: activity.running.map(spokenTask) };
      case "finished":
        return { tasks: activity.finished.map(spokenTask) };
      case "today": {
        const today = dayIn(session.timeZone, now);
        const tasks = activity.finished.filter(
          (item) => dayIn(session.timeZone, new Date(item.updatedAt)) === today,
        );
        return { tasks: tasks.map(spokenTask) };
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
