---
name: dead-code
description: Delete the code a branch left behind — with no caller, or replaced by a later commit but still running. Never changes what a user sees. Use when the user says "code mort", "dead code", "code remplacé", or before /comment-cleanup at the end of a PR.
---

A branch that iterates leaves code behind: the method an earlier fix used, the
translation key of a removed label, the template a new component replaced, the logic a
later commit made useless. You delete it. This is about the branch, not a repo-wide
hunt: the scope is what changed since its base (`origin/<base>`: the PR's base branch,
else the default branch).

Run it before `/comment-cleanup`: deleting code makes the comments around it stale.

**Closing sentences** — and nothing else:

- "D definitions with no caller removed, across M files."
- "Replaced code removed in `<commit>`: <what>, replaced by <what>." — or "No replaced
  code found."
- The code you suspect but left, one line each, with what made you keep it.
- Outside `/review-loop` only: "Files to commit: <paths>."

## 1. Replaced but still running — first, on a clean tree

Code that still runs but no longer does anything — logic a later commit on the branch
replaced, code whose only job is to cancel other code — is not dead to `grep`. The
commit that changed approach should have deleted it. When it was missed:

0. **Start on a clean tree.** Any uncommitted file → stop and ask, naming the files.
   `/resolve-findings` commits its fixes, so after it the tree is clean. On a clean tree,
   the deletion commit holds only the deletion, and the check judges only it.
1. **Find it.** Read the branch commit by commit (`git log -p origin/<base>..HEAD`); at
   each change of approach, ask what the earlier approach left behind.
2. **Delete it**, with the tests that only tested it.
3. **Prove nothing visible moved.** Run the check command of the project's instructions with
   the tests of every file the deletion touched. A test fails, or the deletion changes what a user
   sees — a number, a screen, a message → put the code back by hand and ask the user,
   naming the code and what would change. Never `git checkout` or `git reset` to put it
   back: the tree may hold changes that are not committed.
4. **Commit it alone**, only once step 3 passes, so it can be read and reverted on its
   own: `refactor(<scope>): remove <what>, replaced by <what> (<issue>)`, the issue
   written as `docs/agents/issue-tracker.md` says, in the language `commit_messages`
   sets in `docs/agents/skills-settings.yml`.

## 2. No caller

Candidates:

- a definition the branch added or changed — function, method, constant, query scope,
  translation key, template, component, CSS class, test helper;
- a definition whose caller the branch deleted — read the `-` lines of
  `git diff $(git merge-base origin/<base> HEAD)`, which includes the changes not
  committed yet.

A candidate is dead when `grep -rn` over every directory that holds code, config, data
or tests — not only `app/` or `src/`: `lib/`, `db/`, `config/`, the test folders —
finds no caller other than its own test. Some callers hide from a plain search — check them
before cutting:

| Hidden caller | Search for |
|---|---|
| a name built at runtime (`t("orders.#{status}.label")`, reflection, a dynamic import) | the fixed part of the name |
| a name passed as a string or a symbol | that string |
| Rails: view helper, component method | the bare name in views and components |
| Rails: relative i18n key (`t(".title")`) | the last segment, in the view whose path matches the key |
| Rails: route, controller action, `before_action`, job, mailer | `config/routes.rb`, the symbol, the class name |
| Stimulus controller, CSS class | `data-controller="…"`, the class in views and components |
| JS: a re-export in a barrel file (`index.ts`), a lazy import | the export name, the file path |
| JS: a CSS module class | `styles.<name>` |

Cut a dead definition together with its test and what only it used: its translation key
in every locale, its styles, its route, its line in a barrel file. Not sure → keep it,
and name it in the closing sentences.

## Afterwards

Run the check command with the tests of every file you deleted code from. Leave the
no-caller deletions uncommitted. Inside `/review-loop`, the commit after `/comment-cleanup`
takes them (§ *Finish*). Outside it, list them
in the closing sentences for the user to commit.
