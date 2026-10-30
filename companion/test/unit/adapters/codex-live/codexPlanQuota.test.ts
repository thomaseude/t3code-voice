// The plan quota read through a fake Codex app-server: what is left in the 5-hour window and
// in the week, and when the quota counts as unreadable.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CodexPlanQuota } from "../../../../src/adapters/codex-live/codexPlanQuota.ts";
import { PlanQuotaError } from "../../../../src/ports/planQuota.ts";
import { FakeClock } from "../../fakePorts.ts";
import { FakeCodexRpc, rateLimits } from "./fakes.ts";

function setup() {
  const rpc = new FakeCodexRpc();
  const quota = new CodexPlanQuota({
    startAppServer: () => rpc,
    clock: new FakeClock(),
    acceptedVersions: ["0.163.0"],
  });
  return { rpc, quota };
}

describe("reading the plan's quota from Codex", () => {
  test("returns the percent left in the 5-hour window and in the week", async () => {
    const { rpc, quota } = setup();
    rpc.limits = rateLimits({ fiveHourUsed: 38, weekUsed: 25 });
    assert.deepEqual(await quota.read(), {
      fiveHourPercentLeft: 62,
      weekPercentLeft: 75,
      limitReached: false,
    });
  });

  test("stops the app-server once the quota is read", async () => {
    const { rpc, quota } = setup();
    await quota.read();
    assert.equal(rpc.closed, true);
  });

  test("says a limit is reached when Codex names one", async () => {
    const { rpc, quota } = setup();
    rpc.limits = rateLimits({ fiveHourUsed: 100, reachedType: "rate_limit_reached" });
    assert.equal((await quota.read()).limitReached, true);
  });

  test("says a limit is reached when the plan no longer allows ordinary usage", async () => {
    const { rpc, quota } = setup();
    rpc.limits = rateLimits({ ordinaryUsageAllowed: false });
    assert.equal((await quota.read()).limitReached, true);
  });

  test("says a limit is reached when Codex does not know whether usage is allowed", async () => {
    const { rpc, quota } = setup();
    rpc.limits = rateLimits({ ordinaryUsageAllowed: null });
    assert.equal((await quota.read()).limitReached, true);
  });

  test("a window Codex does not report is left out", async () => {
    const { rpc, quota } = setup();
    const limits = rateLimits({ fiveHourUsed: 10 });
    limits.rateLimitsByLimitId.codex.secondary = null;
    rpc.limits = limits;
    assert.deepEqual(await quota.read(), {
      fiveHourPercentLeft: 90,
      weekPercentLeft: null,
      limitReached: false,
    });
  });

  test("is unreadable on a Codex version that is not pinned", async () => {
    const { rpc, quota } = setup();
    rpc.version = "0.166.0";
    await assert.rejects(quota.read(), PlanQuotaError);
    assert.deepEqual(rpc.sent("account/rateLimits/read"), []);
    assert.equal(rpc.closed, true);
  });

  test("is unreadable when Codex fails to read it, and stops the app-server", async () => {
    const { rpc, quota } = setup();
    rpc.limits = new Error("not logged in");
    await assert.rejects(quota.read(), PlanQuotaError);
    assert.equal(rpc.closed, true);
  });
});
