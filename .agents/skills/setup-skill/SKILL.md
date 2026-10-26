---
name: setup-skill
description: Check that this repo gives what the shared skills (/code-review, /resolve-findings, /review-loop, /dead-code, /comment-cleanup, /implement, /tdd) read from it — the check command, the standards and the stack's traps in its instructions (AGENTS.md / CLAUDE.md); the languages and the comment-cleanup scope in docs/agents/skills-settings.yml — and add what is missing. Run once per repo, after /setup-matt-pocock-skills.
disable-model-invocation: true
---

# Set up the shared skills

The shared skills keep the method and read the project's rules in two places, each
holding one kind of thing:

- **Rules** — prose the project already writes for its developers: `AGENTS.md` (Codex
  reads only that file, Claude Code reads it through `CLAUDE.md` with `@AGENTS.md`) and
  the files it points to. No copy elsewhere: a rule lives in one place.
- **Settings** — the closed-value choices only the skills read (a language, a scope):
  `docs/agents/skills-settings.yml`, one key per setting (`value`, `default`, `allowed` for a closed
  list, `description`), pointed to from `AGENTS.md`. The same split as
  `docs/agents/issue-tracker.md`: the file is the setting, the instructions only point to
  it. YAML, because an agent reads a key without interpreting a sentence (why a file,
  and why this one: ADR 0001 of `thomaseude/agent-skills`, not of the project,
  `docs/adr/0001-project-settings-in-a-yaml-file.md`).

`docs/agents/issue-tracker.md` belongs to `/setup-matt-pocock-skills`, and the review
skills need it. Missing → stop and ask the user to run it first.

## 1. Explore

Read `AGENTS.md`, `CLAUDE.md`, every file they point to, and `docs/agents/skills-settings.yml` if
it exists. For each subject below, note where the answer already is, or that it is missing:

| Subject | Lives in | The skills need |
|---|---|---|
| Check | the instructions | the command to run before a commit, with which tests; whether the full suite runs locally or only on CI; what the check enforces, so no reviewer reports it |
| Standards | the instructions | where the coding rules are written (`.agents/rules/`, `CONTRIBUTING.md`, `docs/`…) |
| Stack traps | the instructions | the bugs that hurt most here: who may see whose data, money, migrations on big tables, jobs |
| Languages | `docs/agents/skills-settings.yml` | of the review reports, of the commit messages, of the code comments |
| Comment-cleanup scope | `docs/agents/skills-settings.yml` | which comments `/comment-cleanup` reads with no argument: only those the change touches (`diff`, the default), or every comment of every touched file (`file`, the boy scout rule) |
| Widening | `docs/agents/skills-settings.yml` | what `/resolve-findings` does with a real finding outside the ticket. `ask` (the default): it opens an issue, but asks the user whether to widen the branch when the fix is clearly cheaper than an issue. `defer`: it always opens an issue, even for a small fix |

A setting the instructions already state in prose (« commits in French ») is not
missing: it is the recommended value for the settings file, and the prose stays where it
is — it is a rule for the developers too.

To propose answers, read the repo too: `script/`, `bin/`, `Makefile`, `package.json`
scripts, the CI config, the linters, the last 20 commit subjects, the comments in a few
recent files.

## 2. Ask — one missing subject at a time

Only for what is missing. Lead with the recommended answer, drawn from what the repo
shows, so the user can accept it in a word. A stack trap goes in only when the user
confirms it is true here.

## 3. Write

Show the user a draft of both, and let them edit before writing:

- **The rules** — the lines to add to `AGENTS.md`, next to the section that already
  covers that subject, else in `## Agent skills` (created if missing). Never move or
  rewrite what the file already says. A `CLAUDE.md` that holds rules of its own without
  importing `AGENTS.md` → propose adding `@AGENTS.md` to it, so both providers read the
  same rules.
- **The settings** — `docs/agents/skills-settings.yml`, from the seed template
  [skills-settings.yml](./skills-settings.yml): every key kept, each `value` set to the answer, `default`,
  `allowed` and `description` copied as they are. When the file exists, change only the
  values that were missing or wrong; never drop a key.

Then the pointer, once: in `AGENTS.md`, next to where it names the skills, else as a
`### Shared skills` sub-block of `## Agent skills`:

```markdown
Their settings (languages, `/comment-cleanup` scope) are in `docs/agents/skills-settings.yml`.
```

The pointer names the settings, never their values: a value restated in `AGENTS.md` is a
second source of truth, and two instructions that disagree make the agent pick one at
random. A prose rule the instructions already state for the developers (« commits in
French ») stays where it is — it is a rule, not the setting.

## 4. Done

Name what was added. From now on the user edits `AGENTS.md` and `docs/agents/skills-settings.yml`
directly.
