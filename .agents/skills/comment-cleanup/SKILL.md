---
name: comment-cleanup
description: Remove comments that repeat the code, explain a past change, or replay a decision recorded elsewhere; shorten useful comments that ramble; rewrite useful but unclear comments in plain English for junior developers. Touches comments only. Use when the user asks to clean up, clarify, or trim comments, says "too many comments", "nettoie les commentaires", "trop de commentaires", "réduis les commentaires", or wants a comment pass before the last push of a PR.
argument-hint: "<file | directory> — with no argument: every code file changed since the base branch"
---

You cut comments that carry nothing, shrink comments that take too long to say
something useful, and rewrite useful comments that are hard to understand. The default
reader is a junior developer with B1 English who knows common web-development terms but
has no hidden knowledge of the feature.

**No report, no list of candidates to approve: the diff is the report.** The reviewer
reads the diff anyway, and it shows every cut, so a comment cut by mistake is easy to put
back by hand.

One closing sentence — "N comments cut, P shortened, Q clarified, across M files". Count
each comment once: `clarified` means a language-only rewrite; count a comment that was
also shortened under `shortened`. After it, one line for each code change you saw but did
not make (below: an extraction, a step that needed its paragraph, any other line of
code) — and nothing else.

## What a comment is for

A comment says what the code **cannot** say, at a different level than the code:
either **more precise** (a unit, what `nil` means, a side effect, a boundary) or **more
abstract** (the why, the constraint, the model in the author's head). A comment at the
same level as the code is narration — it goes.

For each comment, ask:

1. **Need:** does it state a fact, reason, contract, or risk that the code cannot state?
   If not, cut it.
2. **Truth:** does it name the real code and current behaviour precisely? If not,
   correct it when a useful fact remains; otherwise cut it.
3. **Clarity:** can the default reader explain it without inventing missing context? If
   not, rewrite it in plain English without losing the fact.

## Scope

**With no argument**: the code files changed since the base branch (`origin/<base>`: the
PR's base, else the default branch), committed or not (`git diff --name-only
origin/<base>...HEAD` plus `git status --short`). Which comments of those files you read
depends on `comment_cleanup_scope` in `docs/agents/skills-settings.yml` (`/setup-skill` writes
it):

- **Diff** — the default when the file sets none. Only the comments on lines
  the branch adds or changes, and the existing comments that annotate code the branch
  changed: the change may have made them false. Every other comment stays exactly as it
  is, even a long one. Cleaning outside the change belongs in a separate PR.
- **File** — the boy scout rule. **Every** comment of those files, not only the ones on
  changed lines: a file that was touched is a file that gets cleaned.

**With an argument**: that file or that directory, in full, whatever the scope. The
**Never** list below still applies.

**Never**: generated files (a schema dump, framework-generated config, lockfiles, build
output), migrations, vendored code (`vendor/`, `node_modules/`), static files served as
they are (`public/`), and the
documentation itself (`docs/`, `AGENTS.md`, `CLAUDE.md`, the rule files they point to
such as `.agents/rules/`, `README`) — there, the prose is the product, not a comment.

## What goes

1. **It repeats the code**, line by line or as a paragraph. `@param review [Review]`
   above `def for(review:)`: the signature already says it. `# Same as above, for
   the second platform` above `create_second_platform_review`. A step-by-step of what
   the block below does, in prose: the code already says how. Cut; if the how genuinely
   needed the paragraph, note it after the closing sentence, do not touch the code.
2. **It paraphrases the name right below it.** `# The text actually submitted for
   classification.` above `let(:submitted_texts)`.
3. **It replays a decision that lives elsewhere.** A paragraph re-arguing what an issue,
   a PR or an ADR already settled: keep the reference (`#123`, `PR 456`, `ADR 0007`),
   cut the paragraph. The reference is what replaces the ten lines — never cut it with
   them. When the paragraph carries no reference but the decision is findable (`git log
   -S`, the PR that introduced the line), add the reference, then cut.
4. **It explains the change, not the code.** Ask: would this sentence still be true and
   still matter if the code had always been written this way? "This used to return X",
   "what was broken", "who asked for it" fail — they belong in the commit body or the
   PR. "Third-party consumers switch on the historical 1-4 values" passes — it is the
   live constraint, keep it in one sentence.
5. **It says the same thing three times.** Keep the shortest wording, cut the rest.
6. **It narrates the file's history.** "renamed from X", "added this for…": that is what
   `git log` is for.
7. **It is wrong or stale** — it describes code that no longer exists. Fix it if it
   still covers a true fact, cut it otherwise.
8. **It decorates.** `# === PRIVATE ===` above `private`, a banner over two methods.
   A section header in a long file (`// --- Avatar ---` in a stylesheet) is not
   decoration — see below.
9. **It is commented-out code.** If a comment explains why the code is disabled, keep the code and that comment.

## The test before cutting under rules 1 and 2

Word overlap is not paraphrase. Take the code the comment annotates — the statement
below it, or the whole method / class / `include` when it sits above one. Two questions,
in this order:

- Could someone who has never seen this file write the comment from that code alone?
  If yes, it repeats the code — cut.
- Cover the comment and read that code alone: does a reader who does not know the
  file understand what it is *for*, not only what it does? If no, the comment carries
  intent — keep. If yes, and the comment states no fact from *What always stays*, the code already
  says it — cut.

- `/* reset email attachments */` above `yield put(emailAttachmentsFetched.request([]))`
  **stays**: the code shows a request with an empty array, the comment says it is a
  reset. Same for `.success({})` used to clear a store — without the comment it reads
  as a completed fetch.
- `# reset the counter` above `counter = 0` **goes**: the line already says it.

A one-line comment in plain words that names the purpose of a call or block — reset,
fallback, guard, retry, workaround — is the cheapest form of intent there is. Keep it
even when it shares words with the identifier below.

## What always stays

- **The fact you cannot read in the code**: a quirk of an upstream API, a production
  figure ("33% of the corpus"), a return contract the signature does not state
  (`@return [String, nil] nil when the review carries no text`), the reason for an
  **absence** — why there is *no* `has_comment` filter.
- **The why of a counter-intuitive choice**: a legitimate `rescue`, an order of
  operations that matters, a gem workaround, a `# rubocop:disable` and its reason.
- **What costs money or breaks something**: "billed per unit", "deletes the resource
  upstream", "idempotent".
- **A doc tag that carries a contract** (YARD, JSDoc…): allowed values, a unit, what
  `nil` means, a coercion, a type the name does not give. Where
  the project's standards require such tags, they are a documented standard, not a
  preference. A `@param` that merely restates the name and its type is still noise — and
  so is `@return [void]` on a command.
- **Existing `TODO` / `FIXME`**: they belong to whoever put them there.
- **Magic comments**: `# frozen_string_literal: true`, encoding, tool directives.
- **Section headers in a long file**: `// --- Forms ---` in a 350-line stylesheet is
  the file's table of contents, not a repetition. Keep them, and keep their format.

The tie-breaker on **Need**, whenever you hesitate: **keep it**. One comment too many
costs a line; a comment cut by mistake costs the knowledge it carried, and nobody will
go dig it out of the history. Keeping the fact does not require keeping unclear wording.

## What gets shortened

A comment can be entirely true and still too long. Size is a signal in itself:

- **Inside a method body**: one line is the default. Two is fine. Beyond that, either
  the comment is doing the job of a method name (extract — say so, do not do it) or it
  is padding.
- **Above a method, class, `include`, constant**: one to three sentences for the
  contract or the constraint. A concrete example that prevents a wrong "fix" (a
  timestamp that lands on the wrong day, a value that looks like a bug and is not) is
  worth its line and stays. Deployment context and what the alternative would have been
  do not. Who consumes what does not stay either, unless a consumer constrains the code.
- **Beyond ~5 lines**, wherever it sits and even within three sentences, rewrite it in the shortest form that keeps every fact that is
  still true and still binding. List the facts first, one per line; each one gets one
  sentence; drop the connective tissue ("so that", "instead", "in order to"). Three
  facts should not take seventeen lines.
- **Multi-paragraph**: one idea per paragraph, the first sentence of each readable on
  its own. If two paragraphs argue the same point, merge them.

Shortening removes words without removing facts. Clarifying may replace unclear words,
even in a short and true comment. A comment that is already useful, precise, and clear
is not touched.

## Plain English

Preserve the technical fact, not the original wording.
B1 defines the reader; it is not a permitted-word list or a readability-score target.

- Keep exact names such as `Rails controller`, `React hook`, and `HTML id` when they
  identify visible code. Never replace them with a broader but inaccurate label.
- Use literal, concrete language. Replace metaphors, idioms, slang, and private team
  shorthand with the failure, constraint, or result they hide. Established project
  terms stay.
- Put the actor and action near the start. Prefer active voice, present tense, and a
  direct shape: `X uses Y so Z`, `Keep X before Y because Z`, or `X returns Y when Z`.
- Keep one idea per sentence. About 15 words is a useful target; more than 25 words is a
  signal to review the sentence, never an automatic reason to cut it.
- Break compressed noun chains with a verb or preposition. Prefer common, precise verbs;
  use one clear verb instead of a phrasal verb when the meaning is the same. Use one
  term for one concept. Replace vague pronouns when their referent is not immediate.

For example, `Shared by the list and its refresh endpoint to prevent target drift`
hides both the actors and the failure. Write the concrete fact instead:
`The list component and the refresh endpoint use the same HTML ids so the update
replaces the right rows.`

Finish with the paraphrase test: can the default reader identify the actor, the action,
and the reason or result, then point to the related code? If not, clarify again.

## How you cut

- **Name what you lose.** Before cutting, say in one word what the comment carried that
  the line does not. If that word is an intent (reset, skip, because, until), keep it.
  If you cannot name anything, cut.
- **Compress before deleting.** When the fact is true but wordy, bring it down to one or
  two lines rather than losing it. Three lines into one is a win; a fact lost is not.
- **Clarify without weakening.** Replace opaque language, not exact technical names or
  binding facts. A clearer but less accurate comment is a regression.
- **Language.** Code comments are in the language `code_comments` sets in
  `docs/agents/skills-settings.yml` — English when it sets none — even when the conversation is not. A comment in another
  language that carries a real fact gets **translated**, not deleted. When the comment
  language is not English, *Plain English* above applies to that language.
- **Comments only.** If you feel like changing a line of code, that is a different move —
  dead code is `/dead-code`'s job — say so, do not do it.
- **Do not reword for taste.** A useful comment stays word for word when it is already
  precise and clear. Length, a false statement, or language the default reader cannot
  understand earns a rewrite.

## Afterwards

Run the check command of the project's instructions with only the test files you touched — a
comment needs no other test. A linter directive (`# rubocop:disable`,
`// eslint-disable`) cut by mistake shows up there when the check runs that linter.

Do not commit unless asked.
