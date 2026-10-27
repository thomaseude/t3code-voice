// Spoken names: how a followed task gets its short French name, and how a spoken reference
// finds the task again.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chooseSpokenName, findByName } from "../../../src/core/spokenNames.ts";

describe("choosing a spoken name", () => {
  test("the model's proposal is kept when it has 2 to 4 words", () => {
    assert.equal(
      chooseSpokenName({
        proposed: "tests Reviews",
        source: "corriger les tests des Reviews",
        project: "joombo",
        taken: [],
      }),
      "tests Reviews",
    );
  });

  test("without a valid proposal, the name comes from the request's first meaningful words", () => {
    for (const proposed of [null, "", "tests", "un nom bien trop long ici"]) {
      assert.equal(
        chooseSpokenName({
          proposed,
          source: "Corriger les tests des Reviews, puis ouvrir une PR",
          project: "joombo",
          taken: [],
        }),
        "corriger tests Reviews",
      );
    }
  });

  test("a one-word request gets the project's name too", () => {
    assert.equal(
      chooseSpokenName({ proposed: null, source: "refactoring", project: "joombo", taken: [] }),
      "refactoring joombo",
    );
  });

  test("a name already taken gets the project, then an ordinal", () => {
    const base = { proposed: "tests Reviews", source: "", project: "joombo" };

    assert.equal(chooseSpokenName({ ...base, taken: ["Tests reviews"] }), "tests Reviews joombo");
    assert.equal(
      chooseSpokenName({ ...base, taken: ["tests Reviews", "tests reviews joombo"] }),
      "tests Reviews 2",
    );
    assert.equal(
      chooseSpokenName({
        ...base,
        taken: ["tests Reviews", "tests Reviews joombo", "tests Réviews 2"],
      }),
      "tests Reviews 3",
    );
  });
});

test("a name findByName could not tell from a taken one counts as taken", () => {
  const base = { source: "", project: "joombo" };

  assert.equal(
    chooseSpokenName({ ...base, proposed: "tests de la review", taken: ["tests Reviews"] }),
    "tests de la review joombo",
  );
  assert.equal(
    chooseSpokenName({ ...base, proposed: "tests joombo", taken: ["tests joombo"] }),
    "tests joombo 2",
  );
});

describe("finding a task by its spoken name", () => {
  const tasks = [
    { name: "tests Reviews", id: "t1" },
    { name: "page offre totem", id: "t2" },
    { name: "tests paiement", id: "t3" },
  ];
  const find = (query: string) => findByName(query, tasks, (task) => task.name);

  test("the name as said, with articles, accents, case or plural changed, finds the task", () => {
    for (const query of [
      "tests Reviews",
      "la tâche des tests reviews",
      "test review",
      "TESTS REVIEWS",
    ]) {
      assert.deepEqual(find(query), { kind: "found", item: tasks[0] });
    }
  });

  test("part of a name finds the task when only one name has it", () => {
    assert.deepEqual(find("la tâche totem"), { kind: "found", item: tasks[1] });
  });

  test("a reference that fits several tasks returns all of them, and acts on none", () => {
    assert.deepEqual(find("les tests"), { kind: "ambiguous", items: [tasks[0], tasks[2]] });
  });

  test("an exact name wins over names that only contain it", () => {
    const withLonger = [...tasks, { name: "tests Reviews joombo", id: "t4" }];
    assert.deepEqual(
      findByName("tests reviews", withLonger, (task) => task.name),
      { kind: "found", item: tasks[0] },
    );
  });

  test("a reference that fits no task finds nothing", () => {
    assert.deepEqual(find("migration base"), { kind: "none" });
    assert.deepEqual(find("la tâche"), { kind: "none" });
  });
});
