// Configuration and secrets under ~/.config/t3voice/ (override with T3VOICE_CONFIG_DIR).
//
// Every file is written with mode 600 and the directory with mode 700. Secrets are only
// read from and written to these files: they are never printed or logged.

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_T3_URL = "http://127.0.0.1:3773";

export interface CompanionConfig {
  t3: {
    baseUrl: string;
    /** Replaces the tested T3 versions. Only add a version after running the integration tests. */
    acceptedServerVersions?: string[];
  };
}

/** The companion's T3 session. `token` is a secret. */
export interface StoredT3Session {
  token: string;
  scopes: string[];
  expiresAt: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.T3VOICE_CONFIG_DIR ?? join(homedir(), ".config", "t3voice");
}

const CONFIG_FILE = "config.json";
const T3_SESSION_FILE = "t3-session.json";

export async function loadConfig(dir: string): Promise<CompanionConfig | null> {
  const data = await readPrivateJson(join(dir, CONFIG_FILE));
  if (data === null) return null;
  if (typeof data?.t3?.baseUrl !== "string") {
    throw new ConfigError(`${join(dir, CONFIG_FILE)} has no "t3.baseUrl".`);
  }
  return data as CompanionConfig;
}

export async function saveConfig(dir: string, config: CompanionConfig): Promise<void> {
  await writePrivateFile(dir, CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

export async function loadT3Session(dir: string): Promise<StoredT3Session | null> {
  const data = await readPrivateJson(join(dir, T3_SESSION_FILE));
  if (data === null) return null;
  if (typeof data?.token !== "string" || typeof data?.expiresAt !== "string") {
    throw new ConfigError(`${join(dir, T3_SESSION_FILE)} is damaged; run "t3-voice setup" again.`);
  }
  return data as StoredT3Session;
}

export async function saveT3Session(dir: string, session: StoredT3Session): Promise<void> {
  await writePrivateFile(dir, T3_SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`);
}

/** Writes atomically (temp file + rename) so a crash never leaves a half-written secret. */
async function writePrivateFile(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = join(dir, name);
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, content, { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

// biome-ignore lint/suspicious/noExplicitAny: the caller checks the fields it needs.
async function readPrivateJson(path: string): Promise<any | null> {
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(`${path} can be read by other users; run "chmod 600 ${path}".`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} is not valid JSON.`);
  }
}
