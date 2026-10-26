// Guards the hexagonal dependency rule:
//   ports    → nothing else in src
//   core     → ports only
//   adapters → ports and core, never another adapter
//   main.ts  → anything (it is the composition root)

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const SRC = resolve(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

/** "core", "ports", "adapters/<name>" or "main". */
function layerOf(file: string): string {
  const [top, second] = relative(SRC, file).split("/");
  if (top === "adapters") return `adapters/${second}`;
  return top === "main.ts" ? "main" : (top ?? "");
}

function allowed(from: string, to: string): boolean {
  if (from === to || from === "main") return true;
  if (from === "ports") return false;
  if (from === "core") return to === "ports";
  return to === "ports" || to === "core";
}

test("each layer only depends on the layers it may use", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const imports = readFileSync(file, "utf8").matchAll(/(?:from|import) "(\.[^"]+)"/g);
    for (const [, path] of imports) {
      const target = resolve(dirname(file), path ?? "");
      if (!allowed(layerOf(file), layerOf(target))) {
        violations.push(`${relative(SRC, file)} → ${relative(SRC, target)}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
