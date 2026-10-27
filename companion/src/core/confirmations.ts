// Confirmations: a risky action runs only after the user said a clear "oui" to it.
//
// A tool that needs a yes does not act. It answers a question with a confirmation token,
// and the voice model reads the question to the user. The action runs only when the model
// calls the same tool again with that token, and only if the user's own words since the
// question are a clear yes. The companion checks those words itself: the model's opinion
// of the answer does not count, and anything unclear is not a yes.
//
// A token works once, for one action, in one voice session, for 60 s. Each session has one
// question at most: a new question replaces the one before.

import type { Clock } from "../ports/clock.ts";
import { randomSecret } from "./secrets.ts";
import { keyOf } from "./spokenNames.ts";

/** How long the user has to answer a question. */
export const CONFIRM_WINDOW_MS = 60_000;

/**
 * How long a confirmation waits for the user's words when it has not heard a yes yet: the
 * transcript can arrive just after the model's call.
 */
export const TRANSCRIPT_WAIT_MS = 1_500;

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
export interface ConfirmRequest<T> {
  tool: string;
  /** What the voice model reads to the user before asking. No ids, no secrets. */
  readBack: Record<string, unknown>;
  run(): Promise<T>;
}

export type Confirmed<T> =
  | { kind: "confirmed"; run: () => Promise<T> }
  | { kind: "refused"; result: Record<string, unknown> };

interface Question<T> {
  token: string;
  tool: string;
  askedAt: number;
  run: () => Promise<T>;
  /** What the user said since the question, as the engine transcribed it. */
  heard: string;
}

/** The questions of one voice session. */
export class Confirmations<T> {
  private readonly clock: Clock;
  private question: Question<T> | null = null;
  /** A question whose token was taken, while it waits for the user's late words. */
  private waiting: { question: Question<T>; wake: () => void } | null = null;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Replaces any earlier question, and answers what the voice model reads to the user. */
  ask(request: ConfirmRequest<T>): Record<string, unknown> {
    const token = randomSecret(16);
    this.question = {
      token,
      tool: request.tool,
      askedAt: this.clock.now(),
      run: request.run,
      heard: "",
    };
    return { needs_confirmation: true, read_back: request.readBack, confirmation: token };
  }

  /** The user's words, as the engine transcribed them. Kept in memory, never logged. */
  heard(text: string): void {
    if (this.question !== null) this.question.heard += ` ${text}`;
    if (this.waiting !== null) {
      this.waiting.question.heard += ` ${text}`;
      this.waiting.wake();
    }
  }

  /** Uses the token up. The action may run only when this answers "confirmed". */
  async take(tool: string, token: string): Promise<Confirmed<T>> {
    const question = this.question;
    if (question === null || question.token !== token || question.tool !== tool) {
      return { kind: "refused", result: { error: "invalid_confirmation" } };
    }
    this.question = null;
    if (this.clock.now() - question.askedAt > CONFIRM_WINDOW_MS) {
      return { kind: "refused", result: { error: "confirmation_expired" } };
    }
    if (answerOf(question.heard) === "none") await this.waitForWords(question);
    if (answerOf(question.heard) !== "yes") {
      return { kind: "refused", result: { error: "not_confirmed" } };
    }
    return { kind: "confirmed", run: question.run };
  }

  /** Waits until the user says something, or TRANSCRIPT_WAIT_MS at most. */
  private waitForWords(question: Question<T>): Promise<void> {
    this.waiting?.wake();
    return new Promise((resolve) => {
      const wake = () => {
        cancel();
        if (this.waiting?.question === question) this.waiting = null;
        resolve();
      };
      const cancel = this.clock.schedule(TRANSCRIPT_WAIT_MS, wake);
      this.waiting = { question, wake };
    });
  }
}

/** "yes" only for a yes word with no doubt word; "none" when the user said nothing yet. */
function answerOf(heard: string): "yes" | "unclear" | "none" {
  const words = keyOf(heard).split(" ").filter(Boolean);
  if (words.length === 0) return "none";
  if (words.some((word) => DOUBT_WORDS.has(word))) return "unclear";
  return words.some((word) => YES_WORDS.has(word)) ? "yes" : "unclear";
}
