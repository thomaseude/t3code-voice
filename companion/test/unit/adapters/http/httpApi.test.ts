// Seam 2: real HTTP requests against the companion's API, built on in-memory fakes.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { revokeDevice } from "../../../../src/adapters/cli/devices.ts";
import { OpaqueTokenAuth } from "../../../../src/adapters/device-auth/opaqueTokenAuth.ts";
import { type HttpApiOptions, startHttpApi } from "../../../../src/adapters/http/httpApi.ts";
import { openPairingWindow, PairingDesk } from "../../../../src/core/pairing.ts";
import type { PairedDevice } from "../../../../src/ports/deviceAuth.ts";
import { pairedDevice } from "../../builders.ts";
import { FakeDeviceAuth, InMemoryConfigStore } from "../../fakePorts.ts";

// Every route of the spec (#15, "HTTP API"). POST /pair takes a pairing code instead of a
// token, and answers 401 the same way while no pairing window is open.
const ROUTES: Array<[string, string]> = [
  ["POST", "/pair"],
  ["POST", "/sessions"],
  ["POST", "/sessions/s1/events"],
  ["DELETE", "/sessions/s1"],
  ["PUT", "/devices/me/push"],
  ["POST", "/requests/r1/respond"],
  ["GET", "/activity"],
];

let stopServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  await stopServer?.();
  stopServer = null;
});

async function startApi(options: Partial<HttpApiOptions> = {}): Promise<string> {
  const api = await startHttpApi({
    host: "127.0.0.1",
    port: 0,
    auth: new FakeDeviceAuth(),
    pairing: new PairingDesk({ store: new InMemoryConfigStore(), auth: new FakeDeviceAuth() }),
    activity: () => ({ running: [], finished: [] }),
    ...options,
  });
  stopServer = api.close;
  return api.url;
}

describe("HTTP API authentication", () => {
  test("every route answers 401 with no detail when the request has no token", async () => {
    const url = await startApi();

    for (const [method, path] of ROUTES) {
      const response = await fetch(`${url}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(await response.text(), "", `${method} ${path}`);
    }
  });

  test("an unknown token and a malformed header are rejected like a missing token", async () => {
    const auth = new FakeDeviceAuth();
    auth.addDevice("good-token");
    const url = await startApi({ auth });

    for (const authorization of [
      "Bearer wrong-token",
      "good-token",
      "Basic good-token",
      "Bearer",
    ]) {
      const response = await fetch(`${url}/activity`, { headers: { authorization } });
      assert.equal(response.status, 401, authorization);
      assert.equal(await response.text(), "", authorization);
    }
  });

  test("a valid token gets past the check", async () => {
    const auth = new FakeDeviceAuth();
    auth.addDevice("good-token");
    const url = await startApi({ auth });

    const response = await fetch(`${url}/activity`, {
      headers: { authorization: "Bearer good-token" },
    });
    assert.equal(response.status, 200);
  });

  test("a revoked token is rejected on the next request", async () => {
    const auth = new FakeDeviceAuth();
    auth.addDevice("good-token");
    const url = await startApi({ auth });
    const request = () =>
      fetch(`${url}/activity`, { headers: { authorization: "Bearer good-token" } });

    assert.equal((await request()).status, 200);
    auth.revoke("good-token");
    assert.equal((await request()).status, 401);
  });
});

describe("HTTP API with opaque device tokens", () => {
  const TOKEN = "kq3V8o2Yc1rJm0bT6wXpZf4hN9sL7dAeGuQiRyEvOtM";

  const storedDevice = (fields: Partial<PairedDevice> = {}) =>
    pairedDevice({ tokenSha256: createHash("sha256").update(TOKEN).digest("hex"), ...fields });

  async function requestWith(devices: PairedDevice[], token: string): Promise<number> {
    const store = new InMemoryConfigStore();
    store.devices = devices;
    const url = await startApi({ auth: new OpaqueTokenAuth(store) });
    const response = await fetch(`${url}/activity`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await response.body?.cancel();
    return response.status;
  }

  test("a token whose hash is in the device list gets past the check", async () => {
    assert.equal(await requestWith([storedDevice()], TOKEN), 200);
  });

  test("the stored hash is not a token", async () => {
    assert.equal(await requestWith([storedDevice()], storedDevice().tokenSha256), 401);
  });

  test("a revoked device is rejected", async () => {
    const revoked = storedDevice({ revokedAt: "2026-10-26T11:00:00.000Z" });
    assert.equal(await requestWith([revoked], TOKEN), 401);
  });

  test("nothing gets past the check while no device is paired", async () => {
    assert.equal(await requestWith([], TOKEN), 401);
  });
});

describe("HTTP API rate limits", () => {
  const generous = { limit: 100, windowMs: 60_000 };

  test("an IP that sends too many requests gets 429, even without a token", async () => {
    const url = await startApi({
      limits: { perIp: { limit: 2, windowMs: 60_000 }, perDevice: generous },
    });

    assert.equal((await fetch(`${url}/activity`)).status, 401);
    assert.equal((await fetch(`${url}/activity`)).status, 401);
    const limited = await fetch(`${url}/activity`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(await limited.text(), "");
  });

  test("the client IP comes from the configured header, so callers behind a tunnel are counted apart", async () => {
    const url = await startApi({
      clientIpHeader: "cf-connecting-ip",
      limits: { perIp: { limit: 1, windowMs: 60_000 }, perDevice: generous },
    });
    const from = (ip: string) => fetch(`${url}/activity`, { headers: { "cf-connecting-ip": ip } });

    assert.equal((await from("203.0.113.1")).status, 401);
    assert.equal((await from("203.0.113.2")).status, 401);
    assert.equal((await from("203.0.113.1")).status, 429);
  });

  test("without a configured header, the header is ignored", async () => {
    const url = await startApi({
      limits: { perIp: { limit: 1, windowMs: 60_000 }, perDevice: generous },
    });
    const from = (ip: string) => fetch(`${url}/activity`, { headers: { "cf-connecting-ip": ip } });

    assert.equal((await from("203.0.113.1")).status, 401);
    assert.equal((await from("203.0.113.2")).status, 429);
  });

  test("IPv6 callers in the same /64 share one count", async () => {
    const url = await startApi({
      clientIpHeader: "cf-connecting-ip",
      limits: { perIp: { limit: 1, windowMs: 60_000 }, perDevice: generous },
    });
    const from = (ip: string) => fetch(`${url}/activity`, { headers: { "cf-connecting-ip": ip } });

    assert.equal((await from("2001:db8:1:2::1")).status, 401);
    assert.equal((await from("2001:db8:1:2:ffff:ffff:ffff:ffff")).status, 429);
    assert.equal((await from("2001:db8:1:3::1")).status, 401);
  });

  test("a header that lists several IPs counts the last one, which the proxy added", async () => {
    const url = await startApi({
      clientIpHeader: "x-forwarded-for",
      limits: { perIp: { limit: 1, windowMs: 60_000 }, perDevice: generous },
    });
    const from = (ip: string) => fetch(`${url}/activity`, { headers: { "x-forwarded-for": ip } });

    assert.equal((await from("198.51.100.1, 203.0.113.9")).status, 401);
    assert.equal((await from("198.51.100.2, 203.0.113.9")).status, 429);
  });

  test("warns once when a proxy forwards requests but no client IP header is configured", async () => {
    const logs: string[] = [];
    const url = await startApi({ log: (line) => logs.push(line) });
    const viaProxy = () =>
      fetch(`${url}/activity`, { headers: { "cf-connecting-ip": "203.0.113.1" } });

    await viaProxy();
    await viaProxy();
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /server\.clientIpHeader/);
  });

  test("a device that sends too many requests gets 429 from any IP; other devices are not affected", async () => {
    const auth = new FakeDeviceAuth();
    auth.addDevice("token-a", { id: "a", name: "iPhone A" });
    auth.addDevice("token-b", { id: "b", name: "iPhone B" });
    const url = await startApi({
      auth,
      clientIpHeader: "cf-connecting-ip",
      limits: { perIp: generous, perDevice: { limit: 2, windowMs: 60_000 } },
    });
    const request = (token: string, ip: string) =>
      fetch(`${url}/activity`, {
        headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip },
      });

    assert.equal((await request("token-a", "203.0.113.1")).status, 200);
    assert.equal((await request("token-a", "203.0.113.2")).status, 200);
    assert.equal((await request("token-a", "203.0.113.3")).status, 429);
    assert.equal((await request("token-b", "203.0.113.1")).status, 200);
  });

  test("the window is measured with the injected clock", async () => {
    const clock = { now: 0 };
    const url = await startApi({
      now: () => clock.now,
      limits: { perIp: { limit: 1, windowMs: 60_000 }, perDevice: generous },
    });

    assert.equal((await fetch(`${url}/activity`)).status, 401);
    clock.now = 59_000;
    const limited = await fetch(`${url}/activity`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "1");
    clock.now = 60_000;
    assert.equal((await fetch(`${url}/activity`)).status, 401);
  });
});

interface PairedResponse {
  token: string;
  device: { id: string; name: string };
}

describe("Pairing (POST /pair)", () => {
  async function startPairingApi(options: Partial<HttpApiOptions> = {}) {
    const clock = { now: Date.parse("2026-10-26T12:00:00.000Z") };
    const store = new InMemoryConfigStore();
    const auth = new FakeDeviceAuth();
    const pairing = new PairingDesk({ store, auth, now: () => clock.now });
    const url = await startApi({ auth, pairing, ...options });
    const openWindow = () => openPairingWindow(store, clock.now);
    const pair = (body: unknown) =>
      fetch(`${url}/pair`, { method: "POST", body: JSON.stringify(body) });
    const activity = (token: string) =>
      fetch(`${url}/activity`, { headers: { authorization: `Bearer ${token}` } });
    return { url, clock, store, auth, openWindow, pair, activity };
  }

  test("a valid code during the window gives a device token that passes the check", async () => {
    const api = await startPairingApi();
    const { code } = await api.openWindow();

    const response = await api.pair({ code, name: "iPhone de Thomas" });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as PairedResponse;
    assert.equal(body.device.name, "iPhone de Thomas");
    assert.equal(typeof body.token, "string");
    assert.equal((await api.activity(body.token)).status, 200);
  });

  test("the window is closed by default: no code is accepted before `t3-voice pair`", async () => {
    const api = await startPairingApi();

    const response = await api.pair({ code: "AAAAAAAAAAAAAAAAAAAAAA", name: "iPhone" });

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
  });

  test("a code works once", async () => {
    const api = await startPairingApi();
    const { code } = await api.openWindow();

    assert.equal((await api.pair({ code, name: "iPhone" })).status, 200);
    const second = await api.pair({ code, name: "Another phone" });
    assert.equal(second.status, 401);
    assert.equal(await second.text(), "");
    assert.equal(api.auth.devices.size, 1);
  });

  test("two requests sent at the same time with the same code pair one device", async () => {
    const api = await startPairingApi();
    const { code } = await api.openWindow();
    // A slow disk: both requests read the window before either one closes it.
    const load = api.store.loadPairingWindow.bind(api.store);
    api.store.loadPairingWindow = async () => {
      const window = await load();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return window;
    };

    const statuses = await Promise.all([
      api.pair({ code, name: "iPhone" }).then((response) => response.status),
      api.pair({ code, name: "iPhone" }).then((response) => response.status),
    ]);

    assert.deepEqual(statuses.sort(), [200, 401]);
    assert.equal(api.auth.devices.size, 1);
  });

  test("a code expires 5 minutes after the window opened", async () => {
    const api = await startPairingApi();
    const { code } = await api.openWindow();

    api.clock.now += 5 * 60_000;
    const response = await api.pair({ code, name: "iPhone" });

    assert.equal(response.status, 401);
    assert.equal(api.auth.devices.size, 0);
  });

  test("a code still works just before the window closes", async () => {
    const api = await startPairingApi();
    const { code } = await api.openWindow();

    api.clock.now += 5 * 60_000 - 1;
    assert.equal((await api.pair({ code, name: "iPhone" })).status, 200);
  });

  test("a new window replaces the code of the previous one", async () => {
    const api = await startPairingApi();
    const first = await api.openWindow();
    const second = await api.openWindow();

    assert.equal((await api.pair({ code: first.code, name: "iPhone" })).status, 401);
    assert.equal((await api.pair({ code: second.code, name: "iPhone" })).status, 200);
  });

  describe("failed attempts are limited for all callers together", () => {
    // Each attempt comes from its own address, so the per-IP limit never applies.
    async function startBehindTunnel() {
      const api = await startPairingApi({ clientIpHeader: "cf-connecting-ip" });
      let caller = 0;
      const pairFromNewIp = (code: string) => {
        caller++;
        return fetch(`${api.url}/pair`, {
          method: "POST",
          headers: { "cf-connecting-ip": `198.51.100.${caller}` },
          body: JSON.stringify({ code, name: "iPhone" }),
        });
      };
      return { ...api, pairFromNewIp };
    }

    test("after 10 wrong codes in 10 minutes, even the right code gets 429", async () => {
      const api = await startBehindTunnel();
      const { code } = await api.openWindow();

      for (let attempt = 1; attempt <= 10; attempt++) {
        assert.equal((await api.pairFromNewIp("wrong-code")).status, 401, `attempt ${attempt}`);
      }
      const limited = await api.pairFromNewIp(code);

      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "600");
      assert.equal(await limited.text(), "");
      assert.equal(api.auth.devices.size, 0);
    });

    test("9 wrong codes do not block the right one", async () => {
      const api = await startBehindTunnel();
      const { code } = await api.openWindow();

      for (let attempt = 1; attempt <= 9; attempt++) await api.pairFromNewIp("wrong-code");

      assert.equal((await api.pairFromNewIp(code)).status, 200);
    });

    test("pairing works again once the 10 minutes are over", async () => {
      const api = await startBehindTunnel();
      for (let attempt = 1; attempt <= 10; attempt++) await api.pairFromNewIp("wrong-code");

      api.clock.now += 10 * 60_000;
      const { code } = await api.openWindow();

      assert.equal((await api.pairFromNewIp(code)).status, 200);
    });
  });
});

describe("Device tokens issued by pairing", () => {
  const DAY = 86_400_000;

  async function pairedPhone() {
    const clock = { now: Date.parse("2026-10-26T12:00:00.000Z") };
    const store = new InMemoryConfigStore();
    const auth = new OpaqueTokenAuth(store, { now: () => clock.now });
    const url = await startApi({
      auth,
      pairing: new PairingDesk({ store, auth, now: () => clock.now }),
    });
    const { code } = await openPairingWindow(store, clock.now);
    const paired = await fetch(`${url}/pair`, {
      method: "POST",
      body: JSON.stringify({ code, name: "iPhone de Thomas" }),
    });
    const { token } = (await paired.json()) as PairedResponse;
    const activity = (bearer: string) =>
      fetch(`${url}/activity`, { headers: { authorization: `Bearer ${bearer}` } });
    return { clock, store, token, activity };
  }

  test("the device list keeps a hash of the token, never the token", async () => {
    const phone = await pairedPhone();

    assert.equal((await phone.activity(phone.token)).status, 200);
    const saved = JSON.stringify(phone.store.devices);
    assert.ok(!saved.includes(phone.token));
    assert.equal(phone.store.devices[0]?.name, "iPhone de Thomas");
    assert.equal(
      phone.store.devices[0]?.tokenSha256,
      createHash("sha256").update(phone.token).digest("hex"),
    );
  });

  test("a token younger than 30 days is not replaced", async () => {
    const phone = await pairedPhone();

    phone.clock.now += 30 * DAY - 1;
    const response = await phone.activity(phone.token);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("t3voice-token"), null);
  });

  test("a 30-day-old token gets a replacement; the old one works until the new one is used", async () => {
    const phone = await pairedPhone();
    phone.clock.now += 30 * DAY;

    const rotated = await phone.activity(phone.token);
    const replacement = rotated.headers.get("t3voice-token") ?? "";

    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers.get("cache-control"), "no-store");
    assert.ok(replacement !== "" && replacement !== phone.token);
    const first = await phone.activity(replacement);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("t3voice-token"), null);
    assert.equal((await phone.activity(phone.token)).status, 401);
    assert.equal((await phone.activity(replacement)).status, 200);
  });

  test("requests sent together with the old token get one replacement", async () => {
    const phone = await pairedPhone();
    phone.clock.now += 30 * DAY;

    const responses = await Promise.all([phone.activity(phone.token), phone.activity(phone.token)]);

    const replacements = responses.map((response) => response.headers.get("t3voice-token"));
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.equal(replacements.filter((token) => token !== null).length, 1);
  });

  test("a device that missed its replacement gets a new one a minute later", async () => {
    const phone = await pairedPhone();
    phone.clock.now += 30 * DAY;
    const lost = (await phone.activity(phone.token)).headers.get("t3voice-token") ?? "";

    phone.clock.now += 60_000;
    const again = await phone.activity(phone.token);
    const replacement = again.headers.get("t3voice-token") ?? "";

    assert.equal(again.status, 200);
    assert.ok(replacement !== "" && replacement !== lost);
    assert.equal((await phone.activity(lost)).status, 401, "only the latest replacement counts");
    assert.equal((await phone.activity(replacement)).status, 200);
  });

  test("`t3-voice devices revoke` rejects the token and its pending replacement at the next request", async () => {
    const phone = await pairedPhone();
    phone.clock.now += 30 * DAY;
    const replacement = (await phone.activity(phone.token)).headers.get("t3voice-token") ?? "";
    const id = phone.store.devices[0]?.id ?? "";

    await revokeDevice({ store: phone.store, id, now: new Date(phone.clock.now), out: () => {} });

    assert.equal((await phone.activity(phone.token)).status, 401);
    assert.equal((await phone.activity(replacement)).status, 401);
  });
});
