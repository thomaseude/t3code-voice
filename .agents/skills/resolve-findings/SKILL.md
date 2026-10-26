---
name: resolve-findings
description: Give every 🆕 or ❓ finding of the /code-review ledger a verdict — implement, dismiss with a written reason, or defer to a follow-up — then apply the implementations and tick the ledger. Asks one question at a time, with a recommended answer, whenever a finding hinges on a product or scope decision. Use after /code-review, or when the user says "fix the findings", "traite les findings", "implémente ou écarte", "resolve the review".
argument-hint: "[finding ids] — with no argument: every 🆕 or ❓ card of the ledger"
---

You are the author answering the reviewer. Every finding gets one of three verdicts and
none is left unanswered. The code is the tie-breaker between you and the reviewer: an
agent can be confidently wrong, and so can the PR body you wrote an hour ago.

**Input**: the ledger of the PR of the current branch, built from its
`<!-- code-review:v2 head=<sha> -->` comments as `/code-review` step 1 builds it
(`docs/agents/issue-tracker.md` has the `gh` conventions), and in it every card whose
status is 🆕 To do or ❓ Your call. The card format, the statuses, the importance scale
and the report language are in `/code-review` § *The report*. No PR? Work from the
report pasted in chat and say the ledger cannot be updated. A card with a ⏳ line
(outside this PR) has its scope question
(§ 2) already answered no: unless the first two questions dismiss it, treat it as the scope row of § 2 says.
**Output**: code for what is implemented, every card moved to its new status **with its
reason**, and one verdict table in chat.

## 1. Read before judging

```
gh pr view --json number,url
gh api "repos/{owner}/{repo}/issues/<n>/comments" --paginate \
  --jq '.[] | select(.body | startswith("<!-- code-review:v2")) | {id, body}'
```

Build the ledger from those comments. Then, before touching any finding, read:

- the ticket the PR closes (its acceptance criteria are the yardstick for *asked for*);
- the PR body — it may already answer a finding, rightly or wrongly;
- for **each** finding, the cited `file:line` **as it is now**, not the reviewer's
  summary of it.

## 2. Judge — one finding at a time, in ID order

Four questions, in this order. The first "no" settles the verdict, unless its row names an exception.

| Question | Where the answer is | A "no" means |
|---|---|---|
| Is the claim **true**? | the cited code, the spec output, `git log -S` | **dismiss** — quote the line that contradicts it |
| Does something **ask for it** — the ticket's criteria, an ADR, a written standard? | the issue, the ADRs (`docs/agents/domain.md`), the standards (the project's instructions) | it is taste → **dismiss**, unless it is cheap and clearly better: then go on to the scope question, and implement if it is in scope, saying it was a judgement call |
| Is it **in scope** of this branch? | the ticket's criteria, `git log origin/<base>..HEAD` | **defer** — real, not this PR's job: it gets its own issue. The `widening` setting in `docs/agents/skills-settings.yml` decides one case. With `ask` (the default), if the fix is clearly cheaper than the issue, ask (§ 3) whether to widen the branch. With `defer`, always open the issue, even for a small fix, and ask nothing. A fix that adds a mechanism the ticket names nowhere (a new lock, a new method or class, a new kind of test) is not this PR's job either, even for a bug: it always gets its own issue, with no question. Among the fixes that add a mechanism, only the fix of a bug in the code that this branch adds is implemented in this PR |
| Do all possible fixes behave the same **for a user or the business**? | what a user sees with each possible fix | **ask** (§ 3) before implementing |

A finding that re-argues a decision already recorded (an ADR, a ticket comment, a
planning map) is dismissed with the pointer — unless it brings a **new fact**, then it is a
question for § 3.

## 3. Ask — one question at a time

Only **decisions** reach the user; facts you look up yourself. Same convention as
`/grilling`: one question, the options, your recommended answer, then wait. Never a
batch of questions, never a choice presented as already made. While it waits, the card
is ❓ **Your call**, box unticked, so the ledger shows where the resolution stands.

What earns a question:

- two implementations would behave differently for a user or the business
  (should a public reply name the customer? is the stock consumed on order or on shipping?);
- the finding is right, its fix widens the branch beyond the ticket, and `widening` is
  `ask` (the default): the user validates the widening before it happens;
- a documented decision meets a fact the decision did not know;
- the fix adds code that only guards against a risk a person could check by hand
  (an alias kept for one release, a fallback for jobs still in the queue), and a
  later change must delete it. Ask first: the manual check may be enough. Code
  that a documented rule requires, like a backfill job, is not a question.

Everything else — truth, standard vs taste, scope except a widening — you settle alone and write down.

## 4. Apply

| Verdict | In the code | On the card: box, status line, last line |
|---|---|---|
| **implement** | the change, its test, the check command of the project's instructions | ☑ · 🔧 **Fixed, to confirm** · `↳ <what changed> (<commit>)` |
| **dismiss** | nothing | ☑ · ❎ **Dismissed** · `↳ <reason>` |
| **defer** | nothing; open the follow-up issue (`docs/agents/issue-tracker.md`) with the `needs-triage` label, under the name `docs/agents/triage-labels.md` gives it | ☑ · ⏭️ **Deferred → <issue>** · `↳ <why it is not this PR's job>` |

The card's 💡 line is a lead, not the fix. Before implementing, `git log -L` the cited
lines: if an earlier pass's fix wrote them, that fix may have been the wrong shape —
look for one rule that settles both findings and deletes the earlier special case,
rather than adding a second one beside it.

Every box ends ticked — except a ❓ still waiting (§ 3) — so the ledger tells the truth
without waiting for another pass. When the user changes an importance, rewrite line 3 of
the card.

Commit the implementations once the check passes, so each `↳` line can cite its commit
and `/dead-code` starts on a clean tree:

- The message is `<type>(<scope>): address review pass <n> (<issue>)`.
- `<n>` is the pass number of the newest `/code-review` comment on the PR.
- `<type>` is the PR's own type.
- `<issue>` is written as `docs/agents/issue-tracker.md` says (`#12`, or `org/repo#12`
  when issues live elsewhere).
- The language is the one `commit_messages` sets in `docs/agents/skills-settings.yml`.
  Translate the template words into that language.

Then update in place —
edit the newest comment that shows each card, do not post a new one:

```
gh api --method PATCH "repos/{owner}/{repo}/issues/comments/<id>" -F body=@<file>
```

A reason is one or two sentences a stranger can **verify**: the line that contradicts,
the criterion that requires, the ADR that decided. "Not needed" and "out of scope" alone
are not reasons. A later pass judges an ❎ card by its reason alone (`/code-review`
step 1): an unexplained one can never be told apart from a forgotten one.

Never argue with the reviewer *in the code*. A comment may carry the fact a finding
missed (what a constant catches, why a field is absent); it never carries the debate.

## 5. Finish

One table in chat: `ID · verdict · reason or what changed`. Inside `/review-loop`, hand
back to the loop. Outside it, if no ❓ card still waits for the user, run `/dead-code`,
then `/comment-cleanup`, without asking. Do not push: the user decides when.
