// TaskRegistry adapter: a SQLite file next to the config (`tasks.sqlite`), through Node's
// built-in `node:sqlite` driver.
//
// Like the config files, the database is private: mode 600 in a directory of mode 700. A
// file or directory that other users can open is refused.

import { chmodSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigError } from "../../ports/configStore.ts";
import type { TaskSummary } from "../../ports/summarizer.ts";
import type { FollowedTask, TaskRegistry, UsageRecord } from "../../ports/taskRegistry.ts";

export const TASK_REGISTRY_FILE = "tasks.sqlite";

/** Each step brings the schema from the version before it (`PRAGMA user_version`) to its own. */
const MIGRATIONS = [
  `CREATE TABLE followed_tasks (
     thread_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     spoken_name TEXT NOT NULL UNIQUE,
     origin TEXT NOT NULL CHECK (origin IN ('voice', 'followed')),
     last_announced_state TEXT,
     last_event_key TEXT,
     cursor INTEGER,
     followed_at TEXT NOT NULL
   )`,
  `CREATE TABLE task_summaries (
     thread_id TEXT NOT NULL,
     event_key TEXT NOT NULL,
     short TEXT NOT NULL,
     long TEXT NOT NULL,
     PRIMARY KEY (thread_id, event_key)
   )`,
  `CREATE TABLE usage_records (
     session_id TEXT PRIMARY KEY,
     engine TEXT NOT NULL,
     day TEXT NOT NULL,
     started_at TEXT NOT NULL,
     minutes REAL NOT NULL,
     estimated_cost_usd REAL NOT NULL
   );
   CREATE INDEX usage_records_by_day ON usage_records (day)`,
];

interface Row {
  thread_id: string;
  project_id: string;
  spoken_name: string;
  origin: "voice" | "followed";
  last_announced_state: string | null;
  last_event_key: string | null;
  cursor: number | null;
  followed_at: string;
}

interface UsageRow {
  session_id: string;
  engine: string;
  day: string;
  started_at: string;
  minutes: number;
  estimated_cost_usd: number;
}

export class SqliteTaskRegistry implements TaskRegistry {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens the database at `path`, creating it (mode 600) when it does not exist. */
  static open(path: string): SqliteTaskRegistry {
    assertPrivate(dirname(path), "directory");
    if (modeOf(path) === null) {
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
    }
    assertPrivate(path, "file");
    const db = new DatabaseSync(path);
    migrate(db);
    return new SqliteTaskRegistry(db);
  }

  followedTasks(): FollowedTask[] {
    const rows = this.db
      .prepare("SELECT * FROM followed_tasks ORDER BY followed_at, rowid")
      .all() as unknown as Row[];
    return rows.map((row) => ({
      threadId: row.thread_id,
      projectId: row.project_id,
      spokenName: row.spoken_name,
      origin: row.origin,
      lastAnnouncedState: row.last_announced_state,
      lastEventKey: row.last_event_key,
      cursor: row.cursor,
      followedAt: row.followed_at,
    }));
  }

  follow(task: FollowedTask): void {
    this.db
      .prepare(
        `INSERT INTO followed_tasks (thread_id, project_id, spoken_name, origin,
           last_announced_state, last_event_key, cursor, followed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.threadId,
        task.projectId,
        task.spokenName,
        task.origin,
        task.lastAnnouncedState,
        task.lastEventKey,
        task.cursor,
        task.followedAt,
      );
  }

  unfollow(threadId: string): boolean {
    this.db.prepare("DELETE FROM task_summaries WHERE thread_id = ?").run(threadId);
    const result = this.db.prepare("DELETE FROM followed_tasks WHERE thread_id = ?").run(threadId);
    return Number(result.changes) > 0;
  }

  markAnnounced(threadId: string, state: string, eventKey: string): void {
    this.db
      .prepare(
        "UPDATE followed_tasks SET last_announced_state = ?, last_event_key = ? WHERE thread_id = ?",
      )
      .run(state, eventKey, threadId);
  }

  saveSummary(threadId: string, eventKey: string, summary: TaskSummary): void {
    this.db
      .prepare(
        `INSERT INTO task_summaries (thread_id, event_key, short, long) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id, event_key) DO UPDATE
         SET short = excluded.short, long = excluded.long`,
      )
      .run(threadId, eventKey, summary.short, summary.long);
  }

  summaryOf(threadId: string, eventKey: string): TaskSummary | null {
    const row = this.db
      .prepare("SELECT short, long FROM task_summaries WHERE thread_id = ? AND event_key = ?")
      .get(threadId, eventKey) as { short: string; long: string } | undefined;
    return row === undefined ? null : { short: row.short, long: row.long };
  }

  saveUsage(record: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage_records (session_id, engine, day, started_at, minutes, estimated_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE
         SET minutes = excluded.minutes, estimated_cost_usd = excluded.estimated_cost_usd`,
      )
      .run(
        record.sessionId,
        record.engine,
        record.day,
        record.startedAt,
        record.minutes,
        record.estimatedCostUsd,
      );
  }

  usageOn(day: string): UsageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM usage_records WHERE day = ? ORDER BY started_at, rowid")
      .all(day) as unknown as UsageRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      engine: row.engine,
      day: row.day,
      startedAt: row.started_at,
      minutes: row.minutes,
      estimatedCostUsd: row.estimated_cost_usd,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function migrate(db: DatabaseSync) {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (const [index, statement] of MIGRATIONS.entries()) {
    if (index < version) continue;
    db.exec("BEGIN");
    db.exec(statement);
    db.exec(`PRAGMA user_version = ${index + 1}`);
    db.exec("COMMIT");
  }
}

function assertPrivate(path: string, kind: "file" | "directory") {
  const mode = modeOf(path);
  if (mode === null) throw new ConfigError(`${path} does not exist.`);
  if ((mode & 0o077) !== 0) {
    const fix = kind === "file" ? "chmod 600" : "chmod 700";
    throw new ConfigError(`${path} can be opened by other users; run "${fix} ${path}".`);
  }
}

function modeOf(path: string): number | null {
  try {
    return statSync(path).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
