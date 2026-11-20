/**
 * Fixtures for the research agent (Phase 2.6): a FAKE WEB streamed as the
 * Messages API streams the server tools' own blocks, and a seeded run made
 * through the product's own usecases. No model is called and nothing reaches a
 * network: the SDK is handed the fake as its fetch (`clientForRun`'s seam).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { attachResearchSource, createResearchBrief, dispatchResearchRun } from '@/app-layer/usecases/research-briefs';
import { executeResearchRun } from '@/app-layer/usecases/research-run';
import { stubMessagesFetch } from '@/lib/ai/model-stub';
import { defaultResearcher } from '@/lib/research/model-seam';
import type { ResearchGateVerdict } from '@/lib/research/record-gate';
import { setFakeApiKey } from './fake-anthropic';

export { gatherEvents, type FakePage } from './fake-web';

export const MOUNTED_GATE = async (): Promise<ResearchGateVerdict> => ({ mounted: true, recordKind: 'structural' });
export const CLEAN_SCAN = async () => ({ status: 'CLEAN' as const, engine: 'test', durationMs: 1 });

/**
 * A run of a brief through the product's own usecases, its model calls answered
 * by the loopback stub (`stubMessagesFetch`, D13) handed as the SDK's fetch:
 * one search, one fetched page, a finding per source, an ADD into the scope
 * element's first empty field. A file is attached, so an UPLOAD citation exists.
 */
export async function seedResearchRun(ctx: WorkspaceRequestContext, bookId: string, elementId: string, question = 'How did medieval falconers train hawks?') {
    const undo = setFakeApiKey();
    try {
        return await seed(ctx, bookId, elementId, question);
    } finally {
        undo();
    }
}

async function seed(ctx: WorkspaceRequestContext, bookId: string, elementId: string, question: string) {
    const brief = await createResearchBrief(ctx, bookId, { question, purpose: 'A falconer in my story needs believable training methods.', scopeElementIds: [elementId], depth: 'QUICK' });
    await attachResearchSource(
        ctx,
        bookId,
        brief.id,
        { bytes: new TextEncoder().encode('Falconers kept hawks hooded in the dark to keep them calm. A hooded hawk rested quietly on the fist.'), mediaType: 'text/plain', filename: 'falconry-notes.txt' },
        { scan: CLEAN_SCAN },
    );
    const { runId } = await dispatchResearchRun(ctx, bookId, brief.id, { gate: MOUNTED_GATE, enqueue: async () => undefined });
    const result = await executeResearchRun({ workspaceId: ctx.workspaceId, runId }, { gate: MOUNTED_GATE, researcher: (c) => defaultResearcher(c, { fetch: stubMessagesFetch as typeof fetch }) });
    return { briefId: brief.id, runId, result };
}
