/**
 * VectorRepository — the ONLY way into the vector store (subphase 2.0, owner
 * decision D8).
 *
 * Domain-neutral: callers in 2.1 (question dedupe) and 4.1 (elements, facts,
 * answers) upsert or delete vectors keyed by (workspace, revision,
 * sourceModel, sourceId, chunkIndex) with a content hash, and search top-k by
 * cosine within a workspace, optionally within one book and some source
 * models. Every reader and writer of vectors goes through this module; the
 * backends under `./vector/` are importable from here and from each other
 * only (ESLint `local/vector-store-single-seam`, which also refuses the
 * table's name and its Prisma delegate in any other file under `src/`).
 *
 * Carved from inflect-compliance's `src/app-layer/repositories/VectorRepository.ts`
 * (docs/carve-manifest.md): tenant → workspace; methods take the caller's
 * transaction (`db`, from `runInWorkspaceContext`) and the workspace id, as
 * every Inkquisitor repository does; the deployment switch, the search
 * strategies and the tenant-wide delete are gone; a record carries its book.
 *
 * ── What it guarantees, whatever the backend ─────────────────────────
 *
 *  1. ONE WORKSPACE PER CALL. A call names its workspace, and the pgvector
 *     backend refuses a transaction not bound to it (`NOT_IN_WORKSPACE_CONTEXT`);
 *     RLS then confines every statement to it, and every statement also
 *     filters on it. No method searches or lists across workspaces.
 *  2. VECTORS ONLY. A record is a key, a book scope, a content hash and a
 *     vector. A record carrying any other member — `text`, `content`, a whole
 *     source row spread into it — is refused `UNKNOWN_RECORD_FIELD`, never
 *     trimmed. Search returns REFERENCES and scores, never text: reading a
 *     hit's text is the caller's read of the source row through its own
 *     repository, under RLS, decrypted there.
 *  3. ONE VECTOR SPACE PER REVISION. A call writes one embedding revision of
 *     one dimension count; search compares a query only with vectors of its
 *     own revision, and a dimension mismatch is refused, never coerced.
 *  4. REBUILDABLE FROM THE SOURCE ROWS. `rebuildRevision` makes the
 *     workspace's rows of a revision EXACTLY the records a source yields —
 *     re-running it is a no-op. A source that yields nothing is refused unless
 *     the caller says the workspace really has nothing to embed
 *     (`allowEmpty`): "rebuild from an empty read" and "the source is broken"
 *     look the same, and only one of them should erase the index (rule 6,
 *     zero is never complete).
 *  5. BOUNDED. `k ≤ MAX_SEARCH_K`, a write batch ≤ `MAX_UPSERT_BATCH`, a key
 *     listing ≤ `MAX_LIST_KEYS` (`./vector-search-params.ts`).
 *  6. IDEMPOTENT. Upserting a key whose stored hash and scope are the
 *     record's writes nothing and reports it `unchanged`.
 *
 * Deleting with the source: a usecase that deletes a source row calls
 * `deleteSource` on the same `db`; the source table's migration also attaches
 * `vector_embedding_delete_with_source()`, which deletes the vectors whoever
 * deletes the row. A book's vectors go with the book (a cascade), and a
 * workspace's with the workspace.
 */
import { metrics } from '@opentelemetry/api';
import { z } from 'zod';
import { EMBEDDING_REVISION_PATTERN } from '@/lib/ai/embeddings/revision';
import { logger } from '@/lib/observability/logger';
import { createPgvectorStore } from './vector/pgvector-store';
import {
    MAX_CHUNK_INDEX,
    MAX_DIMENSIONS,
    MAX_LIST_KEYS,
    MAX_SEARCH_K,
    MAX_SEARCH_SOURCE_MODELS,
    MAX_UPSERT_BATCH,
    VectorStoreError,
    keyOf,
    type InWorkspace,
    type RebuildOutcome,
    type StoredVectorKey,
    type UpsertOutcome,
    type VectorDb,
    type VectorMatch,
    type VectorRecord,
    type VectorSearchQuery,
    type VectorStoreBackend,
} from './vector/types';

export { MAX_LIST_KEYS, MAX_SEARCH_K, MAX_UPSERT_BATCH, VectorStoreError };
export type {
    InWorkspace,
    RebuildOutcome,
    StoredVectorKey,
    UpsertOutcome,
    VectorDb,
    VectorMatch,
    VectorRecord,
    VectorSearchQuery,
    VectorStoreBackend,
};
export type { VectorStoreRefusal } from './vector/types';

// ─── Validation ──────────────────────────────────────────────────────
// The same patterns as the table's CHECK constraints (migration
// 20261119300000_vector_store).

const SOURCE_MODEL = z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/);
const ROW_ID = z.string().regex(/^[A-Za-z0-9_:.-]{1,128}$/);
const EMBEDDING_REVISION = z.string().regex(EMBEDDING_REVISION_PATTERN);
const CONTENT_HASH = z.string().regex(/^[0-9a-f]{64}$/);
/**
 * pgvector stores 32-bit floats, so a component is judged as the database
 * will hold it (`Math.fround`, the same round-to-nearest as its `strtof`): a
 * double past the float range is refused here rather than as a raw
 * out-of-range error quoting the value, and a vector whose every component
 * rounds to zero is the zero vector the table's CHECK refuses (and, as a
 * query, a cosine of NaN).
 */
const COMPONENT = z
    .number()
    .finite()
    .refine((x) => Number.isFinite(Math.fround(x)), 'outside the 32-bit float range the store holds');
const EMBEDDING = z
    .array(COMPONENT)
    .min(1)
    .max(MAX_DIMENSIONS)
    .refine((v) => v.some((x) => Math.fround(x) !== 0), 'a zero vector has no direction');

/** `.strict()` is the vectors-only rule at run time: an unnamed member is refused. */
const RECORD = z
    .object({
        sourceModel: SOURCE_MODEL,
        sourceId: ROW_ID,
        chunkIndex: z.number().int().min(0).max(MAX_CHUNK_INDEX),
        embeddingRevision: EMBEDDING_REVISION,
        bookId: ROW_ID.nullable(),
        contentHash: CONTENT_HASH,
        embedding: EMBEDDING,
    })
    .strict();

const QUERY = z
    .object({
        embeddingRevision: EMBEDDING_REVISION,
        embedding: EMBEDDING,
        k: z.number().int().min(1).max(MAX_SEARCH_K),
        bookId: ROW_ID.optional(),
        sourceModels: z.array(SOURCE_MODEL).min(1).max(MAX_SEARCH_SOURCE_MODELS).optional(),
    })
    .strict();

const WORKSPACE_ID = z.string().min(1);

/** Parse a scalar argument, refusing with a named reason rather than a ZodError. */
function must<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new VectorStoreError('INVALID_QUERY', `invalid ${field}`);
    return result.data;
}

/** The issue paths name fields, never values: no vector or text reaches a message. */
function fieldsOf(error: z.ZodError): string {
    return [...new Set(error.issues.map((i) => i.path.join('.')))].join(', ');
}

function validateBatch(records: readonly VectorRecord[], revision?: string): VectorRecord[] {
    if (records.length > MAX_UPSERT_BATCH) {
        throw new VectorStoreError('BATCH_TOO_LARGE', `at most ${MAX_UPSERT_BATCH} records per call`);
    }
    const parsed: VectorRecord[] = [];
    for (const raw of records) {
        const result = RECORD.safeParse(raw);
        if (!result.success) {
            const unknown = result.error.issues.some((i) => i.code === 'unrecognized_keys');
            throw new VectorStoreError(
                unknown ? 'UNKNOWN_RECORD_FIELD' : 'INVALID_RECORD',
                unknown
                    ? 'a vector record carries only its key, bookId, contentHash and embedding (vectors-only rule)'
                    : `invalid field(s): ${fieldsOf(result.error)}`,
            );
        }
        parsed.push(result.data);
    }
    const first = parsed[0];
    const seen = new Set<string>();
    for (const r of parsed) {
        if (r.embeddingRevision !== (revision ?? first.embeddingRevision)) {
            throw new VectorStoreError('MIXED_REVISIONS', 'one call writes one embedding revision');
        }
        if (r.embedding.length !== first.embedding.length) {
            throw new VectorStoreError('DIMENSION_MISMATCH', 'one call writes one dimension count');
        }
        const key = keyOf(r);
        if (seen.has(key)) throw new VectorStoreError('DUPLICATE_KEY_IN_BATCH', 'a key appears twice in one call');
        seen.add(key);
    }
    return parsed;
}

/** 1..MAX_LIST_KEYS; an absent or non-finite limit (NaN would reach SQL's LIMIT) is the maximum. */
function boundedLimit(limit: number | undefined): number {
    const asked = limit !== undefined && Number.isFinite(limit) ? Math.trunc(limit) : MAX_LIST_KEYS;
    return Math.min(Math.max(1, asked), MAX_LIST_KEYS);
}

// ─── Outcome metric ──────────────────────────────────────────────────

type Operation = 'upsert' | 'search' | 'list_keys' | 'list_source_keys' | 'delete_source' | 'rebuild';
let requestCounter: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | undefined;
let requestDuration: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | undefined;

/**
 * The vector store's two signals: an outcome counter and a latency histogram,
 * labelled by operation, backend and outcome (`ok`, a refusal reason, or
 * `error`). No workspace id is a label (it is in the failure's log line).
 * `/api/readyz` does not gate on the store.
 */
function recordRequest(operation: Operation, backend: VectorStoreBackend['kind'], outcome: string, durationMs: number): void {
    const meter = metrics.getMeter('inkquisitor');
    requestCounter ??= meter.createCounter('vector_store.requests', { description: 'Vector store requests by outcome', unit: '1' });
    requestDuration ??= meter.createHistogram('vector_store.request.duration', {
        description: 'Vector store request latency by operation and outcome',
        unit: 'ms',
    });
    const labels = { operation, backend, outcome };
    requestCounter.add(1, labels);
    requestDuration.record(durationMs, labels);
}

// ─── The repository ──────────────────────────────────────────────────

export interface VectorRepository {
    readonly backend: VectorStoreBackend['kind'];
    upsert(db: VectorDb, workspaceId: string, records: readonly VectorRecord[]): Promise<UpsertOutcome>;
    search(db: VectorDb, workspaceId: string, query: VectorSearchQuery): Promise<VectorMatch[]>;
    listKeys(db: VectorDb, workspaceId: string, embeddingRevision: string, options?: { limit?: number }): Promise<StoredVectorKey[]>;
    /** The stored keys of ONE source's chunks for one revision, in chunk order. */
    listSourceKeys(
        db: VectorDb,
        workspaceId: string,
        embeddingRevision: string,
        sourceModel: string,
        sourceId: string,
        options?: { limit?: number },
    ): Promise<StoredVectorKey[]>;
    /** Every vector of one source row, every revision: call it in the transaction that deletes the row. */
    deleteSource(db: VectorDb, workspaceId: string, sourceModel: string, sourceId: string): Promise<number>;
    /**
     * Re-embed a whole revision: `inWorkspace` opens each transaction
     * (`(fn) => runInWorkspaceContext(ctx, fn)`).
     */
    rebuildRevision(
        inWorkspace: InWorkspace,
        workspaceId: string,
        embeddingRevision: string,
        source: AsyncIterable<readonly VectorRecord[]> | Iterable<readonly VectorRecord[]>,
        options?: { allowEmpty?: boolean },
    ): Promise<RebuildOutcome & { seen: number }>;
}

export function createVectorRepository(store: VectorStoreBackend): VectorRepository {
    async function observed<T>(op: Operation, workspaceId: string, fn: () => Promise<T>): Promise<T> {
        const started = performance.now();
        try {
            const result = await fn();
            recordRequest(op, store.kind, 'ok', performance.now() - started);
            return result;
        } catch (err) {
            const outcome = err instanceof VectorStoreError ? err.reason : 'error';
            recordRequest(op, store.kind, outcome, performance.now() - started);
            logger.warn('vector_store.request_failed', {
                component: 'vector-store',
                operation: op,
                backend: store.kind,
                outcome,
                workspaceId,
            });
            throw err;
        }
    }

    return {
        backend: store.kind,

        upsert(db, workspaceId, records) {
            return observed('upsert', workspaceId, async () => {
                must(WORKSPACE_ID, workspaceId, 'workspaceId');
                const parsed = validateBatch(records);
                if (parsed.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
                return store.upsert(db, workspaceId, parsed);
            });
        },

        search(db, workspaceId, query) {
            return observed('search', workspaceId, async () => {
                must(WORKSPACE_ID, workspaceId, 'workspaceId');
                const parsed = QUERY.safeParse(query);
                if (!parsed.success) throw new VectorStoreError('INVALID_QUERY', `invalid field(s): ${fieldsOf(parsed.error)}`);
                return store.search(db, workspaceId, parsed.data);
            });
        },

        listKeys(db, workspaceId, embeddingRevision, options) {
            return observed('list_keys', workspaceId, async () => {
                must(WORKSPACE_ID, workspaceId, 'workspaceId');
                must(EMBEDDING_REVISION, embeddingRevision, 'embeddingRevision');
                return store.listKeys(db, workspaceId, embeddingRevision, boundedLimit(options?.limit));
            });
        },

        listSourceKeys(db, workspaceId, embeddingRevision, sourceModel, sourceId, options) {
            return observed('list_source_keys', workspaceId, async () => {
                must(WORKSPACE_ID, workspaceId, 'workspaceId');
                must(EMBEDDING_REVISION, embeddingRevision, 'embeddingRevision');
                must(SOURCE_MODEL, sourceModel, 'sourceModel');
                must(ROW_ID, sourceId, 'sourceId');
                return store.listSourceKeys(db, workspaceId, embeddingRevision, sourceModel, sourceId, boundedLimit(options?.limit));
            });
        },

        deleteSource(db, workspaceId, sourceModel, sourceId) {
            return observed('delete_source', workspaceId, async () => {
                must(WORKSPACE_ID, workspaceId, 'workspaceId');
                must(SOURCE_MODEL, sourceModel, 'sourceModel');
                must(ROW_ID, sourceId, 'sourceId');
                return store.deleteSource(db, workspaceId, sourceModel, sourceId);
            });
        },

        rebuildRevision(inWorkspace, workspaceId, embeddingRevision, source, options) {
            return observed('rebuild', workspaceId, async () => {
                must(WORKSPACE_ID, workspaceId, 'workspaceId');
                must(EMBEDDING_REVISION, embeddingRevision, 'embeddingRevision');
                // Validate every batch as it passes, and refuse an empty source
                // INSIDE the iteration — before it completes — so the backend's
                // delete-what-was-not-seen step is never reached on a read that
                // yielded nothing.
                async function* checked(): AsyncGenerator<readonly VectorRecord[]> {
                    let seen = 0;
                    let dimensions: number | null = null;
                    for await (const batch of source) {
                        const parsed = validateBatch(batch, embeddingRevision);
                        if (parsed.length === 0) continue;
                        dimensions ??= parsed[0].embedding.length;
                        if (parsed[0].embedding.length !== dimensions) {
                            throw new VectorStoreError('DIMENSION_MISMATCH', 'one rebuild writes one dimension count');
                        }
                        seen += parsed.length;
                        yield parsed;
                    }
                    if (seen === 0 && !options?.allowEmpty) {
                        throw new VectorStoreError(
                            'EMPTY_REBUILD_SOURCE',
                            'the source yielded no records; pass allowEmpty only when the workspace has nothing to embed',
                        );
                    }
                }
                return store.rebuildRevision(inWorkspace, workspaceId, embeddingRevision, checked());
            });
        },
    };
}

let configured: VectorRepository | undefined;

/**
 * The deployment's vector repository: always pgvector (the 2.0 migration
 * creates the extension, so there is no deployment without it). The
 * in-process backend is never selected here; tests construct it by name
 * (`createVectorRepository(createInProcessVectorStore())`).
 */
export function getVectorRepository(): VectorRepository {
    configured ??= createVectorRepository(createPgvectorStore());
    return configured;
}
