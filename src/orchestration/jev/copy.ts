import type { Production } from '@/contracts/market'
import { FAST_VELOCITY } from '@/modules/production-list/badges'

import { factsFor, priceCeiling, type SectionId } from './sections'
import type { VisitorReading } from './reading'

/**
 * Every word a visitor reads that the model used to write.
 *
 * Jev cannot write, so headings and the top pick's reason are chosen from here.
 * That moves them into the "selective" class in docs/COMPOSABILITY.md: the
 * wording is ours and vetted, and the model picks. Each entry only offers itself
 * when what it says is true of this visitor and these rows, so Jev is never
 * choosing between a true sentence and a false one.
 *
 * Bump `COPY_VERSION` on any edit. It is part of the cache key, so a copy change
 * never replays a choice made against the old wording.
 */

export const COPY_VERSION = 'copy-v1'

export const HEADING_MAX = 60
export const REASON_MIN = 40
export const REASON_MAX = 240

interface HeadingEnv {
    reading: VisitorReading
    sort: string
}

interface HeadingOption {
    id: string
    text: (env: HeadingEnv) => string | null
}

const budgetText = (reading: VisitorReading) => {
    if (reading.budget === null) return null
    return reading.budgetExact ? `Under $${priceCeiling(reading)}` : `Around $${reading.budget}`
}

export const HEADINGS: Record<SectionId, HeadingOption[]> = {
    fit: [
        { id: 'start_here', text: () => 'Where to start' },
        {
            id: 'best_bets_near',
            text: ({ reading }) =>
                reading.metro && reading.travel !== 'fly'
                    ? `Your best bets near ${reading.metro}`
                    : null,
        },
        {
            id: 'budget_and_drive',
            text: ({ reading }) =>
                reading.metro && budgetText(reading) && reading.travel === 'drive'
                    ? `${budgetText(reading)}, within a drive of ${reading.metro}`
                    : null,
        },
        {
            id: 'biggest_you_can_make',
            text: ({ sort }) => (sort === 'demand' ? 'The biggest nights you can make' : null),
        },
        {
            id: 'cheapest_way_in',
            text: ({ sort }) => (sort === 'price' ? 'The cheapest ways in' : null),
        },
        {
            id: 'weekend_nights',
            text: ({ reading }) =>
                reading.days === 'weekend' ? 'Weekend nights you can make' : null,
        },
    ],
    more_in_reach: [
        { id: 'more_you_can_make', text: () => 'More dates you can make' },
        {
            id: 'more_near',
            text: ({ reading }) =>
                reading.metro && reading.travel !== 'fly'
                    ? `More within reach of ${reading.metro}`
                    : null,
        },
        {
            id: 'also_in_budget',
            text: ({ reading }) => (reading.budget !== null ? 'Also inside your budget' : null),
        },
    ],
    big_nights: [
        { id: 'loudest', text: () => 'Where this tour gets loudest' },
        { id: 'biggest', text: () => 'The biggest nights of the tour' },
        { id: 'everyone_wants', text: () => 'The nights everyone wants, wherever they are' },
    ],
    selling_out: [
        { id: 'going_fast', text: () => 'Going fast: dates selling out' },
        { id: 'decide_soon', text: () => 'Decide soon on these' },
    ],
    best_value: [
        { id: 'best_value', text: () => 'The best value on the tour' },
        { id: 'most_show', text: () => 'The most show for the money' },
    ],
    worth_a_flight: [
        { id: 'worth_a_flight', text: () => 'Worth a flight' },
        { id: 'if_flying', text: () => "If you're ever flying" },
    ],
}

/** The headings that are true here, keyed by id. */
export function headingOptions(section: SectionId, env: HeadingEnv): Record<string, string> {
    return Object.fromEntries(
        HEADINGS[section].flatMap((option) => {
            const text = option.text(env)
            return text !== null && text.length <= HEADING_MAX ? [[option.id, text]] : []
        }),
    )
}

interface ReasonEnv {
    pick: Production
    rows: Production[]
    reading: VisitorReading
}

interface ReasonOption {
    id: string
    text: (env: ReasonEnv) => string | null
}

const budgetClause = ({ pick, reading }: ReasonEnv) =>
    reading.budget !== null && factsFor(pick, reading).inBudget
        ? ', and it is inside your budget'
        : ''

const isBest = (rows: Production[], pick: Production, score: (p: Production) => number) =>
    rows.every((row) => score(row) <= score(pick))

/** "these three", or null when there is nothing to compare against. */
const these = (rows: Production[]) =>
    rows.length === 3 ? 'these three' : rows.length === 2 ? 'these two' : null

/**
 * Reasons scoped to the rows the hero shows. The Claude prompt spent a section
 * asking the model not to claim a rank it had not checked; here the rank is
 * checked before the sentence is offered at all.
 */
export const REASONS: ReasonOption[] = [
    {
        id: 'most_wanted',
        text: (env) =>
            these(env.rows) && isBest(env.rows, env.pick, (p) => p.demand_score)
                ? `Of ${these(env.rows)} dates, this is the one fans want most${budgetClause(env)}.`
                : null,
    },
    {
        id: 'cheapest',
        text: ({ pick, rows, reading }) => {
            if (!these(rows) || !rows.every((row) => row.floor_price >= pick.floor_price))
                return null
            const facts = factsFor(pick, reading)
            const where =
                facts.reach === 'home'
                    ? `, right in ${pick.city}`
                    : facts.reach === 'drive' && reading.metro
                      ? `, and ${pick.city} is a drive from ${reading.metro}`
                      : ''
            return `The lowest price to get in of ${these(rows)}, from $${pick.floor_price}${where}.`
        },
    },
    {
        id: 'best_value',
        text: ({ pick, rows }) =>
            these(rows) && isBest(rows, pick, (p) => p.value_score)
                ? `The best value of ${these(rows)}: strong demand for what it costs, from $${pick.floor_price}.`
                : null,
    },
    {
        id: 'no_travel',
        text: (env) =>
            factsFor(env.pick, env.reading).reach === 'home'
                ? `It is in ${env.pick.city}, so you can go without planning any travel${budgetClause(env)}.`
                : null,
    },
    {
        id: 'weekend_plan',
        text: (env) => {
            const facts = factsFor(env.pick, env.reading)
            return facts.weekend
                ? `A ${facts.weekday} night in ${env.pick.city}, which makes it an easy weekend plan${budgetClause(env)}.`
                : null
        },
    },
    {
        id: 'selling_first',
        text: ({ pick, rows }) =>
            these(rows) &&
            pick.sales_velocity >= FAST_VELOCITY &&
            isBest(rows, pick, (p) => p.sales_velocity)
                ? `It is selling faster than the other ${rows.length === 3 ? 'two dates' : 'date'} here, so it is the one to decide on first.`
                : null,
    },
]

const PLAIN_PROSE = /^[^*_`#<>|\n]+$/

export function reasonOptions(env: ReasonEnv): Record<string, string> {
    return Object.fromEntries(
        REASONS.flatMap((option) => {
            const text = option.text(env)
            const fits =
                text !== null &&
                text.length >= REASON_MIN &&
                text.length <= REASON_MAX &&
                PLAIN_PROSE.test(text)
            return fits ? [[option.id, text]] : []
        }),
    )
}
