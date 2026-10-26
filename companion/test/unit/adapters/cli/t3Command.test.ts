import assert from "node:assert/strict";
import { test } from "node:test";
import { t3Command } from "../../../../src/adapters/cli/t3Command.ts";

const lookup = (files: string[]) => ({
  path: "/usr/bin:/home/me/bin",
  home: "/home/me",
  exists: (path: string) => files.includes(path),
});

test("uses `t3` when it is on the PATH", () => {
  assert.equal(t3Command("0.1.0", lookup(["/home/me/bin/t3"])), "t3");
});

test("points at the installed binary when `t3` is not on the PATH", () => {
  assert.equal(
    t3Command("0.1.0", lookup(["/home/me/.t3/runtime/versions/0.1.0/t3"])),
    "~/.t3/runtime/versions/0.1.0/t3",
  );
});

test("falls back to `t3` when it finds neither", () => {
  assert.equal(t3Command("0.1.0", lookup([])), "t3");
});
