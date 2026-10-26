// The HTTP API as `t3-voice serve` starts it.

export interface ApiServerOptions {
  host: string;
  port: number;
  /** Header a local proxy sets to the caller's IP, e.g. "cf-connecting-ip". */
  clientIpHeader?: string;
  /** What GET /activity answers, or null while the companion is not connected to T3. */
  activity(): Activity | null;
}

export interface RunningApiServer {
  url: string;
  close(): Promise<void>;
}

/** The small task list the app shows. */
export interface Activity {
  running: ActivityItem[];
  finished: ActivityItem[];
}

export interface ActivityItem {
  threadId: string;
  title: string;
  /** The project's title, or null when T3 did not send the project. */
  project: string | null;
  state: "running" | "waiting_for_input" | "waiting_for_approval" | "completed" | "failed";
  /** ISO date of the thread's last change. */
  updatedAt: string;
}
