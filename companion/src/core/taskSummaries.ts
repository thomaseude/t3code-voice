// Summaries made by the summarizer. A finished run's summary, for its announcement, is made
// once and read from the registry after. A conversation's summary, for summarize_thread, is
// kept in memory until the thread changes. A summary only tells what the agent did: the
// status always comes from T3.

import type { Clock } from "../ports/clock.ts";
import type { ConversationSummaryRequest, Summarizer, TaskSummary } from "../ports/summarizer.ts";
import type { T3Backend, Thread, ThreadMessage } from "../ports/t3Backend.ts";
import type { TaskRegistry } from "../ports/taskRegistry.ts";
import type { ReadingStatus } from "./awareness.ts";
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

/** The most text of a conversation the summarizer reads, to keep the call quick and cheap. */
const MAX_CONVERSATION_CHARS = 16_000;

export interface ConversationSummary {
  /** Null when there is none: no summarizer, no message, or a failure. */
  summary: string | null;
  /** Some messages were left out: the whole conversation is better read in T3. */
  tooLong: boolean;
}

export class TaskSummaries {
  private readonly options: TaskSummariesOptions;
  /** Summaries being made, by "thread|event key": two asks share one call. */
  private readonly making = new Map<string, Promise<TaskSummary | null>>();
  /** The last conversation summary of each thread, with the key of what it summarized. */
  private readonly conversations = new Map<
    string,
    { key: string; summary: Promise<ConversationSummary> }
  >();

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

  /**
   * A summary of the thread's conversation so far, also while a run goes on. `status` is
   * T3's: the summary is made again when it changes, or when the last message does.
   */
  async conversationSummaryOf(thread: Thread, status: ReadingStatus): Promise<ConversationSummary> {
    const { summarizer } = this.options;
    if (summarizer === null) return { summary: null, tooLong: false };
    const { messages } = await this.options.backend.readThread(thread.id);
    const last = messages.at(-1);
    if (last === undefined) return { summary: null, tooLong: false };
    // The last message's id, and its length: a message the agent is still writing grows.
    const key = `${last.id}|${last.text.length}|${status}`;
    const kept = this.conversations.get(thread.id);
    if (kept?.key === key) return kept.summary;
    const { request, tooLong } = conversationRequest(messages, status);
    const summary = this.makeConversation(summarizer, thread, request, tooLong);
    this.conversations.set(thread.id, { key, summary });
    // A failure is not kept: asking again tries again.
    summary.then(({ summary: text }) => {
      if (text === null && this.conversations.get(thread.id)?.key === key) {
        this.conversations.delete(thread.id);
      }
    });
    return summary;
  }

  private async makeConversation(
    summarizer: Summarizer,
    thread: Thread,
    request: ConversationSummaryRequest,
    tooLong: boolean,
  ): Promise<ConversationSummary> {
    let summary: string | null;
    try {
      summary = await this.withTimeout(summarizer.summarizeConversation(request));
    } catch (error) {
      this.options.log(
        `t3-voice: could not summarize the conversation of thread ${thread.id} (${errorKind(error)}).`,
      );
      return { summary: null, tooLong };
    }
    if (summary === null) {
      this.options.log(`t3-voice: the conversation summary of thread ${thread.id} took too long.`);
    }
    return { summary, tooLong };
  }

  private async make(thread: Thread, eventKey: string): Promise<TaskSummary | null> {
    const { summarizer } = this.options;
    if (summarizer === null) return null;
    let summary: TaskSummary | null;
    try {
      const { messages } = await this.options.backend.readThread(thread.id);
      const { request, output } = lastRunOf(messages, thread.latestRunId);
      if (output === "") return null;
      summary = await this.withTimeout(
        summarizer.summarize({
          request,
          output: output.slice(-MAX_OUTPUT_CHARS),
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
  private withTimeout<T>(work: Promise<T>): Promise<T | null> {
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

/**
 * What the summarizer reads of a conversation: all of it when it fits in
 * MAX_CONVERSATION_CHARS. Else the first message, which is often the user's request, then as
 * many of the latest messages as fit, and `tooLong`. A newest message too long to fit keeps
 * its end, where the agent concludes.
 */
function conversationRequest(
  messages: ThreadMessage[],
  status: string,
): { request: ConversationSummaryRequest; tooLong: boolean } {
  const all = messages.map(({ role, text }) => ({ role, text }));
  const total = all.reduce((sum, message) => sum + message.text.length, 0);
  if (total <= MAX_CONVERSATION_CHARS) {
    return { request: { status, messages: all, omitted: 0 }, tooLong: false };
  }
  const [first, ...rest] = all;
  if (first === undefined) return { request: { status, messages: [], omitted: 0 }, tooLong: false };
  const head = { ...first, text: first.text.slice(0, MAX_CONVERSATION_CHARS / 4) };
  let room = MAX_CONVERSATION_CHARS - head.text.length;
  const latest: ConversationSummaryRequest["messages"] = [];
  for (const message of rest.reverse()) {
    if (room <= 0) break;
    // Only the newest message is cut to fit; an older one that does not fit is left out.
    if (message.text.length > room && latest.length > 0) break;
    const text = message.text.slice(-room);
    latest.unshift({ ...message, text });
    room -= text.length;
  }
  return {
    request: { status, messages: [head, ...latest], omitted: rest.length - latest.length },
    tooLong: true,
  };
}
