# PROTOTYPE: locked-screen audio (ticket #8)

Throwaway code. It answers one question, then it is deleted:

> Does a minimal SwiftUI app keep a two-way voice conversation working through AirPods with the iPhone locked for 10+ minutes, and survive route changes and interruptions?

The app opens an OpenAI Realtime voice session over WebRTC from the foreground, then keeps it alive with the screen locked. Every few minutes it makes the model say a fake "task finished" announcement, to stand in for the companion. Everything that happens is written to a log file you export after each test.

**Shortcuts compared to the real app (do not copy them):** the app holds a standard OpenAI key in the Keychain and mints its own ephemeral key. Announcements come from the app, not from a companion sideband. There is no T3 and no companion.

## Setup (about 10 minutes)

1. On the Mac: `brew install xcodegen`.
2. `git clone -b prototype/locked-screen-audio https://github.com/thomaseude/t3code-voice && cd t3code-voice/prototypes/locked-screen-audio && xcodegen`.
3. Open `LockedAudioProto.xcodeproj`. For **both** targets, in Signing & Capabilities, pick your team. If Xcode complains about the bundle id, change `co.joombo.t3voice.proto` in `project.yml` and run `xcodegen` again.
4. Plug in the iPhone (Developer Mode on), select it, then Run. The first build downloads the WebRTC package (~50 MB).
5. In the OpenAI dashboard, create a dedicated project with a $10 budget and a key for it. Paste the key in the app. Revoke it after the tests.
6. Settings → Voice Proto → allow Live Activities (on by default).

Cost: `gpt-realtime-2.1-mini` costs about $1/h of conversation, so the whole protocol costs a few dollars. Leave the model on mini: this ticket tests audio survival, not voice quality (that is #12).

## Reading the log

Each line looks like `14:02:31.120 [BG/locked] message`. `BG` means the app is in the background, and `/locked` means the device is locked. Useful lines:

- `hb …` is a heartbeat every 30 s. It shows the connection state, `audioActive` / `audioEnabled`, the route and the battery. **If heartbeats stop while locked, iOS suspended the app.** That is a failure.
- `INTERRUPTION BEGAN/ENDED`, `RESUME OK/FAILED`, `ROUTE CHANGE`, `REMOTE COMMAND`, `DEVICE LOCKED/UNLOCKED`, `network …`.
- `ANNOUNCE #n sent`, then `response.done … said="…"`.

Export the log with "Export log file" (AirDrop to the Mac, or save to Files) and attach it to the ticket.

## Test protocol

Default settings unless stated. "Announce every 5 min" is the default. Start each test with the app on screen and AirPods in, unless stated otherwise.

| # | Test | How | Pass if |
|---|---|---|---|
| T1 | 30 min locked | Start, talk for 1 min, lock, put the phone in your pocket. Ask something every ~10 min. | You hear all 6 announcements, your questions get answered, and `hb` lines continue the whole time. Note the battery % at start and end. |
| T2 | Network handover | During a locked session, walk out of Wi-Fi range (or turn Wi-Fi off from Control Center). | The conversation comes back by itself. Note how many seconds it takes (`peer state`, `auto-reconnect` lines). |
| T3 | Soft vs hard mute in background | Lock, Mute from the Live Activity, wait 2 min, Unmute. Then repeat with "Hard mute" on. | Audio comes back after Unmute in both cases. If hard mute fails, the real app must keep the engine running and mute in software. |
| T4 | Phone call | While locked, get called from another phone. Answer, talk 30 s, hang up. Repeat with Settings → Apps → Phone → Incoming Calls set to "Banner", then to "Full Screen". | **Key unknown.** Write down which one happens: (a) `RESUME OK` by itself, (b) the Live Activity Resume button works, (c) you have to open the app. |
| T5 | Siri | During a locked session, say "Dis Siri, quelle heure est-il ?". | Same three outcomes as T4. |
| T6 | Other audio | During the session, start music from Control Center, then pause it. | Same three outcomes as T4. Also note whether the music stopped our session. |
| T7 | AirPods removed | Take both AirPods out. Then put them back and tap Unmute. Then put them in the case. Then let them switch to the Mac. | Nothing ever plays on the loudspeaker (`MUTED source=headset-lost`). After putting them back and unmuting, audio works again. |
| T8 | AirPods stem press | During the session, press the stem once, then use the mute gesture if you have one. | Write down whether `REMOTE COMMAND` appears in the log. |
| T9 | Audio quality | Do one 3-min session with "voiceChat mode" on and one with it off. Interrupt the assistant while it is speaking. | Choose which mode sounds acceptable, and check whether the assistant hears itself (echo) or misses your interruptions. |
| T10 | SDK and audio session | Nothing to do: read the logs from T1–T7. | `audioActive=true` in every `hb` line until Stop. Any `false` means WebRTC deactivated the session behind our back. |
| T11 | Start from Siri / Action Button | Stop the session, send the app to the background (do not kill it), lock. Say "Start voice test in Voice Proto" (or bind the shortcut to the Action Button). | Expected to fail. Write down what happens: an error, or it starts but the mic stays silent. |
| T12 | Live Activity | Look at the lock screen throughout T1–T7. | It appears at start, updates while locked, and its buttons work. |
| T13 | Battery | Use T1's numbers. | Gives %/h for a locked, listening session. |
| T14 | 60-min rollover | Set "Force reconnect every" to 3 min, start, lock for 10 min. | Announcements keep coming after each reconnect, and nothing plays on the loudspeaker. This stands in for the 60-min session cap. |
| T15 | False turns | Leave a locked session for 10 min in a noisy place (TV, café) without talking. | Note the number of "User turns" and responses. Each one is a false turn. |

PushToTalk (item 14 of the research checklist) is skipped: it is out of scope in the map.

## Results template (paste into ticket #8)

```
iPhone model / iOS version:
AirPods model:
T1 30 min locked: pass/fail — battery x% → y% in z min — notes
T2 handover: recovered in N s / did not recover
T3 soft mute: ok/ko — hard mute: ok/ko
T4 call (banner): a/b/c — call (full screen): a/b/c
T5 Siri: a/b/c
T6 music: a/b/c — did it stop our session?
T7 AirPods out: speaker leak yes/no — back + unmute ok/ko — case ok/ko — Mac switch ok/ko
T8 stem press reaches app: yes/no — mute gesture: yes/no
T9 voiceChat vs default: preferred = …, echo/barge-in notes
T10 audioActive ever false: yes/no (when?)
T11 start from background: what happened
T12 Live Activity: ok/ko — notes
T14 forced reconnect while locked: ok/ko
T15 false turns in 10 min of noise: N
Logs attached: …
```
