/**
 * Phase 2.H items 2 and 5, against a real PostgreSQL and the fake Messages API
 * (2.1's real `callStructured`, its ledger and its records; no network):
 *
 *   COST (item 2) — every model feature stops cleanly at its session's (or
 *   run's) token budget and at the workspace's monthly ceiling, sending
 *   nothing it cannot pay for and writing nothing it cannot finish:
 *     the interview's rounds (also `interview-engine-hardening`,
 *     `interview-model-wiring`), "Ask me this differently", reconcile, and a
 *     research run (its depth's gather budget and the ceiling).
 *
 *   FAILURE MODES (item 5) — a model timeout, an answer invalid twice (after
 *   2.1's one repair) and a provider outage each end the interview, a
 *   reconcile run and a research run in a RESUMABLE state with a named
 *   reason the page words in plain English: the next round, a re-run, a
 *   re-dispatch, each of which then works.
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { callStructured } from '@/app-layer/usecases/model-calls';
import { nextRound, startInterview } from '@/app-layer/usecases/interviews';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { rephraseQuestion } from '@/app-layer/usecases/interview-rephrase';
import { reconcileRound } from '@/app-layer/usecases/enrichment-reconcile';
import { createResearchBrief, dispatchResearchRun } from '@/app-layer/usecases/research-briefs';
import { executeResearchRun } from '@/app-layer/usecases/research-run';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { stubReconcileAnswer } from '@/lib/ai/model-stub';
import { embedderFrom } from '@/app-layer/usecases/question-embeddings';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { reconcilerOver } from '@/lib/enrichment/model-seam';
import { questionGeneratorOver } from '@/lib/interview/model-seam';
import { defaultResearcher } from '@/lib/research/model-seam';
import { TOKENS_PER_RECONCILE_CALL } from '@/lib/interview/dials';
import { TOKENS_PER_REPHRASE_CALL } from '@/lib/interview/rephrase';
import { AppError } from '@/lib/errors/types';
import { fakeAnthropic, setFakeApiKey, type FakeAnthropic, type FakeTurn } from '../helpers/fake-anthropic';
import { questionModel } from '../helpers/fake-question-model';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { seedReconciledRound } from '../helpers/enrichment';
import { gatherEvents, MOUNTED_GATE, type FakePage } from '../helpers/research';
import { createAccount, workspaceCtx } from '../helpers/workspaces';
import en from '../../messages/en.json';

const embedder = embedderFrom(new StubEmbeddingProvider());
const USAGE = { input_tokens: 2_000, output_tokens: 500 };
/** A deadline short enough that a hanging stream ends the call TIMEOUT within the test. */
const SHORT_DEADLINE_MS = 300;

let restoreKey: () => void;
beforeEach(() => {
    restoreKey = setFakeApiKey();
});
afterEach(() => {
    restoreKey();
    delete process.env.AI_DISABLED;
    delete process.env.AI_MONTHLY_CEILING_USD_DEFAULT;
});
afterAll(() => prisma.$disconnect());

async function setup() {
    const owner = await createAccount();
    const ctx = workspaceCtx(owner);
    const bookId = (await createBook(ctx, { title: 'The Weir Ledger' })).id;
    const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Tamsin Reed', fields: [{ key: 'role', value: 'A lock keeper on the old canal.' }] })).id;
    return { owner, ctx, bookId, elementId };
}

const budgetOf = async (sessionId: string) => (await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId }, select: { tokenBudget: true } })).tokenBudget;

/** An element interview whose first round is open and fully answered (not yet closed). */
async function answeredRound(ctx: WorkspaceRequestContext, bookId: string, elementId: string) {
    const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
    for (const q of view.round!.questions) {
        await answerQuestion(ctx, bookId, view.session.id, q.id, q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: `The ${q.targetsFieldKeys[0].split('_').join(' ')} is plain and true.` });
    }
    return view;
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, reason: (err.details as { reason?: unknown } | undefined)?.reason };
        throw err;
    }
    throw new Error('expected a refusal');
}

/** A sentence the page shows for a code: present, and a sentence rather than a code. */
function plainMessage(group: Record<string, unknown>, code: string): string {
    const text = group[code];
    expect([code, typeof text]).toEqual([code, 'string']);
    expect(text as string).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b/);
    expect((text as string).length).toBeGreaterThan(10);
    return text as string;
}

const wiredGenerator = (ctx: WorkspaceRequestContext, api: FakeAnthropic, timeoutMs?: number) =>
    questionGeneratorOver((input) => callStructured(ctx, input, { fetch: api.fetch, timeoutMs }));
const wiredReconciler = (ctx: WorkspaceRequestContext, api: FakeAnthropic, timeoutMs?: number) =>
    reconcilerOver((input) => callStructured(ctx, input, { fetch: api.fetch, timeoutMs }));
const reconcileTurn: FakeTurn = { kind: 'respond', answer: (body) => ({ kind: 'text', text: JSON.stringify(stubReconcileAnswer(body)), usage: USAGE }) };
const notJson: FakeTurn = { kind: 'text', text: 'not json', usage: { input_tokens: 400, output_tokens: 20 } };
const outage: FakeTurn = { kind: 'repeat', turn: { kind: 'http-error', status: 529, type: 'overloaded_error' } };
const hang: FakeTurn = { kind: 'hang', usage: { input_tokens: 100, output_tokens: 1 } };

describe('cost: "Ask me this differently" stops at the session budget and at the month', () => {
    it('a session that cannot take one more rephrase call is 409 TOKEN_BUDGET; a month that cannot take it is 409 WORKSPACE_CEILING — nothing sent, the question still answerable', async () => {
        const { owner, ctx, bookId, elementId } = await setup();
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const q = view.round!.questions[0];
        const api = fakeAnthropic([questionModel({ usage: USAGE })]);
        const generator = wiredGenerator(ctx, api);

        await prisma.interviewSession.update({ where: { id: view.session.id }, data: { tokensUsed: (await budgetOf(view.session.id)) - TOKENS_PER_REPHRASE_CALL + 1 } });
        expect(await refusal(rephraseQuestion(ctx, bookId, view.session.id, q.id, { generator, embedder: null }))).toEqual({ status: 409, reason: 'TOKEN_BUDGET' });

        await prisma.interviewSession.update({ where: { id: view.session.id }, data: { tokensUsed: 0 } });
        process.env.AI_MONTHLY_CEILING_USD_DEFAULT = '0';
        expect(await refusal(rephraseQuestion(ctx, bookId, view.session.id, q.id, { generator, embedder: null }))).toEqual({ status: 409, reason: 'WORKSPACE_CEILING' });

        expect(api.requests).toHaveLength(0);
        expect(await prisma.aiCallLog.count({ where: { workspaceId: owner.workspaceId } })).toBe(0);
        // Nothing stopped: the author answers the question as it stands.
        const reply = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'An answer.' };
        await expect(answerQuestion(ctx, bookId, view.session.id, q.id, reply)).resolves.toBeDefined();
        plainMessage(en.interview.errors, 'TOKEN_BUDGET');
        plainMessage(en.interview.errors, 'WORKSPACE_CEILING');
    });
});

describe('"Ask me this differently" is gated on its evaluation record (D11, 2.H item 7)', () => {
    it('without a record this deployment accepts it is a 503 REPHRASE_NOT_EVALUATED before any call, nothing written', async () => {
        const { owner, ctx, bookId, elementId } = await setup();
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const api = fakeAnthropic([questionModel({ usage: USAGE })]);
        const gate = async () => ({ mounted: false as const, reason: 'STRUCTURAL_RECORD_REFUSED' as const, detail: 'test' });
        expect(await refusal(rephraseQuestion(ctx, bookId, view.session.id, view.round!.questions[0].id, { generator: wiredGenerator(ctx, api), embedder: null, rephraseGate: gate }))).toEqual({
            status: 503,
            reason: 'REPHRASE_NOT_EVALUATED',
        });
        expect(api.requests).toHaveLength(0);
        expect(await prisma.aiCallLog.count({ where: { workspaceId: owner.workspaceId } })).toBe(0);
        expect(await prisma.question.count({ where: { sessionId: view.session.id, replacesQuestionId: { not: null } } })).toBe(0);
        plainMessage(en.interview.errors, 'REPHRASE_NOT_EVALUATED');
    });
});

describe('cost: the workspace’s model-call rate (issue #32, item 5)', () => {
    afterEach(() => {
        delete process.env.RATE_LIMIT_ENABLED;
    });
    it('a workspace past its minute’s model calls is refused 429 MODEL_RATE_LIMITED before a session is written; another workspace is not', async () => {
        const { ctx, bookId, elementId } = await setup();
        const other = await setup();
        process.env.RATE_LIMIT_ENABLED = '1';
        const { chargeModelCalls, MODEL_CALLS_LIMIT } = await import('@/lib/security/model-call-rate-limit');
        chargeModelCalls(ctx.workspaceId, MODEL_CALLS_LIMIT.maxAttempts);
        const gen = fakeGenerator();
        const before = await prisma.interviewSession.count({ where: { bookId } });
        expect(await refusal(startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: gen, embedder: null }))).toEqual({ status: 429, reason: 'MODEL_RATE_LIMITED' });
        expect(gen.calls).toHaveLength(0);
        expect(await prisma.interviewSession.count({ where: { bookId } })).toBe(before);
        const ok = await startInterview(other.ctx, other.bookId, { scope: 'ELEMENT', elementId: other.elementId, depth: 2, detail: 3 }, { generator: gen, embedder: null });
        expect(ok.round?.status).toBe('OPEN');
        plainMessage(en.interview.errors, 'MODEL_RATE_LIMITED');
    });
});

describe('cost: reconcile stops at the session budget and at the month', () => {
    it('a session that cannot take the reconcile call ends the run REFUSED TOKEN_BUDGET: no call, answers kept, worded', async () => {
        const { ctx, bookId, elementId } = await setup();
        const calls = { n: 0 };
        // Spend the session's budget down to less than a reconcile call once the round is open.
        const spending = {
            unavailableReason: () => null,
            async reconcile() {
                calls.n++;
                return { output: { operations: [], newElements: [] }, tokensUsed: 1, costMicroUsd: 1 };
            },
        };
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        await prisma.interviewSession.update({ where: { id: view.session.id }, data: { tokensUsed: (await budgetOf(view.session.id)) - TOKENS_PER_RECONCILE_CALL + 1 } });
        const q = view.round!.questions.find((x) => x.kind === 'OPEN') ?? view.round!.questions[0];
        await answerQuestion(ctx, bookId, view.session.id, q.id, q.kind === 'OPEN' ? { text: 'He keeps the lock log in a tin box.' } : q.kind === 'SCALE' ? { scale: 3 } : { choice: q.options![0] });
        const { closeRoundAndReconcile } = await import('@/app-layer/usecases/enrichment-reconcile');
        const closed = await closeRoundAndReconcile(ctx, bookId, view.session.id, '1', { skipUnanswered: true }, { reconciler: spending, gate: MOUNTED_GATE });
        expect(closed.reconcile).toMatchObject({ status: 'REFUSED', outcome: 'TOKEN_BUDGET' });
        expect(calls.n).toBe(0);
        expect(await prisma.answer.count({ where: { sessionId: view.session.id } })).toBeGreaterThan(0);
        plainMessage(en.enrichment.runStatus, 'TOKEN_BUDGET');
    });

    it('a round is not opened unless the budget can also take its reconcile: the session pauses TOKEN_BUDGET before the call', async () => {
        const { ctx, bookId, elementId } = await setup();
        const gen = fakeGenerator();
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 3, detail: 3 }, { generator: gen, embedder: null });
        for (const q of view.round!.questions) {
            await answerQuestion(ctx, bookId, view.session.id, q.id, q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'A plain answer.' });
        }
        const { closeRound } = await import('@/app-layer/usecases/interviews');
        // Room for the next round's question call, not for its reconcile too.
        await prisma.interviewSession.update({ where: { id: view.session.id }, data: { tokensUsed: (await budgetOf(view.session.id)) - 9_000 - TOKENS_PER_RECONCILE_CALL + 1 } });
        const closed = await closeRound(ctx, bookId, view.session.id, '1', {});
        const calls = gen.calls.length;
        const next = closed.session.status === 'ACTIVE' ? await nextRound(ctx, bookId, view.session.id, { generator: gen, embedder: null }) : closed;
        expect(next.session).toMatchObject({ status: 'PAUSED', stopReason: 'TOKEN_BUDGET' });
        expect(gen.calls.length).toBe(calls);
    });

    it('a month that cannot take the call ends the run FAILED WORKSPACE_CEILING with nothing sent, and a re-run reconciles once the month can', async () => {
        const { ctx, bookId, elementId } = await setup();
        const api = fakeAnthropic([reconcileTurn]);
        const view = await answeredRound(ctx, bookId, elementId);
        process.env.AI_MONTHLY_CEILING_USD_DEFAULT = '0';
        const { closeRoundAndReconcile } = await import('@/app-layer/usecases/enrichment-reconcile');
        const closed = await closeRoundAndReconcile(ctx, bookId, view.session.id, '1', {}, { reconciler: wiredReconciler(ctx, api), gate: MOUNTED_GATE });
        expect(closed.reconcile).toMatchObject({ status: 'FAILED', outcome: 'WORKSPACE_CEILING' });
        expect(api.requests).toHaveLength(0);
        plainMessage(en.enrichment.runStatus, 'WORKSPACE_CEILING');
        delete process.env.AI_MONTHLY_CEILING_USD_DEFAULT;
        const rerun = await reconcileRound(ctx, bookId, view.session.id, '1', { reconciler: wiredReconciler(ctx, api), gate: MOUNTED_GATE });
        expect(rerun).toMatchObject({ status: 'DONE', outcome: 'OK', attempts: 2 });
    });
});

const PAGE: FakePage = {
    url: 'https://canals.example.org/locks',
    title: 'Canal locks',
    text: 'A lock keeper opened the paddles slowly so the chamber filled without rocking the narrowboat. Keepers kept a daily log of every boat that passed the lock.',
};
const gatherTurn: FakeTurn = { kind: 'events', events: gatherEvents({ query: 'how canal lock keepers worked', pages: [PAGE] }) };

async function briefOf(ctx: WorkspaceRequestContext, bookId: string, elementId: string) {
    return createResearchBrief(ctx, bookId, { question: 'How did canal lock keepers work?', purpose: 'A lock keeper in my story needs believable routines.', scopeElementIds: [elementId], depth: 'QUICK' });
}

async function runOnce(ctx: WorkspaceRequestContext, bookId: string, briefId: string, turns: FakeTurn[], timeoutMs?: number) {
    const api = fakeAnthropic(turns);
    const { runId } = await dispatchResearchRun(ctx, bookId, briefId, { gate: MOUNTED_GATE, enqueue: async () => undefined });
    await executeResearchRun({ workspaceId: ctx.workspaceId, runId }, { gate: MOUNTED_GATE, researcher: (c) => defaultResearcher(c, { fetch: api.fetch, timeoutMs }) });
    const run = await prisma.researchRun.findUniqueOrThrow({ where: { id: runId } });
    return { api, run };
}

describe('cost: a research run stops at its depth budget and at the month', () => {
    it('the month: FAILED WORKSPACE_CEILING, no request sent, worded; the brief can be dispatched again', async () => {
        const { ctx, bookId, elementId } = await setup();
        const brief = await briefOf(ctx, bookId, elementId);
        process.env.AI_MONTHLY_CEILING_USD_DEFAULT = '0';
        const { api, run } = await runOnce(ctx, bookId, brief.id, [gatherTurn]);
        expect(run).toMatchObject({ status: 'FAILED', outcome: 'WORKSPACE_CEILING' });
        expect(api.requests).toHaveLength(0);
        plainMessage(en.research.outcome, 'WORKSPACE_CEILING');
        delete process.env.AI_MONTHLY_CEILING_USD_DEFAULT;
        await expect(dispatchResearchRun(ctx, bookId, brief.id, { gate: MOUNTED_GATE, enqueue: async () => undefined })).resolves.toMatchObject({ runId: expect.any(String) });
    });

    it('the depth’s gather budget: a turn that spends it before any page is read ends DONE BUDGET_SPENT, saying so, with no further request', async () => {
        const { ctx, bookId, elementId } = await setup();
        const brief = await briefOf(ctx, bookId, elementId);
        // A pause_turn that read nothing but cost past QUICK's gather budget.
        const spent: FakeTurn = {
            kind: 'events',
            events: [
                { type: 'message_start', message: { id: 'msg_spent', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 200_000, output_tokens: 1 } } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searching.' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'message_delta', delta: { stop_reason: 'pause_turn', stop_sequence: null }, usage: { output_tokens: 40_000 } },
                { type: 'message_stop' },
            ],
        };
        const { api, run } = await runOnce(ctx, bookId, brief.id, [spent, gatherTurn]);
        expect(run).toMatchObject({ status: 'DONE', outcome: 'BUDGET_SPENT' });
        expect(api.requests).toHaveLength(1);
        plainMessage(en.research.outcome, 'BUDGET_SPENT');
    });
});

describe('failure modes: each ends resumable, with a plain message', () => {
    // A character whose only open field at depth 1 has no pack example, so a
    // failed call leaves the round empty (no fallback question hides the failure).
    const unaskable = async (ctx: WorkspaceRequestContext, bookId: string) =>
        (await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Unaskable ${Math.random()}`, fields: [{ key: 'role', value: 'Keeps the lock log.' }] })).id;

    it.each([
        ['a model timeout', [hang], SHORT_DEADLINE_MS, 'PROVIDER_FAILURE'],
        ['an answer invalid twice', [notJson, notJson], undefined, 'NO_ACCEPTABLE_QUESTION'],
        ['a provider outage', [outage], undefined, 'PROVIDER_FAILURE'],
    ] as const)('the interview: %s pauses the session with a worded reason; the next round resumes it', async (_label, turns, timeoutMs, reason) => {
        const { ctx, bookId } = await setup();
        const elementId = await unaskable(ctx, bookId);
        const failed = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 1, detail: 1 }, { generator: wiredGenerator(ctx, fakeAnthropic([...turns]), timeoutMs), embedder });
        expect(failed.session).toMatchObject({ status: 'PAUSED', stopReason: reason });
        plainMessage(en.interview.stop, reason);
        const resumed = await nextRound(ctx, bookId, failed.session.id, { generator: wiredGenerator(ctx, fakeAnthropic([questionModel({ usage: USAGE })])), embedder });
        expect(resumed.session.status).toBe('ACTIVE');
        expect(resumed.round!.questions.length).toBeGreaterThan(0);
    });

    it.each([
        ['a model timeout', [hang], SHORT_DEADLINE_MS, 'TIMEOUT'],
        ['an answer invalid twice', [notJson, notJson], undefined, 'INVALID_OUTPUT'],
        ['a provider outage', [outage], undefined, 'PROVIDER_FAILURE'],
    ] as const)('reconcile: %s ends the run FAILED with a worded outcome; a re-run proposes', async (_label, turns, timeoutMs, outcome) => {
        const { ctx, bookId, elementId } = await setup();
        const seeded = await seedReconciledRound(ctx, bookId, elementId, { reconciler: wiredReconciler(ctx, fakeAnthropic([...turns]), timeoutMs), gate: MOUNTED_GATE });
        expect(seeded.closed.reconcile).toMatchObject({ status: 'FAILED', outcome });
        expect(await prisma.enrichmentProposal.count({ where: { sessionId: seeded.sessionId } })).toBe(0);
        plainMessage(en.enrichment.runStatus, outcome);
        const rerun = await reconcileRound(ctx, bookId, seeded.sessionId, '1', { reconciler: wiredReconciler(ctx, fakeAnthropic([reconcileTurn])), gate: MOUNTED_GATE });
        expect(rerun).toMatchObject({ status: 'DONE', outcome: 'OK', attempts: 2 });
    });

    it.each([
        ['a model timeout', [hang], SHORT_DEADLINE_MS, 'TIMEOUT'],
        ['an answer invalid twice', [gatherTurn, notJson, notJson], undefined, 'INVALID_OUTPUT'],
        ['a provider outage', [outage], undefined, 'PROVIDER_FAILURE'],
    ] as const)('research: %s ends the run FAILED with a worded outcome; the brief is dispatched again', async (_label, turns, timeoutMs, outcome) => {
        const { ctx, bookId, elementId } = await setup();
        const brief = await briefOf(ctx, bookId, elementId);
        const { run } = await runOnce(ctx, bookId, brief.id, [...turns], timeoutMs);
        expect(run).toMatchObject({ status: 'FAILED', outcome });
        plainMessage(en.research.outcome, outcome);
        await expect(dispatchResearchRun(ctx, bookId, brief.id, { gate: MOUNTED_GATE, enqueue: async () => undefined })).resolves.toMatchObject({ runId: expect.any(String) });
    });
});
