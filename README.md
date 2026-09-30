# Generative UI prototype

A Vivid Seats performer page whose layout is decided by a model at request time
rather than designed once for everyone. The same tour data produces a different
page for a Chicago fan with $80 than for someone who will fly — not different
copy in a fixed template, but different modules, in a different order, with
different props.

**Picking this up fresh?** This file is how to get it running.
[`docs/COMPOSABILITY.md`](docs/COMPOSABILITY.md) is the decision rule for what the
model is allowed to decide, and where a new constraint belongs.

---

## What you need

| | |
| --- | --- |
| **Node** | 24 (developed on v24.0.0) |
| **An OpenRouter key** | `OPENROUTER_API_KEY` in `.env.local` (gitignored). Any OpenRouter key can call Jev |
| **Network access** | Only the calls to OpenRouter. The page itself fetches nothing |

Composition runs on **Jev** (`typesafe/jev-1.13`), TypeSafe's decision model,
through OpenRouter's Decisions API. It replaced the Claude CLI bridge. Jev does
not write text: it answers typed questions ("which of these", "how useful",
"yes or no") with probabilities, so every heading and reason the visitor reads is
chosen from a copy bank in `src/orchestration/jev/copy.ts`, and every filter is
computed in code. [`docs/COMPOSABILITY.md`](docs/COMPOSABILITY.md) called these
"selective" knobs; with Jev, all of them are.

`src/orchestration/jev/client.ts` pins the model and sets a 5 second timeout.
`JEV_MODEL` and `JEV_ENDPOINT` override them.

## Running it

**Steps 1–5 cost nothing and make no model call.**

1. `npm install`
2. `npm run dev` — http://localhost:3000
3. Open **`/`** — the baseline page: no visitor context, no model involved
4. Press **`Shift+H`** — the developer drawer
5. Set **Mode** to **Eval** — a composed page, read from cache, with what Jev
   read and chose (written by code from its answers) under **Why this page**

Then, as you like:

```bash
npm test                # 220 tests, none of which call Jev
npm run typecheck
npm run build
npm run format
```

**If a dev server is already running, do not start another.** Your harness may
already be serving this worktree on another port. A second `next dev` fails with
"Unable to acquire lock at `.next/dev/lock`" — and that is the lock of the server
you want, not a stale one. Check first:

```bash
pgrep -fl "next dev"
```

## The three modes

`?mode=` selects what the page shows. **Only one of them costs money, and it
never spends it without a press.**

| mode | what the page gets | cost |
| --- | --- | --- |
| `base` (default) | No visitor context — the baseline every visitor gets today. Keeps the visitor's city, because the real page geolocates | free, never calls |
| `eval` | A scripted brief putting budget, distance, popularity and date in tension. See `src/fixtures/eval-scenarios.ts` | one call, then cached |
| `custom` | A brief you type into the drawer | one call per brief, on press, then cached |

Opening `?mode=eval` is **free and instant**. It reads the cache and stops. If
nothing has been composed for that brief yet you get the baseline page plus a
**Run composition** button in the drawer — pressing that is the only thing in the
system that can call Jev.

## Driving the demo

**Press `Shift+H`** to open the developer drawer. It is hidden by default so the
page leads on its own, and opens on the left, pushing the page right rather than
covering it.

It holds, top to bottom:

- **Mode** — `Base` / `Eval` / `Custom`, and the brief each one hands over
- **Compose (one call)** / **Re-run (new call)** — the only path to a live call.
  In Custom it is the button directly under the textarea, and one press does the
  whole thing. Disabled the instant you press it, with an elapsed second count
  below
- **Briefs you have run** (Custom only) — the last five typed briefs, from the
  ledger, each marked *cached* (a free replay) or *needs a call*. Bumping the
  composer or copy version flips every one of them from the first to the second
- **Estimated cost** — what the last call cost, failures included
- **Why this page** — what Jev read about the visitor and what it chose, with
  confidence, written by code from the answers
- **What it composed** — modules placed, rows that actually rendered, the top
  pick, and how many dates each filter removed
- **Provenance** — model, composer version, timestamp, cost, duration, tokens
- **Validator** — every drop or repair, or "passed unmodified"
- **What Jev was asked, and answered** — every stage's state, questions and answers

Drawer state is remembered for the session and starts closed, deliberately not in
the URL.

There is also `/harness` — dev only, unlinked. Every module at every size from
fixture props, for judging visual fidelity without a composition in the way. It
makes no calls, so it is the right place to check a component change.

## What a call costs, and how to not spend it twice

**About $0.0002 and about one second**, measured on the eval brief on
2026-09-29: three sequential Jev calls (read the visitor, arrange the page,
present it), roughly 5,700 input tokens in all at $0.042 per million. Output is
free. Each call gives up at 5 seconds.

It is cheap, but it is still billed to whoever owns the key, so the guards stay:

- **Only a POST to `/api/compose` can call Jev.** Rendering a page cannot.
- **One call at a time, across the whole server.** Two presses for the same
  composition share one in-flight promise; anything else that arrives mid-call
  gets a 409 and spends nothing.
- **Every attempt is logged** to `.cache/calls.log`, failures included, with
  cost, duration, what triggered it, and **the brief it was composed from**.

Compositions are cached on disk under `.cache/` (gitignored), keyed on the
context, the market snapshot, the composer and copy versions, and the pinned
model. So:

- Reloading a composed page is free, forever.
- Bumping `COMPOSER_VERSION` (questions) or `COPY_VERSION` (copy bank), editing
  the fixtures, or changing `JEV_MODEL` **invalidates every cached composition**.
- A replay keeps the original call's cost in the panel, so it never looks free.

## How a page gets composed

```
context + market ─→ OrchestrationProvider ─→ layout spec ─→ validator ─→ renderer ─→ modules
```

- **`src/contracts/`** — four Zod schemas: context, market, module catalog,
  layout spec. The single source of truth for everything else; changes should be
  additive and deliberate.
- **`src/orchestration/`** — the provider seam, `jev/` (the Jev client, the
  visitor reading, sections, copy bank and composer), `cache.ts`, `ledger.ts`,
  and `validate.ts`. The validator **repairs rather than
  discards**: unknown modules are dropped, bad props are stripped back to their
  defaults, and the whole-page fallback is reserved for structural failure. Every
  intervention is recorded and shown in the drawer.
- **`src/modules/`** — module components and the registry. The catalog specifies
  more modules than exist; `implemented: false` keeps the two in step. Two are
  orchestrated today: `production_list` (main column) and `market_signals` (rail).
- **`src/renderer/`** — spec → components, keyed on module id plus heading so
  re-orchestration moves nodes rather than remounting them.
- **`src/shell/`** — navbar, header, the grid, tabs, filter chips, rail, SEO
  block, footer, and `FullTourList`. Static chrome the orchestrator cannot place
  or remove.
- **`src/demo/`** — the drawer, the modes, and `summarize.ts`.
- **`src/design/`** — tokens copied verbatim from `vivid-web-athena`, the Figma
  type scale as data, and the MUI theme wiring them together.
- **`src/orchestration/jev/compose.ts`** — the three Jev calls. Stage one
  reads the brief into typed values (city, budget, travel, days, priority).
  Stage two picks the top group's sort and scores which bands belong below it.
  Stage three picks headings, card signals, the top pick and its reason, from
  options that are already true of the rows. The old Claude prompt's history is
  kept in [`docs/PROMPT-HISTORY.md`](docs/PROMPT-HISTORY.md).

Stack is **Next 16 Pages Router, MUI v6 + Emotion + SCSS modules, Zod, Vitest** —
matching `vivid-web-athena` on purpose, so ports are copy-and-rewire rather than
rewrite. Don't migrate it to Tailwind or App Router without a reason.

## What the model cannot compose away

Enforced in code regardless of what it decides, because a rule it can reason
around is not a rule:

- **The whole tour stays reachable.** `FullTourList` always offers every date.
- **No date appears twice on a page.** An exclusion set accumulated in section
  order; the first section to claim a date keeps it.
- **A section holds three rows at `hero`, seven otherwise**, and a module repeats
  at most three times.
- **At most one module in the rail**, which is 340px and hidden below 1248px.
- **The rail card always carries a demand reading and a price reading.**
- **A stat or badge with nothing behind it is dropped, not guessed at.**

[`docs/COMPOSABILITY.md`](docs/COMPOSABILITY.md) has the test for where a new rule
belongs: if the page would be *wrong* when the rule is broken, enforce it in code;
if it is a judgment about what serves this visitor, put it in the system prompt.

## Guardrails

- **Everything runs locally.** No network dependency on vividseats.com, any CDN,
  or any API — verified by recording every browser request. `media.vsstatic.com`,
  `a.vsstatic.com` and Cloudinary are unreachable here and 404, so commit assets
  to `/public` instead of hotlinking. `next.config.js` deliberately has no
  `images.remotePatterns`. The one exception is the CLI subprocess.
- Your local `vivid-web-athena` checkout is **read-only**. Source is
  read and copied out; nothing is written back.
- **No commits, branches or PRs without the repo owner saying so. Never push.**
- **This is a prototype, not a production delivery.** No auth, analytics,
  monitoring, i18n, CI or hardening. Fixture data is partly fabricated —
  `src/fixtures/README.md` marks which fields are real.

## Why it works this way

What each rule above cost to learn.

- **Five calls once went through from two presses.** A GET is replayable — hot
  reload, a refresh, a second tab, a link prefetch — so only a POST can spend.
- **Two tabs were two calls.** The lock used to be per cache key, which stopped
  being a limit the moment briefs were typed rather than scripted: a new brief is
  a new key. It is now server-wide.
- **The obvious press did nothing visible.** A second button above the textarea,
  also labelled "Compose", only navigated. One press now does the whole thing.
- **Silence looked identical to a dead page**, hence the elapsed counter.
- **Hiding the drawer then switching mode brought it straight back**, because the
  state was a query param that survived navigation. It is session state now.
