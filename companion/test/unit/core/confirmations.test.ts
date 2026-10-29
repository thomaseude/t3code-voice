// Confirmations on their own, for what the voice session tests cannot reach.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Confirmations } from "../../../src/core/confirmations.ts";
import { FakeClock } from "../fakePorts.ts";

describe("Confirmations", () => {
  test("a question asked after the session ended is refused and holds nothing", () => {
    const clock = new FakeClock();
    const opened: boolean[] = [];
    const confirmations = new Confirmations(clock, (open) => opened.push(open));
    confirmations.close();

    const result = confirmations.ask({
      tool: "start_task",
      readBack: {},
      run: async () => ({ result: {} }),
    });

    assert.deepEqual(result, { error: "session_closed" });
    assert.deepEqual(opened, []);
    assert.equal(clock.pendingTimers(), 0);
  });

  test("a « non » closes the question: a later « oui » cannot turn it into a yes", async () => {
    const clock = new FakeClock();
    const opened: boolean[] = [];
    const confirmations = new Confirmations(clock, (open) => opened.push(open));
    const asked = confirmations.ask({
      tool: "interrupt_task",
      readBack: {},
      run: async () => ({ result: {} }),
    });
    confirmations.assistantSpoke();

    confirmations.heard("non");
    clock.advance(2_000);
    confirmations.heard("oui");

    assert.deepEqual(opened, [true, false]);
    assert.equal(clock.pendingTimers(), 0);
    const taken = await confirmations.take("interrupt_task", asked.confirmation as string);
    assert.deepEqual(taken, {
      kind: "refused",
      result: { error: "not_confirmed" },
      why: "not_confirmed",
    });
  });
});
