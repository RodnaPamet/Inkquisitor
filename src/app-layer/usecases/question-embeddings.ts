/**
 * Question embeddings: the vector store's first source table (Phase 2.2,
 * on the 2.0 store, decision D8).
 *
 * Every question asked is embedded (the 2.0 provider: the stub in
 * development and test, TEI inside the deployment in production) and filed
 * under `sourceModel: 'Question'` with its book, so a later round can find a
 * reworded repeat of it anywhere in the book: `findQuestionNeighbours` asks
 * the store for each candidate's nearest asked questions, and deduplication
 * (`src/lib/interview/dedupe.ts`) weighs the scores. Questions are embedded
 * as `query` on both sides (a question compared with a question), never
 * mixed with a passage embedding.
 *
 * Text never enters the store: a record is the question's id, its book, the
 * keyed `vectorContentHash` of its text and the vector. A question's vectors
 * go with it (`vector_embedding_delete_with_source('Question')`), and the
 * store refuses — or, in a rebuild, skips — a vector for a question that no
 * longer exists (`vector_embedding_require_source`, migration
 * 20261119600000_interview_engine), so `rebuildQuestionEmbeddings`, which
 * reads its source outside the transactions that write, cannot bring a
 * deleted question's vector back (issue #23, item 1). Its source is read
 * lazily, page by page, after the rebuild has drawn its start point (item 2).
 *
 * An embedding failure DEGRADES: the question is stored without a vector and
 * deduplication keeps its lexical signals. A missing provider (production
 * refuses the stub, and TEI is not configured) is the same.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { QuestionRepository } from '@/app-layer/repositories/interview.repository';
import { getVectorRepository, type VectorRecord } from '@/app-layer/repositories/vector.repository';
import { getEmbeddingProvider, MAX_EMBED_BATCH, vectorContentHash, type EmbeddingProvider } from '@/lib/ai/embeddings';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import type { EmbeddingNeighbour } from '@/lib/interview/dedupe';
import { logger } from '@/lib/observability/logger';

export const QUESTION_SOURCE_MODEL = 'Question';
/** Nearest asked questions read per candidate. */
export const NEIGHBOURS_PER_CANDIDATE = 5;

export interface QuestionEmbedder {
    readonly revision: string;
    /** One vector per text, or null where the provider failed (never throws). */
    embed(texts: readonly string[]): Promise<Array<readonly number[] | null>>;
}

export function embedderFrom(provider: EmbeddingProvider): QuestionEmbedder {
    return {
        revision: provider.revision,
        async embed(texts) {
            const out: Array<readonly number[] | null> = [];
            for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH) {
                const batch = texts.slice(i, i + MAX_EMBED_BATCH);
                const result = await provider.embed(batch, { inputType: 'query' });
                if (result.ok) out.push(...result.vectors);
                else {
                    logger.warn('interview.question_embedding_failed', { component: 'interview', reason: result.reason, count: batch.length });
                    out.push(...batch.map(() => null));
                }
            }
            return out;
        },
    };
}

/** The deployment's question embedder, or null when no provider is configured (deduplication stays lexical). */
export function defaultQuestionEmbedder(): QuestionEmbedder | null {
    const choice = getEmbeddingProvider();
    if (!choice.ok) {
        logger.warn('interview.question_embedder_unavailable', { component: 'interview', reason: choice.reason });
        return null;
    }
    return embedderFrom(choice.provider);
}

export function questionRecord(workspaceId: string, questionId: string, bookId: string, text: string, vector: readonly number[], revision: string): VectorRecord {
    return { sourceModel: QUESTION_SOURCE_MODEL, sourceId: questionId, chunkIndex: 0, embeddingRevision: revision, bookId, contentHash: vectorContentHash(workspaceId, text), embedding: vector };
}

/** File questions' vectors (after the round's questions committed; the store refuses one whose question is gone). */
export async function upsertQuestionVectors(db: PrismaTx, ctx: WorkspaceRequestContext, records: readonly VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await getVectorRepository().upsert(db, ctx.workspaceId, records);
}

/** Each candidate vector's nearest questions of the book, and the targets of those the caller did not already read. */
export async function findQuestionNeighbours(
    ctx: WorkspaceRequestContext,
    bookId: string,
    revision: string,
    vectors: ReadonlyMap<number, readonly number[]>,
    known: ReadonlySet<string>,
): Promise<{
    neighbours: Map<number, EmbeddingNeighbour[]>;
    neighbourTargets: Map<string, { elementId: string; targetsFieldKeys: string[] }>;
}> {
    return runInWorkspaceContext(ctx, async (db) => {
        const neighbours = new Map<number, EmbeddingNeighbour[]>();
        for (const [index, embedding] of vectors) {
            const matches = await getVectorRepository().search(db, ctx.workspaceId, {
                embeddingRevision: revision,
                embedding,
                k: NEIGHBOURS_PER_CANDIDATE,
                bookId,
                sourceModels: [QUESTION_SOURCE_MODEL],
            });
            neighbours.set(
                index,
                matches.map((m) => ({ questionId: m.sourceId, score: m.score })),
            );
        }
        const unknown = [...new Set([...neighbours.values()].flat().map((n) => n.questionId))].filter((id) => !known.has(id));
        const targets = await QuestionRepository.targetsOf(db, ctx.workspaceId, bookId, unknown);
        return { neighbours, neighbourTargets: new Map(targets.map((t) => [t.id, { elementId: t.elementId, targetsFieldKeys: t.targetsFieldKeys }])) };
    });
}

const REBUILD_PAGE = 64;

/**
 * Re-embed every question of the workspace under the provider's current
 * revision (a model change), making that revision's question vectors exactly
 * the questions that exist. `bible.edit`; an operator's act, not an author's.
 */
export async function rebuildQuestionEmbeddings(ctx: WorkspaceRequestContext, deps: { embedder?: QuestionEmbedder | null } = {}) {
    await assertPermission(ctx, 'bible.edit');
    const embedder = deps.embedder === undefined ? defaultQuestionEmbedder() : deps.embedder;
    if (!embedder) return { rebuilt: false as const, reason: 'NO_EMBEDDING_PROVIDER' as const };

    // A rebuild never writes from a partial read: a question the provider could
    // not embed stops it (a source that throws leaves a superset and deletes
    // nothing), so a failing provider cannot erase the index.
    async function* source(): AsyncGenerator<VectorRecord[]> {
        let after: string | null = null;
        for (;;) {
            const page = await runInWorkspaceContext(ctx, (db) => QuestionRepository.pageForEmbedding(db, ctx.workspaceId, after, REBUILD_PAGE));
            if (page.length === 0) return;
            const vectors = await embedder!.embed(page.map((q) => q.text));
            yield page.map((q, i) => {
                const v = vectors[i];
                if (!v) throw new Error('QUESTION_EMBEDDING_FAILED: the rebuild stopped; nothing was deleted');
                return questionRecord(ctx.workspaceId, q.id, q.bookId, q.text, v, embedder!.revision);
            });
            after = page[page.length - 1].id;
        }
    }

    // Rule 6: an empty source erases the index only when the workspace really has no question.
    const none = (await runInWorkspaceContext(ctx, (db) => QuestionRepository.pageForEmbedding(db, ctx.workspaceId, null, 1))).length === 0;
    const outcome = await getVectorRepository().rebuildRevision((fn) => runInWorkspaceContext(ctx, fn), ctx.workspaceId, embedder.revision, source(), {
        allowEmpty: none,
    });
    return { rebuilt: true as const, ...outcome };
}
