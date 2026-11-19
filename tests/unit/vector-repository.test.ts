/**
 * The vector store's seam, held to its behaviour over the in-process backend.
 *
 * Every assertion goes through `createVectorRepository` — the seam callers
 * use — so a guarantee the repository makes (one workspace per call, vectors
 * only, one space per revision, rebuildable, bounded, idempotent, scoped
 * search) is proved where it is made, not inside a backend that could be
 * swapped. The pgvector backend is held to the same behaviour against a real
 * PostgreSQL in tests/integration/vector-store.test.ts.
 *
 * The isolation cases are two workspaces: B writes, reads, lists, deletes and
 * rebuilds, and A's rows are untouched by every one of them.
 *
 * Adapted from inflect-compliance's `tests/unit/vector-repository.test.ts`.
 */

// The two signals: every request adds to the counter and records its latency,
// labelled by operation, backend and outcome.
const counted: Array<Record<string, string>> = [];
const timed: Array<{ ms: number; labels: Record<string, string> }> = [];
jest.mock('@opentelemetry/api', () => {
    const actual = jest.requireActual('@opentelemetry/api');
    const meter = {
        createCounter: (name: string) => ({
            add: (_n: number, labels: Record<string, string>) => {
                if (name === 'vector_store.requests') counted.push(labels);
            },
        }),
        createHistogram: (name: string) => ({
            record: (ms: number, labels: Record<string, string>) => {
                if (name === 'vector_store.request.duration') timed.push({ ms, labels });
            },
        }),
    };
    return { ...actual, metrics: { ...actual.metrics, getMeter: () => meter } };
});

import {
    createVectorRepository,
    getVectorRepository,
    MAX_SEARCH_K,
    VectorStoreError,
    type InWorkspace,
    type VectorDb,
    type VectorRecord,
    type VectorRepository,
} from '@/app-layer/repositories/vector.repository';
// The backend is imported directly here only to construct the reference
// store; the ESLint seam rule covers src/.
import { createInProcessVectorStore } from '@/app-layer/repositories/vector/in-process-store';
import { vectorContentHash } from '@/lib/ai/embeddings/content-hash';

/** The in-process backend reads no transaction. */
const DB = {} as VectorDb;
const IN_WS: InWorkspace = (fn) => fn(DB);
const A = 'ws-a';
const B = 'ws-b';
const REV = 'test-embed@4:d4:p00000000';
const BOOK = 'book-1';

const hash = (s: string) => vectorContentHash(s);

function rec(sourceId: string, chunkIndex: number, embedding: number[], text = `${sourceId}#${chunkIndex}`, bookId: string | null = BOOK): VectorRecord {
    return { sourceModel: 'Question', sourceId, chunkIndex, embeddingRevision: REV, bookId, contentHash: hash(text), embedding };
}

const DOC1 = [rec('q1', 0, [1, 0, 0, 0]), rec('q1', 1, [0.9, 0.1, 0, 0])];
const DOC2 = [rec('q2', 0, [0, 1, 0, 0])];

async function refusal(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        if (e instanceof VectorStoreError) return e.reason;
        throw e;
    }
    throw new Error('expected a refusal');
}

async function* batchesOf(...batches: VectorRecord[][]): AsyncGenerator<VectorRecord[]> {
    for (const b of batches) yield b;
}

let repo: VectorRepository;
beforeEach(() => {
    repo = createVectorRepository(createInProcessVectorStore());
});

describe("a workspace never reaches another workspace's vectors", () => {
    beforeEach(async () => {
        await repo.upsert(DB, A, [...DOC1, ...DOC2]);
    });

    it("B searching with A's exact vector finds nothing", async () => {
        expect(await repo.search(DB, B, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 10 })).toEqual([]);
        expect((await repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 10 }))[0]).toMatchObject({
            sourceId: 'q1',
            chunkIndex: 0,
        });
    });

    it("B listing A's revision sees no keys", async () => {
        expect(await repo.listKeys(DB, B, REV)).toEqual([]);
        expect(await repo.listKeys(DB, A, REV)).toHaveLength(3);
    });

    it("B deleting A's source id removes nothing of A's", async () => {
        expect(await repo.deleteSource(DB, B, 'Question', 'q1')).toBe(0);
        expect(await repo.listKeys(DB, A, REV)).toHaveLength(3);
    });

    it("B writing the same key keeps a row of its own and leaves A's hash alone", async () => {
        await repo.upsert(DB, B, [rec('q1', 0, [0, 0, 0, 1], 'b text')]);
        const aRow = (await repo.listKeys(DB, A, REV)).find((k) => k.sourceId === 'q1' && k.chunkIndex === 0);
        expect(aRow?.contentHash).toBe(hash('q1#0'));
        const bHits = await repo.search(DB, B, { embeddingRevision: REV, embedding: [0, 0, 0, 1], k: 10 });
        expect(bHits.map((h) => h.contentHash)).toEqual([hash('b text')]);
    });

    it("B rebuilding the revision deletes nothing of A's", async () => {
        await repo.rebuildRevision(IN_WS, B, REV, batchesOf([rec('other', 0, [0, 0, 1, 0])]));
        expect(await repo.listKeys(DB, A, REV)).toHaveLength(3);
    });
});

describe('search: top-k by cosine, within a book and source models when asked', () => {
    beforeEach(async () => {
        await repo.upsert(DB, A, [
            rec('q1', 0, [1, 0, 0, 0]),
            rec('q2', 0, [0.8, 0.6, 0, 0]),
            rec('q3', 0, [0, 1, 0, 0], 'q3', 'book-2'),
            { ...rec('e1', 0, [0.99, 0.01, 0, 0]), sourceModel: 'BibleElement' },
            rec('w1', 0, [0.95, 0.05, 0, 0], 'w1', null),
        ]);
    });

    it('orders by cosine similarity, highest first, at most k', async () => {
        const hits = await repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 3 });
        expect(hits.map((h) => h.sourceId)).toEqual(['q1', 'e1', 'w1']);
        expect(hits[0].score).toBeCloseTo(1, 10);
        expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    });

    it('a book scope returns that book only (not other books, not workspace-level vectors)', async () => {
        const hits = await repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 10, bookId: BOOK });
        expect(hits.map((h) => h.sourceId)).toEqual(['q1', 'e1', 'q2']);
        expect(new Set(hits.map((h) => h.bookId))).toEqual(new Set([BOOK]));
    });

    it('a source-model filter returns those models only', async () => {
        const hits = await repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 10, sourceModels: ['BibleElement'] });
        expect(hits.map((h) => h.sourceId)).toEqual(['e1']);
    });

    it('equal scores are ordered by the key, so the order is deterministic', async () => {
        await repo.upsert(DB, A, [rec('z9', 0, [0, 0, 1, 0]), rec('a1', 0, [0, 0, 2, 0])]);
        const hits = await repo.search(DB, A, { embeddingRevision: REV, embedding: [0, 0, 1, 0], k: 2 });
        expect(hits.map((h) => h.sourceId)).toEqual(['a1', 'z9']);
    });
});

describe('vectors only: a record carries a key, a scope, a content hash and a vector, never text', () => {
    it('refuses a record carrying text, and writes nothing from that call', async () => {
        const withText = { ...rec('q1', 0, [1, 0, 0, 0]), text: 'What does Mara fear?' } as VectorRecord;
        expect(await refusal(repo.upsert(DB, A, [rec('q9', 0, [1, 1, 0, 0]), withText]))).toBe('UNKNOWN_RECORD_FIELD');
        expect(await repo.listKeys(DB, A, REV)).toEqual([]);
    });

    it('returns references and scores from a search, never a vector or text', async () => {
        await repo.upsert(DB, A, DOC1);
        const [hit] = await repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 1 });
        expect(Object.keys(hit).sort()).toEqual(['bookId', 'chunkIndex', 'contentHash', 'score', 'sourceId', 'sourceModel']);
    });

    it('refuses a content hash that is not 64 hex characters — a place text could hide', async () => {
        expect(await refusal(repo.upsert(DB, A, [{ ...rec('q1', 0, [1, 0, 0, 0]), contentHash: 'plain words' }]))).toBe('INVALID_RECORD');
    });

    it('refuses a record with no stated scope (bookId must be named, even as null)', async () => {
        const noScope: Partial<VectorRecord> = rec('q1', 0, [1, 0, 0, 0]);
        delete noScope.bookId;
        expect(await refusal(repo.upsert(DB, A, [noScope as VectorRecord]))).toBe('INVALID_RECORD');
    });

    it.each([
        ['a lower-case source model', { sourceModel: 'question' }],
        ['a source id with a space', { sourceId: 'q 1' }],
        ['a negative chunk', { chunkIndex: -1 }],
        ['a revision with a space', { embeddingRevision: 'my model' }],
        ['a non-finite number', { embedding: [1, Number.NaN, 0, 0] }],
        // pgvector holds 32-bit floats: what it would refuse (out of range) or
        // read as the zero vector (every component underflows) is refused here,
        // never handed to the database as a raw error quoting the value.
        ['a component past the 32-bit float range', { embedding: [1, 1e39, 0, 0] }],
        ['a vector that is zero in 32 bits', { embedding: [1e-50, 0, 0, 0] }],
    ])('refuses %s', async (_label, change) => {
        expect(await refusal(repo.upsert(DB, A, [{ ...rec('q1', 0, [1, 0, 0, 0]), ...change } as VectorRecord]))).toBe('INVALID_RECORD');
    });

    it('admits the 32-bit extremes the database holds: the largest float and a subnormal', async () => {
        expect(await repo.upsert(DB, A, [rec('q1', 0, [3.4e38, 0, 0, 0]), rec('q2', 0, [1e-40, 0, 0, 0])])).toEqual({
            inserted: 2,
            updated: 0,
            unchanged: 0,
        });
    });

    it('refuses a query that is zero in 32 bits (its cosine is NaN), or past the float range', async () => {
        await repo.upsert(DB, A, DOC1);
        for (const embedding of [[1e-50, 0, 0, 0], [1e39, 0, 0, 0]]) {
            expect(await refusal(repo.search(DB, A, { embeddingRevision: REV, embedding, k: 1 }))).toBe('INVALID_QUERY');
        }
    });
});

describe('idempotent by content hash', () => {
    it('the same key with the same hash and scope writes nothing; a moved hash or scope rewrites', async () => {
        expect(await repo.upsert(DB, A, DOC1)).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
        expect(await repo.upsert(DB, A, DOC1)).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
        expect(await repo.upsert(DB, A, [rec('q1', 0, [0, 1, 0, 0], 'edited')])).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
        expect(await repo.upsert(DB, A, [rec('q1', 1, [0.9, 0.1, 0, 0], 'q1#1', 'book-2')])).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
        const keys = await repo.listKeys(DB, A, REV);
        expect(keys.map((k) => [k.chunkIndex, k.contentHash === hash('edited'), k.bookId])).toEqual([
            [0, true, BOOK],
            [1, false, 'book-2'],
        ]);
    });
});

describe('one vector space per embedding revision', () => {
    it('never compares a query with vectors of another revision', async () => {
        await repo.upsert(DB, A, DOC1);
        await repo.upsert(DB, A, [{ ...rec('q1', 0, [1, 0, 0, 0]), embeddingRevision: 'other@4' }]);
        const hits = await repo.search(DB, A, { embeddingRevision: 'other@4', embedding: [1, 0, 0, 0], k: 10 });
        expect(hits).toHaveLength(1);
    });

    it("refuses a write whose dimensions disagree with the revision's stored vectors", async () => {
        await repo.upsert(DB, A, DOC1);
        expect(await refusal(repo.upsert(DB, A, [rec('q3', 0, [1, 0, 0])]))).toBe('REVISION_DIMENSION_MISMATCH');
    });

    it('refuses a query of the wrong dimension rather than comparing it', async () => {
        await repo.upsert(DB, A, DOC1);
        expect(await refusal(repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0], k: 5 }))).toBe('DIMENSION_MISMATCH');
    });

    it('refuses one call mixing revisions, and a zero vector', async () => {
        expect(await refusal(repo.upsert(DB, A, [DOC1[0], { ...DOC2[0], embeddingRevision: 'other@4' }]))).toBe('MIXED_REVISIONS');
        expect(await refusal(repo.upsert(DB, A, [rec('q1', 0, [0, 0, 0, 0])]))).toBe('INVALID_RECORD');
    });
});

describe('every read and write is bounded', () => {
    it(`refuses k above ${MAX_SEARCH_K} and returns at most k`, async () => {
        await repo.upsert(DB, A, [...DOC1, ...DOC2]);
        expect(await refusal(repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: MAX_SEARCH_K + 1 }))).toBe('INVALID_QUERY');
        expect(await repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 2 })).toHaveLength(2);
    });

    it('reads a non-finite listing limit as the bound, never as NaN', async () => {
        await repo.upsert(DB, A, DOC1);
        for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(await repo.listKeys(DB, A, REV, { limit })).toHaveLength(DOC1.length);
            expect(await repo.listSourceKeys(DB, A, REV, 'Question', 'q1', { limit })).toHaveLength(DOC1.length);
        }
    });

    it('refuses a key repeated in one call, and an unknown query member', async () => {
        expect(await refusal(repo.upsert(DB, A, [DOC1[0], DOC1[0]]))).toBe('DUPLICATE_KEY_IN_BATCH');
        expect(
            await refusal(repo.search(DB, A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 1, workspaceId: B } as never)),
        ).toBe('INVALID_QUERY');
    });
});

describe('a source row takes its vectors with it', () => {
    it('deleteSource removes every chunk of that source, every revision, and nothing else', async () => {
        await repo.upsert(DB, A, [...DOC1, ...DOC2]);
        await repo.upsert(DB, A, [{ ...DOC1[0], embeddingRevision: 'other@4' }]);
        expect(await repo.deleteSource(DB, A, 'Question', 'q1')).toBe(3);
        expect((await repo.listKeys(DB, A, REV)).map((k) => k.sourceId)).toEqual(['q2']);
        expect(await repo.listKeys(DB, A, 'other@4')).toEqual([]);
    });
});

describe('the store is rebuildable from the source rows', () => {
    it('a rebuild into an empty store reproduces exactly the keys and hashes incremental writes produced', async () => {
        await repo.upsert(DB, A, DOC1);
        await repo.upsert(DB, A, DOC2);
        await repo.upsert(DB, A, [rec('q1', 1, [0.8, 0.2, 0, 0], 'edited')]);
        const incremental = await repo.listKeys(DB, A, REV);

        const fresh = createVectorRepository(createInProcessVectorStore());
        const source = [DOC1[0], rec('q1', 1, [0.8, 0.2, 0, 0], 'edited'), DOC2[0]];
        const outcome = await fresh.rebuildRevision(IN_WS, A, REV, batchesOf(source.slice(0, 2), source.slice(2)));
        expect(outcome).toMatchObject({ inserted: 3, deleted: 0, seen: 3 });
        expect(await fresh.listKeys(DB, A, REV)).toEqual(incremental);
    });

    it('re-running a rebuild is a no-op', async () => {
        await repo.rebuildRevision(IN_WS, A, REV, [[...DOC1, ...DOC2]]);
        expect(await repo.rebuildRevision(IN_WS, A, REV, [[...DOC1, ...DOC2]])).toEqual({ inserted: 0, updated: 0, unchanged: 3, deleted: 0, seen: 3 });
    });

    it("deletes the rows the source no longer yields, and only that revision's", async () => {
        await repo.upsert(DB, A, [...DOC1, ...DOC2]);
        await repo.upsert(DB, A, [{ ...DOC2[0], embeddingRevision: 'other@4' }]);
        const outcome = await repo.rebuildRevision(IN_WS, A, REV, [DOC1]);
        expect(outcome.deleted).toBe(1);
        expect((await repo.listKeys(DB, A, REV)).map((k) => k.sourceId)).toEqual(['q1', 'q1']);
        expect(await repo.listKeys(DB, A, 'other@4')).toHaveLength(1);
    });

    it('a source that fails part-way deletes nothing', async () => {
        await repo.upsert(DB, A, [...DOC1, ...DOC2]);
        async function* failing(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            throw new Error('source read failed');
        }
        await expect(repo.rebuildRevision(IN_WS, A, REV, failing())).rejects.toThrow('source read failed');
        expect(await repo.listKeys(DB, A, REV)).toHaveLength(3);
    });

    it('an empty source is refused and erases nothing, unless the caller says there is nothing to embed', async () => {
        await repo.upsert(DB, A, DOC1);
        expect(await refusal(repo.rebuildRevision(IN_WS, A, REV, []))).toBe('EMPTY_REBUILD_SOURCE');
        expect(await repo.listKeys(DB, A, REV)).toHaveLength(2);
        expect((await repo.rebuildRevision(IN_WS, A, REV, [], { allowEmpty: true })).deleted).toBe(2);
        expect(await repo.listKeys(DB, A, REV)).toEqual([]);
    });

    it('refuses a rebuild batch of another revision', async () => {
        expect(await refusal(repo.rebuildRevision(IN_WS, A, 'other@4', [DOC1]))).toBe('MIXED_REVISIONS');
    });
});

describe('a rebuild never erases a write that landed while it ran', () => {
    it('a source embedded between two of its batches survives the final delete', async () => {
        const ingested = rec('q-new', 0, [0, 0, 1, 0]);
        async function* source(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            await repo.upsert(DB, A, [ingested]);
            yield [DOC1[1]];
        }
        const outcome = await repo.rebuildRevision(IN_WS, A, REV, source());
        expect(outcome.deleted).toBe(0);
        expect((await repo.listKeys(DB, A, REV)).map((k) => k.sourceId)).toEqual(['q-new', 'q1', 'q1']);
    });

    it('two overlapping rebuilds of one workspace and revision do not erase each other’s rows', async () => {
        const later = rec('q-later', 0, [0, 0, 0, 1]);
        async function* outer(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            await repo.rebuildRevision(IN_WS, A, REV, [[DOC1[0], later]]);
            yield [DOC1[1]];
        }
        await repo.rebuildRevision(IN_WS, A, REV, outer());
        expect((await repo.listKeys(DB, A, REV)).map((k) => k.sourceId)).toEqual(['q-later', 'q1', 'q1']);
    });

    it('a row written before the rebuild began and absent from its source is still deleted', async () => {
        await repo.upsert(DB, A, [...DOC1, ...DOC2]);
        async function* source(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            await repo.upsert(DB, A, [rec('q-new', 0, [0, 0, 1, 0])]);
            yield [DOC1[1]];
        }
        const outcome = await repo.rebuildRevision(IN_WS, A, REV, source());
        expect(outcome.deleted).toBe(1);
        expect((await repo.listKeys(DB, A, REV)).map((k) => k.sourceId)).not.toContain('q2');
    });
});

describe("the deployment's vector store is pgvector, always", () => {
    it('getVectorRepository constructs the pgvector backend, once', () => {
        expect(getVectorRepository().backend).toBe('pgvector');
        expect(getVectorRepository()).toBe(getVectorRepository());
    });
});

describe('every request is counted and timed, by outcome (vector_store.requests and its histogram)', () => {
    it('records one counter increment and one latency per request, with the same labels', async () => {
        counted.length = 0;
        timed.length = 0;
        await repo.upsert(DB, A, DOC1);
        await refusal(repo.search(DB, A, { embeddingRevision: REV, embedding: [0, 0, 0, 0], k: 1 }));
        expect(counted).toEqual([
            { operation: 'upsert', backend: 'in-process', outcome: 'ok' },
            { operation: 'search', backend: 'in-process', outcome: 'INVALID_QUERY' },
        ]);
        expect(timed.map((t) => t.labels)).toEqual(counted);
        for (const t of timed) expect(t.ms).toBeGreaterThanOrEqual(0);
    });
});
