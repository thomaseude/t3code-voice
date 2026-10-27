// Notifications sent to the phone when no voice session can speak an announcement (ntfy
// today, APNs later). A notification shows on the Lock Screen: it carries ids, the task's
// spoken name, its project and its state, never code, prompts or transcripts.

export interface PushNotification {
  threadId: string;
  spokenName: string;
  project: string | null;
  state: "completed" | "failed" | "waiting_for_input" | "waiting_for_approval";
}

export interface PushSender {
  /** Throws when the notification could not be handed over. */
  send(notification: PushNotification): Promise<void>;
}
