/**
 * The vector store's record shapes and its backend contract.
 *
 * Nothing outside `src/app-layer/repositories/vector.repository.ts` and this
 * directory may import from here (ESLint `local/vector-store-single-seam`).
 * Callers go through the repository, which validates every record and every
 * query before a backend sees it.
 *
 * Carved from inflect-compliance's `src/app-layer/repositories/vector/types.ts`
 * (docs/carve-manifest.md): tenant → workspace; a backend takes the caller's
 * transaction and the workspace id (Inkquisitor's repository shape) instead
 * of opening its own; the chunk table, the search strategies and the
 * tenant-wide delete are gone; a record carries its book scope.
 *
 * ── The vectors-only rule ─────────────────────────────────────────────
 *
 * A row in the vector store is a KEY and a VECTOR, never text. The key is
 * `(workspaceId, embeddingRevision, sourceModel, sourceId, chunkIndex)`;
 * beside it sit the book the source belongs to (the search scope), the keyed
 * `contentHash` of the text the vector was computed from
 * (`vectorContentHash`) and the vector's `dimensions`. The text itself stays
 * in its source row, encrypted under the workspace's data key, and is read
 * back through that row's own repository under RLS. So every field here is
 * derived from a source row plus an embedding call: losing the store loses
 * nothing, and `rebuildRevision` restores it from the system of record.
 *
 * `VectorRecord` has no text member, and the repository REFUSES a record
 * carrying any key it does not name, so a caller that spreads a source object
 * (`{ ...question, embedding }`) into a write is refused rather than having
 * its text silently dropped or, in a later backend, silently stored.
 */
import type { Prisma } from '@prisma/client';

export {
    EXACT_SCAN_WARN_ROWS,
    MAX_CHUNK_INDEX,
    MAX_DIMENSIONS,
    MAX_LIST_KEYS,
    MAX_SEARCH_K,
    MAX_SEARCH_SOURCE_MODELS,
    MAX_UPSERT_BATCH,
    MAX_WITHIN_IDS,
    MAX_PRESENT_IDS,
} from '../vector-search-params';

/**
 * A search's ISOLATION FILTER, applied INSIDE the query (Phase 4.1, #57 item 3):
 * only vectors whose source row is in the caller's allowed set are ranked, so a
 * book's top k is never a workspace's top k cut down after the fact. Each scope
 * is a reviewed predicate over the source table, named here and nowhere else;
 * the backend joins the source row under the caller's RLS.
 *
 *   chunks-of-sources   a `SourceChunk` whose `sourceId` is one of `sourceIds`
 *   facts-of-book       a live, CONFIRMED `StoryFact` that is the book's own
 *                       (`bookId`) or drawn from one of `sourceIds`
 */
export const VECTOR_SCOPES = ['chunks-of-sources', 'facts-of-book'] as const;
export type VectorScope = (typeof VECTOR_SCOPES)[number];
export interface VectorScopeFilter {
    scope: VectorScope;
    sourceIds: readonly string[];
    /** `facts-of-book`: the book whose own facts count. */
    bookId?: string;
}

/** The transaction a backend runs on: the caller's, inside `runInWorkspaceContext`. */
export type VectorDb = Prisma.TransactionClient;

/** Runs `fn` in a fresh transaction under the workspace's RLS (a rebuild needs many). */
export type InWorkspace = <T>(fn: (db: VectorDb) => Promise<T>) => Promise<T>;

/** The identity of one chunk's vector inside a workspace, minus the workspace. */
export interface VectorKey {
    /** The Prisma model of the source row, e.g. `Question`. */
    sourceModel: string;
    /** That row's id. */
    sourceId: string;
    /** The chunk's position within its source, from 0 (0 for a source embedded whole). */
    chunkIndex: number;
    /**
     * Which embedding produced the vector (`EmbeddingProvider.revision`):
     * model, dimensions and prompt prefixes. Vectors of two revisions are
     * never compared with each other.
     */
    embeddingRevision: string;
}

/** One vector, ready to store. Deliberately carries no text. */
export interface VectorRecord extends VectorKey {
    /** The book the source belongs to, or null for a workspace-level source. */
    bookId: string | null;
    /** `vectorContentHash` of the text the vector was computed from. */
    contentHash: string;
    /** The vector itself; its length is `dimensions`. */
    embedding: readonly number[];
}

/** What a stored row looks like when listed: the key, the scope and the hash, no vector. */
export interface StoredVectorKey extends VectorKey {
    bookId: string | null;
    contentHash: string;
    dimensions: number;
}

export interface VectorSearchQuery {
    embeddingRevision: string;
    embedding: readonly number[];
    /** At most `MAX_SEARCH_K`. */
    k: number;
    /** Only vectors of this book; absent = the whole workspace. */
    bookId?: string;
    /** Only these source models; absent = every model. */
    sourceModels?: readonly string[];
    /** Only vectors whose source row is in this allowed set, filtered in the query (above). */
    within?: VectorScopeFilter;
}

/** A search hit: a reference to read back under RLS, and a cosine similarity. */
export interface VectorMatch {
    sourceModel: string;
    sourceId: string;
    chunkIndex: number;
    bookId: string | null;
    contentHash: string;
    /** Cosine similarity in [-1, 1]; higher is closer. */
    score: number;
}

export interface UpsertOutcome {
    inserted: number;
    /** The content hash or the book scope moved, so the row was rewritten. */
    updated: number;
    /** Same key, same content hash, same scope: nothing written. */
    unchanged: number;
}

export interface RebuildOutcome extends UpsertOutcome {
    /** Rows of the revision that the source no longer produces. */
    deleted: number;
}

/**
 * A backend. Every method names the workspace it acts in; the pgvector
 * backend refuses a transaction that is not bound to that workspace as
 * app_user (`NOT_IN_WORKSPACE_CONTEXT`), so the RLS policy and the
 * application-layer filter agree on every statement.
 *
 * Backends receive input the repository has already validated.
 */
export interface VectorStoreBackend {
    readonly kind: 'in-process' | 'pgvector';
    upsert(db: VectorDb, workspaceId: string, records: readonly VectorRecord[]): Promise<UpsertOutcome>;
    search(db: VectorDb, workspaceId: string, query: VectorSearchQuery): Promise<VectorMatch[]>;
    /** Keys of the workspace's rows for one revision, ordered, at most `limit`. */
    listKeys(db: VectorDb, workspaceId: string, embeddingRevision: string, limit: number): Promise<StoredVectorKey[]>;
    /** Keys of ONE source's rows for one revision, in chunk order, at most `limit`. */
    listSourceKeys(
        db: VectorDb,
        workspaceId: string,
        embeddingRevision: string,
        sourceModel: string,
        sourceId: string,
        limit: number,
    ): Promise<StoredVectorKey[]>;
    /** Which of `sourceIds` (of one model) hold a vector of this revision (an ingestion's resume, #57 item 1). */
    presentSources(db: VectorDb, workspaceId: string, embeddingRevision: string, sourceModel: string, sourceIds: readonly string[]): Promise<string[]>;
    /** Every vector of one source, every revision. */
    deleteSource(db: VectorDb, workspaceId: string, sourceModel: string, sourceId: string): Promise<number>;
    /**
     * Make the workspace's rows for `embeddingRevision` exactly the records the
     * batches yield, one transaction per batch through `inWorkspace`. Rows the
     * batches do not yield are deleted only after the LAST batch was written:
     * a source that throws part-way leaves a superset and deletes nothing.
     */
    rebuildRevision(
        inWorkspace: InWorkspace,
        workspaceId: string,
        embeddingRevision: string,
        batches: AsyncIterable<readonly VectorRecord[]>,
    ): Promise<RebuildOutcome & { seen: number }>;
}

/** Refusal reasons, each named so a caller and a log line can tell them apart. */
export type VectorStoreRefusal =
    | 'PGVECTOR_NOT_INSTALLED'
    /** The transaction is not `runInWorkspaceContext`'s for this workspace. */
    | 'NOT_IN_WORKSPACE_CONTEXT'
    | 'INVALID_RECORD'
    | 'UNKNOWN_RECORD_FIELD'
    | 'DIMENSION_MISMATCH'
    | 'REVISION_DIMENSION_MISMATCH'
    | 'DUPLICATE_KEY_IN_BATCH'
    | 'BATCH_TOO_LARGE'
    | 'INVALID_QUERY'
    | 'MIXED_REVISIONS'
    | 'EMPTY_REBUILD_SOURCE'
    /** A write in a transaction whose isolation is not READ COMMITTED (issue #23, item 3). */
    | 'UNSUPPORTED_ISOLATION';

export class VectorStoreError extends Error {
    constructor(
        readonly reason: VectorStoreRefusal,
        message: string,
    ) {
        super(`${reason}: ${message}`);
        this.name = 'VectorStoreError';
    }
}

/** The map key of one row inside a workspace. */
export function keyOf(k: VectorKey): string {
    return `${k.embeddingRevision}\u0000${k.sourceModel}\u0000${k.sourceId}\u0000${k.chunkIndex}`;
}

/** Deterministic order: model, id, chunk. Used by every backend's listing and as the search tie-break. */
export function compareKeys(
    a: Pick<VectorKey, 'sourceModel' | 'sourceId' | 'chunkIndex'>,
    b: Pick<VectorKey, 'sourceModel' | 'sourceId' | 'chunkIndex'>,
): number {
    if (a.sourceModel !== b.sourceModel) return a.sourceModel < b.sourceModel ? -1 : 1;
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
    return a.chunkIndex - b.chunkIndex;
}

/** Cosine similarity of two equal-length, non-zero vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
