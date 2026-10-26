// `t3-voice setup`: points the companion at a T3 server and pairs it.

import { type CompanionConfig, type ConfigStore, DEFAULT_T3_URL } from "../../ports/configStore.ts";
import { REQUIRED_T3_SCOPES, type T3Connector } from "../../ports/t3Backend.ts";
import { t3Command } from "./t3Command.ts";

export interface SetupOptions {
  store: ConfigStore;
  t3: T3Connector;
  /** From `--t3-url`; otherwise the saved URL, otherwise T3's default loopback address. */
  t3Url?: string;
  /** Reads the pairing link without echoing it. */
  readPairingLink(): Promise<string>;
  out(line: string): void;
}

export async function runSetup({ store, t3, t3Url, readPairingLink, out }: SetupOptions) {
  const saved = await store.loadConfig();
  const config: CompanionConfig = {
    ...saved,
    t3: { ...saved?.t3, baseUrl: t3Url ?? saved?.t3.baseUrl ?? DEFAULT_T3_URL },
  };
  const { baseUrl, acceptedServerVersions } = config.t3;

  out(`Checking T3 at ${baseUrl} ...`);
  const server = await t3.checkServer(baseUrl, acceptedServerVersions);
  out(`T3 ${server.version} (protocol ${server.protocolVersion}) is supported.`);

  out("");
  out("Create a pairing link limited to orchestration on the T3 host:");
  out(
    `  ${t3Command(server.version)} auth pairing create --scope orchestration:read --scope orchestration:operate --base-url ${baseUrl}`,
  );
  const session = await t3.pair(baseUrl, await readPairingLink());

  const missing = REQUIRED_T3_SCOPES.filter((scope) => !session.scopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(
      `The pairing link does not grant ${missing.join(", ")}. Create one with the command above.`,
    );
  }

  await store.saveConfig(config);
  await store.saveT3Session(session);
  out(`Saved the T3 session in ${store.location} (mode 600). It expires on ${session.expiresAt}.`);

  const backend = await t3.connect(baseUrl, session.token, acceptedServerVersions);
  try {
    const projects = await backend.listProjects();
    out(`Connected: ${projects.length} project(s) visible. Run "t3-voice status" for details.`);
  } finally {
    backend.close();
  }
}
