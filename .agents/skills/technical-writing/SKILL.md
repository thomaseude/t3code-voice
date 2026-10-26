---
name: technical-writing
description: Write or rewrite technical prose so that a reader at B1 level in its language, or another agent, cannot misread it. Works in any language (English, French…). Short sentences, one term per concept, active voice, lists, exact technical names. Based on ASD-STE100 Simplified Technical English. Use for ADRs, PR and issue bodies, commit bodies, AGENTS.md rules, skills and docs. Use when the user says "simplify this", "make this readable", "too dense", "plain English", "B1", "STE", "réécris plus simplement", "c'est trop dense", or asks to rewrite a doc. Also audits a doc for sentences an agent could misread, when the user says "audit", "check this ADR" or "cherche les ambiguïtés". Not for code comments (/comment-cleanup) or marketing copy (/no-ai-slop).
argument-hint: "<file | pasted text>: no argument means the prose you are about to write"
---

The reader has B1 English, knows common web-development terms, and cannot ask you what
you meant. A human reads it once; an agent acts on it literally. Each sentence must
have one reading.

Apply these rules while you write. To rewrite an existing text, apply them sentence by
sentence.

## Rules

| Rule | Do | Not |
|---|---|---|
| One term per concept | Pick one word for each thing and each action, and reuse it | "rating" here, "score" there, "figure" further on |
| Exact technical names | Keep `ReviewBonusRule`, "webhook", "idempotent". Define an internal name once | Replace a precise term with a vaguer, simpler word |
| Active voice | Name the actor the text names: "Joombo converts the score". If it names none, keep the passive | "The score is converted" when the actor is known; an actor the text never names |
| One idea per sentence | Split at each "and", "which" or semicolon that starts a new idea | A sentence that holds a rule, its reason and an example |
| Sentence length | 20 words or fewer for an instruction, 25 for a description. A signal, not a cut | Chains of clauses |
| Lists | A list for 3 or more items, steps or conditions. A table for a mapping | Five items inside one sentence |
| No missing words | Keep the subject, the verb and the article | "Only what a platform shows does" |
| Noun chains | 3 words at most, or break them with a verb or preposition | "platform rating scale registry entry" |
| Literal words | Say the failure, constraint or result | Idioms, metaphors, slang, private shorthand |
| Plain verbs | "use", "help", "decided", "can" | "utilize", "leverage", "facilitate", "made a decision", "has the ability to" |
| Name the source | "issue 616 shows…", a link, a named doc | "Best practice says", "experts agree" with no source. With none, ask the author |
| End on the last point | The last fact, step or open question | A closing paragraph that repeats the text ("In summary…") |
| Condition first | "If Booking is connected, the screen shows…" | The condition at the end of a long sentence |
| What it means for the code | When a sentence describes a mechanism, say its consequence for the code and keep the reason: "The rule needs no special case for internal access, because the membership query finds it too" | "The rule excludes it without knowing it exists"; advice turned into an order ("worth saying" → "announce it") |
| Em dash | Split the sentence or name the link: "because", "so", a colon before an example | A dash that leaves the reader to guess the link |
| One hedge at most | "probably" once, where it is true | "may possibly suggest" |

**Tenses.** Simple present for what is true and for rules ("Rules read stars"). Simple
past for what happened. The conditional for what is **not** true: a rejected option, a
hypothesis, a counterfactual ("A 7/10 would never pay"). A rejected option in the
present tense reads as a fact, and an agent that finds that line alone acts on it.

## Keep the meaning

- Precision beats brevity. When a shorter sentence drops a number, a condition or a
  scope, keep the longer one.
- Add no fact, example or reason that the text does not hold. If something is unclear,
  ask.
- Keep every scope word: only, all, every, each, any, never, always, at most (seul,
  tout, chaque, jamais…). Add none, drop none. "Not X, but Y" does not become "only Y".
- Domain terms win over "one term per concept". Before you merge two words, read the
  project's glossary (`CONTEXT.md`, or the file its instructions name). Never pick a
  word that names another model or concept of the code ("team" for people when `Team`
  is a model).
- When you split a sentence, each pronoun and each "which" or "whose" must still point
  to the same thing, and "everything else" must keep its limit.
- Leave a sentence alone when it already follows the rules. Quotes, code, commands and
  error messages stay as they are.
- Keep the document's structure and headings. Change the line wrapping only where you
  change the sentence.

## Check before you deliver

For a rewrite, read the old and the new text side by side:

1. Every fact, number, condition and code name of the old text is in the new one.
2. Every scope word and every negation is still there, on the same thing.
3. Every hypothesis and rejected option is still a hypothesis, and advice is still advice.
4. No domain term was replaced; no actor was added.
5. No sentence holds two ideas; none runs past 25 words without a reason.
6. One term names each concept from start to end.

Fix what fails, then check again.

**For a file, a second reader checks the meaning.** Your own check misses meaning
changes. Give the old and the new text to a fresh agent (a subagent; without one, a
new session) with only this task: "List every place where the new text says something
the old one does not: a fact, scope word, negation, condition or term that changed.
Quote both versions. Ignore pure rewording." Fix each real change it finds.

## Audit: find what an agent could misread

Use it when asked to audit or check a doc.

1. List every sentence with two readings: a pronoun or "the others" with two possible
   targets, a scope that may or may not be exclusive ("c'est X qui", "only"), a term
   used in two senses or against the glossary, a number with an unclear unit, a line
   that contradicts another.
2. Look for the answer before asking: the code, the glossary, the linked issue or ADR.
   If they settle it, it is a fact: fix the sentence and say where the fact came from.
3. What they do not settle is the author's decision. Ask one question at a time:
   quote the sentence, give the two readings and your recommended one, then wait.
4. Rewrite only those sentences, with the rules above, then run the second-reader check
   on them. Close with: "N ambiguities: M settled by the code, K by you."

## Output

- **A file:** edit it in place. The diff is the report. Close with one sentence: "N
  sentences rewritten, M lists added."
- **Pasted text:** return the full rewritten text, then nothing else unless the user
  asks why.
- **Another language:** apply the same rules in that language.
