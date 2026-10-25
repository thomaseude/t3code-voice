# T3 Code client protocol

Research for ticket #3 (part of map #2). Research only: nothing here is implemented.

- Upstream: [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at commit
  **`5b35402623d7d1d88eaa472807272a6c2e78012a`** (2026-10-25, `t3` server version 0.1.2).
- Method: shallow clone read as data. No upstream scripts were run. Every claim links to
  `path#Lline` at that SHA. Claims about the Effect library's own wire format come from outside
  this repo and are marked **(uncertain)**.

All source links are permalinks under `https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/`; link text shows the repo-relative path.

---

## Answer

1. **Two client surfaces.** The first is the app protocol used by web, desktop and the official
   iOS/Android app. It is an **Effect RPC over WebSocket (`GET /ws`, JSON serialization)** plus a
   small **Effect `HttpApi` REST surface** (`/api/auth/*`, `/oauth/token`,
   `/api/orchestration/*`, `/api/projects`, `/.well-known/t3/environment`). The second is a
   separate **MCP server at `/mcp`** (Streamable HTTP, MCP `2025-06-18`) for agents that T3 Code did
   not start. It has tools such as `t3_project_list`, `t3_thread_list`, `t3_thread_read`,
   `t3_thread_launch`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt`,
   `t3_pending_request_*` and `orchestrator_capabilities`.
2. **Neither surface is a stable public API.** The contracts package `@t3tools/contracts` is
   `private: true` and not published. The app protocol is gated by a single integer
   `ORCHESTRATION_PROTOCOL_VERSION = 2` (the server returns 426 on a mismatch), plus a growing
   set of optional capability flags in the environment descriptor and server config. The schemas
   change constantly: 9 of the last 50 upstream commits, which span about one day, touched the
   orchestration/RPC/MCP contract files. **MCP is the closest thing to a supported external API.**
   It is user-documented ("Outside agents"), uses a standard protocol and OAuth, and is described
   as the integration path for Claude Code, Codex, ChatGPT and bots.
3. **Pairing (app protocol).** A one-time pairing credential (default TTL **5 min**) travels in a
   URL fragment: `https://host/pair#token=…` (QR code or pasted URL). The client exchanges it at
   `POST /oauth/token`, an RFC 8693 token-exchange grant
   (`subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`), for a **Bearer
   access token**. Default session TTL is **30 days**. No refresh grant was found; the client
   re-pairs when the token expires (**uncertain**). Through T3 Connect (the cloud relay, using a
   Clerk account), the client instead gets a **DPoP-bound token with a 1 h TTL**, which it
   re-mints through the relay. Each WebSocket opens with a short-lived (**5 min**) `wsTicket`
   from `POST /api/auth/websocket-ticket/rpc`. The long-lived token never goes in the socket URL.
4. **Scopes and revocation.** Grants are scoped: `orchestration:read`, `orchestration:operate`,
   `terminal:*`, `filesystem:*`, `access:*`, `relay:*` and more. By default a pairing grants
   *every* scope. `--scope` narrows it (`t3 pair --scope …`, `t3 auth pairing create`,
   `t3 auth session issue`). Revocation is server-side, per session or per pairing link, via
   Settings → Connections, `/api/auth/clients/revoke`, or `t3 auth session revoke`. Revoking a
   session closes any live socket that uses it.
5. **Remote/mobile access is enabled** by binding the server to a reachable address
   (`t3 serve --host <lan/tailnet ip>`), by using Tailscale HTTPS (`t3 serve --tailscale-serve` /
   `t3 pair --tailscale`), by SSH, or by **T3 Connect** (`t3 connect`, a managed tunnel). A
   headless background service accepts only loopback/private/tailnet peers.
6. **Listing projects/threads (app protocol).** Subscribe to `orchestration.subscribeShell`, a
   stream that starts with a snapshot of projects and thread shells and then sends deltas. HTTP
   alternatives are `GET /api/orchestration/shell` and `GET /api/projects`. Thread detail comes
   from `orchestration.subscribeThread` (a stream), `getThreadProjection`, or
   `GET /api/orchestration/threads/:id[/bounded|/history|/transcript]`.
7. **Sending to a thread (app protocol).** Call `orchestration.dispatchCommand` with
   `{type:"message.dispatch", commandId, threadId, messageId, text, attachments:[], dispatchMode:{type:"start_immediately"|"queue_after_active"|"steer_active"|"restart_active",…}}`.
   Approvals and questions use `{type:"runtime-request.respond", requestId, decision|answers}`.
   Interrupting uses `run.interrupt` / `thread.stop`. Both require `orchestration:operate`.
8. **Creating a Claude Code/Codex thread and choosing provider/model.** Call
   `orchestration.launchThread` with `{commandId, projectId, title, modelSelection:{instanceId, model, options?}, runtimeMode, interactionMode, workspaceStrategy, initialMessage?}`.
   The provider is chosen by **provider instance id**. Built-in driver kinds are `claudeAgent`
   and `codex`, plus `cursor`, `grok`, `opencode`, `pi`, `acpRegistry`, `antigravity` and
   `muse`. The available instances and models come from `server.getConfig` /
   `subscribeServerConfig` → `providers[].models`. On MCP the equivalents are
   `t3_thread_launch` (`projectId` + optional `modelSelection`, `runtimeMode`,
   `interactionMode`, `workspaceStrategy`, `message`) and `orchestrator_capabilities` (providers
   and models).
9. **MCP auth is a separate audience.** External clients sign in with **OAuth 2.1 authorization
   code + PKCE**: dynamic stateless registration, public client. The owner approves with a pairing
   code or an `access:write` browser session and picks **read-only** or a **runtime-mode
   ceiling**. Tokens last **30 days**. A paired app token is rejected on `/mcp`, and an MCP token
   is rejected on `/ws` and HTTP. Redirect URIs must be **`https:` or loopback `http:`**, so
   custom URL schemes such as `myapp://` are rejected. A native iOS app would need an HTTPS
   (universal-link) callback.
10. **MCP limits that matter for a voice companion.** `t3_pending_request_respond` answers user
    questions but **cannot approve permission requests**. There is no push or streaming
    subscription; `t3_thread_wait` long-polls with a timeout, and `t3_thread_read` pages with
    `afterPosition`. Thread modes cannot exceed the client's ceiling. `t3_thread_launch` has no
    idempotency key. `t3_thread_send` accepts `clientRequestId`.
11. **CLI surface.** `t3 thread start|send [--wait]|show|list` drives the same MCP tools, but
    only **on the host**. It mints a short-lived local MCP session from the server's own
    database, so it is not a remote API.
12. **Adapter recommendation.** Put a **`T3Backend` port** in the companion with operations such
    as `listProjects`, `listThreads`, `readThread(since)`, `launchThread(project, provider, model, modes, text)`,
    `send(thread, text, mode)`, `waitForRun`, `listPendingQuestions` / `answer`, `interrupt`
    and `capabilities`. Implement it first against **MCP `/mcp`**: MCP is documented, has a
    narrow surface and standard OAuth, and its blast radius is ceiling-bounded. Keep a possible
    **app-protocol adapter** (WS RPC with orchestration protocol 2 + bearer pairing) behind the
    same port for live streaming and permission approvals. That adapter must pin the protocol
    version, read the descriptor and capability flags, and treat any schema as unstable. The
    companion should depend only on its own DTOs, never on `@t3tools/contracts` types directly.

---

## 1. Transport

### 1.1 App protocol: WebSocket RPC

- The server mounts `GET /ws`. Before authenticating, it rejects clients whose
  `?orchestrationProtocol=` query parameter is not `2`, answering **HTTP 426** with
  `code: "orchestration_protocol_incompatible"`
  ([apps/server/src/ws.ts#L3273-L3288](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L3273-L3288),
  check at [apps/server/src/ws.ts#L630-L635](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L630-L635)).
- Protocol constants: `ORCHESTRATION_PROTOCOL_VERSION = 2`, query param `orchestrationProtocol`,
  header `x-t3-orchestration-protocol`
  ([packages/contracts/src/environment.ts#L13-L16](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environment.ts#L13-L16)).
- The upgrade is authenticated with `authenticateWebSocketUpgrade(request, "rpc")`. The server
  then runs `RpcServer.make(ServerWsRpcGroup)` over `makeProtocolWithHttpEffectWebsocket` with
  **`RpcSerialization.layerJson`**. Each RPC is checked by `RpcAuthorization.layer(session.scopes)`
  ([apps/server/src/ws.ts#L3289-L3305](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L3289-L3305),
  [apps/server/src/ws.ts#L3344](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L3344)). The client uses the same
  JSON serialization
  ([packages/client-runtime/src/rpc/session.ts#L224](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/client-runtime/src/rpc/session.ts#L224)).
- The socket stays open until the session is invalidated, for example by revocation
  (`raceFirst(..., sessions.awaitInvalidation(...))`,
  [apps/server/src/ws.ts#L3376-L3390](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L3376-L3390)).
- RPCs are declared with Effect `Rpc.make(tag, {payload, success, error, stream?})` in
  [packages/contracts/src/rpc.ts](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/rpc.ts). Method names live in
  `WS_METHODS` ([packages/contracts/src/rpc.ts#L385](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/rpc.ts#L385)) and
  `ORCHESTRATION_V2_WS_METHODS`
  ([packages/contracts/src/orchestrationV2.ts#L3285-L3305](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3285-L3305)).
- **(uncertain)** The frame shapes, such as `{_tag:"Request", id, tag, payload, headers}` →
  `Chunk` / `Exit` / `Ack` / `Ping`, are defined by the `effect` library (catalog version `4.0.5`,
  [pnpm-workspace.yaml#L64](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/pnpm-workspace.yaml#L64)), not by this repo. A non-TypeScript
  client would have to re-implement Effect RPC framing and Effect Schema encodings (branded IDs,
  `DateTimeUtc`, tagged errors).

### 1.2 App protocol: HTTP API

Declared as Effect `HttpApiGroup`s in
[packages/contracts/src/environmentHttp.ts](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environmentHttp.ts):

| Group | Endpoints | Lines |
|---|---|---|
| metadata | `GET /.well-known/t3/environment` → `ExecutionEnvironmentDescriptor` (unauthenticated) | [L530-L534](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environmentHttp.ts#L530-L534) |
| auth | `GET /api/auth/session`, `POST /api/auth/browser-session`, `POST /oauth/token`, `POST /api/auth/websocket-ticket[/:use]`, `POST /api/auth/pairing-token`, `GET /api/auth/pairing-links`, `POST …/pairing-links/revoke`, `GET /api/auth/clients`, `POST /api/auth/clients/revoke`, `POST /api/auth/clients/revoke-others` | [L536-L618](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environmentHttp.ts#L536-L618) |
| mcpOAuth | `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/oauth/mcp/{register,authorize,approval,decision,token}` | [L620-L664](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environmentHttp.ts#L620-L664) |
| orchestration | `GET /api/orchestration/shell`, `GET /api/orchestration/threads/:threadId`, `…/transcript`, `…/bounded`, `…/history` | [L695-L737](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environmentHttp.ts#L695-L737) |
| projects | `GET /api/projects`, `POST /api/projects/mutate` | [L739-L754](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environmentHttp.ts#L739-L754) |

The descriptor carries `environmentId`, `label`, `platform`, `serverVersion`,
`orchestrationProtocolVersion` and about 40 optional `capabilities` booleans
([packages/contracts/src/environment.ts#L72-L145](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environment.ts#L72-L145)).
The docs say clients "must use advertised capabilities and handle their absence"
([docs/internals/remote.md#L97-L101](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/remote.md#L97-L101)).

### 1.3 MCP server

- `McpServer.layerHttp({ name: "T3 Code", path: "/mcp", protocols: [McpProtocol.v2025_06_18] })`
  ([apps/server/src/mcp/McpHttpServer.ts#L1033-L1039](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/McpHttpServer.ts#L1033-L1039)).
- The design doc covers the tool surface, idempotency and error codes
  ([docs/orchestration-v2/orchestrator-mcp-server.md#L193-L535](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/orchestration-v2/orchestrator-mcp-server.md#L193-L535)).
  It also says `ThreadManagementService` is the shared application boundary for both V2
  WebSocket commands and MCP
  ([#L22-L27](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/orchestration-v2/orchestrator-mcp-server.md#L22-L27)), so the two
  surfaces have the same semantics.

## 2. Pairing and authentication

### 2.1 Policies, methods, scopes

- Auth policies are `desktop-managed-local | loopback-browser | remote-reachable | unsafe-no-auth`.
  Bootstrap methods are `desktop-bootstrap | one-time-token`. Session methods are
  `browser-session-cookie | bearer-access-token | dpop-access-token`
  ([packages/contracts/src/auth.ts#L12-L28](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/auth.ts#L12-L28)).
- Scopes are listed at
  [packages/contracts/src/auth.ts#L30-L47](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/auth.ts#L30-L47) and the
  default "standard client" set at
  [#L149-L166](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/auth.ts#L149-L166). The default grant includes
  everything, because `terminal:operate` or `orchestration:operate` could mint a full session
  anyway ([docs/internals/environment-auth.md#L9-L18](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/environment-auth.md#L9-L18);
  user docs [docs/user/remote-access.md#L260-L272](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/remote-access.md#L260-L272)).
- Every WS RPC declares a required scope
  ([apps/server/src/auth/RpcAuthorization.ts#L42-L63](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/RpcAuthorization.ts#L42-L63)):
  `dispatchCommand` / `launchThread` → `orchestration:operate`; `subscribeShell`,
  `subscribeThread`, `getThreadProjection`, `server.getConfig` → `orchestration:read`.

### 2.2 Pairing flow (direct LAN / Tailscale / public URL)

1. The host creates a one-time credential: `t3 pair` (prints a QR code), `t3 auth pairing create`,
   Settings → Connections, or `POST /api/auth/pairing-token` (needs `access:write`, input
   `{label?, scopes?}`, [packages/contracts/src/auth.ts#L386-L390](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/auth.ts#L386-L390)).
   The default one-time TTL is **5 minutes**. Desktop bootstrap and dev-startup tokens last 24 h
   ([apps/server/src/auth/PairingGrantStore.ts#L249-L251](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/PairingGrantStore.ts#L249-L251)).
2. The pairing URL is `<base>/pair#token=<credential>`. The token goes in the **fragment** so
   it never reaches a server
   ([apps/server/src/startupAccess.ts#L153-L159](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/startupAccess.ts#L153-L159);
   parsing in [packages/shared/src/remote.ts#L144-L152](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/shared/src/remote.ts#L144-L152);
   the mobile app builds and parses the same URL from host + code or a QR scan,
   [apps/mobile/src/features/connection/pairing.ts#L30-L43](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/mobile/src/features/connection/pairing.ts#L30-L43)).
   Hosted web uses `app.t3.codes/pair?host=…#token=…`
   ([docs/internals/remote.md#L69-L80](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/remote.md#L69-L80)).
3. The client checks `GET /.well-known/t3/environment`, including protocol compatibility. It then
   POSTs form-encoded data to **`/oauth/token`**:
   `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
   `subject_token=<credential>`,
   `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`,
   `requested_token_type=urn:ietf:params:oauth:token-type:access_token`, and optionally `scope`,
   `client_label`, `client_device_type` and `client_os`
   ([packages/contracts/src/auth.ts#L168-L238](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/auth.ts#L168-L238);
   client code [packages/client-runtime/src/authorization/remote.ts#L142-L163](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/client-runtime/src/authorization/remote.ts#L142-L163)).
   The response is `{access_token, token_type: "Bearer"|"DPoP", expires_in, scope}`. Requested
   scopes are intersected with the pairing grant
   ([apps/server/src/auth/EnvironmentAuth.ts#L955-L980](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/EnvironmentAuth.ts#L955-L980)).
4. **Lifetimes.** Bearer sessions default to **30 days**
   ([apps/server/src/auth/SessionStore.ts#L432](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/SessionStore.ts#L432)).
   DPoP-bound tokens get **1 hour**
   ([apps/server/src/auth/EnvironmentAuth.ts#L969-L975](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/EnvironmentAuth.ts#L969-L975)).
   **(uncertain)** No refresh-token grant or sliding expiry appears in `SessionStore.ts`. A
   directly paired client seems to need a fresh pairing once its bearer token expires. User docs
   say "Pairing authorizes that device for future connections"
   ([docs/user/remote-access.md#L61-L65](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/remote-access.md#L61-L65)).
5. **Per-connection WS ticket.** `POST /api/auth/websocket-ticket/rpc` (header
   `Authorization: Bearer …` or `DPoP …` plus a `dpop` proof) returns `{ticket, expiresAt}`. The
   default ticket TTL is **5 min**
   ([apps/server/src/auth/SessionStore.ts#L433](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/SessionStore.ts#L433)).
   The client opens `wss://host/ws?wsTicket=…&orchestrationProtocol=2[&dpop=…]` plus client
   metadata params
   ([packages/client-runtime/src/authorization/remote.ts#L267-L298](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/client-runtime/src/authorization/remote.ts#L267-L298);
   rationale in [docs/internals/environment-auth.md#L73-L86](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/environment-auth.md#L73-L86)).
6. **Storage on mobile.** The official app keeps credentials in `expo-secure-store` (Keychain on
   iOS) ([apps/mobile/src/persistence/mobile-secure-storage.ts#L5-L47](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/mobile/src/persistence/mobile-secure-storage.ts#L5-L47)).
7. **Headless alternative.** `t3 auth session issue --scope … --ttl …` on the host prints a
   scoped bearer token with no pairing step
   ([apps/server/src/cli/auth.ts#L159-L168](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/cli/auth.ts#L159-L168)).

### 2.3 T3 Connect (cloud relay)

The client signs into a Clerk account. The relay asks the linked environment to mint a one-time
bootstrap credential **bound to the client's DPoP key**. The client exchanges it **directly with
the environment** for a 1 h DPoP session. The relay never sees the session token
([docs/internals/t3-connect.md#L36-L57](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/t3-connect.md#L36-L52); client
[packages/client-runtime/src/authorization/service.ts#L307-L359](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/client-runtime/src/authorization/service.ts#L306-L359)).
Traffic goes over a managed tunnel hostname, not through the relay
([docs/internals/t3-connect.md#L1-L6](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/t3-connect.md#L1-L6)). Using this
route would make the companion depend on T3's cloud and Clerk.

### 2.4 Revocation

- `GET /api/auth/clients`, `POST /api/auth/clients/revoke`, `POST /api/auth/clients/revoke-others`,
  and `POST /api/auth/pairing-links/revoke` (all need `access:*`;
  [packages/contracts/src/environmentHttp.ts#L583-L618](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environmentHttp.ts#L583-L618)).
  CLI: `t3 auth session list|revoke`, `t3 auth pairing list|revoke`. UI: Settings → Connections
  ([docs/user/remote-access.md#L250-L258](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/remote-access.md#L250-L258)).
- Revoking a session terminates its live WebSocket
  ([apps/server/src/ws.ts#L3376-L3390](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L3376-L3390)).
- To change a client's scopes, pair again with a fresh link
  ([docs/user/remote-access.md#L274-L279](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/remote-access.md#L274-L279)).

### 2.5 Enabling remote/mobile access

`t3 serve --host <private-ip>`, `t3 pair`, `t3 serve --tailscale-serve` / `t3 pair --tailscale`,
desktop "Network access", SSH, or `t3 connect`
([docs/user/remote-access.md#L6-L151](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/remote-access.md#L6-L151)). A background
service with no host set listens on all IPv4 interfaces but closes non-private peers
([docs/internals/remote.md#L57-L64](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/remote.md#L57-L64)). The hosted web app
needs HTTPS to reach the backend
([docs/user/remote-access.md#L153-L161](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/remote-access.md#L153-L161)).

## 3. Operations on the app protocol

### 3.1 List projects and threads

- `orchestration.subscribeShell` is a stream: `{afterSequence?, omitIdleSubagents?, omitOlderSettled?}`
  → snapshot + deltas of `projects` and thread shells
  ([packages/contracts/src/rpc.ts#L1749-L1754](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/rpc.ts#L1749-L1754);
  input [packages/contracts/src/orchestrationV2.ts#L3402-L3416](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3402-L3416)).
  Shell snapshots may leave out idle subagents and older settled threads when the client asks
  ([docs/internals/connection-runtime.md#L62-L76](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/connection-runtime.md#L62-L76)).
- HTTP alternatives: `GET /api/orchestration/shell` and `GET /api/projects`.

### 3.2 Read / follow a thread

`orchestration.subscribeThread` is a stream
([packages/contracts/src/rpc.ts#L1756-L1761](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/rpc.ts#L1756-L1761)).
The non-streaming routes are `getThreadProjection` and the `/api/orchestration/threads/:id/*`
HTTP routes.

### 3.3 Send a message to an existing thread

`orchestration.dispatchCommand` takes the `OrchestrationV2Command` union and returns `{sequence}`
([packages/contracts/src/rpc.ts#L1627-L1631](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/rpc.ts#L1627-L1631)).
The `message.dispatch` variant has `commandId`, `threadId`, `messageId`, `text`,
`attachments`, optional `modelSelection`, optional `deliveryIntent`, and `dispatchMode` ∈
`defer_start | steer_active | restart_active | queue_after_active | start_immediately`
([packages/contracts/src/orchestrationV2.ts#L2959-L2999](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L2959-L2999)).
Related commands:

- `runtime-request.respond` (approval `decision` or question `answers`,
  [#L3088-L3097](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3088-L3097));
- `run.interrupt` and `thread.stop`
  ([#L3040](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3040),
  [#L2722-L2732](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L2722-L2732));
- `thread.model-selection.set` ([#L2947](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L2947)).

### 3.4 Create a new thread (Claude Code / Codex) and choose provider/model

- `orchestration.launchThread` input: `commandId`, `projectId`, `title`, `modelSelection`,
  `runtimeMode`, `interactionMode`, `workspaceStrategy`, and optional `initialMessage {text, attachments}`.
  It returns `{threadId, projection, resumed}`
  ([packages/contracts/src/orchestrationV2.ts#L3361-L3388](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3361-L3388);
  RPC [packages/contracts/src/rpc.ts#L1733-L1737](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/rpc.ts#L1733-L1737)).
  There is also a lower-level `thread.create` command
  ([#L2733-L2756](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L2733-L2756)).
- `ModelSelection` on the wire is `{instanceId, model, options?}`. A legacy `provider` field is
  still accepted as `instanceId`
  ([packages/contracts/src/modelSelection.ts#L9-L50](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/modelSelection.ts#L9-L50)).
- Driver kinds: `codex`, `claudeAgent`, `cursor`, `grok`, `muse`, `pi`, `acpRegistry`, `opencode`
  ([packages/contracts/src/model.ts#L115-L122](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/model.ts#L115-L122)),
  and `antigravity` ([#L151](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/model.ts#L151)). Routing goes by
  **instance id** ("Only instanceId is stable enough for provider routing",
  [packages/contracts/src/server.ts#L205-L208](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/server.ts#L205-L208)).
- Discovery: `server.getConfig` / `subscribeServerConfig` → `ServerConfig.providers[]`, each
  with `instanceId`, `driver`, `supportedRuntimeModes` and `models[]`
  ([packages/contracts/src/server.ts#L582-L596](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/server.ts#L582-L596),
  [#L205-L255](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/server.ts#L205-L255)).
- `RuntimeMode = approval-required | auto-accept-edits | auto | full-access` (default
  `full-access`). `ProviderInteractionMode = default | plan`
  ([packages/contracts/src/providerPolicy.ts#L25-L36](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/providerPolicy.ts#L25-L36)).

## 4. MCP / CLI surface (alternative for a companion)

### 4.1 Tools

Defined in `apps/server/src/mcp/toolkits/*`. The ones relevant here:

| Tool | Purpose | Source |
|---|---|---|
| `t3_project_list` | paged projects (read-only) | [project/tools.ts#L45-L57](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/project/tools.ts#L45-L57) |
| `t3_thread_launch` | new top-level thread; `projectId` (required outside a thread) or `scratch`, `title`, `modelSelection?`, `runtimeMode?`, `interactionMode?`, `workspaceStrategy?`, `message?`, `attachments?`; **no retry key** | [project/tools.ts#L100-L135](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/project/tools.ts#L100-L135) |
| `orchestrator_capabilities` | providers, models, modes | [orchestrator/tools.ts#L55](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L55) |
| `t3_thread_list` / `t3_thread_read` | shells per project; incremental timeline via `afterPosition`/`nextPosition` | [orchestrator/tools.ts#L215-L243](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L215-L240) |
| `t3_thread_send` | `{threadId, message, mode?: auto/queue/steer/restart, clientRequestId?}` → `{runId, status, delivery}` | [orchestrator/tools.ts#L257-L268](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L257-L268), schema [orchestratorMcp.ts#L458-L474](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestratorMcp.ts#L458-L474) |
| `t3_thread_wait` | `{threadId, runId?, timeoutMs?}`, long-poll until terminal | [orchestrator/tools.ts#L270-L282](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L270-L282) |
| `t3_thread_interrupt` | interrupt the running turn | [orchestrator/tools.ts#L284-L294](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L284-L295) |
| `t3_pending_request_list/read/respond` | user questions; **"cannot approve a permission request"** | [thread/tools.ts#L149-L172](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/thread/tools.ts#L149-L172) |

The server registers more than 80 tools in total (previews, devices, PRs, queue, worktrees,
scheduled tasks, and others).

### 4.2 Auth for external MCP clients

- OAuth authorization-code with PKCE, stateless dynamic registration, and public clients. The
  owner approves with a pairing code or an `access:write` browser session, then chooses read-only
  or a runtime-mode ceiling. The result is a session with subject `mcp-client`, which only `/mcp`
  accepts ([docs/internals/environment-auth.md#L42-L71](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/environment-auth.md#L42-L71)).
  Enforcement: [apps/server/src/auth/EnvironmentAuth.ts#L614-L621](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/EnvironmentAuth.ts#L614-L621)
  (rejected outside `/mcp`) and [#L1295-L1330](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/EnvironmentAuth.ts#L1295-L1330)
  (`/mcp` accepts only `mcp-client` bearer sessions, TTL **30 days**,
  [#L74-L75](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/EnvironmentAuth.ts#L74-L75)). Read-only clients are refused
  for mutating tools
  ([apps/server/src/mcp/McpToolAccess.ts#L68-L78](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/McpToolAccess.ts#L68-L78)).
  Access levels are `read-only | approval-required | auto-accept-edits | auto | full-access`
  ([packages/contracts/src/auth.ts#L402-L408](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/auth.ts#L402-L408)).
- **Redirect URIs must be `https:` or loopback `http:`**, with exact match for HTTPS
  ([apps/server/src/auth/McpOAuth.ts#L94-L118](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/McpOAuth.ts#L94-L118)).
  Custom schemes are not accepted.
- Clients outside a thread must pass `projectId` / `threadId` explicitly. Their limits come from
  the session ceiling
  ([apps/server/src/mcp/threadAccess.ts#L63-L75](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/threadAccess.ts#L63-L75),
  [#L125-L147](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/threadAccess.ts#L125-L147)).
- User-facing setup (Claude Code, Codex, ChatGPT, revocation, 30-day sign-in):
  [docs/user/outside-agents.md#L1-L121](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/outside-agents.md#L1-L121).
- Agents that T3 Code launches itself get a separate, per-provider-session credential injected
  as `t3-code` ([docs/orchestration-v2/orchestrator-mcp-server.md#L29-L55](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/orchestration-v2/orchestrator-mcp-server.md#L29-L55)).
  That is not relevant for an external companion.
- **(uncertain, not recommended)** `t3 auth session issue --subject mcp-client` appears able to
  mint a bearer token that `/mcp` would accept with `approval-required` access.
  `issueSession` does not restrict `subject`
  ([apps/server/src/auth/EnvironmentAuth.ts#L1084-L1095](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/auth/EnvironmentAuth.ts#L1084-L1095)).
  This is not documented and not tested here.

### 4.3 CLI

`t3 thread start|send|show|list` mints a temporary full-access `mcp-client` session straight
from the local server database and talks to `/mcp` on the host's own origin
([apps/server/src/cli/thread.ts#L205-L235](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/cli/thread.ts#L205-L235); user docs
[docs/user/outside-agents.md#L95-L115](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/outside-agents.md#L95-L115)). This is a
host-local scripting surface, not a remote API.

## 5. Stability and versioning

- `@t3tools/contracts` and `@t3tools/client-runtime` are `"private": true`
  ([packages/contracts/package.json#L4](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/package.json#L4),
  [packages/client-runtime/package.json#L3](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/client-runtime/package.json#L3)).
  No published SDK and no documented public REST/WS API were found.
- Versioning works through one orchestration protocol integer plus additive optional fields and
  capability flags, with explicit back-compat shims. Examples: the ticket `/:use` fallback
  ([packages/contracts/src/auth.ts#L246-L252](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/auth.ts#L245-L252)), and
  `permissions` vs legacy `scopes` ([docs/internals/environment-auth.md#L88-L99](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/environment-auth.md#L88-L99)).
  Clients must handle older servers
  ([docs/internals/remote.md#L97-L101](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/remote.md#L97-L101)).
- Churn: 9 of the last 50 commits (2026-10-24 → 2026-10-25) touched `orchestrationV2.ts`,
  `rpc.ts` or `orchestratorMcp.ts`. This comes from `git log` on the shallow clone.
- MCP is pinned to protocol `2025-06-18`, and its tools are typed by
  `packages/contracts/src/orchestratorMcp.ts`. The tool names and inputs are also internal, but
  they are user-documented, published to third-party agents, and kept compact for LLMs. They are
  likely, but **not promised**, to change more slowly.

## 6. What a companion adapter should depend on

Recommended boundary, for the map to confirm:

- **Port (companion-owned DTOs):** `connect/pair`, `capabilities()`, `listProjects()`,
  `listThreads(project)`, `readThread(id, sinceCursor)`,
  `launchThread({projectId, providerInstanceId, model, runtimeMode, interactionMode, text})`,
  `send(threadId, text, mode, idempotencyKey)`, `waitForRun(threadId, runId?, timeout)`,
  `pendingQuestions(threadId)` / `answer(...)`, `interrupt(threadId)`, and, only on the WS
  adapter, `approve(requestId, decision)` and `subscribe(threadId)`.
- **Adapter A: MCP (`/mcp`)** is the primary candidate. Its dependencies are the MCP
  Streamable-HTTP client, OAuth 2.1 + PKCE with an HTTPS redirect, the tool names and JSON shapes
  in §4.1, and `OrchestratorMcpFailure` codes
  ([docs/orchestration-v2/orchestrator-mcp-server.md#L497-L535](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/orchestration-v2/orchestrator-mcp-server.md#L497-L535)).
  Gaps: no permission approvals and no push streaming.
- **Adapter B: app protocol (`/ws` + HTTP)** is a fallback or complement. It depends on the
  pairing URL format, the `/oauth/token` token-exchange, the WS ticket,
  `orchestrationProtocol=2`, Effect RPC JSON framing, and the `OrchestrationV2Command` /
  `ThreadLaunchInput` / shell and thread stream schemas. It must check the descriptor's
  `orchestrationProtocolVersion` and `capabilities` on every connect, and fail closed on a
  mismatch.
- Keep the T3 Connect (Clerk/relay) route out of scope unless the map decides otherwise. Direct
  HTTPS (Tailscale Serve) covers self-hosting.

## Side note

Upstream already has on-device voice dictation in the official iOS app. It only edits the
composer draft and never auto-submits
([docs/internals/voice-input.md#L1-L6](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/voice-input.md#L1-L6)).
