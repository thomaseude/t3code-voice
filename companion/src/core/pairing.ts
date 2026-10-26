// Pairing an iPhone: `t3-voice pair` opens a window with a one-time code, and the app
// trades the code for a device token through POST /pair. `serve` never changes the
// window: the device it saves keeps the hash of the code, which uses the code up.

import type { ConfigStore, PairingWindow } from "../ports/configStore.ts";
import type { Device, DeviceAuth } from "../ports/deviceAuth.ts";
import { RateLimiter } from "./rateLimiter.ts";
import { randomSecret, sha256 } from "./secrets.ts";

/** How long a pairing window stays open. */
export const PAIRING_WINDOW_MS = 5 * 60_000;

/**
 * Wrong codes allowed for all callers together. The per-IP limit is not enough: it
 * forgets old addresses, so a caller with many addresses would escape it.
 */
const FAILED_ATTEMPTS = { limit: 10, windowMs: 10 * 60_000 };

/** Opens a new pairing window and returns its code (a secret). */
export async function openPairingWindow(
  store: ConfigStore,
  now: number,
): Promise<{ code: string; window: PairingWindow }> {
  // 128 random bits: the code travels in a QR code, so it can be long.
  const code = randomSecret(16);
  const window = {
    codeSha256: sha256(code),
    expiresAt: new Date(now + PAIRING_WINDOW_MS).toISOString(),
  };
  await store.savePairingWindow(window);
  return { code, window };
}

export type PairingResult =
  | { status: "paired"; device: Device; token: string }
  /** Wrong code, used code, expired or closed window: the caller learns nothing more. */
  | { status: "refused" }
  /** Too many wrong codes lately: nobody can pair until `retryAfterMs` has passed. */
  | { status: "limited"; retryAfterMs: number };

export interface DevicePairingOptions {
  store: ConfigStore;
  auth: DeviceAuth;
  /** Current time in milliseconds; injectable for tests. */
  now?: () => number;
}

export class DevicePairing {
  private readonly store: ConfigStore;
  private readonly auth: DeviceAuth;
  private readonly now: () => number;
  /** One key for every caller. */
  private readonly failures: RateLimiter;
  /** The attempt in progress: attempts run one at a time, so a code cannot be used twice. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ store, auth, now = Date.now }: DevicePairingOptions) {
    this.store = store;
    this.auth = auth;
    this.now = now;
    this.failures = new RateLimiter({ ...FAILED_ATTEMPTS, now });
  }

  pair(code: string, name: string): Promise<PairingResult> {
    const attempt = this.queue.then(() => this.attempt(code, name));
    this.queue = attempt.catch(() => {});
    return attempt;
  }

  private async attempt(code: string, name: string): Promise<PairingResult> {
    const limit = this.failures.check(FAILURES_KEY);
    if (!limit.allowed) return { status: "limited", retryAfterMs: limit.retryAfterMs };

    const window = await this.store.loadPairingWindow(sha256(code));
    if (
      window === null ||
      !(this.now() < Date.parse(window.expiresAt)) ||
      (await this.codeWasUsed(window.codeSha256))
    ) {
      this.failures.take(FAILURES_KEY);
      return { status: "refused" };
    }
    // One write saves the device and uses up the code. If it fails, the code still works.
    const { device, token } = await this.auth.register(name, window.codeSha256);
    return { status: "paired", device, token };
  }

  private async codeWasUsed(codeSha256: string): Promise<boolean> {
    const devices = await this.store.loadDevices();
    return devices.some((device) => device.pairingCodeSha256 === codeSha256);
  }
}

const FAILURES_KEY = "all callers";
