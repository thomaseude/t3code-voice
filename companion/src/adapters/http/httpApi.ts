// Driving adapter: the HTTP API the iPhone app calls. It serves JSON over plain HTTP on
// loopback; the tunnel in front of it adds HTTPS.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, isIPv6 } from "node:net";
import type { DevicePairing } from "../../core/pairing.ts";
import { type RateDecision, RateLimiter } from "../../core/rateLimiter.ts";
import { scrubSecrets } from "../../core/secrets.ts";
import type { ApiServerOptions, RunningApiServer } from "../../ports/apiServer.ts";
import type { DeviceAuth } from "../../ports/deviceAuth.ts";

export interface RateLimit {
  limit: number;
  windowMs: number;
}

export interface HttpApiOptions extends ApiServerOptions {
  auth: DeviceAuth;
  devicePairing: DevicePairing;
  limits?: { perIp: RateLimit; perDevice: RateLimit };
  /** Current time in milliseconds; injectable for tests. */
  now?: () => number;
  /** Where operational warnings go; stderr by default. */
  log?: (line: string) => void;
}

const DEFAULT_LIMITS = {
  perIp: { limit: 120, windowMs: 60_000 },
  perDevice: { limit: 60, windowMs: 60_000 },
};

export async function startHttpApi(options: HttpApiOptions): Promise<RunningApiServer> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const perIp = new RateLimiter({ ...limits.perIp, now: options.now });
  const perDevice = new RateLimiter({ ...limits.perDevice, now: options.now });
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let warnedAboutProxy = false;

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // For example a device list with loose permissions. The caller learns nothing.
      const message = error instanceof Error ? error.message : String(error);
      log(`t3-voice: request failed: ${scrubSecrets(message)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  // Slow clients must not hold connections open.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const { address, port } = server.address() as AddressInfo;

  return {
    url: `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const peer = request.socket.remoteAddress ?? "unknown";
    const fromProxy = isLoopback(peer) && hasForwardingHeader(request);
    if (options.clientIpHeader === undefined && fromProxy && !warnedAboutProxy) {
      warnedAboutProxy = true;
      log(
        't3-voice: requests come through a proxy, but "server.clientIpHeader" is not set, ' +
          "so every caller shares one per-IP limit. Set it (cf-connecting-ip behind Cloudflare).",
      );
    }
    // Counted before the token check, so guessing tokens is throttled too.
    const ip = clientIp(request, peer, options.clientIpHeader);
    if (refused(response, perIp.take(rateKey(ip)))) return;

    const path = new URL(request.url ?? "/", "http://companion").pathname;
    const route = `${request.method} ${path}`;
    // The only route a device calls before it has a token.
    if (route === "POST /pair") return pair(request, response);

    const token = bearerToken(request);
    const authentication = token === null ? null : await options.auth.authenticate(token);
    if (authentication === null) return unauthorized(response);
    if (refused(response, perDevice.take(authentication.device.id))) return;
    if (authentication.replacementToken !== null) {
      // The app stores it and sends it from the next request on.
      response.setHeader("t3voice-token", authentication.replacementToken);
      response.setHeader("cache-control", "no-store");
    }

    switch (route) {
      case "POST /sessions":
        return openSession(request, response, authentication.device.id);
      case "GET /activity": {
        const activity = options.activity();
        if (activity === null) return sendJson(response, 503, { error: "t3_unavailable" });
        return sendJson(response, 200, activity);
      }
    }
    const sessionId = /^\/sessions\/([A-Za-z0-9_-]{1,64})$/.exec(path)?.[1];
    if (request.method === "DELETE" && sessionId !== undefined) {
      const closed = await options.voiceSessions.close(authentication.device.id, sessionId);
      if (!closed) return sendJson(response, 404, { error: "not_found" });
      response.writeHead(204);
      return response.end();
    }
    return sendJson(response, 404, { error: "not_found" });
  }

  async function openSession(request: IncomingMessage, response: ServerResponse, deviceId: string) {
    const body = await readJson(request, MAX_OFFER_BYTES);
    const sdpOffer = body?.sdp;
    if (typeof sdpOffer !== "string" || !sdpOffer.startsWith("v=0")) {
      return sendJson(response, 400, { error: "invalid_offer" });
    }
    const timeZone = typeof body?.timeZone === "string" ? body.timeZone : null;
    const result = await options.voiceSessions.open(deviceId, { sdpOffer, timeZone });
    switch (result.status) {
      case "opened":
        response.writeHead(201, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        return response.end(JSON.stringify({ sessionId: result.sessionId, sdp: result.sdpAnswer }));
      case "unavailable":
        return sendJson(response, 503, { error: "voice_unavailable" });
      case "failed":
        return sendJson(response, 502, { error: "voice_engine_failed" });
    }
  }

  async function pair(request: IncomingMessage, response: ServerResponse) {
    const body = await readJson(request);
    const code = typeof body?.code === "string" ? body.code : "";
    const result = await options.devicePairing.pair(code, deviceName(body?.name));
    if (result.status === "limited") {
      return refused(response, { allowed: false, retryAfterMs: result.retryAfterMs });
    }
    if (result.status === "refused") return unauthorized(response);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ token: result.token, device: result.device }));
  }
}

/** No detail: a caller must not learn whether a token or code exists, expired or was revoked. */
function unauthorized(response: ServerResponse) {
  response.writeHead(401);
  response.end();
}

const MAX_BODY_BYTES = 4096;
/** A WebRTC offer with its ICE candidates takes a few kilobytes. */
const MAX_OFFER_BYTES = 64 * 1024;

/** The JSON body, or null when it is missing, too big or not JSON. */
// biome-ignore lint/suspicious/noExplicitAny: the caller checks the fields it needs.
async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<any | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function deviceName(value: unknown): string {
  // Printed by `t3-voice devices list`: no control characters, which could rewrite the terminal.
  const name = typeof value === "string" ? value.replace(/\p{Cc}/gu, "").trim() : "";
  return name === "" ? "iPhone" : name.slice(0, 64);
}

/** Answers 429 when the limiter refused the request. */
function refused(response: ServerResponse, decision: RateDecision): boolean {
  if (decision.allowed) return false;
  response.writeHead(429, { "retry-after": String(Math.ceil(decision.retryAfterMs / 1000)) });
  response.end();
  return true;
}

function clientIp(request: IncomingMessage, peer: string, header: string | undefined): string {
  // Only a local proxy (cloudflared) may say who the caller is; anyone else could lie.
  if (header === undefined || !isLoopback(peer)) return peer;
  const forwarded = request.headers[header.toLowerCase()];
  if (typeof forwarded !== "string") return peer;
  // A list ("client, proxy") may start with values the caller wrote; the proxy appends
  // the address it saw, so only the last one can be trusted.
  const last = forwarded.split(",").at(-1)?.trim() ?? "";
  return last === "" ? peer : last;
}

/** IPv6 callers usually hold a whole /64, so they are counted by that prefix. */
function rateKey(ip: string): string {
  const address = ip.split("%")[0] ?? ip;
  if (!isIPv6(address) || address.includes(".")) return ip;
  const [head = "", tail] = address.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = Array(8 - headGroups.length - tailGroups.length).fill("0");
  const groups = tail === undefined ? headGroups : [...headGroups, ...zeros, ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

function hasForwardingHeader(request: IncomingMessage): boolean {
  const headers = request.headers;
  return (
    headers["cf-connecting-ip"] !== undefined ||
    headers["x-forwarded-for"] !== undefined ||
    headers.forwarded !== undefined
  );
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function bearerToken(request: IncomingMessage): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
