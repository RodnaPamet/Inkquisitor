/**
 * Continuity's words and bounds (Phase 4.2, decision D28). Client-safe: no
 * server import, so the Continuity page reads the same lists the server
 * enforces.
 *
 *   CONTRADICTIONS  two live facts that cannot both hold, PROPOSED (rule 1) by a
 *                   deterministic RULE (at extraction, or the nightly sweep) or by
 *                   the nightly DEEP check; recorded in 4.1's `StoryFactProposal`
 *                   with a KIND. The author keeps the newer, keeps the older, says
 *                   both are true and explains (the explanation becomes a fact), or
 *                   says it is not a contradiction.
 *   THREADS         the registries: a PROMISE set up for the reader (open, paid
 *                   off, dropped), a CLUE (open, revealed, dropped), an OPEN
 *                   QUESTION (open, resolved). Proposed by the bible fact
 *                   extraction, each citing a version's words; accepted or
 *                   rejected by the author; added, edited and removed by hand.
 *   STALE FLAGS     propagation debt: an entry whose accepted versions cited an
 *                   answer about an element that has since changed "may be stale".
 */

/** What cannot both hold (the migration's CHECK holds the same list). */
export const CONTRADICTION_KINDS = ['VALUE', 'WHEREABOUTS', 'KNOWLEDGE', 'TIMELINE', 'OTHER'] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

/** The author's answers to a contradiction (4.1's three, plus keeping the older fact). */
export const CONTRADICTION_DECISIONS = ['INVALIDATE', 'INVALIDATE_NEWER', 'KEEP_BOTH', 'REJECT'] as const;
export type ContradictionDecision = (typeof CONTRADICTION_DECISIONS)[number];

/** An explanation's stored bound (the fact's statement), and its raw bound. */
export const EXPLANATION_MAX = 600;

/** The registries' kinds, and each kind's states (OPEN first; the CHECK holds the same). */
export const THREAD_KINDS = ['PROMISE', 'CLUE', 'OPEN_QUESTION'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];
export const THREAD_STATES: Readonly<Record<ThreadKind, readonly string[]>> = Object.freeze({
    PROMISE: Object.freeze(['OPEN', 'PAID_OFF', 'DROPPED']),
    CLUE: Object.freeze(['OPEN', 'REVEALED', 'DROPPED']),
    OPEN_QUESTION: Object.freeze(['OPEN', 'RESOLVED']),
});
export const ALL_THREAD_STATES = ['OPEN', 'PAID_OFF', 'DROPPED', 'REVEALED', 'RESOLVED'] as const;
export type ThreadState = (typeof ALL_THREAD_STATES)[number];

/** Is `state` one of `kind`'s states? */
export function threadStateAllowed(kind: string, state: string): boolean {
    return (THREAD_STATES[kind as ThreadKind] ?? []).includes(state);
}

/** A thread's title and note, stored bounds. */
export const THREAD_TITLE_MAX = 200;
export const THREAD_NOTE_MAX = 2_000;
/** Threads a book holds at most (a hand-added one past it is refused THREADS_FULL). */
export const THREADS_PER_BOOK_MAX = 500;
/** Threads, thread proposals, contradictions and stale flags the Continuity page reads at most each (a cut is said). */
export const CONTINUITY_LIST_MAX = 100;
/** Thread candidates one bible fact call may return, and open promises it is shown (to suggest one paid off). */
export const THREADS_PER_CALL_MAX = 6;
export const OPEN_THREADS_SHOWN_MAX = 20;

export const THREAD_PROPOSAL_OPS = ['NEW_THREAD', 'SET_STATE'] as const;
export const THREAD_PROPOSAL_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;

/** Stale flags. */
export const STALE_FLAG_STATUSES = ['OPEN', 'DISMISSED', 'CLEARED'] as const;
/** Fields of the stale entry a grill session challenges at most (each once; a challenge a round). */
export const STALE_CHALLENGES_MAX = 6;
/** The change shown to a grill session's question generator, characters at most. */
export const STALE_CHANGE_MAX_CHARS = 6_000;

/** THE NIGHTLY DEEP CHECK (D28). */
export const CONTINUITY_RUN_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'STOPPED', 'SKIPPED', 'FAILED'] as const;
export type ContinuityRunStatus = (typeof CONTINUITY_RUN_STATUSES)[number];

/** How a night's run ended or paused (the migration's CHECK holds the same list). */
export const CONTINUITY_OUTCOMES = [
    /** The pass completed: every live fact up to its target has been checked. */
    'OK',
    /** The night's bound was reached with subjects left: the pass goes on tomorrow from its cursor. Not a failure. */
    'PAGED',
    /** The book holds no live fact (rule 6: nothing was checked, so nothing is reported clean). */
    'NO_FACTS',
    /** Nothing changed since the last complete pass. */
    'NOTHING_NEW',
    'BOOK_DELETED',
    /** No member may edit the bible (no call is made on nobody's behalf). */
    'NO_ACTOR',
    /** The workspace's monthly ceiling (D10): resumable, never a failure (the D27 addendum's rule). */
    'CEILING',
    /** `AI_DISABLED=1`: resumable. */
    'KILL_SWITCH',
    /** No model call can be made in this deployment: resumable. */
    'AI_UNAVAILABLE',
    /** No evaluation record this deployment accepts (D11): the rules still ran; the deep step waits. */
    'NOT_EVALUATED',
    /** The workspace's model-call minute stayed full (D17): resumable. */
    'MODEL_RATE_LIMITED',
    /** A call failed: resumable from the cursor. */
    'CALL_FAILED',
    /** The facts (or the answer about them) tripped the guard: the night stops, and the pass resumes past that page tomorrow. */
    'GUARD_REFUSED',
    /** Even the smallest call (one subject's facts, cut) is past the per-call budget: resumable once a cheaper model is configured. */
    'CALL_OVER_BUDGET',
    /** The worker shut down mid-run: resumable. */
    'ABORTED',
    /** A claim whose worker died: resumable. */
    'CLAIM_EXPIRED',
    'INTERNAL',
] as const;
export type ContinuityOutcome = (typeof CONTINUITY_OUTCOMES)[number];

/** Outcomes that stop a run resumably and count as no failure (the ceiling, the switch, the deployment). */
export const UNCOUNTED_CONTINUITY_STOPS: ReadonlySet<ContinuityOutcome> = new Set(['CEILING', 'KILL_SWITCH', 'AI_UNAVAILABLE', 'NOT_EVALUATED']);

/**
 * ONE NIGHT'S BOUND, per book (D28): at most `CONTINUITY_CALLS_PER_NIGHT` deep calls, each over at most
 * `CONTINUITY_FACTS_PER_CALL_MAX` facts and inside the per-call cost budget (`prompt.ts`). Subjects are taken in a
 * stable order (kind, then name, then id) from the pass's cursor, whole where they fit; a subject with more facts
 * than one call holds is cut into calls of its own. So a night covers about two hundred facts of a book, a
 * thousand-fact book's first pass takes about five nights, and every pass after it covers only what changed.
 * Justified in the 4.2 note: at the deep tier's rates the worst case of a night is at most $1.50 a changed book (two calls at the per-call budget),
 * the typical case a tenth of that, inside the $50 monthly ceiling (D10).
 */
export const CONTINUITY_CALLS_PER_NIGHT = 2;
export const CONTINUITY_FACTS_PER_CALL_MAX = 100;
/** The fewest facts a call is cut down to (to fit its budget) before the run stops CALL_OVER_BUDGET. */
export const CONTINUITY_FACTS_PER_CALL_MIN = 10;
/** A book's live facts the nightly run reads at most (the rule sweep and the pass's subject list; a cut is counted). */
export const CONTINUITY_FACTS_READ_MAX = 4_000;
/**
 * Contradictions one night's rule sweep proposes at most for a book. The rules re-read the whole book every night and
 * skip every pair already proposed, so what is past the bound is proposed on the nights that follow; without it, one
 * subject with a few hundred whereabouts and no story time (unknown overlaps everything) made tens of thousands of
 * pairs, whose writes ran past the transaction's timeout and failed the run every night.
 */
export const CONTINUITY_PROPOSALS_PER_RUN_MAX = 1_000;
/** Books the nightly dispatcher queues at most a night, across workspaces (fair-shared). */
export const CONTINUITY_DISPATCH_MAX = 500;
/** A QUEUED or RUNNING run with no sign of life for this long was lost: the next night queues the book again. */
export const STALE_CONTINUITY_RUN_MS = 6 * 60 * 60 * 1000;

/** The kinds of fact the continuity check reads (4.1's bible kinds, the author's explanations, confirmed book-library source facts). */
export const CONTINUITY_FACT_KINDS = ['BIBLE_VERSION', 'RELATION_VERSION', 'AUTHOR_RESOLUTION', 'SOURCE_CHUNK'] as const;

/** Placed elements the story clock reads at most (D25); past it no fact gets a position and the stated times decide. */
export const CLOCK_ELEMENTS_MAX = 2_000;
