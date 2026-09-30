# AGENTS.md

Rules for working in this repo. [`README.md`](README.md) is what the project is,
how to run it, and what a call costs — read it first; this file does not repeat
it.

## Spending money

A live composition calls Jev through OpenRouter and is billed to whoever owns
`OPENROUTER_API_KEY`. It is about $0.0002 a page, so the rule is about keeping
spend deliberate, not about cost. See
[What a call costs](README.md#what-a-call-costs-and-how-to-not-spend-it-twice).

- **`/harness` is how you check visuals.** It renders every implemented module
  from fixture props and calls nothing.
- **Bump `COMPOSER_VERSION` or `COPY_VERSION`** when you change a question or a
  line of copy. They are part of the cache key.

## Git

**Never commit, branch, push or open a PR unless the repo owner asks.** Finish
the work and leave it in the working tree. This is not a habit to fall into at
the end of a task — it is an action the owner takes.

## The seams

Duplicated from the README on purpose: you need these before you have read it.

- **`src/contracts/`** is the source of truth — four Zod schemas. A change here
  changes what the model is sent.
- **`src/orchestration/jev/`** is the composer. Jev only chooses; filters,
  distances and every visible word are code and copy bank. A new decision is a
  new question with enumerated options, never free text.
- **`src/shell/`** is chrome the model cannot compose away. It does not go
  through the layout spec.
- **`src/renderer/ComposedPage.tsx`** is deliberately dumb: it mounts what the
  validated spec says and makes no decisions.

Where a new rule belongs is answered in
[`docs/COMPOSABILITY.md`](docs/COMPOSABILITY.md): if the page would be *wrong*
when the rule is broken, enforce it in code; if it is a judgment about what
serves this visitor, put it in the system prompt. A rule the model can reason its
way around is not a rule.

## Tests

`vitest.config.ts` sets `environment: 'node'` and includes `src/**/*.test.ts`
only, so the decision logic is covered and **every `.tsx` file is untested by
design**. Component fidelity is checked by eye in `/harness`, not by assertion.
`src/orchestration/jev/client.ts` is untested: it is the one network call, and the composer tests mock it.

## Style

Single quotes, no semicolons, 4-space indent, ~100 columns. `npm run format`
enforces it, scoped to `ts/tsx/scss/css`. Markdown is hand-wrapped — leave it
out. Generated token files under `src/design/tokens/` are regenerated, never
hand-edited.

## Honesty

Never fabricate a number, a file path, a test result, or a verification you did
not run. Re-derive a figure before asserting it, and say plainly what you could
not check. "I cannot tell from this" is an acceptable answer; an invented one is
not.

**Fixture data is partly fabricated** — `src/fixtures/README.md` marks which
fields are real. Never state a fixture number as fact.
