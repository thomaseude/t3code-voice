// The log-only push sender: until ntfy (#25), a notification is one log line.

import assert from "node:assert/strict";
import { test } from "node:test";
import { LogPushSender } from "../../../../src/adapters/log-push/logPushSender.ts";

test("logs the thread and its state, never the spoken name or the project", async () => {
  const lines: string[] = [];
  const sender = new LogPushSender((line) => lines.push(line));

  await sender.send({
    threadId: "t1",
    spokenName: "tests Reviews",
    project: "Joombo",
    state: "completed",
  });

  assert.deepEqual(lines, [
    "t3-voice: no voice session is open; would notify that thread t1 is completed.",
  ]);
});
