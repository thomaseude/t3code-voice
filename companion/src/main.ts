#!/usr/bin/env node
// Composition root: the only place that picks the real adapters and plugs them into the
// ports. Everything else depends on the ports.

import { runCli } from "./adapters/cli/cli.ts";
import { defaultConfigDir, FileConfigStore } from "./adapters/config/fileConfigStore.ts";
import { OpaqueTokenAuth } from "./adapters/device-auth/opaqueTokenAuth.ts";
import { GptLiveEngine } from "./adapters/gpt-live/gptLiveEngine.ts";
import { openAiTransport } from "./adapters/gpt-live/openAiTransport.ts";
import { startHttpApi } from "./adapters/http/httpApi.ts";
import { WebSocketT3Connector } from "./adapters/t3-websocket/connector.ts";
import { systemClock } from "./core/clock.ts";
import { DevicePairing } from "./core/pairing.ts";

// `t3-voice status | head` closes stdout early; that is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const store = new FileConfigStore(defaultConfigDir());
const auth = new OpaqueTokenAuth(store);

process.exitCode = await runCli(process.argv.slice(2), {
  store,
  t3: new WebSocketT3Connector(),
  startServer: (options) =>
    startHttpApi({ ...options, auth, devicePairing: new DevicePairing({ store, auth }) }),
  voiceEngine: ({ apiKey, ...settings }) =>
    new GptLiveEngine({ transport: openAiTransport(apiKey), clock: systemClock, ...settings }),
});
