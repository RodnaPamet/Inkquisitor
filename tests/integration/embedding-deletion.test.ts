/**
 * EMBEDDINGS ARE DERIVATIVES OF ENCRYPTED-AT-REST COLUMNS (Phase 4.H-a, roadmap
 * 4.H item 4; `docs/rls-workspace-isolation.md`, "Vectors"): a vector is
 * computed from author text that is stored encrypted in its source row, and it
 * lives exactly as long as that row. For EVERY vector source model — each table
 * whose migration attaches `vector_embedding_delete_with_source('<Model>')`,
 * read from the migrations, so a new one fails here until it is covered — the
 * row's vectors are made through the product's own path and deleted with the row
 * through the product's own deletion (or its cascade). Nothing reaches a network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prisma } from '@/lib/db';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, deleteElement } from '@/app-layer/usecases/bible-elements';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { startInterview } from '@/app-layer/usecases/interviews';
import { removeSource } from '@/app-layer/usecases/source-library';
import { executeFactLayerDispatch } from '@/app-layer/usecases/fact-layer-dispatch';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { ageExtractor, extractPending } from '../helpers/facts';
import { ingestText } from '../helpers/sources';
import { createAccount, workspaceCtx } from '../helpers/workspaces';
import { repoRelativeFiles } from '../helpers/repo-files';

afterAll(() => prisma.$disconnect());

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Every model a migration attaches the delete-with-source trigger to (the vector source models). */
function vectorSourceModels(): string[] {
    const out = new Set<string>();
    for (const rel of repoRelativeFiles().filter((f) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(f))) {
        const file = path.join(REPO_ROOT, rel);
        for (const hit of fs.readFileSync(file, 'utf8').matchAll(/EXECUTE FUNCTION vector_embedding_delete_with_source\('([A-Za-z]+)'\)/g)) out.add(hit[1]);
    }
    return [...out].sort();
}

async function vectorsOf(model: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return runWithoutRls({ reason: 'test' }, async (db) => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "VectorEmbedding" WHERE "sourceModel" = ${model} AND "sourceId" = ANY(${[...ids]}::text[])`)[0].n));
}

const covered = new Set<string>();
afterAll(() => {
    // Every vector source model the migrations name was proved here (a new one must join this file).
    expect([...covered].sort()).toEqual(vectorSourceModels());
});

describe('a vector is deleted with its source row, for every vector source model (roadmap 4.H item 4)', () => {
    it('BibleElement, StoryFact, Question and Answer: an element’s deletion takes its vectors, its facts’, its questions’ and their answers’', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Derived' })).id;
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren is 12 years old. Wren keeps the lock at Harrow Weir.' });
        await extractPending(ctx, bookId, ageExtractor('Wren'));
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder });
        const q = view.round!.questions.find((x) => x.kind === 'OPEN')!;
        await answerQuestion(ctx, bookId, view.session.id, q.id, { text: 'She keeps the tide table by lamplight.' });
        // The background embedding of the element, its facts and the answer (the minutely dispatcher's work).
        await executeFactLayerDispatch({ enqueue: async () => undefined, extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });

        const ids = await runWithoutRls({ reason: 'test' }, async (db) => ({
            facts: (await db.storyFact.findMany({ where: { elementId: el.id }, select: { id: true } })).map((f) => f.id),
            questions: (await db.question.findMany({ where: { elementId: el.id }, select: { id: true } })).map((x) => x.id),
            answers: (await db.answer.findMany({ where: { question: { elementId: el.id }, status: 'ANSWERED' }, select: { id: true } })).map((a) => a.id),
        }));
        const before = {
            BibleElement: await vectorsOf('BibleElement', [el.id]),
            StoryFact: await vectorsOf('StoryFact', ids.facts),
            Question: await vectorsOf('Question', ids.questions),
            Answer: await vectorsOf('Answer', ids.answers),
        };
        // Each model holds vectors before (so the deletion below is not vacuous).
        for (const [model, n] of Object.entries(before)) expect({ model, held: n > 0 }).toEqual({ model, held: true });

        await deleteElement(ctx, bookId, el.id);
        const after = {
            BibleElement: await vectorsOf('BibleElement', [el.id]),
            StoryFact: await vectorsOf('StoryFact', ids.facts),
            Question: await vectorsOf('Question', ids.questions),
            Answer: await vectorsOf('Answer', ids.answers),
        };
        expect(after).toEqual({ BibleElement: 0, StoryFact: 0, Question: 0, Answer: 0 });
        for (const model of Object.keys(after)) covered.add(model);
    }, 60_000);

    it('SourceChunk and a source’s StoryFacts: removing the source takes its chunks’ vectors and its facts’', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Removed' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara' });
        const sourceId = await ingestText(ctx, { kind: 'book', bookId }, 'Mara wants the salt road reopened before winter.');
        await executeFactLayerDispatch({ enqueue: async () => undefined, extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });
        const ids = await runWithoutRls({ reason: 'test' }, async (db) => ({
            chunks: (await db.sourceChunk.findMany({ where: { sourceId }, select: { id: true } })).map((c) => c.id),
            facts: (await db.storyFact.findMany({ where: { sourceId }, select: { id: true } })).map((f) => f.id),
        }));
        expect(await vectorsOf('SourceChunk', ids.chunks)).toBe(ids.chunks.length);
        expect(await vectorsOf('StoryFact', ids.facts)).toBeGreaterThan(0);
        await removeSource(ctx, sourceId);
        expect(await vectorsOf('SourceChunk', ids.chunks)).toBe(0);
        expect(await vectorsOf('StoryFact', ids.facts)).toBe(0);
        covered.add('SourceChunk');
        covered.add('StoryFact');
    }, 60_000);
});
