// The HTTP API as `t3-voice serve` starts it.

export interface ApiServerOptions {
  host: string;
  port: number;
  /** Header a local proxy sets to the caller's IP, e.g. "cf-connecting-ip". */
  clientIpHeader?: string;
  /** What GET /activity answers, or null while the companion is not connected to T3. */
  activity(): Activity | null;
  voiceSessions: VoiceSessions;
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

/** Voice sessions, as the HTTP API opens and ends them for a paired device. */
export interface VoiceSessions {
  /**
   * Opens a session for the device with its SDP offer. A session the device still has open
   * is closed first: a device has one session at most.
   */
  open(deviceId: string, request: OpenSessionRequest): Promise<OpenSessionResult>;
  /** Ends the device's session. False when the device has no session with this id. */
  close(deviceId: string, sessionId: string): Promise<boolean>;
  /** A signal from the app about its session. False when the device has no session with this id. */
  signal(deviceId: string, sessionId: string, signal: SessionSignal): boolean;
}

/** "mute": the app turned its microphone off (the user, the AirPods, or the AirPods removed). */
export type SessionSignal = "mute" | "unmute";

export interface OpenSessionRequest {
  /** The iPhone's WebRTC SDP offer. */
  sdpOffer: string;
  /** The device's IANA time zone ("Europe/Paris"), for "today"; null for the server's own. */
  timeZone: string | null;
}

export type OpenSessionResult =
  | { status: "opened"; sessionId: string; sdpAnswer: string }
  /** No voice engine is configured (no OpenAI key). */
  | { status: "unavailable" }
  /** The engine refused or could not be reached. */
  | { status: "failed" }
  /** Today's voice sessions already cost the daily budget. */
  | { status: "budget_reached" };
