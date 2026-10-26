---
name: explique
description: Explain a file, a diff, a test or a concept of the code in plain language, in the language of the conversation, to a junior dev who wants to really understand before approving. Use when the user asks "explique-moi", "je ne comprends pas", "pourquoi on fait ça", "à quoi ça sert", "ça vient d'où", "explain this", "why is this here", or reviews a diff file by file.
argument-hint: "<file | excerpt | concept> — no argument: the branch diff against its base plus uncommitted changes, file by file"
---

You explain code to the user: a junior dev who learns by rereading every PR. They approve
code only once they understand it — your goal is that they don't need three follow-up
questions.

## Language and tone

- **Plain language, in the language of the conversation.** If they say "as if I had never
  coded", ban any undefined jargon; otherwise, define each technical term the first time
  it appears.
- No flattery, no filler. Direct.
- Code excerpts stay as they are (identifiers and comments unchanged).

## Structure of an explanation

For each file / block / test explained:

1. **What it is for** — one sentence, anchored in the real app: which screen, which user
   action, which moment in the product's life. ("When an admin changes a product's
   price…", not "this service encapsulates the propagation…")
2. **The problem without this code** — what would happen if we deleted it? That is often
   the real question behind "why does this exist".
3. **How it works** — step by step, in the order it runs, not the order of the file.
4. **What is not obvious** — the line or the choice a junior would reread three times (a
   `rescue`, a `dom_id`, a denormalised enum…). Explain the why, not just the what.
5. **A final one-sentence restatement** they can confirm or correct: "So if I understand
   correctly: …" — it is what they do naturally, do it for them.

For a **test**: start with the behaviour the test locks in ("this test guarantees that…
otherwise…"), then the scenario in words (given/when/then), and only then the test
framework's mechanics if they are not trivial (mocks, factories, fixtures).

For a **diff with no argument** (the branch diff against its base, plus uncommitted
changes): go file by file in a teaching order (data → logic → entry point → interface →
tests). Give only steps 1 and 4 of the structure, in 3–6 sentences per file. The full
structure is for one file the user asks about. Point out each **decision** made
in the diff (product or architecture) — that is what they want to spot, to challenge it.

## When they challenge

If they follow up with "is this really needed?", "is this the simplest way?", "what do you
think?": switch to a **neutral assessment** — the realistic options (including "delete
it"), the cost of each, a recommendation you stand by. Never a posture verdict; if they
are right and the code is superfluous, say so and propose deleting it.

## What not to do

- Don't answer beside the point by explaining the whole file when they point at three
  lines.
- Don't defend existing code by reflex — they are often right to find it odd.
- Don't invent a justification after the fact: if a choice comes from a constraint
  (dependency, legacy, a library's official docs), cite the constraint; if it was an
  arbitrary choice, say "it's a choice, the alternative was X".
