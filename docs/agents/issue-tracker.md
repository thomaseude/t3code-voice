# Issue tracker: GitHub

Issues, the spec (#15) and the tickets of this repo live as GitHub issues in
`thomaseude/t3code-voice`. Use the `gh` CLI for all operations; it infers the repo from
`git remote -v`.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>`. Write the body
  with `/technical-writing`, in English.
- **Read an issue**: `gh issue view <number> --json title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,labels`.
- **Comment**: `gh issue comment <number> --body "..."`. **Close**:
  `gh issue close <number> --comment "..."`.
- **Blocked by**: tickets carry a `## Blocked by` section listing their blockers. A ticket
  is ready when every blocker is closed.

## Opening the PR that finishes an issue

- **Draft first**: `gh pr create --draft --base main --head <branch> --title "..." --body-file <file>`.
- **Before `/code-review`**: the skill keeps its memory in PR comments, so the PR must exist
  first. It never creates the PR itself.
- **`Closes #<n>`** on the first line of the body, English keyword only. If the merge does
  not finish the issue, write `Refs #<n>` and say what is left.
- **`## TODO before merge`**: a checklist, right under the closing line, of what a human
  must do that the merge will not (a tunnel rule, a token, a device check). Nothing to
  do? No block.
- The body ends with the attribution line the agent's harness gives, if any.

## When a skill says "publish to the issue tracker"

Create a GitHub issue. Write its body with `/technical-writing`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
