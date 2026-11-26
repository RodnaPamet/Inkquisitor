/**
 * The depth and detail dials' tables (Phase 2.2; 2.3 adds the manner, the
 * workspace and book defaults and their precedence in `dial-settings.ts`).
 * A dial changes
 * what is asked and how, and the budgets; it never changes what may be
 * written to the bible (roadmap 2.3).
 *
 * The tables are the question-engine design's (sections 8.1 and 8.2) and the
 * content formats' (1.5, 1.6). They live here, in one file, so a prompt, a
 * validation and a budget can never disagree about a dial.
 */
import type { QuestionKind } from './vocabulary';

export const DIAL_MIN = 1;
export const DIAL_MAX = 5;

/** The depth and detail a session runs with when no layer sets them (`CODE_DEFAULT_DIALS` in `dial-settings.ts`). */
export const DEFAULT_DIALS = Object.freeze({ depth: 3, detail: 3 });

export interface Dials {
    /** How far down the field dependencies (a field's level must not exceed it). */
    depth: number;
    /** How specific a question is and how long a reply it invites. */
    detail: number;
}

interface DepthRow {
    /** The sentence the prompt carries for this depth. */
    emphasis: string;
}

/**
 * Design 8.1. Since Phase 4.4 (D23) depth sets how far DOWN a session goes — the levels in reach and the deepening
 * ladder's layers (`ladderDepthFor`) — and no longer how many rounds it runs: the session's length is the author's
 * (`session-length.ts`), and the fixed six-round limit is gone.
 */
export const DEPTH: Readonly<Record<number, DepthRow>> = Object.freeze({
    1: { emphasis: 'Ask about foundations only; no consequences or edge cases.' },
    2: { emphasis: 'Ask about foundations and what rests directly on them.' },
    3: { emphasis: 'Ask about consequences and pressures as well as foundations.' },
    4: { emphasis: 'Ask about consequences and pressures; a stored value may be challenged when the round has room.' },
    5: { emphasis: 'Ask about consistency with related elements and edge cases; a stored value may be challenged.' },
});

interface DetailRow {
    /** The question kinds this detail allows (content formats 1.6). */
    kinds: readonly QuestionKind[];
    /** How many questions a round holds at most. */
    roundCap: number;
    /** The longest text answer the session accepts (refused beyond, never cut); 0 = a pick only. */
    answerMax: number;
    /** The reply the prompt invites, in one sentence. */
    reply: string;
    /** The generation call's output budget in tokens (roadmap rule 9: a cost budget per call). */
    maxOutputTokens: number;
}

/** Design 8.2. */
export const DETAIL: Readonly<Record<number, DetailRow>> = Object.freeze({
    1: { kinds: ['CHOICE', 'EITHER_OR', 'SCALE'], roundCap: 8, answerMax: 0, reply: 'Invite a pick or a number, nothing written.', maxOutputTokens: 1_200 },
    2: { kinds: ['CHOICE', 'EITHER_OR', 'SCALE', 'OPEN'], roundCap: 7, answerMax: 300, reply: 'Invite a pick, a number, or a phrase of up to one sentence.', maxOutputTokens: 1_400 },
    3: {
        kinds: ['OPEN', 'CHOICE', 'EITHER_OR', 'SCENARIO', 'SCALE'],
        roundCap: 6,
        answerMax: 600,
        reply: 'Invite up to three sentences; a pick may carry a one-sentence reason.',
        maxOutputTokens: 1_600,
    },
    4: {
        kinds: ['OPEN', 'SCENARIO', 'CHOICE', 'EITHER_OR'],
        roundCap: 4,
        answerMax: 1_500,
        reply: 'Invite about a paragraph; a pick carries a reason of a few sentences.',
        maxOutputTokens: 1_600,
    },
    5: { kinds: ['OPEN', 'SCENARIO'], roundCap: 3, answerMax: 4_000, reply: 'Invite several paragraphs.', maxOutputTokens: 1_400 },
});

/** A pick may carry a written reason from detail 3 (content formats 1.6). */
export const PICK_REASON_FROM_DETAIL = 3;
/** A pick's reason is held to this many characters at detail 1 and 2 (where none is invited, one sentence is still accepted). */
export const PICK_REASON_MIN_MAX = 300;

/** A question may target two fields only from this detail, where a reply of several sentences can serve both. */
export const PAIR_TARGETS_FROM_DETAIL = 3;

/** Tokens per persona generation call and per reconcile call, the session budget's terms (design 8.4). */
export const TOKENS_PER_GENERATION_CALL = 9_000;
export const TOKENS_PER_RECONCILE_CALL = 6_000;

export function isDial(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= DIAL_MIN && value <= DIAL_MAX;
}

export function kindsAllowed(detail: number): readonly QuestionKind[] {
    return DETAIL[detail].kinds;
}

export function roundCapFor(detail: number): number {
    return DETAIL[detail].roundCap;
}

/** The longest written text an answer at this detail may carry. */
export function answerTextMax(detail: number): number {
    return Math.max(DETAIL[detail].answerMax, PICK_REASON_MIN_MAX);
}
