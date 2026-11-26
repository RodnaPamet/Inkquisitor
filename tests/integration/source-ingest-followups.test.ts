/**
 * Issue #57's ingestion follow-ups, fixed in Phase 4.1 where the fact layer
 * touches the code, against a real PostgreSQL (the model scripted or the
 * loopback stub; nothing reaches a network):
 *
 *   1  a first pass whose embedding failed is embedded by the resume
 *   2  a chunk that repeats a sentence of the prompt is marked unreadable, named, and the rest completes
 *   5  a call's cost is counted even when writing its result fails
 *   6  the worker's shutdown aborts a running ingestion (STOPPED ABORTED, resumable)
 *
 * (3, the vector post-filter, is fact-layer.test.ts and the unit suite; 4 and 7 are 4.H's.)
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { dispatchIngestion, getSource, uploadSource } from '@/app-layer/usecases/source-library';
import { executeSourceIngest } from '@/app-layer/usecases/source-ingest';
import { getVectorRepository } from '@/app-layer/repositories/vector.repository';
import { StoryFactRepository } from '@/app-layer/repositories/source.repository';
import { abortRunningJobs, jobShutdownSignal, _resetJobShutdownSignal } from '@/app-layer/jobs/shutdown-signal';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import type { EmbeddingProvider } from '@/lib/ai/embeddings';
import { stubMessagesFetch } from '@/lib/ai/model-stub';
import type { ExtractResult, FactExtractor } from '@/lib/sources/extractor';
import { defaultFactExtractor } from '@/lib/sources/model-seam';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { CLEAN_SCAN } from '../helpers/sources';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());
let undoKey: () => void;
beforeAll(() => {
    undoKey = setFakeApiKey();
});
afterAll(() => undoKey());

type Ctx = ReturnType<typeof workspaceCtx>;
const stubExtractor = (ctx: Ctx) => defaultFactExtractor(ctx, { fetch: stubMessagesFetch as typeof fetch });
const deps = { scan: CLEAN_SCAN, enqueue: async () => undefined };

function draft(chapters: number): Uint8Array {
    const parts: string[] = [];
    for (let i = 1; i <= chapters; i++) parts.push(`Chapter ${i}`, `Wren wants to find the lighthouse keeper number ${i}.`, Array.from({ length: 700 }, (_, k) => `filler${k}`).join(' ') + '.');
    return new TextEncoder().encode(parts.join('\n\n'));
}

async function uploaded(chapters: number) {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title: 'Follow-ups' })).id;
    const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: draft(chapters), filename: 'draft.txt' }, deps);
    await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, deps);
    return { ctx, bookId, sourceId: source.id };
}

async function chunkRows(sourceId: string) {
    return runWithoutRls({ reason: 'test' }, (db) => db.sourceChunk.findMany({ where: { sourceId }, orderBy: { position: 'asc' }, select: { id: true, extractedAt: true, unreadableReason: true } }));
}

const failingEmbedder = (): EmbeddingProvider => {
    const real = new StubEmbeddingProvider();
    return { revision: real.revision, dimensions: real.dimensions, embed: async () => ({ ok: false as const, reason: 'PROVIDER_UNAVAILABLE' as const }) } as unknown as EmbeddingProvider;
};

it('#57.1 a first pass whose embedding failed is embedded by the resume', async () => {
    const { ctx, sourceId } = await uploaded(2);
    let calls = 0;
    const ceilingAfterOne = (): FactExtractor => ({
        async extract(request, signal): Promise<ExtractResult> {
            if (++calls === 2) return { ok: false, failure: 'WORKSPACE_CEILING', errorCode: 'CEILING', tokensUsed: 0, costMicroUsd: 0, callIds: [] };
            return stubExtractor(ctx).extract(request, signal);
        },
    });
    expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId }, { extractor: ceilingAfterOne, embedder: failingEmbedder })).outcome).toBe('CEILING');
    const revision = new StubEmbeddingProvider().revision;
    const ids = (await chunkRows(sourceId)).map((c) => c.id);
    const present = () => runInWorkspaceContext(ctx, (db) => getVectorRepository().presentSources(db, ctx.workspaceId, revision, 'SourceChunk', ids));
    expect(await present()).toEqual([]);
    // The resume (the author confirms the rest) embeds what the first pass could not.
    const source = await getSource(ctx, sourceId);
    await dispatchIngestion(ctx, sourceId, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, deps).catch(async (err: { details?: { worstCaseMicroUsd?: number } }) => {
        await dispatchIngestion(ctx, sourceId, { confirmWorstCaseMicroUsd: err.details?.worstCaseMicroUsd ?? 0 }, deps);
    });
    expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId }, { extractor: () => stubExtractor(ctx), embedder: () => new StubEmbeddingProvider() })).outcome).toBe('OK');
    expect((await present()).sort()).toEqual([...ids].sort());
});

it('#57.2 a chunk that repeats a sentence of the prompt is marked unreadable with its reason, and the rest completes', async () => {
    const { ctx, sourceId } = await uploaded(2);
    let calls = 0;
    const firstRefused = (): FactExtractor => ({
        async extract(request, signal): Promise<ExtractResult> {
            if (++calls === 1) return { ok: false, failure: 'PROMPT_INVALID', errorCode: 'REPEATS_PROMPT', tokensUsed: 0, costMicroUsd: 0, callIds: [] };
            return stubExtractor(ctx).extract(request, signal);
        },
    });
    const r = await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId }, { extractor: firstRefused, embedder: () => new StubEmbeddingProvider() });
    expect(r.outcome).toBe('OK');
    const chunks = await chunkRows(sourceId);
    expect(chunks[0]).toMatchObject({ unreadableReason: 'REPEATS_PROMPT' });
    expect(chunks[0].extractedAt).not.toBeNull();
    expect(chunks[1]).toMatchObject({ unreadableReason: null });
    expect(await getSource(ctx, sourceId)).toMatchObject({ status: 'DONE', chunksDone: 2 });
});

it('#57.2 any other prompt refusal (a programming error) is not taken for the text: the chunk is left for a resume', async () => {
    const { ctx, sourceId } = await uploaded(1);
    const broken = (): FactExtractor => ({ extract: async () => ({ ok: false, failure: 'PROMPT_INVALID', errorCode: 'PROMPT_INVALID', tokensUsed: 0, costMicroUsd: 0, callIds: [] }) });
    expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId }, { extractor: broken, embedder: () => new StubEmbeddingProvider() })).outcome).toBe('PARTIAL');
    expect((await chunkRows(sourceId))[0]).toMatchObject({ extractedAt: null, unreadableReason: null });
});

it('#57.5 a call’s cost is counted even when writing its result fails', async () => {
    const { ctx, sourceId } = await uploaded(1);
    const paid = (): FactExtractor => ({ extract: async (request, signal) => ({ ...(await stubExtractor(ctx).extract(request, signal)), costMicroUsd: 4_321 }) as ExtractResult });
    const spy = jest.spyOn(StoryFactRepository, 'createMany').mockRejectedValueOnce(new Error('database down'));
    try {
        expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId }, { extractor: paid, embedder: () => new StubEmbeddingProvider() })).outcome).toBe('INTERNAL');
    } finally {
        spy.mockRestore();
    }
    const spent = await runWithoutRls({ reason: 'test' }, (db) => db.source.findUnique({ where: { id: sourceId }, select: { spentMicroUsd: true } }));
    expect(Number(spent!.spentMicroUsd)).toBe(4_321);
});

it('#57.6 the worker’s shutdown aborts a running ingestion: it stops ABORTED, resumable, at its next chunk', async () => {
    _resetJobShutdownSignal();
    const { ctx, sourceId } = await uploaded(3);
    let calls = 0;
    const shutDownAfterOne = (): FactExtractor => ({
        async extract(request, signal): Promise<ExtractResult> {
            const r = await stubExtractor(ctx).extract(request, signal);
            if (++calls === 1) abortRunningJobs();
            return r;
        },
    });
    try {
        const r = await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId }, { extractor: shutDownAfterOne, embedder: () => new StubEmbeddingProvider(), signal: jobShutdownSignal() });
        expect(r.outcome).toBe('ABORTED');
        expect(calls).toBe(1);
        expect(await getSource(ctx, sourceId)).toMatchObject({ status: 'STOPPED', outcome: 'ABORTED', chunksDone: 1 });
    } finally {
        _resetJobShutdownSignal();
    }
});
