/**
 * The question engine's edges against a real PostgreSQL (Phase 2.2 review):
 * what holds when a book outgrows a bounded read, when the bible moves while a
 * round is worded, when a session's rounds keep failing, when an author keeps
 * re-answering, when a pack will not load, and when the book is deleted. No
 * model is called: the deterministic fake generator words every question.
 */
import { ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { QuestionRepository } from '@/app-layer/repositories/interview.repository';
import { createBook, deleteBook } from '@/app-layer/usecases/books';
import { createElement, deleteElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { answerQuestion, decideLater, skipQuestion } from '@/app-layer/usecases/interview-answers';
import { closeRound, getInterview, listInterviews, nextRound, startInterview, stopInterview } from '@/app-layer/usecases/interviews';
import { AppError } from '@/lib/errors/types';
import * as packsModule from '@/lib/interview/packs';
import type { QuestionGenerator } from '@/lib/interview/generator';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

jest.setTimeout(30_000);
afterAll(() => prisma.$disconnect());
afterEach(() => jest.restoreAllMocks());

let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount());
    bookId = (await createBook(ctx, { title: 'The Long Survey' })).id;
});

const unique = () => Math.random().toString(36).slice(2, 8);

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, reason: (err.details as { reason?: unknown } | undefined)?.reason };
        if (err instanceof ZodError) return { status: 400, reason: 'VALIDATION_ERROR' };
        throw err;
    }
    throw new Error('expected a refusal');
}

/** A generator whose calls wait for `release` (the window in which the book moves). */
function gated() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const inner = fakeGenerator();
    const generator: QuestionGenerator = {
        unavailableReason: () => null,
        async generateCandidates(request) {
            entered();
            await gate;
            return inner.generateCandidates(request);
        },
    };
    return { generator, started, release };
}

describe('deduplication against the whole book', () => {
    it('an exact repeat beyond the bounded read of earlier questions is still found, by the book’s index', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Indexed ${unique()}` });
        const first = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 1, detail: 2 }, { generator: fakeGenerator(), embedder: null });
        await stopInterview(ctx, bookId, first.session.id);
        // The earlier session's questions now lie beyond the bounded read (a book with more than it holds).
        jest.spyOn(QuestionRepository, 'listForElementsElsewhere').mockResolvedValue([]);
        const second = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 1, detail: 2 }, { generator: fakeGenerator(), embedder: null });
        const firstTexts = new Set(first.round!.questions.map((q) => q.text));
        expect(second.round?.questions.some((q) => firstTexts.has(q.text)) ?? false).toBe(false);
        const round = await prisma.interviewRound.findFirst({ where: { sessionId: second.session.id }, select: { metrics: true } });
        expect((round!.metrics as { duplicates: Record<string, number> }).duplicates.EXACT).toBeGreaterThan(0);
    });
});

describe('the book moves while a round is worded', () => {
    it('a field the author fills meanwhile is not asked (rule 5)', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Moving ${unique()}` });
        const g = gated();
        const pending = startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 1, detail: 2 }, { generator: g.generator, embedder: null });
        await g.started;
        await updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'role', value: 'Keeps the lighthouse.' }], baseVersion: el.versionNumber });
        g.release();
        const view = await pending;
        expect(view.round!.questions.length).toBeGreaterThan(0);
        expect(view.round!.questions.flatMap((q) => q.targetsFieldKeys)).not.toContain('role');
        expect(view.round!.questions.map((q) => q.position)).toEqual(view.round!.questions.map((_, i) => i + 1));
    });

    it('an element deleted meanwhile is not asked about, and the round still opens', async () => {
        const kind = 'FACTION' as const;
        const keep = await createElement(ctx, bookId, { kind, name: `Kept ${unique()}` });
        const gone = await createElement(ctx, bookId, { kind, name: `Gone ${unique()}` });
        const g = gated();
        const pending = startInterview(ctx, bookId, { scope: 'KIND', kind, depth: 1, detail: 2 }, { generator: g.generator, embedder: null });
        await g.started;
        await deleteElement(ctx, bookId, gone.id);
        g.release();
        const view = await pending;
        expect(view.round!.status).toBe('OPEN');
        expect(view.round!.questions.every((q) => q.elementId !== gone.id)).toBe(true);
        expect(view.round!.questions.some((q) => q.elementId === keep.id)).toBe(true);
    });
});

describe('a session whose rounds keep failing', () => {
    it('still takes its next round past the bounded read of its rounds', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Failing ${unique()}` });
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 1, detail: 2 }, { generator: fakeGenerator(), embedder: null });
        await stopInterview(ctx, bookId, view.session.id);
        // A paused session that has failed 60 rounds since (rounds 2..61).
        await prisma.interviewSession.update({ where: { id: view.session.id }, data: { status: 'PAUSED', stopReason: 'PROVIDER_FAILURE', endedAt: null } });
        await prisma.interviewRound.createMany({
            data: Array.from({ length: 60 }, (_, i) => ({ workspaceId: ctx.workspaceId, sessionId: view.session.id, number: i + 2, status: 'FAILED' as const, plan: {}, promptVersion: 'test' })),
        });
        const resumed = await nextRound(ctx, bookId, view.session.id, { generator: fakeGenerator(), embedder: null });
        expect(resumed.session.status).toBe('ACTIVE');
        expect(resumed.round).toMatchObject({ number: 62, status: 'OPEN' });
    });
});

describe('answers', () => {
    it('a question takes at most a bounded number of revisions, so the session’s answer read is never cut', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Revised ${unique()}` });
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 1, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const q = view.round!.questions.find((x) => x.kind === 'OPEN')!;
        for (let i = 1; i <= 20; i++) await answerQuestion(ctx, bookId, view.session.id, q.id, { text: `Draft ${i}.` });
        expect(await refusal(answerQuestion(ctx, bookId, view.session.id, q.id, { text: 'Draft 21.' }))).toEqual({ status: 409, reason: 'ANSWER_REVISIONS_EXHAUSTED' });
        expect(await prisma.answer.count({ where: { questionId: q.id } })).toBe(20);
    });

    it('two submissions at once are two revisions, never a conflict', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Twice ${unique()}` });
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 1, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const q = view.round!.questions.find((x) => x.kind === 'OPEN')!;
        const results = await Promise.all([
            answerQuestion(ctx, bookId, view.session.id, q.id, { text: 'One.' }),
            answerQuestion(ctx, bookId, view.session.id, q.id, { text: 'Two.' }),
        ]);
        expect(results.map((r) => r.answer!.revision).sort()).toEqual([1, 2]);
    });
});

describe('the token budget', () => {
    it('what the calls report is charged to the session', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Charged ${unique()}` });
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 1, detail: 3 }, { generator: fakeGenerator({ tokensPerCall: 4_321 }), embedder: null });
        const row = await prisma.interviewSession.findUnique({ where: { id: view.session.id }, select: { tokensUsed: true } });
        expect(row!.tokensUsed).toBe(4_321);
    });

    it('a session whose budget the next round would pass pauses saying so, before any call', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Spent ${unique()}` });
        const gen = fakeGenerator({ tokensPerCall: 1_000_000 });
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 2, detail: 3 }, { generator: gen, embedder: null });
        for (const q of view.round!.questions) {
            const reply = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'An answer.' };
            await answerQuestion(ctx, bookId, view.session.id, q.id, reply);
        }
        // Answering the first level opens the second: something is left to ask, and the budget is spent.
        const closed = await closeRound(ctx, bookId, view.session.id, '1', {});
        expect(closed.session).toMatchObject({ status: 'PAUSED', stopReason: 'TOKEN_BUDGET' });
        const calls = gen.calls.length;
        const next = await nextRound(ctx, bookId, view.session.id, { generator: gen, embedder: null });
        expect(next.session).toMatchObject({ status: 'PAUSED', stopReason: 'TOKEN_BUDGET' });
        expect(gen.calls.length).toBe(calls);
    });
});

describe('the packs', () => {
    it('a pack that will not load refuses the request before anything is written', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Packless ${unique()}` });
        jest.spyOn(packsModule, 'getPacks').mockImplementation(() => {
            throw new Error('ENOENT: src/lib/interview/packs/craft/character/PACK.md');
        });
        await expect(startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id }, { generator: fakeGenerator(), embedder: null })).rejects.toThrow(/ENOENT/);
        expect(await prisma.interviewSession.count({ where: { targetElementId: el.id } })).toBe(0);
    });
});

describe('a deleted book', () => {
    it('answers 404 on every interview usecase', async () => {
        const doomed = (await createBook(ctx, { title: `Doomed ${unique()}` })).id;
        const el = await createElement(ctx, doomed, { kind: 'CHARACTER', name: 'Last Light' });
        const view = await startInterview(ctx, doomed, { scope: 'ELEMENT', elementId: el.id, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const sessionId = view.session.id;
        const qid = view.round!.questions[0].id;
        await deleteBook(ctx, doomed);
        const deps = { generator: fakeGenerator(), embedder: null };
        const calls: Array<[string, () => Promise<unknown>]> = [
            ['start', () => startInterview(ctx, doomed, { scope: 'ELEMENT', elementId: el.id }, deps)],
            ['list', () => listInterviews(ctx, doomed)],
            ['get', () => getInterview(ctx, doomed, sessionId)],
            ['next', () => nextRound(ctx, doomed, sessionId, deps)],
            ['close', () => closeRound(ctx, doomed, sessionId, '1', { skipUnanswered: true })],
            ['stop', () => stopInterview(ctx, doomed, sessionId)],
            ['answer', () => answerQuestion(ctx, doomed, sessionId, qid, { text: 'x' })],
            ['skip', () => skipQuestion(ctx, doomed, sessionId, qid)],
            ['later', () => decideLater(ctx, doomed, sessionId, qid)],
        ];
        for (const [name, call] of calls) expect([name, (await refusal(call())).status]).toEqual([name, 404]);
        expect(await prisma.answer.count({ where: { questionId: qid } })).toBe(0);
    });
});
