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
        elementId: 'el_1',
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
            dials: { depth: 3, detail: 3 },
            personaKeys: [],
            offerRecommended: true,
            preferChoice: false,
            packs: [],
            status: over.status ?? 'ACTIVE',
            stopReason: (over.stopReason ?? null) as InterviewView['session']['stopReason'],
            stopDetail: null,
            roundBudget: 4,
            roundsRun: 0,
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
