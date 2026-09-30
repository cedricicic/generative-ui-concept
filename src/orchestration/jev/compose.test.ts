import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextSchema } from '@/contracts/context'
import { MarketSchema } from '@/contracts/market'
import baseContext from '@/fixtures/contexts/base.json'
import marketJson from '@/fixtures/market.json'
import leahBudget80 from '@/fixtures/contexts/leah-budget-80.json'
import { DEFAULT_EVAL_SCENARIO } from '@/fixtures/eval-scenarios'
import { resolveExclusions, selectProductions } from '@/modules/production-list/select'
import type { ProductionListProps } from '@/modules/production-list/select'
import { validateLayout } from '@/orchestration/validate'

import type { Answer, Question } from './client'
import { reachFrom } from './geo'

/**
 * Jev is never called here: `decide` answers from a script, defaulting to the
 * first option of every choice. What is under test is everything the page
 * guarantees whatever Jev answers, which is the point of having code own the
 * filters and the copy.
 */

const script = vi.hoisted(() => ({ answers: {} as Record<string, Answer> }))

vi.mock('./client', () => ({
    JEV_MODEL: 'typesafe/jev-1.13',
    decide: vi.fn(async (_state: unknown, questions: Record<string, Question>) => ({
        answers: Object.fromEntries(
            Object.entries(questions).map(([name, question]) => {
                if (script.answers[name]) return [name, script.answers[name]]
                if (question.type === 'choice') {
                    const [first] = Object.keys(question.criteria)
                    return [
                        name,
                        { type: 'choice', choice: first, confidence: 0.9, probabilities: {} },
                    ]
                }
                if (question.type === 'score') {
                    return [name, { type: 'score', score: 2, confidence: 0.9, probabilities: {} }]
                }
                return [name, { type: 'noul', noul: 0.9 }]
            }),
        ),
        model: 'typesafe/jev-1.13-20260917',
        costUsd: 0.00002,
        inputTokens: 500,
        durationMs: 300,
    })),
}))

import { decide } from './client'
import { composeWithJev } from './compose'

const market = MarketSchema.parse(marketJson)
const evalContext = ContextSchema.parse({ ...baseContext, brief: DEFAULT_EVAL_SCENARIO.brief })

const choice = (value: string, confidence = 0.95): Answer => ({
    type: 'choice',
    choice: value,
    confidence,
    probabilities: {},
})

/** How the eval brief should read: Chicago, about $80, drive not fly, weekends. */
const EVAL_READING: Record<string, Answer> = {
    metro: choice('chicago'),
    budget: choice('usd_80'),
    budget_exact: { type: 'noul', noul: 0.1 },
    travel: choice('drive'),
    days: choice('weekend'),
    intent: choice('experience_first'),
    watches_sellout: { type: 'noul', noul: 0.9 },
}

beforeEach(() => {
    vi.clearAllMocks()
    script.answers = { ...EVAL_READING }
})

function rendered(layout: { module: string; props: Record<string, unknown> }[]) {
    const exclusions = resolveExclusions(layout, market, evalContext)
    return layout.map((entry, index) =>
        entry.module === 'production_list'
            ? selectProductions(
                  market,
                  evalContext,
                  entry.props as unknown as ProductionListProps,
                  exclusions[index],
              ).groups.flatMap((group) => group.productions)
            : [],
    )
}

describe('composeWithJev', () => {
    it('reads the brief, arranges, then presents: three calls', async () => {
        await composeWithJev(evalContext, market)

        expect(decide).toHaveBeenCalledTimes(3)
    })

    it('skips reading when there is no brief, which is the app’s case', async () => {
        await composeWithJev(ContextSchema.parse(leahBudget80), market)

        expect(decide).toHaveBeenCalledTimes(2)
    })

    it('produces a spec the validator passes without dropping anything', async () => {
        const { spec } = await composeWithJev(evalContext, market)
        const { notes, usedFallback } = validateLayout(spec, market)

        expect(usedFallback).toBe(false)
        expect(notes.filter((note) => note.level === 'dropped')).toEqual([])
    })

    it('keeps the top group inside the stated limits, whatever Jev chose', async () => {
        const { spec } = await composeWithJev(evalContext, market)
        const [hero] = rendered(spec.layout)

        expect(hero).toHaveLength(3)
        for (const row of hero) {
            expect(row.floor_price).toBeLessThanOrEqual(88)
            expect(reachFrom('Chicago', row.city)).not.toBe('flight')
        }
    })

    it('places at least one band below the top group, and no band is thin', async () => {
        const { spec } = await composeWithJev(evalContext, market)
        const sections = rendered(spec.layout).filter(
            (rows, index) => spec.layout[index].module === 'production_list',
        )

        expect(sections.length).toBeGreaterThanOrEqual(2)
        for (const rows of sections.slice(1)) expect(rows.length).toBeGreaterThanOrEqual(3)
    })

    it('recommends only a date the top group actually shows, with a reason', async () => {
        const { spec } = await composeWithJev(evalContext, market)
        const { spec: validated } = validateLayout(spec, market)
        const [hero] = rendered(spec.layout)

        expect(validated.top_pick).not.toBeNull()
        expect(hero.map((row) => row.id)).toContain(validated.top_pick)
        expect(validated.top_pick_reason).not.toBeNull()
    })

    it('leaves the recommendation out when Jev chooses none', async () => {
        script.answers.top_pick = choice('none', 0.9)
        const declined = await composeWithJev(evalContext, market)
        expect(validateLayout(declined.spec, market).spec.top_pick).toBeNull()
    })

    it('leaves the recommendation out when Jev is not confident in a date', async () => {
        script.answers.top_pick = choice('date_prod_002', 0.3)
        const unsure = await composeWithJev(evalContext, market)
        expect(validateLayout(unsure.spec, market).spec.top_pick).toBeNull()
    })

    it('treats an unsure reading as not stated rather than guessing', async () => {
        script.answers.budget = choice('usd_40', 0.2)
        const { spec } = await composeWithJev(evalContext, market)
        const [hero] = rendered(spec.layout)

        expect(hero.some((row) => row.floor_price > 44)).toBe(true)
    })

    it('says where the visitor is, from the brief', async () => {
        script.answers.metro = choice('los_angeles')
        const { spec } = await composeWithJev(evalContext, market)

        expect(spec.visitor_metro).toBe('Los Angeles')
    })

    it('adds up cost and latency across the calls', async () => {
        const composition = await composeWithJev(evalContext, market)

        expect(composition.costUsd).toBeCloseTo(0.00006)
        expect(composition.durationMs).toBe(900)
        expect(composition.trace.map((stage) => stage.stage)).toEqual([
            'read',
            'arrange',
            'present',
        ])
    })
})
