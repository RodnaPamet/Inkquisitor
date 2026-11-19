/**
 * Integration fixtures for the vector store (subphase 2.0): vectors written
 * through the product's own seam (`getVectorRepository()`, inside
 * `runInWorkspaceContext`), embedded by the deterministic stub provider, so a
 * fixture row is exactly what a caller would leave and no test reaches a
 * network.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { getVectorRepository, type InWorkspace, type VectorRecord } from '@/app-layer/repositories/vector.repository';
import { vectorContentHash } from '@/lib/ai/embeddings/content-hash';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';

export const stub = new StubEmbeddingProvider();

/** Opens each transaction a rebuild needs, under the workspace's RLS. */
export function inWorkspace(ctx: WorkspaceRequestContext): InWorkspace {
    return (fn) => runInWorkspaceContext(ctx, fn);
}

/** A record for `text`, embedded by the stub. */
export async function recordFor(
    text: string,
    key: { sourceModel?: string; sourceId: string; chunkIndex?: number; bookId: string | null },
): Promise<VectorRecord> {
    const out = await stub.embed([text], { inputType: 'passage' });
    if (!out.ok) throw new Error(`stub embedding failed: ${out.reason}`);
    return {
        sourceModel: key.sourceModel ?? 'Question',
        sourceId: key.sourceId,
        chunkIndex: key.chunkIndex ?? 0,
        embeddingRevision: stub.revision,
        bookId: key.bookId,
        contentHash: vectorContentHash(text),
        embedding: out.vectors[0],
    };
}

/** The stub's query vector for `text`. */
export async function queryFor(text: string): Promise<readonly number[]> {
    const out = await stub.embed([text], { inputType: 'query' });
    if (!out.ok) throw new Error(`stub embedding failed: ${out.reason}`);
    return out.vectors[0];
}

/** One vector in the workspace, for a fixture that needs a row in every scoped table. */
export async function seedVectors(ctx: WorkspaceRequestContext, bookId: string, marker = 'seed'): Promise<void> {
    const record = await recordFor(`What does the seed character ${marker} want?`, { sourceId: `seed-${marker}`, bookId });
    await runInWorkspaceContext(ctx, (db) => getVectorRepository().upsert(db, ctx.workspaceId, [record]));
}
