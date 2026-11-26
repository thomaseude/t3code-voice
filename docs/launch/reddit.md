# Reddit

Read each subreddit's rules on the day you post. One subreddit per day. Use a text post
with the video, and adapt the angle to the subreddit.

## r/selfhosted (angle: self-hosted, security)

**Title:** I go running while my self-hosted coding agents work, and I manage them by voice (open source)

I self-host T3 Code (an app that runs Claude Code / Codex agents on my own box). I wanted
to leave the desk, go for a run, and still hand out work and hear when it's done. So I
built T3 Voice (unofficial, MIT). AirPods in, iPhone locked in the pocket. The setup:

- A small Node service runs next to T3 and talks to it on loopback only.
- The iPhone pairs with a one-time QR code (5-minute window, single-use code), and every
  request needs a device token. Rate limits on every route.
- The phone holds no API key and never talks to T3 directly.
- I publish it through a Cloudflare Tunnel; Tailscale/Caddy docs are an open issue.
- Logs contain no audio, transcripts or code.

[demo] · https://github.com/thomaseude/t3code-voice

Happy to answer questions about the setup. Contributions welcome.

## r/ClaudeAI or r/ChatGPTCoding (angle: agent workflow)

**Title:** I manage my Claude/Codex agents by voice while I'm out running (open source)

[Open with the run: what you said, what you heard back. Then the example phrases, the announcement when a task finishes,
then the link. Check whether the subreddit has a weekly self-promotion thread.]

## r/iOSProgramming (angle: iOS engineering)

**Title:** Keeping a realtime voice conversation alive with the iPhone locked: WebRTC, Live Activities and App Intents (open source)

[What was hard: background audio rules, Face ID before a start from the locked screen,
Action Button / Siri / Control Center triggers. Link to the code.]
