/**
 * HOW LONG A SESSION RUNS — the author's choice (Phase 4.4, D23). Pure and
 * client-safe, so the setup sheet, the start route and the stop decision read
 * one rule.
 *
 *   ROUNDS          a number of rounds (1..`SESSION_ROUNDS_MAX`)
 *   QUESTIONS       a number of questions (1..`SESSION_QUESTIONS_CHOSEN_MAX`); the last round asks only what is left
 *   UNTIL_STOPPED   until the author stops
 *
 * The fixed six-round limit (2.2's depth table) is gone: the depth dial now sets how far DOWN a session goes (the
 * levels in reach and the deepening ladder's layers), never how many rounds it runs. Every session, whatever its
 * mode, is still bounded by its token budget (`tokenBudgetFor`), the workspace's monthly ceiling (D10), the kill
 * switch, the author's stop, and the most questions one session's reads hold (SESSION_LIMIT); and when every
 * question left is minor it pauses and asks whether to go on (VALUE_FELL, D30), so a long session never pads.
 *
 * THE TOKEN BUDGET is sized from the length: a ROUNDS session's rounds, a QUESTIONS session's questions over the
 * round cap (and one round more, for fields carried), an open-ended session `OPEN_ENDED_ROUNDS` rounds; each round
 * its generation calls, its reconcile call, the tie-break call (`ORDER_CALL_TOKENS`) and a share for long-session
 * compaction (`COMPACTION_TOKENS_PER_ROUND`): 4.3's review found the summary call must fit the session's budget
 * beside the round it serves, so an open-ended session is budgeted for it rather than stalled for want of it.
 */
import { DETAIL, TOKENS_PER_GENERATION_CALL, TOKENS_PER_RECONCILE_CALL } from './dials';
import type { InterviewLengthMode } from './vocabulary';

export type SessionLength = { mode: 'ROUNDS'; rounds: number } | { mode: 'QUESTIONS'; questions: number } | { mode: 'UNTIL_STOPPED' };

/** The most rounds a ROUNDS session may ask for (the database's CHECK holds the same). */
export const SESSION_ROUNDS_MAX = 30;
/** The most questions a QUESTIONS session may ask for (the CHECK holds the same). */
export const SESSION_QUESTIONS_CHOSEN_MAX = 300;
/** The rounds an UNTIL_STOPPED session's token budget is sized for. */
export const OPEN_ENDED_ROUNDS = 30;
/** What a session runs with when its request names no length: four rounds (what 2.2's default depth gave). */
export const DEFAULT_SESSION_LENGTH: Readonly<{ mode: 'ROUNDS'; rounds: number }> = Object.freeze({ mode: 'ROUNDS' as const, rounds: 4 });

/** Tokens a round sets aside for the tie-break call (`QUESTION_ORDER_PROMPT`, fast tier, small input). */
export const ORDER_CALL_TOKENS = 3_000;
/** Tokens a round sets aside for long-session compaction's summary call (D29, on since 4.4). */
export const COMPACTION_TOKENS_PER_ROUND = 6_000;

export function isSessionLength(value: unknown): value is SessionLength {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    const whole = (n: unknown, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;
    if (v.mode === 'ROUNDS') return whole(v.rounds, SESSION_ROUNDS_MAX);
    if (v.mode === 'QUESTIONS') return whole(v.questions, SESSION_QUESTIONS_CHOSEN_MAX);
    return v.mode === 'UNTIL_STOPPED';
}

/** The session row's columns for a length. */
export function lengthColumns(length: SessionLength): { lengthMode: InterviewLengthMode; roundBudget: number | null; questionBudget: number | null } {
    if (length.mode === 'ROUNDS') return { lengthMode: 'ROUNDS', roundBudget: length.rounds, questionBudget: null };
    if (length.mode === 'QUESTIONS') return { lengthMode: 'QUESTIONS', roundBudget: null, questionBudget: length.questions };
    return { lengthMode: 'UNTIL_STOPPED', roundBudget: null, questionBudget: null };
}

/** A session row's length, read back (a pre-4.4 row is ROUNDS with the budget it started with). */
export function lengthOf(row: { lengthMode: InterviewLengthMode; roundBudget: number | null; questionBudget: number | null }): SessionLength {
    if (row.lengthMode === 'QUESTIONS' && row.questionBudget !== null) return { mode: 'QUESTIONS', questions: row.questionBudget };
    if (row.lengthMode === 'UNTIL_STOPPED') return { mode: 'UNTIL_STOPPED' };
    return { mode: 'ROUNDS', rounds: row.roundBudget ?? DEFAULT_SESSION_LENGTH.rounds };
}

/** The rounds a session's token budget is sized for. */
export function budgetedRounds(length: SessionLength, detail: number): number {
    if (length.mode === 'ROUNDS') return length.rounds;
    if (length.mode === 'QUESTIONS') return Math.ceil(length.questions / DETAIL[detail].roundCap) + 1;
    return OPEN_ENDED_ROUNDS;
}

/** One round's share of the budget: its generation calls (one per persona, one with none), its reconcile, the tie-break and compaction. */
export function tokensPerRound(personaCount: number): number {
    return Math.max(1, personaCount) * TOKENS_PER_GENERATION_CALL + TOKENS_PER_RECONCILE_CALL + ORDER_CALL_TOKENS + COMPACTION_TOKENS_PER_ROUND;
}

/** A session's token budget, input and output together (the header). */
export function tokenBudgetFor(length: SessionLength, detail: number, personaCount: number): number {
    return budgetedRounds(length, detail) * tokensPerRound(personaCount);
}
