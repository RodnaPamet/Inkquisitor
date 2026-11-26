/**
 * The vector store's bounds and its search path, in a LEAF module with no
 * imports, so a caller (a dedupe threshold, a retriever's token budget) can
 * read them without loading a backend.
 *
 * Adapted from inflect-compliance's
 * `src/app-layer/repositories/vector-search-params.ts`
 * (docs/carve-manifest.md). Inflect searches a shared HNSW index, so its
 * module holds the index's build and search parameters and the exact-scan
 * threshold below which a tenant skips the index. Inkquisitor has no HNSW
 * index yet (the production embedding model, and so the dimension an index
 * is built for, is chosen in 2.1; see the 2.0 migration), so EVERY search is
 * the exact path: a sequential read of one workspace's rows of one revision,
 * optionally one book's, through a workspace-leading btree. Recall is 1 by
 * construction.
 *
 * `EXACT_SCAN_WARN_ROWS` is where that stops being free: past it a search
 * logs `vector_store.search_large_exact_scan`, the signal to add the partial
 * HNSW index (and the iterative-scan search inflect's backend runs) for the
 * revision in use. 20,000 vectors of 384 dimensions is about 30 MB of floats,
 * a few tens of milliseconds to scan.
 */

export const SEARCH_PATH = 'exact' as const;

export const EXACT_SCAN_WARN_ROWS = 20_000;

/** At most this many hits per search. */
export const MAX_SEARCH_K = 50;
/** At most this many records per write call. */
export const MAX_UPSERT_BATCH = 500;
/** At most this many keys per listing. */
export const MAX_LIST_KEYS = 5000;
/** The largest vector the store holds (the table's CHECK says the same). */
export const MAX_DIMENSIONS = 4096;
/** The largest chunk position (the table's CHECK says the same). */
export const MAX_CHUNK_INDEX = 100_000;
/** At most this many source models in one search's filter. */
export const MAX_SEARCH_SOURCE_MODELS = 32;
/** Source ids a search's `within` filter names at most (a book's own sources and its opted-in series sources: 50 + 50, with room). */
export const MAX_WITHIN_IDS = 256;
/** Source ids `presentSources` is asked about at most a call. */
export const MAX_PRESENT_IDS = 500;
