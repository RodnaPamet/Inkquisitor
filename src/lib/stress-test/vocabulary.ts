/**
 * The stress test's words and bounds (Phase 4.3, decision D29). Client-safe:
 * no server import, so the Interrogate page reads the same lists the server
 * enforces.
 *
 *   A STRESS TEST is one deep-tier pass over the whole canon, run on demand
 *   after the author has seen its "at most" cost and confirmed it, as a
 *   background job (payload ids only). It finds the book's WEAK POINTS and
 *   turns each into QUESTIONS: never a verdict, never a rewrite (D3; rule 1).
 *   Every weak point cites what it rests on — an element (E), a fact (F), an
 *   open thread (T) or a passage of the book's sources (P) — by the tag the
 *   call was shown, and code checks every citation.
 */

/** The kinds of weak point the pass looks for (the migration's CHECK holds the same list). */
export const WEAK_POINT_KINDS = ['UNMOTIVATED_TURN', 'COSTLESS_PROTAGONIST', 'UNARGUED_THEME', 'UNPAID_PROMISE', 'OTHER'] as const;
export type WeakPointKind = (typeof WEAK_POINT_KINDS)[number];

/** What a citation names: an element, a fact, an open thread or a source passage. */
export const CITATION_TYPES = ['ELEMENT', 'FACT', 'THREAD', 'PASSAGE'] as const;
export type CitationType = (typeof CITATION_TYPES)[number];
/** The tag letter each type is shown under (`E3`, `F12`, `T2`, `P1`). */
export const CITATION_TAG: Readonly<Record<CitationType, string>> = { ELEMENT: 'E', FACT: 'F', THREAD: 'T', PASSAGE: 'P' };

export const STRESS_TEST_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'STOPPED', 'FAILED'] as const;
export type StressTestStatus = (typeof STRESS_TEST_STATUSES)[number];

/**
 * How a stress test ended (the migration's CHECK holds the same list):
 *
 *   OK                weak points found (at least one survived validation)
 *   NONE_FOUND        the call answered and no weak point survived: the canon WAS read, nothing is claimed of it
 *   NOT_ASSESSED      the book holds nothing to read (no element): rule 6, never "no weak points"
 *   CEILING, KILL_SWITCH, AI_UNAVAILABLE, NOT_EVALUATED, MODEL_RATE_LIMITED, ESTIMATE_CHANGED, CALL_OVER_BUDGET,
 *   ABORTED, CLAIM_EXPIRED   stopped before or during the call, nothing claimed; the author may run it again
 *   CALL_FAILED, GUARD_REFUSED  the call itself failed or the guard refused it
 *   BOOK_DELETED, NO_ACTOR    nothing to run for
 *   INTERNAL          a defect
 */
export const STRESS_TEST_OUTCOMES = [
    'OK',
    'NONE_FOUND',
    'NOT_ASSESSED',
    'CEILING',
    'KILL_SWITCH',
    'AI_UNAVAILABLE',
    'NOT_EVALUATED',
    'MODEL_RATE_LIMITED',
    'ESTIMATE_CHANGED',
    'CALL_OVER_BUDGET',
    'ABORTED',
    'CLAIM_EXPIRED',
    'CALL_FAILED',
    'GUARD_REFUSED',
    'BOOK_DELETED',
    'NO_ACTOR',
    'ENQUEUE_FAILED',
    'INTERNAL',
] as const;
export type StressTestOutcome = (typeof STRESS_TEST_OUTCOMES)[number];

/** Weak points one pass keeps at most; questions per weak point; citations per weak point. */
export const WEAK_POINTS_MAX = 8;
export const QUESTIONS_PER_WEAK_POINT_MAX = 3;
export const CITES_PER_WEAK_POINT_MAX = 8;
/** A weak point's label (one line, never a sentence) and a question, stored bounds. */
export const WEAK_POINT_TITLE_MAX = 100;
export const WEAK_POINT_QUESTION_MAX = 280;
/** A quoted run inside a question longer than this many words must be a quote of the material shown (no rewrite). */
export const QUOTED_RUN_WORDS_MAX = 5;

/** The input's bounds: elements, facts, open threads, beats in the story order and passages shown at most. */
export const STRESS_ELEMENTS_MAX = 80;
export const STRESS_FACTS_MAX = 60;
export const STRESS_THREADS_MAX = 30;
export const STRESS_PASSAGES_MAX = 6;
export const STRESS_SUMMARY_SHOWN_MAX_CHARS = 400;
/** The whole input's character budget (every block), before the per-call cost budget halves it. */
export const STRESS_INPUT_CHAR_BUDGET = 40_000;
/** The smallest budget a call is cut to before it is refused CALL_OVER_BUDGET. */
export const STRESS_INPUT_CHAR_BUDGET_MIN = 5_000;

/** A RUNNING stress test with no sign of life for this long reads STOPPED CLAIM_EXPIRED. */
export const STALE_STRESS_TEST_MS = 20 * 60_000;
/** Stress tests a book's page lists at most. */
export const STRESS_TESTS_LISTED_MAX = 20;
/** Elements a session started from a stress test asks about at most (the selection's bound). */
export const STRESS_SESSION_ELEMENTS_MAX = 12;

/** Refusal codes of the validation (counted on the run, never rows). */
export const WEAK_POINT_REFUSALS = [
    'INVALID_ITEM',
    'OVER_LIMIT',
    'TITLE_EMPTY',
    'TITLE_A_SENTENCE',
    'NO_QUESTION',
    'INVENTS_NAME',
    'NOT_A_QUESTION',
    'REWRITES_TEXT',
    'NO_CITATION',
    'UNKNOWN_CITATION',
    'COPIES_INJECTED',
    'DUPLICATE',
    'CITATION_GONE',
] as const;
export type WeakPointRefusal = (typeof WEAK_POINT_REFUSALS)[number];

/** Is this stress test still being worked on (a QUEUED or RUNNING row)? */
export function isLiveStressTest(status: string): boolean {
    return status === 'QUEUED' || status === 'RUNNING';
}
