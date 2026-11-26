/**
 * The vector store's allowed-set filter (Phase 4.1, #57 item 3): a book's
 * search names the sources it may draw on, and the filter is part of the
 * query — a join to the source row — never a cut of the workspace's top k
 * after ranking. Proved here on the SQL built and the seam's validation; the
 * integration suite (fact-layer.test.ts) proves the recall against a real
 * PostgreSQL.
 */
import { createVectorRepository, VectorStoreError } from '@/app-layer/repositories/vector.repository';
import { createInProcessVectorStore } from '@/app-layer/repositories/vector/in-process-store';
import { buildSearchQuery } from '@/app-layer/repositories/vector/pgvector-store';

const revision = 'test-embed@8:d8:p00000000';
const sql = (within?: Parameters<typeof buildSearchQuery>[1]['within']) => buildSearchQuery('ws-1', { embeddingRevision: revision, embedding: [1, 0, 0, 0, 0, 0, 0, 0], k: 20, sourceModels: ['SourceChunk'], within }, 8);

describe('the allowed-set filter is inside the query', () => {
    it('chunks: the source row is joined, its source in the allowed set, before ORDER BY and LIMIT', () => {
        const q = sql({ scope: 'chunks-of-sources', sourceIds: ['s-1', 's-2'] });
        const text = q.sql;
        const exists = text.indexOf('EXISTS');
        expect(exists).toBeGreaterThan(0);
        expect(exists).toBeLessThan(text.indexOf('ORDER BY'));
        expect(text).toContain('"SourceChunk" p WHERE p."id"');
        expect(text).toContain('p."sourceId" = ANY(');
        expect(q.values).toEqual(expect.arrayContaining([['s-1', 's-2']]));
    });

    it('facts: a live, confirmed fact of the book or of an allowed source', () => {
        const text = sql({ scope: 'facts-of-book', bookId: 'b-1', sourceIds: [] }).sql;
        expect(text).toContain('"StoryFact" p');
        expect(text).toContain('p."supersededAt" IS NULL');
        expect(text).toContain(`p."status" = 'CONFIRMED'`);
        expect(text).toContain('p."bookId" =');
    });

    it('no filter, no join (callers that ask for none get none)', () => {
        expect(sql().sql).not.toContain('EXISTS');
    });
});

describe('the seam validates the filter', () => {
    const repo = createVectorRepository(createInProcessVectorStore());
    const db = {} as never;
    it('refuses facts-of-book without its book, and too many ids', async () => {
        await expect(repo.search(db, 'ws-1', { embeddingRevision: revision, embedding: [1, 0, 0, 0, 0, 0, 0, 0], k: 5, within: { scope: 'facts-of-book', sourceIds: [] } })).rejects.toBeInstanceOf(VectorStoreError);
        await expect(
            repo.search(db, 'ws-1', { embeddingRevision: revision, embedding: [1, 0, 0, 0, 0, 0, 0, 0], k: 5, within: { scope: 'chunks-of-sources', sourceIds: Array.from({ length: 300 }, (_, i) => `s-${i}`) } }),
        ).rejects.toMatchObject({ reason: 'INVALID_QUERY' });
    });
    it('the in-process backend, which holds no source rows, refuses the filter rather than ignore it', async () => {
        await expect(repo.search(db, 'ws-1', { embeddingRevision: revision, embedding: [1, 0, 0, 0, 0, 0, 0, 0], k: 5, within: { scope: 'chunks-of-sources', sourceIds: ['s-1'] } })).rejects.toMatchObject({ reason: 'INVALID_QUERY' });
    });
    it('reports which sources hold a vector of a revision (an ingestion resume embeds only the rest)', async () => {
        await repo.upsert(db, 'ws-1', [{ sourceModel: 'SourceChunk', sourceId: 'c-1', chunkIndex: 0, embeddingRevision: revision, bookId: null, contentHash: 'a'.repeat(64), embedding: [1, 0, 0, 0, 0, 0, 0, 0] }]);
        expect(await repo.presentSources(db, 'ws-1', revision, 'SourceChunk', ['c-1', 'c-2'])).toEqual(['c-1']);
    });
});
