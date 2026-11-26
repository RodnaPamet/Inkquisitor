/**
 * HARDENING THE FACT LAYER (Phase 4.H-a, D31), against a real PostgreSQL. Every
 * model step is a scripted extractor; nothing reaches a network.
 *
 *   roadmap 4.H item 1   extraction is idempotent: re-running a bible version's
 *                        extraction, and a source's ingestion, writes nothing
 *   #60 item 1           a subject past `LIVE_FACTS_READ_MAX` live facts still finds
 *                        a held claim (provenance), never a unique violation and a
 *                        loop to ATTEMPTS_SPENT
 *   #60 item 2           a refused piece no longer holds the entry's baseline back:
 *                        the next version sends only what changed since
 *   #60 item 6           an ingestion that read every chunk but failed to embed is
 *                        resumable, and the resume re-embeds
 *   #57 item 4           an upload whose book is deleted while it is read writes nothing
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook, deleteBook } from '@/app-layer/usecases/books';
import { createElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { executeBibleFactExtraction, LIVE_FACTS_READ_MAX } from '@/app-layer/usecases/bible-facts';
import { FactExtractionRepository } from '@/app-layer/repositories/fact-layer.repository';
import { dispatchIngestion, uploadSource } from '@/app-layer/usecases/source-library';
import { executeSourceIngest } from '@/app-layer/usecases/source-ingest';
import { getVectorRepository } from '@/app-layer/repositories/vector.repository';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import type { EmbeddingProvider } from '@/lib/ai/embeddings';
import { AppError } from '@/lib/errors/types';
import { SOURCE_CHUNK_MODEL } from '@/lib/sources/vocabulary';
import type { ExtractResult, FactExtractor } from '@/lib/sources/extractor';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { ageExtractor, cloneFact, extractPending } from '../helpers/facts';
import { CLEAN_SCAN } from '../helpers/sources';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let undoKey: () => void;
beforeAll(() => {
    undoKey = setFakeApiKey();
});
afterAll(() => undoKey());

type Ctx = ReturnType<typeof workspaceCtx>;
const MOUNTED = () => ({ mounted: true as const, recordKind: 'structural' as const });

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, reason: (err.details as { reason?: unknown } | undefined)?.reason };
        throw err;
    }
    throw new Error('expected a refusal');
}

/** Every fact-layer row a book holds, counted: what a re-run must leave exactly as it was. */
async function factLayerRows(bookId: string) {
    return runWithoutRls({ reason: 'test' }, async (db) => {
        const facts = await db.storyFact.findMany({ where: { bookId }, select: { id: true } });
        const ids = facts.map((f) => f.id);
        return {
            facts: facts.length,
            provenance: await db.storyFactProvenance.count({ where: { factId: { in: ids } } }),
            proposals: await db.storyFactProposal.count({ where: { bookId } }),
            threadProposals: await db.storyThreadProposal.count({ where: { bookId } }),
        };
    });
}

/** Queue one DONE extraction again, as a dispatcher re-queue of a lost claim would, and run it. */
async function rerun(ctx: Ctx, extractionId: string, extractor: () => FactExtractor) {
    await runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.update({ where: { id: extractionId }, data: { status: 'QUEUED', outcome: null, startedAt: null, queuedAt: new Date() } }));
    return executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId }, { extractor, charge: () => undefined, gate: MOUNTED });
}

function result(output: unknown): ExtractResult {
    return { ok: true, output, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
}

describe('extraction is idempotent (roadmap 4.H item 1)', () => {
    it('a bible version extracted again writes no fact, provenance, proposal or thread proposal', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Twice' })).id;
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren is 12 years old. Wren keeps the lock at Harrow Weir.' });
        expect(await extractPending(ctx, bookId, ageExtractor('Wren'))).toEqual(['OK']);
        await updateElement(ctx, bookId, el.id, { summary: 'Wren is 13 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 1 });
        expect(await extractPending(ctx, bookId, ageExtractor('Wren'))).toEqual(['OK']);
        const before = await factLayerRows(bookId);
        expect(before.facts).toBeGreaterThanOrEqual(3);
        expect(before.provenance).toBeGreaterThan(0);
        expect(before.proposals).toBeGreaterThan(0);

        // Both versions run again (the newest last): nothing more is written.
        const rows = await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.listForBook(db, ctx.workspaceId, bookId, 10));
        for (const row of [...rows].reverse()) await rerun(ctx, row.id, ageExtractor('Wren'));
        expect(await factLayerRows(bookId)).toEqual(before);
    });

    it('a source ingested again writes no fact, chunk or vector, and a resume with nothing left is refused', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Read twice' })).id;
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode('# One\n\nWren never learned to swim.\n\n# Two\n\nThe weir is older than the town.'), filename: 'draft.md' }, { scan: CLEAN_SCAN });
        const extractor = (): FactExtractor => ({
            async extract(request) {
                const text = request.data.map((b) => b.text).join('\n');
                const facts = text.includes('Wren never learned to swim')
                    ? [{ subject: 'Wren', predicate: 'OTHER', object: '', statement: 'Wren never learned to swim.', quote: 'Wren never learned to swim', storyTimeFrom: '', storyTimeTo: '' }]
                    : [];
                return result({ facts });
            },
        });
        const embedder = () => new StubEmbeddingProvider();
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, { gate: MOUNTED, enqueue: async () => undefined });
        expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { extractor, embedder, gate: MOUNTED, charge: () => undefined })).outcome).toBe('OK');
        const count = () =>
            runWithoutRls({ reason: 'test' }, async (db) => ({
                facts: await db.storyFact.count({ where: { sourceId: source.id } }),
                chunks: await db.sourceChunk.count({ where: { sourceId: source.id } }),
                vectors: Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "VectorEmbedding" WHERE "sourceModel" = ${SOURCE_CHUNK_MODEL} AND "sourceId" IN (SELECT id FROM "SourceChunk" WHERE "sourceId" = ${source.id})`)[0].n),
            }));
        const before = await count();
        expect(before.facts).toBe(1);
        expect(before.vectors).toBe(before.chunks);

        expect(await refusal(dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: 0 }, { gate: MOUNTED, enqueue: async () => undefined }))).toMatchObject({ status: 409, reason: 'NOTHING_TO_INGEST' });
        // Queued again by hand (a dispatch that raced the job): the job reads nothing and writes nothing.
        await runWithoutRls({ reason: 'test' }, (db) => db.source.update({ where: { id: source.id }, data: { status: 'QUEUED', heartbeatAt: new Date() } }));
        const calls = { n: 0 };
        const counting = (): FactExtractor => ({ extract: async (r) => (calls.n++, extractor().extract(r)) });
        expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { extractor: counting, embedder, gate: MOUNTED, charge: () => undefined })).outcome).toBe('OK');
        expect(calls.n).toBe(0);
        expect(await count()).toEqual(before);
    });
});

describe('a subject past the live-fact read (#60 item 1)', () => {
    it('a claim held past LIVE_FACTS_READ_MAX gets provenance; the run ends OK, never INTERNAL', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Crowded' })).id;
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren keeps the lock at Harrow Weir.' });
        expect(await extractPending(ctx, bookId, ageExtractor('Wren'))).toEqual(['OK']);
        const held = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findFirstOrThrow({ where: { bookId, elementId: el.id }, select: { id: true, dedupeKey: true } }));
        // LIVE_FACTS_READ_MAX older live facts of the same entry about the same subject: the held claim is past the read.
        await cloneFact(held.id, LIVE_FACTS_READ_MAX, { statedEarlierMs: 86_400_000 });
        await updateElement(ctx, bookId, el.id, { summary: 'Wren is 12 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 1 });
        expect(await extractPending(ctx, bookId, ageExtractor('Wren'))).toEqual(['OK']);
        const provenance = await runWithoutRls({ reason: 'test' }, (db) => db.storyFactProvenance.count({ where: { factId: held.id } }));
        expect(provenance).toBeGreaterThanOrEqual(1);
        const twins = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.count({ where: { bookId, dedupeKey: held.dedupeKey, supersededAt: null } }));
        expect(twins).toBe(1);
    }, 30_000);
});

describe('a refused piece (#60 item 2)', () => {
    it('is not sent again with every later version: the version still becomes the baseline, and the next sends only what changed', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Poisoned' })).id;
        const sent: string[] = [];
        const extractor = (): FactExtractor => ({
            async extract(request) {
                const text = request.data.find((b) => b.label === 'entry.text')?.text ?? '';
                sent.push(text);
                if (text.includes('XQZ')) return { ok: false, failure: 'GUARD_REFUSED', errorCode: 'GUARD', tokensUsed: 0, costMicroUsd: 0, callIds: [] };
                return ageExtractor('Wren')().extract(request);
            },
        });
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren keeps the lock at Harrow Weir.', fields: [{ key: 'want', value: 'To speak the XQZ phrase to the river.' }] });
        expect(await extractPending(ctx, bookId, extractor)).toEqual(['GUARD_REFUSED']);
        const first = await runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.findFirstOrThrow({ where: { bookId }, select: { status: true } }));
        // Before 4.H-a a refusal SKIPPED the version, so it was never the baseline.
        expect(first.status).toBe('DONE');

        await updateElement(ctx, bookId, el.id, { summary: 'Wren is 12 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 1 });
        expect(await extractPending(ctx, bookId, extractor)).toEqual(['OK']);
        expect(sent).toHaveLength(2);
        expect(sent[1]).not.toContain('XQZ');
        const facts = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findMany({ where: { bookId, supersededAt: null }, select: { predicate: true } }));
        expect(facts.map((f) => f.predicate).sort()).toEqual(['AGE', 'OTHER']);
    });
});

describe('an ingestion whose embedding failed (#60 item 6)', () => {
    it('every chunk read but not embedded stops PARTIAL EMBEDDING_FAILED, resumable; the resume re-embeds without a model call', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Unindexed' })).id;
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode('Wren never learned to swim.'), filename: 'note.txt' }, { scan: CLEAN_SCAN });
        const calls = { n: 0 };
        const extractor = (): FactExtractor => ({ extract: async () => (calls.n++, result({ facts: [] })) });
        const stub = new StubEmbeddingProvider();
        const failing: EmbeddingProvider = { providerId: stub.providerId, model: stub.model, revision: stub.revision, dimensions: stub.dimensions, embed: async () => ({ ok: false, reason: 'TIMEOUT' }) };
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, { gate: MOUNTED, enqueue: async () => undefined });
        expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { extractor, embedder: () => failing, gate: MOUNTED, charge: () => undefined })).outcome).toBe('PARTIAL');
        const stopped = await runWithoutRls({ reason: 'test' }, (db) => db.source.findUniqueOrThrow({ where: { id: source.id }, select: { status: true, metrics: true } }));
        expect(stopped).toMatchObject({ status: 'STOPPED', metrics: expect.objectContaining({ errorCode: 'EMBEDDING_FAILED' }) });
        expect(calls.n).toBe(1);

        // Resumable although nothing is left to read: a zero "at most", and the resume embeds only.
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: 0 }, { gate: MOUNTED, enqueue: async () => undefined });
        expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { extractor, embedder: () => stub, gate: MOUNTED, charge: () => undefined })).outcome).toBe('OK');
        expect(calls.n).toBe(1);
        const chunkIds = await runWithoutRls({ reason: 'test' }, async (db) => (await db.sourceChunk.findMany({ where: { sourceId: source.id }, select: { id: true } })).map((c) => c.id));
        const present = await runInWorkspaceContext(ctx, (db) => getVectorRepository().presentSources(db, ctx.workspaceId, stub.revision, SOURCE_CHUNK_MODEL, chunkIds));
        expect(present.sort()).toEqual(chunkIds.sort());
        expect(await refusal(dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: 0 }, { gate: MOUNTED, enqueue: async () => undefined }))).toMatchObject({ reason: 'NOTHING_TO_INGEST' });
    });
});

describe('an upload whose book is deleted while it is read (#57 item 4)', () => {
    it('is refused in the write’s own transaction: no library and no source under the deleted book', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Going' })).id;
        // The scan runs between the first check and the write: the book is deleted there.
        const scan = async () => {
            await deleteBook(ctx, bookId);
            return CLEAN_SCAN();
        };
        const r = await refusal(uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode('Wren never learned to swim.'), filename: 'note.txt' }, { scan }));
        expect(r.status).toBe(404);
        const written = await runWithoutRls({ reason: 'test' }, async (db) => ({ libraries: await db.sourceLibrary.count({ where: { bookId } }), sources: await db.source.count({ where: { library: { bookId } } }) }));
        expect(written).toEqual({ libraries: 0, sources: 0 });
    });
});
