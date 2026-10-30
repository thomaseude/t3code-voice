// ConfigStore adapter: JSON files under ~/.config/t3voice/ (override with T3VOICE_CONFIG_DIR).
//
// Every file is written with mode 600 and the directory is created with mode 700. A file or
// directory that other users can open is refused. Secrets are only read from and written to
// these files: they are never printed or logged.

import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CompanionConfig,
  ConfigError,
  type ConfigStore,
  DEFAULT_SESSION_LIMITS,
  DEFAULT_VOICE,
  type PairingWindow,
} from "../../ports/configStore.ts";
import type { PairedDevice } from "../../ports/deviceAuth.ts";
import type { T3Pairing } from "../../ports/t3Backend.ts";

const CONFIG_FILE = "config.json";
const T3_PAIRING_FILE = "t3-pairing.json";
/** One line `OPENAI_API_KEY=<key>`, in the shell `.env` format. */
const OPENAI_KEY_FILE = "openai.env";
const DEVICES_FILE = "devices.json";
/** One file per revoked device: `<device id>.json`. */
const REVOKED_DIR = "revoked";
/** One file per open pairing window: `<SHA-256 of its code>.json`. */
const PAIRING_WINDOWS_DIR = "pairing-windows";

/** Device ids and code hashes become file names, so they must match these patterns (no `/`, no `..`). */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A device as devices.json holds it: revocations live in `revoked/`, one file per device. */
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
    for (const field of [
      "model",
      "voice",
      "delegationModel",
      "summaryModel",
      "codexModel",
      "codexReasoningEffort",
    ] as const) {
      const value = data.voice?.[field];
      if (
        value !== undefined &&
        !(typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value))
      ) {
        throw new ConfigError(
          `${path}: "voice.${field}" must be a name, e.g. "${DEFAULT_VOICE[field]}".`,
        );
      }
    }
    for (const field of ["idleMinutes", "idleMinutesWhileTasksRun"] as const) {
      const value = data.voice?.[field];
      // The warning comes 30 s before the stop.
      if (value !== undefined && !(Number.isFinite(value) && value >= 1)) {
        throw new ConfigError(
          `${path}: "voice.${field}" must be a number of minutes, 1 or more, e.g. ${DEFAULT_SESSION_LIMITS[field]}.`,
        );
      }
    }
    const budget = data.voice?.dailyBudgetUsd;
    if (budget !== undefined && !(Number.isFinite(budget) && budget > 0)) {
      throw new ConfigError(
        `${path}: "voice.dailyBudgetUsd" must be an amount in US dollars above 0, e.g. ${DEFAULT_SESSION_LIMITS.dailyBudgetUsd}.`,
      );
    }
    const minQuota = data.voice?.minPlanQuotaPercent;
    if (
      minQuota !== undefined &&
      !(Number.isFinite(minQuota) && minQuota >= 0 && minQuota <= 100)
    ) {
      throw new ConfigError(
        `${path}: "voice.minPlanQuotaPercent" must be a percent, 0 to 100, e.g. ${DEFAULT_VOICE.minPlanQuotaPercent}.`,
      );
    }
    const codexVersions = data.voice?.acceptedCodexVersions;
    if (
      codexVersions !== undefined &&
      !(
        Array.isArray(codexVersions) &&
        codexVersions.every((version) => typeof version === "string")
      )
    ) {
      // A malformed list must never loosen the version check.
      throw new ConfigError(`${path}: "voice.acceptedCodexVersions" must be a list of versions.`);
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

  async loadOpenAiKey(): Promise<string | null> {
    const path = join(this.location, OPENAI_KEY_FILE);
    const text = await this.readPrivateText(path);
    if (text === null) return null;
    const line = text
      .split("\n")
      .find((candidate) => candidate.trim().startsWith("OPENAI_API_KEY="));
    const key = line
      ?.trim()
      .slice("OPENAI_API_KEY=".length)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (key === undefined || key === "")
      throw new ConfigError(`${path} has no OPENAI_API_KEY line.`);
    return key;
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
    if (!DEVICE_ID.test(id)) throw new ConfigError(`"${id}" is not a device id.`);
    const name = join(REVOKED_DIR, `${id}.json`);
    // The first date counts.
    if ((await modeOf(join(this.location, name))) !== null) return;
    // A file of its own, written in one step: it cannot overwrite what `serve` or
    // another revoke wrote, and a write cut short leaves nothing behind.
    await this.writePrivateFile(name, `${JSON.stringify({ revokedAt })}\n`);
  }

  /** Device id → date of its revocation. */
  private async loadRevocations(): Promise<Map<string, string>> {
    const revocations = new Map<string, string>();
    for (const file of await this.privateFilesIn(REVOKED_DIR)) {
      const path = join(this.location, REVOKED_DIR, file);
      let revokedAt: unknown = null;
      try {
        revokedAt = JSON.parse((await this.readPrivateText(path)) ?? "null")?.revokedAt;
      } catch {}
      // A damaged file still revokes its device: fail closed, for that device only.
      if (typeof revokedAt !== "string")
        revokedAt = new Date((await stat(path)).mtimeMs).toISOString();
      revocations.set(file.slice(0, -".json".length), revokedAt as string);
    }
    return revocations;
  }

  async loadPairingWindow(codeSha256: string): Promise<PairingWindow | null> {
    if (!SHA256_HEX.test(codeSha256)) return null;
    const path = join(this.location, PAIRING_WINDOWS_DIR, `${codeSha256}.json`);
    const data = await this.readPrivateJson(path);
    if (data === null) return null;
    if (Number.isNaN(Date.parse(data?.expiresAt))) {
      throw new ConfigError(`${path} is damaged; run "t3-voice pair" again.`);
    }
    return { codeSha256, expiresAt: data.expiresAt };
  }

  async savePairingWindow(window: PairingWindow): Promise<void> {
    await this.writePrivateFile(
      join(PAIRING_WINDOWS_DIR, `${window.codeSha256}.json`),
      `${JSON.stringify({ expiresAt: window.expiresAt }, null, 2)}\n`,
    );
  }

  async clearPairingWindow(codeSha256: string): Promise<void> {
    if (!SHA256_HEX.test(codeSha256)) return;
    // Only this window's own file: a newer window is another file.
    await rm(join(this.location, PAIRING_WINDOWS_DIR, `${codeSha256}.json`), { force: true });
  }

  /** The `.json` files of a subdirectory (temp files left out); none when it is missing. */
  private async privateFilesIn(dir: string): Promise<string[]> {
    const path = join(this.location, dir);
    await this.assertPrivateDir(path);
    try {
      return (await readdir(path)).filter((file) => file.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Writes atomically (temp file + rename) so a crash never leaves a half-written secret.
   * `name` may be in a subdirectory, which is created private too.
   */
  private async writePrivateFile(name: string, content: string): Promise<void> {
    const path = join(this.location, name);
    await this.ensurePrivateDir();
    await this.ensurePrivateDir(dirname(path));
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
    await this.assertPrivateDir(dirname(path));
    const mode = await modeOf(path);
    if (mode === null) return null;
    if ((mode & 0o077) !== 0) {
      throw new ConfigError(`${path} can be read by other users; run "chmod 600 ${path}".`);
    }
    return readFile(path, "utf8");
  }

  private async ensurePrivateDir(dir = this.location): Promise<void> {
    // Tighten the directory only if we created it. An existing one is checked, never changed.
    const created = await mkdir(dir, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(dir, 0o700);
    else await this.assertPrivateDir(dir);
  }

  private async assertPrivateDir(dir = this.location): Promise<void> {
    const mode = (await modeOf(dir)) ?? 0;
    if ((mode & 0o077) !== 0) {
      throw new ConfigError(`${dir} can be opened by other users; run "chmod 700 ${dir}".`);
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
