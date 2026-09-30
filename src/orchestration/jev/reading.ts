import type { Context, InferredIntent } from '@/contracts/context'
import { InferredIntentSchema } from '@/contracts/context'
import type { Market } from '@/contracts/market'

import type { Answer, ChoiceAnswer, NoulAnswer, Question } from './client'

/**
 * Stage one: what the visitor told us, as typed values.
 *
 * Claude read the brief and reasoned about it in the same breath as composing.
 * Jev cannot hold a number in its head, so reading comes first and on its own:
 * it classifies the brief into buckets, and code does everything numeric with
 * the result. In the app this stage disappears, because favourites, location and
 * order history already arrive typed.
 */

export type Travel = 'local_only' | 'drive' | 'fly'
export type Days = 'weekend' | 'weeknight' | 'any'

export interface VisitorReading {
    /** A city the tour plays, or null when unknown. */
    metro: string | null
    /** Dollars per ticket, or null for no stated limit. */
    budget: number | null
    /** "No more than $80" rather than "about $80". */
    budgetExact: boolean
    travel: Travel
    days: Days
    intent: InferredIntent
    watchesSellout: boolean
    /** Every answer's confidence, for the drawer. */
    confidence: Record<string, number>
}

/**
 * Below this a choice is treated as not stated. Tuned by eye on the eval brief,
 * not on labelled data: see the plan's checkpoint 1.
 */
export const READING_CONFIDENCE = 0.5

const BUDGET_STEPS = [40, 50, 60, 70, 80, 90, 100, 120, 150, 175, 200, 250, 300, 400, 500] as const

const TRAVEL: Record<Travel | 'unstated', string> = {
    local_only: 'Will only go to a show in or right next to their own city.',
    drive: 'Will drive a few hours to a show but will not fly.',
    fly: 'Is willing to fly to a show.',
    unstated: 'The description does not say how far they will travel.',
}

const DAYS: Record<Days, string> = {
    weekend: 'Can only go on a Friday, Saturday or Sunday.',
    weeknight: 'Can only go Monday to Thursday.',
    any: 'Did not limit which days they can go.',
}

const INTENT: Record<InferredIntent, string> = {
    price_sensitive: 'Mostly wants the cheapest way in.',
    date_flexible: 'Mostly cares about finding a date that fits their schedule.',
    seat_quality_first: 'Mostly cares about having a great seat.',
    location_flexible: 'Happy to go wherever the show is.',
    gift_buyer: 'Buying tickets as a gift for someone else.',
    experience_first: 'Wants the biggest, most packed, highest energy night.',
    unknown: 'The description does not make their priority clear.',
}

function citySlug(city: string): string {
    return city.toLowerCase().replace(/[^a-z]+/g, '_')
}

function tourCities(market: Market): string[] {
    return [...new Set(market.productions.map((production) => production.city))].sort()
}

export function readingQuestions(market: Market): Record<string, Question> {
    const cities = Object.fromEntries(
        tourCities(market).map((city) => {
            const state = market.productions.find((p) => p.city === city)?.state ?? ''
            return [citySlug(city), `The visitor is in or lives near ${city}, ${state}.`]
        }),
    )

    return {
        metro: {
            type: 'choice',
            instructions: 'Where is the visitor?',
            criteria: {
                ...cities,
                elsewhere: 'The visitor is somewhere not in this list.',
                unstated: 'The description does not say where the visitor is.',
            },
        },
        budget: {
            type: 'choice',
            instructions: 'What is the most the visitor will pay per ticket?',
            criteria: {
                none: 'The description does not state a price limit.',
                ...Object.fromEntries(
                    BUDGET_STEPS.map((dollars) => [
                        `usd_${dollars}`,
                        `Around $${dollars} a ticket.`,
                    ]),
                ),
            },
        },
        budget_exact: {
            type: 'noul',
            instructions: 'Is the price limit stated as a hard ceiling?',
            criteria: {
                true: 'Stated as a strict maximum, such as "no more than" or "at most".',
                false: 'Approximate, such as "about" or "around", or no limit at all.',
            },
        },
        travel: {
            type: 'choice',
            instructions: 'How far will the visitor travel for a show?',
            criteria: TRAVEL,
        },
        days: {
            type: 'choice',
            instructions: 'Which days can the visitor go?',
            criteria: DAYS,
        },
        intent: {
            type: 'choice',
            instructions: 'What matters most to this visitor?',
            criteria: INTENT,
        },
        watches_sellout: {
            type: 'noul',
            instructions: 'Is the visitor worried about dates selling out?',
            criteria: {
                true: 'They mention sellouts, scarcity, or deciding before tickets are gone.',
                false: 'They say nothing about tickets running out.',
            },
        },
    }
}

function choice(answers: Record<string, Answer>, name: string): ChoiceAnswer {
    const answer = answers[name]
    if (answer?.type !== 'choice') throw new Error(`expected a choice for ${name}`)
    return answer
}

function noul(answers: Record<string, Answer>, name: string): NoulAnswer {
    const answer = answers[name]
    if (answer?.type !== 'noul') throw new Error(`expected a noul for ${name}`)
    return answer
}

/** A choice, or null when Jev is not sure enough to act on it. */
function confident(answer: ChoiceAnswer): string | null {
    return answer.confidence >= READING_CONFIDENCE ? answer.choice : null
}

export function parseReading(
    answers: Record<string, Answer>,
    context: Context,
    market: Market,
): VisitorReading {
    const metroAnswer = choice(answers, 'metro')
    const budgetAnswer = choice(answers, 'budget')
    const travelAnswer = choice(answers, 'travel')
    const daysAnswer = choice(answers, 'days')
    const intentAnswer = choice(answers, 'intent')

    const bySlug = new Map(tourCities(market).map((city) => [citySlug(city), city]))
    const metroChoice = confident(metroAnswer)
    const metro =
        metroChoice === null || metroChoice === 'unstated'
            ? fallbackMetro(context, market)
            : (bySlug.get(metroChoice) ?? null)

    const budgetChoice = confident(budgetAnswer)
    const budget =
        budgetChoice === null || budgetChoice === 'none'
            ? context.stated_budget
            : Number(budgetChoice.replace('usd_', ''))

    const travelChoice = confident(travelAnswer)
    const intentChoice = confident(intentAnswer)
    const parsedIntent = InferredIntentSchema.safeParse(intentChoice)

    return {
        metro,
        budget,
        budgetExact: noul(answers, 'budget_exact').noul >= 0.5,
        travel: travelChoice === 'local_only' || travelChoice === 'fly' ? travelChoice : 'drive',
        days: (confident(daysAnswer) as Days | null) ?? 'any',
        intent: parsedIntent.success ? parsedIntent.data : context.entry.inferred_intent,
        watchesSellout: noul(answers, 'watches_sellout').noul >= 0.5,
        confidence: {
            metro: metroAnswer.confidence,
            budget: budgetAnswer.confidence,
            travel: travelAnswer.confidence,
            days: daysAnswer.confidence,
            intent: intentAnswer.confidence,
        },
    }
}

/**
 * The geo-IP guess, used only when the brief says nothing about place. A guess
 * naming a city the tour does not play is no better than no guess.
 */
function fallbackMetro(context: Context, market: Market): string | null {
    return tourCities(market).includes(context.geo.metro) ? context.geo.metro : null
}

/** No brief to read: the structured context is all there is. The app's case. */
export function readingFromContext(context: Context, market: Market): VisitorReading {
    return {
        metro: fallbackMetro(context, market),
        budget: context.stated_budget,
        budgetExact: false,
        travel: 'drive',
        days: 'any',
        intent: context.entry.inferred_intent,
        watchesSellout: false,
        confidence: {},
    }
}
