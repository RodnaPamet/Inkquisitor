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
    /**
     * The entry's text tripped the guard: it yields no fact. Since 4.H-a (#60 item 2) only the refused PIECE yields
     * nothing; the run goes on with the others, and a version every one of whose calls was refused ends DONE with this
     * outcome, so it is the entry's baseline and the refused text is sent again only once it changes.
     */
    'GUARD_REFUSED',
    /** The entry repeats a sentence of the prompt, so no request can carry it (2.1 refuses it): as GUARD_REFUSED. */
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
    /**
     * 4.H-b (D32): a BACKFILL extraction stopped at the workspace's daily share of its monthly ceiling (10 %, measured
     * from the ledger by the backfill's purpose): resumable, no attempt counted; the backfill job queues it again
     * once the day has room.
     */
    'DAILY_SHARE',
    /**
     * 4.H-b (D32, owner decision 2026-11-27): a BACKFILL extraction stopped at the backfill's share of the workspace's
     * CALENDAR MONTH (`BACKFILL_MONTHLY_SHARE`, 50 % of the monthly ceiling, UTC month, by the backfill's purpose):
     * resumable, no attempt counted; the backfill queues it again next month.
     */
    'MONTHLY_SHARE',
] as const;
export type FactExtractionOutcome = (typeof FACT_EXTRACTION_OUTCOMES)[number];

/** 4.H-b (D31, D32): where an extraction row came from: a save's outbox trigger, or the backfill of an entry saved before 4.1. */
export const FACT_EXTRACTION_ORIGINS = ['SAVE', 'BACKFILL'] as const;
export type FactExtractionOrigin = (typeof FACT_EXTRACTION_ORIGINS)[number];

/**
 * 4.H-b (D32): a section the guard refused, by its key (a field key, `summary`, `note`: product words, never author
 * text), and the guard rule version (`GUARD_RULES_VERSION`) that refused it. Carried forward from baseline to
 * baseline while the section is unchanged; once the guard's version is newer, the section is sent again ONCE.
 */
export interface GuardRefusedSection {
    readonly key: string;
    readonly rulesVersion: number;
}

/** A row's `guardRefused` as stored, read defensively (anything malformed is dropped: it can only re-send less). */
export function readGuardRefused(raw: unknown): GuardRefusedSection[] {
    if (!Array.isArray(raw)) return [];
    const out: GuardRefusedSection[] = [];
    for (const item of raw.slice(0, GUARD_REFUSED_SECTIONS_MAX)) {
        const key = (item as { key?: unknown } | null)?.key;
        const rulesVersion = (item as { rulesVersion?: unknown } | null)?.rulesVersion;
        if (typeof key === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(key) && typeof rulesVersion === 'number' && Number.isInteger(rulesVersion) && rulesVersion >= 1) out.push({ key, rulesVersion });
    }
    return out;
}

/** Sections a row records as refused at most (an entry's template holds far fewer). */
export const GUARD_REFUSED_SECTIONS_MAX = 200;

/** The outcomes after which the row is STOPPED and dispatched again later (the rest end it). */
export const RESUMABLE_EXTRACTION_OUTCOMES: ReadonlySet<FactExtractionOutcome> = new Set(['CEILING', 'KILL_SWITCH', 'AI_UNAVAILABLE', 'NOT_EVALUATED', 'MODEL_RATE_LIMITED', 'CALL_FAILED', 'ABORTED', 'CLAIM_EXPIRED', 'INTERNAL', 'DAILY_SHARE', 'MONTHLY_SHARE']);

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

/**
 * THE BACKFILL OF BIBLES SAVED BEFORE 4.1 (4.H-b; D31, D32). Each workspace's backfill spends at most this share of
 * its monthly ceiling a DAY (owner decision 2026-11-27, D32): measured from the ledger — the calls of
 * `facts.bible-extract.backfill` charged in the last `BACKFILL_DAY_WINDOW_MS` plus their live reservations — before
 * each call and again by the ledger under its spend lock. It stands beside the nightly continuity check's own 10 %
 * (D28 addendum), measured apart by purpose; the monthly ceiling stays the hard bound over both and every other call.
 */
export const BACKFILL_DAILY_SHARE = 0.1;
/**
 * Besides its daily share, the backfill spends at most this share of a workspace's monthly ceiling in a CALENDAR
 * MONTH (UTC; owner decision 2026-11-27, D32), measured from the ledger by its purpose (calls charged since the
 * month began plus live reservations) before queuing, before each call and by the ledger under its spend lock. Past
 * it rows stop MONTHLY_SHARE, resumable, and the backfill resumes next month: ten days of the daily share cannot
 * take a whole month's ceiling.
 */
export const BACKFILL_MONTHLY_SHARE = 0.5;
/** The day the backfill's share is measured over: the last 24 hours, rolling. */
export const BACKFILL_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Entries the backfill gives an outbox row at most a tick, per workspace (it queues no more than it can dispatch). */
export const BACKFILL_ENTRIES_PER_WORKSPACE_TICK = 20;
/** Backfill extractions queued at most a tick, across workspaces. */
export const BACKFILL_DISPATCH_MAX = 200;
/** Workspaces the backfill serves at most a tick (from its cursor, round-robin: every workspace within a bounded number of ticks). */
export const BACKFILL_WORKSPACES_PER_TICK = 50;
/** Embedding tasks the dispatcher works at most a tick, across workspaces. */
export const DISPATCH_EMBEDDINGS_MAX = 256;
/** An embedding task that failed this many times is dropped (logged): its row is re-marked by its next change. */
export const EMBEDDING_TASK_ATTEMPTS_MAX = 5;

export const FACT_PROPOSAL_REASONS = ['CONTRADICTED', 'NO_LONGER_STATED'] as const;
export type FactProposalReason = (typeof FACT_PROPOSAL_REASONS)[number];
/** Phase 4.2 adds DEEP: the nightly deep continuity check (D28). */
export const FACT_PROPOSAL_BASES = ['RULE', 'MODEL', 'TEXT', 'DEEP'] as const;
export type FactProposalBasis = (typeof FACT_PROPOSAL_BASES)[number];
/** Phase 4.2 adds INVALIDATED_NEWER: the author kept the older fact (D28). */
export const FACT_PROPOSAL_STATUSES = ['PENDING', 'INVALIDATED', 'INVALIDATED_NEWER', 'KEPT', 'REJECTED'] as const;
export type FactProposalStatus = (typeof FACT_PROPOSAL_STATUSES)[number];

/**
 * The author's answers to a proposal (D27): invalidate the older fact, keep both, or reject the proposal; and since
 * Phase 4.2 (D28), for a contradiction, invalidate the NEWER one (the author picks the older). Keeping both of a
 * contradiction takes the author's explanation, which becomes a fact.
 */
export const FACT_PROPOSAL_DECISIONS = ['INVALIDATE', 'INVALIDATE_NEWER', 'KEEP_BOTH', 'REJECT'] as const;
export type FactProposalDecision = (typeof FACT_PROPOSAL_DECISIONS)[number];
export const STATUS_OF_DECISION: Readonly<Record<FactProposalDecision, Exclude<FactProposalStatus, 'PENDING'>>> = Object.freeze({ INVALIDATE: 'INVALIDATED', INVALIDATE_NEWER: 'INVALIDATED_NEWER', KEEP_BOTH: 'KEPT', REJECT: 'REJECTED' });

/** A book's pending proposals the Facts page reads at most (a cut is said). */
export const FACT_PROPOSALS_PER_VIEW_MAX = 100;
