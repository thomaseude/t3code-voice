// The announcement queue: each open voice session keeps the announcements it has not spoken
// yet, in order, and speaks them at the next gap in the conversation. With no session open,
// or when a session ends before it could speak them, they are pushed instead.

import type { Clock } from "../ports/clock.ts";
import type { PushSender } from "../ports/pushSender.ts";
import type { TaskRegistry } from "../ports/taskRegistry.ts";
import { type Announcement, spokenAnnouncement } from "./announcementText.ts";
import { eventKeyOf } from "./awareness.ts";
import { errorKind } from "./secrets.ts";
import type { ShellState } from "./shellState.ts";

export interface AnnouncementQueueOptions {
  registry: TaskRegistry;
  /** The current T3 state, or null while the companion is not connected to T3. */
  shell(): ShellState | null;
  push: PushSender;
  clock: Clock;
  /** Operational lines only: never a spoken name, a summary or a title. */
  log(line: string): void;
}

/** What the queue needs from a voice session. */
export interface SpeakingSession {
  speak(text: string): void;
  /** IANA time zone of the device, for the times an announcement says. */
  timeZone: string;
}

interface QueuedSession extends SpeakingSession {
  items: Announcement[];
  /** Clock time of the last sign that someone spoke. */
  lastSpeechAt: number;
  /** Tool calls the model still waits for: it speaks their result next. */
  pendingToolCalls: number;
  /** A confirmation question is open: an announcement would blur its answer. */
  questionOpen: boolean;
  cancelFlush: () => void;
}

/**
 * How long nobody must have spoken before an announcement is said. The engine sends no
 * "done speaking" event, so a silence is the absence of transcript for this long.
 */
const QUIET_MS = 2_000;

export class AnnouncementQueue {
  private readonly options: AnnouncementQueueOptions;
  private readonly sessions = new Map<string, QueuedSession>();
  /** Announcements being pushed, as "thread|event key". */
  private readonly pushing = new Set<string>();

  constructor(options: AnnouncementQueueOptions) {
    this.options = options;
  }

  openSession(id: string, session: SpeakingSession): void {
    this.sessions.set(id, {
      ...session,
      items: [],
      lastSpeechAt: Number.NEGATIVE_INFINITY,
      pendingToolCalls: 0,
      questionOpen: false,
      cancelFlush: () => {},
    });
  }

  /** The session ended: what it could not speak is pushed, unless another session holds it. */
  closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.cancelFlush();
    this.sessions.delete(id);
    for (const item of session.items) {
      if (!this.heldBySession(item) && this.stillToTell(item)) this.pushNow(item);
    }
  }

  /** Someone spoke in the session: announcements wait for the next gap. */
  heardSpeech(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.lastSpeechAt = this.options.clock.now();
    this.flush(session);
  }

  toolCallStarted(id: string): void {
    const session = this.sessions.get(id);
    if (session !== undefined) session.pendingToolCalls++;
  }

  /** The model got its result and reads it back now: that counts as speech. */
  toolCallEnded(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.pendingToolCalls = Math.max(0, session.pendingToolCalls - 1);
    this.heardSpeech(id);
  }

  /** Holds announcements while a confirmation question is open. */
  questionOpen(id: string, open: boolean): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.questionOpen = open;
    this.flush(session);
  }

  /**
   * Whether the session is at a gap: nobody spoke for 2 s, no tool result is awaited and no
   * confirmation question is open.
   */
  isQuiet(id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    return (
      session.pendingToolCalls === 0 &&
      !session.questionOpen &&
      this.options.clock.now() - session.lastSpeechAt >= QUIET_MS
    );
  }

  /** Whether the announcement already waits in a session or is being pushed. */
  isPending(threadId: string, eventKey: string): boolean {
    return (
      this.pushing.has(`${threadId}|${eventKey}`) || this.heldBySession({ threadId, eventKey })
    );
  }

  announce(announcement: Announcement): void {
    if (this.isPending(announcement.threadId, announcement.eventKey)) return;
    if (!this.stillToTell(announcement)) return;
    if (this.sessions.size === 0) {
      this.pushNow(announcement);
      return;
    }
    for (const session of this.sessions.values()) {
      session.items.push(announcement);
      this.flush(session);
    }
  }

  /** Speaks every waiting announcement now if the session is quiet, or later when it is. */
  private flush(session: QueuedSession) {
    session.cancelFlush();
    session.cancelFlush = () => {};
    if (session.items.length === 0 || session.pendingToolCalls > 0 || session.questionOpen) {
      return;
    }
    const now = this.options.clock.now();
    const wait = session.lastSpeechAt + QUIET_MS - now;
    if (wait > 0) {
      session.cancelFlush = this.options.clock.schedule(wait, () => this.flush(session));
      return;
    }
    // Another session may have spoken one meanwhile: each event is told once.
    const items = session.items.splice(0).filter((item) => this.stillToTell(item));
    if (items.length === 0) return;
    const nowDate = new Date(now);
    session.speak(
      items.map((item) => spokenAnnouncement(item, session.timeZone, nowDate)).join(" "),
    );
    session.lastSpeechAt = now;
    for (const item of items) this.recordTold(item);
  }

  private pushNow(item: Announcement) {
    const key = `${item.threadId}|${item.eventKey}`;
    this.pushing.add(key);
    this.options.push
      .send({
        threadId: item.threadId,
        spokenName: item.spokenName,
        project: item.project,
        state: item.state,
      })
      .catch((error) => {
        // Not tried again: a channel that keeps failing must not resend on every T3 event.
        this.options.log(
          `t3-voice: could not push the news of thread ${item.threadId} (${errorKind(error)}).`,
        );
      })
      .finally(() => {
        this.recordTold(item);
        this.pushing.delete(key);
      });
  }

  private heldBySession(item: Pick<Announcement, "threadId" | "eventKey">): boolean {
    return [...this.sessions.values()].some((session) =>
      session.items.some(
        (other) => other.threadId === item.threadId && other.eventKey === item.eventKey,
      ),
    );
  }

  /**
   * Still followed, not told yet, and still true: a completion whose run went on, or a
   * question answered in the T3 app meanwhile, is no longer news.
   */
  private stillToTell(item: Announcement): boolean {
    const task = this.options.registry
      .followedTasks()
      .find((each) => each.threadId === item.threadId);
    if (task === undefined || task.lastEventKey === item.eventKey) return false;
    const shell = this.options.shell();
    // While T3 is away, nothing shows that the news is old, so it is still told.
    if (shell === null) return true;
    const thread = shell.threads.get(item.threadId);
    return thread !== undefined && eventKeyOf(thread) === item.eventKey;
  }

  private recordTold(item: Announcement) {
    this.options.registry.markAnnounced(item.threadId, item.state, item.eventKey);
  }
}
