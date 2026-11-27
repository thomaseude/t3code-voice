# T3 Code Discord

Read the channel list and the rules first. Post in the channel for community projects or
showcases if one exists; otherwise ask a moderator where it fits. Attach the demo video.

---

Hey all 👋 I wanted to go for a run and keep my T3 agents working, so I built an
**unofficial** voice companion for T3 Code, open source (MIT):
https://github.com/thomaseude/t3code-voice

AirPods in, iPhone locked in my pocket, and I manage my agents the way I'd manage a team
on the phone. Press the Action Button (Face ID), then talk:
- "what's running?" / "what finished today?"
- "start Claude on <project> to fix the checkout tests"
- "tell it to add a test" (follow-up in the same thread)
- it tells you out loud when a task you follow finishes or fails, with a short summary

How it works: a small Node companion runs next to your T3 server and talks to it on
loopback; the iPhone app carries only audio (WebRTC) and never touches T3. Voice runs on
your ChatGPT plan through Codex, or on the OpenAI API.

Caveats: it speaks **French only** for now (English is the #1 open issue), and you build
the iOS app yourself with Xcode (a free Apple account works).

Feedback and contributors very welcome: there are `good first issue`s, and the companion
is plain TypeScript, no Mac needed.
