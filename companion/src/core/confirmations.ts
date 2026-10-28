// Confirmations: a risky action runs only after the user said a clear "oui" to it.
//
// A tool that needs a yes does not act. It answers a question with a confirmation token,
// and the voice model reads the question to the user. The action runs only when the model
// calls the same tool again with that token, and only if the user's own words since the
// assistant started reading the question are a clear yes. The companion checks those words
// itself: the model's opinion of the answer does not count, and anything unclear is not a yes.
//
// A token works once, for one action, in one voice session, for 60 s. Each session has one
// question at most: a new question replaces the one before. While a question waits for its
// answer, announcements wait too, so a "oui" only ever answers the question the user heard
// (decided by Thomas in #21).

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
  askedAt: number;
  run: () => Promise<ToolOutcome>;
  /**
   * When the assistant started reading the question. Only a turn of the user that starts
   * after it is the answer: the transcript of the request itself can come in later.
   */
  readAt: number | null;
  /** What the user said in those turns, as the engine transcribed it. */
  heard: string;
  lastSpeechAt: number | null;
}

/** The questions of one voice session. */
export class Confirmations {
  private readonly clock: Clock;
  private question: Question | null = null;
  /** Questions whose token was taken, while they wait for the end of the user's answer. */
  private readonly waiting = new Set<{ question: Question; wake: () => void }>();
  /** When the user's current turn started, and their last word. */
  private userTurnStartedAt = Number.NEGATIVE_INFINITY;
  private lastUserSpeechAt = Number.NEGATIVE_INFINITY;
  private closed = false;
  private readonly onOpenChange: (open: boolean) => void;
  private cancelExpiry = () => {};

  /** `onOpenChange` hears when a question starts and stops waiting for its answer. */
  constructor(clock: Clock, onOpenChange: (open: boolean) => void) {
    this.clock = clock;
    this.onOpenChange = onOpenChange;
  }

  /** Replaces any earlier question, and answers what the voice model reads to the user. */
  ask(request: ConfirmRequest): ToolResult {
    const token = randomSecret(16);
    this.question = {
      token,
      tool: request.tool,
      askedAt: this.clock.now(),
      run: request.run,
      readAt: null,
      heard: "",
      lastSpeechAt: null,
    };
    this.cancelExpiry();
    this.cancelExpiry = this.clock.schedule(CONFIRM_WINDOW_MS, () => this.stopWaiting());
    this.onOpenChange(true);
    return { needs_confirmation: true, read_back: request.readBack, confirmation: token };
  }

  /** The assistant speaks: after a question, the user's next turn is the answer. */
  assistantSpoke(): void {
    if (this.question !== null && this.question.readAt === null) {
      this.question.readAt = this.clock.now();
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
    const questions = [this.question, ...[...this.waiting].map((waiter) => waiter.question)];
    for (const question of questions) {
      if (question === null || question.readAt === null) continue;
      if (this.userTurnStartedAt < question.readAt) continue;
      question.heard += text;
      question.lastSpeechAt = now;
    }
    for (const waiter of this.waiting) waiter.wake();
  }

  /** The session ended: no action runs any more, even one whose answer is coming in. */
  close(): void {
    this.closed = true;
    this.question = null;
    this.stopWaiting();
    for (const waiter of this.waiting) waiter.wake();
  }

  /** Uses the token up. The action may run only when this answers "confirmed". */
  async take(tool: string, token: string): Promise<Confirmed> {
    const question = this.question;
    if (question === null || question.token !== token || question.tool !== tool) {
      return { kind: "refused", result: { error: "invalid_confirmation" } };
    }
    this.question = null;
    this.stopWaiting();
    const deadline = question.askedAt + CONFIRM_WINDOW_MS;
    if (this.clock.now() > deadline || !(await this.answerEnded(question, deadline))) {
      return { kind: "refused", result: { error: "confirmation_expired" } };
    }
    if (this.closed || !isClearYes(question.heard)) {
      return { kind: "refused", result: { error: "not_confirmed" } };
    }
    return { kind: "confirmed", run: question.run };
  }

  /** No question waits for an answer any more: it was taken, it expired, or the session ended. */
  private stopWaiting(): void {
    this.cancelExpiry();
    this.cancelExpiry = () => {};
    this.onOpenChange(false);
  }

  /**
   * Waits until the user was quiet ANSWER_QUIET_MS, or said nothing for TRANSCRIPT_WAIT_MS.
   * False when they still talk at the deadline.
   */
  private async answerEnded(question: Question, deadline: number): Promise<boolean> {
    if (question.lastSpeechAt === null) await this.waitForWords(question, TRANSCRIPT_WAIT_MS);
    while (question.lastSpeechAt !== null && !this.closed) {
      const now = this.clock.now();
      const quietFor = now - question.lastSpeechAt;
      if (quietFor >= ANSWER_QUIET_MS) return true;
      if (now >= deadline) return false;
      await this.waitForWords(question, Math.min(ANSWER_QUIET_MS - quietFor, deadline - now));
    }
    return true;
  }

  /** Waits until the user says something, or `ms` at most. */
  private waitForWords(question: Question, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter = {
        question,
        wake: () => {
          cancel();
          this.waiting.delete(waiter);
          resolve();
        },
      };
      const cancel = this.clock.schedule(ms, waiter.wake);
      this.waiting.add(waiter);
    });
  }
}

/** A yes word, with no doubt word. */
function isClearYes(heard: string): boolean {
  const words = keyOf(heard).split(" ").filter(Boolean);
  if (words.some((word) => DOUBT_WORDS.has(word))) return false;
  return words.some((word) => YES_WORDS.has(word));
}
