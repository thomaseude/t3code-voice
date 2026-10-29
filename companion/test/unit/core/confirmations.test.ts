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

  test("a code sent as a number keeps its leading zeros: 472 answers « 0472 »", async () => {
    const clock = new FakeClock();
    const confirmations = new Confirmations(
      clock,
      () => {},
      () => "0472",
    );
    let ran = false;
    confirmations.ask({
      tool: "start_task",
      readBack: {},
      run: async () => {
        ran = true;
        return { result: {} };
      },
    });
    confirmations.assistantSpoke();
    confirmations.heard("oui");
    clock.advance(1_000);

    const taken = await confirmations.take("start_task", 472);

    assert.equal(taken.kind, "confirmed");
    if (taken.kind === "confirmed") await taken.run();
    assert.equal(ran, true);
  });

  test("a word sent as a code is not the code « 0000 »", async () => {
    const clock = new FakeClock();
    const confirmations = new Confirmations(
      clock,
      () => {},
      () => "0000",
    );
    confirmations.ask({ tool: "start_task", readBack: {}, run: async () => ({ result: {} }) });

    const taken = await confirmations.take("start_task", "oui");

    assert.deepEqual(taken, {
      kind: "refused",
      result: { error: "invalid_confirmation" },
      why: "invalid_confirmation: wrong_code",
    });
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
