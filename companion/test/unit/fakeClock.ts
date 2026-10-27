// A clock the test moves by hand: scheduled callbacks run only when `advance` passes them.

import type { Clock } from "../../src/ports/clock.ts";

export class FakeClock implements Clock {
  private time: number;
  private timers: Array<{ at: number; callback: () => void }> = [];

  constructor(start = Date.parse("2026-10-26T10:00:00.000Z")) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const timer = { at: this.time + delayMs, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((other) => other !== timer);
    };
  }

  /** Moves time forward and runs, in order, the callbacks that fall due. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.time = next.at;
      next.callback();
    }
    this.time = end;
  }
}
