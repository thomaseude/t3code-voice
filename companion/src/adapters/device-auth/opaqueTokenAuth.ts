// DeviceAuth with the companion's own opaque tokens: random values it gives to a device
// when it pairs. Only their SHA-256 is stored. A token is long and random, so a plain
// hash is enough: there is no weak password to protect with a slow hash.

import { randomBytes } from "node:crypto";
import { randomSecret, sameHash, sha256 } from "../../core/secrets.ts";
import type { ConfigStore } from "../../ports/configStore.ts";
import type { Authentication, Device, DeviceAuth, PairedDevice } from "../../ports/deviceAuth.ts";

/** A token is replaced the first time it is used after this age. */
const ROTATE_AFTER_MS = 30 * 86_400_000;
/**
 * A replacement is sent again (as a new token) only after this delay. Requests sent
 * together with the old token then get one replacement, not several the app could mix up.
 */
const RESEND_REPLACEMENT_AFTER_MS = 60_000;

export interface OpaqueTokenAuthOptions {
  /** Current time in milliseconds; injectable for tests. */
  now?: () => number;
}

export class OpaqueTokenAuth implements DeviceAuth {
  private readonly store: ConfigStore;
  private readonly now: () => number;

  constructor(store: ConfigStore, { now = Date.now }: OpaqueTokenAuthOptions = {}) {
    this.store = store;
    this.now = now;
  }

  async authenticate(token: string): Promise<Authentication | null> {
    const hash = sha256(token);
    // Read on every request, so a revocation applies to the next one.
    for (const device of await this.store.loadDevices()) {
      if (device.revokedAt !== null) continue;
      if (sameHash(device.tokenSha256, hash)) return this.withCurrentToken(device);
      if (device.nextToken !== null && sameHash(device.nextToken.sha256, hash)) {
        return this.withReplacementToken(device);
      }
    }
    return null;
  }

  async register(name: string): Promise<{ device: Device; token: string }> {
    const token = newToken();
    const now = new Date(this.now()).toISOString();
    let device: Device = { id: "", name };
    await this.store.updateDevices((devices) => {
      device = { id: newDeviceId(devices), name };
      const paired: PairedDevice = {
        ...device,
        tokenSha256: sha256(token),
        nextToken: null,
        tokenIssuedAt: now,
        pairedAt: now,
        revokedAt: null,
      };
      return [...devices, paired];
    });
    return { device, token };
  }

  /** The device used its current token: hand it a replacement once the token is 30 days old. */
  private async withCurrentToken(device: PairedDevice): Promise<Authentication> {
    const now = this.now();
    const authenticated = { device: summary(device), replacementToken: null };
    if (now - Date.parse(device.tokenIssuedAt) < ROTATE_AFTER_MS) return authenticated;
    if (
      device.nextToken !== null &&
      now - Date.parse(device.nextToken.issuedAt) < RESEND_REPLACEMENT_AFTER_MS
    ) {
      return authenticated;
    }

    // The device missed the previous replacement, if any: that one is dropped.
    const replacement = newToken();
    const saved = await this.changeIfStill(device, (current) => ({
      ...current,
      nextToken: { sha256: sha256(replacement), issuedAt: new Date(now).toISOString() },
    }));
    return saved ? { ...authenticated, replacementToken: replacement } : authenticated;
  }

  /** The device used its replacement: it has stored it, so the old token stops working. */
  private async withReplacementToken(device: PairedDevice): Promise<Authentication> {
    const now = new Date(this.now()).toISOString();
    await this.changeIfStill(device, (current) => ({
      ...current,
      tokenSha256: current.nextToken?.sha256 ?? current.tokenSha256,
      nextToken: null,
      tokenIssuedAt: now,
    }));
    return { device: summary(device), replacementToken: null };
  }

  /**
   * Applies the change only if the device's tokens are still the ones just checked and it
   * was not revoked meanwhile. Otherwise another request already changed them, or
   * `t3-voice devices revoke` ran: the token was valid when checked, so the request goes on.
   */
  private async changeIfStill(
    seen: PairedDevice,
    change: (device: PairedDevice) => PairedDevice,
  ): Promise<boolean> {
    let changed = false;
    await this.store.updateDevices((devices) =>
      devices.map((device) => {
        const unchanged =
          device.id === seen.id &&
          device.revokedAt === null &&
          device.tokenSha256 === seen.tokenSha256 &&
          device.nextToken?.sha256 === seen.nextToken?.sha256;
        if (!unchanged) return device;
        changed = true;
        return change(device);
      }),
    );
    return changed;
  }
}

function summary(device: PairedDevice): Device {
  return { id: device.id, name: device.name };
}

function newToken(): string {
  return randomSecret(32);
}

/** Short, so it is easy to type in `t3-voice devices revoke <id>`. */
function newDeviceId(devices: PairedDevice[]): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!devices.some((device) => device.id === id)) return id;
  }
}
