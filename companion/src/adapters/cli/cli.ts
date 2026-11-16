// Driving adapter: the `t3-voice` command line. It only knows the ports; main.ts wires
// the real adapters in.

import { scrubSecrets } from "../../core/secrets.ts";
import type { ApiServerOptions, RunningApiServer } from "../../ports/apiServer.ts";
import { type ConfigStore, DEFAULT_T3_URL } from "../../ports/configStore.ts";
import type { PushSender } from "../../ports/pushSender.ts";
import type { Summarizer } from "../../ports/summarizer.ts";
import { type T3Connector, T3IncompatibleError } from "../../ports/t3Backend.ts";
import type { TaskRegistry } from "../../ports/taskRegistry.ts";
import type { VoiceEngine } from "../../ports/voiceEngine.ts";
import { listDevices, revokeDevice } from "./devices.ts";
import { HiddenLineEditor } from "./hiddenLineEditor.ts";
import { runPair } from "./pair.ts";
import {
  type CodexVoice,
  type CodexVoiceSettings,
  runServe,
  type SummarizerSettings,
  type VoiceEngineSettings,
} from "./serve.ts";
import { runSetup } from "./setup.ts";
import { runStatus } from "./status.ts";

export interface CliDependencies {
  store: ConfigStore;
  t3: T3Connector;
  startServer(options: ApiServerOptions): Promise<RunningApiServer>;
  voiceEngine(settings: VoiceEngineSettings): VoiceEngine;
  codexVoice(settings: CodexVoiceSettings): CodexVoice;
  summarizer(settings: SummarizerSettings): Summarizer;
  pushSender(log: (line: string) => void): PushSender;
  /** main.ts plugs the SQLite registry in here. */
  openTaskRegistry(): TaskRegistry;
}

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
/** The T3 server is not a tested version: the companion fails closed. */
const EXIT_INCOMPATIBLE_T3 = 3;

const USAGE = `Usage: t3-voice <command>

Commands:
  setup [--t3-url URL]   Pair the companion with a T3 server (default ${DEFAULT_T3_URL}).
                         Reads the T3 pairing link from the terminal or from stdin.
  status                 Show the T3 server, its projects and the running threads.
  serve                  Run the HTTP API the iPhone app calls (port 8787 by default).
  pair                   Show a QR code to pair an iPhone; open for 5 minutes, works once.
  devices list           List the paired iPhones.
  devices revoke ID      Revoke an iPhone: its token is refused from its next request.
  help                   Show this help.

Configuration and secrets live in ~/.config/t3voice/ (or $T3VOICE_CONFIG_DIR).`;

/** Runs one command and returns the process exit code. */
export async function runCli(argv: string[], deps: CliDependencies): Promise<number> {
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`t3-voice: ${scrubSecrets(message)}\n`);
    if (error instanceof T3IncompatibleError) return EXIT_INCOMPATIBLE_T3;
    if (error instanceof UsageError) return EXIT_USAGE;
    return EXIT_ERROR;
  }
}

async function dispatch(
  argv: string[],
  {
    store,
    t3,
    startServer,
    voiceEngine,
    codexVoice,
    summarizer,
    pushSender,
    openTaskRegistry,
  }: CliDependencies,
): Promise<number> {
  const [command, ...args] = argv;
  const out = (line: string) => process.stdout.write(`${line}\n`);

  switch (command) {
    case "setup": {
      const t3Url = readFlag(args, "--t3-url");
      await runSetup({
        store,
        t3,
        ...(t3Url ? { t3Url } : {}),
        out,
        readPairingLink: () => readSecretLine("Paste the T3 pairing link (input hidden): "),
      });
      return 0;
    }
    case "status":
      await runStatus({ store, t3, out });
      return 0;
    case "serve":
      await runServe({
        store,
        t3,
        startServer,
        voiceEngine,
        codexVoice,
        summarizer,
        pushSender,
        openTaskRegistry,
        waitForStop,
        out,
      });
      return 0;
    case "pair": {
      const stopped = waitForStop().then(() => "stop" as const);
      const wait = (ms: number) =>
        Promise.race([
          new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), ms)),
          stopped,
        ]);
      return await runPair({ store, out, wait });
    }
    case "devices": {
      const [subcommand, id] = args;
      if (subcommand === "list") {
        await listDevices({ store, out });
        return 0;
      }
      if (subcommand === "revoke" && id) {
        await revokeDevice({ store, id, out });
        return 0;
      }
      throw new UsageError('Use "t3-voice devices list" or "t3-voice devices revoke ID".');
    }
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

function waitForStop(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
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
    const editor = new HiddenLineEditor();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk: string) => {
      const result = editor.feed(chunk);
      if (result === null) return;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (result === "cancelled") reject(new Error("Cancelled."));
      else resolve(editor.line);
    };
    stdin.on("data", onData);
  });
}
