---
name: code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along three axes — Standards (does the code follow this repo's documented coding standards?), Spec (does the code match what the originating issue/PRD asked for?) and Bugs (what does the diff break at runtime?). Runs the three reviews in parallel sub-agents, plus a reviewer from the other model provider (Codex from Claude Code, Claude from Codex), then a verifier tries to refute every new finding against the code before it is reported. Remembers its previous passes on the same PR (report posted as a PR comment). Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

Three-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?
- **Bugs** — what does the diff break at runtime that the tests may not cover?

The three axes run as **parallel sub-agents** so they don't pollute each other's context. Alongside them, a **reviewer from the other provider** covers all three axes: models of one family share blind spots. Then a **verifier** per axis tries to refute every new finding against the code: only what survives is reported as open. A killed finding is still posted, folded and ticked with its evidence — nothing is hidden, but nobody has to sort it by hand. Every finding is a **card** with a status and an importance (see _The report_).

**Memory**: with an open PR, each pass posts its report as a PR comment and the next pass reads the previous ones first. The `code-review:v2` PR comments are the only source of truth.

**Project rules** — the check command and what it enforces, the coding standards, the stack's traps — come from the project's instructions: `AGENTS.md` or `CLAUDE.md`, and the files they point to. The languages: `docs/agents/skills-settings.yml`, written by `/setup-skill`. Where issues live: `docs/agents/issue-tracker.md`, written by `/setup-matt-pocock-skills`.

## Process

### 1. Locate the PR and its previous passes

`gh pr view --json number,baseRefName,url,body` resolves the PR of the current branch.

| Situation | What happens |
|---|---|
| No open PR | Review with no memory. Report in chat only, with a warning and a ready `gh pr create --draft` command, written as `docs/agents/issue-tracker.md` says. Never create the PR yourself. |
| PR, no previous pass | Pass 1, empty ledger. |
| PR with previous passes | Build the ledger below. |

Previous passes are the PR comments starting with `<!-- code-review:v2 head=<sha> -->`:

```
gh api "repos/{owner}/{repo}/issues/<n>/comments" --paginate \
  --jq '.[] | select(.body | startswith("<!-- code-review:v2")) | .body'
```

Read them oldest to newest into a **ledger**, one entry per finding ID (`S<n>` Standards, `P<n>` Spec, `B<n>` Bugs, `X<n>` other provider — stable, never reused, next free = max + 1). Title, location, importance and status come from the newest comment listing the ID. Keep `last_head` = the `head=` of the newest comment. A status is read from its emoji, never from its label: labels follow the report language.

| Status on the card | Reviewer does |
|---|---|
| 🆕 To do, ❓ Your call | re-check against the full diff: still true → same status, location refreshed; gone → ✅ Fixed |
| 🔧 Fixed, to confirm | re-check against its `↳` line: the fix holds → ✅ Fixed; it does not → 🆕 To do, saying why. Holding is not enough when the fix is a special case stacked on an earlier pass's fix: see *Patch on patch* |
| ❎ Dismissed | silent — unless the incremental diff touches the cited location: re-check its `↳` reason, no longer holds → 🆕 To do. No `↳` line (ticked by hand): always silent |
| ✅ Fixed | silent; if the problem comes back it is a new finding |
| ⏭️ Deferred | silent; its issue tracks the problem, so it is never raised again |

**Patch on patch** — when the incremental diff rewrites lines an earlier pass's fix wrote (the commit on a `↳` line), the fixes are now answering each other. Look past the latest one: is there one simpler rule that settles every finding involved, so the special cases can go? If so, it is a new Standards finding at level 1 to 3 (🟡 3 · Minor or more severe), citing the IDs of the chain and the simpler rule in its 💡 line. The proof that a fix holds is not proof that it is the right shape.

When someone changed a box by hand, the box in the newest comment that shows the card wins: a ticked status (🔧, ✅, ❎, ⏭️) with an unticked box is 🆕 To do (reopened); 🆕 or ❓ with a ticked box is ❎ Dismissed.

### 2. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. Default with a PR: its base branch (`origin/<baseRefName>`). Otherwise ask.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside parallel sub-agents.

**Incremental diff** (only when a previous pass exists): `git diff <last_head>..HEAD`, where new findings are looked for. Empty → say so and stop, the ledger stands. If `last_head` is not an ancestor of `HEAD` (rebase), incremental = full diff, and the report says so. The full diff is always handed over too.

### 3. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the PR title/body and commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.) — fetch via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A PRD/spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, do not spawn the **Spec** sub-agent in step 5: the report says "no spec available".

### 4. Identify the standards sources

The project's instructions, and the files they point to (`.agents/rules/`, `CONTRIBUTING.md`, a `docs/` page on conventions).

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 5. Spawn the reviewers in parallel

Start the other-provider reviewer in the background first (below), then send a single message with one `Agent` tool call per axis — three, or two when step 3 found no spec. Wait for every reviewer you started to finish and read every output before step 5b. Use the `general-purpose` subagent for each axis. Reviewers are read-only: they never edit files, run specs, or post comments.

All prompts share the **memory block**, filtered to the agent's axis (`S*`, `P*`, `B*` or `X*`):

- Full diff command, incremental diff command (pass 1: same), commit list.
- The ledger for this axis, one line per entry: `ID · status · importance · file:line · title · ↳ <last line>`. The next free ID. Plus, read-only, the ⏭️ and ❎ entries of the other axes: a problem deferred or dismissed under one axis is never raised again under another.
- The status table above, the importance scale and the card format from _The report_, pasted in full.
- The rules: "New findings only for what the incremental diff creates — it may sit in a line the diff does not touch: a caller it breaks, a sentence it makes false. Then give every ledger entry its new status, as in the status table. Never re-describe a ledger entry under a new ID. Output, in the language `review_reports` sets in `docs/agents/skills-settings.yml` (English when it sets none): (1) one card per new finding, in the format given; (2) one line per ledger entry you re-checked: `ID · <new status> · <one sentence>`. Nothing found → say `none`. Under 700 words."

**Standards sub-agent prompt** — include, on top of the memory block:

- The list of standards-source files you found in step 4, **plus the smell baseline from step 4** pasted in full — the sub-agent has no other access to it.
- *Patch on patch* from step 1, pasted in full, with the commits of the `↳` lines of every card the earlier passes fixed.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); (b) any baseline smell you spot: name it and quote the hunk; and (c) **reinvention** — for every new building block in the diff (component, controller, helper, service, hook…), search the repo for what already does that job — the project's instructions may say where to look — and name the existing thing it should have used, or say explicitly that nothing fits; for every name the diff gives to a concept (a new or renamed class, module, method), search the code and the domain glossary for the word the repo already uses for it — a second word for one concept is reinvention too; for every new file, compare it with two files of the same kind: a different format, layout, folder or namespace is reinvention too. A documented repo standard overrides the baseline, and a baseline smell is never more severe than 3 · Minor: it is level 3 or 4 (Minor or Suggestion). Skip anything tooling enforces: the project's instructions say what the check command covers."

**Spec sub-agent prompt** — include, on top of the memory block:

- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong; (d) an ADR that the diff makes false: the ADR must change in the same PR. Quote the spec line, or the ADR line, for each finding."

**Bugs sub-agent prompt** — include, on top of the memory block:

- The spec (or "no spec") — a bug is a gap between what the code does and what it is for.
- The brief: "Find defects this diff introduces. For each, give the concrete scenario: the state or input, then the wrong result (a wrong number, a crash, data shown to the wrong account, a lost or half-done write). Read the callers and the data the code really receives, not only the hunk. Look in particular at: a record reachable from another account (an id from the request read without scoping it to the current user); `nil`, an empty collection or a missing key on a path real data takes; a multi-step write outside a transaction; two requests racing on the same record; one query per row in a loop or a component; a period boundary (first or last day of a month, time zone); a migration that locks a big table or backfills inline; a job that is not safe to retry; and the traps the project's instructions name. No style, no standards, no missing test as such — only behaviour that is wrong. A bug the diff creates counts, even in a line it does not touch; a bug that was already there at the fixed point is out."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

**Other-provider reviewer** — the provider that is *not* running this skill, so every review has both families whoever wrote the code:

| Skill runs in | Reviewer | Sign-in check | Command, from the repo root |
|---|---|---|---|
| Claude Code | OpenAI Codex | `codex login status` → ChatGPT | `codex exec --sandbox read-only --ephemeral -o <out> - < <prompt>` (never `--oss`) |
| Codex | Claude Code | `claude auth status` → claude.ai | `claude -p --permission-mode plan < <prompt> > <out>` |

Its prompt is the memory block with the **whole** ledger — every axis, so it never re-raises an `S`, `P` or `B` entry that is not ✅; it gives a new status to its own `X*` entries only — plus the three briefs above (standards sources and smell baseline, spec, bugs checklist), with the same cards, the axis emoji after 🔀 (`**X3** 🔀🐛`). Pass the prompt through a file, never shell interpolation. Never switch to API-key billing to make it run. Not signed in, or the run fails → the report says so under its section; never fill it in with the provider running the skill.

### 5b. Drop duplicates

Drop an `X` finding that says the same thing as a finding of another axis in this pass, or as a ledger entry that is not ✅. Only a problem that comes back after ✅ is a new finding. Add the line `👥 Also seen by <provider>` to the card you keep. Two families agreeing is no proof, but it tells the author where to look first.

### 6. Verify — try to kill every new finding

For each axis that reported a new card, or moved a card back to 🆕 from ❎ Dismissed — the other provider counts as one axis — spawn one verifier (`general-purpose`), all in a single message. Other ledger entries are not re-verified: they already survived the pass that raised them.

The verifier gets the axis's new cards, the full diff command, the fixed point, the spec, the PR body, and — for Standards — the standards sources and the smell baseline. It does **not** get the reviewer's reasoning: it judges the claim against the code, not the argument.

The brief: "You are trying to kill each finding below. For each, read the cited code as it is at `HEAD`, its callers, and the spec. Read only: never edit a file, run a spec, or post anything. Kill a finding only with evidence, in one of these three ways:

| Kill | Evidence to quote |
|---|---|
| `false` — the code does not do what the finding says | the line of code or of the spec that contradicts it — never the PR body |
| `settled` — someone other than the author already decided the question the finding raises: the ticket, an ADR, a ticket comment, or a line of the PR body that records the user's decision. A spec that prescribes X without a word on the rule X breaks has not weighed that rule | the sentence that decides, and who decided |
| `tooling` — the check command already enforces it (the project's instructions say what it covers) | the guard |

The PR body is the author's word. What it explains, announces or lists as a choice to validate is not a decision — only a decision it attributes to the user is. Whether a true finding is worth fixing is not yours to judge either: that is the author's call in `/resolve-findings`. A finding that is true but was already true at the fixed point is not killed: it is out of this PR — the same problem existed there, quote the code on the fixed point that gives the same wrong result. A problem the diff creates belongs to it, even in a line it does not touch, and so does a problem in code it moves or rewrites. A requirement of the ticket the PR closes is never out: doing it is this PR's job. A finding you cannot kill with evidence survives: doubt keeps it. Never add a finding and never reword one. Output one line per finding: `ID · keep`, `ID · out · <evidence in one sentence>`, or `ID · kill · <reason> · <evidence in one sentence>`."

The verifier is a counterweight, not a vote: two agents agreeing proves nothing, a quoted line does. It removes what is wrong, not what is minor — and not what is real but older than the PR, which is `/resolve-findings`' job to defer.

### 7. Aggregate

Build the comment from _The report_: the dashboard, then one section per axis in this fixed order — `## 🐛 Bugs`, `## 📋 Spec`, `## 📏 Standards`, `## 🔀 Other provider · <provider> <model>`. In each section:

- the open cards (🆕, ❓, 🔧), sorted by status then importance;
- a verifier `kill` → the card becomes ❎ Dismissed, ticked, with `↳ **Dismissed by the verifier (<reason>)**: <evidence>`;
- a verifier `out` → the card stays 🆕, with the line `⏳ **Outside this PR**: <evidence>`;
- a folded block `<details><summary>Done in this pass (n)</summary>` with the cards that reached ✅, ❎ or ⏭️ in this pass, reduced to their first four lines (title, status, importance, 📍) and the `↳` line — the next pass needs the location.

A section with nothing in it is one line: `_Nothing to report._`. Do **not** merge or rerank findings across axes — they are deliberately separate (see _Why separate axes_). Check IDs are unique.

### 8. Persist the pass

With a PR, write the report to a temp file and post it: `gh pr comment <n> --body-file <file>`. The file is:

```
<!-- code-review:v2 head=<git rev-parse HEAD> -->
## Code review · `<head, 7 chars>` since `<fixed-point>` · pass <n>
<report from step 7>
_Ticking a box dismisses the card. Unticking it, in the newest comment that shows the card, reopens it._
```

Show the report and the comment URL in chat. Without a PR, show the report and the warning from step 1.

## The report

**Language** — everything a person reads in the comment is written in the language `review_reports` sets in `docs/agents/skills-settings.yml` (English when it sets none). Translate the English labels of steps 7–8 and of this section once, then reuse the words of the previous passes' comments: a label never changes from one pass to the next. The marker, the IDs, the emojis and the boxes never change: the ledger is read from them.

**Dashboard** — first, one row per axis. Status columns count the whole ledger; the importance column counts what is still 🆕 or ❓:

```
| Axis | 🆕 To do | ❓ Your call | 🔧 To confirm | Done | Importance (to do) |
|---|---|---|---|---|---|
| 🐛 Bugs | **2** | – | 3 | 1 | 🔴 1 · 🟡 1 |

> 🎯 **Critical to do**: B1 — <title>   (or `none`)
```

**Card** — one per finding, a task-list item so the box stays clickable:

```
- [ ] **B1** 🐛 · **<the consequence, in product words>**
  🆕 **To do**
  🔴 **1 · Critical**
  📍 [`app/path.rb:42`](https://github.com/<owner>/<repo>/blob/<head>/app/path.rb#L42)
  <evidence, by axis>
  💡 **Idea**: <one sentence>
```

- **Title** — the consequence, not the mechanism: "A finding reopened by hand drops out of the ledger", not "Unticking in an old pass reopens nothing".
- **Idea** — the simplest change that removes the problem. A rule that drops a special case beats one more case on top of it.
- **Evidence** — 🐛 `🧪 **Scenario**` then numbered steps, from the state to the wrong result · 📋 `📜 **Ticket**: "<quote>"` and `🔍 **In the code**: …` · 📏 `📏 **Rule**: <file + rule, or baseline smell>` and `🔍 **Observed**: …`.
- **Optional lines** — `👥 Also seen by <provider>`, `⏳ **Outside this PR**: <evidence>`, and `↳ <what was done>`, added when the card changes status.

**Status** — line 2. The box says whether someone answered:

| In progress | Done |
|---|---|
| 🆕 **To do** · ☐ | ✅ **Fixed** — a later pass confirmed the fix · ☑ |
| ❓ **Your call** — a question waits for the user · ☐ | ❎ **Dismissed** — with its reason, by the user or the verifier · ☑ |
| 🔧 **Fixed, to confirm** — the next pass checks it · ☑ | ⏭️ **Deferred → <issue>** — written as `docs/agents/issue-tracker.md` says (`#12`, or `org/repo#12` when issues live elsewhere) · ☑ |

**Importance** — line 3, proposed by the reviewer, the user may change it. The same scale for every axis:

| Level | Criterion |
|---|---|
| 🔴 **1 · Critical** | On a normal path: wrong money, data shown to the wrong account, data lost, a page that crashes |
| 🟠 **2 · Important** | A user sees a wrong result, or a ticket requirement is missing or wrong |
| 🟡 **3 · Minor** | No user sees it today: an unlikely edge case, a written rule broken with no visible effect |
| ⚪ **4 · Suggestion** | Taste — worth doing if cheap |

## Why separate axes

A change can pass one axis and fail another:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**
- Code that follows the standards and does what the issue asked, but crashes on a month with no data → **Bugs fail.**

Reporting them separately stops one axis from masking another.

## Why a verifier

A reviewer asked to find problems finds some whether or not they are there. Before this step, about a third of the findings were dismissed by hand in `/resolve-findings`: decisions already taken, claims the code contradicts, smells raised on two occurrences. The verifier is given the opposite job — break the finding — and only evidence counts.

## Why two providers

On three past PRs, Codex raised about seventeen findings that survived the verifier and that no Claude reviewer had seen, among them a crash; Claude's Bugs reviewer found a race that Codex missed. Neither family alone finds what both find.
