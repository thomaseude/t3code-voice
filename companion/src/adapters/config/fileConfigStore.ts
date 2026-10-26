// ConfigStore adapter: JSON files under ~/.config/t3voice/ (override with T3VOICE_CONFIG_DIR).
//
// Every file is written with mode 600 and the directory with mode 700. Secrets are only
// read from and written to these files: they are never printed or logged.

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CompanionConfig, ConfigError, type ConfigStore } from "../../ports/configStore.ts";
import type { T3Session } from "../../ports/t3Backend.ts";

const CONFIG_FILE = "config.json";
const T3_SESSION_FILE = "t3-session.json";

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.T3VOICE_CONFIG_DIR ?? join(homedir(), ".config", "t3voice");
}

export class FileConfigStore implements ConfigStore {
  readonly location: string;

  constructor(dir: string) {
    this.location = dir;
  }

  async loadConfig(): Promise<CompanionConfig | null> {
    const path = join(this.location, CONFIG_FILE);
    const data = await readPrivateJson(path);
    if (data === null) return null;
    if (typeof data?.t3?.baseUrl !== "string") {
      throw new ConfigError(`${path} has no "t3.baseUrl".`);
    }
    return data as CompanionConfig;
  }

  async saveConfig(config: CompanionConfig): Promise<void> {
    await this.writePrivateFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  }

  async loadT3Session(): Promise<T3Session | null> {
    const path = join(this.location, T3_SESSION_FILE);
    const data = await readPrivateJson(path);
    if (data === null) return null;
    if (typeof data?.token !== "string" || typeof data?.expiresAt !== "string") {
      throw new ConfigError(`${path} is damaged; run "t3-voice setup" again.`);
    }
    return data as T3Session;
  }

  async saveT3Session(session: T3Session): Promise<void> {
    await this.writePrivateFile(T3_SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`);
  }

  /** Writes atomically (temp file + rename) so a crash never leaves a half-written secret. */
  private async writePrivateFile(name: string, content: string): Promise<void> {
    await mkdir(this.location, { recursive: true, mode: 0o700 });
    await chmod(this.location, 0o700);
    const path = join(this.location, name);
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, content, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
  }
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
