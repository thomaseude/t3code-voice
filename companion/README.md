# t3-voice companion

The service that runs next to a T3 Code server and lets the T3 Voice iOS app drive it.
So far it connects to T3, reports its status and serves an HTTP API that only answers
paired devices (none can pair yet). See the spec in issue #15.

TypeScript on Node 22.18 or later. No runtime dependencies: it uses Node's built-in
`fetch` and `WebSocket`.

## Set up

```sh
cd companion
npm install
npm run build
npm link            # puts `t3-voice` on your PATH (or run `node dist/main.js`)
```

On the T3 host, create a one-time pairing link limited to orchestration:

```sh
t3 auth pairing create --scope orchestration:read --scope orchestration:operate \
  --base-url http://127.0.0.1:3773
```

If `t3` is not on your PATH, use the binary T3 installed, for example
`~/.t3/runtime/versions/0.1.0/t3` (`setup` prints the right path). In a terminal opened from
T3 itself, prefix the command with `env -u T3_SERVICE_LAUNCHER_CONTEXT`.

Then pair the companion and paste the link when asked (the input is hidden):

```sh
t3-voice setup                 # T3 on http://127.0.0.1:3773
t3-voice setup --t3-url URL    # T3 somewhere else
t3-voice status
```

`setup` checks that T3 is a supported version, exchanges the link for a T3 token (valid 30
days) and stores it with the URL of the server that issued it. `status` refuses to send the
token to any other URL. The link also works through a pipe:
`echo "$LINK" | t3-voice setup`.

## Run the HTTP API

`t3-voice serve` runs the API the iPhone app calls. It listens on `127.0.0.1:8787` by
default and stops cleanly on `SIGTERM` or Ctrl-C.

- Every request needs a device token (`Authorization: Bearer <token>`). Without a valid
  one, the answer is `401` with an empty body. A revoked device is refused on its next
  request.
- Every request is rate-limited: 120 requests per minute per client IP (counted before
  the token check, so guessing tokens is throttled) and 60 per minute per device. Over the
  limit, the answer is `429` with a `Retry-After` header.

Settings in `config.json`, all optional:

```json
{
  "t3": { "baseUrl": "http://127.0.0.1:3773" },
  "server": { "host": "127.0.0.1", "port": 8787, "clientIpHeader": "cf-connecting-ip" }
}
```

`clientIpHeader` names the header a local proxy sets to the caller's IP. Behind a
Cloudflare Tunnel it is `cf-connecting-ip`. The companion reads it only on connections from
loopback, so a remote caller cannot pick its own IP. Without it, every request through the
proxy counts as one IP.

### As a systemd user service

```sh
cd companion
mkdir -p ~/.config/systemd/user
sed -e "s|@NODE@|$(command -v node)|" -e "s|@MAIN@|$PWD/dist/main.js|" \
  deploy/t3-voice.service > ~/.config/systemd/user/t3-voice.service
systemctl --user daemon-reload
systemctl --user enable --now t3-voice
sudo loginctl enable-linger "$USER"   # start at boot, without a login session
journalctl --user -u t3-voice -f      # logs
```

The unit runs the `node` that was on your PATH when you ran `sed`. After a Node upgrade (with
nvm, for example), run the `sed` line again, then `systemctl --user daemon-reload` and
`systemctl --user restart t3-voice`.

### Publish it over HTTPS

The phone needs an HTTPS address. Keep the companion on loopback and put a TLS proxy or a
tunnel in front of it. With a Cloudflare Tunnel (`voice.example.com` stands for your
hostname):

1. Add an ingress rule above the catch-all rule in the tunnel config, then restart
   `cloudflared`:

   ```yaml
   - hostname: voice.example.com
     service: http://127.0.0.1:8787
   ```

2. Create the DNS route: `cloudflared tunnel route dns <tunnel> voice.example.com`.
3. If Cloudflare Access protects your domain, the app cannot pass its login page. Create an
   Access application for `voice.example.com` only, with one policy whose action is
   **Bypass**. Do not change the applications of your other hostnames. The companion's
   device tokens protect this hostname.
4. Set `"clientIpHeader": "cf-connecting-ip"` in `config.json` and restart the service.
5. Check from outside: `curl -i https://voice.example.com/activity` must answer `401`.

## Files

Everything lives in `~/.config/t3voice/` (or `$T3VOICE_CONFIG_DIR`). The companion creates
the directory with mode 700 and every file with mode 600. It never changes the mode of a
directory it did not create: it refuses to use a directory or a file that other users can
open, and prints the `chmod` command that fixes it.

| File | Content |
|---|---|
| `config.json` | T3 URL and optional `t3.acceptedServerVersions` |
| `t3-pairing.json` | T3 token (secret), the URL of the server that issued it, scopes, expiry |
| `devices.json` | Paired iPhones: id, name, SHA-256 of the device token, dates. Never the token itself |
| `openai.env` | OpenAI key (secret, used by later tickets) |

Secrets are never printed or logged.

## Supported T3 versions (fail closed)

T3's protocol is not a public API and changes often. On every connection the companion
reads `/.well-known/t3/environment` and refuses to run unless:

- the orchestration protocol is 2;
- the server version is one it was tested with (`DEFAULT_T3_PIN` in
  `src/adapters/t3-websocket/compatibility.ts`, currently `0.1.0` and `0.1.1`);
- the capabilities it requires are advertised (none yet: add a flag to the pin when a
  feature starts to depend on it).

On a mismatch, commands print what differs and exit with code 3.

To support a new T3 version, once T3 has installed it in `~/.t3/runtime/versions/`:

1. Add the version to `serverVersions` in `DEFAULT_T3_PIN`.
2. Run `T3_VERSION=<version> npm run test:integration`.
3. Keep the version if the tests pass; otherwise remove it and fix the adapter first.

To unblock one machine before a release, list the versions in `t3.acceptedServerVersions` in
its `config.json`. The list replaces the pinned versions, so also list the ones still in use.

## Code map

Hexagonal: the core and the CLI only know the ports; adapters implement them; `main.ts` is
the one place that plugs the real adapters in. `test/unit/architecture.test.ts` enforces it.

```
src/
  main.ts                    composition root
  ports/
    t3Backend.ts             T3Backend, T3Connector, the companion's own T3 types
    configStore.ts           ConfigStore (settings, T3 token, paired devices)
    deviceAuth.ts            DeviceAuth: which device a token belongs to
  core/
    shellState.ts            projects and threads kept up to date; "is this thread running?"
    rateLimiter.ts           requests per key (IP, device) in fixed windows
  adapters/
    t3-websocket/            T3 over /ws: connector, backend, RPC frames, wire translation,
                             pairing/ticket HTTP calls, pinned version check
    config/                  ConfigStore on files in ~/.config/t3voice/
    device-auth/             DeviceAuth with the companion's own opaque tokens (stored hashed)
    http/                    the HTTP API: token check and rate limits on every route
    cli/                     `t3-voice` commands (setup, status, serve)
deploy/
  t3-voice.service           systemd user unit template
```

## Tests

```sh
npm test                    # unit tests, in-memory fakes, no network
npm run test:integration    # against a real, throwaway `t3 serve`
npm run lint
npm run typecheck
```

The integration tests start their own `t3 serve` with a temporary data directory, an empty
HOME and a free port, so they never touch your T3 server. They use the T3 binary from
`$T3_BIN`, or `~/.t3/runtime/versions/<version>/t3`, where `<version>` is `$T3_VERSION` or
the newest pinned version. They are skipped when no binary is found. CI runs the unit tests only, since it has no T3 binary.
