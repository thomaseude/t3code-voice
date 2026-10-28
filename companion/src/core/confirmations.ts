// Confirmations: a risky action runs only after the user said a clear "oui" to it.
//
// A tool that needs a yes does not act. It answers a question with a confirmation token,
// and the voice model reads the question to the user. The action runs only when the model
// calls the same tool again with that token, and only if the user's own words since the
// assistant started reading the question are a clear yes. The companion checks those words
// itself: the model's opinion of the answer does not count, and anything unclear is not a yes.
//
// A token works once, for one action, in one voice session, for 60 s. Each session has one
// question at most: a new question replaces the one before. While a question is open,
// announcements wait, so a "oui" only ever answers the question the user heard (decided by
// Thomas in #21). A question closes when its answer is judged (after the model sends the
// token back), when the user's words can no longer make a yes, when its 60 s run out, or
// when the session ends.

import type { Clock } from "../ports/clock.ts";
import { randomSecret } from "./secrets.ts";
import { keyOf } from "./spokenNames.ts";
import type { ToolOutcome, ToolResult } from "./voiceTasks.ts";

/** How long the user has to answer a question. */
export const CONFIRM_WINDOW_MS = 60_000;

/**
 * How long a confirmation waits for the user's first words: the transcript can arrive just
 * after the model's call.
 */
export const TRANSCRIPT_WAIT_MS = 1_500;

/**
 * How long the user must be quiet for their words to end: the answer is judged then, so
 * "oui… mais attends" is heard whole (decided by Thomas in #21). Words closer together
 * than this are one turn.
 */
export const ANSWER_QUIET_MS = 1_000;

/** Words that make an answer a yes. */
const YES_WORDS = new Set([
  "oui",
  "ouais",
  "ouaip",
  "ok",
  "okay",
  "accord",
  "vas",
  "confirme",
  "confirmer",
  "exactement",
  "absolument",
  "yes",
]);

/** Words that make an answer unclear, even with a yes in it: "oui mais attends". */
const DOUBT_WORDS = new Set([
  "non",
  "nan",
  "pas",
  "ne",
  "n",
  "mais",
  "attends",
  "attend",
  "attendez",
  "stop",
  "arrete",
  "annule",
  "annuler",
  "jamais",
  "plutot",
]);

/** What a tool answers instead of acting, and what it runs after the yes. */
export interface ConfirmRequest {
  tool: string;
  /** What the voice model reads to the user before asking. No ids, no secrets. */
  readBack: ToolResult;
  run(): Promise<ToolOutcome>;
}

export type Confirmed =
  | { kind: "confirmed"; run: () => Promise<ToolOutcome> }
  | { kind: "refused"; result: ToolResult };

interface Question {
  token: string;
  tool: string;
  run: () => Promise<ToolOutcome>;
  /**
   * When the assistant started reading the question. Only a turn of the user that starts
   * after it is the answer: the transcript of the request itself can come in later.
   */
  readAt: number | null;
  /** What the user said in those turns, as the engine transcribed it. */
  heard: string;
  lastSpeechAt: number | null;
  /** Whether the model sent the token back: it works once. */
  taken: boolean;
  /** Why the question ended, or null while it is still open. */
  ended: "judged" | "doubted" | "expired" | "replaced" | "session_closed" | null;
  /** Wakes the judging of the answer: the user spoke, or the question ended. */
  wake: () => void;
  stopTimer: () => void;
}

/** The question of one voice session. */
export class Confirmations {
  private readonly clock: Clock;
  /** `onQuestionOpen` hears when announcements must wait for a question, and when no more. */
  private readonly onQuestionOpen: (open: boolean) => void;
  private question: Question | null = null;
  /** When the user's current turn started, and their last word. */
  private userTurnStartedAt = Number.NEGATIVE_INFINITY;
  private lastUserSpeechAt = Number.NEGATIVE_INFINITY;
  private sessionClosed = false;

  constructor(clock: Clock, onQuestionOpen: (open: boolean) => void) {
    this.clock = clock;
    this.onQuestionOpen = onQuestionOpen;
  }

  /** Replaces any earlier question, and answers what the voice model reads to the user. */
  ask(request: ConfirmRequest): ToolResult {
    if (this.sessionClosed) return { error: "session_closed" };
    const before = this.question;
    const token = randomSecret(16);
    const question: Question = {
      token,
      tool: request.tool,
      run: request.run,
      readAt: null,
      heard: "",
      lastSpeechAt: null,
      taken: false,
      ended: null,
      wake: () => {},
      stopTimer: () => {},
    };
    question.stopTimer = this.clock.schedule(CONFIRM_WINDOW_MS, () =>
      this.end(question, "expired"),
    );
    this.question = question;
    if (before !== null) this.end(before, "replaced");
    this.onQuestionOpen(true);
    return { needs_confirmation: true, read_back: request.readBack, confirmation: token };
  }

  /** The assistant speaks: after a question, the user's next turn is the answer. */
  assistantSpoke(): void {
    const question = this.question;
    if (question !== null && question.ended === null && question.readAt === null) {
      question.readAt = this.clock.now();
    }
  }

  /**
   * A piece of the user's words, as the engine transcribed it. Pieces carry their own
   * spaces. Kept in memory, never logged.
   */
  heard(text: string): void {
    const now = this.clock.now();
    if (now - this.lastUserSpeechAt >= ANSWER_QUIET_MS) this.userTurnStartedAt = now;
    this.lastUserSpeechAt = now;
    const question = this.question;
    if (question === null || question.ended !== null || question.readAt === null) return;
    if (this.userTurnStartedAt < question.readAt) return;
    question.heard += text;
    question.lastSpeechAt = now;
    // "non", "attends"…: whatever comes next, the answer is no longer a yes.
    if (hasDoubt(question.heard)) this.end(question, "doubted");
    else question.wake();
  }

  /** The session ended: no question stays open, and no action runs any more. */
  close(): void {
    this.sessionClosed = true;
    if (this.question !== null) this.end(this.question, "session_closed");
  }

  /** Uses the token up. The action may run only when this answers "confirmed". */
  async take(tool: string, token: string): Promise<Confirmed> {
    const question = this.question;
    if (question === null || question.taken || question.token !== token || question.tool !== tool) {
      return { kind: "refused", result: { error: "invalid_confirmation" } };
    }
    question.taken = true;
    await this.answerEnded(question);
    const ended = question.ended;
    this.end(question, "judged");
    if (ended === "expired") return { kind: "refused", result: { error: "confirmation_expired" } };
    if (ended !== null || !isClearYes(question.heard)) {
      return { kind: "refused", result: { error: "not_confirmed" } };
    }
    return { kind: "confirmed", run: question.run };
  }

  /**
   * Waits until the user was quiet ANSWER_QUIET_MS, or said nothing for TRANSCRIPT_WAIT_MS,
   * or the question ended.
   */
  private async answerEnded(question: Question): Promise<void> {
    if (question.ended === null && question.lastSpeechAt === null) {
      await this.sleep(question, TRANSCRIPT_WAIT_MS);
    }
    while (question.ended === null && question.lastSpeechAt !== null) {
      const quietFor = this.clock.now() - question.lastSpeechAt;
      if (quietFor >= ANSWER_QUIET_MS) return;
      await this.sleep(question, ANSWER_QUIET_MS - quietFor);
    }
  }

  /** Waits `ms`, or less if the question is woken. */
  private sleep(question: Question, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        cancel();
        question.wake = () => {};
        resolve();
      };
      const cancel = this.clock.schedule(ms, done);
      question.wake = done;
    });
  }

  /** Ends the question once: its timer stops, its judging wakes, announcements may go on. */
  private end(question: Question, reason: NonNullable<Question["ended"]>): void {
    if (question.ended !== null) return;
    question.ended = reason;
    question.stopTimer();
    question.wake();
    if (this.question === question) this.onQuestionOpen(false);
  }
}

/** A yes word, with no doubt word. */
function isClearYes(heard: string): boolean {
  return !hasDoubt(heard) && wordsOf(heard).some((word) => YES_WORDS.has(word));
}

function hasDoubt(heard: string): boolean {
  return wordsOf(heard).some((word) => DOUBT_WORDS.has(word));
}

function wordsOf(heard: string): string[] {
  return keyOf(heard).split(" ").filter(Boolean);
}
