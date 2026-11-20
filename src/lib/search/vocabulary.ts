/**
 * Word search's bounds, weights and wire shapes (Phase 3.4, decision D21).
 * Client-safe: no imports but types, so the search box can share the bounds
 * and the response type.
 *
 * Every bound is a constant here, and every one is stated in the response
 * when it cut something: `truncated` when more elements matched than are
 * returned, `coverage` when the book held more than one search reads.
 */

/** A query, trimmed, at most this many characters (`QUERY_TOO_LONG`). */
export const SEARCH_QUERY_MAX_CHARS = 200;
/** The raw request member, before trimming: refused unread past this (a length check, never a parse). */
export const SEARCH_QUERY_RAW_MAX_CHARS = SEARCH_QUERY_MAX_CHARS * 4;
/** Words in a query at most, quoted and unquoted together (`QUERY_TOO_MANY_TERMS`). */
export const SEARCH_QUERY_MAX_WORDS = 12;
/** Quoted phrases in a query at most (`QUERY_TOO_MANY_PHRASES`). */
export const SEARCH_QUERY_MAX_PHRASES = 4;

/** Elements one search reads at most, by name; past it the coverage says so. */
export const SEARCH_ELEMENTS_MAX = 2_000;
/** Relations (their notes) one search reads at most; past it the coverage says so. */
export const SEARCH_RELATIONS_MAX = 10_000;
/** Stored fields read per element (every template has fewer). */
export const SEARCH_FIELDS_PER_ELEMENT = 50;
/** Elements whose fields are read (and decrypted) per query, so a large book is never held whole. */
export const SEARCH_FIELD_READ_CHUNK = 250;
/**
 * Plain-text characters one search analyses at most. A book of the load test's
 * size holds a few megabytes; the stored bounds would allow far more, so past
 * this the elements not yet read are left out and the coverage says so.
 */
export const SEARCH_TEXT_MAX_CHARS = 8_000_000;

/** Elements (and the book itself) returned at most; `truncated` says when more matched. */
export const SEARCH_RESULTS_MAX = 50;
/** Matched sources returned per result, best first; `matchedSourceCount` says how many matched. */
export const SEARCH_MATCHES_PER_RESULT = 3;
/** A snippet's length, at most (a whole short source is its own snippet). */
export const SNIPPET_MAX_CHARS = 180;
/** Characters of context kept before the first highlighted word. */
export const SNIPPET_LEAD_CHARS = 50;

/**
 * BM25F (`rank.ts`). Each source class has a weight (a name match beats a
 * summary, which beats field text) and a length normalisation `b` (short,
 * name-like sources barely normalised).
 */
export const BM25_K1 = 1.2;
export const SOURCE_WEIGHTS = {
    title: 3,
    name: 3,
    label: 2.5,
    summary: 1.5,
    logline: 1.5,
    field: 1,
    relationNote: 0.8,
} as const satisfies Record<SearchSourceKind, number>;
export const SOURCE_LENGTH_NORMALISATION = {
    title: 0.3,
    name: 0.3,
    label: 0.3,
    summary: 0.75,
    logline: 0.75,
    field: 0.75,
    relationNote: 0.75,
} as const satisfies Record<SearchSourceKind, number>;
/** How much one matching word counts: an exact-case match of a capitalised query word, a surface match, a match by stem alone. */
export const MATCH_WEIGHTS = { exactCase: 1.3, surface: 1, stem: 0.6 } as const;
/** A quoted phrase's own signal, beside its words. */
export const PHRASE_BOOST = 1.5;

export const SEARCH_SOURCE_KINDS = ['title', 'logline', 'name', 'label', 'summary', 'field', 'relationNote'] as const;
export type SearchSourceKind = (typeof SEARCH_SOURCE_KINDS)[number];

/** Why a query is refused (400, `details.reason`). */
export const SEARCH_QUERY_REFUSALS = ['QUERY_TOO_LONG', 'QUERY_TOO_MANY_TERMS', 'QUERY_TOO_MANY_PHRASES'] as const;
export type SearchQueryRefusal = (typeof SEARCH_QUERY_REFUSALS)[number];

/** Why a search read less than the whole book. */
export type SearchCoverageCut = 'ELEMENTS_CAP' | 'RELATIONS_CAP' | 'TEXT_BUDGET';

export interface SearchHighlight {
    /** Offsets into `snippet.text`; add `snippet.start` for offsets into the source's plain text. */
    start: number;
    end: number;
}

export interface SearchSnippet {
    /** Plain text, never HTML: render it as text. */
    text: string;
    /** Where `text` begins in the source's plain text. */
    start: number;
    /** Text precedes / follows the snippet in the source. */
    cutBefore: boolean;
    cutAfter: boolean;
    highlights: SearchHighlight[];
}

export interface SearchMatchView {
    source: SearchSourceKind;
    /** A template field's key and label (`source` = `field`). */
    fieldKey: string | null;
    fieldLabel: string | null;
    /** The element at the relation's other end (`source` = `relationNote`). */
    otherElementName: string | null;
    snippet: SearchSnippet;
}

export interface SearchHitView {
    kind: 'book' | 'element';
    /** Null for the book itself. */
    elementId: string | null;
    elementKind: string | null;
    /** The element's name, or the book's title. */
    name: string;
    customLabel: string | null;
    matches: SearchMatchView[];
    /** How many of the result's sources matched (the matches shown are the best of them). */
    matchedSourceCount: number;
}

export interface SearchCoverageView {
    /** The book's elements, and how many the search read. */
    elements: number;
    searchedElements: number;
    complete: boolean;
    /** Why it is not complete; null when it is. */
    cut: SearchCoverageCut | null;
}

export interface BookSearchView {
    /** The query held no word to search for (only punctuation or spaces): nothing was searched. */
    emptyQuery: boolean;
    hits: SearchHitView[];
    /** Elements (and the book) that matched; more than `hits` when `truncated`. */
    totalHits: number;
    truncated: boolean;
    coverage: SearchCoverageView;
    /** The analysis the terms came from: `en` stems, `other` matches surface forms (D12). */
    language: 'en' | 'other';
    analyzerVersion: string;
}
