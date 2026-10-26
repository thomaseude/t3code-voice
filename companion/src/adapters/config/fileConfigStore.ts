// ConfigStore adapter: JSON files under ~/.config/t3voice/ (override with T3VOICE_CONFIG_DIR).
//
// Every file is written with mode 600 and the directory is created with mode 700. A file or
// directory that other users can open is refused. Secrets are only read from and written to
// these files: they are never printed or logged.

import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CompanionConfig,
  ConfigError,
  type ConfigStore,
  type PairingWindow,
} from "../../ports/configStore.ts";
import type { PairedDevice } from "../../ports/deviceAuth.ts";
import type { T3Pairing } from "../../ports/t3Backend.ts";

const CONFIG_FILE = "config.json";
const T3_PAIRING_FILE = "t3-pairing.json";
const DEVICES_FILE = "devices.json";
const PAIRING_WINDOW_FILE = "pairing-window.json";

/** How long to wait for another process to release a lock. Holding one takes milliseconds. */
const LOCK_WAIT_MS = 5_000;

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
    const data = await this.readPrivateJson(path);
    if (data === null) return null;
    if (typeof data?.t3?.baseUrl !== "string") {
      throw new ConfigError(`${path} has no "t3.baseUrl".`);
    }
    const accepted = data.t3.acceptedServerVersions;
    if (
      accepted !== undefined &&
      !(Array.isArray(accepted) && accepted.every((version) => typeof version === "string"))
    ) {
      // A malformed list must never loosen the version check.
      throw new ConfigError(`${path}: "t3.acceptedServerVersions" must be a list of versions.`);
    }
    const server = data.server ?? {};
    if (server.host !== undefined && !(typeof server.host === "string" && server.host !== "")) {
      // Node listens on every interface when the host is empty.
      throw new ConfigError(`${path}: "server.host" must be a non-empty address.`);
    }
    if (
      server.port !== undefined &&
      !(Number.isInteger(server.port) && server.port >= 1 && server.port <= 65535)
    ) {
      throw new ConfigError(`${path}: "server.port" must be a port number (1 to 65535).`);
    }
    if (server.clientIpHeader !== undefined && typeof server.clientIpHeader !== "string") {
      throw new ConfigError(`${path}: "server.clientIpHeader" must be a header name.`);
    }
    if (server.publicUrl !== undefined && !isHttpsUrl(server.publicUrl)) {
      // The phone sends its device token to this address.
      throw new ConfigError(
        `${path}: "server.publicUrl" must be an https:// address, e.g. "https://voice.example.com".`,
      );
    }
    return data as CompanionConfig;
  }

  async saveConfig(config: CompanionConfig): Promise<void> {
    await this.writePrivateFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  }

  async loadT3Pairing(): Promise<T3Pairing | null> {
    const path = join(this.location, T3_PAIRING_FILE);
    const data = await this.readPrivateJson(path);
    if (data === null) return null;
    const expiresAt = data?.expiresAt;
    if (
      typeof data?.baseUrl !== "string" ||
      typeof data?.token !== "string" ||
      !(typeof expiresAt === "string" || expiresAt === null)
    ) {
      throw new ConfigError(`${path} is damaged; run "t3-voice setup" again.`);
    }
    return data as T3Pairing;
  }

  async saveT3Pairing(pairing: T3Pairing): Promise<void> {
    await this.writePrivateFile(T3_PAIRING_FILE, `${JSON.stringify(pairing, null, 2)}\n`);
  }

  async loadDevices(): Promise<PairedDevice[]> {
    const path = join(this.location, DEVICES_FILE);
    const data = await this.readPrivateJson(path);
    if (data === null) return [];
    const devices = data?.devices;
    if (!Array.isArray(devices) || !devices.every(isPairedDevice)) {
      // Fail closed: a list we cannot read must not let any device through.
      throw new ConfigError(`${path} is damaged.`);
    }
    return devices;
  }

  async updateDevices(
    change: (devices: PairedDevice[]) => PairedDevice[],
  ): Promise<PairedDevice[]> {
    return this.withLock(DEVICES_FILE, async () => {
      const devices = change(await this.loadDevices());
      await this.writePrivateFile(DEVICES_FILE, `${JSON.stringify({ devices }, null, 2)}\n`);
      return devices;
    });
  }

  async loadPairingWindow(): Promise<PairingWindow | null> {
    const path = join(this.location, PAIRING_WINDOW_FILE);
    const data = await this.readPrivateJson(path);
    if (data === null) return null;
    if (typeof data?.codeSha256 !== "string" || Number.isNaN(Date.parse(data?.expiresAt))) {
      throw new ConfigError(`${path} is damaged; run "t3-voice pair" again.`);
    }
    return { codeSha256: data.codeSha256, expiresAt: data.expiresAt };
  }

  async savePairingWindow(window: PairingWindow): Promise<void> {
    await this.withLock(PAIRING_WINDOW_FILE, () =>
      this.writePrivateFile(PAIRING_WINDOW_FILE, `${JSON.stringify(window, null, 2)}\n`),
    );
  }

  async clearPairingWindow(codeSha256: string): Promise<void> {
    await this.withLock(PAIRING_WINDOW_FILE, async () => {
      if ((await this.loadPairingWindow())?.codeSha256 !== codeSha256) return;
      await rm(join(this.location, PAIRING_WINDOW_FILE), { force: true });
    });
  }

  /**
   * Runs `work` while holding `<name>.lock`, so other t3-voice processes (and other calls
   * in this one) wait for it. The lock file holds the id of the process that holds it.
   */
  private async withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    await this.ensurePrivateDir();
    const lock = join(this.location, `${name}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!(await tryLock(lock))) {
      await removeIfHolderDied(lock);
      if (Date.now() > deadline) {
        throw new ConfigError(
          `${lock} is held by another t3-voice process. If none is running, delete the file.`,
        );
      }
      await sleep(5 + Math.random() * 20);
    }
    try {
      return await work();
    } finally {
      await rm(lock, { force: true });
    }
  }

  /** Writes atomically (temp file + rename) so a crash never leaves a half-written secret. */
  private async writePrivateFile(name: string, content: string): Promise<void> {
    await this.ensurePrivateDir();
    const path = join(this.location, name);
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, content, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
  }

  // biome-ignore lint/suspicious/noExplicitAny: the caller checks the fields it needs.
  private async readPrivateJson(path: string): Promise<any | null> {
    // Check the directory even when the file is missing: setup must fail before it pairs.
    await this.assertPrivateDir();
    const mode = await modeOf(path);
    if (mode === null) return null;
    if ((mode & 0o077) !== 0) {
      throw new ConfigError(`${path} can be read by other users; run "chmod 600 ${path}".`);
    }
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new ConfigError(`${path} is not valid JSON.`);
    }
  }

  private async ensurePrivateDir(): Promise<void> {
    // Tighten the directory only if we created it. An existing one is checked, never changed.
    const created = await mkdir(this.location, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(this.location, 0o700);
    else await this.assertPrivateDir();
  }

  private async assertPrivateDir(): Promise<void> {
    const mode = (await modeOf(this.location)) ?? 0;
    if ((mode & 0o077) !== 0) {
      throw new ConfigError(
        `${this.location} can be opened by other users; run "chmod 700 ${this.location}".`,
      );
    }
  }
}

/** The file mode, or null when the path does not exist. */
async function modeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Creates the lock with this process's id in it, in one step: link() fails when the lock
 * exists, so two processes can never both create it.
 */
async function tryLock(lock: string): Promise<boolean> {
  const temp = uniqueName(lock);
  await writeFile(temp, String(process.pid), { mode: 0o600 });
  try {
    await link(temp, lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Removes a lock whose process died (killed while it held the lock). The lock is first
 * moved to a unique name, so only one process can remove it. If the moved lock belongs to
 * another process, it was taken again in the meantime, and it is put back.
 */
async function removeIfHolderDied(lock: string): Promise<void> {
  const holder = await lockHolder(lock);
  if (holder === null || isRunning(holder)) return;
  const aside = uniqueName(lock);
  try {
    await rename(lock, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if ((await lockHolder(aside)) !== holder) await link(aside, lock).catch(() => {});
  await rm(aside, { force: true });
}

/** The process id in a lock file, or null when the file is gone or holds no id. */
async function lockHolder(lock: string): Promise<number | null> {
  try {
    const pid = Number.parseInt(await readFile(lock, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function uniqueName(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
}

function isHttpsUrl(value: unknown): boolean {
  return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:";
}

// biome-ignore lint/suspicious/noExplicitAny: checks an untyped JSON value.
function isPairedDevice(value: any): value is PairedDevice {
  const next = value?.nextToken;
  return (
    typeof value?.id === "string" &&
    typeof value?.name === "string" &&
    typeof value?.tokenSha256 === "string" &&
    (next === null || (typeof next?.sha256 === "string" && typeof next?.issuedAt === "string")) &&
    typeof value?.tokenIssuedAt === "string" &&
    typeof value?.pairedAt === "string" &&
    (typeof value?.revokedAt === "string" || value?.revokedAt === null)
  );
}
