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
 * Stored (encrypted) bytes of fields read per query, at most: a chunk ends
 * before the element that would take it past this, so one query never holds
 * more than this many bytes of ciphertext, and the plain text they decrypt to,
 * at once (one element alone may pass it). Without it a chunk of 250 elements
 * of six 100,000-character rich-text fields each was some 150 million
 * characters held by one request before the text budget was asked.
 */
export const SEARCH_FIELD_READ_BYTES = 8 * 1024 * 1024;
/**
 * Plain-text characters one search analyses at most. A book of the load test's
 * size holds a few megabytes; the stored bounds would allow far more, so past
 * this the elements not yet read are left out and the coverage says so.
 */
export const SEARCH_TEXT_MAX_CHARS = 8_000_000;

/**
 * Scenes one search reads at most (Phase 5.H-a, D33 addendum A: word search covers the manuscript's scenes as it
 * covers the bible): a manuscript holds at most 5,000 (`SCENES_PER_MANUSCRIPT_MAX`); past this the coverage says so.
 */
export const SEARCH_SCENES_MAX = 5_000;
/**
 * Stored (encrypted) bytes of scene text and notes read per query, at most, as `SEARCH_FIELD_READ_BYTES` bounds the
 * bible's fields: a chunk of scenes ends before the scene that would pass it (one scene alone may pass it).
 */
export const SEARCH_SCENE_READ_BYTES = 8 * 1024 * 1024;
/**
 * Plain-text characters of scenes one search analyses at most, a budget of its own beside the bible's, so a large
 * bible never starves the manuscript of being searched (a 150,000-word manuscript is about 900,000 characters).
 */
export const SEARCH_SCENE_TEXT_MAX_CHARS = 8_000_000;

/** Elements, scenes (and the book itself) returned at most; `truncated` says when more matched. */
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
    relationField: 0.8,
    sceneTitle: 2.5,
    sceneText: 1,
    sceneNote: 0.8,
} as const satisfies Record<SearchSourceKind, number>;
export const SOURCE_LENGTH_NORMALISATION = {
    title: 0.3,
    name: 0.3,
    label: 0.3,
    summary: 0.75,
    logline: 0.75,
    field: 0.75,
    relationNote: 0.75,
    relationField: 0.75,
    sceneTitle: 0.3,
    sceneText: 0.75,
    sceneNote: 0.75,
} as const satisfies Record<SearchSourceKind, number>;
/** How much one matching word counts: an exact-case match of a capitalised query word, a surface match, a match by stem alone. */
export const MATCH_WEIGHTS = { exactCase: 1.3, surface: 1, stem: 0.6 } as const;
/** A quoted phrase's own signal, beside its words. */
export const PHRASE_BOOST = 1.5;

export const SEARCH_SOURCE_KINDS = ['title', 'logline', 'name', 'label', 'summary', 'field', 'relationNote', 'relationField', 'sceneTitle', 'sceneText', 'sceneNote'] as const;
export type SearchSourceKind = (typeof SEARCH_SOURCE_KINDS)[number];

/** Why a query is refused (400, `details.reason`). */
export const SEARCH_QUERY_REFUSALS = ['QUERY_TOO_LONG', 'QUERY_TOO_MANY_TERMS', 'QUERY_TOO_MANY_PHRASES'] as const;
export type SearchQueryRefusal = (typeof SEARCH_QUERY_REFUSALS)[number];

/** Why a search read less than the whole book. */
export type SearchCoverageCut = 'ELEMENTS_CAP' | 'RELATIONS_CAP' | 'TEXT_BUDGET' | 'SCENES_CAP' | 'SCENE_TEXT_BUDGET';

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
    /** A template field's key and label (`source` = `field`, or `relationField`: a field of a relation, Phase 3.3). */
    fieldKey: string | null;
    fieldLabel: string | null;
    /** The element at the relation's other end (`source` = `relationNote` or `relationField`). */
    otherElementName: string | null;
    snippet: SearchSnippet;
}

export interface SearchHitView {
    kind: 'book' | 'element' | 'scene';
    /** Null for the book itself and for a scene. */
    elementId: string | null;
    /** A manuscript scene's id (Phase 5.H-a); null otherwise. A `sceneText` snippet's `start` is an offset into the
     *  scene's plain text as the editor rebuilds it, so the result opens the editor at the match. */
    sceneId: string | null;
    /** A scene's chapter title (null: untitled, or not a scene). */
    chapterTitle: string | null;
    elementKind: string | null;
    /** The element's name, the scene's title ('' when untitled), or the book's title. */
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
    /** The manuscript's live scenes, and how many the search read (Phase 5.H-a). */
    scenes: number;
    searchedScenes: number;
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
