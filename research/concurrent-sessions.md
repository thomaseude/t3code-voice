# Concurrent agent sessions and workspaces

Ticket: #5 (part of map #2). Sources: `pingdotgg/t3code` at commit
[`5b35402`](https://github.com/pingdotgg/t3code/tree/5b35402623d7d1d88eaa472807272a6c2e78012a)
(shallow clone, 2026-10-25). All links below are pinned to that SHA. Upstream changes quickly,
so recheck before relying on exact line numbers.

## Answer

- **Threads run in parallel.** Each thread has its own queue of runs, with **one active run per
  thread**. Later messages are steered into the active turn or queued behind it. Different threads
  run independently, including several threads in the same project at the same time.
- **Each thread is bound to one workspace when it launches.** There are three options:
  - `root`: the project's main checkout. This is the default for MCP launches and for the
    `local` env mode.
  - `existing_worktree`: shares a checkout that another thread already uses.
  - `worktree`: T3 Code runs `git worktree add -b <branch>` from a `baseRef` into
    `~/.t3/worktrees/<repo>/<branch>`. The branch starts as a temporary `t3/<8 hex>` name and
    is renamed later from the first message using a model.
- **Nothing stops two agents from editing the same working tree at once.** T3 Code has no lock,
  refusal, or UI warning when a second thread starts in a checkout that another thread is already
  editing. The locks it does have are narrow:
  - per-checkout leases for T3's own git branch changes and checkpoint operations
  - a per-thread dispatch lock
  - a guard that refuses **checkpoint file restore** when another thread or session shares the
    directory
  - skipping settle scripts and worktree cleanup for shared or active worktrees
- **There is no concurrency limit per provider or per session.** I found no cap on concurrent
  agent sessions. The only limit is provider-side usage or rate limiting: the thread stops as
  "Limited" and can be resumed. Provider sessions are closed after 30 minutes idle. Codex and
  OpenCode can serve several threads from one provider session. (Low-medium confidence: I searched
  for limits but did not read every adapter.)
- **The upstream UI already recommends worktrees for separate tasks.** Its docs say to "choose
  New worktree when its code changes need a separate branch and working directory". Multi-model
  sends and background sends each create **their own worktree**.
- **Recommendation for the voice companion:** start any **second concurrent task in a project as
  a `worktree` thread** (`baseRef` = the project's current or default branch). Only use
  `root`/`existing_worktree` when the user explicitly says "in the same checkout" or "continue
  in that worktree". Before choosing, check whether another active thread is already using that
  path (`orchestration.getWorktreeThreadIds` / `t3_worktree_list` / thread list). Follow-ups to an
  existing task should go to **the same thread** (queue or steer), not a new one.

## Details

### 1. One active run per thread; threads are independent

- A thread's runs are serialized. Follow-up input is steered into the active run, used to restart
  it, or queued as a new run after it
  ([feature-lifecycles.md L61-L101](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/orchestration-v2/feature-lifecycles.md#L61-L101)).
  The MCP `t3_thread_send` modes are `auto`, `queue`, `steer`, and `restart`
  ([orchestrator-mcp-server.md L421-L433](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/orchestration-v2/orchestrator-mcp-server.md#L421-L433)).
- Dispatch and queued-run start are serialized **per thread id** by a keyed lock
  ([ThreadManagementService.ts L1116](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ThreadManagementService.ts#L1116),
  [Orchestrator.ts L2150-L2156](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Orchestrator.ts#L2150-L2156)).
  No equivalent lock exists per project or per checkout for agent turns.

### 2. How a thread gets its workspace

- The launch workspace strategy is a union of `root{branch?}`, `existing_worktree{worktreePath, branch?}`,
  and `worktree{baseRef, branch?, startFromOrigin?}`
  ([orchestrationV2.ts L576-L592](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L576-L592)).
- MCP `t3_thread_launch`: `root` is the default. The workspace is bound before the agent starts,
  and the workspace is **not** inherited. `create_threads` inherits the parent's branch and
  worktree, which means it shares the checkout
  ([orchestrator-mcp-server.md L350-L370](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/orchestration-v2/orchestrator-mcp-server.md#L350-L370)).
- UI default: `defaultThreadEnvMode` is `local | worktree`. When it is null, T3 Code falls back to
  `t3.json` and then to `local`
  ([environment.ts L49](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/environment.ts#L49),
  [settings.ts L1198-L1199](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/settings.ts#L1198-L1199)).
  Repos that are not git are forced to `local`
  ([projectSettings.ts L196-L201](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/shared/src/projectSettings.ts#L196-L201)).
  New projects with no threads yet use their checkout even when the default is worktree
  ([projectSettings.ts L168-L194](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/shared/src/projectSettings.ts#L168-L194)).
  Scratch (no-project) threads are always rewritten to `root`
  ([ThreadLaunchService.ts L805-L810](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L805-L810)).
- How a worktree is created:
  - If no branch is requested, T3 Code generates a temporary `t3/<8 hex>` branch. If a `t3`
    branch already exists, the name is flattened to `t3-<hex>`
    ([ThreadLaunchService.ts L365-L424](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L365-L424),
    [shared/git.ts L12, L101-L121](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/shared/src/git.ts#L101-L121)).
  - If `startFromOrigin` is set, it fetches the remote base first. It then runs
    `git worktree add -b <newBranch> -- <path> <startRef>`, where the path is
    `<worktreesDir>/<repoName>/<branch with / replaced by ->`
    ([GitVcsDriverCore.ts L3676-L3705](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/vcs/GitVcsDriverCore.ts#L3676-L3705)).
    The default directory is `~/.t3/worktrees`, and it can be changed in Settings → Storage
    ([project-settings.md L171-L176](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/project-settings.md#L171-L176)).
    Submodules are initialized and a project setup script may run
    ([ThreadLaunchService.ts L310-L325](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L310-L325)).
  - After creation, the temporary branch is renamed in the background using a model-generated
    name, which follows the branch naming settings. Other threads that share the worktree are
    updated to the new branch name
    ([ThreadLaunchService.ts L470-L545](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L470-L545),
    [project-settings.md L49-L59](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/project-settings.md#L49-L59)).
- For `root`/`existing_worktree`, the requested `branch` is only recorded on the thread. I saw no
  `git switch` in the launch path (*uncertain*: I did not trace every client path). The agent's
  `cwd` is the thread's `worktreePath`, or the project root when it has none
  ([RuntimePolicy.ts L52-L59](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/RuntimePolicy.ts#L52-L59),
  [threadWorkspaceRoot.ts](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/project/threadWorkspaceRoot.ts#L9-L19)).
- A running thread can move itself into a fresh worktree with the MCP `t3_worktree_handoff`
  tool. This detaches the provider, ends the turn, and resumes in the worktree on the next run
  ([worktreeMcp.ts L5-L29](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/worktreeMcp.ts#L5-L29),
  [worktree/tools.ts L28-L45](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/mcp/toolkits/worktree/tools.ts#L28-L45)).

### 3. Upstream UX guidance

- "Use a new thread for a separate task. Choose **New worktree** when its code changes need a
  separate branch and working directory." Users can also pick "New thread in this worktree" to
  share an existing worktree on purpose
  ([thread-sidebar.md L3-L11](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/thread-sidebar.md#L3-L11)).
- Background sends (`Cmd+Enter`) and multi-model sends each create their own worktree
  ([thread-sidebar.md L34-L44](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/thread-sidebar.md#L34-L44)).
  This is the closest upstream precedent for "start another task while one runs".

### 4. Protection against concurrent edits (what exists and what does not)

What exists:
- **Checkpoint file restore** is refused unless the thread is in a worktree that no other
  thread, checkpoint scope, or live provider session uses. The check covers the same directory,
  a parent, or a child. The message is "File restore requires an isolated worktree..."
  ([CheckpointRestoreSafety.ts L9-L95](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts#L9-L95),
  [composer.md L150-L157](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/composer.md#L150-L157)).
  Threads in the project root can only rewind the conversation, never the files.
- **Per-checkout leases** are in-process semaphores keyed by real path. They serialize **T3's own**
  branch-changing git operations (`switchRef`, stacked actions, local PR checkout) and checkpoint
  rollback/cleanup
  ([workspaceLease.ts](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/workspace/workspaceLease.ts#L1-L21),
  [GitWorkflowService.ts L178-L182, L370-L398, L452-L460](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/git/GitWorkflowService.ts#L178-L182)).
  Checkpoint capture is also locked per cwd
  ([CheckpointService.ts L256-L258](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/CheckpointService.ts#L256-L258)).
  These locks do **not** cover file edits that agents make through their own tools.
- **Settle scripts** are skipped in shared checkouts
  ([ThreadSettlementService.ts L566](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L566)).
  **Worktree cleanup** never removes worktrees that have active sessions or are shared
  ([project-settings.md L184-L208](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/project-settings.md#L184-L208),
  [storageCleanup.ts L940-L970](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/storageCleanup.ts#L940-L970)).
- **Git's own rule** (not T3 code): one branch cannot be checked out in two worktrees, and
  `worktree add -b` fails if the branch already exists. This only prevents branch collisions,
  not shared edits.

What does not exist (based on searching server and web sources for lock, lease, and
shared-checkout warnings; *medium confidence*):
- No refusal or warning when a second `root` thread starts while another thread is running in the
  same project root.
- No file-level locking between agents.

### 5. Concurrency limits

- I found no limit on concurrent sessions per provider or overall. The only
  `maxConcurrentSessions` setting is for device (simulator) sessions
  ([EasDeviceHost.ts L408-L409](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/device/EasDeviceHost.ts#L408-L409)).
  HTML render browsers are capped at 2, and the settlement sweep at 8 threads. These do not
  limit agent sessions.
- Provider sessions close after 30 minutes idle, with a maximum idle pin of 4 hours
  ([ProviderSessionManager.ts L56-L57](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L56-L57)).
  Codex and OpenCode adapters can host several provider threads in one session
  ([CodexAdapterV2.ts L235](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L235),
  [ProviderSessionManager.ts L2174-L2176](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L2174-L2176)).
- The practical limit is provider usage or rate limits. Threads stop as **Limited**, with
  resume, auto-resume, or snooze options
  ([thread-sidebar.md L209-L229](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/thread-sidebar.md#L209-L229)).
  Running many parallel threads on one subscription will hit this sooner.

### 6. Implications for the voice companion

1. **Default rule:** if the project already has an active (running or queued) thread and the user
   starts a *new* task, launch it as `workspaceStrategy: {type: "worktree", baseRef: <project
   default/current branch>}`. Let the server name the branch.
2. **Follow-ups go to the same thread.** Use queue or steer (`auto`) on the same thread rather
   than opening a new thread in the same checkout.
3. **Avoid** starting a second thread with `root`/`existing_worktree` on a busy path unless the
   user explicitly asks. Upstream will not stop it, so the companion has to enforce this. A
   speakable confirmation could be: "Another task is already running in that checkout. Start this
   one in a new worktree?"
4. **Detection:** query the active threads on the path (`orchestration.getWorktreeThreadIds`,
   [orchestrationV2.ts L3494-L3498](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/contracts/src/orchestrationV2.ts#L3494-L3498)),
   or list threads with their status and `worktreePath`.
5. **Edge cases:**
   - Non-git and scratch projects cannot use worktrees, so warn or serialize instead.
   - A new project with no threads uses its root.
   - Worktree creation is asynchronous (fetch → checkout → setup-script stages). The companion
     should report "setting up worktree" progress and failures (`workspace_preparation_failed`).
6. **Cost/limits:** consider a soft cap on parallel tasks per provider on the companion side,
   because upstream has none.
