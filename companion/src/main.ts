#!/usr/bin/env node
// Composition root: the only place that picks the real adapters and plugs them into the
// ports. Everything else depends on the ports.

import { join } from "node:path";
import { runCli } from "./adapters/cli/cli.ts";
import { startCodexAppServer } from "./adapters/codex-live/appServer.ts";
import { CodexLiveEngine } from "./adapters/codex-live/codexLiveEngine.ts";
import { defaultConfigDir, FileConfigStore } from "./adapters/config/fileConfigStore.ts";
import { OpaqueTokenAuth } from "./adapters/device-auth/opaqueTokenAuth.ts";
import { GptLiveEngine } from "./adapters/gpt-live/gptLiveEngine.ts";
import { openAiTransport } from "./adapters/gpt-live/openAiTransport.ts";
import { startHttpApi } from "./adapters/http/httpApi.ts";
import { LogPushSender } from "./adapters/log-push/logPushSender.ts";
import { OpenAiSummarizer } from "./adapters/openai-summarizer/openAiSummarizer.ts";
import { openAiResponsesTransport } from "./adapters/openai-summarizer/openAiTransport.ts";
import { WebSocketT3Connector } from "./adapters/t3-websocket/connector.ts";
import {
  SqliteTaskRegistry,
  TASK_REGISTRY_FILE,
} from "./adapters/task-registry/sqliteTaskRegistry.ts";
import { systemClock } from "./core/clock.ts";
import { DevicePairing } from "./core/pairing.ts";

// `t3-voice status | head` closes stdout early; that is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const configDir = defaultConfigDir();
const store = new FileConfigStore(configDir);
const auth = new OpaqueTokenAuth(store);

process.exitCode = await runCli(process.argv.slice(2), {
  store,
  t3: new WebSocketT3Connector(),
  startServer: (options) =>
    startHttpApi({ ...options, auth, devicePairing: new DevicePairing({ store, auth }) }),
  // SPIKE (research/codex-voice): T3VOICE_ENGINE=codex picks Codex's voice, on the Codex
  // login of the user the service runs as.
  voiceEngine: ({ apiKey, ...settings }) =>
    process.env.T3VOICE_ENGINE === "codex"
      ? new CodexLiveEngine({
          startAppServer: startCodexAppServer,
          clock: systemClock,
          brainModel: process.env.T3VOICE_BRAIN_MODEL ?? "gpt-6.1-terra",
          brainEffort: process.env.T3VOICE_BRAIN_EFFORT ?? "low",
        })
      : new GptLiveEngine({ transport: openAiTransport(apiKey), clock: systemClock, ...settings }),
  summarizer: ({ apiKey, model }) =>
    new OpenAiSummarizer({ transport: openAiResponsesTransport(apiKey), model }),
  pushSender: (log) => new LogPushSender(log),
  openTaskRegistry: () => SqliteTaskRegistry.open(join(configDir, TASK_REGISTRY_FILE)),
});
