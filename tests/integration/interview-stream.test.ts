/**
 * The interview experience's server side (Phase 2.4), against a real
 * PostgreSQL: the streamed start and next-round routes (events in order,
 * drafts before the commit, refusals before the stream as JSON, cancellation
 * abandoning the round and leaving the session resumable), "Ask me this
 * differently" (a rephrase replaces the question; only one of the pair is
 * answerable), the guard flag on a question, the stubbed model running the
 * real 2.1 path, and the migration's constraints.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

const seam: { generator: import('@/lib/interview/generator').QuestionGenerator | null } = { generator: null };
jest.mock('@/lib/interview/model-seam', () => {
    const actual = jest.requireActual<typeof import('@/lib/interview/model-seam')>('@/lib/interview/model-seam');
    return {
        ...actual,
        defaultQuestionGenerator: (ctx: Parameters<typeof actual.defaultQuestionGenerator>[0]) => seam.generator ?? actual.defaultQuestionGenerator(ctx),
    };
});

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createBook } from '@/app-layer/usecases/books';
import { closeRound, getInterview, startInterview } from '@/app-layer/usecases/interviews';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { REPHRASES_PER_ROUND_MAX, rephraseQuestion } from '@/app-layer/usecases/interview-rephrase';
import { POST as startStreamRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/stream/route';
import { POST as nextStreamRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/rounds/stream/route';
import { POST as rephraseRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/questions/[questionId]/rephrase/route';
import type { InterviewView } from '@/app-layer/usecases/interview-state';
import type { GenerationRequest, QuestionGenerator } from '@/lib/interview/generator';
import { parseSseData, type InterviewStreamEvent } from '@/lib/interview/stream-events';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let owner: Awaited<ReturnType<typeof createAccount>>;
let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;

beforeAll(async () => {
    owner = await createAccount();
    session.userId = owner.userId;
    ctx = workspaceCtx(owner);
    bookId = (await createBook(ctx, { title: 'The Salt Road' })).id;
});

async function newElement(name: string): Promise<string> {
    return (await createElement(ctx, bookId, { kind: 'CHARACTER', name })).id;
}

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;

function request(path: string, body: unknown, signal?: AbortSignal): NextRequest {
    return new NextRequest(`http://localhost/api/w/${owner.workspaceSlug}/books/${bookId}/interviews${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.40' },
        body: JSON.stringify(body),
        signal,
    });
}

async function post(handler: Handler, path: string, params: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
    return handler(request(path, body, signal), { params: Promise.resolve({ workspaceSlug: owner.workspaceSlug, bookId, ...params }) as Promise<never> });
}

/** Every event of a finished stream, in order. */
async function eventsOf(res: Response): Promise<InterviewStreamEvent[]> {
    const text = await res.text();
    return text
        .split('\n\n')
        .map(parseSseData)
        .filter((e): e is InterviewStreamEvent => e !== null);
}

/** A generator whose rephrase calls word the target another way (the fake words a round's questions one way only). */
function rephrasingGenerator(options: { reviewRequired?: boolean } = {}): QuestionGenerator & { calls: GenerationRequest[] } {
    const base = fakeGenerator({
        mutate: (q, request) =>
            request.data.some((b) => b.label === 'previous-wording') ? { ...q, text: `Picture a reader meeting the ${q.targetsFieldKeys[0].split('_').join(' ')}: what do they notice first?` } : q,
    });
    return {
        ...base,
        calls: base.calls,
        async generateCandidates(request, signal) {
            const result = await base.generateCandidates(request, signal);
            return options.reviewRequired ? { ...result, reviewRequired: true, guardRuleIds: ['injection.instruction_override'] } : result;
        },
    };
}

describe('the streamed start', () => {
    it('streams started, planned, thinking, drafts and checking, then the committed round, then done', async () => {
        seam.generator = fakeGenerator();
        const elementId = await newElement('Odile');
        const res = await post(startStreamRoute, '/stream', {}, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
        const events = await eventsOf(res);
        const types = events.map((e) => e.type);
        expect(types[0]).toBe('started');
        expect(types[1]).toBe('planned');
        expect(types.indexOf('thinking')).toBeGreaterThan(1);
        expect(types.slice(-2)).toEqual(['committed', 'done']);
        const drafts = events.filter((e): e is Extract<InterviewStreamEvent, { type: 'draft' }> => e.type === 'draft');
        const committed = events.find((e): e is Extract<InterviewStreamEvent, { type: 'committed' }> => e.type === 'committed')!.interview;
        // Every draft arrived before the commit, and the commit is what the database holds.
        expect(types.lastIndexOf('draft')).toBeLessThan(types.indexOf('checking'));
        expect(drafts.length).toBe(committed.round!.questions.length);
        expect(drafts.map((d) => d.question.text).sort()).toEqual(committed.round!.questions.map((q) => q.text).sort());
        const started = events[0] as Extract<InterviewStreamEvent, { type: 'started' }>;
        expect(committed.session.id).toBe(started.sessionId);
        const planned = events[1] as Extract<InterviewStreamEvent, { type: 'planned' }>;
        expect(planned.targets.map((t) => t.fieldKey).sort()).toEqual(committed.round!.questions.flatMap((q) => q.targetsFieldKeys).sort());
        expect((await getInterview(ctx, bookId, started.sessionId)).round).toMatchObject({ status: 'OPEN', number: 1 });
    });

    it('answers a refusal before anything is written as the ordinary JSON error (no key: 503 AI_UNAVAILABLE)', async () => {
        seam.generator = null;
        const elementId = await newElement('Bram');
        const before = await prisma.interviewSession.count({ where: { bookId } });
        const res = await post(startStreamRoute, '/stream', {}, { scope: 'ELEMENT', elementId });
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: unknown }).error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'CREDENTIAL_NOT_CONFIGURED' } });
        expect(await prisma.interviewSession.count({ where: { bookId } })).toBe(before);
        // A malformed body is a 400, never a stream.
        expect((await post(startStreamRoute, '/stream', {}, { scope: 'ELEMENT' })).status).toBe(400);
    });

    it('a cancelled stream cuts the model call, abandons the round (no question written) and leaves the session resumable', async () => {
        let callAborted = false;
        let release: () => void = () => {};
        const called = new Promise<void>((resolve) => (release = resolve));
        seam.generator = {
            unavailableReason: () => null,
            generateCandidates: (_request, signal) =>
                new Promise((_resolve, reject) => {
                    release();
                    signal?.addEventListener('abort', () => {
                        callAborted = true;
                        // As 2.1 answers a caller's abort: a named failure of this call.
                        reject(new Error('aborted'));
                    });
                }),
        };
        const elementId = await newElement('Cass');
        const abort = new AbortController();
        const res = await post(startStreamRoute, '/stream', {}, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, abort.signal);
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        await called;
        await reader.cancel();
        abort.abort();
        // The round settles FAILED once the usecase sees the abort.
        let sessionRow: { id: string; status: string } | null = null;
        for (let i = 0; i < 100; i++) {
            sessionRow = await prisma.interviewSession.findFirst({ where: { bookId, targetElementId: elementId }, select: { id: true, status: true } });
            const rounds = sessionRow ? await prisma.interviewRound.findMany({ where: { sessionId: sessionRow.id }, select: { status: true } }) : [];
            if (rounds.length > 0 && rounds.every((r) => r.status === 'FAILED')) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        expect(callAborted).toBe(true);
        expect(sessionRow).toMatchObject({ status: 'ACTIVE' });
        expect(await prisma.question.count({ where: { sessionId: sessionRow!.id } })).toBe(0);
        expect(await prisma.interviewRound.findMany({ where: { sessionId: sessionRow!.id }, select: { status: true } })).toEqual([{ status: 'FAILED' }]);

        // Resumable: the next round streams in.
        seam.generator = fakeGenerator();
        const next = await post(nextStreamRoute, `/${sessionRow!.id}/rounds/stream`, { sessionId: sessionRow!.id }, {});
        const events = await eventsOf(next);
        const committed = events.find((e): e is Extract<InterviewStreamEvent, { type: 'committed' }> => e.type === 'committed')!.interview;
        expect(committed.round).toMatchObject({ status: 'OPEN', number: 2 });
    });

    it('refuses a next round while one is open: 409 ROUND_OPEN as JSON, nothing written', async () => {
        seam.generator = fakeGenerator();
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: await newElement('Dov'), depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const res = await post(nextStreamRoute, `/${view.session.id}/rounds/stream`, { sessionId: view.session.id }, {});
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: { details: unknown } }).error.details).toMatchObject({ reason: 'ROUND_OPEN' });
    });

    it('marks a question whose call the guard flagged (reviewRequired), and only those', async () => {
        const flagged = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: await newElement('Eda'), depth: 2, detail: 3 }, { generator: rephrasingGenerator({ reviewRequired: true }), embedder: null });
        expect(flagged.round!.questions.length).toBeGreaterThan(0);
        expect(flagged.round!.questions.every((q) => q.reviewRequired)).toBe(true);
        const plain = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: await newElement('Fen'), depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        expect(plain.round!.questions.every((q) => !q.reviewRequired)).toBe(true);
    });
});

describe('"Ask me this differently"', () => {
    async function freshRound(name: string): Promise<InterviewView> {
        return startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: await newElement(name), depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
    }

    it('replaces the question in its place; the original can no longer be answered, and closing the round does not wait for it', async () => {
        const view = await freshRound('Gil');
        const [first, ...others] = view.round!.questions;
        seam.generator = rephrasingGenerator();
        const res = await post(rephraseRoute, `/${view.session.id}/questions/${first.id}/rephrase`, { sessionId: view.session.id, questionId: first.id }, {});
        expect(res.status).toBe(201);
        const replacement = ((await res.json()) as { question: { id: string; replacesQuestionId: string; targetsFieldKeys: string[]; text: string } }).question;
        expect(replacement).toMatchObject({ replacesQuestionId: first.id, targetsFieldKeys: first.targetsFieldKeys });
        expect(replacement.text).not.toBe(first.text);
        // The rephrase prompt went to the fast tier, the old wording as data, never in the system prompt.
        const call = (seam.generator as ReturnType<typeof rephrasingGenerator>).calls.at(-1)!;
        expect(call.template).toMatchObject({ id: 'interview.rephrase', tier: 'fast' });
        expect(call.data.find((b) => b.label === 'previous-wording')!.text).toContain(first.text);
        expect(call.template.system).not.toContain(first.text);

        const after = await getInterview(ctx, bookId, view.session.id);
        expect(after.round!.questions.map((q) => q.id)).toEqual([replacement.id, ...others.map((q) => q.id)]);
        expect(after.progress).toMatchObject({ asked: view.round!.questions.length });

        await expect(answerQuestion(ctx, bookId, view.session.id, first.id, { text: 'x' })).rejects.toMatchObject({ details: { reason: 'QUESTION_SUPERSEDED' } });
        await expect(rephraseQuestion(ctx, bookId, view.session.id, first.id, { generator: rephrasingGenerator(), embedder: null })).rejects.toMatchObject({ details: { reason: 'QUESTION_SUPERSEDED' } });
        // Answer everything asked; the replaced question waits for nothing.
        for (const q of after.round!.questions) {
            const body = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'A plain reply.' };
            await answerQuestion(ctx, bookId, view.session.id, q.id, body);
        }
        const closed = await closeRound(ctx, bookId, view.session.id, '1', {});
        expect(closed.round).toMatchObject({ status: 'CLOSED' });
        expect(await prisma.answer.count({ where: { questionId: first.id } })).toBe(0);
        expect(await prisma.question.findUniqueOrThrow({ where: { id: first.id }, select: { supersededAt: true } })).toMatchObject({ supersededAt: expect.any(Date) });
    });

    it('refuses an answered question, and never takes a repeat of the same wording as a rephrase', async () => {
        const view = await freshRound('Hale');
        const [first, second] = view.round!.questions;
        await answerQuestion(ctx, bookId, view.session.id, first.id, first.kind === 'CHOICE' || first.kind === 'EITHER_OR' ? { choice: first.options![0] } : first.kind === 'SCALE' ? { scale: 2 } : { text: 'Yes.' });
        await expect(rephraseQuestion(ctx, bookId, view.session.id, first.id, { generator: rephrasingGenerator(), embedder: null })).rejects.toMatchObject({ details: { reason: 'QUESTION_ANSWERED' } });

        // The plain fake words the same question again: a repeat is never a rephrase (the pack may offer one instead).
        const before = await prisma.question.count({ where: { sessionId: view.session.id } });
        try {
            const r = await rephraseQuestion(ctx, bookId, view.session.id, second.id, { generator: fakeGenerator(), embedder: null });
            expect(r.origin).toBe('PACK_FALLBACK');
            expect(r.text).not.toBe(second.text);
        } catch (err) {
            expect(err).toMatchObject({ details: { reason: 'NO_REPHRASE' } });
            expect(await prisma.question.count({ where: { sessionId: view.session.id } })).toBe(before);
        }
    });

    it('stops at REPHRASES_PER_ROUND_MAX rephrases a round', async () => {
        const view = await freshRound('Iva');
        let current = view.round!.questions[0];
        for (let i = 0; i < REPHRASES_PER_ROUND_MAX; i++) {
            const gen = fakeGenerator({
                mutate: (q, request) =>
                    request.data.some((b) => b.label === 'previous-wording') ? { ...q, text: [`Picture a reader meeting this: what stands out first?`, `Say it to a stranger: how would it sound?`, `Look back from the ending: what changed?`, `Name the smallest detail that proves it: which is it?`][i] } : q,
            });
            current = await rephraseQuestion(ctx, bookId, view.session.id, current.id, { generator: gen, embedder: null });
        }
        await expect(rephraseQuestion(ctx, bookId, view.session.id, current.id, { generator: rephrasingGenerator(), embedder: null })).rejects.toMatchObject({ details: { reason: 'REPHRASE_LIMIT' } });
    });
});

describe('the stubbed model (AI_MODEL_STUB=1)', () => {
    const before = { ...process.env };
    afterEach(() => {
        for (const key of ['AI_MODEL_STUB', 'ANTHROPIC_API_KEY']) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    });

    it('runs a round through the real 2.1 path — the client, the middleware, callStructured, the ledger — with nothing sent', async () => {
        seam.generator = null;
        process.env.AI_MODEL_STUB = '1';
        delete process.env.ANTHROPIC_API_KEY;
        const elementId = await newElement('Juno');
        const res = await post(startStreamRoute, '/stream', {}, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 });
        expect(res.status).toBe(200);
        const events = await eventsOf(res);
        const committed = events.find((e): e is Extract<InterviewStreamEvent, { type: 'committed' }> => e.type === 'committed')!.interview;
        expect(committed.round!.questions.length).toBeGreaterThan(0);
        expect(committed.round!.questions.every((q) => q.origin === 'MODEL')).toBe(true);
        const calls = await prisma.aiCallLog.findMany({ where: { workspaceId: owner.workspaceId, bookId }, orderBy: { createdAt: 'desc' }, take: 1, select: { outcome: true, promptId: true } });
        expect(calls[0]).toMatchObject({ outcome: 'OK', promptId: 'interview.questions' });

        // And a rephrase on the fast tier, through the same stub.
        const q = committed.round!.questions[0];
        const rephrased = await rephraseQuestion(ctx, bookId, committed.session.id, q.id);
        expect(rephrased).toMatchObject({ origin: 'REPHRASE', replacesQuestionId: q.id });
    });

    it('steps aside for a configured key: the key, not the stub, is what a call would use', async () => {
        const { stubModelActive } = await import('@/lib/ai/config');
        expect(stubModelActive({ AI_MODEL_STUB: '1' })).toBe(true);
        expect(stubModelActive({ AI_MODEL_STUB: '1', ANTHROPIC_API_KEY: 'k' })).toBe(false);
    });
});

describe('the migration', () => {
    it('refuses a question that replaces itself, and a rephrase naming a question of another session', async () => {
        const a = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: await newElement('Kit'), depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const b = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: await newElement('Lio'), depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const qa = a.round!.questions[0];
        const qb = b.round!.questions[0];
        await expect(prisma.$executeRawUnsafe(`UPDATE "Question" SET "replacesQuestionId" = "id" WHERE "id" = $1`, qa.id)).rejects.toThrow(/Question_replaces_not_itself/);
        await expect(prisma.$executeRawUnsafe(`UPDATE "Question" SET "replacesQuestionId" = $1 WHERE "id" = $2`, qb.id, qa.id)).rejects.toThrow(/replacesQuestionId_fkey|foreign key/);
        await expect(prisma.$executeRawUnsafe(`UPDATE "Question" SET "origin" = 'REPHRASE' WHERE "id" = $1`, qa.id)).rejects.toThrow(/Question_rephrase_replaces/);
    });
});
