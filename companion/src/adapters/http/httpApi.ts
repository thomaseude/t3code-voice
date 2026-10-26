// Driving adapter: the HTTP API the iPhone app calls (JSON, behind HTTPS at the tunnel).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, isIPv6 } from "node:net";
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

    const token = bearerToken(request);
    const device = token === null ? null : await options.auth.authenticate(token);
    if (device === null) {
      // No detail: a caller must not learn whether the token exists or was revoked.
      response.writeHead(401);
      response.end();
      return;
    }
    if (refused(response, perDevice.take(device.id))) return;

    sendJson(response, 404, { error: "not_found" });
  }
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
