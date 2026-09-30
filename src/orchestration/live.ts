import type { Context } from '@/contracts/context'
import type { Market } from '@/contracts/market'
import { SpecProvenanceSchema, type ResolvedLayout } from '@/contracts/layout-spec'

import { cacheKey, readCached, writeCached } from './cache'
import { recordCall } from './ledger'
import { specKeyFor } from './context-key'
import { JEV_MODEL } from './jev/client'
import { COMPOSER_VERSION, composeWithJev } from './jev/compose'
import type { OrchestrationProvider } from './provider'
import { FALLBACK_LAYOUT, validateLayout } from './validate'

/**
 * Live orchestration: the composition happens at request time, by Jev.
 *
 * This is the whole point of the `OrchestrationProvider` seam: the renderer, the
 * validator, the contracts and the modules are all unchanged, and the only
 * difference from the static baseline is where the layout spec comes from. It
 * came from the Claude CLI until the switch to Jev, and nothing downstream had
 * to change for that.
 *
 * Two deliberate choices:
 *
 * - The composition goes through the same `validateLayout` as everything else.
 *   Jev only chooses among options that are already valid, so the validator
 *   should rarely act, and when it does the note is the bug report.
 * - When a call fails, the static layout is served and provenance says
 *   `fallback`, so the page never claims `live` for something Jev did not decide.
 */

export interface LiveProviderOptions {
    /** Names the cache bucket, and shows up in the panel. */
    mode?: string
    /** Skip the cache and pay for a new composition. The re-run button. */
    fresh?: boolean
    /** What asked for this call, for the ledger. */
    trigger?: string
}

/**
 * The cache key for a composition, given what would be sent.
 *
 * Exported because two callers need the same key from different sides: the page
 * reads it, and `/api/compose` writes it. Deriving it twice from the same inputs
 * is what makes "press Run, then the page finds it" work without passing
 * anything between them.
 */
export async function compositionKey(
    context: Context,
    market: Market,
    mode: string,
): Promise<string> {
    return cacheKey({
        mode,
        message: JSON.stringify({ context, market }),
        promptText: `${COMPOSER_VERSION}|${JEV_MODEL}`,
    })
}

/**
 * A composition already paid for, or null.
 *
 * **This is the only path the page itself uses.** Rendering a page can no longer
 * spend money: a GET is replayable by design — hot reload, a refresh, a second
 * tab, a link prefetch, a curl — and every unintended call so far came from one
 * of those re-running `getServerSideProps`. Calling now requires a POST to
 * `/api/compose`, which nothing replays on its own.
 */
export async function readComposition(
    context: Context,
    market: Market,
    mode: string,
): Promise<ResolvedLayout | null> {
    const cached = await readCached(await compositionKey(context, market, mode))
    if (!cached) return null
    return replay(cached, market)
}

/**
 * Re-validate a stored composition on the way out, and mark it as a replay.
 *
 * Not trusted as stored: a rule added in code should repair the compositions
 * already paid for rather than waiting for the next call. Idempotent on a spec
 * that already passed, so a replay with no rule changes reports nothing new.
 */
function replay(cached: ResolvedLayout, market: Market): ResolvedLayout {
    const revalidated = validateLayout(cached.spec, market)

    return {
        ...cached,
        spec: revalidated.spec,
        // The original provenance is kept as-is — including what the call cost —
        // so the panel never implies this was free. The note is what tells you
        // it is a replay.
        notes: [
            {
                level: 'repaired',
                reason: `replayed from cache (composed ${cached.provenance.generated_at}); press Run for a fresh composition`,
            },
            ...cached.notes,
            ...revalidated.notes,
        ],
    }
}

export class LiveProvider implements OrchestrationProvider {
    readonly name = 'Live (composed at request time by Jev)'
    readonly isLive = true

    constructor(private readonly options: LiveProviderOptions = {}) {}

    async getLayout(context: Context, market: Market): Promise<ResolvedLayout> {
        const contextId = specKeyFor(context)
        const mode = this.options.mode ?? 'live'

        // Keyed on the context, the snapshot, the composer and copy versions and
        // the pinned model, so a change to any of them invalidates. A
        // composition attributed to questions or copy that no longer exist would
        // be worse than no cache.
        const key = await compositionKey(context, market, mode)

        if (!this.options.fresh) {
            const cached = await readCached(key)
            if (cached) return replay(cached, market)
        }

        const startedAt = Date.now()

        try {
            const composition = await composeWithJev(context, market)
            const { spec, notes } = validateLayout(composition.spec, market)
            const resolved: ResolvedLayout = {
                spec,
                notes,
                provenance: SpecProvenanceSchema.parse({
                    generated_at: new Date().toISOString(),
                    source: 'live',
                    model: composition.model,
                    prompt_version: COMPOSER_VERSION,
                    context_id: contextId,
                    raw_response: JSON.stringify(composition.trace, null, 2),
                    cost_usd: composition.costUsd,
                    duration_ms: composition.durationMs,
                    input_tokens: composition.inputTokens,
                }),
            }

            await writeCached(key, resolved)
            await recordCall({
                at: resolved.provenance.generated_at,
                mode,
                key,
                brief: context.brief ?? null,
                trigger: this.options.trigger ?? 'unknown',
                outcome: 'composed',
                durationMs: composition.durationMs,
                costUsd: composition.costUsd,
                inputTokens: composition.inputTokens,
            })
            return resolved
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'unknown error'
            await recordCall({
                at: new Date().toISOString(),
                mode,
                key,
                // A typed brief lives in the drawer's React state until a call
                // succeeds, so for a failed call this line is the only surviving
                // copy of what was asked for.
                brief: context.brief ?? null,
                trigger: this.options.trigger ?? 'unknown',
                outcome: 'failed',
                durationMs: Date.now() - startedAt,
                costUsd: null,
                inputTokens: null,
                error: reason,
            })
            return this.fallback(context, reason)
        }
    }

    /**
     * Live call failed — serve the static layout and say so.
     *
     * This used to serve a hand-authored composition for the nearest matching
     * context. That library is gone, and the static layout is the more honest
     * failure anyway: a page composed for somebody else, presented without
     * comment as though it were composed for this visitor, is a worse lie than a
     * page that plainly did not compose. The note and the provenance both say
     * `fallback`.
     */
    private fallback(context: Context, reason: string): ResolvedLayout {
        return {
            spec: FALLBACK_LAYOUT,
            provenance: SpecProvenanceSchema.parse({
                generated_at: new Date().toISOString(),
                source: 'fallback',
                model: null,
                prompt_version: null,
                context_id: specKeyFor(context),
                raw_response: null,
            }),
            notes: [{ level: 'fallback', reason: `live orchestration failed: ${reason}` }],
        }
    }
}
