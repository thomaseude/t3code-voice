// Seam 2: real HTTP requests against the companion's API, built on in-memory fakes.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { OpaqueTokenAuth } from "../../../../src/adapters/device-auth/opaqueTokenAuth.ts";
import { type HttpApiOptions, startHttpApi } from "../../../../src/adapters/http/httpApi.ts";
import type { PairedDevice } from "../../../../src/ports/deviceAuth.ts";
import { pairedDevice } from "../../builders.ts";
import { FakeDeviceAuth, InMemoryConfigStore } from "../../fakePorts.ts";

// Every route of the spec (#15, "HTTP API"). POST /pair stays closed until #18 opens a
// pairing window.
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

    // No route is served yet (#18 adds the first ones), so a checked request ends in a 404.
    const response = await fetch(`${url}/activity`, {
      headers: { authorization: "Bearer good-token" },
    });
    assert.equal(response.status, 404);
  });

  test("a revoked token is rejected on the next request", async () => {
    const auth = new FakeDeviceAuth();
    auth.addDevice("good-token");
    const url = await startApi({ auth });
    const request = () =>
      fetch(`${url}/activity`, { headers: { authorization: "Bearer good-token" } });

    assert.equal((await request()).status, 404);
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
    assert.equal(await requestWith([storedDevice()], TOKEN), 404);
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

    assert.equal((await request("token-a", "203.0.113.1")).status, 404);
    assert.equal((await request("token-a", "203.0.113.2")).status, 404);
    assert.equal((await request("token-a", "203.0.113.3")).status, 429);
    assert.equal((await request("token-b", "203.0.113.1")).status, 404);
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
