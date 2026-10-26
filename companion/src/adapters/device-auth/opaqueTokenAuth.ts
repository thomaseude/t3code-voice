// DeviceAuth with the companion's own opaque tokens: random values it gives to a device
// when it pairs. Only their SHA-256 is stored. A token is long and random, so a plain
// hash is enough: there is no weak password to protect with a slow hash.

import { createHash, timingSafeEqual } from "node:crypto";
import type { ConfigStore } from "../../ports/configStore.ts";
import type { Device, DeviceAuth } from "../../ports/deviceAuth.ts";

export class OpaqueTokenAuth implements DeviceAuth {
  private readonly store: ConfigStore;

  constructor(store: ConfigStore) {
    this.store = store;
  }

  async authenticate(token: string): Promise<Device | null> {
    const hash = createHash("sha256").update(token).digest();
    // Read on every request, so a revocation applies to the next one.
    for (const device of await this.store.loadDevices()) {
      if (device.revokedAt !== null) continue;
      const stored = Buffer.from(device.tokenSha256, "hex");
      if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
        return { id: device.id, name: device.name };
      }
    }
    return null;
  }
}
