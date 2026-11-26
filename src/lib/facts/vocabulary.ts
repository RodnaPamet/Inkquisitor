/**
 * The fact layer's words and bounds (Phase 4.1, decision D27). Client-safe: no
 * server import, so the Facts page reads the same lists the server enforces.
 *
 * Bible facts are drawn from ACCEPTED versions (an element's or a relation's)
 * and count at once; a live fact is never retired silently — an older fact a
 * newer one contradicts, or one its entry no longer states, is PROPOSED for
 * invalidation and stays live until the author decides.
 */

/** The vector store's source models the fact layer adds (subphase 2.0's `sourceModel`). */
export const BIBLE_ELEMENT_MODEL = 'BibleElement';
export const STORY_FACT_MODEL = 'StoryFact';
export const ANSWER_MODEL = 'Answer';
export const EMBEDDING_TASK_MODELS = [BIBLE_ELEMENT_MODEL, STORY_FACT_MODEL, ANSWER_MODEL] as const;
export type EmbeddingTaskModel = (typeof EMBEDDING_TASK_MODELS)[number];

export const FACT_EXTRACTION_KINDS = ['BIBLE_VERSION', 'RELATION_VERSION'] as const;
export type FactExtractionKind = (typeof FACT_EXTRACTION_KINDS)[number];

export const FACT_EXTRACTION_STATUSES = ['PENDING', 'QUEUED', 'RUNNING', 'DONE', 'SKIPPED', 'STOPPED', 'FAILED'] as const;
export type FactExtractionStatus = (typeof FACT_EXTRACTION_STATUSES)[number];

/** How an extraction ended or paused (the migration's CHECK holds the same list). */
export const FACT_EXTRACTION_OUTCOMES = [
    /** The version's facts extracted and resolved. */
    'OK',
    /** Nothing fact-bearing changed since the element's last extracted version (a reorder, a status): no call. */
    'NO_CHANGE',
    /** A newer version of the same element or relation exists: its extraction covers this one. No call. */
    'SUPERSEDED',
    /** The element or relation is gone. */
    'SUBJECT_GONE',
    /** The book is deleted (soft). */
    'BOOK_DELETED',
    /** The version's author left the workspace or may no longer edit the bible: no call is made on their behalf. */
    'AUTHOR_NOT_PERMITTED',
    /** The workspace's monthly ceiling (D10): resumable. */
    'CEILING',
    /** `AI_DISABLED=1`: resumable. */
    'KILL_SWITCH',
    /** No model call can be made in this deployment: resumable. */
    'AI_UNAVAILABLE',
    /** The prompt has no evaluation record this deployment accepts (D11): resumable once one is committed. */
    'NOT_EVALUATED',
    /** The workspace's model-call minute stayed full (D17): resumable. */
    'MODEL_RATE_LIMITED',
    /** The entry's text tripped the guard: it yields no fact. Final. */
    'GUARD_REFUSED',
    /** The entry repeats a sentence of the prompt, so no request can carry it (2.1 refuses it): it yields no fact. Final. */
    'REPEATS_PROMPT',
    /** The call failed (a timeout, the provider, an invalid answer): resumable. */
    'CALL_FAILED',
    /** The worker shut down mid-run: resumable. */
    'ABORTED',
    /** A claim whose worker died: resumable. */
    'CLAIM_EXPIRED',
    /** Resumed `FACT_EXTRACTION_ATTEMPTS_MAX` times without finishing. Final. */
    'ATTEMPTS_SPENT',
    /**
     * Even the smallest call the version could be sent in (its shortest piece, no book names, no existing facts) has
     * a worst case past the per-call cost budget (rule 9, enforced since the D27 addendum): nothing is sent. Final for
     * this version (a dearer fast-tier model configured); the entry's next version is tried afresh.
     */
    'CALL_OVER_BUDGET',
    'INTERNAL',
] as const;
export type FactExtractionOutcome = (typeof FACT_EXTRACTION_OUTCOMES)[number];

/** The outcomes after which the row is STOPPED and dispatched again later (the rest end it). */
export const RESUMABLE_EXTRACTION_OUTCOMES: ReadonlySet<FactExtractionOutcome> = new Set(['CEILING', 'KILL_SWITCH', 'AI_UNAVAILABLE', 'NOT_EVALUATED', 'MODEL_RATE_LIMITED', 'CALL_FAILED', 'ABORTED', 'CLAIM_EXPIRED', 'INTERNAL']);

/** A version settles this long before it is dispatched: a run of autosaves is extracted once, at its newest version. */
export const FACT_EXTRACTION_SETTLE_MS = 20_000;
/** A STOPPED extraction is dispatched again no earlier than this after it stopped. */
export const FACT_EXTRACTION_RETRY_MS = 60 * 60 * 1000;
/** A QUEUED or RUNNING extraction with no sign of life for this long was lost (its job or its worker): dispatched again. */
export const STALE_EXTRACTION_MS = 30 * 60 * 1000;
/** An extraction resumed this many times ends ATTEMPTS_SPENT. */
export const FACT_EXTRACTION_ATTEMPTS_MAX = 12;
/**
 * ONE CALL'S INPUT (owner decision, 2026-11-21): a version's changed sections are sent in batches of at most this
 * many characters of section text, a longer section cut into pieces (`pieceSections`). 20,000 characters is about
 * 5,000 tokens of English (`CHARS_PER_TOKEN`), several pages: room for any summary or field an author writes by hand
 * in one call, while a pasted chapter (rich text holds up to 100,000) is split. It is also what the per-call budget
 * takes: 2.1's worst case counts every UTF-8 byte as a token and adds the one repair (the request again, the answer
 * and the repair turn), so on the default fast model a 20,000-character Latin piece with the prompt, a dozen existing
 * facts and the book's names stays well inside `BIBLE_FACTS_CALL_COST_BUDGET_MICRO_USD`; a piece that does not (a
 * script of three bytes a character, a long list of existing facts) is halved again before anything is dropped.
 */
export const BIBLE_FACT_PIECE_MAX_CHARS = 20_000;
/** A piece is never halved below this; past it the call drops the book's names, then the existing facts shown. */
export const BIBLE_FACT_PIECE_MIN_CHARS = 2_000;

/** Extractions the dispatcher queues at most a tick, across workspaces. */
export const DISPATCH_EXTRACTIONS_MAX = 200;
/** Embedding tasks the dispatcher works at most a tick, across workspaces. */
export const DISPATCH_EMBEDDINGS_MAX = 256;
/** An embedding task that failed this many times is dropped (logged): its row is re-marked by its next change. */
export const EMBEDDING_TASK_ATTEMPTS_MAX = 5;

export const FACT_PROPOSAL_REASONS = ['CONTRADICTED', 'NO_LONGER_STATED'] as const;
export type FactProposalReason = (typeof FACT_PROPOSAL_REASONS)[number];
export const FACT_PROPOSAL_BASES = ['RULE', 'MODEL', 'TEXT'] as const;
export type FactProposalBasis = (typeof FACT_PROPOSAL_BASES)[number];
export const FACT_PROPOSAL_STATUSES = ['PENDING', 'INVALIDATED', 'KEPT', 'REJECTED'] as const;
export type FactProposalStatus = (typeof FACT_PROPOSAL_STATUSES)[number];

/** The author's three answers to a proposal (D27): invalidate the older fact, keep both, or reject the proposal. */
export const FACT_PROPOSAL_DECISIONS = ['INVALIDATE', 'KEEP_BOTH', 'REJECT'] as const;
export type FactProposalDecision = (typeof FACT_PROPOSAL_DECISIONS)[number];
export const STATUS_OF_DECISION: Readonly<Record<FactProposalDecision, Exclude<FactProposalStatus, 'PENDING'>>> = Object.freeze({ INVALIDATE: 'INVALIDATED', KEEP_BOTH: 'KEPT', REJECT: 'REJECTED' });

/** A book's pending proposals the Facts page reads at most (a cut is said). */
export const FACT_PROPOSALS_PER_VIEW_MAX = 100;
