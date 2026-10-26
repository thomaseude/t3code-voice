// Opens the T3 backend from the saved configuration. Shared by the CLI commands.

import {
  type CompanionConfig,
  ConfigError,
  loadConfig,
  loadT3Session,
  type StoredT3Session,
} from "../config.ts";
import { DEFAULT_T3_PIN, type T3Pin } from "../t3/compatibility.ts";
import { makeHttpTransport, WebSocketT3Backend } from "../t3/webSocketBackend.ts";

export function pinFor(config: CompanionConfig | null): T3Pin {
  const accepted = config?.t3.acceptedServerVersions;
  return accepted?.length ? { ...DEFAULT_T3_PIN, serverVersions: accepted } : DEFAULT_T3_PIN;
}

export interface SavedSetup {
  config: CompanionConfig;
  session: StoredT3Session;
}

export async function loadSavedSetup(dir: string): Promise<SavedSetup> {
  const config = await loadConfig(dir);
  const session = await loadT3Session(dir);
  if (!config || !session) {
    throw new ConfigError('The companion is not set up yet; run "t3-voice setup".');
  }
  return { config, session };
}

/** Connects to T3 after the startup check; throws T3IncompatibleError on a mismatch. */
export function connectBackend({ config, session }: SavedSetup): Promise<WebSocketT3Backend> {
  return WebSocketT3Backend.connect({
    transport: makeHttpTransport(config.t3.baseUrl, session.token),
    pin: pinFor(config),
  });
}
