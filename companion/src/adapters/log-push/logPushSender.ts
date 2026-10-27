// PushSender adapter that only writes a log line, until the ntfy adapter exists (#25).
// The spoken name comes from the user's prompt, so the line leaves it out.

import type { PushNotification, PushSender } from "../../ports/pushSender.ts";

export class LogPushSender implements PushSender {
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.log = log;
  }

  async send(notification: PushNotification): Promise<void> {
    this.log(
      `t3-voice: no voice session is open; would notify that thread ${notification.threadId} is ${notification.state}.`,
    );
  }
}
