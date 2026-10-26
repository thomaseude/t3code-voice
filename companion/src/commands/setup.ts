// `t3-voice setup`: points the companion at a T3 server and pairs it.

import {
  type CompanionConfig,
  DEFAULT_T3_URL,
  loadConfig,
  saveConfig,
  saveT3Session,
} from "../config.ts";
import { assertCompatible } from "../t3/compatibility.ts";
import {
  exchangePairingCredential,
  fetchDescriptor,
  parsePairingCredential,
  REQUIRED_SCOPES,
} from "../t3/http.ts";
import { connectBackend, pinFor } from "./connect.ts";

export interface SetupOptions {
  dir: string;
  /** From `--t3-url`; otherwise the saved URL, otherwise T3's default loopback address. */
  t3Url?: string;
  /** Reads the pairing link without echoing it. */
  readPairingLink(): Promise<string>;
  out(line: string): void;
}

export async function runSetup(options: SetupOptions): Promise<void> {
  const { dir, out } = options;
  const saved = await loadConfig(dir);
  const config: CompanionConfig = {
    ...saved,
    t3: { ...saved?.t3, baseUrl: options.t3Url ?? saved?.t3.baseUrl ?? DEFAULT_T3_URL },
  };
  const baseUrl = config.t3.baseUrl;

  out(`Checking T3 at ${baseUrl} ...`);
  const descriptor = await fetchDescriptor(baseUrl);
  assertCompatible(descriptor, pinFor(config));
  out(
    `T3 ${descriptor.serverVersion} (protocol ${descriptor.orchestrationProtocolVersion}) is supported.`,
  );

  out("");
  out("Create a pairing link limited to orchestration on the T3 host:");
  out(
    `  t3 auth pairing create --scope orchestration:read --scope orchestration:operate --base-url ${baseUrl}`,
  );
  const credential = parsePairingCredential(await options.readPairingLink());

  const session = await exchangePairingCredential(baseUrl, credential);
  const missing = REQUIRED_SCOPES.filter((scope) => !session.scopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(
      `The pairing link does not grant ${missing.join(", ")}. Create one with the command above.`,
    );
  }

  await saveConfig(dir, config);
  await saveT3Session(dir, session);
  out(`Saved the T3 session in ${dir} (mode 600). It expires on ${session.expiresAt}.`);

  const backend = await connectBackend({ config, session });
  try {
    const projects = await backend.listProjects();
    out(`Connected: ${projects.length} project(s) visible. Run "t3-voice status" for details.`);
  } finally {
    backend.close();
  }
}
