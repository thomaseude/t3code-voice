import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RateLimiter } from "../../../src/core/rateLimiter.ts";

function limiterAt(start: number, limit = 3, windowMs = 60_000) {
  const clock = { now: start };
  const limiter = new RateLimiter({ limit, windowMs, now: () => clock.now });
  return { clock, limiter };
}

describe("RateLimiter", () => {
  test("allows the limit, then refuses until the window ends", () => {
    const { clock, limiter } = limiterAt(1_000_000);

    assert.deepEqual(limiter.take("ip:1"), { allowed: true });
    assert.deepEqual(limiter.take("ip:1"), { allowed: true });
    assert.deepEqual(limiter.take("ip:1"), { allowed: true });
    clock.now += 20_000;
    assert.deepEqual(limiter.take("ip:1"), { allowed: false, retryAfterMs: 40_000 });

    clock.now += 40_000;
    assert.deepEqual(limiter.take("ip:1"), { allowed: true });
  });

  test("check says whether a key is over its limit, without counting a request", () => {
    const { clock, limiter } = limiterAt(0, 2);

    assert.deepEqual(limiter.check("all"), { allowed: true });
    limiter.take("all");
    assert.deepEqual(limiter.check("all"), { allowed: true });
    limiter.take("all");
    clock.now = 15_000;
    assert.deepEqual(limiter.check("all"), { allowed: false, retryAfterMs: 45_000 });
    assert.deepEqual(limiter.check("all"), { allowed: false, retryAfterMs: 45_000 });
    clock.now = 60_000;
    assert.deepEqual(limiter.check("all"), { allowed: true });
  });

  test("counts each key on its own", () => {
    const { limiter } = limiterAt(0, 1);

    assert.deepEqual(limiter.take("ip:1"), { allowed: true });
    assert.deepEqual(limiter.take("ip:2"), { allowed: true });
    assert.equal(limiter.take("ip:1").allowed, false);
  });

  test("refused requests do not push the window further", () => {
    const { clock, limiter } = limiterAt(0, 1);

    limiter.take("ip:1");
    clock.now = 59_000;
    limiter.take("ip:1");
    clock.now = 60_000;
    assert.deepEqual(limiter.take("ip:1"), { allowed: true });
  });

  test("forgets keys whose window ended, so memory does not grow with every caller", () => {
    const { clock, limiter } = limiterAt(0);

    for (let i = 0; i < 100; i++) limiter.take(`ip:${i}`);
    clock.now = 60_000;
    limiter.take("ip:new");
    assert.equal(limiter.trackedKeys(), 1);
  });

  test("when it tracks the maximum, forgets the oldest caller rather than refuse a new one", () => {
    const clock = { now: 0 };
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 2,
      now: () => clock.now,
    });

    limiter.take("ip:1");
    clock.now = 1_000;
    limiter.take("ip:2");
    clock.now = 2_000;
    assert.deepEqual(limiter.take("ip:3"), { allowed: true });
    assert.equal(limiter.trackedKeys(), 2);
    assert.equal(limiter.take("ip:2").allowed, false);
    assert.equal(limiter.take("ip:3").allowed, false);
  });

  test("a key whose window restarts counts as the newest", () => {
    const clock = { now: 0 };
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 2,
      now: () => clock.now,
    });

    limiter.take("ip:1");
    clock.now = 30_000;
    limiter.take("ip:2");
    clock.now = 60_000;
    limiter.take("ip:1");
    clock.now = 61_000;
    limiter.take("ip:3");
    assert.equal(limiter.take("ip:1").allowed, false, "ip:1 is still counted");
  });

  test("a clock that steps back restarts every window, so none is stretched", () => {
    const { clock, limiter } = limiterAt(0, 1);

    limiter.take("ip:1");
    clock.now = 50_000;
    limiter.take("ip:2");
    clock.now = 40_000;
    assert.deepEqual(limiter.take("ip:1"), { allowed: true });
    assert.deepEqual(limiter.take("ip:2"), { allowed: true });
    assert.equal(limiter.trackedKeys(), 2);
  });
});
