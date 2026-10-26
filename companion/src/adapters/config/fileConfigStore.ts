// ConfigStore adapter: JSON files under ~/.config/t3voice/ (override with T3VOICE_CONFIG_DIR).
//
// Every file is written with mode 600 and the directory is created with mode 700. A file or
// directory that other users can open is refused. Secrets are only read from and written to
// these files: they are never printed or logged.

import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
const REVOCATIONS_FILE = "revocations.jsonl";

/** A device as devices.json holds it: revocations live in their own file. */
type StoredDevice = Omit<PairedDevice, "revokedAt">;

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.T3VOICE_CONFIG_DIR ?? join(homedir(), ".config", "t3voice");
}

export class FileConfigStore implements ConfigStore {
  readonly location: string;
  /** The device list change in progress: changes run one at a time. */
  private deviceChanges: Promise<unknown> = Promise.resolve();

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
    const devices = data === null ? [] : data?.devices;
    if (!Array.isArray(devices) || !devices.every(isStoredDevice)) {
      // Fail closed: a list we cannot read must not let any device through.
      throw new ConfigError(`${path} is damaged.`);
    }
    const revocations = await this.loadRevocations();
    return devices.map((device) => ({ ...device, revokedAt: revocations.get(device.id) ?? null }));
  }

  updateDevices(change: (devices: PairedDevice[]) => PairedDevice[]): Promise<PairedDevice[]> {
    const run = this.deviceChanges.then(async () => {
      const devices = change(await this.loadDevices());
      const stored: StoredDevice[] = devices.map(({ revokedAt: _, ...device }) => device);
      await this.writePrivateFile(
        DEVICES_FILE,
        `${JSON.stringify({ devices: stored }, null, 2)}\n`,
      );
      return devices;
    });
    this.deviceChanges = run.catch(() => {});
    return run;
  }

  async revokeDevice(id: string, revokedAt: string): Promise<void> {
    await this.ensurePrivateDir();
    // One line added at the end: it cannot overwrite what `serve` or another revoke wrote.
    await appendFile(
      join(this.location, REVOCATIONS_FILE),
      `${JSON.stringify({ id, revokedAt })}\n`,
      { mode: 0o600 },
    );
  }

  /** Device id → date of its first revocation. */
  private async loadRevocations(): Promise<Map<string, string>> {
    const path = join(this.location, REVOCATIONS_FILE);
    const text = await this.readPrivateText(path);
    const revocations = new Map<string, string>();
    for (const line of (text ?? "").split("\n")) {
      if (line.trim() === "") continue;
      let entry: { id?: unknown; revokedAt?: unknown } | null = null;
      try {
        entry = JSON.parse(line);
      } catch {}
      if (typeof entry?.id !== "string" || typeof entry?.revokedAt !== "string") {
        // Fail closed: a revocation we cannot read must not let the device through.
        throw new ConfigError(`${path} is damaged.`);
      }
      if (!revocations.has(entry.id)) revocations.set(entry.id, entry.revokedAt);
    }
    return revocations;
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
    await this.writePrivateFile(PAIRING_WINDOW_FILE, `${JSON.stringify(window, null, 2)}\n`);
  }

  async clearPairingWindow(codeSha256: string): Promise<void> {
    if ((await this.loadPairingWindow())?.codeSha256 !== codeSha256) return;
    await rm(join(this.location, PAIRING_WINDOW_FILE), { force: true });
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
    const text = await this.readPrivateText(path);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ConfigError(`${path} is not valid JSON.`);
    }
  }

  /** The file's content, or null when it does not exist. Refuses a file others can read. */
  private async readPrivateText(path: string): Promise<string | null> {
    // Check the directory even when the file is missing: setup must fail before it pairs.
    await this.assertPrivateDir();
    const mode = await modeOf(path);
    if (mode === null) return null;
    if ((mode & 0o077) !== 0) {
      throw new ConfigError(`${path} can be read by other users; run "chmod 600 ${path}".`);
    }
    return readFile(path, "utf8");
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

function isHttpsUrl(value: unknown): boolean {
  return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:";
}

// biome-ignore lint/suspicious/noExplicitAny: checks an untyped JSON value.
function isStoredDevice(value: any): value is StoredDevice {
  const next = value?.nextToken;
  return (
    typeof value?.id === "string" &&
    typeof value?.name === "string" &&
    typeof value?.tokenSha256 === "string" &&
    (next === null || (typeof next?.sha256 === "string" && typeof next?.issuedAt === "string")) &&
    typeof value?.tokenIssuedAt === "string" &&
    typeof value?.pairingCodeSha256 === "string" &&
    typeof value?.pairedAt === "string"
  );
}
