/**
 * RETRIEVAL ISOLATION (Phase 4.H-a, roadmap 4.H item 3), against a real
 * PostgreSQL: a book's context never holds another book's or another
 * workspace's text — at the QUERY level (a second book of the same workspace,
 * and a series source the book did not opt into, are excluded by the queries
 * themselves, RLS admitting them) and under RLS (another workspace's book is
 * excluded by row-level security even when a query names it).
 *
 * Every book is seeded alike, each with its own marker in every text: elements,
 * bible facts (and a contradiction), a source of its own library (a pending fact
 * and a confirmed one, its chunks embedded), an open thread. The surfaces read
 * for book A are the ones 4.0–4.4 feed a model or the author:
 *
 *   the retriever          `assembleSourceContext` (facts, passages, vector and lexical)
 *   the stress test        its canon (`readStressCanon`) and the blocks its call was sent
 *   the gap hunt           the blocks its ranking call was sent
 *   the question engine    the generators' inputs (sources, continuity, relations, the ladder) and the
 *                          question generator's request, and the round's code-worded questions
 *   the draft reading      (5.3, D35) the blocks the nightly reading of a scene was sent, and a scene interview's
 *                          request (its scene text block)
 *
 * The model steps are scripted; nothing reaches a network.
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { createThread } from '@/app-layer/usecases/continuity';
import { decideFact, listBookFacts } from '@/app-layer/usecases/source-facts';
import { setSeriesOptIn } from '@/app-layer/usecases/source-library';
import { assembleSourceContext } from '@/app-layer/usecases/source-retrieval';
import { readStressCanon } from '@/app-layer/usecases/stress-tests';
import { runGapHunt } from '@/app-layer/usecases/gap-hunts';
import { loadGeneratorInputs } from '@/app-layer/usecases/interview-generators';
import { frontierOf, loadInterviewState, requireSession } from '@/app-layer/usecases/interview-state';
import { startInterview } from '@/app-layer/usecases/interviews';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { createChapter, createScene } from '@/app-layer/usecases/manuscript';
import { saveSceneText, updateSceneMeta } from '@/app-layer/usecases/manuscript-scenes';
import { executeDraftReadDispatch } from '@/app-layer/usecases/draft-read-dispatch';
import { executeDraftRead } from '@/app-layer/usecases/draft-read';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { ageExtractor, extractPending } from '../helpers/facts';
import { MOUNTED, runStressTest, scriptedTester } from '../helpers/interrogation';
import { ingestText } from '../helpers/sources';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

jest.setTimeout(60_000);
afterAll(() => prisma.$disconnect());

type Ctx = ReturnType<typeof workspaceCtx>;

/** One book's every kind of text, each carrying `marker` (a capitalised word: the stub reads "Wren Amber" as a name). */
async function seedBook(ctx: Ctx, title: string, marker: string): Promise<{ bookId: string; wren: string; ida: string; sceneId: string }> {
    const bookId = (await createBook(ctx, { title: `${title} ${marker}`, logline: `A ${marker} logline.` })).id;
    const name = `Wren ${marker}`;
    const wren = (await createElement(ctx, bookId, { kind: 'CHARACTER', name, summary: `${name} is 12 years old. ${name} keeps the lock at Harrow Weir.` })).id;
    await extractPending(ctx, bookId, ageExtractor(name));
    // A contradiction (a pending proposal): the continuity generator's input.
    await updateElement(ctx, bookId, wren, { summary: `${name} is 13 years old. ${name} keeps the lock at Harrow Weir.`, baseVersion: 1 });
    await extractPending(ctx, bookId, ageExtractor(name));
    const ida = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Ida ${marker}`, summary: `Ida ${marker} rows the ${marker} ferry.` })).id;
    await extractPending(ctx, bookId, ageExtractor(`Ida ${marker}`));
    // The book's own library: one fact confirmed (the context's facts), one left pending (a source question).
    await ingestText(ctx, { kind: 'book', bookId }, `${name} wants the ${marker} road reopened before winter. ${name} never learned to swim in the ${marker} bay.`, `draft-${marker}.txt`);
    const facts = (await listBookFacts(ctx, bookId)).facts;
    await decideFact(ctx, facts.find((f) => f.predicate === 'WANT')!.id, 'CONFIRM');
    await createThread(ctx, bookId, { kind: 'PROMISE', title: `Who wound the ${marker} music box`, subjectElementId: wren });
    // An open thread about the plot: it lands in a field, so the continuity generator asks about it.
    const plot = (await createElement(ctx, bookId, { kind: 'PLOT', name: `The ${marker} flood`, summary: `The ${marker} flood takes the lower town.` })).id;
    await createThread(ctx, bookId, { kind: 'PROMISE', title: `Who opened the ${marker} sluice`, subjectElementId: plot });
    // Phase 5.3: a scene of the manuscript, told from Wren's point of view (the draft reading and the scene interview).
    const chapterId = (await createChapter(ctx, bookId, { title: `The ${marker} chapter` })).id;
    const sceneId = (await createScene(ctx, bookId, { chapterId, title: `The ${marker} scene` })).id;
    const saved = await saveSceneText(ctx, bookId, sceneId, { html: `<p>${name} crossed the ${marker} weir at dusk.</p>`, baseRevision: 0 });
    await updateSceneMeta(ctx, bookId, sceneId, { baseRevision: saved.revision, povElementId: wren });
    return { bookId, wren, ida, sceneId };
}

const OWN = 'Amber';
const FOREIGN = ['Bistre', 'Cobalt', 'Sepia'] as const;

/** The text of anything a surface returned or sent, and the foreign markers found in it. */
function foreignIn(value: unknown): string[] {
    const text = JSON.stringify(value);
    return FOREIGN.filter((m) => text.includes(m));
}

let ctx: Ctx;
let other: Ctx;
let a: Awaited<ReturnType<typeof seedBook>>;
let c: Awaited<ReturnType<typeof seedBook>>;

beforeAll(async () => {
    const undo = setFakeApiKey();
    try {
        ctx = workspaceCtx(await createAccount());
        other = workspaceCtx(await createAccount());
        a = await seedBook(ctx, 'The Weir', OWN);
        // The same workspace's second book: excluded by the queries alone (RLS admits it).
        await seedBook(ctx, 'The Ferry', 'Bistre');
        // Another workspace's book: excluded by row-level security too.
        c = await seedBook(other, 'The Lock', 'Cobalt');
        // A series source of the workspace that book A did not opt into, and one it did (its marker is A's own).
        await ingestText(ctx, { kind: 'series' }, 'Wren Sepia wants the Sepia guild dissolved before spring.', 'series-sepia.txt');
        const joined = await ingestText(ctx, { kind: 'series' }, `Wren ${OWN} wants the ${OWN} archive opened.`, 'series-amber.txt');
        await setSeriesOptIn(ctx, a.bookId, joined, true);
    } finally {
        undo();
    }
}, 240_000);

describe('a book’s context holds only its own text (roadmap 4.H item 3)', () => {
    it('the retriever: facts and passages, lexical and by vector — even a query worded in another book’s text', async () => {
        const stub = new StubEmbeddingProvider();
        const elements = [{ elementId: a.wren, kind: 'CHARACTER' as const, name: `Wren ${OWN}` }];
        for (const words of [`Wren ${OWN} wants the road reopened`, 'Wren Bistre wants the Bistre road reopened', 'Wren Cobalt Sepia guild']) {
            const embedded = await stub.embed([words], { inputType: 'query' });
            if (!embedded.ok) throw new Error('stub embedding failed');
            const context = await runInWorkspaceContext(ctx, async (db) => {
                // Read as app_user: row-level security is in force for every query below.
                const [{ role }] = await db.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`;
                expect(role).toBe('app_user');
                return assembleSourceContext(db, ctx, a.bookId, elements, { vector: embedded.vectors[0], revision: stub.revision });
            });
            expect(JSON.stringify(context)).toContain(OWN);
            expect(foreignIn(context)).toEqual([]);
        }
    });

    it('under RLS: another workspace asking for this book (or its own book’s elements under this book’s id) reads nothing of it', async () => {
        const stub = new StubEmbeddingProvider();
        const embedded = await stub.embed([`Wren ${OWN} wants the road reopened`], { inputType: 'query' });
        if (!embedded.ok) throw new Error('stub embedding failed');
        const fromOther = await runInWorkspaceContext(other, (db) =>
            assembleSourceContext(db, other, a.bookId, [{ elementId: a.wren, kind: 'CHARACTER', name: `Wren ${OWN}` }], { vector: embedded.vectors[0], revision: stub.revision }),
        );
        expect(JSON.stringify(fromOther)).not.toContain(OWN);
        // And this workspace naming the other workspace's book and element: nothing of it either.
        const named = await runInWorkspaceContext(ctx, (db) => assembleSourceContext(db, ctx, c.bookId, [{ elementId: c.wren, kind: 'CHARACTER', name: 'Wren Cobalt' }], { vector: embedded.vectors[0], revision: stub.revision }));
        expect(JSON.stringify(named)).not.toContain('Cobalt');
    });

    it('the stress test: its canon and the blocks its one call was sent', async () => {
        const canon = await runInWorkspaceContext(ctx, (db) => readStressCanon(db, ctx, a.bookId));
        expect(JSON.stringify(canon)).toContain(OWN);
        expect(foreignIn(canon)).toEqual([]);
        const seen: Array<ReadonlyArray<{ label: string; text: string }>> = [];
        const r = await runStressTest(ctx, a.bookId, { tester: scriptedTester({ weakPoints: [] }, seen) });
        expect(r.outcome).not.toBeNull();
        expect(seen).toHaveLength(1);
        expect(JSON.stringify(seen)).toContain(OWN);
        expect(foreignIn(seen)).toEqual([]);
    });

    it('the gap hunt: the blocks its ranking call was sent', async () => {
        const seen: Array<ReadonlyArray<{ label: string; text: string }>> = [];
        const undo = setFakeApiKey();
        try {
            await runGapHunt(ctx, a.bookId, { confirmWorstCaseMicroUsd: Number.MAX_SAFE_INTEGER }, { gate: MOUNTED, charge: () => undefined, ranker: scriptedTester({ ranking: [] }, seen) });
        } finally {
            undo();
        }
        expect(seen).toHaveLength(1);
        expect(JSON.stringify(seen)).toContain(OWN);
        expect(foreignIn(seen)).toEqual([]);
    });

    it('the question engine: every generator’s inputs, the question generator’s request and the round’s questions', async () => {
        const generator = fakeGenerator();
        const view = await startInterview(ctx, a.bookId, { scope: 'BOOK', depth: 3, detail: 5 }, { generator, embedder: stubQuestionEmbedder });
        const inputs = await runInWorkspaceContext(ctx, async (db) => {
            const session = await requireSession(db, ctx, a.bookId, view.session.id);
            const state = await loadInterviewState(db, ctx, session);
            return loadGeneratorInputs(db, ctx, session, state, frontierOf(state, session.depth));
        });
        // The inputs carry the book's own pairs, and round 1 asked from its sources and its continuity (below), so the
        // check is not vacuous.
        expect(inputs.pairs.length).toBeGreaterThan(0);
        const serialisable = { ...inputs, enabled: [...inputs.enabled], ladder: { answered: [...inputs.ladder.answered], askedInSession: [...inputs.ladder.askedInSession] }, factsHeld: [...inputs.factsHeld], heldByProposals: [...(inputs.heldByProposals ?? [])] };
        expect(JSON.stringify(serialisable)).toContain(OWN);
        expect(foreignIn(serialisable)).toEqual([]);
        expect(generator.calls.length).toBeGreaterThan(0);
        expect(foreignIn(generator.calls.map((c) => c.data))).toEqual([]);
        expect(foreignIn(view.round!.questions)).toEqual([]);
        const asked = new Set(view.round!.questions.map((q) => q.generator));
        expect(asked.has('SOURCES') || inputs.pendingFacts.length > 0).toBe(true);
        expect(asked.has('CONTINUITY') || inputs.continuity.length > 0).toBe(true);
        expect(JSON.stringify(view.round!.questions)).toContain(OWN);
    }, 60_000);

    it('the draft reading: the blocks the nightly reading of the book’s scene was sent, and a scene interview’s request (5.3, D35)', async () => {
        const queued: string[] = [];
        await executeDraftReadDispatch({ enqueue: async (_n, payload) => void queued.push((payload as { runId: string }).runId), workspaceIds: [ctx.workspaceId], nightKey: `iso-${Date.now().toString(36)}` });
        const runs = await prisma.draftReadRun.findMany({ where: { id: { in: queued } }, select: { id: true, bookId: true } });
        const runA = runs.find((r) => r.bookId === a.bookId);
        expect(runA).toBeDefined();
        const seen: Array<ReadonlyArray<{ label: string; text: string }>> = [];
        const undo = setFakeApiKey();
        try {
            await executeDraftRead(
                { workspaceId: ctx.workspaceId, runId: runA!.id },
                {
                    charge: () => undefined,
                    gate: () => ({ mounted: true, recordKind: 'structural' }),
                    nightlyCapMicroUsd: Number.MAX_SAFE_INTEGER,
                    reader: () => ({ extract: async (request) => (seen.push(request.data), { ok: true as const, output: { facts: [], threads: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] as string[] }) }),
                },
            );
        } finally {
            undo();
        }
        expect(seen).toHaveLength(1);
        expect(JSON.stringify(seen)).toContain(OWN);
        expect(foreignIn(seen)).toEqual([]);

        const generator = fakeGenerator();
        await startInterview(ctx, a.bookId, { scope: 'SCENE', sceneId: a.sceneId, depth: 2, detail: 3 }, { generator, embedder: stubQuestionEmbedder });
        expect(generator.calls.length).toBeGreaterThan(0);
        expect(JSON.stringify(generator.calls.map((c) => c.data))).toContain(OWN);
        expect(foreignIn(generator.calls.map((c) => c.data))).toEqual([]);
    });
});
