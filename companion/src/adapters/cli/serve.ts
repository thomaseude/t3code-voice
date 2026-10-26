// `t3-voice serve`: runs the HTTP API the iPhone calls, until the process is asked to stop.

import {
  ConfigError,
  type ConfigStore,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from "../../ports/configStore.ts";

export interface ServerOptions {
  host: string;
  port: number;
  clientIpHeader?: string;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  store: ConfigStore;
  /** main.ts plugs the HTTP adapter in here. */
  startServer(options: ServerOptions): Promise<RunningServer>;
  /** Resolves when the process must stop (SIGTERM from systemd, Ctrl-C). */
  waitForStop(): Promise<void>;
  out(line: string): void;
}

export async function runServe({ store, startServer, waitForStop, out }: ServeOptions) {
  const config = await store.loadConfig();
  if (!config) throw new ConfigError('The companion is not set up yet; run "t3-voice setup".');
  // Read once now, so a damaged or loose device list stops the start, not the first request.
  const devices = await store.loadDevices();

  const {
    host = DEFAULT_SERVER_HOST,
    port = DEFAULT_SERVER_PORT,
    clientIpHeader,
  } = config.server ?? {};
  const server = await startServer({ host, port, ...(clientIpHeader ? { clientIpHeader } : {}) });
  const paired = devices.filter((device) => device.revokedAt === null).length;
  out(`Listening on ${server.url} (${paired} paired device${paired === 1 ? "" : "s"}).`);

  await waitForStop();
  await server.close();
}
