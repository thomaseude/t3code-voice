# Agent lifecycle and completion events (ticket #4)

Upstream read: `pingdotgg/t3code` at commit
[`5b35402623d7d1d88eaa472807272a6c2e78012a`](https://github.com/pingdotgg/t3code/tree/5b35402623d7d1d88eaa472807272a6c2e78012a)
(committed 2026-10-25). Everything below is about the **orchestration V2** stack
(`ORCHESTRATION_PROTOCOL_VERSION = 2`). The `legacy/` V1 code was not examined.
All line links point at that SHA, so they can drift from `main`.

## Answer

- **Model.** The server uses event sourcing. Provider adapters (Claude, Codex, and others)
  turn native SDK/JSON-RPC traffic into one normalized `ProviderAdapterV2Event` union
  ([ProviderAdapter.ts L79-167][adapter-event]). The orchestrator persists those as
  **`OrchestrationV2DomainEvent`s** in SQLite with a global `AUTOINCREMENT` `sequence`
  ([055 migration L19-31][events-table], [DomainEvent L1686-1830][domain-event]). Each domain
  event is an *entity upsert* (`run.updated`, `run-attempt.updated`, `provider-turn.updated`,
  `runtime-request.updated`, `turn-item.updated`, `message.updated`, …) that carries the whole
  entity. It is not a delta, so applying events is idempotent.
- **Push.** Clients use Effect RPC over a WebSocket at `GET /ws?…` (the protocol version is
  checked) ([ws.ts L3273-3285][ws-route]). There are two streaming subscriptions:
  `orchestration.subscribeShell` sends a compact per-thread `ThreadShell` (status + pending
  request summary) for every thread. `orchestration.subscribeThread` sends the full
  projection snapshot and then the raw domain events for one thread ([WS methods L3285-3305][ws-methods]).
- **Lifecycle states.** A run moves `preparing → queued → starting → running → waiting →
  completed`. It can also end in `interrupted | failed | cancelled | rolled_back`
  ([RunStatus L512-523][run-status]). Attempts and provider turns use
  `completed | interrupted | failed | cancelled` ([RunAttempt L639-661][attempt], [ProviderTurn L1040-1058][provider-turn]).
  **Gotcha:** run status `waiting` does *not* mean "waiting for the user". It means "the
  agent turn ended OK, and a checkpoint capture / post-terminal drain is still pending". When
  the provider turn completes, the run is written as `waiting` with `completedAt: null`
  ([RunExecutionService L703-718][persisted-waiting]). Only after the checkpoint capture is it
  flipped to `completed` ([CheckpointCaptureService L195-208][capture-completed]).
- **Approvals and questions** are `RuntimeRequest`s
  (`kind: command | file-read | file-change | mcp-elicitation | permission | dynamic_tool_call | user_input | auth_refresh`,
  `status: pending | resolved | expired | cancelled`) ([RuntimeRequest L1077-1100][runtime-request], [ProviderRequestKind][request-kind]).
  Each one is mirrored as an `approval_request` / `user_input_request` turn item with
  `status: "waiting"` ([TurnItem L1464-1516][turn-items]). The shell exposes it as
  `pendingRuntimeRequest {id, kind, createdAt, blocking?}` ([L1874-1881][pending-summary]).
- **"Finished" with confidence: yes**, if you use upstream's own rule.
  `projectThreadAwarenessV2` (used by T3's iOS push / Live Activity relay) derives
  `starting | running | waiting_for_approval | waiting_for_input | completed | failed`
  from the shell ([agentAwareness.ts L103-141][awareness]):
  - A pending `user_input` request (blocking, or the run is no longer live) means **waiting for input**.
  - Any other pending request except `auth_refresh` means **waiting for approval**.
  - Run `completed` means **completed**, unless background tasks still hold it.
  - Run `failed` means **failed**.
  - `interrupted`, `cancelled`, `idle` and `queued` are silent.

  Even upstream waits **5 s to confirm** a `completed` before alerting, because "a run can end
  moments before its continuation starts" ([AgentAwarenessRelay L555-566][relay-confirm]).
- **Failure detail.** A failed terminal carries `OrchestrationV2ProviderFailure`
  `{class: usage_limit|provider_error|transport_error|permission_error|validation_error|unknown, message, code, retryable, resetAt}`
  ([L1310-1332][failure]). It appears as an `error` turn item and as
  `lastError`/`lastErrorClass` on the shell ([ThreadShell L1914-1929][shell-fields]).
- **Recovery after disconnect: yes.** Both subscriptions accept `afterSequence`
  ([SubscribeThreadInput L3500-3509][sub-thread-input], [SubscribeShellInput L3402][sub-shell-input]).
  - **Thread stream:** the server replays the missed events if there are ≤128 events and
    ≤1 MiB. Otherwise it sends a fresh `snapshot` (with `snapshotSequence`) and then
    the live tail ([ThreadStream.ts L15-24, L94-112][thread-stream], [ws.ts L914-985][sub-thread-impl]).
  - **Shell stream:** the gap limit is 1,000 events and 8 MiB ([ws.ts L574-578][shell-gap]).
  - **Optional marker:** with `requestCompletionMarker`, the server sends a `synchronized`
    item once the client is caught up.
  - **Sequences:** they are global and not contiguous per thread, and old superseded
    events are compacted away ([ProjectionMaintenance L289-336][compaction]). Clients must
    treat sequences as a cursor only, never as gap detection.
- **Answering** is a command: `orchestration.dispatchCommand` with
  `{type: "runtime-request.respond", commandId, threadId, requestId, decision?, feedback?, answers?}`.
  - **Approvals:** `decision ∈ accept | acceptForSession | acceptAlways | decline | cancel`.
  - **Questions:** `answers` is a map from question id to answer.
  - **Feedback:** only allowed together with `decline` on a live approval that supports it.

  Sources: [command L3089-3097][respond-cmd], [validation L7775-7830][respond-impl].
  `commandId` is idempotent (receipts) ([L11918-11940][receipts]). Interrupt is
  `run.interrupt {runId}` ([L3040-3046][interrupt-cmd]).
- **Caveat: pending requests do not survive.** On server restart, every pending request
  becomes `expired` / `not_resumable` ([ProviderRuntimeRecoveryService L333-347][restart-expire]).
  Interrupting a run cancels its pending requests ([Orchestrator L9325-9340][interrupt-cancel]).
  Answering a non-pending or `not_resumable` request is rejected.

## Details

### 1. Layers: provider runtime events → domain events → client streams

| Layer | Type | Where |
|---|---|---|
| Native provider traffic | Claude Agent SDK messages / `canUseTool`; Codex app-server JSON-RPC (`turn/started`, `turn/completed`, `item/*/requestApproval`, `item/tool/requestUserInput`, `error`) | [CodexAdapterV2 L4418, L4517, L5114, L5186, L5540, L6123][codex-native]; [ClaudeAdapterV2 L8911-8930][claude-ask] |
| Raw provider log | `OrchestrationV2RawProviderEvent` (direction, JSON-RPC method/id, payload, own sequence) | [L1660-1673][raw-event] |
| Normalized adapter events | `ProviderAdapterV2Event`: `provider_session/thread/turn.updated`, `node.updated`, `subagent.updated`, `message.updated`, `turn_item.updated`, `runtime_request.updated`, `plan.updated`, unpersisted `command_output.delta`, and **`turn.terminal`** | [ProviderAdapter.ts L79-167][adapter-event] |
| Domain events (persisted, sequenced) | `OrchestrationV2DomainEvent` + `OrchestrationV2StoredEvent {sequence, commandId, event}` | [L1675-1830][domain-event], [L2083-2087][stored-event] |
| Read model | `OrchestrationV2ThreadProjection` (runs, attempts, nodes, providerTurns, runtimeRequests, messages, turnItems, …) and the compact `OrchestrationV2ThreadShell` | [L1832-1858][projection], [L1893-1960][shell-fields] |
| Client streams | `ShellStreamItem` (`snapshot`, `thread.updated`, `thread.removed`, `project.*`, `synchronized`), `ThreadStreamItem` (`snapshot`, `event`, `unknown-event`, `synchronized`) | [L2049-2081][shell-stream], [L3610-3633][thread-stream-item] |

`turn.terminal` is the one decisive end-of-turn signal from an adapter. It has
`status: completed | interrupted | cancelled` (no failure), or `status: failed` with a
`failure`, an optional `retry`, and `threadDisposition: reusable | broken`
([ProviderAdapter.ts L141-166][adapter-terminal]). Two examples of how each provider maps to it:

- **Codex:** maps `turn/completed`'s native status. A `completed` that arrives while T3 is
  interrupting that turn is rewritten to `interrupted` ([CodexAdapterV2 L6123-6135][codex-turn-completed]).
- **Claude:** emits the terminal from its turn finalization ([ClaudeAdapterV2 L6815-6850][claude-terminal]).

If the provider event stream ends without a root terminal, the run execution raises
`"Provider event stream ended without a root terminal."` instead of silently hanging
([RunExecutionService L1442-1468][no-terminal]). On a terminal, the ingestor also dismisses
leftover native user-input requests, and for failures it writes an `error` turn item
([ProviderEventIngestor L699-720][ingestor-terminal]).

### 2. Event catalogue mapped to the ticket's vocabulary

| Ticket concept | What to watch (domain event → field) |
|---|---|
| started | `run.updated` with `status` `starting`→`running` (`startedAt` set); `run-attempt.created`; `provider-turn.updated` `running` |
| progress | `turn-item.updated` (`assistant_message`, `reasoning`, `command_execution`, `file_change`, `web_search`, `todo_list`, `subagent`, …) and `message.updated` (`streaming: true`). Live streams coalesce these in a 50 ms window ([ThreadLiveEventCoalescer L18-46][coalescer]) |
| turn completed | `run-attempt.updated` `completed`, then `run.updated` `waiting`, then (after checkpoint) `run.updated` `completed` + `checkpoint.captured` |
| failed | `run.updated` / `run-attempt.updated` `failed` + `turn-item.updated` of type `error` (`failure.class`, `message`, `retryable`, `resetAt`) |
| interrupted | `run.interrupt` command → `turn-item.updated` `run_interrupt_request`, then `run_interrupt_result` + run/attempt `interrupted` ([RunExecutionService L645-700, L765-784][interrupt-items]) |
| permission request | `runtime-request.updated` (`kind` ≠ `user_input`, `status: pending`) + `turn-item.updated` `approval_request` (`requestKind`, `prompt`, `reason`, `options[]` with labels/warnings) |
| clarification question | `runtime-request.updated` (`kind: user_input`) + `turn-item.updated` `user_input_request` with `questions[] {id, header, question, options[], multiSelect, allowCustomAnswer, required}` ([L1201-1217][question]) |
| request resolved | `runtime-request.updated` `status: resolved` (with `decision` / `answers`), or `expired` / `cancelled` |

Claude example: the adapter builds a `waiting` node, a `pending` RuntimeRequest with
`responseCapability: {type: "live", providerSessionId, supportsFeedback}`, and a
`waiting` turn item ([ClaudeAdapterV2 L6490-6560][claude-request]). Its `AskUserQuestion` tool
becomes a `user_input_request` ([L8911-8930][claude-ask]).

Unknown event or turn-item types from a newer server decode to `unknown-event` and still
advance the cursor ([L3576-3608][unknown-event]). That gives forward-compatibility for a
third-party client.

### 3. Distinguishing success / failure / waiting-for-input

Upstream's reference rule (copy it) is in [packages/shared/src/agentAwareness.ts L103-141][awareness]:

```
runStatus = shell.activityRunStatus ?? shell.status
if pendingRuntimeRequest.kind == "user_input" and (blocking != false or run not live) -> waiting_for_input
if pendingRuntimeRequest and kind not in {user_input, auth_refresh}                -> waiting_for_approval
preparing|starting -> starting ; running|waiting -> running
completed -> completed (unless pendingBackgroundTasks hold it -> running)
failed -> failed ; idle|queued|interrupted|cancelled|rolled_back -> (nothing)
```

On top of that rule, it suppresses three cases ([L60-101][awareness-project]):

- a `completed` whose stop the user requested (`latestRunStopRequested`);
- runs marked silent, i.e. idle compaction (`latestRunSilent`);
- subagent child threads.

Points that matter for "announce finished":

- `blocking: false` user-input requests are async questions the run keeps working past.
  `waiting_for_input` is only declared for them once the run is no longer live
  ([L1874-1881][pending-summary], [awareness L107-113][awareness]).
- `waiting` is still "running" for notification purposes ([Orchestrator L611-616][has-live-run]:
  "Waiting runs only drain post-terminal output; their agent turn is over").
- Queued follow-ups or automatic continuations can start right after a completion. The
  relay therefore holds `completed` for 5 s and re-reads before alerting
  ([AgentAwarenessRelay L555-566][relay-confirm]). A voice client should do the same
  (debounce, then re-check `activeRunId` / `status`).
- `usage_limit` failures are surfaced specially: the shell can report `failed` for a
  blocking usage-limit run and expose `usageLimitResetAt`
  ([ProjectionStore L6324-6360][usage-limit]).

### 4. Reconnect / replay

- **Thread stream.** `subscribeThread({threadId, afterSequence?, requestCompletionMarker?, acceptBoundedSnapshot?, …})`
  ([L3500-3509][sub-thread-input]).
  - **No cursor:** `snapshot` (`snapshotSequence` + full or bounded projection), then live events.
  - **With a cursor:** if `afterSequence > highWater`, or the gap is >128 events, or the
    payload is >1 MiB, or the gap contains a thread re-creation, the server sends a
    snapshot instead. Otherwise it replays the stored events, then goes live from the high
    water mark ([ws.ts L783-985][sub-thread-impl], [ThreadStream.ts L94-112][thread-stream]).
  - **Overlap:** the server subscribes before reading, so replay and live can overlap.
    "Clients dedupe overlap by sequence" ([ws.ts L913][sub-thread-impl]).
- **Shell stream.** `subscribeShell({afterSequence?, requestCompletionMarker?, omitIdleSubagents?, omitOlderSettled?})`
  replays when the gap is ≤1,000 events and ≤8 MiB, otherwise it sends a snapshot
  ([ws.ts L574-578, L1163-1200][shell-gap]).
- **Compaction.** Persisted events are compacted: superseded whole-entity rows
  (`message.updated`, `node.updated`, certain thread events) are deleted
  ([ProjectionMaintenance L289-336][compaction]). Replay therefore gives a correct final
  state, but not every intermediate state. That is fine for a voice client, which only
  needs the current state.
- **Command output.** Live command output (`subscribeCommandOutput`) is *not persisted*
  and cannot be replayed ([L3314-3322][cmd-output]).
- **One-shot reads.** `orchestration.getThreadProjection` and `getTurnItem` are available
  ([WS methods][ws-methods]).

### 5. Answering a request / interrupting

- **Dispatch.** Send `orchestration.dispatchCommand` with an `OrchestrationV2Command`. It
  returns `{sequence}` ([L3391-3393][dispatch-result]). `commandId` is client-chosen; a retry
  with the same id replays the receipt instead of re-executing, and reusing an id on another
  thread is rejected ([Orchestrator L284-292, L11918-11940][receipts]).
- **`runtime-request.respond`** ([L3089-3097][respond-cmd]): the server checks the request
  exists, is `pending`, is not `not_resumable`, and that feedback rules hold. It then marks
  the request `resolved` and enqueues a delivery effect to the provider session
  ([L7775-7830, L8072-8088][respond-impl]). There are three `responseCapability` modes:
  - `live`: delivered to the running provider session.
  - `message`: async question; the answers are sent as a follow-up user message
    `async-answer:<requestId>` ([L7994-8066][message-mode]).
  - `not_resumable`: rejected with a reason.

  If delivery fails, the answer stays recorded and an `error` turn item
  "Answer delivery not confirmed" is shown ([L8091-8140][delivery-fail]).
- **Other commands:**
  - `thread.user-input.dismiss {requestId}` dismisses a question ([L3099-3103][respond-cmd]).
  - `run.interrupt {runId, reason?, holdQueue?}` interrupts a run, and `thread.stop` stops
    the thread ([L3040-3046][interrupt-cmd], [L2723][thread-stop]).
  - `message.dispatch` sends a new prompt, with `dispatchMode`
    `steer_active | restart_active | queue_after_active | start_immediately` ([L2960-2998][message-dispatch]).
- **Authorization.** The server authorizes every RPC. Operate actions need the
  orchestration-operate scope ([clientRpcPermissions.ts L15-55][perms]). This ticket did not
  check which scopes a paired mobile token gets.

### 6. Uncertainties

- **Provider coverage.** I only traced Claude and Codex adapter mappings in part (the
  request/terminal paths). Other drivers (ACP, OpenCode, Grok, …) emit the same normalized
  union, but I did not verify them.
- **Approvals while running.** I did not confirm whether the run `status` itself changes
  while an approval is pending. From the code read, it stays `running`, and the pending
  state lives on the request, the node, and the turn item. Upstream's awareness rule checks
  `pendingRuntimeRequest` before run status, so this does not matter if you copy that rule.
- **Field stability.** Upstream evolves fast. Many shell fields are `optional` with
  "Absent from older servers" comments, so a client must tolerate missing fields.
- **Code size.** `Orchestrator.ts` is >11k lines. The citations show the key paths, not
  every transition.

[adapter-event]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/provider-core/src/server/ProviderAdapter.ts#L79-L167
[adapter-terminal]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/provider-core/src/server/ProviderAdapter.ts#L141-L166
[events-table]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/persistence/Migrations/055_OrchestrationV2.ts#L19-L31
[domain-event]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1675-L1830
[stored-event]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L2083-L2087
[raw-event]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1660-L1673
[projection]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1832-L1858
[ws-route]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L3273-L3285
[ws-methods]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3285-L3305
[run-status]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L512-L523
[attempt]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L639-L661
[provider-turn]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1040-L1058
[persisted-waiting]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/RunExecutionService.ts#L703-L718
[capture-completed]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/CheckpointCaptureService.ts#L195-L208
[runtime-request]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1077-L1100
[request-kind]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/providerPolicy.ts#L38-L72
[turn-items]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1464-L1516
[pending-summary]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1874-L1881
[awareness]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/shared/src/agentAwareness.ts#L103-L141
[awareness-project]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/shared/src/agentAwareness.ts#L60-L101
[relay-confirm]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/relay/AgentAwarenessRelay.ts#L555-L566
[failure]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1310-L1332
[shell-fields]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1893-L1960
[sub-thread-input]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3500-L3509
[sub-shell-input]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3402-L3415
[thread-stream]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ThreadStream.ts#L15-L112
[sub-thread-impl]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L783-L985
[shell-gap]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/ws.ts#L574-L578
[compaction]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ProjectionMaintenance.ts#L289-L336
[respond-cmd]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3089-L3103
[respond-impl]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Orchestrator.ts#L7775-L7830
[message-mode]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Orchestrator.ts#L7994-L8066
[delivery-fail]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Orchestrator.ts#L8091-L8140
[receipts]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Orchestrator.ts#L11918-L11940
[interrupt-cmd]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3040-L3046
[thread-stop]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L2723
[message-dispatch]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L2960-L2998
[dispatch-result]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3391-L3393
[restart-expire]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L333-L347
[interrupt-cancel]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Orchestrator.ts#L9325-L9340
[codex-native]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5114-L5545
[codex-turn-completed]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L6123-L6135
[claude-terminal]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6815-L6850
[claude-request]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6490-L6560
[claude-ask]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L8911-L8930
[no-terminal]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/RunExecutionService.ts#L1442-L1468
[ingestor-terminal]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ProviderEventIngestor.ts#L699-L720
[coalescer]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts#L18-L46
[interrupt-items]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/RunExecutionService.ts#L645-L784
[question]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L1201-L1217
[unknown-event]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3576-L3608
[has-live-run]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Orchestrator.ts#L611-L616
[usage-limit]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ProjectionStore.ts#L6324-L6360
[cmd-output]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3314-L3322
[perms]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/clientRpcPermissions.ts#L15-L55
[shell-stream]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L2049-L2081
[thread-stream-item]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3610-L3633
