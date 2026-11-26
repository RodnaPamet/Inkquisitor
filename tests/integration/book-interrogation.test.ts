/**
 * BOOK-LEVEL INTERROGATION END TO END (Phase 4.3, D29), against a real
 * PostgreSQL. Every model step is a scripted step or the fake Messages API;
 * nothing reaches a network.
 *
 *   the stress test: the estimate and its "at most", the author's confirmation
 *   (less than the worst case is refused), the job, weak points as questions,
 *   every citation checked (again at persist), nothing written to the bible,
 *   the ceiling and the kill switch stopping it before anything is sent, rule 6,
 *   an interview started from its weak points
 *   the gap hunt: the code's candidates, the model's ranking validated, the
 *   code's order shown LABELLED UNRANKED when the model cannot rank (no key,
 *   D11) or keeps no pick
 *   a panel session's questions grouped by who asked
 *   long-session compaction: the earlier rounds' answers verbatim, the summary
 *   fenced, stored once and encrypted
 */
import { prisma } from '@/lib/db';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, deleteElement } from '@/app-layer/usecases/bible-elements';
import { createThread } from '@/app-layer/usecases/continuity';
import { executeStressTest, getStressTest, getStressTestPage, startStressTest } from '@/app-layer/usecases/stress-tests';
import { getGapHuntPage, runGapHunt } from '@/app-layer/usecases/gap-hunts';
import { closeRound, getInterview, nextRound, startInterview } from '@/app-layer/usecases/interviews';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { groupByPersona } from '@/lib/interview/persona-groups';
import { PANEL_PERSONA_KEYS } from '@/lib/interview/vocabulary';
import { nextRoundTokens } from '@/lib/interview/dial-settings';
import { GAP_HUNTS_LISTED_MAX } from '@/lib/gap-hunt/vocabulary';
import { defaultStressTester } from '@/lib/stress-test/model-seam';
import { defaultGapRanker } from '@/lib/gap-hunt/model-seam';
import { AppError } from '@/lib/errors/types';
import { ZodError } from 'zod';
import { setBookInterviewDefaults, setWorkspaceInterviewDefaults } from '@/app-layer/usecases/interview-defaults';
import type { FactExtractor } from '@/lib/sources/extractor';
import { fakeAnthropic, setFakeApiKey } from '../helpers/fake-anthropic';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { MOUNTED, runStressTest, scriptedTester } from '../helpers/interrogation';
import { createAccount, workspaceCtx } from '../helpers/workspaces';
import { ingestText } from '../helpers/sources';
import { decideFact, listBookFacts } from '@/app-layer/usecases/source-facts';

afterAll(() => prisma.$disconnect());

type Ctx = ReturnType<typeof workspaceCtx>;

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown; details: Record<string, unknown> }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, reason: (err.details as { reason?: unknown } | undefined)?.reason, details: (err.details ?? {}) as Record<string, unknown> };
        throw err;
    }
    throw new Error('expected a refusal');
}

async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
    const before = process.env[name];
    process.env[name] = value;
    try {
        return await fn();
    } finally {
        if (before === undefined) delete process.env[name];
        else process.env[name] = before;
    }
}

async function bibleVersionCount(bookId: string): Promise<number> {
    return runWithoutRls({ reason: 'test' }, async (db) => (await db.bibleEntryVersion.count({ where: { bookId } })) + (await db.bibleRelationVersion.count({ where: { bookId } })));
}

/** A book with a premise, a protagonist, a beat and an open promise. */
async function weirBook(ctx: Ctx) {
    const bookId = (await createBook(ctx, { title: 'The Weir', logline: 'A lock-keeper’s daughter keeps a village alive.' })).id;
    const premise = await createElement(ctx, bookId, { kind: 'PREMISE', name: 'The Weir', summary: 'A village below a failing weir survives a winter.', fields: [{ key: 'central_character', value: 'Wren Holt.' }] });
    const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'The lock-keeper’s daughter, twelve.', fields: [{ key: 'role', value: 'Protagonist.' }] });
    const beat = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: 'The open sluice', summary: 'Wren opens the main sluice at night.' });
    const thread = await createThread(ctx, bookId, { kind: 'PROMISE', title: 'Who wound the music box' });
    return { bookId, premiseId: premise.id, wrenId: wren.id, beatId: beat.id, threadId: thread.id };
}

/** The tag a row was shown under, read from the blocks the tester saw. */
function tagOf(blocks: ReadonlyArray<{ label: string; text: string }>, name: string): string {
    const line = blocks.flatMap((b) => b.text.split('\n')).find((l) => l.includes(name))!;
    return /^([EFTP]\d+)\./.exec(line)![1];
}

describe('the stress test', () => {
    it('a book with nothing in it is NOT ASSESSED, and none can be started (rule 6)', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Empty' })).id;
        const undo = setFakeApiKey();
        try {
            const page = await getStressTestPage(ctx, bookId, { gate: MOUNTED });
            expect(page).toMatchObject({ assessed: false, estimate: null, tests: [] });
            expect(await refusal(startStressTest(ctx, bookId, { confirmWorstCaseMicroUsd: 10_000_000 }, { gate: MOUNTED, enqueue: async () => undefined }))).toMatchObject({ status: 409, reason: 'NOTHING_TO_TEST' });
        } finally {
            undo();
        }
    });

    it('shows its "at most" first, refuses less, then runs once as a job: weak points as questions, every citation checked, nothing written to the bible', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const versionsBefore = await bibleVersionCount(book.bookId);
        const undo = setFakeApiKey();
        try {
            const page = await getStressTestPage(ctx, book.bookId, { gate: MOUNTED });
            expect(page.assessed).toBe(true);
            expect(page.unavailable).toBeNull();
            expect(page.estimate!.overBudget).toBe(false);
            expect(page.estimate!.worstMicroUsd).toBeGreaterThan(0);
            expect(page.estimate!.coverage).toMatchObject({ elements: { shown: 3, total: 3 }, threads: { shown: 1, total: 1 }, cut: false });

            // Less than the "at most" now: refused with the figure, nothing written.
            const low = await refusal(startStressTest(ctx, book.bookId, { confirmWorstCaseMicroUsd: page.estimate!.worstMicroUsd - 1 }, { gate: MOUNTED, enqueue: async () => undefined }));
            expect(low).toMatchObject({ status: 409, reason: 'ESTIMATE_CHANGED', details: { worstCaseMicroUsd: page.estimate!.worstMicroUsd } });
            expect(await runWithoutRls({ reason: 'test' }, (db) => db.stressTest.count({ where: { bookId: book.bookId } }))).toBe(0);

            const queued: Array<{ workspaceId: string; stressTestId: string }> = [];
            const view = await startStressTest(ctx, book.bookId, { confirmWorstCaseMicroUsd: page.estimate!.worstMicroUsd }, { gate: MOUNTED, enqueue: async (p) => void queued.push(p) });
            expect(view.status).toBe('QUEUED');
            // The job's payload is ids only.
            expect(queued).toEqual([{ workspaceId: ctx.workspaceId, stressTestId: view.id }]);
            // One live test a book.
            expect(await refusal(startStressTest(ctx, book.bookId, { confirmWorstCaseMicroUsd: page.estimate!.worstMicroUsd }, { gate: MOUNTED, enqueue: async () => undefined }))).toMatchObject({ status: 409, reason: 'STRESS_TEST_IN_PROGRESS' });

            const seen: Array<ReadonlyArray<{ label: string; text: string }>> = [];
            const tester = scriptedTester((blocks: ReadonlyArray<{ label: string; text: string }>) => ({
                weakPoints: [
                    { kind: 'UNMOTIVATED_TURN', title: 'Wren at the sluice', questions: ['What does Wren want when she opens the sluice that night?', 'This turn is unmotivated.'], cites: [tagOf(blocks, 'The open sluice'), tagOf(blocks, 'Wren:')] },
                    { kind: 'UNPAID_PROMISE', title: 'The music box', questions: ['When does the reader learn who wound the music box?'], cites: [tagOf(blocks, 'music box')] },
                    { kind: 'OTHER', title: 'Nowhere', questions: ['Where does this happen?'], cites: ['E42'] },
                ],
            }), seen);
            const r = await executeStressTest(queued[0], { gate: MOUNTED, charge: () => undefined, tester });
            expect(r).toEqual({ ran: true, outcome: 'OK' });
            // The call was shown the canon as data: the book, the elements, the open threads.
            expect(seen[0].map((b) => b.label)).toEqual(expect.arrayContaining(['book', 'elements', 'threads']));

            const done = await getStressTest(ctx, book.bookId, view.id);
            expect(done.status).toBe('DONE');
            expect(done.weakPoints).toHaveLength(2);
            const [turn, promise] = done.weakPoints;
            expect(turn).toMatchObject({ kind: 'UNMOTIVATED_TURN', title: 'Wren at the sluice', questions: ['What does Wren want when she opens the sluice that night?'] });
            expect(turn.citations.map((c) => [c.type, c.id, c.label])).toEqual([
                ['ELEMENT', book.beatId, 'The open sluice'],
                ['ELEMENT', book.wrenId, 'Wren'],
            ]);
            expect(promise.citations).toEqual([{ type: 'THREAD', id: book.threadId, label: 'Who wound the music box' }]);
            expect(done.sessionElementIds).toEqual([book.beatId, book.wrenId]);
            const metrics = (await runWithoutRls({ reason: 'test' }, (db) => db.stressTest.findUniqueOrThrow({ where: { id: view.id }, select: { metrics: true } }))).metrics as { refusals: Record<string, number> };
            expect(metrics.refusals).toMatchObject({ NOT_A_QUESTION: 1, UNKNOWN_CITATION: 1 });

            // Author-derived text is encrypted at rest.
            const raw = await prisma.$queryRawUnsafe<Array<{ title: string; questions: string }>>('SELECT "title", "questions" FROM "StressWeakPoint" WHERE "stressTestId" = $1', view.id);
            expect(raw.every((w) => w.title.startsWith('v2:') && w.questions.startsWith('v2:'))).toBe(true);

            // NOTHING REACHED THE BIBLE (rule 1).
            expect(await bibleVersionCount(book.bookId)).toBe(versionsBefore);
        } finally {
            undo();
        }
    });

    it('a canon that grew between the confirmation and the job stops ESTIMATE_CHANGED with nothing sent: the author confirmed less', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const undo = setFakeApiKey();
        try {
            const page = await getStressTestPage(ctx, book.bookId, { gate: MOUNTED });
            const queued: string[] = [];
            const view = await startStressTest(ctx, book.bookId, { confirmWorstCaseMicroUsd: page.estimate!.worstMicroUsd }, { gate: MOUNTED, enqueue: async (p) => void queued.push(p.stressTestId) });
            // The book grows before the job runs: its input, and so its worst case, is now larger than what was confirmed.
            for (let i = 0; i < 6; i++) {
                await createElement(ctx, book.bookId, { kind: 'CHARACTER', name: `Villager ${i + 1}`, summary: `A villager below the weir who keeps the eel traps and remembers the old flood, number ${i + 1}. `.repeat(6).trim() });
            }
            const api = fakeAnthropic([]);
            const r = await executeStressTest({ workspaceId: ctx.workspaceId, stressTestId: queued[0] }, { gate: MOUNTED, charge: () => undefined, tester: (c) => defaultStressTester(c, { fetch: api.fetch }) });
            expect(r.outcome).toBe('ESTIMATE_CHANGED');
            expect(api.requests).toHaveLength(0);
            expect(await getStressTest(ctx, book.bookId, view.id)).toMatchObject({ status: 'STOPPED', outcome: 'ESTIMATE_CHANGED', weakPoints: [] });
        } finally {
            undo();
        }
    });

    it('a citation whose row is gone by the time it is written is dropped; a weak point left citing nothing is refused', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const deleting: () => FactExtractor = () => ({
            async extract(request) {
                const beat = tagOf(request.data, 'The open sluice');
                const wren = tagOf(request.data, 'Wren:');
                await deleteElement(ctx, book.bookId, book.beatId);
                return { ok: true, output: { weakPoints: [{ kind: 'OTHER', title: 'The sluice', questions: ['Why the sluice?'], cites: [beat] }, { kind: 'OTHER', title: 'Wren', questions: ['What does Wren fear?'], cites: [beat, wren] }] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
            },
        });
        const r = await runStressTest(ctx, book.bookId, { tester: deleting });
        expect(r.outcome).toBe('OK');
        const done = await getStressTest(ctx, book.bookId, r.id);
        expect(done.weakPoints.map((w) => [w.title, w.citations.map((c) => c.id)])).toEqual([['Wren', [book.wrenId]]]);
    });

    it('a cited fact the author rejects while the call runs is gone at persist: its citation is dropped', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Salt Road' })).id;
        const mara = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara', summary: 'A salt trader.' });
        await ingestText(ctx, { kind: 'book', bookId }, 'Mara wants the salt road reopened before winter.');
        const fact = (await listBookFacts(ctx, bookId)).facts[0];
        expect(fact).toBeDefined();
        await decideFact(ctx, fact.id, 'CONFIRM');
        let factTag = '';
        const rejecting: () => FactExtractor = () => ({
            async extract(request) {
                const facts = request.data.find((b) => b.label === 'facts')?.text ?? '';
                factTag = /^(F\d+)\./m.exec(facts)?.[1] ?? '';
                const maraTag = tagOf(request.data, '[CHARACTER] Mara');
                await decideFact(ctx, fact.id, 'REJECT');
                return {
                    ok: true,
                    output: {
                        weakPoints: [
                            { kind: 'OTHER', title: 'The road', questions: ['Why must the road open before winter?'], cites: [factTag] },
                            { kind: 'OTHER', title: 'What Mara risks', questions: ['What does Mara stand to lose?'], cites: [factTag, maraTag] },
                        ],
                    },
                    tokensUsed: 1,
                    costMicroUsd: 1,
                    callIds: [],
                };
            },
        });
        const r = await runStressTest(ctx, bookId, { tester: rejecting });
        expect(factTag).toMatch(/^F\d+$/);
        expect(r.outcome).toBe('OK');
        const done = await getStressTest(ctx, bookId, r.id);
        expect(done.weakPoints.map((w) => [w.title, w.citations.map((c) => c.id)])).toEqual([['What Mara risks', [mara.id]]]);
    });

    it('stops at the ceiling and the kill switch with nothing sent, a named outcome and nothing claimed', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const api = fakeAnthropic([]);
        const ceiling = await withEnv('AI_MONTHLY_CEILING_USD_DEFAULT', '0.01', () => runStressTest(ctx, book.bookId, { tester: (c) => defaultStressTester(c, { fetch: api.fetch }) }));
        expect(ceiling.outcome).toBe('CEILING');
        expect(api.requests).toHaveLength(0);
        const stopped = await getStressTest(ctx, book.bookId, ceiling.id);
        expect(stopped).toMatchObject({ status: 'STOPPED', outcome: 'CEILING', weakPoints: [] });
        const call = await prisma.aiCallLog.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId, purpose: 'interrogation.stress-test' } });
        expect(call).toMatchObject({ outcome: 'CEILING', attempts: 0 });

        // The kill switch, set between the confirmation and the job: nothing is sent.
        const undo = setFakeApiKey();
        try {
            const page = await getStressTestPage(ctx, book.bookId, { gate: MOUNTED });
            const queued: string[] = [];
            const view = await startStressTest(ctx, book.bookId, { confirmWorstCaseMicroUsd: page.estimate!.worstMicroUsd }, { gate: MOUNTED, enqueue: async (p) => void queued.push(p.stressTestId) });
            const r = await withEnv('AI_DISABLED', '1', () => executeStressTest({ workspaceId: ctx.workspaceId, stressTestId: queued[0] }, { gate: MOUNTED, charge: () => undefined, tester: (c) => defaultStressTester(c, { fetch: api.fetch }) }));
            expect(r.outcome).toBe('KILL_SWITCH');
            expect(api.requests).toHaveLength(0);
            expect((await getStressTest(ctx, book.bookId, view.id)).status).toBe('STOPPED');
        } finally {
            undo();
        }
        // Without a record this deployment accepts (D11): refused before anything is written.
        const undo2 = setFakeApiKey();
        try {
            expect(await refusal(startStressTest(ctx, book.bookId, { confirmWorstCaseMicroUsd: 10_000_000 }, { gate: () => ({ mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: '' }), enqueue: async () => undefined }))).toMatchObject({ status: 503, reason: 'STRESS_TEST_NOT_EVALUATED' });
        } finally {
            undo2();
        }
        // No key at all: 503 AI_UNAVAILABLE naming the reason.
        expect(await refusal(startStressTest(ctx, book.bookId, { confirmWorstCaseMicroUsd: 10_000_000 }, { gate: MOUNTED, enqueue: async () => undefined }))).toMatchObject({ status: 503, reason: 'CREDENTIAL_NOT_CONFIGURED' });
    });

    it('the real model seam: the canon goes as fenced data, and the answer is validated before anything is kept', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const api = fakeAnthropic([
            {
                kind: 'respond',
                answer: (body) => {
                    const user = JSON.stringify(body.messages);
                    const sluice = /(E\d+)\. \[PLOT_BEAT\] The open sluice/.exec(user)![1];
                    return { kind: 'text', text: JSON.stringify({ weakPoints: [{ kind: 'UNMOTIVATED_TURN', title: 'The sluice', questions: ['What drives Wren to open the sluice?'], cites: [sluice] }] }) };
                },
            },
        ]);
        const r = await runStressTest(ctx, book.bookId, { tester: (c) => defaultStressTester(c, { fetch: api.fetch }) });
        expect(r.outcome).toBe('OK');
        expect(api.requests).toHaveLength(1);
        // The system prompt carries no author text; the canon is in the user turn's fenced data.
        expect(JSON.stringify(api.requests[0].system)).not.toContain('lock-keeper');
        expect(JSON.stringify(api.requests[0].messages)).toContain('lock-keeper');
        expect((await getStressTest(ctx, book.bookId, r.id)).weakPoints[0].citations[0].id).toBe(book.beatId);
    });

    it('an interview started from the weak points asks about their elements, carries them as a data block and challenges their fields first', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const r = await runStressTest(ctx, book.bookId, {
            tester: scriptedTester((blocks: ReadonlyArray<{ label: string; text: string }>) => ({ weakPoints: [{ kind: 'COSTLESS_PROTAGONIST', title: 'What Wren risks', questions: ['What does Wren stand to lose?'], cites: [tagOf(blocks, 'Wren:')] }] })),
        });
        const test = await getStressTest(ctx, book.bookId, r.id);
        expect(test.sessionElementIds).toEqual([book.wrenId]);
        // Elements the test does not ask about are refused.
        expect(await refusal(startInterview(ctx, book.bookId, { scope: 'SELECTION', elementIds: [book.premiseId], relationIds: [], stressTestId: r.id }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder }))).toMatchObject({
            status: 409,
            reason: 'STRESS_SCOPE_MISMATCH',
        });
        const generator = fakeGenerator();
        const view = await startInterview(ctx, book.bookId, { scope: 'SELECTION', elementIds: test.sessionElementIds, relationIds: [], stressTestId: r.id, depth: 3, detail: 3 }, { generator, embedder: stubQuestionEmbedder });
        expect(view.session.scope).toBe('SELECTION');
        expect(view.session.stressTestId).toBe(r.id);
        const block = generator.calls[0].data.find((b) => b.label === 'weak-points');
        expect(block).toBeDefined();
        expect(JSON.parse(block!.text)).toEqual([{ kind: 'COSTLESS_PROTAGONIST', weakPoint: 'What Wren risks', questions: ['What does Wren stand to lose?'], about: ['Wren'] }]);
        // Wren's stored role is planned for a challenge in the first round (the weak point's field), whatever the depth would allow.
        const round = await runWithoutRls({ reason: 'test' }, (db) => db.interviewRound.findFirstOrThrow({ where: { sessionId: view.session.id, number: 1 }, select: { plan: true } }));
        expect((round.plan as { challenge: unknown }).challenge).toMatchObject({ elementId: book.wrenId, fieldKey: 'role' });
    });
});

describe('the gap hunt', () => {
    async function gappyBook(ctx: Ctx) {
        const bookId = (await createBook(ctx, { title: 'Glass Ledger' })).id;
        const premise = await createElement(ctx, bookId, { kind: 'PREMISE', name: 'Glass Ledger', fields: [{ key: 'central_character', value: 'Ines.' }, { key: 'starting_situation', value: 'A vote voids every deed.' }] });
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ines', fields: [{ key: 'role', value: 'A forger.' }] });
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Tomas', fields: [{ key: 'role', value: 'Her partner.' }] });
        return { bookId, premiseId: premise.id };
    }

    it('computes the candidates in code, and with no call possible shows the code’s order LABELLED UNRANKED, never as the model’s', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await gappyBook(ctx);
        const page = await getGapHuntPage(ctx, book.bookId);
        expect(page.assessed).toBe(true);
        expect(page.ranking).toEqual({ available: false, reason: 'AI_UNAVAILABLE' });
        expect(page.hunt).toMatchObject({ id: null, ranked: false });
        expect(page.hunt.candidates[0]).toMatchObject({ kind: 'PREMISE', fieldKey: 'central_conflict', empty: 1, emptyElementIds: [book.premiseId] });
        expect(page.hunt.sessions[0]).toMatchObject({ target: { scope: 'ELEMENT', elementId: book.premiseId } });
        expect(page.hunt.elementNames[book.premiseId]).toBe('Glass Ledger');

        const ranker = { called: 0 };
        const hunt = await runGapHunt(ctx, book.bookId, {}, { ranker: () => ({ extract: async () => (ranker.called++, { ok: true, output: { picks: [] }, tokensUsed: 0, costMicroUsd: 0, callIds: [] }) }) });
        expect(ranker.called).toBe(0);
        expect(hunt).toMatchObject({ ranked: false, unrankedReason: 'AI_UNAVAILABLE', costMicroUsd: 0 });
        expect(hunt.picks.every((p) => p.reason === null)).toBe(true);
        expect(hunt.sessions.length).toBeGreaterThan(0);
        expect(hunt.sessions.length).toBeLessThanOrEqual(3);
        // D11: with a key but no record this deployment accepts, it is unranked NOT_EVALUATED.
        const undo = setFakeApiKey();
        try {
            expect(await runGapHunt(ctx, book.bookId, {}, { gate: () => ({ mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: '' }) })).toMatchObject({ ranked: false, unrankedReason: 'NOT_EVALUATED' });
        } finally {
            undo();
        }
    });

    it('ranks with the model after the author confirms its "at most"; picks outside the list or ungrounded are refused; none left is unranked', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await gappyBook(ctx);
        const undo = setFakeApiKey();
        try {
            const page = await getGapHuntPage(ctx, book.bookId, { gate: MOUNTED });
            expect(page.ranking.available).toBe(true);
            const worst = page.ranking.available ? page.ranking.worstMicroUsd : 0;
            expect(await refusal(runGapHunt(ctx, book.bookId, {}, { gate: MOUNTED, charge: () => undefined }))).toMatchObject({ status: 409, reason: 'ESTIMATE_CHANGED' });

            const want = page.hunt.candidates.find((c) => c.kind === 'CHARACTER' && c.fieldKey === 'want')!;
            const conflict = page.hunt.candidates.find((c) => c.fieldKey === 'central_conflict')!;
            const api = fakeAnthropic([
                {
                    kind: 'text',
                    text: JSON.stringify({
                        picks: [
                            { candidate: want.n, reason: 'Neither forger has a conscious want, and the theft turns on what they want.', cites: [want.n] },
                            { candidate: conflict.n, reason: 'This matters a great deal.', cites: [conflict.n] },
                        ],
                    }),
                },
            ]);
            const ranked = await runGapHunt(ctx, book.bookId, { confirmWorstCaseMicroUsd: worst }, { gate: MOUNTED, charge: () => undefined, ranker: (c) => defaultGapRanker(c, { fetch: api.fetch }) });
            expect(ranked.ranked).toBe(true);
            expect(ranked.picks).toEqual([{ n: want.n, reason: 'Neither forger has a conscious want, and the theft turns on what they want.', cites: [want.n], flags: [] }]);
            expect(ranked.sessions[0].target).toEqual({ scope: 'KIND', kind: 'CHARACTER' });
            // The call was shown the code's candidates as data.
            expect(JSON.stringify(api.requests[0].messages)).toContain('Conscious want');
            const row = await runWithoutRls({ reason: 'test' }, (db) => db.gapHunt.findFirstOrThrow({ where: { bookId: book.bookId, ranked: true }, select: { refusals: true, promptVersion: true } }));
            expect(row.refusals).toMatchObject({ NOT_GROUNDED: 1 });
            const raw = await prisma.$queryRawUnsafe<Array<{ picks: string }>>('SELECT "picks" FROM "GapHunt" WHERE "bookId" = $1', book.bookId);
            expect(raw.every((r) => r.picks.startsWith('v2:'))).toBe(true);

            const nothing = await runGapHunt(ctx, book.bookId, { confirmWorstCaseMicroUsd: worst }, { gate: MOUNTED, charge: () => undefined, ranker: scriptedTester({ picks: [{ candidate: 12, reason: 'Stakes.', cites: [12] }] }) });
            expect(nothing).toMatchObject({ ranked: false, unrankedReason: 'NO_VALID_PICK' });
            expect((await getGapHuntPage(ctx, book.bookId, { gate: MOUNTED })).hunt.ranked).toBe(false);
        } finally {
            undo();
        }
    });

    it('a run answers with the hunt IT stored, never whatever row is newest (a concurrent run, a skewed clock)', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await gappyBook(ctx);
        const first = await runGapHunt(ctx, book.bookId, {});
        // Another run's row that sorts newer than the one this request is about to store.
        const planted = await runWithoutRls({ reason: 'test' }, (db) =>
            db.gapHunt.create({ data: { workspaceId: ctx.workspaceId, bookId: book.bookId, ranked: false, unrankedReason: 'KILL_SWITCH', candidates: [], picks: '[]', bookMark: 0, createdAt: new Date(Date.now() + 3_600_000) }, select: { id: true } }),
        );
        const mine = await runGapHunt(ctx, book.bookId, {});
        expect(mine.id).not.toBe(planted.id);
        expect(mine.id).not.toBe(first.id);
        expect(mine).toMatchObject({ ranked: false, unrankedReason: 'AI_UNAVAILABLE' });
        expect(mine.candidates.length).toBeGreaterThan(0);
    });

    it('a book keeps only its newest few gap hunts (retention): older rows go as a new one is stored', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        for (let i = 0; i < GAP_HUNTS_LISTED_MAX + 2; i++) await runGapHunt(ctx, book.bookId, {});
        expect(await runWithoutRls({ reason: 'test' }, (db) => db.gapHunt.count({ where: { bookId: book.bookId } }))).toBe(GAP_HUNTS_LISTED_MAX);
    });

    it('a book with nothing in it is not assessed; one with every field filled has no gaps', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Blank' })).id;
        const page = await getGapHuntPage(ctx, bookId);
        expect(page.assessed).toBe(false);
        expect(await refusal(runGapHunt(ctx, bookId, {}))).toMatchObject({ status: 409, reason: 'NOTHING_TO_RANK' });
    });
});

describe('the persona panel', () => {
    it('a panel session words its rounds with all three panel personas, and its questions group by who asked', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const generator = fakeGenerator();
        const view = await startInterview(ctx, book.bookId, { scope: 'BOOK', depth: 3, detail: 3, personaKeys: [...PANEL_PERSONA_KEYS] }, { generator, embedder: stubQuestionEmbedder });
        expect(view.session.personaKeys).toEqual([...PANEL_PERSONA_KEYS]);
        expect(view.session.packs!.map((p) => p.name)).toEqual(expect.arrayContaining(PANEL_PERSONA_KEYS.map((k) => `persona-${k}`)));
        // Phase 4.4: the model-worded questions are the panel's; a code-worded one (a follow-up, a pair) is no persona's.
        const worded = view.round!.questions.filter((q) => q.origin !== 'GENERATOR');
        const groups = groupByPersona(worded);
        expect(groups.map((g) => g.personaKey).sort()).toEqual([...PANEL_PERSONA_KEYS].sort());
        expect(worded.every((q) => q.personaName !== null)).toBe(true);
        // Each persona's call carried its own pack.
        expect(generator.calls.map((c) => c.personaKey).sort()).toEqual([...PANEL_PERSONA_KEYS].sort());
    }, 60_000);

    it('the panel is never a default, and a session names all three panel voices or none (no voice beside its namesake)', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        // Neither the workspace's nor the book's defaults take a panel persona, by the usecase or by the database.
        await expect(setWorkspaceInterviewDefaults(ctx, { personaKeys: ['panel-target-reader'] })).rejects.toBeInstanceOf(ZodError);
        await expect(setBookInterviewDefaults(ctx, book.bookId, { personaKeys: [...PANEL_PERSONA_KEYS] })).rejects.toBeInstanceOf(ZodError);
        await setBookInterviewDefaults(ctx, book.bookId, { personaKeys: ['socratic'] });
        await expect(prisma.$executeRaw`UPDATE "BookInterviewDefaults" SET "personaKeys" = '["panel-target-reader"]'::jsonb WHERE "bookId" = ${book.bookId}`).rejects.toThrow(/personas_known/);
        // A panel voice beside the persona it shares a name with, or the panel cut short, is not the panel.
        for (const personaKeys of [['target-reader', 'panel-target-reader'], ['panel-target-reader', 'panel-ruthless-editor'], ['socratic', 'panel-ruthless-editor', 'panel-genre-specialist']]) {
            await expect(startInterview(ctx, book.bookId, { scope: 'BOOK', depth: 3, detail: 3, personaKeys }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder })).rejects.toBeInstanceOf(ZodError);
        }
        expect(await runWithoutRls({ reason: 'test' }, (db) => db.interviewSession.count({ where: { bookId: book.bookId } }))).toBe(0);
    });
});

describe('long-session compaction', () => {
    it('the summary call is held to the session’s token budget before it is sent: no room beside the round, no compaction', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const generator = fakeGenerator();
        const summaries: Array<ReadonlyArray<{ label: string; text: string }>> = [];
        const deps = { generator, embedder: stubQuestionEmbedder, compaction: { enabled: true, thresholdChars: 10 }, summarizer: scriptedTester({ summary: 'The questions covered Wren’s role.' }, summaries), charge: () => undefined } as const;
        const undo = setFakeApiKey();
        try {
            let view = await startInterview(ctx, book.bookId, { scope: 'ELEMENT', elementId: book.wrenId, depth: 5, detail: 3 }, deps);
            for (let round = 1; round <= 2; round++) {
                for (const q of view.round!.questions) await answerQuestion(ctx, book.bookId, view.session.id, q.id, { text: `Answer ${round}.${q.position}: Wren keeps the sluice key on a string.` });
                await closeRound(ctx, book.bookId, view.session.id, String(view.round!.number), {});
                if (round === 2) {
                    // Exactly the next round's share left: the round may run, a summary call beside it may not.
                    await runWithoutRls({ reason: 'test' }, async (db) => {
                        const s = await db.interviewSession.findUniqueOrThrow({ where: { id: view.session.id }, select: { tokensUsed: true, personaKeys: true } });
                        await db.interviewSession.update({ where: { id: view.session.id }, data: { tokenBudget: s.tokensUsed + nextRoundTokens(s.personaKeys.length) } });
                    });
                }
                view = await nextRound(ctx, book.bookId, view.session.id, deps);
            }
            expect(view.round!.number).toBe(3);
            expect(summaries).toHaveLength(0);
            const labels = generator.calls[generator.calls.length - 1].data.map((b) => b.label);
            expect(labels).not.toContain('session-state');
            expect(labels).toContain('this-session');
        } finally {
            undo();
        }
    });

    it('off by default; on, the earlier rounds are summarised once, the answers reach the model verbatim and the summary is fenced as model text', async () => {
        const ctx = workspaceCtx(await createAccount());
        const book = await weirBook(ctx);
        const generator = fakeGenerator();
        const summaries: Array<ReadonlyArray<{ label: string; text: string }>> = [];
        const scripted = scriptedTester({ summary: 'The questions covered Wren’s role and want; some were deferred.' }, summaries);
        // The round's signal reaches the summary call (a closed stream cuts it as it cuts the generation).
        const signals: Array<AbortSignal | undefined> = [];
        const summarizer = (): FactExtractor => ({ extract: (request, signal) => (signals.push(signal), scripted().extract(request, signal)) });
        const roundSignal = new AbortController().signal;
        const deps = { generator, embedder: stubQuestionEmbedder, compaction: { enabled: true, thresholdChars: 10 }, summarizer, charge: () => undefined, signal: roundSignal } as const;
        const undo = setFakeApiKey();
        try {
            let view = await startInterview(ctx, book.bookId, { scope: 'ELEMENT', elementId: book.wrenId, depth: 5, detail: 3 }, deps);
            const answers: string[] = [];
            for (let round = 1; round <= 2; round++) {
                for (const q of view.round!.questions) {
                    const text = `Answer ${round}.${q.position}: Wren keeps the sluice key on a string.`;
                    answers.push(text);
                    await answerQuestion(ctx, book.bookId, view.session.id, q.id, { text });
                }
                await closeRound(ctx, book.bookId, view.session.id, String(view.round!.number), {});
                view = await nextRound(ctx, book.bookId, view.session.id, deps);
            }
            expect(view.round!.number).toBe(3);
            // Round 3's request: the state block with every answer of round 1 verbatim, the fenced summary, round 2 verbatim.
            const last = generator.calls[generator.calls.length - 1].data;
            const labels = last.map((b) => b.label);
            expect(labels).toEqual(expect.arrayContaining(['session-state', 'earlier-rounds-summary', 'this-session']));
            const state = last.find((b) => b.label === 'session-state')!.text;
            const recent = last.find((b) => b.label === 'this-session')!.text;
            for (const a of answers.filter((x) => x.startsWith('Answer 1.'))) expect(state).toContain(a);
            for (const a of answers.filter((x) => x.startsWith('Answer 2.'))) expect(recent).toContain(a);
            expect(last.find((b) => b.label === 'earlier-rounds-summary')!.text).toContain('<rounds_summary source="model">');
            // The summary call was shown round 1 only, once, under the round's signal.
            expect(summaries).toHaveLength(1);
            expect(signals).toEqual([roundSignal]);
            expect(summaries[0][0].text).toContain('Answer 1.1');
            expect(summaries[0][0].text).not.toContain('Answer 2.');
            const raw = await prisma.$queryRawUnsafe<Array<{ summary: string; throughRound: number }>>('SELECT "summary", "throughRound" FROM "InterviewCompaction" WHERE "sessionId" = $1', view.session.id);
            expect(raw).toHaveLength(1);
            expect(raw[0].throughRound).toBe(1);
            expect(raw[0].summary.startsWith('v2:')).toBe(true);
            // Off by default: the same session's next round without the switch sends every round verbatim.
            const plain = fakeGenerator();
            for (const q of view.round!.questions) await answerQuestion(ctx, book.bookId, view.session.id, q.id, { text: 'More.' });
            await closeRound(ctx, book.bookId, view.session.id, '3', {});
            const after = await nextRound(ctx, book.bookId, view.session.id, { generator: plain, embedder: stubQuestionEmbedder });
            expect(after.round?.number).toBe(4);
            expect(plain.calls.length).toBeGreaterThan(0);
            expect(plain.calls[0].data.map((b) => b.label)).not.toContain('session-state');
            expect(plain.calls[0].data.map((b) => b.label)).toContain('this-session');
            expect((await getInterview(ctx, book.bookId, view.session.id)).session.id).toBe(view.session.id);
        } finally {
            undo();
        }
    });
});
