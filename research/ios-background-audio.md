# iOS background audio constraints (ticket #6)

Research for map #2 / brief #1. Sources were checked on 2026-10-25 against Apple documentation for iOS 26/27, the App Review Guidelines (last updated 2026-10-16) and Apple DTS answers on the Developer Forums. Items marked **[verify]** can only be confirmed on a physical iPhone. They feed prototype ticket #8.

## Answer

- **A locked-screen voice session is feasible without CallKit, but only if the user starts it in the foreground.** Use `UIBackgroundModes = audio`, an `AVAudioSession` in `.playAndRecord`, and activate the session while the app is in the foreground. While the session stays active (mic engine running), iOS does not suspend the app. Mic capture, TTS playback and the WebSocket/WebRTC connection all keep working with the screen locked. An Apple DTS engineer stated this directly in May 2026 ([thread 826462](https://developer.apple.com/forums/thread/826462)).
- **Recording cannot *start* from the background.** "There's a privacy block in place that prevents recording sessions from activating in the background." Only CallKit, LiveCommunicationKit and PushToTalk are exempt, and only for real communication apps ([thread 816408](https://developer.apple.com/forums/thread/816408)). Practical consequences:
  - A push such as "Claude has finished" cannot reopen the microphone.
  - Siri, Shortcuts, the Action Button or an AirPods gesture cannot start a new session while the app is in the background.
- **Design rule: one long-lived session.** Start it in the foreground, keep the audio engine running for the whole conversation (mute logically, never deactivate), and end it explicitly. After the session ends, or after an interruption iOS refuses to resume, the user has to bring the app to the foreground again. Live Activities and App Intents can show and control the session, but they cannot cold-start recording.
- **Interruptions** (phone call, Siri, alarms, other non-mixable audio) deactivate the session. iOS 27 adds new lifecycle notifications for this (`didBecomeInactive` / `resumptionRecommendation`) ([Apple](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)). Whether a `.playAndRecord` session can **re-activate from the background after a call ends** is the single most important thing to test on device **[verify]**.
- **AirPods:**
  - `.voiceChat` mode forces Bluetooth HFP. That gives you echo cancellation and AGC but narrow-band output ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat)).
  - The "high-quality AirPods recording" option is not meant for real-time use and is unavailable in the EU ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/bluetoothhighqualityrecording)).
  - Route changes must be handled through `routeChangeNotification` ([Apple](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes)).
- **CallKit / VoIP push are off the table for this app.** "You're not a VoIP app, so you can't use CallKit" ([DTS](https://developer.apple.com/forums/thread/826462)). VoIP pushes *must* be reported as calls to CallKit, or the app is killed and pushes stop ([Apple](https://developer.apple.com/documentation/pushkit/pkpushregistrydelegate/pushregistry(_:didreceiveincomingpushwith:for:completion:))). PushToTalk exists for walkie-talkie apps only, and needs a foreground user action to join a channel ([Apple](https://developer.apple.com/documentation/pushtotalk/creating-a-push-to-talk-app)).
- **Agent-completion events while no voice session is active** have to be ordinary APNs alert notifications sent by the companion service (already planned in #2). They cannot be a spoken voice.
- **App Store risk is moderate, and the MVP (Xcode/TestFlight) is not affected.** The `audio` mode is defensible because the app really plays and records audio in the background (2.5.4). Approval risk comes from:
  - abusing the mode to keep an *idle* app alive (for example, keeping it alive only to wait for agents);
  - having no clear recording indicator (2.5.14);
  - sending audio to a third-party AI without explicit consent (5.1.2(i));
  - using CallKit/VoIP without being a calling app (2.5.1 / 2.5.4).
- **ChatGPT shows the same pattern.** Its "Background Conversations" voice mode is opt-in. Once a session has started, it continues when you switch apps or lock the screen, and shows a Live Activity ([BGR, 2024](https://www.bgr.com/tech/chatgpt-voice-just-got-a-big-privacy-upgrade-for-background-conversations/); secondary source, as OpenAI's help center was not fetchable).

## Details

### 1. Background modes: `audio` vs `voip` vs `push-to-talk`

| Mode | What Apple says it is for | Fit for us |
|---|---|---|
| `audio` | "The app plays audible content in the background" ([Configuring background execution modes](https://developer.apple.com/documentation/xcode/configuring-background-execution-modes)) | **Yes**: this is the mode to use |
| `voip` | "The app provides Voice over IP services. For more information, see the CallKit framework." (same page) | No: tied to CallKit and PushKit VoIP, policy restricted |
| `push-to-talk` | "The app launches in response to a push notification and plays audible content in the background" (same page, plus the [PushToTalk](https://developer.apple.com/documentation/pushtotalk) framework) | No: walkie-talkie UX and semantics, see §6 |

- **Default behavior.** iOS suspends an app "shortly after the user has moved it to the background" ([Quinn, DTS, "iOS Background Execution Limits", rev. 2026-01-09](https://developer.apple.com/forums/thread/685525)).
- **With the `audio` mode and an active session:** "Because your app has the 'audio' background category and an active audio session, … it's allowed to stay active indefinitely (as long as its session is active)" ([Kevin Elliott, DTS, May 2026](https://developer.apple.com/forums/thread/826462)).
- **The two requirements he lists:**
  1. have the `audio` background category;
  2. "ONLY activate your audio session in the foreground."

  He also warns that "many of our higher-level APIs do their own session activation/deactivation. Don't use those APIs." This matters for WebRTC stacks, see §3.

### 2. AVAudioSession configuration

- **Category `.playAndRecord`.** It is for "recording (input) and playback (output) of audio, such as for a VoIP app". "Your audio continues … with the screen locked. To continue playing audio when your app transitions to the background … add the `audio` value to UIBackgroundModes." It is non-mixable by default, so activating it interrupts other non-mixable audio such as Music or podcasts ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playandrecord)).
- **Mode `.voiceChat`.** It optimizes for two-way voice and limits routes to voice-suitable ones. It also automatically applies `allowBluetoothHFP`. Real echo cancellation and AGC only happen with the Voice-Processing I/O unit or `AVAudioEngine.setVoiceProcessingEnabled(_:)` ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat)). This is the natural choice for a barge-in capable assistant.
- **Alternative: `.default` mode with `setPrefersEchoCancelledInput(true)`.** It gives wider-band echo cancellation on the built-in speaker, on certain 2024+ iPhones only. It may switch off when the route changes to a headset ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/setprefersechocancelledinput(_:))). It is not useful with AirPods.
- **Bluetooth options:**
  - `allowBluetoothHFP` makes HFP devices available for *input* ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/allowbluetoothhfp)).
  - A2DP is output-only. When both options are set, "the system gives hands-free ports a higher priority" ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/allowbluetootha2dp)).
  - Result: with an AirPods mic, playback goes over HFP (call-quality audio).
- **`bluetoothHighQualityRecording` (iOS 26, WWDC25 session 251).** It enables full-bandwidth AirPods input, but has several limits for us ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/bluetoothhighqualityrecording), [WWDC25-251](https://developer.apple.com/videos/play/wwdc2025/251/)):
  - it works only in `.default` mode;
  - it "may increase input latency … isn't recommended for real-time communication";
  - it is not supported in the EU.

  Conclusion: not suitable for our real-time use, especially for a French user.
- **Activation failures:**
  - Activating `.playAndRecord` while another app hosts a call fails with `insufficientPriority` ([setActive](https://developer.apple.com/documentation/avfaudio/avaudiosession/setactive(_:options:))).
  - Activating a non-mixable session from the background fails with `cannotInterruptOthers`.
  - Starting a mixable recording from the background fails with `cannotStartRecording` ([error codes](https://developer.apple.com/documentation/coreaudiotypes/avaudiosession/errorcode)).
  - `siriIsRecording` is a dedicated error for when Siri is recording (same page).

### 3. Can recording start in the background, or only continue?

**It can only continue.**
- Kevin Elliott (DTS, Feb 2026) on starting recording from a Bluetooth trigger: "There's a privacy block in place that prevents recording sessions from activating in the background. Our voice communication APIs (CallKit, LiveCommunicationKit, and the PushToTalk framework) do allow this … but they can't be used for any other purpose" ([thread 816408](https://developer.apple.com/forums/thread/816408)).
- `AudioRecordingIntent` (iOS 18+) tells the system that the app records audio, and makes the system show a recording indicator. The app "must start a Live Activity when you begin the audio recording and keep it active … If you don't start a Live Activity, the audio recording stops" ([Apple](https://developer.apple.com/documentation/appintents/audiorecordingintent)).
- Developer reports say that starting it from a fully backgrounded state (Shortcut or Action Button) fails ([thread 815725](https://developer.apple.com/forums/thread/815725), non-Apple reply, so weak evidence). That is consistent with the DTS statement above. **[verify]** whether an `AudioRecordingIntent` run from Siri or the Action Button can start a session when the app was recently in the foreground but is now suspended.
- **WebRTC caveat.** Google's WebRTC (used by the OpenAI Realtime WebRTC path) and LiveKit both manage `AVAudioSession` themselves. LiveKit only documents "add the Audio, AirPlay, and Picture in Picture background mode" ([LiveKit Swift docs](https://docs.livekit.io/transport/sdk-platforms/swift/)). This conflicts with DTS's advice not to let higher-level APIs activate and deactivate the session. Example risk: the SDK deactivates the session when a track is unpublished, and then cannot re-activate it in the background. **[verify]** with the chosen engine (#5/#7). Owning the session ourselves (manual audio handling and a WebSocket transport) avoids this.

### 4. Keeping the WebSocket / WebRTC connection alive

- "The key factor here is not foreground/background but running/suspended. If your app is running, the system won't nix its network connections" ([Quinn, DTS, 2022](https://developer.apple.com/forums/thread/716118)).
- "If you're an audio playing app then you can use the audio background mode … which prevents your app from being suspended, which means your networking will work" ([Quinn, DTS, 2019](https://developer.apple.com/forums/thread/124737)).
- Once the app is suspended, sockets may be reclaimed ("all networking operations on the socket will fail") ([TN2277, archived](https://developer.apple.com/library/archive/technotes/tn2277/_index.html)). There is no general way to keep a socket alive or to wake on socket data: background URLSession is HTTP-only, and DTS points to pushes instead ([thread 685525](https://developer.apple.com/forums/thread/685525)).
- **Implications:**
  - The T3 Code / companion WebSocket and the voice-engine connection are reliable only while the voice session is active.
  - When the session ends, expect the app to be suspended within seconds and the sockets to die. Everything that happens next has to arrive through APNs alert pushes from the companion service.
  - The app needs reconnect/resync logic on every return to the foreground. This is an existing "Not yet specified" item in #2.
- **[verify]**:
  - Connection stability over long locked periods, including Wi-Fi to cellular handover with the screen off.
  - Whether Low Power Mode changes anything.

### 5. Interruptions and route changes

- **Legacy notification (iOS ≤ 26).** Use `AVAudioSession.interruptionNotification`: `.began` / `.ended`, plus `.shouldResume`.
- **iOS 27+ lifecycle notifications.** `didBecomeInactiveNotification` (with a `DeactivationContext` saying whether the system or the app caused it) and `resumptionRecommendationNotification`. The latter "isn't tied to the interrupting app's end-of-interruption signal, so your app doesn't stay stuck in an interrupted state" ([Handling audio interruptions](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)). Support both, because the deployment target decides which applies.
- **Incoming calls.**
  - If the user's call display style is *banner*, `setPrefersNoInterruptionsFromSystemAlerts(true)` keeps the session uninterrupted until the call is accepted.
  - With the full-screen style, the system always interrupts ([Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/setprefersnointerruptionsfromsystemalerts(_:))).
  - While the user is on a cellular or FaceTime call, the app cannot capture the mic (`insufficientPriority`, [setActive](https://developer.apple.com/documentation/avfaudio/avaudiosession/setactive(_:options:))).
- **Siri.** It takes the mic. Expect an interruption, or the `siriIsRecording` error ([error codes](https://developer.apple.com/documentation/coreaudiotypes/avaudiosession/errorcode)).
- **Other apps' audio.** Starting Music or a podcast with a non-mixable session interrupts us. Our activation interrupts them. Using `mixWithOthers` avoids this, but then background start becomes `cannotStartRecording` territory ([mixWithOthers](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/mixwithothers)).
- **Resume strategy.** On interruption end, or on a resumption recommendation, try `setActive(true)` and restart the engine.
  - If that fails while in the background, keep the WebSocket state and update the Live Activity to "Paused, tap to resume".
  - Send a local notification. Tapping it opens the app, and the session can be re-activated in the foreground.
  - A forum answer suggests a Live Activity button (`LiveActivityIntent`, which runs in the app process ([Apple](https://developer.apple.com/documentation/appintents/liveactivityintent))) can resume after an interruption ([thread 815725](https://developer.apple.com/forums/thread/815725), unofficial). **[verify]**
- **Route changes.**
  - Observe `routeChangeNotification`. Use `newDeviceAvailable` / `oldDeviceUnavailable` and inspect `currentRoute` ([Apple](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes)).
  - Since iOS 17, a route disconnect only interrupts *Now Playing* sessions (`setPrefersInterruptionOnRouteDisconnect`, [Apple](https://developer.apple.com/documentation/avfaudio/avaudiosession/setprefersinterruptiononroutedisconnect(_:))). When AirPods are removed, we must therefore decide ourselves whether to pause, so the assistant does not start speaking from the loudspeaker.
  - **[verify]** AirPods auto-switching to a Mac or iPad, and case-in or case-out, mid-session.
- **AirPods controls.**
  - Remote commands (stem press) come through `MPRemoteCommandCenter` ([Apple](https://developer.apple.com/documentation/mediaplayer/mpremotecommandcenter)), but are normally delivered to the "Now Playing" app.
  - The AirPods mute gesture is handled "internally" by the system on iOS ([AVAudioApplication](https://developer.apple.com/documentation/avfaudio/avaudioapplication/setinputmutestatechangehandler(_:))).
  - **[verify]** whether a stem press or the mute gesture reaches a `.playAndRecord`/`.voiceChat` app that is not a CallKit call. That would be useful as a "push to interrupt" or "mute" control.

### 6. Alternatives and complements

- **CallKit / LiveCommunicationKit.** These integrate VoIP calls with the system call UI, and they are what lifts the background-recording block. But DTS says "you're not a VoIP app, so you can't use CallKit" ([thread 826462](https://developer.apple.com/forums/thread/826462)). PushKit VoIP pushes *must* be reported to CallKit, otherwise "the system will terminate your app" and may stop delivering pushes ([Apple](https://developer.apple.com/documentation/pushkit/pkpushregistrydelegate/pushregistry(_:didreceiveincomingpushwith:for:completion:)), [PushKit guide](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit)). Using it would also mean a fake "call" UI for every agent notification. **Not recommended**: high App Review risk (2.5.1 "use APIs … for their intended purposes"), even though it is technically possible for a sideloaded single-user build.
- **PushToTalk.**
  - The system UI plus an ephemeral APNs token wake the app to *play* incoming audio in the background. The user can transmit from the lock screen.
  - Joining a channel requires the app in the foreground "with explicit user interaction". Only one PTT channel can exist system-wide, and the default mode is half-duplex ([Apple](https://developer.apple.com/documentation/pushtotalk/creating-a-push-to-talk-app)).
  - It would allow the companion to *speak* an agent-completion message on the lock screen, which nothing else allows.
  - It is designed for people-to-people walkie-talkie use, so App Review fit is questionable (2.5.1/2.5.4).
  - **Open option, worth one spike** if spoken out-of-session notifications become a requirement.
- **Live Activities.** Use one as the visible "session on / listening / paused" indicator and for lock-screen controls (mute, end, resume) via `LiveActivityIntent`. Limits ([Apple](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)):
  - maximum 8 h active (12 h on the Lock Screen);
  - no network access from the activity itself;
  - updates come from the app or from ActivityKit pushes.

  It also partly satisfies 2.5.14 (recording indication). **Recommended.**
- **App Intents / Siri.**
  - Useful to *open* the app and start a session ("Hey Siri, start T3 Voice"): starting it in the foreground is allowed.
  - `AudioRecordingIntent` and `LiveActivityIntent` give a system recording indicator and lock-screen controls.
  - They do not get around the background-start privacy block (§3).
- **APNs alert notifications** from the companion service cover "task finished" when no session is running. Only the push itself is shown or read out: Siri's "Announce Notifications" on AirPods is a user setting, not something the app controls **[verify]**.

### 7. App Store Review Guidelines (last updated 2026-10-16)

Source: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

- **2.5.4:** "Multitasking apps may only use background services for their intended purposes: VoIP, audio playback, location, task completion, local notifications, etc."
  - The typical rejection text reads: "your app declares support for audio in the UIBackgroundModes key … but did not include features that require persistent audio" ([forum report](https://developer.apple.com/forums/thread/671406)).
  - DTS: background mechanisms "must be visible to the user, and tightly controlled by App Review" ([thread 124737](https://developer.apple.com/forums/thread/124737)).
- **2.5.1:** "Apps should use APIs and frameworks for their intended purposes". This is the risk for CallKit, PushToTalk or VoIP misuse.
- **2.5.14:** "explicit user consent and … a clear visual and/or audible indication when recording … This includes any use of the … microphone". The system orange mic indicator is there anyway; add a Live Activity and in-app state.
- **5.1.1(ii)/(iv):** consent, purpose strings (`NSMicrophoneUsageDescription`) and a way to withdraw consent.
- **5.1.2(i):** "You must clearly disclose where personal data will be shared with third parties, including with third-party AI, and obtain explicit permission". This applies because the voice audio goes to OpenAI or another provider.

**What makes approval risky:**
1. Keeping the app alive in the background while nothing is being played or recorded. For example, holding a silent session open only to wait for agent completion is classic 2.5.4 abuse.
2. Using CallKit, PushKit VoIP or PushToTalk for a non-calling assistant.
3. An always-listening mic with no visible indicator or explicit opt-in.
4. Undisclosed sending of audio to a third-party AI.

Because session start must happen in the foreground and is user-initiated, and because a Live Activity shows the state, our design matches the ChatGPT pattern, which is on the App Store. Out of scope per #2, but the spec does not block it.

## To verify on device (feeds prototype #8)

- [ ] `audio` mode + `.playAndRecord`/`.voiceChat`, session activated in the foreground, then lock the screen: mic capture and TTS playback continue for at least 30 min over AirPods. Watch for unexplained kills (`runningboardd` logs, see [thread 826462](https://developer.apple.com/forums/thread/826462)).
- [ ] The WebSocket (T3 Code / companion) and the voice-engine connection (WebSocket or WebRTC) stay up while locked, including through a Wi-Fi to cellular handover.
- [ ] Stopping and restarting the `AVAudioEngine` (or VPIO unit) in the background, while the session stays active, works. If not, keep the engine running and mute in software.
- [ ] After a phone call ends (banner style vs full-screen style), the session can be re-activated from the background. Test both the legacy (iOS 26) and lifecycle (iOS 27) notifications.
- [ ] Siri invocation mid-session: interruption and resume behavior.
- [ ] Another app starting music or a podcast mid-session, and our resume afterwards.
- [ ] AirPods removed, case-in, auto-switch to a Mac, then reconnected: route-change handling, with no fallback to the loudspeaker.
- [ ] Whether the AirPods stem press (MPRemoteCommandCenter) and the mute gesture reach the app during a non-CallKit `.voiceChat` session.
- [ ] HFP audio quality of the TTS over AirPods is acceptable, compared with `.default` mode with no voice processing (echo/barge-in tradeoff).
- [ ] Whether the chosen voice SDK (OpenAI Realtime WebRTC, LiveKit, or a custom one) deactivates or re-activates the session behind our back, and whether we can take ownership of `AVAudioSession`.
- [ ] Can an `AudioRecordingIntent` or `LiveActivityIntent` (Live Activity button, Siri, Action Button) resume or start recording when the app is backgrounded but not terminated? Expected: start is blocked; resume after interruption is uncertain.
- [ ] Live Activity start, update and end from a background-running app during the session, and the 8 h limit.
- [ ] Battery drain per hour of a locked, idle-but-listening session.
- [ ] Optional spike: PushToTalk full-duplex channel as a way to *speak* agent-completion messages while no session is running.
