// The few HTTP calls the companion makes to T3: the environment descriptor, the pairing
// token exchange, and the short-lived WebSocket ticket.

import { REQUIRED_T3_SCOPES, type T3Session } from "../../ports/t3Backend.ts";
import type { EnvironmentDescriptor } from "./compatibility.ts";
import type { WireJson } from "./wire.ts";

const REQUEST_TIMEOUT_MS = 10_000;

export class T3HttpError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "T3HttpError";
    this.status = status;
  }
}

export async function fetchDescriptor(baseUrl: string): Promise<EnvironmentDescriptor> {
  const body = await request(baseUrl, "/.well-known/t3/environment", { method: "GET" });
  if (
    typeof body?.serverVersion !== "string" ||
    typeof body?.orchestrationProtocolVersion !== "number"
  ) {
    throw new T3HttpError("The T3 environment descriptor has an unexpected shape.");
  }
  return {
    serverVersion: body.serverVersion,
    orchestrationProtocolVersion: body.orchestrationProtocolVersion,
    capabilities: isObject(body.capabilities) ? body.capabilities : {},
  };
}

/**
 * Accepts a pairing link (`https://host/pair#token=...`) or the bare credential, and
 * returns the credential. The link's host is ignored: the companion always talks to the
 * configured T3 URL.
 */
export function parsePairingCredential(input: string): string {
  const text = input.trim();
  const match = text.match(/[#?&]token=([^&\s]+)/);
  const credential = match ? decodeURIComponent(match[1] ?? "") : text;
  if (!/^[A-Za-z0-9._~-]+$/.test(credential)) {
    throw new Error("This does not look like a T3 pairing link or pairing token.");
  }
  return credential;
}

/** Exchanges a one-time pairing credential for a bearer token (RFC 8693 token exchange). */
export async function exchangePairingCredential(
  baseUrl: string,
  credential: string,
  now: Date = new Date(),
): Promise<T3Session> {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    // T3 grants at most what the pairing link allows.
    scope: REQUIRED_T3_SCOPES.join(" "),
    client_label: "t3-voice companion",
  });
  const body = await request(baseUrl, "/oauth/token", { method: "POST", body: form });
  if (typeof body?.access_token !== "string" || body.token_type !== "Bearer") {
    throw new T3HttpError("T3 answered the pairing exchange with an unexpected token.");
  }
  const expiresInSeconds = typeof body.expires_in === "number" ? body.expires_in : 0;
  return {
    token: body.access_token,
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
  };
}

/** Gets a single-use ticket to open one WebSocket. The bearer token never goes in a URL. */
export async function issueWebSocketTicket(baseUrl: string, token: string): Promise<string> {
  const headers = { authorization: `Bearer ${token}` };
  let body: WireJson;
  try {
    body = await request(baseUrl, "/api/auth/websocket-ticket/rpc", { method: "POST", headers });
  } catch (error) {
    // Servers older than ticket audiences (T3 0.1.0) only have the bare route.
    if (!(error instanceof T3HttpError && error.status === 404)) throw error;
    body = await request(baseUrl, "/api/auth/websocket-ticket", { method: "POST", headers });
  }
  if (typeof body?.ticket !== "string") {
    throw new T3HttpError("T3 answered the WebSocket ticket request with an unexpected body.");
  }
  return body.ticket;
}

async function request(baseUrl: string, path: string, init: RequestInit): Promise<WireJson> {
  const url = new URL(path, baseUrl);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    // Only the URL without query is reported: no credential ever travels in these paths.
    throw new T3HttpError(`Cannot reach T3 at ${url.origin}${url.pathname}: ${describe(error)}`);
  }
  if (!response.ok) {
    throw new T3HttpError(
      `T3 answered ${response.status} on ${url.pathname}${await errorCode(response)}`,
      response.status,
    );
  }
  return response.json();
}

/** T3's error bodies carry a code ("auth_invalid", ...); never echo anything else. */
async function errorCode(response: Response): Promise<string> {
  try {
    const body: WireJson = await response.json();
    return typeof body?.code === "string" ? ` (${body.code})` : "";
  } catch {
    return "";
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause: WireJson = error.cause;
    return typeof cause?.code === "string" ? cause.code : error.message;
  }
  return String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
