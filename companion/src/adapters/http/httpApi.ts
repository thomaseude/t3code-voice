// Driving adapter: the HTTP API the iPhone app calls (JSON, behind HTTPS at the tunnel).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type RateDecision, RateLimiter } from "../../core/rateLimiter.ts";
import type { DeviceAuth } from "../../ports/deviceAuth.ts";

export interface RateLimit {
  limit: number;
  windowMs: number;
}

export interface HttpApiOptions {
  host: string;
  port: number;
  auth: DeviceAuth;
  /**
   * Header that carries the caller's IP when a local proxy forwards the request, e.g.
   * "cf-connecting-ip" behind a Cloudflare Tunnel. Read only on loopback connections.
   */
  clientIpHeader?: string;
  limits?: { perIp: RateLimit; perDevice: RateLimit };
  /** Current time in milliseconds; injectable for tests. */
  now?: () => number;
}

export const DEFAULT_LIMITS = {
  perIp: { limit: 120, windowMs: 60_000 },
  perDevice: { limit: 60, windowMs: 60_000 },
};

export interface RunningHttpApi {
  url: string;
  close(): Promise<void>;
}

export async function startHttpApi(options: HttpApiOptions): Promise<RunningHttpApi> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? Date.now;
  const perIp = new RateLimiter({ ...limits.perIp, now });
  const perDevice = new RateLimiter({ ...limits.perDevice, now });

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // For example a device list with loose permissions. The caller learns nothing.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`t3-voice: request failed: ${message}\n`);
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
    // Counted before the token check, so guessing tokens is throttled too.
    if (refused(response, perIp.take(clientIp(request, options.clientIpHeader)))) return;

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

function clientIp(request: IncomingMessage, header: string | undefined): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  // Only a local proxy (cloudflared) may say who the caller is; anyone else could lie.
  if (header === undefined || !isLoopback(peer)) return peer;
  const forwarded = request.headers[header.toLowerCase()];
  return typeof forwarded === "string" && forwarded !== "" ? forwarded : peer;
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
