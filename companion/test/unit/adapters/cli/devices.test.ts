import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { listDevices, revokeDevice } from "../../../../src/adapters/cli/devices.ts";
import { pairedDevice } from "../../builders.ts";
import { InMemoryConfigStore } from "../../fakePorts.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function storeWithDevices() {
  const store = new InMemoryConfigStore();
  store.devices = [
    pairedDevice({
      id: "3f9a2c1b",
      name: "iPhone de Thomas",
      pairedAt: "2026-10-26T10:00:00.000Z",
    }),
    pairedDevice({
      id: "77aa0e12",
      name: "Old iPhone",
      pairedAt: "2026-09-01T08:00:00.000Z",
      revokedAt: "2026-10-20T09:00:00.000Z",
    }),
  ];
  return store;
}

describe("t3-voice devices", () => {
  test("list shows every device with its id, name and dates, never a token hash", async () => {
    const store = storeWithDevices();
    const lines: string[] = [];

    await listDevices({ store, out: (line) => lines.push(line) });

    assert.deepEqual(lines, [
      "Paired devices (1 active, 1 revoked):",
      "  3f9a2c1b  iPhone de Thomas  paired 2026-10-26",
      "  77aa0e12  Old iPhone        paired 2026-09-01, revoked 2026-10-20",
    ]);
  });

  test("list says when no device was ever paired", async () => {
    const lines: string[] = [];

    await listDevices({ store: new InMemoryConfigStore(), out: (line) => lines.push(line) });

    assert.deepEqual(lines, ['No paired device. Run "t3-voice pair" to pair one.']);
  });

  test("revoke marks the device revoked and drops its pending replacement token", async () => {
    const store = storeWithDevices();
    store.devices[0] = {
      ...(store.devices[0] ?? pairedDevice()),
      nextToken: { sha256: "b".repeat(64), issuedAt: "2026-10-26T11:00:00.000Z" },
    };
    const lines: string[] = [];

    await revokeDevice({
      store,
      id: "3f9a2c1b",
      now: () => NOW.getTime(),
      out: (line) => lines.push(line),
    });

    assert.equal(store.devices[0]?.revokedAt, "2026-10-26T12:00:00.000Z");
    assert.equal(store.devices[0]?.nextToken, null);
    assert.equal(
      store.devices[1]?.revokedAt,
      "2026-10-20T09:00:00.000Z",
      "other devices unchanged",
    );
    assert.deepEqual(lines, [
      'Revoked "iPhone de Thomas" (3f9a2c1b). Its token is refused from its next request.',
    ]);
  });

  test("revoking a revoked device keeps its first revocation date", async () => {
    const store = storeWithDevices();
    const lines: string[] = [];

    await revokeDevice({
      store,
      id: "77aa0e12",
      now: () => NOW.getTime(),
      out: (line) => lines.push(line),
    });

    assert.equal(store.devices[1]?.revokedAt, "2026-10-20T09:00:00.000Z");
    assert.deepEqual(lines, ['"Old iPhone" (77aa0e12) was already revoked.']);
  });

  test("revoke refuses an unknown id", async () => {
    const store = storeWithDevices();

    await assert.rejects(
      revokeDevice({ store, id: "nope", now: () => NOW.getTime(), out: () => {} }),
      /No device "nope"; "t3-voice devices list" shows the ids/,
    );
  });
});
