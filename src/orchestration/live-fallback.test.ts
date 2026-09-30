import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextSchema } from '@/contracts/context'
import { MarketSchema } from '@/contracts/market'
import marketJson from '@/fixtures/market.json'
import leahBudget80 from '@/fixtures/contexts/leah-budget-80.json'
import type { JevComposition } from './jev/compose'

/**
 * Jev is a network call that costs money, so the composer is mocked. What these
 * tests cover is what the provider does with what comes back, above all when a
 * call fails, since the demo depends on a failed call still producing a
 * sensible page that does not claim to be live.
 *
 * The mock's behaviour is driven by a `vi.hoisted` box rather than per-test
 * `mockRejectedValue` / `mockImplementation`. A rejection created inside a test
 * body gets reported by vitest as a test failure even when the code under test
 * caught it and every assertion passes; a throw from inside the factory
 * implementation does not. The box keeps per-test control without that.
 */
const jev = vi.hoisted(() => ({
    mode: 'ok' as 'ok' | 'throw',
    composition: null as unknown,
}))

// The cache is real code that writes to disk. Left unmocked, one test's
// composition gets served to the next and the mock is never consulted.
vi.mock('./cache', () => ({
    cacheKey: () => 'test-key',
    readCached: vi.fn(async () => null),
    writeCached: vi.fn(async () => undefined),
}))

// The ledger appends to `.cache/calls.log`, which is a record of real money
// spent on this machine. A test run must never write to it.
vi.mock('./ledger', () => ({
    recordCall: vi.fn(async () => undefined),
}))

vi.mock('./jev/compose', () => ({
    COMPOSER_VERSION: 'jev-composer-test',
    composeWithJev: vi.fn(async () => {
        if (jev.mode === 'throw') throw new Error('Jev returned 503: upstream unavailable')
        return jev.composition
    }),
}))

import { LiveProvider, readComposition } from './live'
import { readCached } from './cache'
import { composeWithJev } from './jev/compose'
import { recordCall } from './ledger'

const market = MarketSchema.parse(marketJson)
const context = ContextSchema.parse(leahBudget80)

function composition(spec: unknown): JevComposition {
    return {
        spec: spec as JevComposition['spec'],
        model: 'typesafe/jev-1.13-20260917',
        costUsd: 0.0001,
        durationMs: 900,
        inputTokens: 2400,
        trace: [],
    }
}

const GOOD = {
    layout: [{ module: 'production_list', size: 'hero', props: { sort: 'price' } }],
    reasoning: 'read the visitor as in Chicago',
    visitor_metro: 'Chicago',
}

beforeEach(() => {
    jev.mode = 'ok'
    jev.composition = composition(GOOD)
})

describe('LiveProvider', () => {
    it('marks a successful composition as live, with cost and latency', async () => {
        const resolved = await new LiveProvider().getLayout(context, market)

        expect(resolved.provenance.source).toBe('live')
        expect(resolved.provenance.model).toBe('typesafe/jev-1.13-20260917')
        expect(resolved.provenance.prompt_version).toBe('jev-composer-test')
        expect(resolved.provenance.cost_usd).toBe(0.0001)
        expect(resolved.provenance.duration_ms).toBe(900)
        expect(resolved.spec.layout[0].module).toBe('production_list')
        expect(resolved.spec.reasoning).toContain('in Chicago')
    })

    it('keeps the trace of every stage so the drawer can show what Jev was asked', async () => {
        const resolved = await new LiveProvider().getLayout(context, market)

        expect(resolved.provenance.raw_response).toBe('[]')
    })

    it('still validates live output — a hallucinated module is dropped', async () => {
        jev.composition = composition({
            layout: [
                { module: 'vibe_check', props: {} },
                { module: 'production_list', props: {} },
            ],
            reasoning: 'r',
        })

        const resolved = await new LiveProvider().getLayout(context, market)

        expect(resolved.spec.layout.map((entry) => entry.module)).toEqual(['production_list'])
        expect(resolved.notes.some((note) => note.level === 'dropped')).toBe(true)
    })

    it('falls back to the static layout when the call fails', async () => {
        jev.mode = 'throw'

        const resolved = await new LiveProvider().getLayout(context, market)

        expect(resolved.provenance.source).toBe('fallback')
        expect(resolved.provenance.model).toBeNull()
        expect(resolved.spec.layout.length).toBeGreaterThan(0)
        expect(resolved.notes[0].level).toBe('fallback')
        expect(resolved.notes[0].reason).toContain('live orchestration failed')
        expect(resolved.notes[0].reason).toContain('Jev returned 503')
    })

    it('falls back rather than rendering an empty page when nothing survives', async () => {
        jev.composition = composition({ layout: [{ module: 'nope', props: {} }], reasoning: 'r' })

        const resolved = await new LiveProvider().getLayout(context, market)

        expect(resolved.spec.layout.length).toBeGreaterThan(0)
    })
})

describe('LiveProvider — replaying a cached composition', () => {
    it('re-validates on the way out, so a rule added in code repairs what was already paid for', async () => {
        vi.mocked(readCached).mockResolvedValueOnce({
            spec: {
                layout: [
                    {
                        module: 'production_list',
                        size: 'hero',
                        props: { heading: 'Packed nights, under $80', group_by_geo: true },
                    },
                ],
                reasoning: 'stored earlier',
            },
            notes: [],
            provenance: {
                generated_at: '2026-09-10T19:11:11.672Z',
                source: 'live',
                model: 'claude-sonnet-5',
                prompt_version: 'v4',
                context_id: 'eval',
                cost_usd: 0.15,
                duration_ms: 159555,
                input_tokens: 16506,
            },
        } as never)

        const resolved = await new LiveProvider().getLayout(context, market)

        expect(resolved.spec.layout[0].props.group_by_geo).toBe(false)
        expect(resolved.notes[0].reason).toContain('replayed from cache')
        expect(resolved.notes.some((note) => note.reason.includes('group_by_geo'))).toBe(true)
        expect(resolved.provenance.cost_usd).toBe(0.15)
    })
})

/**
 * The page's own path into a composition.
 *
 * The one property that matters here is negative: `readComposition` must never
 * reach Jev. Rendering the page used to be able to call the model, and a
 * GET is replayable — hot reload, a refresh, a second tab, a prefetch — so calls
 * happened that nobody asked for, three of which died at the timeout and billed
 * for nothing. Calling now requires a POST to `/api/compose`.
 */
describe('readComposition — what the page is allowed to do', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns null on a cache miss without calling the model', async () => {
        vi.mocked(readCached).mockResolvedValueOnce(null)

        expect(await readComposition(context, market, 'eval')).toBeNull()
        expect(composeWithJev).not.toHaveBeenCalled()
    })

    it('replays a cached composition without calling the model', async () => {
        vi.mocked(readCached).mockResolvedValueOnce({
            spec: {
                layout: [{ module: 'production_list', size: 'hero', props: { sort: 'price' } }],
                reasoning: 'composed earlier',
                top_pick: null,
                visitor_metro: null,
                top_pick_reason: null,
            },
            notes: [],
            provenance: {
                generated_at: '2026-09-11T00:00:00.000Z',
                source: 'live',
                model: 'claude-sonnet-5',
                prompt_version: 'v8',
                context_id: 'eval/x',
                raw_response: null,
                cost_usd: 0.14,
                duration_ms: 76_000,
                input_tokens: 18_207,
            },
        })

        const resolved = await readComposition(context, market, 'eval')

        expect(composeWithJev).not.toHaveBeenCalled()
        expect(resolved?.provenance.source).toBe('live')
        expect(resolved?.provenance.cost_usd).toBe(0.14)
        expect(resolved?.notes[0]?.reason).toContain('replayed from cache')
    })

    it('records a successful call in the ledger with what it cost', async () => {
        vi.mocked(readCached).mockResolvedValueOnce(null)

        await new LiveProvider({ mode: 'eval', trigger: 'run button' }).getLayout(context, market)

        expect(recordCall).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: 'eval',
                trigger: 'run button',
                outcome: 'composed',
                costUsd: 0.0001,
            }),
        )
    })

    it('records a failed call too — a timeout buys nothing and must still show up', async () => {
        vi.mocked(readCached).mockResolvedValueOnce(null)
        jev.mode = 'throw'

        await new LiveProvider({ mode: 'eval', trigger: 'run button' }).getLayout(context, market)

        expect(recordCall).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'failed', costUsd: null }),
        )
    })
})
