// The SQLite task registry, on a real file in a temporary directory.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { SqliteTaskRegistry } from "../../../../src/adapters/task-registry/sqliteTaskRegistry.ts";
import { ConfigError } from "../../../../src/ports/configStore.ts";
import { followedTask } from "../../builders.ts";

async function privateDir() {
  const dir = join(await mkdtemp(join(tmpdir(), "t3voice-registry-")), "t3voice");
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

describe("SQLite task registry", () => {
  test("a followed task is still there after the registry is reopened", async () => {
    const path = join(await privateDir(), "tasks.sqlite");
    const first = SqliteTaskRegistry.open(path);
    first.follow(followedTask("t1", { spokenName: "tests Reviews", origin: "voice" }));
    first.follow(followedTask("t2", { spokenName: "page offre", cursor: 42, lastEventKey: "k" }));
    first.close();

    const second = SqliteTaskRegistry.open(path);

    assert.deepEqual(second.followedTasks(), [
      followedTask("t1", { spokenName: "tests Reviews", origin: "voice" }),
      followedTask("t2", { spokenName: "page offre", cursor: 42, lastEventKey: "k" }),
    ]);
    second.close();
  });

  test("unfollow removes the task, and says whether it was followed", async () => {
    const registry = SqliteTaskRegistry.open(join(await privateDir(), "tasks.sqlite"));
    registry.follow(followedTask("t1"));

    assert.equal(registry.unfollow("t1"), true);
    assert.equal(registry.unfollow("t1"), false);
    assert.deepEqual(registry.followedTasks(), []);
    registry.close();
  });

  test("a thread or a spoken name is never followed twice", async () => {
    const registry = SqliteTaskRegistry.open(join(await privateDir(), "tasks.sqlite"));
    registry.follow(followedTask("t1", { spokenName: "tests Reviews" }));

    assert.throws(() => registry.follow(followedTask("t1", { spokenName: "autre nom" })));
    assert.throws(() => registry.follow(followedTask("t2", { spokenName: "tests Reviews" })));
    registry.close();
  });

  test("an announced event is still known after the registry is reopened", async () => {
    const path = join(await privateDir(), "tasks.sqlite");
    const first = SqliteTaskRegistry.open(path);
    first.follow(followedTask("t1"));
    first.markAnnounced("t1", "completed", "completed:run-1");
    // A thread no longer followed is left alone.
    first.markAnnounced("t9", "failed", "failed:run-1");
    first.close();

    const second = SqliteTaskRegistry.open(path);

    assert.deepEqual(second.followedTasks(), [
      followedTask("t1", { lastAnnouncedState: "completed", lastEventKey: "completed:run-1" }),
    ]);
    second.close();
  });

  test("each event of a thread keeps its own summary, until the thread is unfollowed", async () => {
    const path = join(await privateDir(), "tasks.sqlite");
    const first = SqliteTaskRegistry.open(path);
    first.follow(followedTask("t1"));
    assert.equal(first.summaryOf("t1", "completed:run-1"), null);
    first.saveSummary("t1", "completed:run-1", { short: "Court 1." });
    first.saveSummary("t1", "completed:run-2", { short: "Court 2." });
    first.close();

    const second = SqliteTaskRegistry.open(path);
    assert.deepEqual(second.summaryOf("t1", "completed:run-1"), { short: "Court 1." });
    assert.deepEqual(second.summaryOf("t1", "completed:run-2"), { short: "Court 2." });
    second.unfollow("t1");
    assert.equal(second.summaryOf("t1", "completed:run-2"), null);
    second.close();
  });

  test("a database written before the long summary was dropped keeps its short summaries", async () => {
    const path = join(await privateDir(), "tasks.sqlite");
    SqliteTaskRegistry.open(path).close();
    // The schema as it was then: version 2, with a "long" column.
    const db = new DatabaseSync(path);
    db.exec(`DROP TABLE task_summaries;
      CREATE TABLE task_summaries (
        thread_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        short TEXT NOT NULL,
        long TEXT NOT NULL,
        PRIMARY KEY (thread_id, event_key)
      );
      INSERT INTO task_summaries VALUES ('t1', 'completed:run-1', 'Court.', 'Long.');
      PRAGMA user_version = 2;`);
    db.close();

    const registry = SqliteTaskRegistry.open(path);
    registry.follow(followedTask("t1"));
    assert.deepEqual(registry.summaryOf("t1", "completed:run-1"), { short: "Court." });
    registry.saveSummary("t1", "completed:run-2", { short: "Court 2." });
    assert.deepEqual(registry.summaryOf("t1", "completed:run-2"), { short: "Court 2." });
    registry.close();
  });

  test("the database file is created readable by its owner only", async () => {
    const path = join(await privateDir(), "tasks.sqlite");

    SqliteTaskRegistry.open(path).close();

    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  test("a database file other users can read is refused", async () => {
    const path = join(await privateDir(), "tasks.sqlite");
    await writeFile(path, "", { mode: 0o644 });
    await chmod(path, 0o644);

    assert.throws(() => SqliteTaskRegistry.open(path), ConfigError);
  });

  test("a directory other users can open is refused", async () => {
    const dir = await privateDir();
    await chmod(dir, 0o755);

    assert.throws(() => SqliteTaskRegistry.open(join(dir, "tasks.sqlite")), ConfigError);
  });
});
