import type { Context } from '@/contracts/context'
import type { Market, Production } from '@/contracts/market'
import type { BadgeId } from '@/modules/production-list/badges'
import { FAST_VELOCITY } from '@/modules/production-list/badges'
import { selectProductions, type ProductionListProps } from '@/modules/production-list/select'
import { isWeekend } from '@/orchestration/derive'

import { reachFrom, type Reach } from './geo'
import type { VisitorReading } from './reading'

/**
 * The sections a page can be built from, with their filters written in code.
 *
 * With Claude, the model wrote every filter and the most common failure was a
 * filter looser than its heading: a budget section opening with a $156 date, a
 * "within a drive" section with Tampa in it. Here the filter comes from the
 * visitor reading, so a section cannot promise more than its rows deliver. Jev
 * chooses among sections that are already true.
 */

export type SectionId =
    'fit' | 'more_in_reach' | 'big_nights' | 'selling_out' | 'best_value' | 'worth_a_flight'

export type Sort = ProductionListProps['sort']

export interface SectionDefinition {
    id: SectionId
    /** What the section is, written for Jev. */
    purpose: string
    filter: NonNullable<ProductionListProps['filter']>
    sort: Sort
    badges: BadgeId[]
}

/**
 * "About $80" admits $88. The same ten percent the Claude prompt asked for, now
 * applied rather than requested.
 */
export const APPROXIMATE_BUDGET_SLACK = 1.1

export function priceCeiling(reading: VisitorReading): number | undefined {
    if (reading.budget === null) return undefined
    return reading.budgetExact
        ? reading.budget
        : Math.round(reading.budget * APPROXIMATE_BUDGET_SLACK)
}

function reachable(reach: Reach, reading: VisitorReading): boolean {
    if (reading.travel === 'fly') return true
    if (reach === 'unknown') return true
    if (reading.travel === 'local_only') return reach === 'home'
    return reach !== 'flight'
}

/** The tour's cities the visitor can get to, or undefined when every city is. */
export function reachableCities(market: Market, reading: VisitorReading): string[] | undefined {
    if (reading.travel === 'fly' || reading.metro === null) return undefined
    const cities = new Set(market.productions.map((production) => production.city))
    return [...cities].filter((city) => reachable(reachFrom(reading.metro, city), reading))
}

function flightCities(market: Market, reading: VisitorReading): string[] {
    if (reading.metro === null) return []
    const cities = new Set(market.productions.map((production) => production.city))
    return [...cities].filter((city) => reachFrom(reading.metro, city) === 'flight')
}

/** The visitor's own constraints, as a filter. */
export function fitFilter(market: Market, reading: VisitorReading, days = true) {
    const filter: SectionDefinition['filter'] = {}
    const ceiling = priceCeiling(reading)
    if (ceiling !== undefined) filter.max_price = ceiling
    const cities = reachableCities(market, reading)
    if (cities !== undefined) filter.city = cities
    if (days && reading.days !== 'any') filter.day_type = reading.days
    return filter
}

export function sectionDefinitions(market: Market, reading: VisitorReading): SectionDefinition[] {
    const fit = fitFilter(market, reading)
    const flights = flightCities(market, reading)

    const definitions: SectionDefinition[] = [
        {
            id: 'fit',
            purpose: 'The dates that satisfy everything the visitor said.',
            filter: fit,
            sort: 'demand',
            badges: ['selling_fast', 'tickets_left', 'deals_available'],
        },
        {
            id: 'more_in_reach',
            purpose: 'More dates the visitor can make, beyond the top three.',
            filter: fit,
            sort: 'date',
            badges: ['deals_available', 'tickets_left'],
        },
        {
            id: 'big_nights',
            purpose:
                'The most anticipated nights on the whole tour, wherever and whatever they cost. Orientation, not a recommendation.',
            filter: { min_demand_score: 0.85 },
            sort: 'demand',
            badges: ['fans_viewed', 'tickets_left'],
        },
        {
            id: 'selling_out',
            purpose: 'Dates whose tickets are close to gone, anywhere on the tour.',
            filter: { sellout_risk: 'high' },
            sort: 'date',
            badges: ['selling_fast', 'tickets_left'],
        },
        {
            id: 'best_value',
            purpose: 'Dates that give the most show for the money, anywhere on the tour.',
            filter: { min_value_score: 0.75 },
            sort: 'value',
            badges: ['deals_available'],
        },
    ]

    if (reading.travel !== 'fly' && flights.length > 0) {
        definitions.push({
            id: 'worth_a_flight',
            purpose:
                'Big nights in cities the visitor would have to fly to, for if they ever change their mind.',
            filter: { city: flights, min_demand_score: 0.8 },
            sort: 'demand',
            badges: ['fans_viewed'],
        })
    }

    return definitions
}

export function propsFor(
    definition: SectionDefinition,
    size: 'hero' | 'standard',
    sort: Sort = definition.sort,
): ProductionListProps {
    return {
        filter: definition.filter,
        sort,
        group_by_geo: false,
        max_items: size === 'hero' ? 3 : 7,
        badges: definition.badges,
    }
}

/** What a section would actually render, given the dates already claimed. */
export function rowsFor(
    market: Market,
    context: Context,
    props: ProductionListProps,
    claimed: ReadonlySet<string>,
): Production[] {
    return selectProductions(market, context, props, claimed).groups.flatMap(
        (group) => group.productions,
    )
}

/** A section with fewer rows than this reads as a page that ran out of things to say. */
export const MIN_BAND_ROWS = 3

/**
 * The top group's filter, widened until it holds three.
 *
 * The Claude prompt asked for this ("if a filter leaves the top group with fewer
 * than three, widen it"). It is a rule about the page's shape, so it lives here.
 * Days go first because a weekday is the softest thing a visitor states; budget
 * and distance only ever widen together with it.
 */
export function heroDefinition(
    market: Market,
    context: Context,
    reading: VisitorReading,
    sort: Sort,
): SectionDefinition {
    const base = sectionDefinitions(market, reading)[0]
    const attempts = [fitFilter(market, reading), fitFilter(market, reading, false)]

    for (const filter of attempts) {
        const rows = rowsFor(
            market,
            context,
            propsFor({ ...base, filter }, 'hero', sort),
            new Set(),
        )
        if (rows.length >= 3) return { ...base, filter }
    }
    return { ...base, filter: attempts[attempts.length - 1] }
}

/** The facts about one date that a reason or a description may state. */
export interface DateFacts {
    reach: Reach
    weekend: boolean
    inBudget: boolean
    sellingFast: boolean
    weekday: string
}

export function factsFor(production: Production, reading: VisitorReading): DateFacts {
    const ceiling = priceCeiling(reading)
    const date = new Date(production.date)
    return {
        reach: reachFrom(reading.metro, production.city),
        weekend: isWeekend(production.date),
        inBudget: ceiling === undefined || production.floor_price <= ceiling,
        sellingFast: production.sales_velocity >= FAST_VELOCITY,
        weekday: date.toLocaleDateString('en-US', { weekday: 'long' }),
    }
}

/** One date, in words Jev can weigh against the others. */
export function describeDate(production: Production, reading: VisitorReading): string {
    const facts = factsFor(production, reading)
    const date = new Date(production.date).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
    })
    const level = (score: number) => (score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low')
    const where =
        facts.reach === 'home'
            ? 'in the visitor’s own city'
            : facts.reach === 'drive'
              ? 'a drive from the visitor'
              : facts.reach === 'flight'
                ? 'a flight away from the visitor'
                : 'at an unknown distance'

    return [
        `${production.city}, ${date}, ${where}.`,
        `From $${production.floor_price}${facts.inBudget ? ', inside the budget' : ', over the budget'}.`,
        `Fan demand ${level(production.demand_score)}, value ${level(production.value_score)}.`,
        facts.sellingFast ? 'Selling fast.' : '',
        production.traits.length > 0 ? `Notable: ${production.traits.join(', ')}.` : '',
    ]
        .filter(Boolean)
        .join(' ')
}
