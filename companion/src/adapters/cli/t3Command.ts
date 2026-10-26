// How to call the `t3` CLI in the instructions we print. T3's installer does not always put
// `t3` on the PATH, so fall back to the binary it installs under ~/.t3/runtime.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface T3CommandLookup {
  path: string;
  home: string;
  exists(path: string): boolean;
}

const systemLookup = (): T3CommandLookup => ({
  path: process.env.PATH ?? "",
  home: homedir(),
  exists: existsSync,
});

export function t3Command(serverVersion: string, lookup: T3CommandLookup = systemLookup()): string {
  const onPath = lookup.path.split(delimiter).some((dir) => dir && lookup.exists(join(dir, "t3")));
  if (onPath) return "t3";

  const installed = join(lookup.home, ".t3", "runtime", "versions", serverVersion, "t3");
  if (lookup.exists(installed)) return `~/.t3/runtime/versions/${serverVersion}/t3`;
  return "t3";
}
