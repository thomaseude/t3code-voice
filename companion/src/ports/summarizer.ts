// The summarizer: a cheap text model that tells, in spoken French, what an agent did. It
// never decides a status: the status always comes from T3.

import type { ThreadMessage } from "./t3Backend.ts";

export interface SummaryRequest {
  /** What the user asked the agent for, or null when the thread does not say. */
  request: string | null;
  /** What the agent answered at the end of its run. It may hold code and file paths. */
  output: string;
}

export interface TaskSummary {
  /** 2 or 3 spoken French sentences, for the announcement. */
  short: string;
}

/** A thread's conversation, for summarize_thread. */
export interface ConversationSummaryRequest {
  /**
   * T3's status of the thread ("running", "waiting_for_input", "queued", "completed", ...):
   * the summary never contradicts it.
   */
  status: string;
  /**
   * The messages, oldest first: the first one, then the latest ones. Tool calls and diffs
   * are not messages. The text may hold code and file paths.
   */
  messages: Array<Pick<ThreadMessage, "role" | "text">>;
  /** How many messages were left out between the first one and the latest ones. */
  omitted: number;
}

export interface Summarizer {
  /** Throws when the model cannot be reached or answers something unusable. */
  summarize(request: SummaryRequest): Promise<TaskSummary>;
  /** Spoken French sentences on the conversation so far. Throws like `summarize`. */
  summarizeConversation(request: ConversationSummaryRequest): Promise<string>;
}
