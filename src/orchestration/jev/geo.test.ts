import { describe, expect, it } from 'vitest'

import { MarketSchema } from '@/contracts/market'
import marketJson from '@/fixtures/market.json'

import { CITY_COORDINATES, milesBetween, reachFrom } from './geo'

const market = MarketSchema.parse(marketJson)

describe('geo', () => {
    it('knows every city the tour plays', () => {
        for (const production of market.productions) {
            expect(CITY_COORDINATES[production.city], production.city).toBeDefined()
        }
    })

    it('puts Milwaukee a drive from Chicago and Memphis a flight', () => {
        expect(reachFrom('Chicago', 'Chicago')).toBe('home')
        expect(reachFrom('Chicago', 'Milwaukee')).toBe('drive')
        expect(reachFrom('Chicago', 'Indianapolis')).toBe('drive')
        expect(reachFrom('Chicago', 'Memphis')).toBe('flight')
        expect(reachFrom('Chicago', 'Tampa')).toBe('flight')
    })

    it('treats Newark as home for a New York visitor', () => {
        expect(reachFrom('New York', 'Newark')).toBe('home')
    })

    it('says unknown rather than guessing', () => {
        expect(reachFrom(null, 'Chicago')).toBe('unknown')
        expect(reachFrom('Chicago', 'Atlantis')).toBe('unknown')
        expect(milesBetween('Chicago', 'Atlantis')).toBeNull()
    })

    it('measures roughly right', () => {
        expect(milesBetween('Chicago', 'Milwaukee')).toBeGreaterThan(70)
        expect(milesBetween('Chicago', 'Milwaukee')).toBeLessThan(95)
    })
})
