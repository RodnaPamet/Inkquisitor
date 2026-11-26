/**
 * CONTINUITY: the 4.2 review's regressions (Phase 4.2, D28), against a real
 * PostgreSQL. Each case failed before its fix:
 *
 *   a nightly rule sweep naming tens of thousands of pairs (one subject's many
 *   whereabouts at one time) ran past PostgreSQL's bind-parameter limit in
 *   one query, and its writes past the transaction's timeout: the run failed
 *   every night
 *   a rejected thread came back under a reworded title (the key was the title)
 *   a book due for facts the check cannot read (an unlinked subject) ended
 *   NO_FACTS without moving its coverage, and was queued again every night
 *   the dispatcher ordered a workspace's due books by id, so books that stay due
 *   took every night's places and the rest were never reached
 *   a night stopped after its first call reported every subject still remaining
 *   a page the guard refused was sent again every night (on the way out, a paid
 *   call), and the pass never got past it
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { decideThreadProposal, getContinuityPage } from '@/app-layer/usecases/continuity';
import { executeContinuityDispatch } from '@/app-layer/usecases/continuity-dispatch';
import { decideFact, listBookFacts } from '@/app-layer/usecases/source-facts';
import { dispatchIngestion, uploadSource } from '@/app-layer/usecases/source-library';
import { executeSourceIngest } from '@/app-layer/usecases/source-ingest';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import type { FactExtractor } from '@/lib/sources/extractor';
import { CLEAN_SCAN } from '../helpers/research';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { ageExtractor, extractPending } from '../helpers/facts';
import { runNight, threadExtractor } from '../helpers/continuity';
import { CONTINUITY_PROPOSALS_PER_RUN_MAX } from '@/lib/continuity/vocabulary';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const quiet = () => ({ extract: async () => ({ ok: true as const, output: { contradictions: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] as string[] }) });

/** A three-letter tag per index (aaa, aab, …): no tag holds another, so every two places differ by the rule. */
function tag(i: number): string {
    const a = 'abcdefghijklmnopqrstuvwxyz';
    return a[Math.floor(i / 676) % 26] + a[Math.floor(i / 26) % 26] + a[i % 26];
}

describe('the nightly rule sweep at scale', () => {
    it('a subject whose many whereabouts all clash at one time raises every pair, in queries PostgreSQL accepts', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Wanderer' })).id;
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Rook' });
        const N = 190; // 17,955 pairs: past what one query could name
        await runInWorkspaceContext(ctx, async (db) => {
            const v = await db.bibleEntryVersion.findFirstOrThrow({ where: { elementId: el.id }, select: { id: true } });
            await db.storyFact.createMany({
                data: Array.from({ length: N }, (_, i) => {
                    const statement = `Rook is in Town ${tag(i)}.`;
                    return {
                        workspaceId: ctx.workspaceId,
                        sourceKind: 'BIBLE_VERSION' as const,
                        bookId,
                        elementId: el.id,
                        bibleVersionId: v.id,
                        automatic: true,
                        dedupeKey: randomBytes(32).toString('hex'),
                        status: 'CONFIRMED' as const,
                        decidedAt: new Date(),
                        position: i,
                        subjectName: 'Rook',
                        subjectElementId: el.id,
                        predicate: 'LOCATION' as const,
                        objectLiteral: `Town ${tag(i)}`,
                        statement,
                        quote: statement,
                        quoteStart: 0,
                        quoteEnd: statement.length,
                        // One stated time for all (D28 addendum: an undated place clashes with nothing by rule).
                        storyTimeFrom: 'the night of the flood',
                    };
                }),
            });
        });
        const raised = () => runWithoutRls({ reason: 'test' }, (db) => db.storyFactProposal.count({ where: { bookId, basis: 'RULE', kind: 'WHEREABOUTS' } }));
        const distinct = () => runWithoutRls({ reason: 'test' }, async (db) => {
            const rows = await db.storyFactProposal.findMany({ where: { bookId }, select: { factId: true, newerFactId: true } });
            return new Set(rows.map((r) => [r.factId, r.newerFactId].sort().join('|'))).size;
        });
        // A night proposes a bounded share of what the rules see (never fails on the rest)…
        expect(await runNight(ctx, { checker: quiet })).toEqual(['OK']);
        expect(await raised()).toBe(CONTINUITY_PROPOSALS_PER_RUN_MAX);
        // …and the next night the next share, every pair once.
        await runWithoutRls({ reason: 'test' }, (db) => db.continuityCheck.updateMany({ where: { bookId }, data: { coveredThrough: null } }));
        expect(await runNight(ctx, { checker: quiet })).toEqual(['OK']);
        expect(await raised()).toBe(2 * CONTINUITY_PROPOSALS_PER_RUN_MAX);
        expect(await distinct()).toBe(2 * CONTINUITY_PROPOSALS_PER_RUN_MAX);
        expect((N * (N - 1)) / 2).toBeGreaterThan(2 * CONTINUITY_PROPOSALS_PER_RUN_MAX);
    }, 120_000);
});

describe('the registries: rejection memory', () => {
    it('a rejected thread is not proposed again under a reworded title for the same words of the entry', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Reworded' })).id;
        const clue = 'Tam hides a brass key under the third step.';
        const tam = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Tam', summary: clue });
        await extractPending(ctx, bookId, threadExtractor(clue, 'Tam hides a brass key'));
        const [first] = (await getContinuityPage(ctx, bookId)).threadProposals.items;
        expect(first).toMatchObject({ op: 'NEW_THREAD', quote: clue });
        await decideThreadProposal(ctx, bookId, first.id, { decision: 'REJECT' });
        // The section changes, so the sentence is shown again; the model words the same thread differently.
        await updateElement(ctx, bookId, tam.id, { summary: `${clue} The house is quiet.`, baseVersion: 1 });
        await extractPending(ctx, bookId, threadExtractor(clue, 'A brass key under the third step'));
        expect((await getContinuityPage(ctx, bookId)).threadProposals.items).toEqual([]);
    });
});

describe('the nightly check: coverage and fairness', () => {
    it('a book due only for facts the check cannot read ends NO_FACTS once, not every night', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Unlinked' })).id;
        // A confirmed source fact about a name that is no element of the book: live, but its subject is unlinked.
        const sentence = 'Nobody-here is 40 years old.';
        const extractor: FactExtractor = {
            async extract() {
                return { ok: true, output: { facts: [{ subject: 'Nobody-here', predicate: 'AGE', object: '40 years old', statement: sentence, quote: sentence, storyTimeFrom: '', storyTimeTo: '' }] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
            },
        };
        const undo = setFakeApiKey();
        try {
            const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode(`Chapter one.\n\n${sentence}`), filename: 'notes.txt' }, { scan: CLEAN_SCAN });
            await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, { enqueue: async () => undefined });
            await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { extractor: () => extractor, embedder: () => new StubEmbeddingProvider() });
        } finally {
            undo();
        }
        const fact = (await listBookFacts(ctx, bookId)).facts.find((f) => f.statement === sentence)!;
        await decideFact(ctx, fact.id, 'CONFIRM');

        expect(await runNight(ctx, { checker: quiet })).toEqual(['NO_FACTS']);
        expect(await runNight(ctx, { checker: quiet })).toEqual([]);
    });

    it('a workspace’s books that stay due share the nights: the one checked least recently goes first', async () => {
        const ctx = workspaceCtx(await createAccount());
        const books: string[] = [];
        for (const title of ['One', 'Two', 'Three']) {
            const bookId = (await createBook(ctx, { title })).id;
            await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Kit${title}`, summary: `Kit${title} is 30 years old.` });
            await extractPending(ctx, bookId, ageExtractor(`Kit${title}`));
            books.push(bookId);
        }
        // No evaluation record: every pass stays under way, so every book stays due, night after night.
        const refused = { gate: () => ({ mounted: false as const, reason: 'STRUCTURAL_RECORD_REFUSED' as const, detail: '' }) };
        const seen = new Set<string>();
        for (let night = 0; night < 3; night++) {
            const queued: string[] = [];
            await executeContinuityDispatch({ take: 1, workspaceIds: [ctx.workspaceId], enqueue: async (_n, payload) => void queued.push((payload as { runId: string }).runId) });
            expect(queued).toHaveLength(1);
            const run = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.findUniqueOrThrow({ where: { id: queued[0] }, select: { bookId: true } }));
            seen.add(run.bookId);
            const { executeContinuityCheck } = await import('@/app-layer/usecases/continuity-check');
            const undo = setFakeApiKey();
            try {
                expect((await executeContinuityCheck({ workspaceId: ctx.workspaceId, runId: queued[0] }, { charge: () => undefined, ...refused })).outcome).toBe('NOT_EVALUATED');
            } finally {
                undo();
            }
        }
        expect(seen).toEqual(new Set(books));
    });

    it('a night stopped after its first call counts the subjects that call covered as no longer remaining', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Halfway' })).id;
        for (const name of ['Ada', 'Bo', 'Cass']) {
            await createElement(ctx, bookId, { kind: 'CHARACTER', name, summary: `${name} is 30 years old.` });
            await extractPending(ctx, bookId, ageExtractor(name));
        }
        let n = 0;
        const firstThenFail = () => ({
            extract: async () =>
                ++n === 1
                    ? { ok: true as const, output: { contradictions: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] as string[] }
                    : { ok: false as const, failure: 'PROVIDER_FAILURE' as const, errorCode: 'PROVIDER_FAILURE', tokensUsed: 0, costMicroUsd: 0, callIds: [] as string[] },
        });
        expect(await runNight(ctx, { checker: firstThenFail, callsPerNight: 2, factsPerCall: 1 })).toEqual(['CALL_FAILED']);
        const run = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.findFirstOrThrow({ where: { bookId }, select: { subjectsCovered: true, subjectsRemaining: true } }));
        expect(run).toEqual({ subjectsCovered: 1, subjectsRemaining: 2 });
    });
});

describe('the nightly check: a page the guard refuses', () => {
    it('stops the night but is passed over: the next night goes on past it, never retrying it behind the pass', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Guarded' })).id;
        for (const name of ['Edda', 'Finn']) {
            await createElement(ctx, bookId, { kind: 'CHARACTER', name, summary: `${name} is 30 years old.` });
            await extractPending(ctx, bookId, ageExtractor(name));
        }
        const shown: string[] = [];
        // The first subject's page trips the guard every time it is sent; any other page passes.
        const guarded = () => ({
            extract: async (request: { data: ReadonlyArray<{ label: string; text: string }> }) => {
                const text = request.data.find((b) => b.label === 'facts')?.text ?? '';
                shown.push(text);
                return shown.length === 1 || text === shown[0]
                    ? { ok: false as const, failure: 'GUARD_REFUSED' as const, errorCode: 'GUARD', tokensUsed: 0, costMicroUsd: 0, callIds: [] as string[] }
                    : { ok: true as const, output: { contradictions: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] as string[] };
            },
        });
        const night = () => runNight(ctx, { checker: guarded, callsPerNight: 1, factsPerCall: 1 });
        expect(await night()).toEqual(['GUARD_REFUSED']);
        expect(await night()).toEqual(['OK']);
        expect(shown).toHaveLength(2);
        expect(shown[1]).not.toBe(shown[0]);
    });
});
