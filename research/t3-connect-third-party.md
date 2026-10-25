# Can a third-party app use T3 Connect?

Research for [#14](https://github.com/thomaseude/t3code-voice/issues/14) (part of map #2).
Sources: upstream `pingdotgg/t3code` at commit
[`5b35402623d7d1d88eaa472807272a6c2e78012a`](https://github.com/pingdotgg/t3code/tree/5b35402623d7d1d88eaa472807272a6c2e78012a)
(same SHA as the [client protocol research](https://github.com/thomaseude/t3code-voice/blob/research/t3-client-protocol/research/t3-client-protocol.md)),
plus a search of upstream issues/PRs. Read-only: no upstream scripts run, no calls made to T3's
Clerk instance or relay. Statements marked **(uncertain)** are inferences, not checked live.

## Answer

**There is no supported way for a third-party app to use T3 Connect.** It is built for T3's own
clients only:

- **No third-party client registration.** The relay accepts exactly two client ids, the
  hardcoded literals `t3-mobile` and `t3-web`. Each id has a fixed scope set, and only
  `t3-mobile` can register for push. The docs and Terms describe no developer program, API, or
  app registration.
- **Technically it would mostly work, but only by posing as T3's app.** The Clerk publishable key,
  JWT template name and CLI OAuth client id are published as "public identifiers". The relay does
  not check which app a Clerk token came from (no `azp`/origin check), and `client_id` is just a
  form field. A custom app could probably sign in with email/password against `clerk.t3.codes`,
  list the user's servers, and run the same DPoP connect flow **(uncertain, not tested)**. It
  would then appear as `t3-mobile`/`t3-web`, get **full standard scopes** on the user's server,
  and depend on an undocumented internal protocol that T3 changes often. The Terms give a personal-use
  licence to "the Services", forbid bypassing "access controls … or usage restrictions", and let
  T3 change or suspend features at any time. **Treat this as against intended use.** It is fine
  for a private experiment. Do not ship it in a public app.
- **The relay cannot reach the companion.** Connect is not a traffic relay. It sets up a
  Cloudflare tunnel whose only origin is the **T3 server's own loopback port**, and it explicitly
  refuses to expose "another service on the environment host". Only webhooks pass through the
  relay itself.
- **The companion gains nothing by being a Connect client.** It already reaches T3 on loopback.
  If it needs an official, documented third-party login to T3, that is **MCP OAuth** on
  `/mcp` (public PKCE clients with stateless registration, approved with a pairing code). That
  path is for "outside agents", not Connect.
- **The `infra/relay` push relay cannot carry our notifications.** It is the same relay. It
  sends APNs with a single `APNS_BUNDLE_ID` (T3's app), device registration requires the
  `t3-mobile` client's `mobile:registration` scope, and payloads come from T3 servers. Our
  App Store app needs its own push relay, as #13 already noted.
- **The supported "same UX" path is to fork the stack.** The relay and Clerk setup are MIT-licensed and
  documented for self-deployment (own Clerk, own relay, own tunnels). But a T3 server stores
  **one** relay issuer. Pointing it at our relay would take it off T3's official relay
  **(uncertain whether both can coexist)**. That is heavy and conflicts with the user also using
  the official T3 app.

**Recommendation:** keep the MVP decision from #13 (separate companion hostname plus its own QR
pairing). Do not build "Sign in with T3". If account-style login is wanted later, build **our
own** small cloud (accounts, companion directory, push relay), as #13's spec requirements already
allow. Optionally ask T3 maintainers whether they would accept a registered third-party client
id or scope, which is the only legitimate way to unlock Connect. Separately, upstream PR
[#14865](https://github.com/pingdotgg/t3code/pull/14865) (open, community) adds Codex voice
conversations to T3's own clients. The map should track it.

## Details

Permalink base: `https://github.com/pingdotgg/t3code/blob/5b35402…/`. All links below are pinned.

### 1. How Connect auth works end to end

1. **Clerk instance.** Production uses publishable key `pk_live_Y2xlcmsudDMuY29kZXMk`, which
   decodes to the Frontend API `clerk.t3.codes`. It also uses JWT template `t3-relay` and CLI OAuth
   client id `hzxSgY2cH10sDU2r`. The repo calls these "the same public identifiers baked into
   official release builds, not secrets"
   ([.env.example#L1-L11](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/.env.example#L1-L11)),
   with relay `https://relay.t3.codes`
   ([.env.example#L20-L22](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/.env.example#L20-L22)).
   Interactive clients and the CLI share one Clerk application with different credentials. The
   CLI is a public PKCE OAuth client, and SSH/headless sessions use Clerk's device grant
   ([t3-connect.md#L159-L177](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/t3-connect.md#L159-L177)).
   The JWT template adds `aud: "t3-code-relay"`
   ([connect-setup.md#L50-L61](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/operations/connect-setup.md#L50-L61)).
2. **Native sign-in (official iOS app).** The app wraps itself in `@clerk/expo`'s `ClerkProvider`
   with the publishable key
   ([CloudAuthProvider.tsx#L1](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/mobile/src/features/cloud/CloudAuthProvider.tsx#L1),
   [#L204](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/mobile/src/features/cloud/CloudAuthProvider.tsx#L204)).
   It fetches relay-template tokens with `getToken(...)`
   ([#L130](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/mobile/src/features/cloud/CloudAuthProvider.tsx#L130)).
   Clerk's instance is configured for T3's own apps: SSO redirect allowlists for `t3code://` and
   the `com.t3tools.t3code*` Android callbacks, and passkeys tied to T3's Apple Team ID and bundle
   ([connect-setup.md#L63-L99](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/operations/connect-setup.md#L63-L99);
   team `ARK85ZXQ4Z` in
   [app.config.ts#L241-L247](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/mobile/app.config.ts#L241-L247)).
   **(uncertain)** For a third-party bundle, OAuth/social sign-in and passkeys would therefore
   fail. Plain email/password or email-code sign-in through Clerk's native API probably needs no
   allowlist entry. I did not test this.
3. **Relay token exchange.** The client posts an RFC 8693 token exchange to
   `POST /v1/client/dpop-token` with `subject_token` (the Clerk JWT), `resource` (the relay URL), `scope` and
   `client_id`, plus a DPoP proof
   ([relay.ts#L758-L783](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/relay.ts#L758-L783),
   client side [managedRelay.ts#L514-L519](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/client-runtime/src/relay/managedRelay.ts#L514-L519)).
   The relay checks `resource`, the allowed scopes for the `client_id`, the Clerk signature and the
   `aud`, and the DPoP proof. It then issues a **30-minute** DPoP-bound relay token (`cnf.jkt`)
   ([Api.ts#L1005-L1053](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/http/Api.ts#L1005-L1053),
   [RelayTokens.ts#L29](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/auth/RelayTokens.ts#L29),
   [#L45-L55](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/auth/RelayTokens.ts#L45-L55)).
   Clerk verification passes only `secretKey` and `audience`, with **no `authorizedParties`
   (azp/origin) check**
   ([Api.ts#L1648-L1664](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/http/Api.ts#L1648-L1664)).
4. **Server discovery.** `GET /v1/environments` and the link/unlink endpoints sit behind
   `RelayClientAuth`, which accepts a Clerk session JWT with the relay audience **or** a Clerk
   OAuth token, such as the CLI's
   ([relay.ts#L1057-L1113](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/relay.ts#L1057-L1113),
   [Api.ts#L315-L345](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/http/Api.ts#L315-L345),
   [#L1692-L1708](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/http/Api.ts#L1692-L1708)).
5. **Connect.** `POST /v1/environments/:id/connect` (needs `environment:connect`) takes the
   client's DPoP key thumbprint
   ([relay.ts#L729-L745](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/relay.ts#L729-L745),
   [Api.ts#L1073](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/http/Api.ts#L1073)).
   The relay sends the T3 server a signed, replay-guarded mint proof with
   `scope: ["environment:connect"]` and `cnf.jkt`
   ([relay.ts#L858-L868](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/relay.ts#L858-L868)).
   The server checks the issuer, audience `t3-env:<id>`, linked cloud user, key binding and replay. It then
   creates a **2-minute, key-bound pairing credential with `AuthStandardClientScopes`**, subject
   `cloud-connect`, label "T3 Connect connect"
   ([CloudLink.ts#L1531-L1603](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/cloud/CloudLink.ts#L1531-L1603)).
   `AuthStandardClientScopes` covers orchestration, terminal, filesystem, settings, access and
   relay management
   ([auth.ts#L149-L166](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/auth.ts#L149-L166)).
   The relay returns `{endpoint {httpBaseUrl, wsBaseUrl}, credential, expiresAt}`
   ([relay.ts#L830-L835](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/relay.ts#L830-L835)).
   The client redeems the credential **directly with the server** for a 1 h DPoP session. The relay
   never sees that session
   ([t3-connect.md#L36-L57](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/t3-connect.md#L36-L57)).
   From there it is the normal T3 client protocol (see the earlier research, §2.2–2.3).

### 2. Third-party client registration

- `client_id` is a closed literal set: `RelayPublicClientId = ["t3-mobile", "t3-web"]`
  ([relay.ts#L762-L765](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/relay.ts#L762-L765)).
  Allowed scopes are hardcoded per id, and only `t3-mobile` gets `mobile:registration`
  ([RelayTokens.ts#L63-L73](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/auth/RelayTokens.ts#L63-L73)).
  There is no registration endpoint. The `/.well-known/oauth-authorization-server` metadata only
  advertises the token-exchange grant
  ([Api.ts#L450](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/http/Api.ts#L450)).
- The ids are not secrets and are not bound to an app identity. Nothing (attestation, azp, origin)
  stops another binary from sending `client_id=t3-mobile`. That is why it is technically possible,
  and also why doing so means posing as T3's first-party app.
- The Clerk-side setup steps (redirect allowlists, Native API iOS app, passkey RP) are all
  written for T3's own bundles and schemes
  ([connect-setup.md#L37-L99](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/operations/connect-setup.md#L37-L99)).
- Upstream issue/PR search found no discussion of third-party Connect clients or a public API.

### 3. Terms and policy

From the [Terms of Service](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/marketing/src/pages/terms-of-service.astro)
(effective 2026-07-15):
- They cover the apps, the hosted app "and the optional T3 Connect service"
  ([#L28-L32](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/marketing/src/pages/terms-of-service.astro#L28-L32)).
- The open-source code is governed by its licence (MIT). The hosted Services carry a "limited,
  non-exclusive, non-transferable, revocable right … for lawful personal or internal business
  purposes", and use of T3 trademarks is not allowed
  ([#L113-L121](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/marketing/src/pages/terms-of-service.astro#L113-L121)).
- Acceptable use forbids bypassing "access controls, security measures, or usage restrictions"
  and placing "unreasonable load on shared infrastructure"
  ([#L134-L135](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/marketing/src/pages/terms-of-service.astro#L134-L135)).
  Features can change or stop
  ([#L150](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/marketing/src/pages/terms-of-service.astro#L150)).
- **Reading:** nothing explicitly permits or forbids third-party clients. Since only first-party
  client ids exist, a public app posing as `t3-mobile` is at best unsanctioned, and arguably
  bypasses a usage restriction. A personal script for your own account is lower risk but still
  unsupported. This is my interpretation, not legal advice.

### 4. Can the relay reach the companion? Can the companion be a Connect client?

- The relay is "not in the hot path". After bootstrap, traffic goes to the environment's tunnel
  hostname, and the only proxied traffic is webhooks under `/v1/hooks/...`
  ([t3-connect.md#L3-L12](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/t3-connect.md#L3-L12),
  [relay README#L6-L12](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/README.md#L6-L12)).
- "Managed tunnels expose only a validated loopback HTTP origin … These restrictions keep
  endpoint discovery from turning into arbitrary relay egress **or exposing another service on
  the environment host**"
  ([t3-connect.md#L59-L64](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/t3-connect.md#L59-L64)).
  The server registers its own listening port as the origin
  ([CloudLink.ts#L1180-L1189](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/cloud/CloudLink.ts#L1180-L1189)).
  The relay requires a loopback host
  ([ManagedEndpointProvider.ts#L370-L378](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/environments/ManagedEndpointProvider.ts#L370-L378)),
  and the tunnel ingress is that one origin plus a 404 catch-all
  ([#L797-L803](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/environments/ManagedEndpointProvider.ts#L797-L803)).
  A hacked link could point at another loopback port, but that requires impersonating a T3
  environment and is clearly against the stated design.
- **Companion as Connect client:** possible only through the same impersonation as above, and
  pointless, because the companion runs on the T3 host and uses loopback. The **supported**
  third-party login to a T3 server is MCP OAuth for "outside agents". It uses public PKCE clients
  and stateless registration, is approved with a pairing code, and grants read-only or a
  runtime-mode ceiling. Hosted agents are told to use the T3 Connect address
  ([environment-auth.md#L42-L60](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/environment-auth.md#L42-L60),
  [outside-agents.md#L1-L54](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/outside-agents.md#L1-L54)).
  The tunnel hostname is public and the server does its own auth. So a non-T3 client holding a
  T3 credential from **pairing or MCP OAuth** can reach T3 through the Connect hostname without
  Clerk at all. That is supported use of the hostname, not of Connect's account features.

### 5. What `infra/relay` is, and the push relay (AgentAwarenessRelay)

- `infra/relay` is the whole T3 Connect control plane, a Cloudflare Worker with Postgres. It
  handles linking, managed tunnels, short-lived connect credentials, environment/device listing,
  APNs/FCM device registration, and delivery of agent-activity notifications and Live Activities
  ([README#L1-L25](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/README.md#L1-L25)).
  Push code lives in `src/agentActivity`. I found no separate "AgentAwarenessRelay" component at
  this SHA, so the push part is this module **(uncertain about the name)**.
- APNs is sent with **one** configured bundle id as `apns-topic`
  ([worker.ts#L147](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/worker.ts#L147),
  [ApnsClient.ts#L243](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/agentActivity/ApnsClient.ts#L243),
  [#L305](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/agentActivity/ApnsClient.ts#L305)),
  with production secrets `APNS_BUNDLE_ID` and `APNS_PRIVATE_KEY`
  ([README#L141-L162](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/README.md#L141-L162)).
  Device endpoints need `mobile:registration`
  ([Api.ts#L771-L806](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/src/http/Api.ts#L771-L806)),
  which only `t3-mobile` can obtain. A device token from our app would be rejected by APNs
  (topic mismatch). Payloads are T3 agent-activity events published by linked servers. **A third
  party cannot use T3's instance for its own pushes.** The code is reusable as a template for our
  own push relay (MIT).

### 6. Running our own Connect stack

Supported by the docs: set our own Clerk key, template, OAuth client and relay URL, and deploy
`infra/relay` with Alchemy (Cloudflare, PlanetScale, Axiom, APNs)
([connect-setup.md#L7-L35](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/operations/connect-setup.md#L7-L35),
[README#L77-L168](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/infra/relay/README.md#L77-L168)).
Bundled servers accept runtime overrides. But a server holds a single relay issuer/URL
([CloudLink.ts#L1542-L1560](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/cloud/CloudLink.ts#L1542-L1560)),
so linking to our relay likely means leaving T3's **(uncertain)**. It would also tie each user's
T3 to our infrastructure. That is too heavy and intrusive for this project.

## Feasible vs. against intended use

| Option | Feasible? | Intended use? |
|---|---|---|
| Our app signs into T3's Clerk, uses `client_id=t3-mobile` to list and connect to servers | Probably (email/password only; untested) | No: poses as a first-party client, unsupported, fragile |
| Relay or tunnel reaching the companion | No, by design (single loopback origin) | No |
| Companion as Connect client | Only via the same impersonation; no benefit | No |
| T3's push relay for our app | No (APNs topic and scope bound to T3's app) | No |
| Our app/companion reaching T3 through the Connect **hostname** with a pairing/MCP credential | Yes | Yes (documented for outside agents) |
| Self-hosted fork of relay + Clerk | Yes, but heavy, and likely replaces the T3 link | Yes (MIT), but intrusive |
| Our own small cloud (accounts, directory, push) | Yes | Yes |

## Recommendation

1. Keep #13's MVP: companion on its own hostname with QR pairing. Drop "Sign in with T3" as a target.
2. If account login is wanted for public users, build our own cloud layer later, as already
   allowed by #13's spec requirements 1–4. Our push relay would follow T3's design but use our
   own APNs key.
3. Optional: open a discussion upstream asking whether a registered third-party client id or scope
   (for example "environment:connect" for listed partner apps) would be accepted. Only do this if Connect
   login becomes important.
