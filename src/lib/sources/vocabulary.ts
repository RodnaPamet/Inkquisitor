/**
 * The source library's words and bounds (Phase 4.0, decisions D23 and D26).
 * Client-safe: no server import, so the Sources and Facts pages read the same
 * lists the server enforces.
 *
 * THE PREDICATE → FIELD TABLE (`PREDICATE_FIELDS`) is the ONLY way a confirmed
 * fact answers a template field (rule 5). It is explicit and conservative: a
 * predicate maps to a field only where the fact, stated about an element of
 * that kind, plainly IS that field's answer (a character's want, a setting's
 * kind of place). A trait does not answer a whole list of traits, a backstory
 * sentence does not answer a wound, and anything unlisted answers nothing: it
 * is still shown, quoted, as context. Widening the table is a reviewed change.
 */

/** The vector store's source model for a chunk (subphase 2.0's `sourceModel`). */
export const SOURCE_CHUNK_MODEL = 'SourceChunk';

/** The upload's size bound (D26): 20 MB a file. */
export const SOURCE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** Files a library holds at most (D26): 50. Superseded versions count until removed. */
export const SOURCES_PER_LIBRARY_MAX = 50;

/** The formats a source may be (D26). No OCR: a PDF without a text layer is refused. */
export const SOURCE_FORMATS = ['DOCX', 'MARKDOWN', 'TXT', 'EPUB', 'PDF'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export const SOURCE_STATUSES = ['ESTIMATED', 'QUEUED', 'RUNNING', 'STOPPED', 'DONE', 'FAILED'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Characters a token is estimated at (English prose). */
export const CHARS_PER_TOKEN = 4;
/** A chunk is cut at a chapter or scene once it holds this many tokens… */
export const CHUNK_MIN_TOKENS = 1_000;
/** …and always before it passes this many. */
export const CHUNK_MAX_TOKENS = 2_000;
/** Chunks a source may make (about three million tokens): past it the upload is refused SOURCE_TOO_LONG. */
export const CHUNKS_PER_SOURCE_MAX = 1_500;
/** Extracted characters a source may hold before it is chunked (refused SOURCE_TOO_LONG past it). */
export const SOURCE_TEXT_MAX_CHARS = CHUNKS_PER_SOURCE_MAX * CHUNK_MAX_TOKENS * CHARS_PER_TOKEN;

/** How an ingestion ended or paused. */
export const SOURCE_OUTCOMES = [
    /** Every chunk's facts extracted. */
    'OK',
    /** Some chunks' calls failed (a timeout, the provider, an invalid answer): resumable, the rest kept. */
    'PARTIAL',
    /** The workspace's monthly ceiling (D10) would be passed by the next chunk. */
    'CEILING',
    /** `AI_DISABLED=1`. */
    'KILL_SWITCH',
    /** The spend the author confirmed would be passed by the next chunk. */
    'BUDGET',
    /** No model call can be made in this deployment. */
    'AI_UNAVAILABLE',
    /** The extraction prompt has no evaluation record this deployment accepts (D11). */
    'NOT_EVALUATED',
    /** The person who started it may no longer edit the bible. */
    'REQUESTER_NOT_PERMITTED',
    /** A run claimed and never finished (the worker died): resumable. */
    'CLAIM_EXPIRED',
    /** Stopped from outside (the worker shut down). */
    'ABORTED',
    /** The job never reached the queue. */
    'ENQUEUE_FAILED',
    'INTERNAL',
] as const;
export type SourceOutcome = (typeof SOURCE_OUTCOMES)[number];

/** A QUEUED or RUNNING source whose heartbeat is older than this reads STOPPED CLAIM_EXPIRED (its worker is gone). */
export const STALE_INGEST_MS = 30 * 60 * 1000;

/** What a fact may state (the closed list the extraction's output schema offers). */
export const FACT_PREDICATES = [
    'ROLE',
    'WANT',
    'APPEARANCE',
    'TRAIT',
    'ABILITY',
    'BACKSTORY',
    'RELATIONSHIP',
    'LOCATION',
    'OCCUPATION',
    'POSSESSION',
    'AGE',
    'KNOWLEDGE',
    'EVENT',
    'PLACE_TYPE',
    'PURPOSE',
    'MEMBERSHIP',
    'POWER_BASE',
    'RULE',
    'OTHER',
] as const;
export type FactPredicate = (typeof FACT_PREDICATES)[number];

/** THE predicate → field table (the header). Kind → predicate → template key. */
export const PREDICATE_FIELDS: Readonly<Partial<Record<string, Readonly<Partial<Record<FactPredicate, string>>>>>> = Object.freeze({
    CHARACTER: Object.freeze({ ROLE: 'role', WANT: 'want', APPEARANCE: 'physical_presence' }),
    SETTING: Object.freeze({ PLACE_TYPE: 'place_type' }),
    FACTION: Object.freeze({ PURPOSE: 'purpose', MEMBERSHIP: 'membership', POWER_BASE: 'power_base' }),
});

/** The field a confirmed fact with this predicate answers on an element of this kind, or null. */
export function fieldAnsweredBy(kind: string, predicate: string): string | null {
    return PREDICATE_FIELDS[kind]?.[predicate as FactPredicate] ?? null;
}

export const FACT_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** What a fact is flagged for (D14 applied to facts). */
export const FACT_FLAGS = ['POSSIBLE_INSTRUCTION'] as const;
export type FactFlag = (typeof FACT_FLAGS)[number];

/** The Facts page reads at most this many facts a view (and so a bulk confirm names at most this many). */
export const FACTS_PER_VIEW_MAX = 100;
/** A view token is honoured this long. */
export const VIEW_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
/** An override's stored bound. */
export const OVERRIDE_TEXT_MAX = 2_000;

/** Why an upload is refused (each a `details.reason`; `sources.reasons` words them). */
export const SOURCE_REFUSALS = [
    'SOURCE_TYPE',
    'SOURCE_NO_TEXT_LAYER',
    'SOURCE_ENCRYPTED',
    'SOURCE_EMPTY',
    'SOURCE_NOT_TEXT',
    'SOURCE_ARCHIVE_REFUSED',
    'SOURCE_XML_REFUSED',
    'SOURCE_PARSE_FAILED',
    'SOURCE_PARSE_TIMEOUT',
    'SOURCE_TOO_LONG',
    'SOURCE_DUPLICATE',
    'LIBRARY_FULL',
    'UPLOAD_INFECTED',
    'SCAN_UNAVAILABLE',
] as const;
export type SourceRefusalReason = (typeof SOURCE_REFUSALS)[number];

/** Is a status one the job may still be working on? */
export function isLiveStatus(status: string): boolean {
    return status === 'QUEUED' || status === 'RUNNING';
}

/**
 * A source as it effectively stands: a RUNNING or QUEUED row whose last sign of life (`heartbeatAt`: queued,
 * claimed, or a step taken) is older than `STALE_INGEST_MS` reads STOPPED CLAIM_EXPIRED. Never the upload
 * time: a source uploaded an hour before its ingestion was confirmed is not stale, and neither is a long
 * ingestion that is still moving.
 */
export function effectiveSourceState(
    row: { status: string; outcome: string | null; heartbeatAt?: Date | string | null; startedAt: Date | string | null; createdAt: Date | string },
    now: Date = new Date(),
): { status: SourceStatus; outcome: string | null } {
    if (isLiveStatus(row.status)) {
        const since = new Date(row.heartbeatAt ?? row.startedAt ?? row.createdAt).getTime();
        if (now.getTime() - since > STALE_INGEST_MS) return { status: 'STOPPED', outcome: 'CLAIM_EXPIRED' };
    }
    return { status: row.status as SourceStatus, outcome: row.outcome };
}
