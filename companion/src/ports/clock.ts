// Time for the core: tests replace it with a fake clock and never sleep.

export interface Clock {
  /** Current time in milliseconds (a wall clock, like Date.now). */
  now(): number;
  /** Runs `callback` once after `delayMs`; returns a function that cancels it. */
  schedule(delayMs: number, callback: () => void): () => void;
}
