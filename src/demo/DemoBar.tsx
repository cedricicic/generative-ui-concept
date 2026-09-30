import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import classNames from 'classnames'

import type { ResolvedLayout } from '@/contracts/layout-spec'

import styles from './DemoBar.module.scss'
import type { CompositionSummary } from './summarize'
import { MODE_SLUGS, type BriefHistoryEntry, type DemoMode, type ModeSlug } from './modes'
import type { CallRecord } from '@/orchestration/ledger'

/**
 * Demo chrome: the context switcher and the provenance panel. Not part of the
 * product being argued for, and styled so that is obvious at a glance.
 *
 * **Hidden by default — press Shift+H to show or hide it.** It opens as a left
 * drawer that pushes the page to the right rather than stacking above it: the
 * previous top bar shoved the product down the viewport, so switching context
 * meant closing the panel just to see what changed.
 *
 * Visibility is local state only, and starts closed. It is deliberately not
 * reflected in the URL: a query param survives navigation, which meant hiding
 * the bar and then switching context brought it straight back.
 *
 * The provenance half exists because slice 1 composes ahead of time rather than
 * at request time. "An LLM composed this" would otherwise be an unverifiable
 * claim; here the model, prompt version, generation timestamp and raw response
 * are on screen, alongside every drop or repair the validator made.
 */

interface DemoBarProps {
    active: DemoMode
    resolved: ResolvedLayout
    /** What the spec actually produced, next to the reasoning that asked for it. */
    summary: CompositionSummary
    /** Nothing composed for this brief yet — offer Run rather than a re-run. */
    awaitingRun: boolean
    /** The most recent call attempt. Null before the first one on this machine. */
    lastCall: CallRecord | null
    /**
     * Briefs typed before, and whether each still has a composition on disk.
     * A typed brief exists nowhere but the URL of the tab it was typed in, so
     * without this the composition you paid for is unreachable once you
     * navigate away.
     */
    briefHistory: BriefHistoryEntry[]
    /** The page itself — rendered beside the drawer so opening it pushes right. */
    children: React.ReactNode
}

const MODE_LABEL: Record<ModeSlug, string> = {
    base: 'Base',
    eval: 'Eval',
    custom: 'Custom',
}

const NOTE_CLASS = {
    dropped: styles.noteDropped,
    repaired: styles.noteRepaired,
    fallback: styles.noteFallback,
    gap: styles.noteGap,
} as const

/**
 * Two decimal places, with a thousands separator.
 *
 * `toFixed(3)` rendered $2.177 as "$2.177", which got read as two thousand
 * dollars — a spend figure misread by 1000x is worse than no figure at all. The
 * third decimal was never worth anything: a call is 13 to 18 cents and the
 * number this line exists to answer is "how much have I spent today".
 *
 * A Jev composition is a few hundredths of a cent, which two decimals round to
 * "$0.00". That reads as free, and it is not, so sub-cent amounts are shown in
 * full.
 */
const formatUsd = (amount: number) =>
    amount > 0 && amount < 0.01
        ? `$${amount.toFixed(6)}`
        : amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const formatSeconds = (ms: number | null) => (ms === null ? 'unknown' : `${Math.round(ms / 1000)}s`)

/**
 * A relative stamp, because the absolute one answers the wrong question. "2
 * minutes ago" tells you whether this figure belongs to the press you just made.
 */
const formatWhen = (iso: string) => {
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
    if (seconds < 90) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} minutes ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const TOGGLE_KEY = 'h'
const DRAWER_KEY = 'genui:drawer'
const HISTORY_KEY = 'genui:briefPanel'

/**
 * Runs one composition, and reports on it while it runs.
 *
 * Posts to `/api/compose` — the only path that can call the model — and then
 * refreshes the page's props, which now find the composition in cache. Two
 * requests where there used to be one, and the second is free.
 *
 * Why not navigate and let the server compose, as this did: a navigation is a
 * GET, and Next replays GETs on hot reload and on a cold compile. That is how
 * calls happened that nobody pressed. It also blocked the render for up to
 * three minutes, so a slow call looked identical to a dead page.
 *
 * The elapsed count is the point of the state. A composition takes 30s to over
 * 180s; without a number on screen there is no difference between thinking and
 * broken — which is how three calls got fired on top of each other.
 */
interface ComposeError {
    message: string
    /**
     * Whether this failure cost anything. A 409 from the one-call lock spent
     * nothing and wrote no ledger line; a timeout spent the full input tokens
     * and left no composition. Telling the reader "this is in the ledger either
     * way" when it is not is the kind of small lie that makes the rest of the
     * cost reporting unbelievable.
     */
    spent: boolean
}

interface ComposeRequest {
    mode: ModeSlug
    brief: string | null
    fresh?: boolean
    /**
     * Where to land once the composition exists. Custom passes the URL for the
     * brief it just composed, which is how the URL became a *result* of a run
     * rather than something you had to navigate to first. Omitted means "re-read
     * where we already are".
     */
    href?: string
}

function useCompose(): {
    composing: boolean
    elapsed: number
    error: ComposeError | null
    run: (body: ComposeRequest) => void
} {
    const router = useRouter()
    const [startedAt, setStartedAt] = useState<number | null>(null)
    const [elapsed, setElapsed] = useState(0)
    const [error, setError] = useState<ComposeError | null>(null)

    useEffect(() => {
        if (startedAt === null) return
        const tick = window.setInterval(
            () => setElapsed(Math.round((Date.now() - startedAt) / 1000)),
            1000,
        )
        return () => window.clearInterval(tick)
    }, [startedAt])

    const run = ({ href, ...body }: ComposeRequest) => {
        if (startedAt !== null) return
        setError(null)
        setElapsed(0)
        setStartedAt(Date.now())

        void fetch('/api/compose', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then(async (response) => {
                const payload = (await response.json()) as { error?: string; reason?: string }
                if (!response.ok) {
                    // The page stays as it was rather than going blank.
                    setError({
                        message:
                            payload.reason ?? payload.error ?? `call failed (${response.status})`,
                        // 409 is the one-call lock refusing, before any call was
                        // made. Everything else got as far as the model.
                        spent: response.status !== 409,
                    })
                    return
                }
                // Re-read props. The composition is in cache now, so this is
                // free. `shallow` is deliberately not passed — it is the one
                // flag that would suppress the getServerSideProps re-run this
                // whole call depends on. `scroll: false` matters more than it
                // looks: a query change defaults to scrolling to the top, and
                // doing that after a 40–180s wait throws away the page you
                // waited for.
                await router.replace(href ?? router.asPath, undefined, { scroll: false })
            })
            .catch((cause: unknown) => {
                // The request itself never completed, so whether the model was
                // reached is unknown — assume it was and say so, because the
                // expensive mistake is reporting a call as free.
                setError({
                    message: cause instanceof Error ? cause.message : 'the request never completed',
                    spent: true,
                })
            })
            .finally(() => setStartedAt(null))
    }

    return { composing: startedAt !== null, elapsed, error, run }
}

export const DemoBar: React.FC<DemoBarProps> = ({
    active,
    resolved,
    summary,
    awaitingRun,
    lastCall,
    briefHistory,
    children,
}) => {
    const { provenance, notes, spec } = resolved
    // Remembered for the session rather than held in the URL. Switching mode is
    // a full navigation, so pure local state closed the drawer every time you
    // used it; a query param had the opposite problem — hiding it and then
    // switching mode brought it straight back. sessionStorage does neither.
    const [isOpen, setIsOpen] = useState(false)

    useEffect(() => {
        setIsOpen(window.sessionStorage.getItem(DRAWER_KEY) === 'open')
    }, [])

    const toggle = () =>
        setIsOpen((open) => {
            const next = !open
            window.sessionStorage.setItem(DRAWER_KEY, next ? 'open' : 'closed')
            return next
        })

    /**
     * The brief-history panel, remembered the same way and for a sharper reason.
     *
     * Every row in it is a link, so opening it and clicking one is a full
     * navigation — and plain local state would close the panel on the very
     * click it exists to serve, leaving you to reopen it for the next brief.
     * Closed by default: the list is what was pushing the composition output
     * down the drawer, and a panel that defaults open just moves the crowding
     * onto the product instead.
     */
    const [historyOpen, setHistoryOpen] = useState(false)

    useEffect(() => {
        setHistoryOpen(window.sessionStorage.getItem(HISTORY_KEY) === 'open')
    }, [])

    const toggleHistory = () =>
        setHistoryOpen((open) => {
            const next = !open
            window.sessionStorage.setItem(HISTORY_KEY, next ? 'open' : 'closed')
            return next
        })
    // The textarea's own value. Initialised here only to avoid a flash on first
    // paint; the effect below is what actually keeps it right.
    const [draft, setDraft] = useState(active.slug === 'custom' ? (active.brief ?? '') : '')
    const { composing, elapsed, error, run } = useCompose()

    /**
     * Keep the textarea on the brief the page is actually showing.
     *
     * This has to be an effect, not just an initialiser. `pages/_app.tsx`
     * renders `<Component>` with no `key`, so a query-only navigation re-renders
     * this component without remounting it and an initialiser runs once per
     * hard load. That is how switching Eval → Custom used to arrive with the
     * eval brief already in the box — and, worse, how clicking a remembered
     * brief could leave stale text in a textarea whose button then composed it,
     * paying for a brief that was not the one on screen.
     *
     * Keyed on what the page is *showing*, via a ref, so it fires once per
     * navigation and not once per render. Gating on `composing` instead looks
     * equivalent and is not: the flag going false at the end of a *failed* call
     * would re-run this and overwrite the typed text with the brief in the URL —
     * and until a call succeeds, the textarea is the only copy of it.
     */
    const syncedTo = useRef<string | null>(null)

    useEffect(() => {
        const showing = `${active.slug}:${active.brief ?? ''}`
        if (syncedTo.current === showing) return
        syncedTo.current = showing
        setDraft(active.slug === 'custom' ? (active.brief ?? '') : '')
    }, [active.slug, active.brief])

    const typed = draft.trim()
    // `fresh` means "re-run the thing on screen", and nothing else. It used to
    // be `!awaitingRun`, which describes the brief in the *URL* — so typing a
    // new brief over a composed one asked to skip the cache, and paid for a
    // brief that may well have been cached already. Every replay from the
    // history list hit that.
    const sameBrief = typed === (active.brief ?? '')
    const composedThis = sameBrief && !awaitingRun

    // Custom only, and only with something to list — the same conditions the
    // inline list had. Eval's brief is scripted and has nowhere to come back to.
    const showHistory = active.slug === 'custom' && briefHistory.length > 0

    /** One press: call, then let the URL catch up to what was composed. */
    const composeTyped = (event: React.FormEvent) => {
        event.preventDefault()
        if (!typed || composing) return
        run({
            mode: 'custom',
            brief: typed,
            fresh: composedThis,
            href: `/?mode=custom&brief=${encodeURIComponent(typed)}`,
        })
    }

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
            if (event.key.toLowerCase() !== TOGGLE_KEY) return

            // Don't steal the keystroke from a field. No module takes text input
            // yet, but `budget_entry` will, and a shortcut that eats a capital H
            // mid-typing is a nasty thing to debug later.
            const target = event.target as HTMLElement | null
            if (target?.isContentEditable) return
            if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

            event.preventDefault()
            toggle()
        }

        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])

    return (
        <div className={styles.layout}>
            {isOpen && (
                <aside className={styles.drawer} aria-label="Demo controls">
                    <div className={styles.drawerHeader}>
                        <span className={styles.label}>Mode</span>
                        <div className={styles.variants}>
                            {MODE_SLUGS.map((slug) => (
                                <Link
                                    key={slug}
                                    // Plainly `/?mode=custom`, never carrying
                                    // the draft. It used to, which meant the
                                    // Custom tab inherited whatever brief the
                                    // tab you left had — usually the eval one.
                                    href={`/?mode=${slug}`}
                                    className={classNames(styles.variant, {
                                        [styles.variantActive]: slug === active.slug,
                                        [styles.variantDisabled]: composing,
                                    })}
                                    // Switching mode is free — it reads cache.
                                    // Still barred mid-call, because navigating
                                    // away from a running composition loses the
                                    // only progress indicator for it.
                                    aria-disabled={composing}
                                    tabIndex={composing ? -1 : undefined}
                                    onClick={(event) => {
                                        if (composing) event.preventDefault()
                                    }}
                                >
                                    {MODE_LABEL[slug]}
                                </Link>
                            ))}
                        </div>

                        {/*
                          What the page was actually given. The whole argument
                          rests on the difference between composing for someone
                          and not, so the panel should never leave that implicit.
                        */}
                        <span className={styles.label}>Given to the page</span>
                        <span className={styles.note}>{active.given}</span>
                        {/*
                          Quoted only where there is nowhere else to read it.
                          In Custom the textarea below holds the same text, and
                          two copies of an editable value invite the question of
                          which one the button will use.
                        */}
                        {active.slug !== 'custom' && active.brief && (
                            <blockquote className={styles.brief}>{active.brief}</blockquote>
                        )}

                        {active.slug === 'custom' && (
                            <form className={styles.briefForm} onSubmit={composeTyped}>
                                <textarea
                                    className={styles.briefInput}
                                    value={draft}
                                    onChange={(event) => setDraft(event.target.value)}
                                    // The real height is `min-height` in the
                                    // stylesheet; this is the no-CSS floor.
                                    rows={4}
                                    placeholder="Describe who is landing. Plain sentences — the model reads this."
                                    aria-label="Visitor brief"
                                />
                                {/*
                                  One button, and it is the one that spends. It
                                  used to take two presses: a submit that only
                                  navigated, labelled "Compose", and a separate
                                  Run below it. Typing a brief and pressing the
                                  button under it did nothing visible, which
                                  invites pressing it again.
                                */}
                                <button
                                    type="submit"
                                    className={styles.runButton}
                                    // Disabled the instant the request starts,
                                    // not on completion: the second press is the
                                    // one that pays twice.
                                    disabled={!typed || composing}
                                >
                                    {composing
                                        ? 'Composing…'
                                        : composedThis
                                          ? 'Re-run (new call)'
                                          : 'Compose (one call)'}
                                </button>
                            </form>
                        )}

                        {/*
                          Eval's run path. Custom has its own button inside the
                          form above; this one stays because Eval has no
                          textarea to put a button under, and gating it on
                          `active.brief` alone would show two buttons in Custom.
                        */}
                        {active.slug !== 'custom' && active.brief && (
                            <button
                                type="button"
                                className={styles.runButton}
                                disabled={composing}
                                onClick={() =>
                                    run({
                                        mode: active.slug,
                                        brief: active.brief,
                                        // A composition already exists, so this
                                        // press is asking for a new one.
                                        fresh: !awaitingRun,
                                    })
                                }
                            >
                                {composing
                                    ? 'Composing…'
                                    : awaitingRun
                                      ? 'Run composition (one call)'
                                      : 'Re-run (new call)'}
                            </button>
                        )}

                        {/*
                          The calls you have already made live in a panel of
                          their own, beside this drawer. They were a list here,
                          which put every brief ever run between the compose box
                          and the composition — so the output moved further down
                          the scroll with each call, and reading a spec meant
                          scrolling past the history that produced it.
                        */}
                        {showHistory && (
                            <button
                                type="button"
                                className={styles.historyToggle}
                                onClick={toggleHistory}
                                aria-expanded={historyOpen}
                            >
                                Recent calls ({briefHistory.length})
                                <span aria-hidden>{historyOpen ? '×' : '›'}</span>
                            </button>
                        )}

                        {composing && (
                            <p className={styles.composing} role="status" aria-live="polite">
                                <span className={styles.spinner} aria-hidden="true" />
                                <span>
                                    Asking Jev — {elapsed}s
                                    <span className={styles.composingHint}>
                                        {elapsed < 5
                                            ? 'usually about a second'
                                            : 'each call gives up at 5s'}
                                    </span>
                                </span>
                            </p>
                        )}

                        {error && (
                            <p className={styles.composeError} role="alert">
                                {error.message}
                                <span className={styles.composingHint}>
                                    {error.spent
                                        ? 'The page still shows what it had. The call is in .cache/calls.log either way.'
                                        : 'The page still shows what it had. Nothing was spent and nothing was logged.'}
                                </span>
                            </p>
                        )}

                        {/*
                          What the last press cost, in the UI rather than in a
                          server log — a timed-out call is the most expensive
                          kind, since it buys nothing, and used to leave no
                          trace at all.

                          The last *call*, not the cost of the composition on
                          screen: the two differ whenever a system prompt edit
                          has invalidated the cache, and the provenance block
                          below already carries the composition's own figures.
                        */}
                        <span className={styles.label}>Estimated cost</span>
                        <span className={styles.note}>
                            {lastCall === null ? (
                                'No calls yet on this machine'
                            ) : lastCall.outcome === 'composed' ? (
                                <>
                                    {formatUsd(lastCall.costUsd ?? 0)} ·{' '}
                                    {formatSeconds(lastCall.durationMs)} · {lastCall.mode}
                                    <span className={styles.composingHint}>
                                        {formatWhen(lastCall.at)}
                                    </span>
                                </>
                            ) : (
                                <>
                                    Failed after {formatSeconds(lastCall.durationMs)}
                                    <span className={styles.composingHint}>
                                        Billed, and there is no composition for it.{' '}
                                        {formatWhen(lastCall.at)}
                                    </span>
                                </>
                            )}
                        </span>

                        <span className={styles.label}>shift+h to hide</span>
                    </div>

                    <div className={styles.panel}>
                        <p className={styles.panelHeading}>Why this page</p>
                        <p className={styles.reasoning}>{spec.reasoning}</p>

                        <p className={styles.panelHeading}>What it composed</p>
                        <ul className={styles.moduleList}>
                            {summary.modules.map((module, index) => (
                                <li key={`${module.module}:${index}`}>
                                    {module.module}{' '}
                                    <span className={styles.dim}>· {module.size}</span>
                                </li>
                            ))}
                        </ul>

                        {summary.signals.map((signals) => (
                            <div key={signals.heading} className={styles.renderedGroup}>
                                <p className={styles.groupLabel}>{`rail: ${signals.heading}`}</p>
                                <ul className={styles.rowList}>
                                    {signals.lines.map((line) => (
                                        <li key={line}>{line}</li>
                                    ))}
                                </ul>
                            </div>
                        ))}

                        {summary.unshownTopPick !== null && (
                            <ul className={styles.notes}>
                                <li className={styles.noteRepaired}>
                                    {`top pick ${summary.unshownTopPick} was named but no section shows it`}
                                </li>
                            </ul>
                        )}

                        {summary.emptySections.length > 0 && (
                            <ul className={styles.notes}>
                                {summary.emptySections.map((section) => (
                                    <li key={section.heading} className={styles.noteRepaired}>
                                        {`empty: ${section.heading} — ${section.reason}`}
                                    </li>
                                ))}
                            </ul>
                        )}

                        <p className={styles.tally}>
                            {summary.shown} of {summary.total} dates shown
                            {summary.filteredOut > 0 && (
                                <span className={styles.dim}>
                                    {` · ${summary.filteredOut} removed by the filter`}
                                </span>
                            )}
                        </p>

                        {summary.groups.map((group) => (
                            <div key={group.label} className={styles.renderedGroup}>
                                <p className={styles.groupLabel}>{group.label}</p>
                                <ul className={styles.rowList}>
                                    {group.rows.map((row) => (
                                        <li
                                            key={row.id}
                                            className={classNames({
                                                [styles.rowHighlighted]: row.isTopPick,
                                            })}
                                        >
                                            {row.date} · {row.city} · from ${row.floorPrice}
                                            {row.isTopPick && (
                                                <span className={styles.dim}> ← top pick</span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}

                        <p className={styles.panelHeading}>Provenance</p>
                        <dl className={styles.kv}>
                            <dt>source</dt>
                            <dd>
                                {provenance.source}
                                {provenance.source === 'live' &&
                                    ' — composed just now, at request time'}
                                {provenance.source === 'precomputed' &&
                                    ' — composed during development, not at request time'}
                            </dd>
                            <dt>model</dt>
                            <dd>{provenance.model ?? '—'}</dd>
                            <dt>composer</dt>
                            <dd>{provenance.prompt_version ?? '—'}</dd>
                            <dt>generated</dt>
                            <dd>{provenance.generated_at}</dd>
                            {provenance.duration_ms !== null && (
                                <>
                                    <dt>took</dt>
                                    <dd>
                                        {(provenance.duration_ms / 1000).toFixed(1)}s
                                        {provenance.cost_usd !== null &&
                                            ` · $${provenance.cost_usd.toFixed(6)}`}
                                        {provenance.input_tokens !== null &&
                                            ` · ${provenance.input_tokens.toLocaleString('en-US')} in`}
                                    </dd>
                                </>
                            )}
                        </dl>

                        <p className={styles.panelHeading}>Validator</p>
                        {notes.length === 0 ? (
                            <p className={styles.kv}>spec passed unmodified</p>
                        ) : (
                            <ul className={styles.notes}>
                                {notes.map((note, index) => (
                                    <li
                                        key={`${note.level}-${note.module ?? index}`}
                                        className={NOTE_CLASS[note.level]}
                                    >
                                        [{note.level}] {note.module ? `${note.module}: ` : ''}
                                        {note.reason}
                                    </li>
                                ))}
                            </ul>
                        )}

                        <p className={styles.panelHeading}>What Jev was asked, and answered</p>
                        <pre className={styles.raw}>
                            {provenance.raw_response ?? '(static fallback, no Jev output)'}
                        </pre>
                    </div>
                </aside>
            )}

            {/*
              Briefs already typed on this machine, from the call ledger. A
              typed brief lives in the URL and nowhere else, so without this the
              composition you paid for becomes unreachable the moment you switch
              tabs — it is still on disk, under a hash.

              Each says whether it replays for nothing or costs a call. Same
              brief, both answers possible: editing the system prompt or the
              catalog invalidates every key.

              A column beside the drawer rather than a layer over the product.
              The drawer pushes the page right instead of covering it, and a
              panel opened to fix "I cannot read the output" has no business
              covering the output.
            */}
            {isOpen && showHistory && historyOpen && (
                <aside className={styles.historyPanel} aria-label="Recent calls">
                    <div className={styles.historyPanelHeader}>
                        <span className={styles.label}>Recent calls</span>
                        <button
                            type="button"
                            className={styles.historyClose}
                            onClick={toggleHistory}
                            aria-label="Close the recent calls list"
                        >
                            ×
                        </button>
                    </div>

                    <ul className={styles.briefHistory}>
                        {briefHistory.map((entry) => (
                            <li key={entry.brief}>
                                <Link
                                    href={`/?mode=custom&brief=${encodeURIComponent(entry.brief)}`}
                                    className={classNames(styles.briefHistoryLink, {
                                        [styles.variantDisabled]: composing,
                                    })}
                                    aria-disabled={composing}
                                    tabIndex={composing ? -1 : undefined}
                                    onClick={(event) => {
                                        if (composing) event.preventDefault()
                                    }}
                                    title={entry.brief}
                                >
                                    {entry.brief.length > 90
                                        ? `${entry.brief.slice(0, 90)}…`
                                        : entry.brief}
                                    <span className={styles.composingHint}>
                                        {entry.cached
                                            ? 'cached — replays for nothing'
                                            : 'no composition on disk — needs a call'}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </aside>
            )}

            <div className={styles.content}>{children}</div>
        </div>
    )
}

export default DemoBar
