# Show HN

Post on a weekday, between 14:00 and 16:00 (Paris time), from your own account. Link to
the GitHub repository. Stay two hours to answer. Do not ask anyone to upvote.

## Title (80 characters max)

Show HN: I manage my coding agents by voice while I'm out running

## First comment (post it yourself, right after the submission)

Hi HN, I wanted to go for a run without my coding agents stopping.

With agents (I run Claude Code and Codex through T3 Code, an open-source app, on my own
server), my job is mostly to give direction, wait, and check. Giving direction doesn't
need a screen, yet I was sitting in front of a terminal in case an agent finished or
asked something.

T3 Voice is an unofficial, MIT-licensed voice companion for T3 Code. On a run, with the
iPhone locked in my pocket and AirPods in, I press the Action Button, pass Face ID, and
talk: "what's running?",
"start Claude on my-shop to fix the checkout tests", "tell it to add a test". When a task
I follow finishes or fails, the assistant says so out loud, with a two-sentence summary.

Some things that were interesting to build:

- **Audio with the screen locked.** iOS suspends most apps. A live WebRTC call with the
  right audio session keeps the conversation going, with a Live Activity that shows the
  mic is on.
- **The phone holds no keys and never talks to the coding server.** A small Node
  companion runs next to T3 on loopback. The phone gets the audio stream and a control
  channel, with a per-device token from a one-time QR pairing.
- **Fail closed.** T3's protocol is not a public API, so the companion pins the T3 and
  Codex versions it was tested with and refuses to start on anything else.
- **Confirmations.** Stopping a task needs a spoken "yes"; anything unclear never counts
  as yes.
- **Cost.** Voice runs on the ChatGPT plan through `codex app-server` while the plan has
  quota, and falls back to the OpenAI realtime API with a daily budget.

Limits: you build the iOS app yourself (a free Apple account works), and permission
requests by voice are still in progress. [Adapt: English support status.]

Code: hexagonal TypeScript, unit-tested with fakes, plus integration tests against a
throwaway T3 server. Good first issues are open. I'd love feedback on the voice UX and
the security model.
