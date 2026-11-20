/**
 * The question engine's closed vocabularies (Phase 2.2), mirrored client-safe
 * from the Prisma enums in `prisma/schema/enums.prisma` (the order of each
 * list is the enum's), plus the six persona keys of the content formats
 * (section 1.10). `tests/unit/interview/vocabulary.test.ts` holds each list
 * equal to its enum.
 */

export const INTERVIEW_SCOPES = ['ELEMENT', 'KIND', 'BOOK'] as const;
export type InterviewScope = (typeof INTERVIEW_SCOPES)[number];

export const INTERVIEW_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED', 'STOPPED'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const STOP_REASONS = [
    'FRONTIER_EMPTY',
    'NOTHING_AT_DEPTH',
    'ROUND_BUDGET',
    'TOKEN_BUDGET',
    'WORKSPACE_CEILING',
    'KILL_SWITCH',
    'AUTHOR_STOPPED',
    'PROVIDER_FAILURE',
    'NO_ACCEPTABLE_QUESTION',
    'GUARD_REFUSED',
    'PACK_CHANGED',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const ROUND_STATUSES = ['GENERATING', 'OPEN', 'CLOSED', 'FAILED'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const QUESTION_KINDS = ['OPEN', 'CHOICE', 'EITHER_OR', 'SCENARIO', 'SCALE'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_MODES = ['FRONTIER', 'CHALLENGE'] as const;
export type QuestionMode = (typeof QUESTION_MODES)[number];

export const QUESTION_ORIGINS = ['MODEL', 'PACK_FALLBACK'] as const;
export type QuestionOrigin = (typeof QUESTION_ORIGINS)[number];

export const ANSWER_STATUSES = ['ANSWERED', 'SKIPPED', 'DECIDE_LATER'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/** The six interviewer personas (content formats 1.10). Closed. */
export const PERSONA_KEYS = ['gentle-mentor', 'ruthless-editor', 'socratic', 'devils-advocate', 'target-reader', 'genre-specialist'] as const;
export type PersonaKey = (typeof PERSONA_KEYS)[number];

export function isPersonaKey(value: unknown): value is PersonaKey {
    return typeof value === 'string' && (PERSONA_KEYS as readonly string[]).includes(value);
}

/**
 * How a stop leaves the session. A stop that ran out of things to ask or of
 * rounds COMPLETES it; the author's stop STOPS it; a stop that can clear (a
 * failed model call, a guard refusal, a budget, the kill switch, a changed
 * pack) PAUSES it, and the next round resumes it.
 */
export const STATUS_AFTER_STOP: Readonly<Record<StopReason, Exclude<InterviewStatus, 'ACTIVE'>>> = {
    FRONTIER_EMPTY: 'COMPLETED',
    NOTHING_AT_DEPTH: 'COMPLETED',
    ROUND_BUDGET: 'COMPLETED',
    TOKEN_BUDGET: 'PAUSED',
    WORKSPACE_CEILING: 'PAUSED',
    KILL_SWITCH: 'PAUSED',
    AUTHOR_STOPPED: 'STOPPED',
    PROVIDER_FAILURE: 'PAUSED',
    NO_ACCEPTABLE_QUESTION: 'PAUSED',
    GUARD_REFUSED: 'PAUSED',
    // A pack the session pinned is not the file this deployment would teach it
    // (Phase 2.3): paused, because the pins are written once and a deployment
    // that restores the file lets it resume; the author can start afresh. A
    // session from before pinning (2.2, NULL pins; `stopDetail.problem`
    // PACK_NOT_PINNED) is never pinned later — a pin written after the start
    // would be a reconstruction — so it stays paused, readable, and the author
    // starts a new session.
    PACK_CHANGED: 'PAUSED',
};
