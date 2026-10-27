// Summaries of finished runs: made once by the summarizer from the thread's last messages,
// then read from the registry. A summary only tells what the agent did: the status always
// comes from T3.

import type { Clock } from "../ports/clock.ts";
import type { Summarizer, TaskSummary } from "../ports/summarizer.ts";
import type { T3Backend, Thread, ThreadMessage } from "../ports/t3Backend.ts";
import type { TaskRegistry } from "../ports/taskRegistry.ts";
import { errorKind } from "./secrets.ts";

export interface TaskSummariesOptions {
  backend: T3Backend;
  /** Null when no OpenAI key is set up: there are no summaries then. */
  summarizer: Summarizer | null;
  registry: TaskRegistry;
  clock: Clock;
  /** Operational lines only: never messages or summaries. */
  log(line: string): void;
}

/** How long a summary may take before the announcement goes without one. */
const SUMMARY_TIMEOUT_MS = 30_000;

/** The end of the agent's output the summarizer reads: its conclusion comes last. */
const MAX_OUTPUT_CHARS = 12_000;

export class TaskSummaries {
  private readonly options: TaskSummariesOptions;
  /** Summaries being made, by "thread|event key": two asks share one call. */
  private readonly making = new Map<string, Promise<TaskSummary | null>>();

  constructor(options: TaskSummariesOptions) {
    this.options = options;
  }

  /**
   * The summary of the finished run `eventKey` names, from the registry or made now.
   * Null when there is none: no summarizer, nothing the agent wrote, or a failure.
   */
  summaryOf(thread: Thread, eventKey: string): Promise<TaskSummary | null> {
    const saved = this.options.registry.summaryOf(thread.id, eventKey);
    if (saved !== null) return Promise.resolve(saved);
    const key = `${thread.id}|${eventKey}`;
    let making = this.making.get(key);
    if (making === undefined) {
      making = this.make(thread, eventKey).finally(() => this.making.delete(key));
      this.making.set(key, making);
    }
    return making;
  }

  private async make(thread: Thread, eventKey: string): Promise<TaskSummary | null> {
    const { summarizer } = this.options;
    if (summarizer === null) return null;
    let summary: TaskSummary | null;
    try {
      const messages = await this.options.backend.readThread(thread.id);
      const { request, output } = lastRunOf(messages, thread.latestRunId);
      if (output === "") return null;
      summary = await this.withTimeout(
        summarizer.summarize({
          request,
          output: output.slice(-MAX_OUTPUT_CHARS),
          outcome: eventKey.startsWith("failed:") ? "failed" : "completed",
        }),
      );
    } catch (error) {
      this.options.log(`t3-voice: could not summarize thread ${thread.id} (${errorKind(error)}).`);
      return null;
    }
    if (summary === null) {
      this.options.log(`t3-voice: the summary of thread ${thread.id} took too long.`);
      return null;
    }
    // The registry keeps summaries of followed tasks only.
    const followed = this.options.registry
      .followedTasks()
      .some((task) => task.threadId === thread.id);
    if (followed) this.options.registry.saveSummary(thread.id, eventKey, summary);
    return summary;
  }

  /** Null when `work` takes longer than SUMMARY_TIMEOUT_MS. */
  private withTimeout(work: Promise<TaskSummary>): Promise<TaskSummary | null> {
    return new Promise((resolve, reject) => {
      const cancel = this.options.clock.schedule(SUMMARY_TIMEOUT_MS, () => resolve(null));
      work.then(
        (summary) => {
          cancel();
          resolve(summary);
        },
        (error) => {
          cancel();
          reject(error);
        },
      );
    });
  }
}

/**
 * What the user asked in the run, and what the agent answered in it. Without a run id (an
 * older T3), the run is everything after the last user message.
 */
function lastRunOf(
  messages: ThreadMessage[],
  runId: string | null,
): { request: string | null; output: string } {
  let run: ThreadMessage[];
  if (runId !== null && messages.some((message) => message.runId === runId)) {
    run = messages.filter((message) => message.runId === runId);
  } else {
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    run = messages.slice(Math.max(lastUser, 0));
  }
  const request = run.find((message) => message.role === "user")?.text ?? null;
  const output = run
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n\n")
    .trim();
  return { request, output };
}
