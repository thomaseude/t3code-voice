# Contributing to T3 Voice

Thank you for your interest. This page tells you how to find a task, run the code and send
a pull request.

## Find a task

- Issues labelled
  [`good first issue`](https://github.com/thomaseude/t3code-voice/labels/good%20first%20issue)
  are small and self-contained.
- Issues labelled
  [`help wanted`](https://github.com/thomaseude/t3code-voice/labels/help%20wanted) are
  bigger, but nobody works on them yet.
- Comment on the issue before you start, so that two people do not do the same work.
- The product spec is issue [#15](https://github.com/thomaseude/t3code-voice/issues/15).
  Each feature issue lists its acceptance criteria.
- For an idea or a question, open a
  [Discussion](https://github.com/thomaseude/t3code-voice/discussions) first.

## What you need

| Part | Needs |
|---|---|
| Companion (`companion/`) | Node 22.18 or later. Linux or macOS. No T3 server, no Mac, no iPhone for the unit tests. |
| iPhone app (`ios/`) | A Mac with Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen). An iPhone on iOS 18+ for anything audio. |
| Integration tests | A T3 Code binary. The tests start their own throwaway `t3 serve`. |

## Companion

```sh
cd companion
npm install
npm run lint && npm run typecheck && npm test   # what CI runs, on Node 22 and 24
node --test test/unit/path/to/file.test.ts      # one test file
npm run format                                  # fix the formatting (Biome)
```

The tests run the `.ts` files directly with Node's type stripping. Use only erasable
TypeScript: no `enum`, no constructor parameter properties, no `namespace`.

### Architecture (enforced by a test)

```
companion/src/
  main.ts     the only place that creates adapters
  ports/      interfaces and the companion's own types
  core/       domain rules; imports ports only
  adapters/   one folder per external system (T3, Codex, OpenAI, HTTP, CLI…)
```

- `test/unit/architecture.test.ts` fails on a forbidden import. An adapter never imports
  another adapter.
- T3's wire format stays inside `adapters/t3-websocket/`. The rest of the code uses the
  companion's own types.
- Test the core and the CLI through the fakes in `test/unit/fakePorts.ts`. Time comes from
  an injectable clock: tests never sleep.
- Prefer plain, explicit code over clever types.

`companion/README.md` explains the commands, the files and the voice engines.
`AGENTS.md` holds the full house rules.

## iPhone app

```sh
cd ios
xcodegen            # after every pull; never commit the .xcodeproj
open T3Voice.xcodeproj
```

Pick your signing team in Xcode (a free personal team works). Run the tests with ⌘U.

- Logic goes in plain Swift under `App/Core/` and is tested with XCTest through the fakes
  in `Tests/Fakes.swift`.
- Code that talks to iOS (Keychain, network, WebRTC, Face ID, Live Activity) goes in
  `App/Device/` and stays thin.
- Views stay thin and are checked by hand on an iPhone.

## House rules

- **Never commit or log a secret**: T3 token, OpenAI key, device token. Logs carry no
  audio, transcripts, code or prompts.
- **Never point a test at your real T3 server.** The integration tests start their own.
- **No new runtime dependency** without asking in the issue first. The companion has one.
- **Fail closed against T3.** The companion accepts only the T3 and Codex versions it was
  tested with (`adapters/t3-websocket/compatibility.ts`). To support a new version, add it
  to the pin and run `T3_VERSION=<version> npm run test:integration`.
- Code, comments, commits, issues and pull requests are in English.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep one pull request per issue, and write `Closes #<issue>` in its description.
3. Add or update the tests. Run `npm run lint && npm run typecheck && npm test` in
   `companion/`.
4. Open the pull request as a draft if you want early feedback.

By contributing, you agree that your work is published under the [MIT License](LICENSE).
