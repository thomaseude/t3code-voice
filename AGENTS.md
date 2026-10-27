# t3code-voice

Hands-free voice companion for T3 Code: an iOS app ("T3 Voice") and a companion service
(`t3-voice`) that runs next to a T3 Code server. The spec is issue #15; tickets are its
children (#16–#28). The companion is in `companion/` (TypeScript on Node ≥ 22.18), the iOS
app in `ios/` (Swift/SwiftUI, iOS 18+). Runtime dependencies are only the ones spec #15 lists under "Languages" (`uqr`
draws the pairing QR code). Ask Thomas before adding another one.

Issues are GitHub issues via `gh` (`docs/agents/issue-tracker.md`). Search the spec and the
`research/*` branches before re-deciding something.

## Commands (run in `companion/`)

- Check before shipping: `npm run lint && npm run typecheck && npm test`. CI
  (`.github/workflows/companion.yml`) runs the same plus `npm run build`, on Node 22 and 24.
- One test file: `node --test test/unit/path/to/file.test.ts`.
- Integration tests (seam 3): `npm run test:integration`. They start a throwaway `t3 serve`
  (temp data dir, empty HOME, free port) and never touch the user's T3. Run them locally
  when the T3 adapter changes; CI has no T3 binary and skips them.
- Lint/format is Biome (`npm run format` fixes). Tests run the `.ts` sources directly with
  `node --test` (type stripping): only erasable TypeScript — no `enum`, no constructor
  parameter properties, no `namespace`.

## iOS app (run on a Mac, in `ios/`)

- `project.yml` is the source of the Xcode project: run `xcodegen` after a pull, never commit
  the `.xcodeproj`. Pick the signing team in Xcode (Thomas uses a free personal team).
- Tests: ⌘U in Xcode, or `xcodebuild test -scheme T3Voice -destination 'platform=iOS
  Simulator,name=<a simulator>'`. The agent runs on the Linux VM without Swift, so Thomas
  builds and pastes the errors back.
- Logic goes in plain Swift under `App/Core/`, tested with XCTest through fakes
  (`Tests/Fakes.swift`); views stay thin and are checked by hand on the iPhone.
- The real implementations of Core's protocols (Keychain, network, WebRTC, Face ID,
  Live Activity) go in `App/Device/`. They stay thin and are checked by hand on the iPhone.

## Architecture: hexagonal (enforced)

```
companion/src/
  main.ts       composition root: the only place that instantiates adapters
  ports/        interfaces + the companion's own types (T3Backend, T3Connector, ConfigStore…)
  core/         domain rules; depends on ports only
  adapters/     one folder per adapter (t3-websocket, config, cli…); depends on ports and core
```

- `test/unit/architecture.test.ts` fails on a forbidden import: ports → nothing,
  core → ports, an adapter → ports and core, never another adapter.
- Ports use companion-owned types. T3's wire shapes never leave `adapters/t3-websocket/`
  (`wire.ts` translates them). Never import upstream `@t3tools/*` types.
- A port with one adapter, and an adapter method that only translates and delegates, are
  the architecture here, not Speculative Generality or Middle Man. A new port needs a
  second implementation in sight (a test fake counts) or an external system behind it.
- Core and CLI are tested through fake ports (`test/unit/fakePorts.ts`); the T3 adapter
  through a fake transport (`test/unit/adapters/t3-websocket/fakes.ts`) and seam 3.
- Time in the core comes from an injectable clock; tests never sleep for real.

## House rules

- **Fail closed against T3.** T3's protocol is not a public API. The adapter checks the
  pinned versions (`adapters/t3-websocket/compatibility.ts`) on every new socket. Supporting
  a new T3 version = add it to the pin, run `T3_VERSION=<version> npm run test:integration`,
  keep it only if the tests pass. Never accept a version range.
- **Secrets**: never print, log or commit one (T3 token, OpenAI key, device tokens).
  They live in `~/.config/t3voice/` (dir 700, files 600; a looser one is refused). Logs carry no audio, transcripts,
  code or prompts. CLI errors go through `scrubSecrets` as a last line of defence.
- **Never touch the user's T3 server** (`127.0.0.1:3773`) from tests or experiments. Ask
  before creating a pairing token for it, and never paste a token in chat.
- Tolerate missing fields from T3 (many are optional, "absent from older servers").
- Code, comments, commits, issues and PR text in English. Talk to Thomas in French.
  Thomas reads Ruby better than TypeScript: prefer plain, explicit code over clever types.

## Workflow

- `/implement` from a ticket, `/tdd` at the spec's seams (#15, *Testing Decisions*), PR as
  a draft, then `/review-loop`.
- Prose an agent will act on (issue, spec, PR body, ADR) is written with
  `/technical-writing`.
- Skills come from the repos in `skills-lock.json`, installed under `.agents/skills/`
  (symlinked into `.claude/skills/`). Never edit one here: change it in its own repo, then
  `npx skills update -p -y <skills>`. Their settings: `docs/agents/skills-settings.yml`.
