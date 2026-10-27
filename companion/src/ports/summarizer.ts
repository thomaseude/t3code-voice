// The summarizer: a cheap text model that tells, in spoken French, what an agent did. It
// never decides a status: the status always comes from T3.

export interface SummaryRequest {
  /** What the user asked the agent for, or null when the thread does not say. */
  request: string | null;
  /** What the agent answered at the end of its run. It may hold code and file paths. */
  output: string;
  /** How T3 says the run ended. */
  outcome: "completed" | "failed";
}

export interface TaskSummary {
  /** 2 or 3 spoken French sentences, for the announcement. */
  short: string;
  /** A longer spoken French version, for get_task_details. */
  long: string;
}

export interface Summarizer {
  /** Throws when the model cannot be reached or answers something unusable. */
  summarize(request: SummaryRequest): Promise<TaskSummary>;
}
