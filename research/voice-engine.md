# Voice engine choice (ticket #7)

Research for map #2 / brief #1. All sources were read on **2026-10-25**. Prices and model names in this area change every few months, so re-check the linked pricing pages before committing a budget. Cost figures marked **(est.)** are my own arithmetic from the cited unit prices, using the reference hour defined in §3. Items marked **[verify]** need a prototype on a real iPhone with AirPods.

## Answer

- **Recommendation: OpenAI Realtime API, `gpt-realtime-2.1` (A/B against `gpt-realtime-2.1-mini`), over WebRTC from the iPhone. The companion service mints an ephemeral client secret and attaches a server-side "sideband" WebSocket to the same call.** The app carries only audio. The companion service holds the API key and the tools (T3 Code connector), and it injects "agent finished" announcements. This is the one option that meets every hard requirement with documented, GA primitives:
  - ephemeral tokens with a 10 s – 2 h TTL;
  - WebRTC, with server-side truncation on barge-in;
  - function calling, plus `response.create` at any time for proactive speech;
  - a sideband control channel;
  - per-token billing, so a mostly idle session costs almost nothing while agents run.
- **Strong runner-up, to test in the same prototype: OpenAI GPT-Live (`gpt-live-1`, launched Sept 2026).** It is a full-duplex voice front-end that *delegates* work to a backend. That maps almost 1:1 onto "voice ↔ companion service ↔ T3 agents", and it has first-class events for injecting results (`session.commentary.append`). Against it:
  - it is very new;
  - the docs show no ephemeral-token flow (the server proxies the SDP instead, which still keeps the key off the device);
  - it bills **$0.05/min for the whole connected session, including idle time** (about $3/h). That is a poor fit for a long-lived locked-screen session that mostly waits on agents (see #6).
- **Cascaded STT → LLM → TTS is the fallback, not the default.** It gives the best control over French + English technical vocabulary (keyterm/keyword hints) and lets Claude be the "brain". It is also the cheapest per hour (about $1–2/h est.). But you have to build or host turn-taking, barge-in and echo handling yourself (realistically LiveKit Agents or Pipecat plus a media server next to the companion service). OpenAI's own standalone TTS models are deprecated (shutdown 2027-01-06). Choose it only if the prototype shows Realtime mangling French technical terms.
- **Gemini Live (`gemini-3.8-live`)** has the best *feature fit on paper*:
  - 99 languages including French, with mid-conversation language switching;
  - async `NON_BLOCKING` tool calls with `WHEN_IDLE`/`INTERRUPTED` scheduling;
  - ephemeral tokens.

  It is not recommended for the MVP because:
  - it is WebSocket only (no WebRTC), so the client handles playback truncation and jitter;
  - connections last about 10 min and need session resumption;
  - **accumulated audio context is re-billed on every turn with no cached-audio discount**, which makes cost per hour hard to predict despite the low $/min headline;
  - the iOS (Firebase AI Logic) Live support is in Preview, and its tools documentation is "coming soon".
- **ElevenLabs Agents** has an official Swift SDK, conversation tokens, WebRTC and Claude as a selectable LLM. Against it: $0.08/min (about $4.80/h) plus LLM cost, agent and tool configuration lives on ElevenLabs' platform, and there is no documented "speak now" primitive (`sendContextualUpdate` does not prompt a reply). Viable, but more expensive and less controllable than Realtime.
- **Anthropic has no audio API.** Current Claude models take text and image input and produce text output only. Claude can only be the LLM inside a cascade. The T3 Code agents themselves stay Claude/Codex regardless of the voice engine.
- **Cost per hour of conversation (reference hour, est.):**

  | Option | Cost per hour (est.) |
  |---|---|
  | Realtime 2.1 | ~$2.4 |
  | Realtime 2.1-mini | ~$1.0 |
  | GPT-Live | ~$3.0 + backend |
  | ElevenLabs | ~$5 |
  | Cascade | ~$1–2 |
  | Gemini Live | ~$1–16, highly sensitive to turn count and context compression |

  The Realtime figures **depend on prompt caching** ($0.40 vs $32 per 1M audio input tokens), which OpenAI describes as "best-effort".
- **French quality and end-to-end latency are not published in comparable form by any provider.** They must be measured in a prototype with a fixed French script full of English technical terms ("lance Codex sur la PR, fixe le test `ReviewsService` qui fail en CI").

## Comparison

| Criterion | OpenAI Realtime (`gpt-realtime-2.1` / `-mini`) | OpenAI GPT-Live (`gpt-live-1`) | Gemini Live (`gemini-3.8-live`) | ElevenLabs Agents | Cascade (e.g. Deepgram Flux + LLM + TTS via LiveKit/Pipecat) |
|---|---|---|---|---|---|
| Architecture | Speech-to-speech, one model handles audio, reasoning and tools [^oa-agents] | Full-duplex voice model that delegates reasoning and tools to a backend (`client` or `responses` delegation) [^live-model][^live-deleg] | Native-audio speech-to-speech [^g-cap] | STT + LLM + TTS + proprietary turn-taking model (or their realtime model) [^el-overview] | Three separate services you orchestrate [^oa-agents] |
| French + EN tech terms | French supported. No published FR benchmark. 2.1 claims "improved alphanumeric recognition" [^oa-21] **[verify]** | French voices listed [^live-conv]. No benchmark **[verify]** | 99 languages incl. `fr`, can switch language mid-conversation [^g-cap] **[verify]** | 31 voice languages / 70+ TTS languages [^el-overview] **[verify]** | Best control: OpenAI `gpt-transcribe` `prompt` + `keywords` [^oa-stt]; Deepgram `flux-general-multi` code-switching incl. FR + keyterms [^dg-flux] |
| Latency | No official ms figures. One hop. WARP cuts setup round trips [^warp] | No official figures (0.8 s turn-taking claimed in secondary press [^live-press]) | No official figures [^g-live] | No official figures [^el-overview] | Three hops. Deepgram Flux end-of-turn < 400 ms (vendor claim) [^dg-flux-launch]. Highest risk |
| Barge-in | Built in. With WebRTC the server auto-truncates unplayed audio [^oa-conv]. Semantic VAD [^oa-vad] | Full duplex, both can talk at once [^live-conv] | Server VAD cancels generation and sends an interruption message; the client must flush playback [^g-cap] | Built-in turn-taking model [^el-overview] | Framework-provided (LiveKit turn detector) [^lk-agents], otherwise DIY |
| Tool calling | Function calling, parallel tool calls [^oa-21][^oa-conv]. Can run on the server via sideband [^oa-sideband] | Tools are run by our backend (client delegation) or by a Responses model [^live-deleg] | Async `NON_BLOCKING` + `SILENT`/`WHEN_IDLE`/`INTERRUPTED` scheduling on 3.8 [^g-cap] | Client tools in the Swift SDK (`ClientToolCallEvent`), defined in the ElevenLabs UI [^el-swift] | Any LLM's tool calling [^lk-agents] |
| Ephemeral client token | **Yes**: `POST /v1/realtime/client_secrets`, TTL 10–7200 s (default 600) [^oa-cs] | No token documented. The server proxies the SDP to `POST /v1/live/sessions` (key stays on the server) [^live-webrtc] | **Yes**: `v1beta/auth_tokens`, can be locked to a model/config [^g-eph] | **Yes**: conversation token minted by the server [^el-swift][^el-js] | Depends on the stack (LiveKit JWT room tokens) |
| Transport / iOS | WebRTC (recommended for mobile), WebSocket, SIP [^oa-webrtc]. **No official Swift SDK**: use libwebrtc, e.g. LiveKit's build [^warp] | WebRTC / WebSocket / SIP [^live-guide]. No Swift SDK | **WebSocket only** [^g-live]. Firebase AI Logic Swift support is in **Preview** [^fb-live] | WebRTC by default for voice [^el-js]. **Official Swift SDK**, iOS 14+ [^el-swift] | LiveKit and Pipecat both have iOS SDKs [^pc-ios] (WebRTC) |
| Proactive speech | `conversation.item.create` + `response.create` at any time, from the client or sideband [^oa-conv][^oa-sideband] | `session.commentary.append` (paraphrased) / `session.instructions.append` (verbatim, can interrupt) [^live-deleg] | Send content / `WHEN_IDLE` async tool results [^g-cap] | `sendUserMessage` forces a turn (hack). `sendContextualUpdate` does not prompt a reply [^el-js] | Trivial: just call TTS |
| Session limits | 60 min max per session [^oa-conv] | Duration limit exists but is not stated [^live-conv] | 15 min audio session without compression. ~10 min connection, resumable for 2 h [^g-sess] | n/a in docs | None inherent |
| Billing model | Per token. Context is re-sent every turn, cached input is 80–99% cheaper [^oa-price][^oa-cost] | $0.05/min of connected session, **idle included** [^live-model][^oa-latcost] | Per token, **whole context re-billed each turn**. Input billed all the time while listening (proactive audio) [^g-bp][^g-price] | $0.08/min + LLM pass-through [^el-price][^el-llm] | Sum of parts |
| **$/hour (est., §3)** | **~$2.4 (2.1) / ~$1.0 (mini)** | **~$3.0 + backend** | **~$1–16 (unpredictable)** | **~$5** | **~$1–2** (+ $0.60 if LiveKit Cloud) |

## Details

### 1. OpenAI Realtime API (speech-to-speech)

- **Models and prices** ([pricing](https://developers.openai.com/api/docs/pricing)), per 1M tokens:

  | Model | Audio input | Cached input | Audio output | Text input | Text output |
  |---|---|---|---|---|---|
  | `gpt-realtime-2.1` | $32 | $0.40 | $64 | $4 | $24 |
  | `gpt-realtime-2.1-mini` | $10 | $0.30 | $20 | $0.60 | $2.40 |

  `gpt-realtime-2.1` has a 128k context window and 32k max output. It supports reasoning effort, function calling, and text/audio/image input. It "updates GPT-Realtime-2 with improved alphanumeric recognition, silence and noise handling, and interruption behavior" ([model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)). GPT-Realtime-2 (May 2026) added parallel tool calls and "preambles", short spoken acknowledgements while it works (secondary: [eWeek](https://www.eweek.com/news/openai-gpt-realtime-2-voice-agents/)).
- **Audio token rates:** user audio is 1 token per 100 ms and assistant audio is 1 token per 50 ms. "The entire conversation is sent to the model for each Response". Caching is automatic but "best-effort and not guaranteed", and changing instructions or tools mid-session breaks it ([costs guide](https://developers.openai.com/api/docs/guides/realtime-costs)).
- **Ephemeral tokens:** `POST /v1/realtime/client_secrets` returns `ek_…`. `expires_after.seconds` ranges from 10 to 7200 (default 600). The session config (model, instructions, tools, VAD) can be attached server-side ([API ref](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create)). The client then POSTs its SDP straight to `https://api.openai.com/v1/realtime/calls` with the ephemeral key, and the standard key stays on the server ([WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc)). Set `OpenAI-Safety-Identifier` on the token request ([Realtime guide](https://developers.openai.com/api/docs/guides/realtime)).
- **Sideband:** the server takes the `call_id` from the `Location` header of the `/v1/realtime/calls` answer and opens `wss://api.openai.com/v1/realtime?call_id=…` with its own key. It can then:
  - observe events;
  - send `session.update`;
  - **handle tool calls privately**.

  "Assign one owner for each function call" ([server controls](https://developers.openai.com/api/docs/guides/realtime-server-controls)). One catch: the `call_id` comes back to the client, so the app has to report it to the companion service.
- **Barge-in:** "The server will automatically truncate unplayed audio when there's a user interruption" on WebRTC/SIP. On WebSocket the client must send `conversation.item.truncate` ([conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)). Turn detection modes:
  - `server_vad` (silence-based);
  - `semantic_vad`, with `eagerness` low/medium/high, which is less likely to cut off a user who trails off mid-sentence (useful for French speakers searching for an English term).

  VAD can be disabled ([VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad)).
- **Tools and proactive speech:** tool calls arrive as `function_call` items. The result goes back as `conversation.item.create` (`function_call_output`) followed by `response.create`. `response.create` can also be sent with no user turn, and out-of-band with `conversation: "none"` ([conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)). That is how the companion service says "Claude a terminé" through the sideband.
- **Limits:** "The maximum duration of a Realtime session is 60 minutes" ([conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)). A conversation longer than that needs a transparent reconnect, which means a fresh ephemeral token and re-seeding a short summary. Whether that works from the locked-screen background state is **[verify]** (see #6/#8).
- **iOS:** the docs recommend WebRTC for mobile clients but ship no Swift SDK. The native path is a `libwebrtc` build (the docs cite LiveKit's as an example) plus a pre-negotiated data channel for events ([WARP guide](https://developers.openai.com/api/docs/guides/realtime-webrtc-warp)).

### 2. OpenAI GPT-Live

- **What it is:** "a full-duplex voice model for real-time conversations" that can "delegate reasoning and tool use to a backend agent". Pricing:
  - $0.05/min, billed per second; "Backend model and tool usage is billed separately";
  - rate limits are concurrent sessions (Build: 50).

  It works only on `v1/live/sessions`, not on the Realtime endpoints ([model page](https://developers.openai.com/api/docs/models/gpt-live-1)). Launched around 2026-09-10 (secondary: [aiweekly](https://aiweekly.co/alerts/openai-launches-gpt-live-1-in-the-api-at-005minute-cuts-turn-taking-latency-to)).
- **Client delegation is the interesting mode:** the app (here, the companion service) receives `session.delegation.created`. That event "does **not** contain the user's utterance or task text", so the backend rebuilds the request from transcript deltas. It replies with:
  - `session.commentary.append` ("Results the user should hear", paraphrased);
  - `session.thinking.append` (quiet context);
  - `session.instructions.append` (verbatim, "can interrupt current speech").

  Each append is capped at 500 tokens. "Interrupting speech does not stop backend work." The guide explicitly describes long-running tasks that report back later ([delegation guide](https://developers.openai.com/api/docs/guides/live-delegation.md)). This is very close to our "never block the conversation" requirement.
- **Auth:** the getting-started and WebRTC guides show the client sending its SDP to *your* server, which calls `POST /v1/live/sessions` with the project key ([voice WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [getting started](https://developers.openai.com/api/docs/guides/live.md)). No GPT-Live ephemeral token is documented. This still meets "no long-lived key in the app", but session start then depends on the companion service being reachable.
- **Cost pitfalls:**
  - "billing covers the whole active session, including when the backend is working or both sides are silent";
  - session creation bills 15 s;
  - OpenAI's own advice is to "Close voice sessions during long backend tasks" ([latency & cost](https://developers.openai.com/api/docs/guides/voice-latency-cost)).

  Our design keeps one long-lived session open while the screen is locked, because iOS forbids restarting the mic from the background (#6). So we pay for the idle time.
- **Other caveats:**
  - "GPT-Live has no corresponding event marking the end of each spoken response" ([migration](https://developers.openai.com/api/docs/guides/live-migration));
  - context is 128k, with background summarization of older history ([conversations](https://developers.openai.com/api/docs/guides/live-conversations));
  - the docs state neither the session duration limit nor GA/preview status.

### 3. Cost per hour: reference hour and arithmetic (est.)

**Reference hour:** one 60-minute session containing 20 min of user speech, 12 min of assistant speech and about 100 turns, with about 3k tokens of instructions and tools. A hands-free session that mostly waits on agents would have far less speech, and the per-token options would then cost proportionally less.

- **Realtime `gpt-realtime-2.1` ≈ $2.4/h:**
  - output: 12 min × 1,200 tok/min = 14.4k tok × $64/M ≈ $0.92;
  - uncached input (each new user and assistant item, read once): (12k + 14.4k) × $32/M ≈ $0.84;
  - cached re-reads: ~100 turns × ~16k average context ≈ 1.6M × $0.40/M ≈ $0.64.
- **Realtime `gpt-realtime-2.1-mini` ≈ $1.0/h:** same token counts at $20, $10 and $0.30 per 1M.
- **If caching failed entirely**, the re-reads would be billed at $32/M, about $50/h. Monitor `cached_tokens` in `response.done` ([costs](https://developers.openai.com/api/docs/guides/realtime-costs)), and use `retention_ratio` / truncation to cap context ([latency & cost](https://developers.openai.com/api/docs/guides/voice-latency-cost)).
- **Optional input transcription** (for the UI or T3 thread notes): `gpt-live-transcribe` at $0.017/min ([pricing](https://developers.openai.com/api/docs/pricing)).
- **GPT-Live ≈ $3.00/h:** 60 min × $0.05, idle included. Backend LLM calls are extra (cents, if a small model summarizes T3 events).
- **Gemini Live ≈ $1–16/h:**
  - unit prices: audio input $3/M (≈ $0.005/min) and output $12/M (≈ $0.018/min) for `gemini-3.8-live` ([pricing](https://ai.google.dev/gemini-api/docs/pricing));
  - **but** "The API charges you per turn for all tokens present in the session context window", and audio accrues at about 25 tok/s ([best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices));
  - with proactive audio (always on in 3.8), "the API charges for input tokens the entire time the Live API is listening" (same page);
  - no cached-audio discount is listed;
  - **upper bound:** 100 turns × ~54k average context ≈ 5.4M tok ≈ $16;
  - with sliding-window compression at ~16k: ≈ 1.6M tok ≈ $5;
  - the low end assumes only speech segments stay in context.

  Developers report cost "scales with turn count, not call duration" ([forum, 2026-07](https://discuss.ai.google.dev/t/does-gemini-live-native-audio-bill-cumulative-prompt-tokens-on-every-turn-cost-seems-to-scale-with-turn-count-not-call-duration/173248), not official).
- **ElevenLabs Agents ≈ $5/h:**
  - $0.08/min × 60 = $4.80, plus LLM tokens at the provider's rate "with no markup" ([pricing](https://elevenlabs.io/pricing/api), [LLM docs](https://elevenlabs.io/docs/agents-platform/customization/llm));
  - silent periods are "billed at 5% of the usual per minute rate", but the docs do not say which meter that applies to ([cost optimization](https://elevenlabs.io/docs/eleven-agents/customization/llm/optimizing-costs)).
- **Cascade ≈ $1–2/h:**

  | Component | Cost |
  |---|---|
  | STT: Deepgram Flux Multilingual streaming for 60 min ([pricing](https://deepgram.com/pricing)) | $0.47 |
  | LLM: e.g. Claude Haiku 5.5 (from $0.10/$0.50 per MTok, [models](https://platform.claude.com/docs/en/about-claude/models/overview)) or a GPT mini model, ~100 cached calls | ~$0.1–0.5 |
  | TTS: ~10k characters for 12 min of speech, Deepgram Aura-2 at $0.030/1k or ElevenLabs Flash at $0.04/1k ([EL pricing](https://elevenlabs.io/pricing/api)) | ~$0.3–0.4 |
  | Optional: LiveKit Cloud agent session at $0.01/min on Ship ($50/mo) ([LiveKit pricing](https://livekit.com/pricing)), or self-hosted (open source) | +$0.60 |

### 4. Gemini Live

- **Models:** `gemini-3.8-live` is the default and `gemini-3.8-live-extended-thinking` adds more reasoning. `gemini-3.1-flash-live-preview` is legacy.
- **Languages:** 99 languages including `fr`. Native audio can switch languages mid-conversation ([capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)). The overview page says "70 supported languages", an inconsistency in Google's own docs ([overview](https://ai.google.dev/gemini-api/docs/live-api)).
- **Tools:** 3.8 supports async `NON_BLOCKING` calls with `SILENT` / `WHEN_IDLE` / `INTERRUPTED` scheduling, a natural fit for "announce when idle". But "When an interruption cancels pending calls, the server discards them" ([capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)).
- **Limits:**
  - audio sessions last 15 min without context-window compression;
  - connection lifetime is "around 10 minutes", with `GoAway` warnings;
  - resumption handles are "valid for 2 hr" ([session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)).
- **Ephemeral tokens:** created at `v1beta/auth_tokens`. Defaults:
  - 1 min to start a session;
  - 30 min of messaging;
  - can be locked via `liveConnectConstraints`;
  - "only compatible with Live API", over WebSockets ([ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens)).

  A 1-hour conversation therefore needs token refresh plus resumption.
- **Transport:** "Stateful WebSocket connection (WSS)". WebRTC is available only through partners (LiveKit, Pipecat, etc.) ([overview](https://ai.google.dev/gemini-api/docs/live-api)).
- **iOS:** Firebase AI Logic Swift Live API support is in Preview. Its tools section says "Official documentation for using tools with the Live API is coming soon!", and App Check becomes mandatory on 2026-11-02 ([Firebase](https://firebase.google.com/docs/ai-logic/live-api)).

### 5. ElevenLabs Agents

- **Architecture and LLMs:** a cascade of fine-tuned STT, an LLM, TTS and a "proprietary turn-taking model" ([overview](https://elevenlabs.io/docs/agents-platform/overview)). Selectable LLMs include Claude Opus/Sonnet/Haiku, GPT and Gemini, or a custom LLM endpoint ([LLM docs](https://elevenlabs.io/docs/agents-platform/customization/llm)).
- **Swift SDK:** iOS 14+, with `ElevenLabs.startConversation(auth: .conversationToken(token))` for private agents, client tools via `ClientToolCallEvent` / `sendToolResult`, and a warning against storing the API key in the app ([Swift SDK](https://elevenlabs.io/docs/agents-platform/libraries/swift)).
- **Transport:** voice defaults to WebRTC ([JS SDK](https://elevenlabs.io/docs/agents-platform/libraries/javascript)).
- **Proactive speech** (same JS SDK page):
  - `sendContextualUpdate` "does not prompt a reply";
  - `sendUserMessage` "will prompt the agent to take its turn", which means faking a user turn to announce completion.

### 6. Cascade building blocks

- **STT:**
  - OpenAI `gpt-transcribe` supports `prompt` + `keywords` + `languages` for vocabulary hints ([STT guide](https://developers.openai.com/api/docs/guides/speech-to-text)). For live mic audio, OpenAI points to `gpt-live-transcribe` (same page).
  - Deepgram `flux-general-multi` supports code-switching across ten languages including French and English ([self-hosted Flux](https://developers.deepgram.com/docs/flux-self-hosted)). It has keyterm prompting (up to 100) and claims end-of-turn decisions in under 400 ms ([Flux Multilingual launch](https://deepgram.com/learn/deepgram-launches-flux-multilingual-press-release)). Keyterm support specifically on the multilingual model is not confirmed.
  - Mistral Voxtral realtime STT (French vendor) is reported at about $0.006–0.008/min (secondary only, [llmreference](https://www.llmreference.com/model/voxtral-mini-transcribe-realtime-3/mistral-ai-api)). Unverified.
- **TTS:** OpenAI `gpt-4o-mini-tts`, `tts-1` and `tts-1-hd` "are deprecated and will shut down on January 6, 2027". The suggested replacement is `gpt-realtime-2.1-mini` via the Realtime API ([TTS guide](https://developers.openai.com/api/docs/guides/text-to-speech)). Use ElevenLabs, Cartesia or Deepgram Aura-2 instead (French voices to be checked).
- **Frameworks:**
  - LiveKit Agents provides an STT-LLM-TTS pipeline, a turn-detection model, interruption handling and tool calls, and is self-hostable ([docs](https://docs.livekit.io/agents/)). Its OpenAI plugin also supports `gpt-realtime-2.1`, and a "half-cascade" (realtime model for understanding plus a separate TTS) ([plugin](https://docs.livekit.io/agents/models/realtime/plugins/openai/)). That is a fallback if Realtime's French *voice* is fine but its *pronunciation* of English terms is not.
  - Pipecat has an iOS SDK with Daily, Gemini, OpenAI WebRTC and SmallWebRTC transports ([Pipecat iOS](https://docs.pipecat.ai/client/ios/introduction)).
  - Either one adds a media server and agent worker to the companion-service deployment, which is heavier than "installable next to any T3 Code server".

### 7. Anthropic

- "All current models support text and image input, text output" ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview)). There is no audio input or output in the API.
- Claude's voice mode exists only in the consumer apps (secondary: [Business Standard](https://www.business-standard.com/technology/tech-news/anthropic-s-claude-gets-voice-mode-similar-to-chatgpt-gemini-how-it-works-125052800518_1.html)).
- Claude is therefore usable only as the LLM in a cascade, or inside ElevenLabs Agents.

### 8. How the recommendation maps onto the architecture

```
iPhone (SwiftUI, libwebrtc) ── WebRTC audio + oai-events ──▶ OpenAI Realtime (gpt-realtime-2.1)
      │  ① GET ephemeral token                                   ▲
      ▼                                                          │ ③ sideband WSS ?call_id=…
Companion service (API key, tools, T3 connector, APNs) ──────────┘
      ② app reports call_id → companion attaches sideband, owns all tool calls,
         injects "agent finished" via conversation.item.create + response.create
```

- No key on the device.
- Tool execution and T3 credentials stay server-side.
- The app does not have to know the tool schema.
- If the voice session is closed, the companion service falls back to APNs (#6).

## Open questions for the prototype (#8 or a new ticket)

1. A French + English jargon script, run through `gpt-realtime-2.1`, `-mini` and GPT-Live: measure WER on technical terms, TTS pronunciation of English words, and time from end of speech to first audio (p50/p95).
2. Real cache hit rate and $/h on a 30-min session, read from `response.done.usage`.
3. Realtime 60-min rollover and WebRTC reconnect with the screen locked **[verify]**.
4. Whether background noise or AirPods HFP makes VAD create spurious turns (cost and UX).
5. Sideband `call_id` hand-off latency, and who owns the tool calls.

## Sources (read 2026-10-25)

[^oa-price]: https://developers.openai.com/api/docs/pricing
[^oa-21]: https://developers.openai.com/api/docs/models/gpt-realtime-2.1
[^oa-cs]: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
[^oa-webrtc]: https://developers.openai.com/api/docs/guides/realtime-webrtc
[^oa-conv]: https://developers.openai.com/api/docs/guides/realtime-conversations
[^oa-vad]: https://developers.openai.com/api/docs/guides/realtime-vad
[^oa-cost]: https://developers.openai.com/api/docs/guides/realtime-costs
[^oa-sideband]: https://developers.openai.com/api/docs/guides/realtime-server-controls
[^oa-agents]: https://developers.openai.com/api/docs/guides/voice-agents
[^oa-latcost]: https://developers.openai.com/api/docs/guides/voice-latency-cost
[^oa-stt]: https://developers.openai.com/api/docs/guides/speech-to-text
[^warp]: https://developers.openai.com/api/docs/guides/realtime-webrtc-warp
[^live-model]: https://developers.openai.com/api/docs/models/gpt-live-1
[^live-deleg]: https://developers.openai.com/api/docs/guides/live-delegation.md
[^live-conv]: https://developers.openai.com/api/docs/guides/live-conversations
[^live-webrtc]: https://developers.openai.com/api/docs/guides/voice-webrtc
[^live-guide]: https://developers.openai.com/api/docs/guides/live.md
[^live-press]: https://aiweekly.co/alerts/openai-launches-gpt-live-1-in-the-api-at-005minute-cuts-turn-taking-latency-to (secondary)
[^g-price]: https://ai.google.dev/gemini-api/docs/pricing
[^g-cap]: https://ai.google.dev/gemini-api/docs/live-api/capabilities
[^g-live]: https://ai.google.dev/gemini-api/docs/live-api
[^g-sess]: https://ai.google.dev/gemini-api/docs/live-api/session-management
[^g-eph]: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
[^g-bp]: https://ai.google.dev/gemini-api/docs/live-api/best-practices
[^fb-live]: https://firebase.google.com/docs/ai-logic/live-api
[^el-price]: https://elevenlabs.io/pricing/api
[^el-llm]: https://elevenlabs.io/docs/agents-platform/customization/llm
[^el-overview]: https://elevenlabs.io/docs/agents-platform/overview
[^el-swift]: https://elevenlabs.io/docs/agents-platform/libraries/swift
[^el-js]: https://elevenlabs.io/docs/agents-platform/libraries/javascript
[^dg-flux]: https://developers.deepgram.com/docs/flux-self-hosted
[^dg-flux-launch]: https://deepgram.com/learn/deepgram-launches-flux-multilingual-press-release
[^lk-agents]: https://docs.livekit.io/agents/
[^pc-ios]: https://docs.pipecat.ai/client/ios/introduction
