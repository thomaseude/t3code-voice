// `t3-voice devices list|revoke`: the iPhones paired with this companion.

import type { ConfigStore } from "../../ports/configStore.ts";
import type { PairedDevice } from "../../ports/deviceAuth.ts";

export async function listDevices({ store, out }: { store: ConfigStore; out(line: string): void }) {
  const devices = await store.loadDevices();
  if (devices.length === 0) {
    out('No paired device. Run "t3-voice pair" to pair one.');
    return;
  }
  const revoked = devices.filter((device) => device.revokedAt !== null).length;
  out(`Paired devices (${devices.length - revoked} active, ${revoked} revoked):`);
  const nameWidth = Math.max(...devices.map((device) => device.name.length));
  for (const device of devices) {
    const dates = [`paired ${day(device.pairedAt)}`];
    if (device.revokedAt !== null) dates.push(`revoked ${day(device.revokedAt)}`);
    out(`  ${device.id}  ${device.name.padEnd(nameWidth)}  ${dates.join(", ")}`);
  }
}

export async function revokeDevice({
  store,
  id,
  now = new Date(),
  out,
}: {
  store: ConfigStore;
  id: string;
  now?: Date;
  out(line: string): void;
}) {
  let found: PairedDevice | undefined;
  await store.updateDevices((devices) =>
    devices.map((device) => {
      if (device.id !== id) return device;
      found = device;
      if (device.revokedAt !== null) return device;
      return { ...device, revokedAt: now.toISOString(), nextToken: null };
    }),
  );
  if (found === undefined) {
    throw new Error(`No device "${id}"; "t3-voice devices list" shows the ids.`);
  }
  if (found.revokedAt !== null) {
    out(`"${found.name}" (${id}) was already revoked.`);
    return;
  }
  out(`Revoked "${found.name}" (${id}). Its token is refused from its next request.`);
}

function day(isoDate: string): string {
  return isoDate.slice(0, 10);
}
