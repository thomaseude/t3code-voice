---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

## Before you start

- Working tree dirty? Stop and ask — don't branch over WIP.
- Already on the task branch for this work? Stay on it.
- Otherwise branch off the up-to-date default branch, without checking it out (other
  worktrees may share it): `git fetch origin && git switch -c <type>/<issue>-slug
  origin/<default>`. Naming: the repo's rule if it has one, else `feat/`, `fix/`, `chore/`.

Implement the work described by the user in the spec or tickets.

Before the first line of code, check the names, signatures and places the spec sets
against the project's written rules. A conflict the spec does not mention is a question
for the user, not a decision already taken: a brief written by an agent is no proof
that anyone weighed the rule. Ask the user, with these options:

- (a) follow the spec and write the exception into the rule;
- (b) follow the rule.

Some rules allow an exception: the Bootstrap rule allows custom SCSS when Bootstrap
cannot do the job. Never use an exception on your own: ask first.

Before you create a file of a kind the repo already has (mailer, template, component,
job, service), open two existing ones and copy their shape: format, layout, folder,
namespace, and the files they do not have. A different shape is a question for the user.

Use /tdd where possible. Confirm its seams with the user once, at the start of the task.

Run typechecking regularly, single test files regularly, and the check command of the project's instructions (`AGENTS.md` / `CLAUDE.md`) before shipping. The project's instructions say whether the full suite runs here or on CI.

## Ship it

Check, commit, push, open the PR **as a draft**, then `/review-loop` — the review posts its
report as a PR comment, so the PR must exist first. The order after the PR lives in
`/review-loop`, the PR body rules in `docs/agents/issue-tracker.md`; neither is repeated
here.

### Settling a finding

`/resolve-findings` — every finding gets a verdict (implement, dismiss with a written
reason, defer), and a product or scope decision is put to the user one question at a
time.
