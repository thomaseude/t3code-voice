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

/** What one voice session cost. The daily budget adds up the records of a day. */
export interface UsageRecord {
  sessionId: string;
  /** The engine's model, e.g. "gpt-live-1". */
  engine: string;
  /** The calendar day the session started on, in the server's time zone: "2026-10-26". */
  day: string;
  /** ISO date. */
  startedAt: string;
  /** Minutes the session was open at the engine. */
  minutes: number;
  /** Minutes × the engine's price. Tokens of the model GPT-Live delegates to are not counted. */
  estimatedCostUsd: number;
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
  /** Keeps the summary of one event of the thread, until the thread is unfollowed. */
  saveSummary(threadId: string, eventKey: string, summary: TaskSummary): void;
  /** The summary saved for this event of the thread, or null. */
  summaryOf(threadId: string, eventKey: string): TaskSummary | null;
  /** Saves the usage of a session, replacing what was saved for it before. */
  saveUsage(record: UsageRecord): void;
  /** The usage records of the day ("2026-10-26"), the oldest first. */
  usageOn(day: string): UsageRecord[];
  close(): void;
}
