// `t3-voice serve`: runs the HTTP API the iPhone calls, until the process is asked to stop
// or T3 fails for good.

import { activityOf } from "../../core/activity.ts";
import { ShellState } from "../../core/shellState.ts";
import type { ApiServerOptions, RunningApiServer } from "../../ports/apiServer.ts";
import {
  type ConfigStore,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from "../../ports/configStore.ts";
import type { T3Connector } from "../../ports/t3Backend.ts";
import { loadT3Setup } from "./t3Setup.ts";

export interface ServeOptions {
  store: ConfigStore;
  t3: T3Connector;
  /** main.ts plugs the HTTP adapter in here. */
  startServer(options: ApiServerOptions): Promise<RunningApiServer>;
  /** Resolves when the process must stop (SIGTERM from systemd, Ctrl-C). */
  waitForStop(): Promise<void>;
  out(line: string): void;
  /** Current time in milliseconds; injectable for tests. */
  now?: () => number;
}

export async function runServe({
  store,
  t3,
  startServer,
  waitForStop,
  out,
  now = Date.now,
}: ServeOptions) {
  const { config, pairing } = await loadT3Setup(store);
  // Read once now, so a damaged or loose device list stops the start, not the first request.
  const devices = await store.loadDevices();

  // Fail closed: connect checks that T3 is a tested version, and throws otherwise.
  const backend = await t3.connect(pairing, config.t3.acceptedServerVersions);
  const state = new ShellState();
  let connected = true;
  let fail: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  // Handled by the race below; this only keeps an early failure from crashing the process.
  failed.catch(() => {});
  const subscription = backend.subscribeShell({
    onEvent: (event) => state.apply(event),
    onConnectionChange: (change) => {
      connected = change === "connected";
    },
    // For example T3 came back as an untested version: stop rather than guess.
    onFatalError: (error) => fail(error),
  });

  let server: RunningApiServer | null = null;
  try {
    const {
      host = DEFAULT_SERVER_HOST,
      port = DEFAULT_SERVER_PORT,
      clientIpHeader,
    } = config.server ?? {};
    server = await startServer({
      host,
      port,
      ...(clientIpHeader ? { clientIpHeader } : {}),
      // While T3 is away, its last known state could be stale: say so instead.
      activity: () => (connected && state.hasSnapshot ? activityOf(state, new Date(now())) : null),
    });
    const { version } = backend.serverInfo();
    const paired = devices.filter((device) => device.revokedAt === null).length;
    out(`Connected to T3 ${version} at ${config.t3.baseUrl}.`);
    out(`Listening on ${server.url} (${paired} paired device${paired === 1 ? "" : "s"}).`);

    await Promise.race([waitForStop(), failed]);
  } finally {
    await server?.close();
    subscription.close();
    backend.close();
  }
}
