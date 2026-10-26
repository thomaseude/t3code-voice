#!/usr/bin/env node
// Composition root: the only place that picks the real adapters and plugs them into the
// ports. Everything else depends on the ports.

import { runCli } from "./adapters/cli/cli.ts";
import { defaultConfigDir, FileConfigStore } from "./adapters/config/fileConfigStore.ts";
import { WebSocketT3Connector } from "./adapters/t3-websocket/connector.ts";

// `t3-voice status | head` closes stdout early; that is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

process.exitCode = await runCli(process.argv.slice(2), {
  store: new FileConfigStore(defaultConfigDir()),
  t3: new WebSocketT3Connector(),
});
