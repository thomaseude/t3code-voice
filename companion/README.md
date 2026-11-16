# t3-voice companion

The service that runs next to a T3 Code server and lets the T3 Voice iOS app drive it.
So far it connects to T3, reports its status, pairs iPhones with a QR code and serves an
HTTP API that only answers paired devices. See the spec in issue #15.

TypeScript on Node 22.18 or later. Voice runs on Codex with a ChatGPT login, or on
OpenAI's API with a key (see [Voice engines](#voice-engines)). One runtime dependency, [`uqr`](https://github.com/unjs/uqr)
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
  defaults to the server's). The companion picks the voice engine (see
  [Voice engines](#voice-engines)), sends it the offer, and answers `201` with
  `{"sessionId", "sdp": "<SDP answer>"}` as soon as the engine answers. On GPT-Live, the
  companion's control channel must also be attached. The engine's answer can take up
  to 15 s; the attach after it waits 3 s at most. The app applies the answer and does not
  wait for full ICE gathering. A device
  has one session at most: a new `POST /sessions` closes the one it still had. Errors:
  `400` `invalid_offer`, `403` `budget_reached` (today's API sessions cost the daily
  budget, and Codex cannot be used), `502` `voice_engine_failed` (OpenAI refused or cannot
  be reached), `503` `voice_unavailable` (no OpenAI key, and Codex cannot be used).
- `POST /sessions/:id/events` tells the companion about the app's microphone. Body
  `{"type": "mute"}` or `{"type": "unmute"}`. It answers `204`, `400` `invalid_event`, or
  `404` when the device has no session with this id.
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
- `summarize_thread` gives a task's status from T3 and a spoken summary of its whole
  conversation, also while the agent runs. When T3's status changes while the summary is
  made, the new status comes with no summary. A failure also gives its cause and `resumes_at`.
  `too_long: true` means part of the conversation was left out: the assistant suggests
  opening T3;
- `get_recent_messages` gives a task's last messages (3 by default, at most 10), oldest
  first, as short spoken excerpts: a code block is named "(bloc de code)", a path keeps its
  file name, a link keeps its words, and an excerpt stops at about 400 characters (`cut:
  true`). `older` is a cursor: passed back as `before`, it reads the messages just older.
  Tool calls and diffs are not messages;
- both reading tools take a followed task's spoken name, else the title of any thread,
  archived ones too when no active thread fits. A bare project name ("Joombo") finds its
  project's only archived thread, never a list of them. They
  give T3's state even for a result the user dismissed in T3, `queued` for a run that waits
  its turn, and `idle` for a thread with no run. They read the whole thread over T3's HTTP
  route `GET /api/orchestration/threads/:id`: the WebSocket's projection is only a window
  of the last turns;
- `end_session` when the user says "fin" or "c'est bon, merci": the session closes 5 s later.

A reference that fits several projects or tasks acts on none: the answer lists the choices.

A risky action needs a spoken "oui", checked by the companion, not by the voice model:

1. The first call does nothing. It answers `{needs_confirmation: true, read_back, confirmation}`.
   `confirmation` is a 4-digit code. It is not a secret (the spoken yes is the check): it ties
   the second call to the question, and is short so the voice model copies it right.
2. The model reads `read_back` and asks the question.
3. The model calls the same tool again with `confirmation`. Only its digits count, so
   `"4 7 1 2"` and `4712` work too. What runs is the action that
   was read back, whatever else the second call says.
4. The action runs only if the user's answer (the engine's transcript, kept in memory
   only) holds a yes word ("oui", "ouais", "vas-y", "d'accord", "ok", "confirme"…) and no
   word of doubt ("non", "pas", "mais", "attends"…). The answer is what the user says in
   turns that start after the assistant started reading the question: words less than 1 s
   apart are one turn, so the late transcript of the request never counts. It is judged
   once the user was quiet 1 s, so "oui… mais attends" is heard whole. When the user said
   nothing yet, the companion waits 1.5 s for a late transcript. An answer still going at
   the end of the 60 s window, or cut by the end of the session, runs nothing.
5. While a question is open, announcements wait: a "oui" only ever answers the question
   the user heard. The question closes when its answer is judged (after the model sends
   the code back), when the user's answer can no longer be a yes ("non", "attends"…),
   after 60 s, or when the session ends.

The answers when nothing runs:

- `not_confirmed`: the answer was not a clear yes;
- `confirmation_expired`: the answer came more than 60 s after the question;
- `invalid_confirmation`: the code is unknown, already used, or from another tool or session;
- `session_closed`: the voice session ended before the question was asked.

A code works once. A voice session has one question at most: a new question replaces the
one before, and never gets its code.

Each refusal writes one log line with its reason, never the code or the transcript, for
example `t3-voice: start_task confirmation refused (invalid_confirmation: wrong_code).` The
reasons of `invalid_confirmation`: `wrong_code`, `already_used`, `other_tool`.

A code sent before any question of the session is made up: the voice model filled the
optional field. The companion logs `confirmation ignored` and runs the call as a first call,
so a risky action still asks its question.

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
at most after the first close sent. The logs say when a session opens and ends, and what it
cost, never what was said, asked or answered.

A session stops by itself after a silence: 3 minutes (`voice.idleMinutes`), or 20 minutes
(`voice.idleMinutesWhileTasksRun`) while a followed task runs. While T3 is away, the limit
it had when T3 was last reachable holds. The user speaking, a tool call, an announcement and
unmuting start the silence again; the assistant speaking alone does not. A muted phone sends
no audio, so muted time counts as silence. 30 s before the
stop, the assistant says it is about to stop; a word keeps the session open. At the limit,
it says it stops, and the session closes 5 s later.

The companion records, for each session, the engine, the minutes it was open and their
estimated cost. On the API, the cost is GPT-Live's $0.05 per minute, silence included; the
delegation model's tokens are not counted. On Codex, the minutes are recorded as
`plan_quota` minutes, at no cost: they draw from the ChatGPT plan, not from money. An open
session saves its record every minute.

The daily budget (`voice.dailyBudgetUsd`, default $10) counts API sessions only. Once
today's API sessions (the server's calendar day) cost 80 % of it, each open API session
hears a warning once, at a gap. At 100 %, the open API sessions say so and close 5 s later,
and new sessions open on Codex only: `POST /sessions` answers `403` when Codex cannot be
used, until the next day. A session on Codex never stops for the budget. A session still
open after midnight counts against the day it started on.

### Voice engines

Two engines speak with the phone. The companion picks one when a session opens, and the
session stays on it until it ends:

- **Codex** (`gpt-live-1-codex`), on the ChatGPT login of the user the service runs as. Its
  minutes draw from the plan's quota, which the coding agents also use. The companion
  starts one `codex app-server` per session, in an empty temporary folder. The voice model
  hands each request to an ephemeral Codex thread: read-only sandbox, no shell, approval
  policy `never`, and the companion's tools as dynamic tools. The thread's final answer is
  spoken when its turn completes. A tool action takes 4 to 8 s with the default model.
- **GPT-Live** (`gpt-live-1`), with the OpenAI key in `openai.env`, at $0.05 per minute.

When a session opens, the companion reads the plan's quota (`account/rateLimits/read`, on a
short-lived `codex app-server`, about 1 s). It takes the lower of the two limits, the 5-hour
window and the week:

| What the companion finds | Engine |
|---|---|
| 20 % or more of the quota left (`voice.minPlanQuotaPercent`) | Codex |
| Less than 20 % left | GPT-Live |
| A limit reached, the quota unreadable, no `codex` on the PATH, a Codex version that is not pinned, or Codex fails to open the session | GPT-Live |

The log line of each choice gives the reason, for example
`t3-voice: no plan engine for device d1: 15 % of the plan's quota is left, under 20 %.`
Without an OpenAI key, the GPT-Live rows answer `503` `voice_unavailable`.

Codex is a server requirement for voice on the plan: install it (`npm install -g
@openai/codex`) and log in with your ChatGPT account (`codex login`), as the user the
service runs as. The Codex voice has no `brise`: it uses Codex's default voice.

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
    "summaryModel": "gpt-5.4-mini",
    "codexModel": "gpt-6.1-terra",
    "codexReasoningEffort": "low",
    "minPlanQuotaPercent": 20,
    "idleMinutes": 3,
    "idleMinutesWhileTasksRun": 20,
    "dailyBudgetUsd": 10
  }
}
```

`voice` sets the voice engines. `codexModel` and `codexReasoningEffort` set the Codex thread
that the Codex engine hands requests and tool calls to. `minPlanQuotaPercent` is the share
of the plan's quota (0 to 100) below which sessions open on GPT-Live. `delegationModel` is the Responses model GPT-Live hands
the user's requests to; it calls the companion's tools by name. It is billed per token, on
top of GPT-Live's $0.05 per minute.

`summaryModel` is the cheap text model that summarizes what an agent did. When a followed
task completes, it reads the agent's last messages of the run, and the announcement speaks
its summary. For `summarize_thread`, it reads the thread's first message and its latest
ones, up to 16,000 characters. That summary is kept in memory until the thread's last
message, its length or T3's status changes. Every call uses `store: false`. Without an
OpenAI key there are no summaries.

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
sed -e "s|@NODE@|$(command -v node)|" -e "s|@MAIN@|$PWD/dist/main.js|" -e "s|@PATH@|$PATH|" \
  deploy/t3-voice.service > ~/.config/systemd/user/t3-voice.service
systemctl --user daemon-reload
systemctl --user enable --now t3-voice
sudo loginctl enable-linger "$USER"   # start at boot, without a login session
journalctl --user -u t3-voice -f      # logs
```

The unit runs the `node` that was on your PATH when you ran `sed`, with that PATH, so the
companion finds `codex` there. After a Node upgrade (with nvm, for example), run the `sed`
line again, then `systemctl --user daemon-reload` and
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
| `config.json` | T3 URL, optional `t3.acceptedServerVersions`, `server` settings, and optional `voice` settings: `model` (default `gpt-live-1`), `voice` (default `brise`), `delegationModel` (the Responses model GPT-Live hands requests and tool calls to, default `gpt-5.6-terra`), `summaryModel` (the text model that summarizes finished tasks, default `gpt-5.4-mini`), `codexModel` (default `gpt-6.1-terra`), `codexReasoningEffort` (default `low`), `minPlanQuotaPercent` (default 20), `acceptedCodexVersions` (replaces the pinned Codex versions), `idleMinutes` (default 3), `idleMinutesWhileTasksRun` (default 20), `dailyBudgetUsd` (default 10) |
| `t3-pairing.json` | T3 token (secret), the URL of the server that issued it, scopes, expiry |
| `devices.json` | Paired iPhones: id, name, SHA-256 of the device token (and of a replacement not used yet), SHA-256 of the pairing code it used, dates. Never a token itself. Only `serve` writes it |
| `revoked/<device id>.json` | One file per `t3-voice devices revoke`: the date. Only the CLI writes them. A damaged file still revokes its device |
| `pairing-windows/<SHA-256 of the code>.json` | While `t3-voice pair` runs: the window's expiry. Never the code itself. Only `pair` writes them; each `pair` touches only its own |
| `tasks.sqlite` | The followed tasks: thread id, project id, spoken name, origin (`voice` or `followed`), the last event announced (so none is told twice), and the summary of each finished run of a task, until the task is unfollowed. The usage of each voice session: engine, billing (`usd` or `plan_quota`), day, start, minutes, estimated cost. Only `serve` opens it |
| `openai.env` | OpenAI key (secret): a line `OPENAI_API_KEY=sk-...`. Without it, `serve` runs, and voice sessions open on Codex only |

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

## Supported Codex versions (fail closed)

Codex's `thread/realtime/*` API is experimental: it changed between Codex 0.156 and 0.165.
Each time the companion starts a `codex app-server`, it reads the Codex version (from the
`userAgent` that `initialize` returns). It uses Codex only when the version is in
`DEFAULT_CODEX_VERSIONS` (`src/adapters/codex-live/compatibility.ts`, currently `0.163.0`).
Otherwise sessions open on GPT-Live. A version range is never accepted.

To support a new Codex version:

1. Add the version to `DEFAULT_CODEX_VERSIONS`.
2. Open a session from the iPhone: it must open, the assistant must speak, and a tool action
   with a spoken "oui" must run. Codex's log (`~/.codex/logs_2.sqlite`) must show the call to
   `chatgpt.com/backend-api/codex/realtime/calls`.
3. Keep the version if all of this works.

No automated test runs the real Codex, because a session draws from the plan's quota. To
unblock one machine before a release, list the versions in `voice.acceptedCodexVersions` in
its `config.json`. The list replaces the pinned versions.

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
    voiceEngine.ts           VoiceEngine: the speech model the phone streams audio to,
                             billed in dollars or to a ChatGPT plan
    planQuota.ts             PlanQuota: what is left of the ChatGPT plan's quota
    taskRegistry.ts          TaskRegistry: followed tasks, what was announced, summaries,
                             usage of voice sessions
    summarizer.ts            Summarizer: the text model that tells what an agent did
    pushSender.ts            PushSender: notifications when no voice session can speak
    clock.ts                 Clock: current time and timers, faked in tests
  core/
    shellState.ts            projects and threads kept up to date; "is this thread running?"
    rateLimiter.ts           requests per key (IP, device) in fixed windows
    pairing.ts               pairing window, one-time codes, global limit on wrong codes
    awareness.ts             T3's awareness rule: running, finished or waiting for the user
    activity.ts              the running / finished list of GET /activity
    voiceSessions.ts         one voice session per device, on the engine picked when it
                             opens; answers the voice model's tools; stops after a silence
                             or at the daily budget; records usage
    engineChoice.ts          whether the plan's quota lets a session open on Codex
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
                             pairing/ticket/thread HTTP calls, pinned version check
    config/                  ConfigStore on files in ~/.config/t3voice/
    device-auth/             DeviceAuth with the companion's own opaque tokens (stored
                             hashed), replaced on use every 30 days
    http/                    the HTTP API: token check and rate limits on every route
    gpt-live/                VoiceEngine on OpenAI GPT-Live: session creation with the
                             phone's offer, control channel for tool calls and speech
    codex-live/              VoiceEngine and PlanQuota on `codex app-server`: pinned
                             version check, realtime over WebRTC, the Codex thread's tools
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
