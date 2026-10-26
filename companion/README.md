# t3-voice companion

The service that runs next to a T3 Code server and lets the T3 Voice iOS app drive it.
This first version connects to T3 and reports its status. See the spec in issue #15.

TypeScript on Node 22.18 or later. No runtime dependencies: it uses Node's built-in
`fetch` and `WebSocket`.

## Set up

```sh
cd companion
npm install
npm run build
npm link            # puts `t3-voice` on your PATH (or run `node dist/cli.js`)
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

`setup` checks that T3 is a supported version, exchanges the link for a T3 session token
(valid 30 days) and stores it. The link also works through a pipe:
`echo "$LINK" | t3-voice setup`.

## Files

Everything lives in `~/.config/t3voice/` (or `$T3VOICE_CONFIG_DIR`). The directory is mode
700 and every file mode 600. The companion refuses to read a file other users can read.

| File | Content |
|---|---|
| `config.json` | T3 URL and optional `t3.acceptedServerVersions` |
| `t3-session.json` | T3 session token (secret), scopes, expiry |
| `openai.env` | OpenAI key (secret, used by later tickets) |

Secrets are never printed or logged.

## Supported T3 versions (fail closed)

T3's protocol is not a public API and changes often. On every connection the companion
reads `/.well-known/t3/environment` and refuses to run unless:

- the orchestration protocol is 2;
- the server version is one it was tested with (`DEFAULT_T3_PIN` in
  `src/adapters/t3-websocket/compatibility.ts`, currently `0.1.0`);
- the capabilities it requires are advertised.

On a mismatch, commands print what differs and exit with code 3. To support a new T3
version, run the integration tests against it, then add it to `DEFAULT_T3_PIN` (or, on one
machine only, to `t3.acceptedServerVersions` in `config.json`).

## Code map

Hexagonal: the core and the CLI only know the ports; adapters implement them; `main.ts` is
the one place that plugs the real adapters in. `test/unit/architecture.test.ts` enforces it.

```
src/
  main.ts                    composition root
  ports/
    t3Backend.ts             T3Backend, T3Connector, the companion's own T3 types
    configStore.ts           ConfigStore (settings + T3 session)
  core/
    shellState.ts            projects and threads kept up to date; "is this thread running?"
  adapters/
    t3-websocket/            T3 over /ws: connector, backend, RPC frames, wire translation,
                             pairing/ticket HTTP calls, pinned version check
    config/                  ConfigStore on files in ~/.config/t3voice/
    cli/                     `t3-voice` commands (setup, status)
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
`$T3_BIN`, or `~/.t3/runtime/versions/<pinned version>/t3`, and are skipped when neither
exists. CI runs the unit tests only, since it has no T3 binary.
