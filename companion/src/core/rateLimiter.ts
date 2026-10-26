// Counts requests per key (an IP, a device) in fixed time windows.

export interface RateLimiterOptions {
  /** Requests allowed per key in one window. */
  limit: number;
  windowMs: number;
  /** Keys tracked at most; past it, new keys are refused until windows end. */
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
  /** Per key: when its window started and how many requests it counted. */
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep: number;

  constructor({ limit, windowMs, maxKeys = 10_000, now = Date.now }: RateLimiterOptions) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.lastSweep = now();
  }

  /** Counts one request for the key and says whether it may go through. */
  take(key: string): RateDecision {
    const now = this.now();
    this.sweep(now);

    let window = this.windows.get(key);
    if (window === undefined && this.windows.size >= this.maxKeys) {
      this.sweep(now, true);
      if (this.windows.size >= this.maxKeys) return { allowed: false, retryAfterMs: this.windowMs };
    }
    if (window === undefined || now - window.start >= this.windowMs) {
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

  /** Drops ended windows, at most once per window length unless forced. */
  private sweep(now: number, force = false) {
    if (!force && now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
