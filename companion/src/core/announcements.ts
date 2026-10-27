// Watches the followed tasks in T3's state and announces their news: a run that completed,
// a run that failed, a question or a permission request that waits for the user.
//
// A completion is announced only once it stayed so for 5 s: a run can end moments before
// its continuation starts (T3's own relay waits the same). Each event has a key made of T3's
// ids, kept in the registry once told, so a reconnect or a restart never tells it again.

import type { Clock } from "../ports/clock.ts";
import type { Thread } from "../ports/t3Backend.ts";
import type { FollowedTask, TaskRegistry } from "../ports/taskRegistry.ts";
import type { AnnouncementQueue } from "./announcementQueue.ts";
import type { Announcement } from "./announcementText.ts";
import { awarenessOf, eventKeyOf } from "./awareness.ts";
import { errorKind } from "./secrets.ts";
import type { ShellState } from "./shellState.ts";
import type { TaskSummaries } from "./taskSummaries.ts";

export interface TaskWatcherOptions {
  registry: TaskRegistry;
  /** The current T3 state, or null while the companion is not connected to T3. */
  shell(): ShellState | null;
  summaries: TaskSummaries;
  queue: AnnouncementQueue;
  clock: Clock;
  /** Operational lines only: never a spoken name, a summary or a title. */
  log(line: string): void;
}

/** How long a completion must last before it is announced. */
const SETTLE_MS = 5_000;

export class TaskWatcher {
  private readonly options: TaskWatcherOptions;
  /** Completions waiting out their 5 s, by thread id. */
  private readonly settling = new Map<string, { eventKey: string; cancel: () => void }>();
  /** Announcements being prepared (their summary is being made), by thread id. */
  private readonly preparing = new Map<string, string>();

  constructor(options: TaskWatcherOptions) {
    this.options = options;
  }

  /** Looks at every followed task. Call it after each change of T3's state. */
  check(): void {
    const shell = this.options.shell();
    if (shell === null) return;
    const tasks = this.options.registry.followedTasks();
    for (const [threadId, settling] of this.settling) {
      if (!tasks.some((task) => task.threadId === threadId)) {
        settling.cancel();
        this.settling.delete(threadId);
      }
    }
    for (const task of tasks) {
      const thread = shell.threads.get(task.threadId);
      if (thread !== undefined) this.checkTask(task, thread);
    }
  }

  /** Cancels the completions still settling: the companion is stopping. */
  stop(): void {
    for (const settling of this.settling.values()) settling.cancel();
    this.settling.clear();
  }

  private checkTask(task: FollowedTask, thread: Thread) {
    const eventKey = eventKeyOf(thread);
    const settling = this.settling.get(task.threadId);
    if (settling !== undefined && settling.eventKey !== eventKey) {
      // The run went on, or something else happened: that completion was not the end.
      settling.cancel();
      this.settling.delete(task.threadId);
    }
    if (
      eventKey === null ||
      eventKey === task.lastEventKey ||
      this.settling.has(task.threadId) ||
      this.preparing.get(task.threadId) === eventKey ||
      this.options.queue.isPending(task.threadId, eventKey)
    ) {
      return;
    }
    if (awarenessOf(thread) === "completed") {
      const cancel = this.options.clock.schedule(SETTLE_MS, () => {
        this.settling.delete(task.threadId);
        this.settled(task.threadId, eventKey);
      });
      this.settling.set(task.threadId, { eventKey, cancel });
      return;
    }
    this.prepare(task, thread, eventKey);
  }

  /** The 5 s are over: announces the completion if it is still the thread's current state. */
  private settled(threadId: string, eventKey: string) {
    // While T3 is away, the next snapshot runs check() and settles the completion again.
    const thread = this.options.shell()?.threads.get(threadId);
    const task = this.followed(threadId);
    if (thread === undefined || task === undefined || eventKeyOf(thread) !== eventKey) return;
    this.prepare(task, thread, eventKey);
  }

  private prepare(task: FollowedTask, thread: Thread, eventKey: string) {
    this.preparing.set(task.threadId, eventKey);
    this.announcementOf(task, thread, eventKey)
      .then((announcement) => {
        // Unfollowed while its summary was being made: there is no one to tell.
        if (this.followed(task.threadId) !== undefined) this.options.queue.announce(announcement);
      })
      .catch((error) => {
        this.options.log(
          `t3-voice: could not announce thread ${task.threadId} (${errorKind(error)}).`,
        );
      })
      .finally(() => {
        if (this.preparing.get(task.threadId) === eventKey) this.preparing.delete(task.threadId);
      });
  }

  private async announcementOf(
    task: FollowedTask,
    thread: Thread,
    eventKey: string,
  ): Promise<Announcement> {
    const state = awarenessOf(thread) as Announcement["state"];
    // A failure is told at once, by its cause: get_task_details summarizes it when asked.
    const summary =
      state === "completed" ? await this.options.summaries.summaryOf(thread, eventKey) : null;
    return {
      threadId: task.threadId,
      eventKey,
      state,
      spokenName: task.spokenName,
      project: this.options.shell()?.projects.get(thread.projectId)?.title ?? null,
      summary: summary?.short ?? null,
      error: thread.lastError,
    };
  }

  private followed(threadId: string): FollowedTask | undefined {
    return this.options.registry.followedTasks().find((task) => task.threadId === threadId);
  }
}
