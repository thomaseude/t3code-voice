// Counts requests per key (an IP, a device) in fixed time windows.

export interface RateLimiterOptions {
  /** Requests allowed per key in one window. */
  limit: number;
  windowMs: number;
  /** Keys tracked at most; past it, the oldest key is forgotten. */
  maxKeys?: number;
  /** Current time in milliseconds; injectable for tests. */
  now?: () => number;
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  /**
   * Per key: when its window started and how many requests it counted. A Map keeps
   * insertion order, and a key is re-inserted when its window restarts, so the first
   * entry is always the oldest window.
   */
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor({ limit, windowMs, maxKeys = 10_000, now = Date.now }: RateLimiterOptions) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  /** Counts one request for the key and says whether it may go through. */
  take(key: string): RateDecision {
    const now = this.now();
    this.dropEndedWindows(now);

    let window = this.windows.get(key);
    if (window === undefined) {
      // Full: forget the oldest caller. Refusing newcomers instead would let a flood of
      // addresses lock everyone else out.
      if (this.windows.size >= this.maxKeys) this.dropOldest();
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) {
      return { allowed: false, retryAfterMs: window.start + this.windowMs - now };
    }
    window.count++;
    return { allowed: true };
  }

  trackedKeys(): number {
    return this.windows.size;
  }

  /** Oldest windows come first, so this stops at the first one still running. */
  private dropEndedWindows(now: number) {
    for (const [key, window] of this.windows) {
      if (now - window.start < this.windowMs) return;
      this.windows.delete(key);
    }
  }

  private dropOldest() {
    const oldest = this.windows.keys().next();
    if (!oldest.done) this.windows.delete(oldest.value);
  }
}
