/**
 * Fixtures for the source library (Phase 4.0), made through the product's own
 * usecases: a book source and a series source read by the loopback stub
 * (`stubMessagesFetch`, D13), the book opted into the series source, a series
 * fact confirmed and overridden for the book — a row in every source table.
 * Nothing reaches a network.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { executeSourceIngest } from '@/app-layer/usecases/source-ingest';
import { dispatchIngestion, setSeriesOptIn, uploadSource } from '@/app-layer/usecases/source-library';
import { decideFact, listBookFacts, setFactOverride } from '@/app-layer/usecases/source-facts';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { stubMessagesFetch } from '@/lib/ai/model-stub';
import { defaultFactExtractor } from '@/lib/sources/model-seam';
import { setFakeApiKey } from './fake-anthropic';

export const CLEAN_SCAN = async () => ({ status: 'CLEAN' as const, engine: 'test', durationMs: 1 });

/** Upload `text` and read its facts with the stub. */
export async function ingestText(ctx: WorkspaceRequestContext, target: { kind: 'book'; bookId: string } | { kind: 'series' }, text: string, filename = 'notes.txt'): Promise<string> {
    const undo = setFakeApiKey();
    try {
        const source = await uploadSource(ctx, target, { bytes: new TextEncoder().encode(text), filename }, { scan: CLEAN_SCAN });
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, { enqueue: async () => undefined });
        const r = await executeSourceIngest(
            { workspaceId: ctx.workspaceId, sourceId: source.id },
            { extractor: (c) => defaultFactExtractor(c, { fetch: stubMessagesFetch as typeof fetch }), embedder: () => new StubEmbeddingProvider() },
        );
        if (r.outcome !== 'OK') throw new Error(`the source fixture ended ${String(r.outcome)}`);
        return source.id;
    } finally {
        undo();
    }
}

export async function seedSourceLibrary(ctx: WorkspaceRequestContext, bookId: string, marker: string): Promise<{ bookSourceId: string; seriesSourceId: string }> {
    const bookSourceId = await ingestText(ctx, { kind: 'book', bookId }, `Mara ${marker} wants the salt road reopened before winter.`, `draft-${marker}.txt`);
    const seriesSourceId = await ingestText(ctx, { kind: 'series' }, `Book one. Mara ${marker} wants to leave the guild for good.`, `book-one-${marker}.txt`);
    await setSeriesOptIn(ctx, bookId, seriesSourceId, true);
    const inherited = (await listBookFacts(ctx, bookId)).facts.find((f) => f.provenance.scope === 'SERIES');
    if (!inherited) throw new Error('the source fixture drew no series fact');
    await decideFact(ctx, inherited.id, 'CONFIRM');
    await setFactOverride(ctx, bookId, inherited.id, { text: `In this book Mara ${marker} stays.` });
    return { bookSourceId, seriesSourceId };
}
