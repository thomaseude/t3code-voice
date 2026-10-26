---
name: review-loop
description: Run /code-review and /resolve-findings in a loop on the current PR until nothing is left to treat, then /dead-code, /comment-cleanup and the last push. Pauses on every decision that belongs to the user and, from the 10th pass of the run on, asks before each /resolve-findings. Use when the user says "review-loop", "boucle de revue", "enchaîne review et resolve", or "jusqu'à ce qu'il n'y ait plus de findings".
---

A loop over `/code-review` and `/resolve-findings`, then the end of the chain
(*Finish*). Each step is the skill itself, run as written: this file only says the order,
when to go round again and when to stop.

## Before the first pass

- An open PR on the current branch (`gh pr view`). None → stop: `/code-review` keeps its
  memory in the PR comments.
- A clean tree, with the branch pushed: the loop only starts there, so every later
  change is its own. Uncommitted files → stop, name them, and ask the user to commit or
  put them aside. Commits not pushed yet → push them.

## Each pass

1. Run `/code-review`.
2. Build the ledger as `/code-review` step 1 does. An empty incremental diff posts
   nothing and is not a failure: the ledger comes from the comments already posted.

| The pass leaves | Then |
|---|---|
| no 🆕, no ❓, no 🔧 | **done** → *Finish* |
| only 🔧 `X` cards, and the other provider was absent: only it re-checks its own `X*` entries, so nobody could re-check them | **done** → *Finish*, listing them |
| 🆕 or ❓ cards | run `/resolve-findings`. In this loop it stops after updating the ledger; its hand-off to the cleanup skills belongs to *Finish* |

3. After `/resolve-findings`, judge on the cards and the tree, not on `HEAD`:
   - a card still ❓ (the user postponed it), or the tree not clean (the check red,
     nothing committed) → stop and say which;
   - the table above already says **done** (every card dismissed or deferred) → *Finish*,
     since a new pass would have nothing to check;
   - otherwise push, next pass.
4. A pass fails — an axis reviewer crashes, or the comment is not posted → stop and
   report. Never go round again on a broken pass. The other provider not signed in, or
   its run failing, does not break a pass: `/code-review` says so in the report, and the
   table above decides what comes next.
5. Count only the passes this run made, not the pass number in the PR comment. From
   the 10th pass on, if 🆕 or ❓ cards are left, ask before each `/resolve-findings`, with the number of
   cards and their importance: go on → this pass; or stop → *Finish*, listing the cards
   left.

## Finish

Run `/dead-code`, then `/comment-cleanup` **last**, then commit and push. The cleanup
skills come after the loop because fixing a finding writes new code, and new code leaves
dead code and stale comments behind; code that changes after them means running them
again. One table in chat:
`pass · new · fixed · dismissed · deferred`, and the passes run without the other
provider, if any. Do not mark the PR ready: that is the user's call.
