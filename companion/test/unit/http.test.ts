import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  exchangePairingCredential,
  fetchDescriptor,
  issueWebSocketTicket,
  parsePairingCredential,
  T3HttpError,
} from "../../src/t3/http.ts";

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

/** A tiny local HTTP server standing in for T3's REST routes. */
let routes: Record<string, Handler> = {};
let baseUrl = "";
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const handler = routes[`${request.method} ${request.url}`];
    if (handler) return handler(request, body, response);
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "not_found" }));
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("parsePairingCredential", () => {
  test("takes the token from a pairing link or as is", () => {
    assert.equal(
      parsePairingCredential("https://t3.example/pair#token=ABCD1234efgh"),
      "ABCD1234efgh",
    );
    assert.equal(
      parsePairingCredential("  http://127.0.0.1:3773/pair#token=ab-c_d.e~f \n"),
      "ab-c_d.e~f",
    );
    assert.equal(parsePairingCredential("ABCD1234efgh"), "ABCD1234efgh");
  });

  test("rejects anything else without echoing it", () => {
    assert.throws(
      () => parsePairingCredential("not a link at all"),
      (error: Error) => !error.message.includes("not a link"),
    );
  });
});

describe("fetchDescriptor", () => {
  test("reads version, protocol and capabilities", async () => {
    routes = {
      "GET /.well-known/t3/environment": (_request, _body, response) =>
        json(response, 200, {
          environmentId: "e1",
          serverVersion: "0.1.0",
          orchestrationProtocolVersion: 2,
          capabilities: { threadSettlement: true },
        }),
    };

    assert.deepEqual(await fetchDescriptor(baseUrl), {
      serverVersion: "0.1.0",
      orchestrationProtocolVersion: 2,
      capabilities: { threadSettlement: true },
    });
  });

  test("reports an unreachable server clearly", async () => {
    await assert.rejects(
      fetchDescriptor("http://127.0.0.1:9"),
      /Cannot reach T3 at http:\/\/127\.0\.0\.1:9/,
    );
  });
});

describe("exchangePairingCredential", () => {
  test("sends an RFC 8693 token exchange asking only for orchestration scopes", async () => {
    let sent: URLSearchParams | null = null;
    routes = {
      "POST /oauth/token": (_request, body, response) => {
        sent = new URLSearchParams(body);
        json(response, 200, {
          access_token: "issued-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read orchestration:operate",
        });
      },
    };

    const session = await exchangePairingCredential(
      baseUrl,
      "PAIR1234",
      new Date("2026-10-26T12:00:00Z"),
    );

    assert.deepEqual(session, {
      token: "issued-token",
      scopes: ["orchestration:read", "orchestration:operate"],
      expiresAt: "2026-10-26T13:00:00.000Z",
    });
    assert.ok(sent);
    const form = sent as URLSearchParams;
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(form.get("subject_token"), "PAIR1234");
    assert.equal(
      form.get("subject_token_type"),
      "urn:t3:params:oauth:token-type:environment-bootstrap",
    );
    assert.equal(form.get("scope"), "orchestration:read orchestration:operate");
  });

  test("reports a refused pairing with T3's error code only", async () => {
    routes = {
      "POST /oauth/token": (_request, _body, response) =>
        json(response, 401, { code: "auth_invalid", reason: "secret detail", traceId: "t" }),
    };

    await assert.rejects(exchangePairingCredential(baseUrl, "PAIR1234"), (error: Error) => {
      assert.ok(error instanceof T3HttpError);
      assert.equal(error.message, "T3 answered 401 on /oauth/token (auth_invalid)");
      return true;
    });
  });
});

describe("issueWebSocketTicket", () => {
  test("uses the RPC ticket route when T3 has it", async () => {
    routes = {
      "POST /api/auth/websocket-ticket/rpc": (request, _body, response) =>
        request.headers.authorization === "Bearer my-token"
          ? json(response, 200, { ticket: "rpc-ticket", expiresAt: "x" })
          : json(response, 401, {}),
    };

    assert.equal(await issueWebSocketTicket(baseUrl, "my-token"), "rpc-ticket");
  });

  test("falls back to the bare route on servers without ticket audiences", async () => {
    routes = {
      "POST /api/auth/websocket-ticket": (request, _body, response) =>
        request.headers.authorization === "Bearer my-token"
          ? json(response, 200, { ticket: "bare-ticket", expiresAt: "x" })
          : json(response, 401, {}),
    };

    assert.equal(await issueWebSocketTicket(baseUrl, "my-token"), "bare-ticket");
  });

  test("does not fall back when the token is refused", async () => {
    let bareRouteCalled = false;
    routes = {
      "POST /api/auth/websocket-ticket/rpc": (_request, _body, response) =>
        json(response, 401, { code: "auth_invalid" }),
      "POST /api/auth/websocket-ticket": (_request, _body, response) => {
        bareRouteCalled = true;
        json(response, 200, { ticket: "t" });
      },
    };

    await assert.rejects(issueWebSocketTicket(baseUrl, "revoked"), /401/);
    assert.equal(bareRouteCalled, false);
  });
});
