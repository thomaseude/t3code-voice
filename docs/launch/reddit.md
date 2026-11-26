# Reddit

Read each subreddit's rules on the day you post. One subreddit per day. Use a text post
with the video, and adapt the angle to the subreddit.

## r/selfhosted (angle: self-hosted, security)

**Title:** I made an open-source voice companion to drive my self-hosted coding agents from a locked iPhone

I self-host T3 Code (an app that runs Claude Code / Codex agents on my own box). I wanted
to drive it hands-free, so I built T3 Voice (unofficial, MIT):

- A small Node service runs next to T3 and talks to it on loopback only.
- The iPhone pairs with a one-time QR code (5-minute window, single-use code), and every
  request needs a device token. Rate limits on every route.
- The phone holds no API key and never talks to T3 directly.
- I publish it through a Cloudflare Tunnel; Tailscale/Caddy docs are an open issue.
- Logs contain no audio, transcripts or code.

[demo] · https://github.com/thomaseude/t3code-voice

Happy to answer questions about the setup. Contributions welcome.

## r/ClaudeAI or r/ChatGPTCoding (angle: agent workflow)

**Title:** I start and follow my Claude/Codex coding tasks by voice while walking — open source

[2–3 lines on the workflow, the example phrases, the announcement when a task finishes,
then the link. Check whether the subreddit has a weekly self-promotion thread.]

## r/iOSProgramming (angle: iOS engineering)

**Title:** Keeping a realtime voice conversation alive with the iPhone locked: WebRTC, Live Activities and App Intents (open source)

[What was hard: background audio rules, Face ID before a start from the locked screen,
Action Button / Siri / Control Center triggers. Link to the code.]
