// The tasks the user follows: the threads whose news the assistant speaks about, with the
// short French name the user calls them by. It survives restarts. T3 stays the only source
// of truth for their status: the registry never stores one as current.

import type { TaskSummary } from "./summarizer.ts";

export interface FollowedTask {
  threadId: string;
  projectId: string;
  /** 2 to 4 French words, unique among followed tasks. It never changes. */
  spokenName: string;
  /** "voice": started by voice; "followed": a thread the user chose to follow. */
  origin: "voice" | "followed";
  /** The last state an announcement spoke about, or null before the first one. */
  lastAnnouncedState: string | null;
  /** The key of the last event announced, so each event is spoken once. */
  lastEventKey: string | null;
  /** The shell sequence the announcements resume from, or null before the first one. */
  cursor: number | null;
  /** ISO date. */
  followedAt: string;
}

export interface TaskRegistry {
  /** Every followed task, the oldest first. */
  followedTasks(): FollowedTask[];
  /** Throws when the thread is already followed or the spoken name is taken. */
  follow(task: FollowedTask): void;
  /** False when the thread was not followed. */
  unfollow(threadId: string): boolean;
  /** Records the event just spoken or pushed, so it is never told twice. Nothing when unfollowed. */
  markAnnounced(threadId: string, state: string, eventKey: string): void;
  /** Keeps the summary of one event of the thread, in place of the one before. */
  saveSummary(threadId: string, eventKey: string, summary: TaskSummary): void;
  /** The thread's last saved summary, and the event it is about, or null. */
  summaryOf(threadId: string): (TaskSummary & { eventKey: string }) | null;
  close(): void;
}
