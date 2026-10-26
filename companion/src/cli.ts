#!/usr/bin/env node
// Entry point of the `t3-voice` command.

import { runSetup } from "./commands/setup.ts";
import { runStatus } from "./commands/status.ts";
import { configDir, DEFAULT_T3_URL } from "./config.ts";
import { scrubSecrets } from "./secrets.ts";
import { T3IncompatibleError } from "./t3/compatibility.ts";

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
/** The T3 server is not a tested version: the companion fails closed. */
const EXIT_INCOMPATIBLE_T3 = 3;

const USAGE = `Usage: t3-voice <command>

Commands:
  setup [--t3-url URL]   Pair the companion with a T3 server (default ${DEFAULT_T3_URL}).
                         Reads the T3 pairing link from the terminal or from stdin.
  status                 Show the T3 server, its projects and the running threads.
  help                   Show this help.

Configuration and secrets live in ~/.config/t3voice/ (or $T3VOICE_CONFIG_DIR).`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const dir = configDir();

  switch (command) {
    case "setup": {
      const t3Url = readFlag(args, "--t3-url");
      await runSetup({
        dir,
        ...(t3Url ? { t3Url } : {}),
        out,
        readPairingLink: () => readSecretLine("Paste the T3 pairing link (input hidden): "),
      });
      return 0;
    }
    case "status":
      await runStatus({ dir, out });
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(USAGE);
      return command === undefined ? EXIT_USAGE : 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n`);
      return EXIT_USAGE;
  }
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new UsageError(`${name} needs a value.`);
  return value;
}

class UsageError extends Error {}

/**
 * Reads one line without echoing it, so the pairing link never shows on screen or in
 * the shell history. When stdin is not a terminal, reads the first line of stdin.
 */
function readSecretLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => {
        data += chunk;
      });
      stdin.on("end", () => resolve(data.split("\n").find((line) => line.trim()) ?? ""));
      stdin.on("error", reject);
    });
  }

  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let line = "";
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(line);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") line = line.slice(0, -1);
        else line += char;
      }
    };
    stdin.on("data", onData);
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`t3-voice: ${scrubSecrets(message)}\n`);
    if (error instanceof T3IncompatibleError) process.exitCode = EXIT_INCOMPATIBLE_T3;
    else if (error instanceof UsageError) process.exitCode = EXIT_USAGE;
    else process.exitCode = EXIT_ERROR;
  },
);
