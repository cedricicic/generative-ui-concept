/**
 * The bridge to Jev, TypeSafe's decision model, through OpenRouter's Decisions API.
 *
 * Replaces the Claude CLI bridge. Jev answers typed questions about a state and
 * returns probabilities, not text, so a call is ~300ms and a fraction of a cent
 * rather than a minute and fifteen cents. It still bills, which is why this is
 * only reachable from `LiveProvider` and therefore only from a POST to
 * `/api/compose`.
 *
 * **Server-only.** It reads the API key from the environment.
 */

const ENDPOINT = process.env.JEV_ENDPOINT ?? 'https://openrouter.ai/api/alpha/decisions'

/**
 * Pinned, not `~typesafe/jev-latest`. Thresholds in `compose.ts` are tuned
 * against one release, and the alias would move them without anyone deciding to.
 */
export const JEV_MODEL = process.env.JEV_MODEL ?? 'typesafe/jev-1.13'

/**
 * Measured calls take 270-340ms. Five seconds is headroom for a slow day, not a
 * target: a composition is three sequential calls, and one hanging should fail
 * the page quickly rather than hold the drawer open.
 */
const TIMEOUT_MS = 5_000

export interface ChoiceQuestion {
    type: 'choice'
    instructions: string
    criteria: Record<string, string>
}

export interface NoulQuestion {
    type: 'noul'
    instructions: string
    criteria: { true: string; false: string }
}

export interface ScoreQuestion {
    type: 'score'
    instructions: string
    criteria: string[]
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion

export interface ChoiceAnswer {
    type: 'choice'
    choice: string
    confidence: number
    probabilities: Record<string, number>
}

export interface NoulAnswer {
    type: 'noul'
    noul: number
}

export interface ScoreAnswer {
    type: 'score'
    score: number
    confidence: number
    probabilities: Record<string, number>
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer

export interface DecisionResult {
    answers: Record<string, Answer>
    /** The dated snapshot that answered, e.g. `typesafe/jev-1.13-20260917`. */
    model: string
    costUsd: number | null
    inputTokens: number | null
    durationMs: number
}

interface DecisionEnvelope {
    model?: unknown
    answers?: unknown
    usage?: { input_tokens?: unknown; cost?: unknown }
    error?: { message?: unknown }
}

export async function decide(
    state: Record<string, unknown>,
    questions: Record<string, Question>,
): Promise<DecisionResult> {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (see .env.local)')

    const startedAt = Date.now()
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    let envelope: DecisionEnvelope
    try {
        envelope = (await response.json()) as DecisionEnvelope
    } catch {
        throw new Error(`Jev returned ${response.status} with a body that was not JSON`)
    }

    if (!response.ok) {
        const message = typeof envelope.error?.message === 'string' ? envelope.error.message : ''
        throw new Error(`Jev returned ${response.status}: ${message.slice(0, 300)}`)
    }
    if (envelope.answers === null || typeof envelope.answers !== 'object') {
        throw new Error('Jev returned no answers')
    }

    const answers = envelope.answers as Record<string, Answer>
    const missing = Object.keys(questions).filter((name) => answers[name] === undefined)
    if (missing.length > 0) throw new Error(`Jev did not answer: ${missing.join(', ')}`)

    return {
        answers,
        model: typeof envelope.model === 'string' ? envelope.model : JEV_MODEL,
        costUsd: typeof envelope.usage?.cost === 'number' ? envelope.usage.cost : null,
        inputTokens:
            typeof envelope.usage?.input_tokens === 'number' ? envelope.usage.input_tokens : null,
        durationMs: Date.now() - startedAt,
    }
}
