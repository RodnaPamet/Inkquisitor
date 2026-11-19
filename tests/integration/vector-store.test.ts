/**
 * The vector store against a real PostgreSQL with pgvector (subphase 2.0).
 *
 * Through the product's own seam (`getVectorRepository()` inside
 * `runInWorkspaceContext`, vectors from the deterministic stub provider):
 * upsert and cosine search ordering, the book and source-model scopes,
 * content-hash idempotence, deletion with the source (the repository call,
 * the attachable trigger, the book's cascade), and a rebuild. Below the seam,
 * the table's own guarantees whoever writes: workspace isolation under RLS
 * (app_user bound to one workspace never sees, changes or inserts another's
 * vectors), the composite book key, and the CHECKs (dimensions, zero vector,
 * content-hash format). No test reaches a network.
 *
 * The policy structure and the generic per-table probe are
 * tests/integration/rls-coverage.test.ts, which covers this table too.
 *
 * Adapted in part from inflect-compliance's
 * `tests/integration/vector-tenant-isolation.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getVectorRepository, VectorStoreError, type VectorRecord } from '@/app-layer/repositories/vector.repository';
import { deleteBook } from '@/app-layer/usecases/books';
import { purgeDeletedBooks } from '@/app-layer/usecases/book-purge';
import { vectorContentHash } from '@/lib/ai/embeddings/content-hash';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { seedBible, type SeededBible } from '../helpers/bible';
import { inWorkspace, queryFor, recordFor, stub } from '../helpers/vectors';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const repo = getVectorRepository();
const REV = stub.revision;

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
let actx: ReturnType<typeof workspaceCtx>;
let bctx: ReturnType<typeof workspaceCtx>;
let aBible: SeededBible;
let bBible: SeededBible;

beforeAll(async () => {
    a = await createAccount({ workspaceName: 'Vectors A' });
    b = await createAccount({ workspaceName: 'Vectors B' });
    actx = workspaceCtx(a);
    bctx = workspaceCtx(b);
    aBible = await seedBible(actx, 'vec-a');
    bBible = await seedBible(bctx, 'vec-b');
});

const uid = (label: string) => `${label}-${randomBytes(5).toString('hex')}`;
const cosine = (x: readonly number[], y: readonly number[]) => {
    let dot = 0;
    let nx = 0;
    let ny = 0;
    x.forEach((v, i) => {
        dot += v * y[i];
        nx += v * v;
        ny += y[i] * y[i];
    });
    return dot / Math.sqrt(nx * ny);
};

function inA<T>(fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runInWorkspaceContext(actx, fn);
}
function inB<T>(fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runInWorkspaceContext(bctx, fn);
}

async function refusal(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        if (e instanceof VectorStoreError) return e.reason;
        throw e;
    }
    throw new Error('expected a refusal');
}

/** The raw rows of one source, read as the owner (who sees every workspace). */
function rowsOf(sourceId: string) {
    return prisma.$queryRaw<Array<{ workspaceId: string; bookId: string | null; contentHash: string; updatedAt: Date; embedding: string }>>`
        SELECT "workspaceId", "bookId", "contentHash", "updatedAt", "embedding"::text AS embedding
        FROM "VectorEmbedding" WHERE "sourceId" = ${sourceId} ORDER BY "chunkIndex"`;
}

describe('the database is ready for the store', () => {
    it('carries pgvector 0.8 or later (the image the repository runs)', async () => {
        const [{ extversion }] = await prisma.$queryRaw<Array<{ extversion: string }>>`
            SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
        const [major, minor] = extversion.split('.').map(Number);
        expect(major > 0 || minor >= 8).toBe(true);
    });
});

describe('upsert and search through the seam', () => {
    const texts = {
        want: 'Mara wants the ship back',
        fear: 'Mara wants the ship and the crew back',
        guild: 'Salt guild harbour meeting at dawn',
    };
    const ids = { want: uid('q-want'), fear: uid('q-fear'), guild: uid('q-guild'), element: uid('el') };

    beforeAll(async () => {
        const records = [
            await recordFor(texts.want, { sourceId: ids.want, bookId: aBible.bookId }),
            await recordFor(texts.fear, { sourceId: ids.fear, bookId: aBible.bookId }),
            await recordFor(texts.guild, { sourceId: ids.guild, bookId: aBible.bookId }),
            await recordFor(texts.want, { sourceModel: 'BibleElement', sourceId: ids.element, bookId: aBible.bookId }),
        ];
        expect(await inA((db) => repo.upsert(db, a.workspaceId, records))).toEqual({ inserted: 4, updated: 0, unchanged: 0 });
    });

    it('orders by cosine similarity: the same text first, then the text sharing the most words', async () => {
        const embedding = await queryFor(texts.want);
        const hits = await inA((db) =>
            repo.search(db, a.workspaceId, { embeddingRevision: REV, embedding, k: 3, bookId: aBible.bookId, sourceModels: ['Question'] }),
        );
        expect(hits.map((h) => h.sourceId)).toEqual([ids.want, ids.fear, ids.guild]);
        expect(hits[0].score).toBeCloseTo(1, 5);
        expect(hits[1].score).toBeGreaterThan(hits[2].score);
        // pgvector's cosine is the one the reference backend computes in memory.
        for (const [hit, text] of [
            [hits[1], texts.fear],
            [hits[2], texts.guild],
        ] as const) {
            expect(hit.score).toBeCloseTo(cosine(embedding, await queryFor(text)), 5);
        }
        expect(hits[0]).toEqual({
            sourceModel: 'Question',
            sourceId: ids.want,
            chunkIndex: 0,
            bookId: aBible.bookId,
            contentHash: vectorContentHash(texts.want),
            score: hits[0].score,
        });
    });

    it('a source-model filter and the book scope narrow the population', async () => {
        const embedding = await queryFor(texts.want);
        const elements = await inA((db) =>
            repo.search(db, a.workspaceId, { embeddingRevision: REV, embedding, k: 10, sourceModels: ['BibleElement'] }),
        );
        expect(elements.map((h) => h.sourceId)).toEqual([ids.element]);
        const otherBook = await inA((db) =>
            repo.search(db, a.workspaceId, { embeddingRevision: REV, embedding, k: 10, bookId: 'no-such-book' }),
        );
        expect(otherBook).toEqual([]);
    });

    it('lists the keys of one source, and of the revision', async () => {
        const source = await inA((db) => repo.listSourceKeys(db, a.workspaceId, REV, 'Question', ids.want));
        expect(source).toEqual([
            {
                sourceModel: 'Question',
                sourceId: ids.want,
                chunkIndex: 0,
                embeddingRevision: REV,
                bookId: aBible.bookId,
                contentHash: vectorContentHash(texts.want),
                dimensions: stub.dimensions,
            },
        ]);
        const all = await inA((db) => repo.listKeys(db, a.workspaceId, REV));
        expect(all.map((k) => k.sourceId)).toEqual(expect.arrayContaining([ids.want, ids.fear, ids.guild, ids.element]));
    });
});

describe('content-hash idempotence', () => {
    it('the same key and hash writes nothing (updatedAt and the vector stay); a new hash replaces the vector', async () => {
        const id = uid('q-idem');
        const first = await recordFor('Who taught Mara to sail?', { sourceId: id, bookId: aBible.bookId });
        expect(await inA((db) => repo.upsert(db, a.workspaceId, [first]))).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
        const [before] = await rowsOf(id);

        // The same text, re-embedded with a different vector (a caller that
        // forgot to check the hash): the stored vector stands.
        const again = { ...first, embedding: first.embedding.map((v, i) => (i === 0 ? v + 1 : v)) };
        expect(await inA((db) => repo.upsert(db, a.workspaceId, [again]))).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
        const [same] = await rowsOf(id);
        expect(same.updatedAt).toEqual(before.updatedAt);
        expect(same.embedding).toBe(before.embedding);

        const edited = await recordFor('Who taught Mara to navigate by the stars?', { sourceId: id, bookId: aBible.bookId });
        expect(await inA((db) => repo.upsert(db, a.workspaceId, [edited]))).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
        const [after] = await rowsOf(id);
        expect(after.contentHash).toBe(edited.contentHash);
        expect(after.embedding).not.toBe(before.embedding);
    });

    it("refuses a write of another dimension count into the revision's space", async () => {
        const id = uid('q-dims');
        const record: VectorRecord = { ...(await recordFor('A short question', { sourceId: id, bookId: null })), embedding: [1, 0, 0] };
        expect(await refusal(inA((db) => repo.upsert(db, a.workspaceId, [record])))).toBe('REVISION_DIMENSION_MISMATCH');
    });
});

describe('one revision, one dimension count, under concurrency', () => {
    it("two concurrent first writes of a revision with different counts: one commits, the other is refused, and the revision stays usable", async () => {
        const rev = `race-${randomBytes(4).toString('hex')}`;
        const raw = (sourceId: string, embedding: number[]): VectorRecord => ({
            sourceModel: 'Question',
            sourceId,
            chunkIndex: 0,
            embeddingRevision: rev,
            bookId: null,
            contentHash: 'c'.repeat(64),
            embedding,
        });
        let firstWrote!: () => void;
        const wrote = new Promise<void>((resolve) => {
            firstWrote = resolve;
        });
        // The first holds its transaction open after writing; the second
        // writes while the first's rows are still uncommitted.
        const results = await Promise.allSettled([
            inA(async (db) => {
                const outcome = await repo.upsert(db, a.workspaceId, [raw(uid('race2'), [1, 0])]);
                firstWrote();
                await new Promise((resolve) => setTimeout(resolve, 300));
                return outcome;
            }),
            (async () => {
                await wrote;
                return inA((db) => repo.upsert(db, a.workspaceId, [raw(uid('race3'), [1, 0, 0])]));
            })(),
        ]);
        expect(results[0].status).toBe('fulfilled');
        expect(results[1].status).toBe('rejected');
        expect(((results[1] as PromiseRejectedResult).reason as VectorStoreError).reason).toBe('REVISION_DIMENSION_MISMATCH');
        // Not wedged: the revision holds one count and still answers.
        const hits = await inA((db) => repo.search(db, a.workspaceId, { embeddingRevision: rev, embedding: [1, 0], k: 5 }));
        expect(hits).toHaveLength(1);
    });
});

describe("the seam's float bounds are the database's", () => {
    const raw = (sourceId: string, embedding: number[]): VectorRecord => ({
        sourceModel: 'Question',
        sourceId,
        chunkIndex: 0,
        embeddingRevision: 'float-bounds:d2:p00000000',
        bookId: null,
        contentHash: 'd'.repeat(64),
        embedding,
    });

    it('what the seam admits, pgvector stores: the largest 32-bit float and a subnormal', async () => {
        expect(await inA((db) => repo.upsert(db, a.workspaceId, [raw(uid('fmax'), [3.4e38, 1]), raw(uid('fsub'), [1e-40, 0])]))).toMatchObject({
            inserted: 2,
        });
    });

    it('what pgvector would refuse, the seam refuses first, by name', async () => {
        expect(await refusal(inA((db) => repo.upsert(db, a.workspaceId, [raw(uid('fbig'), [1e39, 1])])))).toBe('INVALID_RECORD');
        expect(await refusal(inA((db) => repo.upsert(db, a.workspaceId, [raw(uid('fzero'), [1e-50, 0])])))).toBe('INVALID_RECORD');
    });
});

describe('workspace isolation', () => {
    const shared = 'Where was Mara born?';
    let aId: string;

    beforeAll(async () => {
        aId = uid('q-iso');
        await inA(async (db) => repo.upsert(db, a.workspaceId, [await recordFor(shared, { sourceId: aId, bookId: aBible.bookId })]));
    });

    it("B, searching with A's exact vector, finds none of A's vectors", async () => {
        const embedding = await queryFor(shared);
        const hits = await inB((db) => repo.search(db, b.workspaceId, { embeddingRevision: REV, embedding, k: 50 }));
        expect(hits.map((h) => h.sourceId)).not.toContain(aId);
        expect(hits.every((h) => h.bookId === null || h.bookId === bBible.bookId)).toBe(true);
    });

    it("B deleting A's source id removes nothing of A's", async () => {
        expect(await inB((db) => repo.deleteSource(db, b.workspaceId, 'Question', aId))).toBe(0);
        expect(await rowsOf(aId)).toHaveLength(1);
    });

    it("the seam refuses a transaction bound to another workspace, or to none", async () => {
        // Inside A's context, naming B: the policy would show A's rows under B's name.
        expect(
            await refusal(inA(async (db) => repo.search(db, b.workspaceId, { embeddingRevision: REV, embedding: await queryFor(shared), k: 5 }))),
        ).toBe('NOT_IN_WORKSPACE_CONTEXT');
        // The owning client, outside any context: RLS would not apply at all.
        expect(
            await refusal(
                prisma.$transaction(async (db) => repo.search(db, a.workspaceId, { embeddingRevision: REV, embedding: await queryFor(shared), k: 5 })),
            ),
        ).toBe('NOT_IN_WORKSPACE_CONTEXT');
    });

    it("below the seam, app_user bound to B sees, updates and deletes none of A's vectors", async () => {
        const seen = await inB((db) => db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "VectorEmbedding" WHERE "sourceId" = ${aId}`);
        expect(seen[0].n).toBe(0);
        const updated = await inB((db) => db.$executeRaw`UPDATE "VectorEmbedding" SET "bookId" = NULL WHERE "sourceId" = ${aId}`);
        const deleted = await inB((db) => db.$executeRaw`DELETE FROM "VectorEmbedding" WHERE "sourceId" = ${aId}`);
        expect([updated, deleted]).toEqual([0, 0]);
        expect(await rowsOf(aId)).toEqual([expect.objectContaining({ workspaceId: a.workspaceId, bookId: aBible.bookId })]);
    });

    it("a vector cannot be filed under another workspace's book, even by a writer RLS does not bind", async () => {
        const record = await recordFor('Who owns the lighthouse?', { sourceId: uid('q-xbook'), bookId: bBible.bookId });
        await expect(inA((db) => repo.upsert(db, a.workspaceId, [record]))).rejects.toThrow(/VectorEmbedding_workspaceId_bookId_fkey/);
        await expect(
            prisma.$executeRaw`
                INSERT INTO "VectorEmbedding" ("id", "workspaceId", "bookId", "sourceModel", "sourceId", "chunkIndex",
                    "embeddingRevision", "dimensions", "contentHash", "embedding", "updatedAt")
                VALUES (${uid('raw')}, ${a.workspaceId}, ${bBible.bookId}, 'Question', ${uid('q-raw')}, 0, ${REV}, 3,
                    ${'a'.repeat(64)}, '[1,0,0]'::vector, now())`,
        ).rejects.toThrow(/VectorEmbedding_workspaceId_bookId_fkey/);
    });
});

describe('the CHECKs hold whoever writes', () => {
    async function rawInsert(values: { dimensions: number; embedding: string; contentHash?: string; sourceModel?: string }) {
        return prisma.$executeRaw`
            INSERT INTO "VectorEmbedding" ("id", "workspaceId", "bookId", "sourceModel", "sourceId", "chunkIndex",
                "embeddingRevision", "dimensions", "contentHash", "embedding", "updatedAt")
            VALUES (${uid('raw')}, ${a.workspaceId}, NULL, ${values.sourceModel ?? 'Question'}, ${uid('q-raw')}, 0, 'raw-check:d3:p00000000',
                ${values.dimensions}, ${values.contentHash ?? 'b'.repeat(64)}, ${values.embedding}::vector, now())`;
    }

    it('dimensions must equal vector_dims(embedding)', async () => {
        await expect(rawInsert({ dimensions: 4, embedding: '[1,0,0]' })).rejects.toThrow(/VectorEmbedding_dims_match/);
    });

    it('a zero vector is refused', async () => {
        await expect(rawInsert({ dimensions: 3, embedding: '[0,0,0]' })).rejects.toThrow(/VectorEmbedding_nonzero/);
    });

    it('a content hash must be 64 lower-case hex characters', async () => {
        await expect(rawInsert({ dimensions: 3, embedding: '[1,0,0]', contentHash: 'What does Mara want?' })).rejects.toThrow(
            /VectorEmbedding_contentHash_check/,
        );
    });

    it('a source model must be a model name', async () => {
        await expect(rawInsert({ dimensions: 3, embedding: '[1,0,0]', sourceModel: 'question; drop' })).rejects.toThrow(
            /VectorEmbedding_sourceModel_check/,
        );
    });

    it('a correct row passes (the controls above fail for their value, not the statement)', async () => {
        expect(await rawInsert({ dimensions: 3, embedding: '[1,0,0]' })).toBe(1);
    });
});

describe('a source row takes its vectors with it', () => {
    it('deleteSource removes every chunk and revision of that source, in the caller’s transaction', async () => {
        const id = uid('q-del');
        await inA(async (db) =>
            repo.upsert(db, a.workspaceId, [
                await recordFor('Chunk one of a long answer', { sourceId: id, chunkIndex: 0, bookId: aBible.bookId }),
                await recordFor('Chunk two of a long answer', { sourceId: id, chunkIndex: 1, bookId: aBible.bookId }),
            ]),
        );
        expect(await rowsOf(id)).toHaveLength(2);
        // Rolled back with the transaction that asked for it.
        await expect(
            inA(async (db) => {
                expect(await repo.deleteSource(db, a.workspaceId, 'Question', id)).toBe(2);
                throw new Error('roll back');
            }),
        ).rejects.toThrow('roll back');
        expect(await rowsOf(id)).toHaveLength(2);
        expect(await inA((db) => repo.deleteSource(db, a.workspaceId, 'Question', id))).toBe(2);
        expect(await rowsOf(id)).toEqual([]);
    });

    it('vector_embedding_delete_with_source(), attached to a source table, deletes the row’s vectors as app_user', async () => {
        const model = `VectorProbe${randomBytes(4).toString('hex')}`;
        await prisma.$executeRawUnsafe(`CREATE TABLE "${model}" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL)`);
        try {
            await prisma.$executeRawUnsafe(
                `CREATE TRIGGER "${model}_vector_embedding_delete" AFTER DELETE ON "${model}" FOR EACH ROW EXECUTE FUNCTION vector_embedding_delete_with_source('${model}')`,
            );
            const [keep, gone] = [uid('src'), uid('src')];
            await prisma.$executeRawUnsafe(`INSERT INTO "${model}" VALUES ($1, $2), ($3, $2)`, keep, a.workspaceId, gone);
            await inA(async (db) =>
                repo.upsert(db, a.workspaceId, [
                    await recordFor('kept text', { sourceModel: model, sourceId: keep, bookId: null }),
                    await recordFor('deleted text', { sourceModel: model, sourceId: gone, bookId: null }),
                ]),
            );
            // An unrelated model's vector with the same id survives: the trigger names its model.
            await inA(async (db) => repo.upsert(db, a.workspaceId, [await recordFor('other model', { sourceId: gone, bookId: null })]));

            await inA((db) => db.$executeRawUnsafe(`DELETE FROM "${model}" WHERE "id" = $1`, gone));
            const left = await prisma.$queryRaw<Array<{ sourceModel: string; sourceId: string }>>`
                SELECT "sourceModel", "sourceId" FROM "VectorEmbedding" WHERE "sourceId" IN (${keep}, ${gone}) ORDER BY "sourceModel"`;
            expect(left).toEqual([
                { sourceModel: 'Question', sourceId: gone },
                { sourceModel: model, sourceId: keep },
            ]);
        } finally {
            await prisma.$executeRawUnsafe(`DROP TABLE "${model}"`);
            await prisma.$executeRaw`DELETE FROM "VectorEmbedding" WHERE "sourceModel" = ${model}`;
        }
    });

    it('a trigger attached without its source model refuses the delete rather than guessing', async () => {
        const model = `VectorProbe${randomBytes(4).toString('hex')}`;
        await prisma.$executeRawUnsafe(`CREATE TABLE "${model}" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL)`);
        try {
            await prisma.$executeRawUnsafe(
                `CREATE TRIGGER "${model}_bad" AFTER DELETE ON "${model}" FOR EACH ROW EXECUTE FUNCTION vector_embedding_delete_with_source()`,
            );
            await prisma.$executeRawUnsafe(`INSERT INTO "${model}" VALUES ($1, $2)`, uid('src'), a.workspaceId);
            await expect(prisma.$executeRawUnsafe(`DELETE FROM "${model}"`)).rejects.toThrow(/VECTOR_SOURCE_TRIGGER_MISCONFIGURED/);
        } finally {
            await prisma.$executeRawUnsafe(`DROP TABLE "${model}"`);
        }
    });

    it("purging a deleted book deletes its vectors (the composite key's cascade), and no other book's", async () => {
        const doomed = await seedBible(actx, 'vec-doomed');
        const id = uid('q-book');
        await inA(async (db) => repo.upsert(db, a.workspaceId, [await recordFor('A question about a doomed book', { sourceId: id, bookId: doomed.bookId })]));
        const otherBefore = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM "VectorEmbedding" WHERE "bookId" = ${aBible.bookId}`;
        expect(await rowsOf(id)).toHaveLength(1);
        // Deleting a book is soft (1.H); its purge, 30 days on, takes the vectors.
        await deleteBook(actx, doomed.bookId);
        expect(await rowsOf(id)).toHaveLength(1);
        // 31 days on (the row's deletion back-dated as the superuser; the database refuses an earlier purge).
        await prisma.book.update({ where: { id: doomed.bookId }, data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
        await purgeDeletedBooks();
        expect(await rowsOf(id)).toEqual([]);
        const otherAfter = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM "VectorEmbedding" WHERE "bookId" = ${aBible.bookId}`;
        expect(otherAfter[0].n).toBe(otherBefore[0].n);
    });
});

describe('a rebuild makes a revision exactly what the source yields', () => {
    it('keeps what it confirms, writes what is new, deletes what the source no longer yields — in this revision only', async () => {
        const rev2 = 'rebuild-test:d64:p00000000';
        const as = (r: VectorRecord): VectorRecord => ({ ...r, embeddingRevision: rev2 });
        const [one, two, three] = [uid('r1'), uid('r2'), uid('r3')];
        const r1 = as(await recordFor('rebuild one', { sourceId: one, bookId: aBible.bookId }));
        const r2 = as(await recordFor('rebuild two', { sourceId: two, bookId: aBible.bookId }));
        const r3 = as(await recordFor('rebuild three', { sourceId: three, bookId: aBible.bookId }));
        await inA((db) => repo.upsert(db, a.workspaceId, [r1, r2]));
        // B's rows of the same revision are not A's rebuild's to judge.
        const bRow = as(await recordFor('rebuild B', { sourceId: uid('rb'), bookId: bBible.bookId }));
        await inB((db) => repo.upsert(db, b.workspaceId, [bRow]));

        const outcome = await repo.rebuildRevision(inWorkspace(actx), a.workspaceId, rev2, [[r1], [r3]]);
        expect(outcome).toEqual({ inserted: 1, updated: 0, unchanged: 1, deleted: 1, seen: 2 });
        expect((await inA((db) => repo.listKeys(db, a.workspaceId, rev2))).map((k) => k.sourceId).sort()).toEqual([one, three].sort());
        expect(await inB((db) => repo.listKeys(db, b.workspaceId, rev2))).toHaveLength(1);

        // Re-running it is a no-op.
        expect(await repo.rebuildRevision(inWorkspace(actx), a.workspaceId, rev2, [[r1, r3]])).toEqual({
            inserted: 0,
            updated: 0,
            unchanged: 2,
            deleted: 0,
            seen: 2,
        });
    });
});
