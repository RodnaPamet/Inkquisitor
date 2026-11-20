/**
 * The vector store's source guard under concurrency (Phase 2.2; issue #23,
 * item 1): `vector_embedding_require_source`, attached to `Question`.
 *
 *   a vector written while its question exists holds the question against a
 *   concurrent delete until it commits, and the delete's trigger then takes it
 *   (without the lock the vector would outlive its question);
 *
 *   a vector write never WAITS on a question being deleted: a multi-row write
 *   that locked one question while a cascade holds another and waits on the
 *   first would otherwise deadlock (40P01), rolling back the delete or the
 *   write. The guard skips a locked source row instead, refusing the plain
 *   write (`VECTOR_SOURCE_MISSING`) with the delete left to finish.
 *
 * Two real transactions on two connections, ordered by watching
 * `pg_stat_activity` for the one that waits on a lock.
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { getVectorRepository } from '@/app-layer/repositories/vector.repository';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { startInterview } from '@/app-layer/usecases/interviews';
import { questionRecord } from '@/app-layer/usecases/question-embeddings';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

jest.setTimeout(30_000);
afterAll(() => prisma.$disconnect());

const REVISION = 'source-guard-test:d4:p00000000';
const UNIT = [1, 0, 0, 0];

let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount());
    bookId = (await createBook(ctx, { title: 'Two Tables' })).id;
});

/** Two questions of a fresh session (no vectors filed: no embedder). */
async function twoQuestions(): Promise<[string, string]> {
    const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Guarded ${Math.random().toString(36).slice(2, 8)}` });
    const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 1, detail: 2 }, { generator: fakeGenerator(), embedder: null });
    const ids = view.round!.questions.map((q) => q.id);
    if (ids.length < 2) throw new Error('expected two questions');
    return [ids[0], ids[1]];
}

/** Resolves once some backend is waiting on a lock (the delete, blocked by the vector's KEY SHARE). */
async function someoneWaitsOnALock(): Promise<void> {
    for (let i = 0; i < 100; i++) {
        const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (row.n > 0) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('nothing ever waited on a lock');
}

function gate(): { wait: Promise<void>; open: () => void } {
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    return { wait, open };
}

const vectorsOf = (id: string) => prisma.vectorEmbedding.count({ where: { sourceModel: 'Question', sourceId: id } });

it('a vector written while its question exists holds the question: a concurrent delete waits, then takes the vector', async () => {
    const [q1] = await twoQuestions();
    const written = gate();
    const release = gate();
    const writer = runInWorkspaceContext(ctx, async (db) => {
        await getVectorRepository().upsert(db, ctx.workspaceId, [questionRecord(ctx.workspaceId, q1, bookId, 'held', UNIT, REVISION)]);
        written.open();
        await release.wait;
    });
    await written.wait;
    // A Prisma query is lazy: `.then` sends it now, not when it is awaited.
    const deleter = prisma.$executeRaw`DELETE FROM "Question" WHERE "id" = ${q1}`.then((n) => n);
    await someoneWaitsOnALock();
    release.open();
    await writer;
    expect(await deleter).toBe(1);
    expect(await vectorsOf(q1)).toBe(0);
});

it('a vector write never waits on a question a cascade is deleting, so the two cannot deadlock', async () => {
    const [q1, q2] = await twoQuestions();
    const firstWritten = gate();
    const secondWrite = gate();
    // The writer files question 1's vector (KEY SHARE on question 1) and keeps its transaction open.
    const writer = runInWorkspaceContext(ctx, async (db) => {
        await getVectorRepository().upsert(db, ctx.workspaceId, [questionRecord(ctx.workspaceId, q1, bookId, 'first', UNIT, REVISION)]);
        firstWritten.open();
        await secondWrite.wait;
        // Question 2 is now locked by the deleter, which waits on question 1.
        await getVectorRepository().upsert(db, ctx.workspaceId, [questionRecord(ctx.workspaceId, q2, bookId, 'second', UNIT, REVISION)]);
    });
    const writerOutcome = writer.then(
        () => 'committed',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await firstWritten.wait;
    // The deleter takes question 2, then waits on the writer's lock on question 1.
    const deleter = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM "Question" WHERE "id" = ${q2}`;
        await tx.$executeRaw`DELETE FROM "Question" WHERE "id" = ${q1}`;
    });
    const deleterOutcome = deleter.then(
        () => 'committed',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await someoneWaitsOnALock();
    secondWrite.open();

    const [w, d] = await Promise.all([writerOutcome, deleterOutcome]);
    // Neither side was chosen as a deadlock victim: the delete went through, and
    // the write was refused for the question it could not see.
    expect(d).toBe('committed');
    expect(w).toMatch(/VECTOR_SOURCE_MISSING/);
    expect(w).not.toMatch(/deadlock/i);
    expect(await vectorsOf(q1)).toBe(0);
    expect(await vectorsOf(q2)).toBe(0);
    expect(await prisma.question.count({ where: { id: { in: [q1, q2] } } })).toBe(0);
});
