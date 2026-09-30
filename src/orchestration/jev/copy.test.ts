import { describe, expect, it } from 'vitest'

import { MarketSchema } from '@/contracts/market'
import marketJson from '@/fixtures/market.json'

import {
    HEADINGS,
    HEADING_MAX,
    REASON_MAX,
    REASON_MIN,
    headingOptions,
    reasonOptions,
} from './copy'
import type { VisitorReading } from './reading'
import type { SectionId } from './sections'

const market = MarketSchema.parse(marketJson)

const reading = (overrides: Partial<VisitorReading> = {}): VisitorReading => ({
    metro: 'Chicago',
    budget: 80,
    budgetExact: false,
    travel: 'drive',
    days: 'any',
    intent: 'unknown',
    watchesSellout: false,
    confidence: {},
    ...overrides,
})

const byId = (id: string) => market.productions.find((production) => production.id === id)!

describe('headings', () => {
    it.each(Object.keys(HEADINGS) as SectionId[])(
        '%s always offers at least one heading, all within the length limit',
        (section) => {
            for (const env of [
                { reading: reading(), sort: 'demand' },
                { reading: reading({ metro: null, budget: null, travel: 'fly' }), sort: 'date' },
                { reading: reading({ metro: 'Salt Lake City', days: 'weekend' }), sort: 'price' },
            ]) {
                const options = Object.values(headingOptions(section, env))
                expect(options.length).toBeGreaterThan(0)
                for (const text of options) expect(text.length).toBeLessThanOrEqual(HEADING_MAX)
            }
        },
    )

    it('only claims a ranking the sort delivers', () => {
        const byDemand = headingOptions('fit', { reading: reading(), sort: 'demand' })
        const byDate = headingOptions('fit', { reading: reading(), sort: 'date' })

        expect(byDemand).toHaveProperty('biggest_you_can_make')
        expect(byDate).not.toHaveProperty('biggest_you_can_make')
    })

    it('says "around" for an approximate budget and "under" for an exact one', () => {
        expect(headingOptions('fit', { reading: reading(), sort: 'date' }).budget_and_drive).toBe(
            'Around $80, within a drive of Chicago',
        )
        expect(
            headingOptions('fit', { reading: reading({ budgetExact: true }), sort: 'date' })
                .budget_and_drive,
        ).toBe('Under $80, within a drive of Chicago')
    })
})

describe('reasons', () => {
    const rows = market.productions.slice(0, 3)

    it('stay within the tooltip bounds and are plain prose', () => {
        for (const pick of rows) {
            for (const text of Object.values(reasonOptions({ pick, rows, reading: reading() }))) {
                expect(text.length).toBeGreaterThanOrEqual(REASON_MIN)
                expect(text.length).toBeLessThanOrEqual(REASON_MAX)
                expect(text).not.toMatch(/[*_`#<>|\n]/)
            }
        }
    })

    it('offer "fans want most" only for the highest demand row shown', () => {
        const top = [...rows].sort((a, b) => b.demand_score - a.demand_score)[0]
        for (const pick of rows) {
            const options = reasonOptions({ pick, rows, reading: reading() })
            expect('most_wanted' in options).toBe(pick.id === top.id)
        }
    })

    it('do not compare a date against nothing', () => {
        const pick = byId('prod-001')
        const options = reasonOptions({ pick, rows: [pick], reading: reading() })

        expect(options).not.toHaveProperty('most_wanted')
        expect(options).not.toHaveProperty('cheapest')
    })

    it('mention the budget only when the date is inside it', () => {
        const pick = byId('prod-001')
        const cheap = reasonOptions({ pick, rows, reading: reading({ budget: 200 }) })
        const tight = reasonOptions({
            pick,
            rows,
            reading: reading({ budget: 40, budgetExact: true }),
        })

        expect(Object.values(cheap).some((text) => text.includes('inside your budget'))).toBe(true)
        expect(Object.values(tight).some((text) => text.includes('inside your budget'))).toBe(false)
    })
})
