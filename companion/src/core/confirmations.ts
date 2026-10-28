// Confirmations: a risky action runs only after the user said a clear "oui" to it.
//
// A tool that needs a yes does not act. It answers a question with a confirmation token,
// and the voice model reads the question to the user. The action runs only when the model
// calls the same tool again with that token, and only if the user's own words since the
// assistant started reading the question are a clear yes. The companion checks those words
// itself: the model's opinion of the answer does not count, and anything unclear is not a yes.
//
// A token works once, for one action, in one voice session, for 60 s. Each session has one
// question at most: a new question replaces the one before.

import type { Clock } from "../ports/clock.ts";
import { randomSecret } from "./secrets.ts";
import { keyOf } from "./spokenNames.ts";
import type { ToolOutcome } from "./voiceTasks.ts";

/** How long the user has to answer a question. */
export const CONFIRM_WINDOW_MS = 60_000;

/**
 * How long a confirmation waits for the user's first words: the transcript can arrive just
 * after the model's call.
 */
export const TRANSCRIPT_WAIT_MS = 1_500;

/**
 * The pause that ends an answer: the answer is judged once the user said nothing for this
 * long, so "oui… mais attends" is heard whole (decided by Thomas in #21).
 */
export const ANSWER_PAUSE_MS = 1_000;

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
  readBack: Record<string, unknown>;
  run(): Promise<ToolOutcome>;
}

export type Confirmed =
  | { kind: "confirmed"; run: () => Promise<ToolOutcome> }
  | { kind: "refused"; result: Record<string, unknown> };

interface Question {
  token: string;
  tool: string;
  askedAt: number;
  run: () => Promise<ToolOutcome>;
  /**
   * Whether the assistant started reading the question. The user's words count only from
   * then on: the transcript of the request itself can arrive after the question.
   */
  read: boolean;
  /** What the user said since, as the engine transcribed it. */
  heard: string;
  lastHeardAt: number | null;
}

/** The questions of one voice session. */
export class Confirmations {
  private readonly clock: Clock;
  private question: Question | null = null;
  /** Questions whose token was taken, while they wait for the end of the user's answer. */
  private readonly waiting = new Set<{ question: Question; wake: () => void }>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Replaces any earlier question, and answers what the voice model reads to the user. */
  ask(request: ConfirmRequest): Record<string, unknown> {
    const token = randomSecret(16);
    this.question = {
      token,
      tool: request.tool,
      askedAt: this.clock.now(),
      run: request.run,
      read: false,
      heard: "",
      lastHeardAt: null,
    };
    return { needs_confirmation: true, read_back: request.readBack, confirmation: token };
  }

  /** The assistant speaks: after a question, the user's next words are the answer. */
  assistantSpoke(): void {
    if (this.question !== null) this.question.read = true;
  }

  /**
   * A piece of the user's words, as the engine transcribed it. Pieces carry their own
   * spaces. Kept in memory, never logged.
   */
  heard(text: string): void {
    const questions = [this.question, ...[...this.waiting].map((waiter) => waiter.question)];
    for (const question of questions) {
      if (question === null || !question.read) continue;
      question.heard += text;
      question.lastHeardAt = this.clock.now();
    }
    for (const waiter of this.waiting) waiter.wake();
  }

  /** Uses the token up. The action may run only when this answers "confirmed". */
  async take(tool: string, token: string): Promise<Confirmed> {
    const question = this.question;
    if (question === null || question.token !== token || question.tool !== tool) {
      return { kind: "refused", result: { error: "invalid_confirmation" } };
    }
    this.question = null;
    if (this.clock.now() - question.askedAt > CONFIRM_WINDOW_MS) {
      return { kind: "refused", result: { error: "confirmation_expired" } };
    }
    await this.waitForAnswer(question);
    if (!isClearYes(question.heard)) {
      return { kind: "refused", result: { error: "not_confirmed" } };
    }
    return { kind: "confirmed", run: question.run };
  }

  /** Waits until the user paused ANSWER_PAUSE_MS, or said nothing for TRANSCRIPT_WAIT_MS. */
  private async waitForAnswer(question: Question): Promise<void> {
    if (question.lastHeardAt === null) await this.waitForWords(question, TRANSCRIPT_WAIT_MS);
    while (question.lastHeardAt !== null) {
      const quietFor = this.clock.now() - question.lastHeardAt;
      if (quietFor >= ANSWER_PAUSE_MS) return;
      await this.waitForWords(question, ANSWER_PAUSE_MS - quietFor);
    }
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
