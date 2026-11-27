/**
 * The question engine's closed vocabularies (Phase 2.2), mirrored client-safe
 * from the Prisma enums in `prisma/schema/enums.prisma` (the order of each
 * list is the enum's), plus the six persona keys of the content formats
 * (section 1.10). `tests/unit/interview/vocabulary.test.ts` holds each list
 * equal to its enum.
 */

/** Phase 3.3 adds SELECTION ("Grill this" on a map) and BETWEEN ("What happens between these?"). */
export const INTERVIEW_SCOPES = ['ELEMENT', 'KIND', 'BOOK', 'SELECTION', 'BETWEEN', 'SCENE'] as const;
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
    'QUESTION_BUDGET',
    'VALUE_FELL',
    'SESSION_LIMIT',
    'AWAITING_DECISIONS',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const ROUND_STATUSES = ['GENERATING', 'OPEN', 'CLOSED', 'FAILED'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const QUESTION_KINDS = ['OPEN', 'CHOICE', 'EITHER_OR', 'SCENARIO', 'SCALE'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_MODES = ['FRONTIER', 'CHALLENGE'] as const;
export type QuestionMode = (typeof QUESTION_MODES)[number];

/** Phase 4.4 adds GENERATOR: worded by code from a question generator's template (D30). */
export const QUESTION_ORIGINS = ['MODEL', 'PACK_FALLBACK', 'REPHRASE', 'GENERATOR'] as const;
export type QuestionOrigin = (typeof QUESTION_ORIGINS)[number];

/**
 * Phase 4.4 (D23, D30): the question generators. The frontier is one among several; each proposes candidates
 * with a value score, and code validates, deduplicates and orders every candidate whichever proposed it.
 */
export const QUESTION_GENERATORS = ['FRONTIER', 'LADDER', 'RELATIONS', 'SOURCES', 'CONTINUITY'] as const;
export type QuestionGeneratorKey = (typeof QUESTION_GENERATORS)[number];

export function isQuestionGenerator(value: unknown): value is QuestionGeneratorKey {
    return typeof value === 'string' && (QUESTION_GENERATORS as readonly string[]).includes(value);
}

/** Phase 4.4 (D23): how long a session runs, the author's choice. */
export const INTERVIEW_LENGTH_MODES = ['ROUNDS', 'QUESTIONS', 'UNTIL_STOPPED'] as const;
export type InterviewLengthMode = (typeof INTERVIEW_LENGTH_MODES)[number];

/** Phase 4.4: the deepening ladder's layers, in order (D23: what, why, what it costs, who knows, what breaks it, edge cases). */
export const LADDER_LAYERS = ['WHAT', 'WHY', 'COST', 'WHO_KNOWS', 'BREAKS', 'EDGE_CASES'] as const;
export type LadderLayer = (typeof LADDER_LAYERS)[number];

/** Phase 4.4: a pair question's angles (D23: what each wants from the other, where they collide, what is hidden). */
export const PAIR_ANGLES = ['WANTS', 'COLLIDE', 'HIDDEN'] as const;
export type PairAngle = (typeof PAIR_ANGLES)[number];

/**
 * Phase 4.4 (owner decision 2026-11-26, B): a source question's angle. SERIES marks a question about a SERIES source's
 * fact: answering it decides the fact for every book that draws on that source (as the Facts page does), so the
 * question says so and the session page shows it.
 */
export const SOURCE_ANGLES = ['SERIES'] as const;
export type SourceAngle = (typeof SOURCE_ANGLES)[number];

export const ANSWER_STATUSES = ['ANSWERED', 'SKIPPED', 'DECIDE_LATER'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/**
 * The interviewer personas (content formats 1.10): the six of Phase 2.3, then
 * the three BOOK-LEVEL PANEL personas of Phase 4.3 (D29), which question the
 * whole book together and are offered only through the setup sheet's Panel
 * preset (`PANEL_PERSONA_KEYS`). Closed; the migration's CHECK holds the same list.
 */
export const PERSONA_KEYS = [
    'gentle-mentor',
    'ruthless-editor',
    'socratic',
    'devils-advocate',
    'target-reader',
    'genre-specialist',
    'panel-target-reader',
    'panel-ruthless-editor',
    'panel-genre-specialist',
] as const;
export type PersonaKey = (typeof PERSONA_KEYS)[number];

/** The book-level panel (Phase 4.3, D29): Target Reader, Ruthless Editor and Genre Specialist, in that order. */
export const PANEL_PERSONA_KEYS = ['panel-target-reader', 'panel-ruthless-editor', 'panel-genre-specialist'] as const satisfies readonly PersonaKey[];

export function isPanelPersona(key: string): boolean {
    return (PANEL_PERSONA_KEYS as readonly string[]).includes(key);
}

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
    // Phase 4.4 (D23): a QUESTIONS session asked the number the author chose.
    QUESTION_BUDGET: 'COMPLETED',
    // Phase 4.4 (D30): every question left is minor; the session says so and waits for the author to go on (the
    // next round with `goOn`), never padding a round with minor questions.
    VALUE_FELL: 'PAUSED',
    // Phase 4.4: the most questions one session holds (`SESSION_QUESTIONS_MAX`): a new session goes on.
    SESSION_LIMIT: 'COMPLETED',
    // Phase 4.4 (owner decision 2026-11-26, A): every question left follows up a field whose proposed change the
    // author has not decided yet; the session waits for those decisions (the next round resumes it), never asking
    // about a field while a change to it is pending.
    AWAITING_DECISIONS: 'PAUSED',
};
