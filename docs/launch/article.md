# Article (dev.to, in English)

Rewrite it in your own voice before you publish. Add the demo video at the top. Tags:
`ai`, `ios`, `typescript`, `opensource`.

---

# I drive my coding agents by voice, with the iPhone locked in my pocket

I run coding agents, Claude Code and Codex, through [T3 Code](https://github.com/pingdotgg/t3code)
on my own server. At the desk, it works well. Away from it, it does not: an agent finishes,
asks a question or needs an approval, and it waits until I am back in front of a screen.

So I built **T3 Voice**, an unofficial, open-source voice companion. I put my AirPods in,
press the Action Button, pass Face ID, and talk:

- "What is running?"
- "Start Claude on my-shop to fix the checkout tests."
- "Tell it to add a test for the empty cart."

When a task I follow finishes or fails, the assistant tells me out loud, with a summary
of two or three sentences. I never unlock the phone.

This post is about four problems that were harder than they looked.

## 1. Talking to an iPhone that is locked

iOS suspends apps in the background. Before writing the real app, I built a throwaway
prototype to answer one question: does a two-way voice conversation keep working with the
screen locked and AirPods in?

It does, with a live WebRTC audio session. The prototype kept listening and answering
while locked, AirPods routing and barge-in worked, and Live Activity buttons (End, Mute)
worked from the Lock Screen. Two lessons went into the real app:

- Starting a session took 6–7 seconds. Do not wait for the full ICE gathering.
- When the AirPods disconnect, mute the mic. Do not switch to the loudspeaker in the
  middle of a conversation.

## 2. The phone must not be the weak point

A phone gets lost, or stays on a table. So the iPhone app holds no API key and never
talks to the coding server. Three parties are involved:

- the **iPhone**, which carries only the audio (WebRTC, to the voice model) and a small
  HTTPS control channel (to the companion);
- the **companion**, a small Node service on the same machine as T3, which talks to T3 on
  loopback only;
- the **voice model**, which acts on T3 only through the companion's tools: list, start,
  follow up, stop.

Pairing uses a QR code that holds a one-time code, valid for 5 minutes. Every request
then needs a device token, and every route has rate limits. Every conversation starts
behind Face ID. The logs hold no audio, no transcript and no code.

## 3. Building on a protocol that is not a public API

T3 Code's WebSocket protocol is internal: it can change in any release. A voice assistant
that misreads a status could announce "done" for a task that failed, or act on the wrong
thread.

So the companion **fails closed**. It pins the exact T3 and Codex versions it was tested
with, checks them on every new socket, and refuses to start on any other version. To
support a new version, you add it to the pin and run the integration tests, which start
a throwaway T3 server with a temporary data directory and an empty HOME.

T3's wire format never leaves one adapter. The rest of the code uses the companion's own
types, in a hexagonal layout that a unit test enforces: the core imports only ports, and
an adapter never imports another adapter.

## 4. A voice "yes" is dangerous

Speech recognition mishears. "Stop the tests task" must never stop the wrong task because
of a guess. The rules:

- Starting a task is immediate, but the assistant repeats what it started, and "no, stop"
  right after undoes it.
- Interrupting a task needs its name and a spoken "yes" to the confirmation.
- Anything unclear never counts as "yes".
- A bare "stop" only silences the assistant. It never stops an agent.

## Cost

Voice runs on the ChatGPT plan through `codex app-server` while the plan has more than
20 % of its quota left. Below that, it falls back to the OpenAI realtime API, with a daily
budget that stops new sessions. A silence ends the session after 3 minutes, or after 20
minutes while a followed task runs.

## Try it, or help

The code is on GitHub under the MIT license:
https://github.com/thomaseude/t3code-voice

[Adapt: language status.] You build the iOS app yourself with Xcode; a free Apple account
is enough. The companion is plain TypeScript, tested on Linux, so you can contribute
without a Mac. Issues labelled `good first issue` are a good place to start.
