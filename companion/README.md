# t3-voice companion

The service that runs next to a T3 Code server and lets the T3 Voice iOS app drive it.
So far it connects to T3, reports its status, pairs iPhones with a QR code and serves an
HTTP API that only answers paired devices. See the spec in issue #15.

TypeScript on Node 22.18 or later. One runtime dependency, [`uqr`](https://github.com/unjs/uqr)
(no dependencies of its own), draws the pairing QR code; the rest uses Node's built-in
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

It connects to T3 first, with the token from `setup`, and fails closed: it refuses to start
(exit code 3) when T3 is not a tested version, and stops when T3 comes back from a restart
as an untested version. Run `setup` before `serve`.

Routes:

- `POST /pair` trades a one-time pairing code for a device token (see below). It is the only
  route without a device token.
- `GET /activity` lists what T3 runs now and what finished in the last 24 hours, 10 threads
  per list at most:
  `{"running": [...], "finished": [...]}`, each item
  `{threadId, title, project, state, updatedAt}`, where `state` is `running`,
  `waiting_for_input`, `waiting_for_approval`, `completed` or `failed`. It answers `503`
  while the companion reconnects to T3.
- `POST /sessions` starts a voice conversation. Body `{"sdp": "<WebRTC SDP offer>",
  "timeZone": "Europe/Paris"}` (`timeZone` is optional; it sets what "today" means, and
  defaults to the server's). The companion sends the offer to GPT-Live with its own OpenAI
  key and answers `201` with `{"sessionId", "sdp": "<SDP answer>"}` as soon as GPT-Live
  answers and the companion's control channel is attached. GPT-Live's answer can take up
  to 15 s; the attach after it waits 3 s at most. The app applies the answer and does not
  wait for full ICE gathering. A device
  has one session at most: a new `POST /sessions` closes the one it still had. Errors:
  `400` `invalid_offer`, `502` `voice_engine_failed` (OpenAI refused or cannot be
  reached), `503` `voice_unavailable` (no OpenAI key).
- `DELETE /sessions/:id` ends the device's session: `204`, or `404` when the device has no
  session with this id.

During a session the companion answers the voice model's tools from T3's state:

- `list_projects`;
- `get_activity` with `scope` `running`, `today` (the device's calendar day) or `finished`
  (the last 24 hours): the 10 latest tasks and the `total`;
- `start_task` starts a T3 thread at once and follows it under a short French spoken name
  (2 to 4 words, unique among followed tasks, never changed). When a name is taken, the
  project's name, then a number, is added to it. It uses the agent and model
  the user named, else the project's default, else T3's, and T3's default runtime mode.
  The agent works in a new worktree when the project is set to `worktree` in T3, when the
  project's folder already has a running agent, or when the user asks for one. The
  worktree starts from the repository's main branch (the one `origin/HEAD` names), fetched
  from origin. A busy project that is not a git repository, or `workspace: shared` on a
  busy folder, asks for a "oui" first (see below). A new worktree asked for in a repository
  with no branch starts nothing (`worktree_unavailable`). Several projects with the title the user said start nothing:
  the answer lists their folder names, and the model calls again with `folder`. A model
  that fits several models, with or without its agent named, answers `ambiguous_model`
  with each agent and model;
- `send_message` sends a follow-up to a followed task, in its thread. A task is named by
  its spoken name, or by its spoken name and project ("tests Reviews de joombo"): `queue` (default)
  after the agent's current turn, `steer` into it;
- `cancel_last_action` undoes the last start or message, within 60 s ("non, arrête"): a
  started thread is stopped (its run interrupted, its queued runs cancelled) and archived,
  a waiting message is taken back from the queue, a message that started an idle thread
  interrupts its run. An undo that failed can be asked again within the 60 s. A steered message, or
  one the agent already took, answers `too_late`;
- `interrupt_task` stops the agent of a task the user named (its run interrupted, its
  queued runs cancelled), after a "oui". It takes a followed task's spoken name, else the
  title of any thread. A task with no run answers `not_running`. The task stays followed,
  and "non, arrête" cancels nothing after it;
- `follow_thread` / `unfollow_thread` follow any thread by its title, or stop following
  a task by its spoken name. Two threads with one title are offered as "<title> sur
  <project>";
- `get_task_details` gives a task's status from T3 and the long summary of its last
  finished run, with the cause and `resumes_at` of a failure. It takes a followed task's
  spoken name, else the title of any thread;
- `end_session` when the user says "fin" or "c'est bon, merci": the session closes 5 s later.

A reference that fits several projects or tasks acts on none: the answer lists the choices.

A risky action needs a spoken "oui", checked by the companion, not by the voice model:

1. The first call does nothing. It answers `{needs_confirmation: true, read_back, confirmation}`.
   `confirmation` is a token.
2. The model reads `read_back` and asks the question.
3. The model calls the same tool again with `confirmation`. What runs is the action that
   was read back, whatever else the second call says.
4. The action runs only if the user's words since the question (the engine's transcript,
   kept in memory only) hold a yes word ("oui", "ouais", "vas-y", "d'accord", "ok",
   "confirme"…) and no word of doubt ("non", "pas", "mais", "attends"…). When the user
   said nothing yet, the companion waits 1.5 s for a late transcript.

The answers when nothing runs:

- `not_confirmed`: the answer was not a clear yes;
- `confirmation_expired`: the answer came more than 60 s after the question;
- `invalid_confirmation`: the token is unknown, already used, or from another tool or session.

A token works once. A voice session has one question at most: a new question replaces the
one before.

While a session is open, the companion announces the news of each followed task: a run
that completed (after 5 s, in case the agent goes on) with a short summary, a run that
failed with its cause and when it can resume, a question or a permission request. It
speaks at the next 2 s gap in the conversation, and each event once, even after a
reconnect or a restart. With no session open, the news goes to the push sender, which
only logs it until ntfy (#25).

While T3 reconnects, the tools answer `t3_unavailable`. A revoked device gets no T3 data:
the companion checks the device before each tool call and every 30 s, and closes the
session of a revoked one. When `serve` stops, it closes every session, those still opening
included. If the companion's control channel to GPT-Live drops, it attaches again (after
1, 2 and 4 s) before it gives up. A new channel is usable once it has stayed up 10 s; until
then, tool results wait, and a drop counts as a failed attach. While a session closes, a
channel is used as soon as it attaches: the queued events go out on the first new channel,
then the close; the close is sent again on each new channel until OpenAI confirms it, 20 s
at most after the first close sent. The logs say when a session opens and ends, never what
was said, asked or answered.

- Every request except `POST /pair` needs a device token (`Authorization: Bearer <token>`). Without a valid
  one, the answer is `401` with an empty body. A revoked device is refused on its next
  request.
- A device token is replaced the first time it is used after 30 days. The answer then
  carries the new token in a `T3Voice-Token` header; the app must store it. The old token
  keeps working until the new one is used. If the app missed the header, its next request
  with the old token (a minute later at least) gets another new token.
- Every request is rate-limited: 120 requests per minute per client IP (counted before
  the token check, so guessing tokens is throttled) and 60 per minute per device. IPv6
  callers are counted by their /64 prefix. Over the limit, the answer is `429` with a
  `Retry-After` header.

Settings in `config.json`, all optional:

```json
{
  "t3": { "baseUrl": "http://127.0.0.1:3773" },
  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "clientIpHeader": "cf-connecting-ip",
    "publicUrl": "https://voice.example.com"
  },
  "voice": {
    "model": "gpt-live-1",
    "voice": "brise",
    "delegationModel": "gpt-5.6-terra",
    "summaryModel": "gpt-5.4-mini"
  }
}
```

`voice` sets the GPT-Live session. `delegationModel` is the Responses model GPT-Live hands
the user's requests to; it calls the companion's tools by name. It is billed per token, on
top of GPT-Live's $0.05 per minute.

`summaryModel` is the cheap text model that summarizes what an agent did when a followed
task completes or fails. The announcement speaks the short summary; `get_task_details` gives the
long one. `get_task_details` on a finished thread nobody follows also asks for a summary,
on each request, and keeps none. The model reads the agent's last messages of the run,
with `store: false`. Without an OpenAI key there are no summaries.

`publicUrl` is the HTTPS address the iPhone reaches the companion at. `t3-voice pair` puts it
in the QR code, and needs it.

`clientIpHeader` names the header a local proxy sets to the caller's IP. Behind a
Cloudflare Tunnel it is `cf-connecting-ip`. The companion reads it only on connections from
loopback, so a remote caller cannot pick its own IP. When the header lists several
addresses, only the last one counts, since the proxy appends the one it saw. Prefer a
header that holds one address the proxy overwrites. Without it, every request through the
proxy counts as one IP, and the companion logs a warning on the first proxied request.

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
5. Set `"publicUrl": "https://voice.example.com"` in `config.json`.
6. Check from outside: `curl -i https://voice.example.com/activity` must answer `401`.

## Pair an iPhone

`t3-voice serve` must be running and published over HTTPS (see above). Then:

```sh
t3-voice pair             # shows a QR code; scan it with T3 Voice
t3-voice devices list     # the paired iPhones, with their ids
t3-voice devices revoke ID
```

- `pair` opens the pairing window for 5 minutes and shows a QR code holding
  `t3voice://pair?url=<publicUrl>&code=<one-time code>`. The code is never printed as text.
  The window closes when a device pairs, when it expires, or on Ctrl-C. Each `pair`
  has its own code: running it twice gives two codes, each valid once.
- The app sends `POST /pair` with `{"code": "...", "name": "iPhone de Thomas"}` and gets
  `{"token": "...", "device": {"id": "...", "name": "..."}}`. A wrong, used or expired code,
  or a closed window, gets `401` with an empty body.
- After 10 wrong codes in 10 minutes, counted for all callers together, `POST /pair`
  answers `429` to everyone until the 10 minutes are over. The per-IP limit alone is not
  enough: it forgets old addresses, so a caller with many addresses would escape it.
- `devices revoke` takes effect at the device's next request: `serve` reads the device
  list and the `revoked/` files on every request.
- Each file has one writer, so `serve` and the CLI never overwrite each other's change.
  `serve` saves a paired device together with the hash of its code: that one write uses
  the code up.

## Files

Everything lives in `~/.config/t3voice/` (or `$T3VOICE_CONFIG_DIR`). The companion creates
the directory with mode 700 and every file with mode 600. It never changes the mode of a
directory it did not create: it refuses to use a directory or a file that other users can
open, and prints the `chmod` command that fixes it.

| File | Content |
|---|---|
| `config.json` | T3 URL, optional `t3.acceptedServerVersions`, `server` settings, and optional `voice` settings: `model` (default `gpt-live-1`), `voice` (default `brise`), `delegationModel` (the Responses model GPT-Live hands requests and tool calls to, default `gpt-5.6-terra`), `summaryModel` (the text model that summarizes finished tasks, default `gpt-5.4-mini`) |
| `t3-pairing.json` | T3 token (secret), the URL of the server that issued it, scopes, expiry |
| `devices.json` | Paired iPhones: id, name, SHA-256 of the device token (and of a replacement not used yet), SHA-256 of the pairing code it used, dates. Never a token itself. Only `serve` writes it |
| `revoked/<device id>.json` | One file per `t3-voice devices revoke`: the date. Only the CLI writes them. A damaged file still revokes its device |
| `pairing-windows/<SHA-256 of the code>.json` | While `t3-voice pair` runs: the window's expiry. Never the code itself. Only `pair` writes them; each `pair` touches only its own |
| `tasks.sqlite` | The followed tasks: thread id, project id, spoken name, origin (`voice` or `followed`), the last event announced (so none is told twice), and the summary of each finished run of a task, until the task is unfollowed. Only `serve` opens it |
| `openai.env` | OpenAI key (secret): a line `OPENAI_API_KEY=sk-...`. Without it, `serve` runs but voice sessions are off |

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
    deviceAuth.ts            DeviceAuth: which device a token belongs to; issuing tokens
    apiServer.ts             what `serve` needs to start and stop the HTTP API; activity;
                             voice sessions as the API opens and ends them
    voiceEngine.ts           VoiceEngine: the speech model the phone streams audio to
    taskRegistry.ts          TaskRegistry: followed tasks, what was announced, summaries
    summarizer.ts            Summarizer: the text model that tells what an agent did
    pushSender.ts            PushSender: notifications when no voice session can speak
    clock.ts                 Clock: current time and timers, faked in tests
  core/
    shellState.ts            projects and threads kept up to date; "is this thread running?"
    rateLimiter.ts           requests per key (IP, device) in fixed windows
    pairing.ts               pairing window, one-time codes, global limit on wrong codes
    awareness.ts             T3's awareness rule: running, finished or waiting for the user
    activity.ts              the running / finished list of GET /activity
    voiceSessions.ts         one voice session per device; answers the voice model's tools
    voiceConversation.ts     French instructions and tool definitions for the voice model
    voiceTasks.ts            the task tools: start, message, follow, details, cancel
    spokenNames.ts           short French names for tasks, and finding a task by name
    folderClaims.ts          project folders a voice start just took
    announcements.ts         watches followed tasks: 5 s settle, one announcement per event
    announcementQueue.ts     per-session queue, spoken at the next gap, else pushed
    announcementText.ts      what an announcement says, in French
    taskSummaries.ts         summaries of finished runs, made once and cached
    clock.ts                 the real clock
    secrets.ts               masks credentials in anything the companion prints
  adapters/
    t3-websocket/            T3 over /ws: connector, backend, RPC frames, wire translation,
                             pairing/ticket HTTP calls, pinned version check
    config/                  ConfigStore on files in ~/.config/t3voice/
    device-auth/             DeviceAuth with the companion's own opaque tokens (stored
                             hashed), replaced on use every 30 days
    http/                    the HTTP API: token check and rate limits on every route
    gpt-live/                VoiceEngine on OpenAI GPT-Live: session creation with the
                             phone's offer, control channel for tool calls and speech
    task-registry/           TaskRegistry on SQLite (tasks.sqlite, node:sqlite)
    openai-summarizer/       Summarizer on OpenAI's Responses API
    log-push/                PushSender that only logs, until ntfy
    cli/                     `t3-voice` commands (setup, status, serve, pair, devices)
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
