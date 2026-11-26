/**
 * Fixtures for the interview UI's rendered tests (Phase 2.4): questions and
 * interviews as the API answers them, and a streamed response the test feeds
 * event by event (jsdom has no `Response`: the hook reads `ok`, `status`,
 * `json()` and `body.getReader()`).
 */
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util';
import { sseData, type InterviewStreamEvent } from '@/lib/interview/stream-events';

// jsdom has neither; a browser has both (the stream hook decodes with TextDecoder).
const g = globalThis as unknown as { TextEncoder?: unknown; TextDecoder?: unknown };
g.TextEncoder ??= NodeTextEncoder;
g.TextDecoder ??= NodeTextDecoder;
import type { InterviewView, QuestionView } from '@/lib/interview/api-client';
import { dialEffects, resolveDials, type DialLayer } from '@/lib/interview/dial-settings';
import { SETUP_API } from '@/lib/interview/setup';
import { PERSONA_KEYS } from '@/lib/interview/vocabulary';

export const SLUG = 'ada';
export const BOOK = { id: 'book_1', title: 'The Salt Roads' };
export const SESSION_ID = 'sess_1';
export const IAPI = `/api/w/${SLUG}/books/${BOOK.id}/interviews`;
export const IDS = { slug: SLUG, bookId: BOOK.id, sessionId: SESSION_ID };
export const ELEMENTS = [{ id: 'el_1', name: 'Aurel Pask', kind: 'CHARACTER' as const }];

let n = 0;
export function question(over: Partial<QuestionView> = {}): QuestionView {
    n += 1;
    const kind = over.kind ?? 'OPEN';
    return {
        id: `q_${n}`,
        position: n,
        elementId: over.elementId ?? 'el_1',
        subjectId: over.subjectId ?? over.elementId ?? 'el_1',
        relationId: null,
        targetsFieldKeys: ['want'],
        mode: 'FRONTIER',
        origin: 'MODEL',
        personaKey: null,
        personaName: null,
        kind,
        text: 'What does Aurel want most?',
        options: kind === 'CHOICE' ? ['To leave', 'To stay', 'To be forgiven'] : kind === 'EITHER_OR' ? ['Hidden', 'Open'] : null,
        scaleLabels: kind === 'SCALE' ? { low: 'faint', high: 'overwhelming' } : null,
        recommendedAnswer: null,
        rationale: null,
        challengeQuote: null,
        dependsOnQuestionIds: [],
        replacesQuestionId: null,
        reviewRequired: false,
        generator: 'FRONTIER',
        angle: null,
        storyFactId: null,
        answer: null,
        ...over,
    };
}

export function answered(q: QuestionView, a: Partial<NonNullable<QuestionView['answer']>>): QuestionView {
    return { ...q, answer: { revision: 1, status: 'ANSWERED', text: null, choice: null, scale: null, acceptedRecommendation: false, ...a } };
}

export function interview(over: { questions?: QuestionView[]; status?: InterviewView['session']['status']; stopReason?: string | null; roundStatus?: 'OPEN' | 'CLOSED' | null; number?: number } = {}): InterviewView {
    const questions = over.questions ?? [];
    const answeredCount = questions.filter((q) => q.answer?.status === 'ANSWERED').length;
    return {
        session: {
            id: SESSION_ID,
            bookId: BOOK.id,
            scope: 'ELEMENT',
            targetElementId: 'el_1',
            targetElementName: 'Aurel Pask',
            targetKind: null,
            scopeElementIds: [],
            scopeRelationIds: [],
            slot: null,
            dials: { depth: 3, detail: 3 },
            personaKeys: [],
            offerRecommended: true,
            preferChoice: false,
            packs: [],
            status: over.status ?? 'ACTIVE',
            stopReason: (over.stopReason ?? null) as InterviewView['session']['stopReason'],
            stopDetail: null,
            length: { mode: 'ROUNDS', rounds: 4 },
            roundBudget: 4,
            roundsRun: 0,
            generatorsOff: [],
            minorAccepted: false,
            stressTestId: null,
            createdAt: '2026-11-19T10:00:00.000Z',
            endedAt: null,
        },
        progress:
            questions.length === 0
                ? { status: 'NOT_ASSESSED', asked: 0 }
                : { status: 'MEASURED', asked: questions.length, answered: answeredCount, skipped: 0, deferred: 0, unanswered: questions.length - answeredCount, answeredShare: answeredCount / questions.length },
        round: over.roundStatus === null ? null : { id: `round_${over.number ?? 1}`, number: over.number ?? 1, status: over.roundStatus ?? 'OPEN', questions },
        generatingRound: null,
        scopeTruncated: false,
    };
}

/**
 * A streamed answer the test feeds: `push` an event (or `end`), and the hook's
 * reader receives it. `aborted` tells whether the client cancelled.
 */
export function controlledStream() {
    const encoder = new TextEncoder();
    const queue: Array<Uint8Array | null> = [];
    let wake: (() => void) | null = null;
    const state = { cancelled: false };
    const reader = {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
            while (queue.length === 0) await new Promise<void>((r) => (wake = r));
            const chunk = queue.shift()!;
            return chunk === null ? { done: true } : { done: false, value: chunk };
        },
        async cancel() {
            state.cancelled = true;
        },
    };
    const feed = (c: Uint8Array | null) => {
        queue.push(c);
        const w = wake;
        wake = null;
        w?.();
    };
    return {
        response: { ok: true, status: 200, body: { getReader: () => reader }, json: async () => ({}) },
        push: (e: InterviewStreamEvent) => feed(encoder.encode(sseData(e))),
        end: () => feed(null),
        state,
    };
}

/** A whole stream, at once. */
export function streamOf(events: InterviewStreamEvent[]) {
    const s = controlledStream();
    for (const e of events) s.push(e);
    s.end();
    return s.response;
}

/**
 * The setup sheet's two reads as 2.3's routes answer them (for `mockFetch`):
 * `GET interview-packs` (every persona, each mountable unless named in
 * `unmountable`) and the book's `GET interview-defaults` resolved from `book`
 * with the real rule (`resolveDials`, `dialEffects`).
 */
export function setupRoutes(slug: string, bookId: string, opts: { book?: DialLayer; unmountable?: string[] } = {}) {
    const resolved = resolveDials({ book: opts.book ?? null });
    const persona = (key: string) => {
        const mountable = !(opts.unmountable ?? []).includes(key);
        return {
            name: `persona-${key}`,
            group: 'persona',
            key,
            displayName: key,
            version: 1,
            description: '',
            contentHash: 'sha256:0',
            coverage: null,
            evaluationCases: 3,
            mountable,
            refusal: mountable ? null : { reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'D11' },
            recordKind: mountable ? 'structural' : null,
        };
    };
    return {
        [`GET ${SETUP_API.packs(slug)}`]: { json: { recordMode: 'structural', personas: PERSONA_KEYS.map(persona), craft: [], mountable: 0, total: 0 } },
        [`GET ${SETUP_API.bookDefaults(slug, bookId)}`]: {
            json: {
                defaults: {
                    stored: { depth: null, detail: null, personaKeys: null, offerRecommended: null, preferChoice: null },
                    effective: resolved.settings,
                    sources: resolved.sources,
                    effects: dialEffects(resolved.settings),
                },
            },
        },
    };
}
