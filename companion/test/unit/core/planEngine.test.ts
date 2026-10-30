// Seam 1: which engine a voice session opens on (#56). The plan engine (Codex on the ChatGPT
// plan) while 20 % or more of the plan's quota is left, the API engine otherwise. Through the
// session manager with a fake quota, two fake engines, a fake registry and a fake clock.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AnnouncementQueue } from "../../../src/core/announcementQueue.ts";
import { ShellState } from "../../../src/core/shellState.ts";
import { VoiceSessionManager } from "../../../src/core/voiceSessions.ts";
import type { PlanQuotaReading } from "../../../src/ports/planQuota.ts";
import type { UsageRecord } from "../../../src/ports/taskRegistry.ts";
import { project } from "../builders.ts";
import {
  FakeClock,
  FakePlanQuota,
  FakePushSender,
  FakeVoiceEngine,
  InMemoryTaskRegistry,
  unusedVoiceTasks,
} from "../fakePorts.ts";

const MINUTE = 60_000;
const TODAY = "2026-10-26";

function quota(fiveHour: number | null, week: number | null, limitReached = false) {
  return {
    fiveHourPercentLeft: fiveHour,
    weekPercentLeft: week,
    limitReached,
  } satisfies PlanQuotaReading;
}

function setup({
  reading = quota(80, 90) as PlanQuotaReading | "unreadable",
  withApiEngine = true,
  usage = [] as UsageRecord[],
} = {}) {
  const clock = new FakeClock();
  const apiEngine = new FakeVoiceEngine({ model: "gpt-live-1" });
  const planEngine = new FakeVoiceEngine({
    model: "gpt-live-1-codex",
    billing: "plan_quota",
    usdPerMinute: 0,
  });
  const planQuota = new FakePlanQuota();
  planQuota.reading = reading;
  const registry = new InMemoryTaskRegistry();
  for (const record of usage) registry.saveUsage(record);
  const shell = new ShellState();
  shell.apply({ type: "snapshot", sequence: 1, projects: [project("p1", "Joombo")], threads: [] });
  const logs: string[] = [];
  const announcements = new AnnouncementQueue({
    registry,
    shell: () => shell,
    push: new FakePushSender(),
    clock,
    log: () => {},
  });
  const sessions = new VoiceSessionManager({
    engine: withApiEngine ? apiEngine : null,
    plan: { engine: planEngine, quota: planQuota, minPercentLeft: 20 },
    shell: () => shell,
    tasks: unusedVoiceTasks(clock),
    announcements,
    registry,
    limits: { idleMinutes: 3, idleMinutesWhileTasksRun: 20, dailyBudgetUsd: 10 },
    budgetTimeZone: "Europe/Paris",
    isRevoked: async () => false,
    clock,
    log: (line) => logs.push(line),
  });
  return {
    clock,
    apiEngine,
    planEngine,
    planQuota,
    registry,
    sessions,
    logs,
    open: (deviceId = "d1") => sessions.open(deviceId, { sdpOffer: "v=0 offer", timeZone: null }),
  };
}

describe("picking the engine when a session opens", () => {
  test("opens on the plan engine when 20 % or more of the quota is left", async () => {
    const { apiEngine, planEngine, open } = setup({ reading: quota(20, 35) });
    const result = await open();
    assert.equal(result.status, "opened");
    assert.equal(planEngine.sessions.length, 1);
    assert.equal(planEngine.last.request.sdpOffer, "v=0 offer");
    assert.equal(apiEngine.sessions.length, 0);
  });

  test("opens on the API engine when the lower of the two limits is under 20 %", async () => {
    const { apiEngine, planEngine, logs, open } = setup({ reading: quota(90, 19) });
    const result = await open();
    assert.equal(result.status, "opened");
    assert.equal(apiEngine.sessions.length, 1);
    assert.equal(planEngine.sessions.length, 0);
    assert.ok(logs.some((line) => line.includes("19 % of the plan's quota is left")));
  });

  test("opens on the API engine when the plan says a limit is reached", async () => {
    const { apiEngine, planEngine, open } = setup({ reading: quota(60, 60, true) });
    await open();
    assert.equal(apiEngine.sessions.length, 1);
    assert.equal(planEngine.sessions.length, 0);
  });

  test("opens on the API engine when the plan reports only one of its two limits", async () => {
    const { apiEngine, planEngine, open } = setup({ reading: quota(80, null) });
    await open();
    assert.equal(apiEngine.sessions.length, 1);
    assert.equal(planEngine.sessions.length, 0);
  });

  test("opens on the API engine when the quota cannot be read", async () => {
    const { apiEngine, planEngine, logs, open } = setup({ reading: "unreadable" });
    await open();
    assert.equal(apiEngine.sessions.length, 1);
    assert.equal(planEngine.sessions.length, 0);
    assert.ok(logs.some((line) => line.includes("codex is not installed")));
  });

  test("opens on the API engine with the same offer when the plan engine fails", async () => {
    const { apiEngine, planEngine, logs, open } = setup();
    planEngine.failNextOpen = true;
    const result = await open();
    assert.equal(result.status, "opened");
    assert.equal(apiEngine.last.request.sdpOffer, "v=0 offer");
    assert.ok(logs.some((line) => line.includes("the plan engine failed to open")));
  });

  test("opens on the plan engine when no API key is set up", async () => {
    const { planEngine, open } = setup({ withApiEngine: false });
    const result = await open();
    assert.equal(result.status, "opened");
    assert.equal(planEngine.sessions.length, 1);
  });

  test("answers unavailable without an API key when the plan engine cannot be used", async () => {
    const { open } = setup({ withApiEngine: false, reading: quota(10, 50) });
    const result = await open();
    assert.equal(result.status, "unavailable");
  });
});

function apiUsage(estimatedCostUsd: number): UsageRecord {
  return {
    sessionId: "earlier",
    engine: "gpt-live-1",
    billing: "usd",
    day: TODAY,
    startedAt: `${TODAY}T08:00:00.000Z`,
    minutes: estimatedCostUsd / 0.05,
    estimatedCostUsd,
  };
}

describe("the daily budget with a plan engine", () => {
  test("a session opens on the plan engine when the day's API budget is spent", async () => {
    const { planEngine, open } = setup({ usage: [apiUsage(10)] });
    const result = await open();
    assert.equal(result.status, "opened");
    assert.equal(planEngine.sessions.length, 1);
  });

  test("no session opens when the budget is spent and the plan engine cannot be used", async () => {
    const { apiEngine, open } = setup({ usage: [apiUsage(10)], reading: quota(5, 50) });
    const result = await open();
    assert.equal(result.status, "budget_reached");
    assert.equal(apiEngine.sessions.length, 0);
  });

  test("minutes on the plan engine are recorded as quota minutes, at no cost", async () => {
    const { clock, registry, sessions, open } = setup();
    const result = await open();
    clock.advance(4 * MINUTE);
    await sessions.close("d1", (result as { sessionId: string }).sessionId);
    const [record] = registry.usageOn(TODAY);
    assert.equal(record?.billing, "plan_quota");
    assert.equal(record?.engine, "gpt-live-1-codex");
    assert.equal(record?.minutes, 4);
    assert.equal(record?.estimatedCostUsd, 0);
  });

  test("the end of a plan session is logged in minutes of quota, not in dollars", async () => {
    const { clock, sessions, logs, open } = setup();
    const result = await open();
    clock.advance(3 * MINUTE);
    await sessions.close("d1", (result as { sessionId: string }).sessionId);
    const ended = logs.find((line) => line.includes("ended after"));
    assert.equal(
      ended,
      "t3-voice: voice session of device d1 ended after 3.0 min on the plan's quota.",
    );
  });

  test("a long plan session does not spend the API budget", async () => {
    const { clock, apiEngine, planQuota, sessions, open } = setup();
    const first = await open("d1");
    // 300 minutes at $0.05 would be $15, over the $10 budget, if they were counted.
    clock.advance(300 * MINUTE);
    await sessions.close("d1", (first as { sessionId: string }).sessionId);
    planQuota.reading = quota(10, 50);
    const second = await open("d1");
    assert.equal(second.status, "opened");
    assert.equal(apiEngine.sessions.length, 1);
  });

  test("an open plan session is not stopped when API sessions spend the budget", async () => {
    const { clock, planEngine, open } = setup({ usage: [apiUsage(10)] });
    await open();
    clock.advance(1 * MINUTE);
    assert.equal(planEngine.last.closed, false);
    assert.deepEqual(planEngine.last.spoken, []);
  });
});
