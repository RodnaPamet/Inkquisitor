/**
 * ONE WORKSPACE THAT CANNOT BE SERVED NEVER STOPS THE OTHERS (Phase 4.H-a),
 * against a real PostgreSQL. A workspace whose wrapped data key is corrupted
 * fails `runInWorkspaceContext` before its transaction opens; before 4.H-a that
 * throw ended the minutely fact-layer dispatcher and the nightly continuity
 * dispatcher for EVERY workspace. Now the workspace is skipped (logged with its
 * ids and a code, counted) and every other workspace is served — and a broken
 * workspace's backlog of embedding tasks no longer fills the dispatcher's whole
 * discovery read either.
 *
 * Nothing reaches a network: the embedder is the stub, enqueue a recorder.
 */
import { prisma, workspaceKeys } from '@/lib/db';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { executeFactLayerDispatch } from '@/app-layer/usecases/fact-layer-dispatch';
import { executeContinuityDispatch } from '@/app-layer/usecases/continuity-dispatch';
import { workspaceFailureCode } from '@/app-layer/jobs/workspace-isolation';
import { WorkspaceKeyUnavailableError } from '@/lib/security/workspace-key-manager';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { BIBLE_ELEMENT_MODEL, DISPATCH_EMBEDDINGS_MAX } from '@/lib/facts/vocabulary';
import { ageExtractor, extractPending } from '../helpers/facts';
import { nextTestNight } from '../helpers/continuity';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

type Ctx = ReturnType<typeof workspaceCtx>;

/** The keys corrupted by this file, put back after it so no other suite meets them. */
const corrupted = new Map<string, string>();

afterAll(async () => {
    for (const [workspaceId, wrapped] of corrupted) {
        await runWithoutRls({ reason: 'test' }, (db) => db.workspace.update({ where: { id: workspaceId }, data: { encryptedDek: wrapped } }));
        workspaceKeys.clear(workspaceId);
    }
    await prisma.$disconnect();
});

/** Corrupt a workspace's wrapped key (one character of its ciphertext flipped) and drop the process's cached copy. */
async function corruptKey(ctx: Ctx): Promise<void> {
    const row = await runWithoutRls({ reason: 'test' }, (db) => db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { encryptedDek: true } }));
    const wrapped = row.encryptedDek!;
    corrupted.set(ctx.workspaceId, wrapped);
    const at = Math.floor(wrapped.length * 0.6);
    const flipped = wrapped.slice(0, at) + (wrapped[at] === 'A' ? 'B' : 'A') + wrapped.slice(at + 1);
    await runWithoutRls({ reason: 'test' }, (db) => db.workspace.update({ where: { id: ctx.workspaceId }, data: { encryptedDek: flipped } }));
    workspaceKeys.clear(ctx.workspaceId);
    // The key really cannot be read now: the failure is the typed one, under the code the dispatchers count.
    const err = await workspaceKeys.getDek(ctx.workspaceId).then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkspaceKeyUnavailableError);
    expect(workspaceFailureCode(err)).toBe('WORKSPACE_KEY_UNAVAILABLE');
}

describe('the minutely fact-layer dispatcher', () => {
    it('skips a workspace whose key cannot be unwrapped and still queues and embeds every other workspace’s rows', async () => {
        const good = workspaceCtx(await createAccount());
        const broken = workspaceCtx(await createAccount());
        const goodBook = (await createBook(good, { title: 'Served' })).id;
        const brokenBook = (await createBook(broken, { title: 'Unreadable' })).id;
        const goodEl = await createElement(good, goodBook, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren keeps the lock at Harrow Weir.' });
        await createElement(broken, brokenBook, { kind: 'CHARACTER', name: 'Ida', summary: 'Ida rows the ferry.' });
        await corruptKey(broken);
        // The broken workspace's backlog: more tasks than one tick reads, all older than the good workspace's.
        const old = new Date(Date.now() - 86_400_000);
        await runWithoutRls({ reason: 'test' }, (db) =>
            db.embeddingTask.createMany({ data: Array.from({ length: DISPATCH_EMBEDDINGS_MAX + 20 }, (_, i) => ({ workspaceId: broken.workspaceId, sourceModel: BIBLE_ELEMENT_MODEL, sourceId: `backlog-${i}`, createdAt: old })) }),
        );

        const queued: Array<{ workspaceId: string; extractionId: string }> = [];
        const result = await executeFactLayerDispatch({
            enqueue: async (_name, payload) => void queued.push(payload as { workspaceId: string; extractionId: string }),
            extractionOpen: () => true,
            embedder: () => new StubEmbeddingProvider(),
            workspaceIds: [good.workspaceId, broken.workspaceId],
            now: () => new Date(Date.now() + 60_000),
        });

        // One skip for its extractions, one for its embeddings; the good workspace served on both sides.
        expect(result.workspacesSkipped).toBe(2);
        expect(queued.length).toBeGreaterThan(0);
        expect(queued.every((q) => q.workspaceId === good.workspaceId)).toBe(true);
        expect(result.embedded).toBeGreaterThan(0);
        const left = await runWithoutRls({ reason: 'test' }, async (db) => ({
            good: await db.embeddingTask.count({ where: { workspaceId: good.workspaceId, sourceId: goodEl.id } }),
            broken: await db.embeddingTask.count({ where: { workspaceId: broken.workspaceId } }),
        }));
        expect(left.good).toBe(0);
        expect(left.broken).toBe(DISPATCH_EMBEDDINGS_MAX + 21);
    }, 60_000);
});

describe('the nightly continuity dispatcher', () => {
    it('skips a book whose workspace key cannot be unwrapped and still queues every other workspace’s due book', async () => {
        const good = workspaceCtx(await createAccount());
        const broken = workspaceCtx(await createAccount());
        const books: Record<string, string> = {};
        for (const [label, ctx] of [['good', good], ['broken', broken]] as const) {
            const bookId = (await createBook(ctx, { title: `Night ${label}` })).id;
            await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ada', summary: 'Ada is 30 years old.' });
            expect(await extractPending(ctx, bookId, ageExtractor('Ada'))).toEqual(['OK']);
            books[label] = bookId;
        }
        await corruptKey(broken);

        const queued: string[] = [];
        const result = await executeContinuityDispatch({
            enqueue: async (_name, payload) => void queued.push((payload as { workspaceId: string }).workspaceId),
            workspaceIds: [good.workspaceId, broken.workspaceId],
            nightKey: nextTestNight(),
        });
        expect(result.due).toBe(2);
        expect(result.workspacesSkipped).toBe(1);
        expect(queued).toEqual([good.workspaceId]);
        const runs = await runWithoutRls({ reason: 'test' }, async (db) => ({
            good: await db.continuityRun.count({ where: { bookId: books.good } }),
            broken: await db.continuityRun.count({ where: { bookId: books.broken } }),
        }));
        expect(runs).toEqual({ good: 1, broken: 0 });
    }, 60_000);
});
