import type { Context } from '@/contracts/context'
import type { LayoutEntry } from '@/contracts/layout-spec'
import type { Market, Production } from '@/contracts/market'
import { CARD_SIGNAL_IDS } from '@/modules/production-list/card-signal'
import type { StatId } from '@/modules/market-signals/signals'

import { decide, type Answer, type ChoiceAnswer, type Question, type ScoreAnswer } from './client'
import { COPY_VERSION, headingOptions, reasonOptions } from './copy'
import { parseReading, readingFromContext, readingQuestions, type VisitorReading } from './reading'
import {
    MIN_BAND_ROWS,
    describeDate,
    heroDefinition,
    propsFor,
    rowsFor,
    sectionDefinitions,
    type SectionDefinition,
    type SectionId,
    type Sort,
} from './sections'

/**
 * A page composed by Jev, in three calls: read the visitor, arrange the page,
 * then present it.
 *
 * Each stage needs the one before it. What sections exist depends on the budget
 * and the distance the visitor stated, and which three rows the top group shows
 * depends on the sort Jev picks for it, so a pick and its reason can only be
 * asked about once those rows are known. Questions inside a stage are answered
 * in parallel and cannot see each other.
 *
 * The output is an ordinary layout spec and goes through the same validator as
 * the Claude compositions did, so a bad decision here is repaired or reported
 * rather than rendered.
 */

/** Part of the cache key: a change to any question invalidates stored compositions. */
export const COMPOSER_VERSION = `jev-composer-v1+${COPY_VERSION}`

/** A top pick below this is left out. "An arbitrary recommendation is worse than none." */
export const PICK_CONFIDENCE = 0.5

/** Bands scored at or above "useful context" are placed. */
const BAND_FLOOR = 1

const MAX_BANDS = 2

const SORTS: Record<Sort, string> = {
    demand: 'The most anticipated nights first.',
    price: 'The cheapest ways in first.',
    value: 'The best value for the money first.',
    date: 'The soonest dates first.',
}

const BAND_SCALE = [
    'Noise for this visitor.',
    'Useful context for this visitor.',
    'Directly answers what this visitor is weighing.',
]

const CARD_SIGNALS: Record<(typeof CARD_SIGNAL_IDS)[number] | 'none', string> = {
    none: 'Show nothing beside the price.',
    price_trend: 'How this date’s price moved over the last week.',
    price_gap_to_cheapest: 'How far each date is above the cheapest date in the section.',
    typical_seat_price: 'What a typical seat costs, not just the cheapest.',
}

const RAIL_DEMAND: Partial<Record<StatId, string>> = {
    fan_demand: 'How much fans want this tour.',
    selling_out: 'How many dates are selling out fast.',
    fans_viewing: 'How many fans looked at these dates in the last day.',
}

const RAIL_PRICE: Partial<Record<StatId, string>> = {
    lowest_price: 'The cheapest price to get in anywhere on the tour.',
    typical_price: 'The typical price to get in.',
    price_direction: 'Which way prices moved over the last week.',
}

export interface StageTrace {
    stage: 'read' | 'arrange' | 'present'
    state: Record<string, unknown>
    questions: Record<string, Question>
    answers: Record<string, Answer>
    model: string
    durationMs: number
}

export interface JevComposition {
    /** Unvalidated: `LiveProvider` passes it through `validateLayout`. */
    spec: {
        layout: LayoutEntry[]
        reasoning: string
        visitor_metro: string | null
    }
    model: string
    costUsd: number | null
    inputTokens: number | null
    durationMs: number
    /** Every stage's state, questions and answers. The drawer's "raw output". */
    trace: StageTrace[]
}

function asChoice(answer: Answer | undefined): ChoiceAnswer | null {
    return answer?.type === 'choice' ? answer : null
}

function asScore(answer: Answer | undefined): ScoreAnswer | null {
    return answer?.type === 'score' ? answer : null
}

function questionKey(prefix: string, id: string): string {
    return `${prefix}_${id.replace(/[^a-zA-Z0-9]+/g, '_')}`
}

function visitorState(reading: VisitorReading, market: Market) {
    return {
        performer: market.performer.name,
        in_city: reading.metro ?? 'unknown',
        budget_per_ticket: reading.budget === null ? 'no limit stated' : `$${reading.budget}`,
        travel: reading.travel,
        days: reading.days,
        priority: reading.intent,
        worried_about_sellouts: reading.watchesSellout,
    }
}

export async function composeWithJev(context: Context, market: Market): Promise<JevComposition> {
    const trace: StageTrace[] = []

    const ask = async (
        stage: StageTrace['stage'],
        state: Record<string, unknown>,
        questions: Record<string, Question>,
    ) => {
        const result = await decide(state, questions)
        trace.push({
            stage,
            state,
            questions,
            answers: result.answers,
            model: result.model,
            durationMs: result.durationMs,
        })
        return result
    }

    const calls: Awaited<ReturnType<typeof decide>>[] = []

    let reading: VisitorReading
    if (context.brief) {
        const read = await ask(
            'read',
            { description_of_visitor: context.brief },
            readingQuestions(market),
        )
        calls.push(read)
        reading = parseReading(read.answers, context, market)
    } else {
        reading = readingFromContext(context, market)
    }

    const arrange = await arrangePage(context, market, reading, ask)
    calls.push(arrange.call)

    const present = await presentPage(context, market, reading, arrange, ask)
    calls.push(present.call)

    const sum = (pick: (call: (typeof calls)[number]) => number | null) =>
        calls.every((call) => pick(call) !== null)
            ? calls.reduce((total, call) => total + (pick(call) ?? 0), 0)
            : null

    return {
        spec: {
            layout: [...present.layout, arrange.rail],
            reasoning: explain(reading, arrange, present),
            visitor_metro: reading.metro,
        },
        model: calls[calls.length - 1].model,
        costUsd: sum((call) => call.costUsd),
        inputTokens: sum((call) => call.inputTokens),
        durationMs: calls.reduce((total, call) => total + call.durationMs, 0),
        trace,
    }
}

type Ask = (
    stage: StageTrace['stage'],
    state: Record<string, unknown>,
    questions: Record<string, Question>,
) => ReturnType<typeof decide>

interface Arrangement {
    call: Awaited<ReturnType<typeof decide>>
    sort: Sort
    hero: SectionDefinition
    bands: SectionDefinition[]
    bandScores: Record<string, number>
    rail: LayoutEntry
}

/**
 * Stage two: which sections, in what order, and how the top group is sorted.
 *
 * A band is only offered if it still holds three dates whichever sort the top
 * group ends up with, so nothing Jev chooses here can leave a thin section.
 */
async function arrangePage(
    context: Context,
    market: Market,
    reading: VisitorReading,
    ask: Ask,
): Promise<Arrangement> {
    const sorts = Object.keys(SORTS) as Sort[]
    const bands = sectionDefinitions(market, reading).filter(
        (definition) => definition.id !== 'fit',
    )

    const viable = bands.filter((band) =>
        sorts.every((sort) => {
            const hero = heroDefinition(market, context, reading, sort)
            const claimed = new Set(
                rowsFor(market, context, propsFor(hero, 'hero', sort), new Set()).map(
                    (row) => row.id,
                ),
            )
            return (
                rowsFor(market, context, propsFor(band, 'standard'), claimed).length >=
                MIN_BAND_ROWS
            )
        }),
    )

    const questions: Record<string, Question> = {
        hero_sort: {
            type: 'choice',
            instructions:
                'The top of the page shows three dates this visitor can make. How should they be ordered?',
            criteria: SORTS,
        },
        rail_lead: {
            type: 'choice',
            instructions: 'Which kind of fact about the tour matters more to this visitor?',
            criteria: {
                demand: 'How much demand there is.',
                price: 'What tickets cost.',
            },
        },
        rail_demand: {
            type: 'choice',
            instructions: 'Which demand fact would help this visitor decide?',
            criteria: RAIL_DEMAND as Record<string, string>,
        },
        rail_price: {
            type: 'choice',
            instructions: 'Which price fact would help this visitor decide?',
            criteria: RAIL_PRICE as Record<string, string>,
        },
        ...Object.fromEntries(
            viable.map((band) => [
                questionKey('band', band.id),
                {
                    type: 'score',
                    instructions: `How useful is this section to this visitor, below their top three dates? ${band.purpose}`,
                    criteria: BAND_SCALE,
                } satisfies Question,
            ]),
        ),
    }

    const state = {
        visitor: visitorState(reading, market),
        tour_dates: market.productions.length,
        sections_available: Object.fromEntries(viable.map((band) => [band.id, band.purpose])),
    }

    const call = await ask('arrange', state, questions)
    const sortChoice = asChoice(call.answers.hero_sort)?.choice
    const sort: Sort = sortChoice && sortChoice in SORTS ? (sortChoice as Sort) : 'demand'
    const hero = heroDefinition(market, context, reading, sort)

    const bandScores = Object.fromEntries(
        viable.map((band) => [
            band.id,
            asScore(call.answers[questionKey('band', band.id)])?.score ?? 0,
        ]),
    )
    const ranked = [...viable].sort((a, b) => bandScores[b.id] - bandScores[a.id])

    const claimed = new Set(
        rowsFor(market, context, propsFor(hero, 'hero', sort), new Set()).map((row) => row.id),
    )
    const placed: SectionDefinition[] = []
    for (const band of ranked) {
        if (placed.length === MAX_BANDS) break
        if (bandScores[band.id] < BAND_FLOOR && placed.length > 0) break
        const rows = rowsFor(market, context, propsFor(band, 'standard'), claimed)
        if (rows.length < MIN_BAND_ROWS) continue
        placed.push(band)
        for (const row of rows) claimed.add(row.id)
    }

    const lead = asChoice(call.answers.rail_lead)?.choice === 'price' ? 'price' : 'demand'
    const demandStat = (asChoice(call.answers.rail_demand)?.choice ?? 'fan_demand') as StatId
    const priceStat = (asChoice(call.answers.rail_price)?.choice ?? 'lowest_price') as StatId
    const stats: StatId[] =
        lead === 'price'
            ? [priceStat, demandStat, 'tour_scale']
            : [demandStat, priceStat, 'tour_scale']

    return {
        call,
        sort,
        hero,
        bands: placed,
        bandScores,
        rail: { module: 'market_signals', size: 'fixed', props: { stats } },
    }
}

interface Presentation {
    call: Awaited<ReturnType<typeof decide>>
    layout: LayoutEntry[]
    topPick: string | null
    /** What Jev answered, including `none`, and how sure it was. Null when not asked. */
    pickAnswer: ChoiceAnswer | null
}

/**
 * Stage three: the words and the recommendation, now the rows are known.
 *
 * Every heading and reason on offer is already true of its section, so what Jev
 * is choosing is emphasis. A pick is asked for among the three rows the top
 * group really shows, which is why it can never label a date that is not there.
 */
async function presentPage(
    context: Context,
    market: Market,
    reading: VisitorReading,
    arrangement: Arrangement,
    ask: Ask,
): Promise<Presentation> {
    const sections: {
        definition: SectionDefinition
        size: 'hero' | 'standard'
        rows: Production[]
    }[] = []
    const claimed = new Set<string>()
    for (const [definition, size] of [
        [arrangement.hero, 'hero'] as const,
        ...arrangement.bands.map((band) => [band, 'standard'] as const),
    ]) {
        const sort = size === 'hero' ? arrangement.sort : definition.sort
        const rows = rowsFor(market, context, propsFor(definition, size, sort), claimed)
        for (const row of rows) claimed.add(row.id)
        sections.push({ definition, size, rows })
    }

    const heroRows = sections[0].rows
    const headings = sections.map(({ definition, size }) =>
        headingOptions(definition.id, {
            reading,
            sort: size === 'hero' ? arrangement.sort : definition.sort,
        }),
    )
    const reasons = Object.fromEntries(
        heroRows.map((pick) => [pick.id, reasonOptions({ pick, rows: heroRows, reading })]),
    )
    const pickable = heroRows.filter((row) => Object.keys(reasons[row.id]).length > 0)

    const questions: Record<string, Question> = {}
    sections.forEach(({ definition }, index) => {
        if (Object.keys(headings[index]).length > 1) {
            questions[questionKey('heading', definition.id)] = {
                type: 'choice',
                instructions: `Which heading best frames the "${definition.id}" section for this visitor?`,
                criteria: headings[index],
            }
        }
        questions[questionKey('signal', definition.id)] = {
            type: 'choice',
            instructions: `Beside each date's starting price in the "${definition.id}" section, which comparison helps this visitor most?`,
            criteria: CARD_SIGNALS,
        }
    })
    if (pickable.length > 0) {
        questions.top_pick = {
            type: 'choice',
            instructions: 'Which one of these dates should the page recommend to this visitor?',
            criteria: {
                ...Object.fromEntries(
                    pickable.map((row) => [
                        questionKey('date', row.id),
                        describeDate(row, reading),
                    ]),
                ),
                none: 'None of them clearly stands out for this visitor.',
            },
        }
    }
    for (const row of pickable) {
        if (Object.keys(reasons[row.id]).length > 1) {
            questions[questionKey('reason', row.id)] = {
                type: 'choice',
                instructions: `If this date is recommended, which reason would matter most to this visitor? ${describeDate(row, reading)}`,
                criteria: reasons[row.id],
            }
        }
    }

    const state = {
        visitor: visitorState(reading, market),
        sections: Object.fromEntries(
            sections.map(({ definition, rows }) => [
                definition.id,
                {
                    purpose: definition.purpose,
                    dates: rows.map((row) => describeDate(row, reading)),
                },
            ]),
        ),
    }

    const call = await ask('present', state, questions)

    const pickAnswer = asChoice(call.answers.top_pick)
    const pickedRow =
        pickAnswer && pickAnswer.confidence >= PICK_CONFIDENCE
            ? pickable.find((row) => questionKey('date', row.id) === pickAnswer.choice)
            : undefined
    const reasonFor = (row: Production) => {
        const options = reasons[row.id]
        const chosen = asChoice(call.answers[questionKey('reason', row.id)])?.choice
        return (chosen && options[chosen]) ?? Object.values(options)[0] ?? null
    }

    const layout: LayoutEntry[] = sections.map(({ definition, size }, index) => {
        const options = headings[index]
        const chosenHeading = asChoice(call.answers[questionKey('heading', definition.id)])?.choice
        const heading =
            (chosenHeading && options[chosenHeading]) ?? Object.values(options)[0] ?? null
        const signal = asChoice(call.answers[questionKey('signal', definition.id)])?.choice
        const props: Record<string, unknown> = {
            ...propsFor(definition, size, size === 'hero' ? arrangement.sort : definition.sort),
            heading,
            card_signal: signal && signal !== 'none' ? signal : null,
        }
        if (size === 'hero' && pickedRow) {
            props.top_pick = pickedRow.id
            props.top_pick_reason = reasonFor(pickedRow)
        }
        return { module: 'production_list', size, props }
    })

    return {
        call,
        layout,
        topPick: pickedRow?.id ?? null,
        pickAnswer,
    }
}

const SECTION_NAMES: Record<SectionId, string> = {
    fit: 'the dates that fit',
    more_in_reach: 'more dates in reach',
    big_nights: 'the biggest nights',
    selling_out: 'dates selling out',
    best_value: 'the best value',
    worth_a_flight: 'dates worth a flight',
}

/**
 * The drawer's "Why this page", written by code from the decisions rather than
 * by the model. Jev gives no reasons, only choices and confidence, so this says
 * what was read and what was chosen, which is also what would be replayed.
 */
function explain(reading: VisitorReading, arrangement: Arrangement, presentation: Presentation) {
    const confidence = (name: string) =>
        reading.confidence[name] === undefined ? '' : ` (${reading.confidence[name].toFixed(2)})`
    const read = [
        `in ${reading.metro ?? 'an unknown city'}${confidence('metro')}`,
        reading.budget === null
            ? `no budget${confidence('budget')}`
            : `${reading.budgetExact ? 'at most' : 'about'} $${reading.budget}${confidence('budget')}`,
        `travel: ${reading.travel}${confidence('travel')}`,
        `days: ${reading.days}${confidence('days')}`,
        `priority: ${reading.intent}${confidence('intent')}`,
        reading.watchesSellout ? 'watching for sellouts' : 'not worried about sellouts',
    ].join(', ')

    const bands = arrangement.bands.length
        ? arrangement.bands
              .map(
                  (band) =>
                      `${SECTION_NAMES[band.id]} (${arrangement.bandScores[band.id].toFixed(2)})`,
              )
              .join(', then ')
        : 'nothing, because no other section held three dates'
    const answer = presentation.pickAnswer
    const pick = !answer
        ? 'No recommendation: no date had a reason that was true of it.'
        : presentation.topPick
          ? `Recommended ${presentation.topPick} at ${answer.confidence.toFixed(2)} confidence.`
          : answer.choice === 'none'
            ? `No recommendation: Jev chose none (${answer.confidence.toFixed(2)}).`
            : `No recommendation: confidence ${answer.confidence.toFixed(2)} was below ${PICK_CONFIDENCE}.`

    return `Read the visitor as ${read}. Led with ${SECTION_NAMES.fit}, sorted by ${arrangement.sort}. Below it: ${bands}. ${pick}`
}
