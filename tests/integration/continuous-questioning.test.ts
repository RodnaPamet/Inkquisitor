/**
 * CONTINUOUS, DEEP QUESTIONING (Phase 4.4, D23 and D30) against a real
 * PostgreSQL, through the product's own usecases:
 *
 *   until I stop      an open-ended session runs past six rounds, pauses VALUE_FELL when only minor questions are
 *                     left, goes on when the author says so, ends naming its reason — and never asks a question twice
 *   the hard gate     a repeat that got past a degraded read is dropped at persist (the repetition metric is a gate)
 *   length            a QUESTIONS session asks the number chosen and ends QUESTION_BUDGET
 *   generators        each can be switched off (a dial, resolved like the others)
 *   source questions  yes confirms the fact as the Facts page would, naming the answer; no rejects it; the
 *                     interview never overrides the author's own decision
 *   relations         a pair with no relation yet is asked about, and its answer may become a NEW_RELATION
 *   the tie-break     reorders only near-equal candidates, and the code's order stands (recorded) when it cannot
 *   the database      the new CHECKs hold for any writer
 *
 * The question generator is the deterministic fake; no model is called and nothing reaches the network.
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { setBookInterviewDefaults } from '@/app-layer/usecases/interview-defaults';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { rephraseQuestion } from '@/app-layer/usecases/interview-rephrase';
import { closeRound, nextRound, startInterview, stopInterview } from '@/app-layer/usecases/interviews';
import { closeRoundAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';
import { getSessionReview } from '@/app-layer/usecases/enrichment-review';
import { decideFact, listBookFacts } from '@/app-layer/usecases/source-facts';
import { QuestionRepository } from '@/app-layer/repositories/interview.repository';
import { StoryFactRepository } from '@/app-layer/repositories/source.repository';
import type { InterviewView } from '@/app-layer/usecases/interview-state';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { bookRepetition } from '@/lib/interview/repetition';
import { SOURCE_NO, SOURCE_YES } from '@/lib/interview/generators/wording';
import { defaultQuestionOrderer } from '@/lib/interview/question-order/model-seam';
import * as orderGate from '@/lib/interview/question-order/record-gate';
import committedOrderRecord from '@/lib/interview/question-order/evals/evaluation-record.json';
import { ZodError } from 'zod';
import { AppError } from '@/lib/errors/types';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { FRONTIER_ONLY, stubQuestionEmbedder } from '../helpers/interview';
import { scripted } from '../helpers/enrichment';
import { ingestText } from '../helpers/sources';
import { fakeAnthropic, setFakeApiKey } from '../helpers/fake-anthropic';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const embedder = stubQuestionEmbedder;

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, reason: (err.details as { reason?: unknown } | undefined)?.reason };
        // A request the schema refuses is a 400 at the route (withApiErrorHandling).
        if (err instanceof ZodError) return { status: 400, reason: 'INVALID_REQUEST' };
        throw err;
    }
    throw new Error('expected a refusal');
}

async function fresh(title: string) {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title })).id;
    return { ctx, bookId };
}

function bodyFor(q: InterviewView['round'] extends infer R ? (R extends { questions: Array<infer Q> } ? Q : never) : never, i: number) {
    return q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: `Answer ${i}: she keeps the tide table by lamplight.` };
}

/** Answer every question of the open round (a pick, a number, or words) and close it. */
async function answerAll(ctx: WorkspaceRequestContext, bookId: string, view: InterviewView, n: { i: number }): Promise<InterviewView> {
    for (const q of view.round!.questions) {
        await answerQuestion(ctx, bookId, view.session.id, q.id, bodyFor(q, n.i++));
    }
    return closeRound(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true });
}

async function bookRows(bookId: string) {
    const rows = await prisma.question.findMany({ where: { bookId }, select: { elementId: true, dedupeKey: true, supersededAt: true }, take: 2_000 });
    return bookRepetition(rows.map((r) => ({ elementId: r.elementId, dedupeKey: r.dedupeKey, superseded: r.supersededAt !== null })));
}

describe('until I stop (D23)', () => {
    it('runs past six rounds, pauses when only minor questions are left, goes on when told, ends naming its reason — never asking a question twice', async () => {
        const { ctx, bookId } = await fresh('The Long Night');
        const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt' })).id;
        const deps = { generator: fakeGenerator(), embedder };
        let view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 5, detail: 3, length: { mode: 'UNTIL_STOPPED' } }, deps);
        expect(view.session.length).toEqual({ mode: 'UNTIL_STOPPED' });
        expect(view.session.roundBudget).toBeNull();
        const n = { i: 0 };
        let valueFell = 0;
        const generators = new Set<string>();
        for (let guard = 0; guard < 60; guard++) {
            if (view.session.status === 'ACTIVE' && view.round?.status === 'OPEN') {
                expect(view.round.questions.length).toBeGreaterThan(0);
                for (const q of view.round.questions) generators.add(q.generator);
                view = await answerAll(ctx, bookId, view, n);
            }
            if (view.session.status === 'COMPLETED' || view.session.status === 'STOPPED') break;
            if (view.session.stopReason === 'VALUE_FELL') {
                valueFell++;
                // The pause asked nothing: it said the rest is minor. The author goes on.
                view = await nextRound(ctx, bookId, view.session.id, deps, { goOn: true });
                expect(view.session.minorAccepted).toBe(true);
            } else {
                view = await nextRound(ctx, bookId, view.session.id, deps);
            }
        }
        expect(valueFell).toBe(1);
        expect(view.session.status).toBe('COMPLETED');
        expect(['FRONTIER_EMPTY', 'NOTHING_AT_DEPTH']).toContain(view.session.stopReason);
        expect(view.session.roundsRun).toBeGreaterThan(6);
        expect(generators).toEqual(new Set(['FRONTIER', 'LADDER']));
        // The ladder went all the way down for at least one field: six layers, in order, each asked once.
        const layers = await prisma.question.findMany({ where: { sessionId: view.session.id, generator: 'LADDER', targetsFieldKeys: { has: 'want' } }, orderBy: { createdAt: 'asc' }, select: { angle: true }, take: 20 });
        expect(layers.map((l) => l.angle)).toEqual(['WHAT', 'WHY', 'COST', 'WHO_KNOWS', 'BREAKS', 'EDGE_CASES']);
        // THE REPETITION METRIC: zero repeats across the whole book.
        expect(await bookRows(bookId)).toMatchObject({ status: 'MEASURED', repeats: 0 });
        // Every stop named its reason in the audit trail.
        const ended = await prisma.auditLog.findMany({ where: { action: 'INTERVIEW_ENDED', entityId: view.session.id }, select: { detailsJson: true }, take: 10 });
        expect(ended.map((e) => (e.detailsJson as { reason?: string }).reason)).toEqual(expect.arrayContaining(['VALUE_FELL']));
        expect(ended.every((e) => typeof (e.detailsJson as { reason?: string }).reason === 'string')).toBe(true);
    }, 180_000);

    it('THE HARD GATE: a repeat that got past a degraded read is dropped at persist, so the book still holds none', async () => {
        const { ctx, bookId } = await fresh('Two Keepers');
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt' });
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ida Marsh' });
        const deps = { generator: fakeGenerator(), embedder: null };
        // Session 1 asks the pair's question and the author skips it (an angle skipped is asked again in a new session).
        const first = await startInterview(ctx, bookId, { scope: 'KIND', kind: 'CHARACTER', depth: 2, detail: 3 }, deps);
        const pair = first.round!.questions.find((q) => q.generator === 'RELATIONS' && q.angle === 'WANTS')!;
        expect(pair.text).toMatch(/^What does (Wren Holt|Ida Marsh) want from (Wren Holt|Ida Marsh)\?$/);
        await stopInterview(ctx, bookId, first.session.id);
        // Session 2 would word the same pair question; the book's exact-repeat read is degraded for the round's
        // generation (it fails open there by design), so only the persist's gate stands between it and a repeat.
        const spy = jest.spyOn(QuestionRepository, 'findExactRepeats').mockResolvedValueOnce([]);
        try {
            const second = await startInterview(ctx, bookId, { scope: 'KIND', kind: 'CHARACTER', depth: 2, detail: 3 }, deps);
            expect(second.round!.questions.some((q) => q.text === pair.text)).toBe(false);
            const round = await prisma.interviewRound.findFirstOrThrow({ where: { sessionId: second.session.id, number: 1 }, select: { metrics: true } });
            expect((round.metrics as { repeatsBlocked?: number }).repeatsBlocked).toBeGreaterThanOrEqual(1);
        } finally {
            spy.mockRestore();
        }
        expect(await bookRows(bookId)).toMatchObject({ status: 'MEASURED', repeats: 0 });
    }, 60_000);
});

describe('session length and generators', () => {
    it('a QUESTIONS session asks the number chosen, its last round cut to what is left, and ends QUESTION_BUDGET', async () => {
        const { ctx, bookId } = await fresh('Three Questions');
        const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt', fields: [{ key: 'role', value: 'The lock-keeper’s daughter.' }] })).id;
        const deps = { generator: fakeGenerator(), embedder };
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 3, detail: 3, length: { mode: 'QUESTIONS', questions: 3 } }, deps);
        expect(view.round!.questions).toHaveLength(3);
        const ended = await answerAll(ctx, bookId, view, { i: 0 });
        expect(ended.session).toMatchObject({ status: 'COMPLETED', stopReason: 'QUESTION_BUDGET', length: { mode: 'QUESTIONS', questions: 3 } });
        // A ROUNDS session may run past six: the limit is the author's, up to thirty.
        const long = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 3, detail: 3, length: { mode: 'ROUNDS', rounds: 12 } }, deps);
        expect(long.session.roundBudget).toBe(12);
        expect(await refusal(startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, length: { mode: 'ROUNDS', rounds: 31 } }, deps))).toMatchObject({ status: 400 });
    }, 60_000);

    it('a generator switched off proposes nothing, and the setting resolves like a dial (book default, then the request)', async () => {
        const { ctx, bookId } = await fresh('Switched Off');
        const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt', fields: [{ key: 'role', value: 'The lock-keeper’s daughter.' }] })).id;
        const deps = { generator: fakeGenerator(), embedder };
        const on = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 3, detail: 3 }, deps);
        expect(on.round!.questions.some((q) => q.generator === 'LADDER')).toBe(true);
        await stopInterview(ctx, bookId, on.session.id);
        await setBookInterviewDefaults(ctx, bookId, { generatorsOff: ['LADDER'] });
        const off = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 3, detail: 3 }, deps);
        expect(off.session.generatorsOff).toEqual(['LADDER']);
        expect(off.round!.questions.some((q) => q.generator === 'LADDER')).toBe(false);
        await stopInterview(ctx, bookId, off.session.id);
        // The request wins over the book's default; all five off is refused.
        const back = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 3, detail: 3, generatorsOff: [] }, deps);
        expect(back.session.generatorsOff).toEqual([]);
        expect(await refusal(startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, generatorsOff: ['FRONTIER', ...FRONTIER_ONLY] }, deps))).toMatchObject({ status: 400 });
    }, 60_000);

    it('a code-worded question is never asked differently (409 QUESTION_NOT_REPHRASABLE), and nothing is sent', async () => {
        const { ctx, bookId } = await fresh('As It Stands');
        const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt', fields: [{ key: 'role', value: 'The lock-keeper’s daughter.' }] })).id;
        const generator = fakeGenerator();
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 3, detail: 3 }, { generator, embedder });
        const ladder = view.round!.questions.find((q) => q.origin === 'GENERATOR')!;
        const calls = generator.calls.length;
        expect(await refusal(rephraseQuestion(ctx, bookId, view.session.id, ladder.id, { generator, embedder }))).toEqual({ status: 409, reason: 'QUESTION_NOT_REPHRASABLE' });
        expect(generator.calls.length).toBe(calls);
    });
});

describe('source questions (D30, item 2)', () => {
    it('yes confirms the pending fact as the Facts page would, naming the answer; no rejects it; neither fills a field through reconcile', async () => {
        const { ctx, bookId } = await fresh('The Salt Road');
        const mara = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara' })).id;
        await ingestText(ctx, { kind: 'book', bookId }, 'Mara wants the salt road reopened before winter. Mara never learned to swim in the bay.', 'draft.txt');
        const pending = (await listBookFacts(ctx, bookId)).facts;
        const want = pending.find((f) => f.predicate === 'WANT')!;
        const swim = pending.find((f) => f.predicate !== 'WANT')!;
        expect([want.status, swim.status]).toEqual(['PENDING', 'PENDING']);

        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: mara, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder });
        const sources = view.round!.questions.filter((q) => q.generator === 'SOURCES');
        expect(sources.map((q) => q.storyFactId).sort()).toEqual([want.id, swim.id].sort());
        const wantQ = sources.find((q) => q.storyFactId === want.id)!;
        const swimQ = sources.find((q) => q.storyFactId === swim.id)!;
        expect(wantQ).toMatchObject({ kind: 'EITHER_OR', origin: 'GENERATOR', options: [SOURCE_YES, SOURCE_NO], targetsFieldKeys: ['want'] });
        expect(wantQ.text).toBe('Your source “draft.txt” says “Mara wants the salt road reopened before winter.”. Is that canon?');
        // A fact whose predicate answers no field decides only the fact: no target.
        expect(swimQ.targetsFieldKeys).toEqual([]);
        // The frontier does not ask the field the pending fact would answer, in the same round.
        expect(view.round!.questions.some((q) => q.generator === 'FRONTIER' && q.targetsFieldKeys.includes('want'))).toBe(false);

        const yes = await answerQuestion(ctx, bookId, view.session.id, wantQ.id, { choice: SOURCE_YES });
        await answerQuestion(ctx, bookId, view.session.id, swimQ.id, { choice: SOURCE_NO });
        // One frontier answer too, so the round has something for reconcile to read.
        const other = view.round!.questions.find((q) => q.generator === 'FRONTIER')!;
        await answerQuestion(ctx, bookId, view.session.id, other.id, bodyFor(other, 0));
        // Until the round closes nothing is decided (the author may still change the answer).
        expect((await listBookFacts(ctx, bookId, { status: 'ALL' })).facts.find((f) => f.id === want.id)!.status).toBe('PENDING');
        let reconciled = 0;
        const reconciler = scripted((facts) => {
            reconciled++;
            // The reconcile request never carries a source question's answer.
            expect(facts.answers.some((a) => a.answer === SOURCE_YES || a.answer === SOURCE_NO)).toBe(false);
            return { operations: [], newElements: [], newRelations: [] };
        });
        await closeRoundAndReconcile(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true }, { reconciler });
        expect(reconciled).toBe(1);

        const rows = await prisma.storyFact.findMany({ where: { id: { in: [want.id, swim.id] } }, select: { id: true, status: true, decidedByAnswerId: true, decidedById: true }, take: 2 });
        const byId = new Map(rows.map((r) => [r.id, r] as const));
        const yesAnswer = await prisma.answer.findFirstOrThrow({ where: { questionId: wantQ.id }, orderBy: { revision: 'desc' }, select: { id: true } });
        expect(byId.get(want.id)).toMatchObject({ status: 'CONFIRMED', decidedByAnswerId: yesAnswer.id, decidedById: ctx.userId });
        expect(byId.get(swim.id)).toMatchObject({ status: 'REJECTED' });
        expect(yes.answer?.choice).toBe(SOURCE_YES);
        const audit = await prisma.auditLog.findFirst({ where: { action: 'STORY_FACT_DECIDED', entityId: want.id }, select: { detailsJson: true } });
        expect(audit?.detailsJson).toMatchObject({ status: 'CONFIRMED', fromAnswerId: yesAnswer.id });

        // A decision on the Facts page afterwards is the author's own: the answer's mark is cleared.
        await decideFact(ctx, want.id, 'REJECT');
        expect(await prisma.storyFact.findUniqueOrThrow({ where: { id: want.id }, select: { decidedByAnswerId: true } })).toEqual({ decidedByAnswerId: null });
    }, 60_000);

    it('never overrides a decision the author made on the Facts page while the round was open', async () => {
        const { ctx, bookId } = await fresh('Second Thoughts');
        const mara = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara' })).id;
        await ingestText(ctx, { kind: 'book', bookId }, 'Mara wants the salt road reopened before winter.', 'draft.txt');
        const fact = (await listBookFacts(ctx, bookId)).facts.find((f) => f.predicate === 'WANT')!;
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: mara, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder });
        const q = view.round!.questions.find((x) => x.storyFactId === fact.id)!;
        await answerQuestion(ctx, bookId, view.session.id, q.id, { choice: SOURCE_YES });
        await decideFact(ctx, fact.id, 'REJECT');
        await closeRound(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true });
        expect(await prisma.storyFact.findUniqueOrThrow({ where: { id: fact.id }, select: { status: true, decidedByAnswerId: true } })).toEqual({ status: 'REJECTED', decidedByAnswerId: null });
        const closed = await prisma.auditLog.findFirst({ where: { action: 'INTERVIEW_ROUND_CLOSED', entityId: view.round!.id }, select: { detailsJson: true } });
        expect(closed?.detailsJson).toMatchObject({ factsConfirmed: 0, factsNotDecided: 1 });
    }, 60_000);
});

describe('source questions under a race', () => {
    it('the write itself is conditional: a decision made on the Facts page after the close read the fact is still not overridden', async () => {
        const { ctx, bookId } = await fresh('A Late Decision');
        const mara = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara' })).id;
        await ingestText(ctx, { kind: 'book', bookId }, 'Mara wants the salt road reopened before winter.', 'draft.txt');
        const fact = (await listBookFacts(ctx, bookId)).facts.find((f) => f.predicate === 'WANT')!;
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: mara, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder });
        const q = view.round!.questions.find((x) => x.storyFactId === fact.id)!;
        await answerQuestion(ctx, bookId, view.session.id, q.id, { choice: SOURCE_YES });
        // The close reads the fact as it stood before the author's decision (the read raced the Facts page).
        const stale = await prisma.storyFact.findMany({ where: { id: fact.id }, take: 1 });
        await decideFact(ctx, fact.id, 'REJECT');
        const spy = jest.spyOn(StoryFactRepository, 'listByIds').mockResolvedValueOnce(stale as never);
        try {
            await closeRound(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true });
        } finally {
            spy.mockRestore();
        }
        expect(await prisma.storyFact.findUniqueOrThrow({ where: { id: fact.id }, select: { status: true, decidedByAnswerId: true } })).toEqual({ status: 'REJECTED', decidedByAnswerId: null });
    }, 60_000);
});

describe('relations (D30, item 3)', () => {
    it('asks about a pair with no relation yet, and its answer may become a NEW_RELATION the author decides', async () => {
        const { ctx, bookId } = await fresh('The Harbour');
        const wren = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt' })).id;
        const harbour = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Harbourmaster Quill' })).id;
        const view = await startInterview(ctx, bookId, { scope: 'KIND', kind: 'CHARACTER', depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder });
        const wants = view.round!.questions.find((q) => q.generator === 'RELATIONS' && q.angle === 'WANTS')!;
        expect(wants.text).toBe('What does Wren Holt want from Harbourmaster Quill?');
        expect(wants).toMatchObject({ elementId: wren, origin: 'GENERATOR', targetsFieldKeys: ['nature'] });
        const words = 'Wren Holt wants the Harbourmaster Quill to keep the lock open past the tide.';
        await answerQuestion(ctx, bookId, view.session.id, wants.id, { text: words });
        const reconciler = scripted((facts) => {
            const answer = facts.answers.find((a) => a.answer === words)!;
            return { operations: [], newElements: [], newRelations: [{ fromElementId: wren, toElementId: harbour, type: 'related_to', note: words, fields: [], cites: [answer.answerId] }] };
        });
        const closed = await closeRoundAndReconcile(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true }, { reconciler });
        expect(closed.reconcile!.proposed.NEW_RELATION).toBe(1);
        const review = await getSessionReview(ctx, bookId, view.session.id);
        expect(review.newRelations).toHaveLength(1);
        // Nothing was written to the bible: the author decides.
        expect(await prisma.bibleRelation.count({ where: { bookId } })).toBe(0);
    }, 60_000);
});

describe('the tie-break (D30, item 4)', () => {
    async function twoEqualCharacters() {
        const { ctx, bookId } = await fresh('Two Equals');
        const a = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ada Rook' })).id;
        const b = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Bram Rook' })).id;
        return { ctx, bookId, a, b };
    }

    it('reorders only near-equal candidates, by one call charged to the session, and records that the model ordered them', async () => {
        const { ctx, bookId, a, b } = await twoEqualCharacters();
        const restore = setFakeApiKey();
        try {
            const api = fakeAnthropic([{ kind: 'text', text: JSON.stringify({ order: [2, 1] }), usage: { input_tokens: 300, output_tokens: 10 } }]);
            const view = await startInterview(ctx, bookId, { scope: 'KIND', kind: 'CHARACTER', depth: 2, detail: 3, generatorsOff: [...FRONTIER_ONLY] }, { generator: fakeGenerator(), embedder, orderer: (c) => defaultQuestionOrderer(c, { fetch: api.fetch }) });
            expect(api.requests).toHaveLength(1);
            // The two roles scored alike; the model put Bram's first. Nothing else moved.
            const roles = view.round!.questions.filter((q) => q.targetsFieldKeys[0] === 'role');
            expect(roles.map((q) => q.elementId)).toEqual([b, a]);
            const round = await prisma.interviewRound.findFirstOrThrow({ where: { sessionId: view.session.id }, select: { metrics: true } });
            expect((round.metrics as { order?: unknown }).order).toMatchObject({ status: 'MODEL', groupSize: 2 });
            const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: view.session.id }, select: { tokensUsed: true } });
            expect(session.tokensUsed).toBeGreaterThan(0);
        } finally {
            restore();
        }
    });

    it('keeps the code’s order, recorded with its reason, when the answer is not a permutation or no record mounts (D11)', async () => {
        const { ctx, bookId, a, b } = await twoEqualCharacters();
        const restore = setFakeApiKey();
        try {
            const bad = fakeAnthropic([{ kind: 'text', text: JSON.stringify({ order: [1, 1] }), usage: { input_tokens: 300, output_tokens: 10 } }]);
            const refused = await startInterview(ctx, bookId, { scope: 'KIND', kind: 'CHARACTER', depth: 2, detail: 3, generatorsOff: [...FRONTIER_ONLY] }, { generator: fakeGenerator(), embedder, orderer: (c) => defaultQuestionOrderer(c, { fetch: bad.fetch }) });
            expect(refused.round!.questions.filter((q) => q.targetsFieldKeys[0] === 'role').map((q) => q.elementId)).toEqual([a, b]);
            const r1 = await prisma.interviewRound.findFirstOrThrow({ where: { sessionId: refused.session.id }, select: { metrics: true } });
            expect((r1.metrics as { order?: unknown }).order).toMatchObject({ status: 'CODE', reason: 'REFUSED', errorCode: 'NOT_A_PERMUTATION' });
            await stopInterview(ctx, bookId, refused.session.id);

            // Production accepts only a real model's record: with the structural one committed, nothing is sent.
            const gate = jest.spyOn(orderGate, 'questionOrderGate').mockImplementation((_mode, record) => orderGate.questionOrderGateVerdict(record ?? committedOrderRecord, 'model'));
            try {
                const unsent = fakeAnthropic([]);
                const notEvaluated = await startInterview(
                    ctx,
                    bookId,
                    { scope: 'KIND', kind: 'CHARACTER', depth: 2, detail: 3, generatorsOff: [...FRONTIER_ONLY] },
                    { generator: fakeGenerator(), embedder, orderer: (c) => defaultQuestionOrderer(c, { fetch: unsent.fetch }) },
                );
                expect(unsent.requests).toHaveLength(0);
                expect(notEvaluated.round!.questions.filter((q) => q.targetsFieldKeys[0] === 'role').map((q) => q.elementId)).toEqual([a, b]);
                const r2 = await prisma.interviewRound.findFirstOrThrow({ where: { sessionId: notEvaluated.session.id }, select: { metrics: true } });
                expect((r2.metrics as { order?: unknown }).order).toMatchObject({ status: 'CODE', reason: 'NOT_EVALUATED' });
            } finally {
                gate.mockRestore();
            }
        } finally {
            restore();
        }
    });
});

describe('the database holds the new rules for any writer', () => {
    it('refuses a ROUNDS session with no rounds, a generator list naming all five, an angle on a frontier question, a fact on a non-source question', async () => {
        const { ctx, bookId } = await fresh('Raw Writes');
        const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt' })).id;
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder });
        const sessionId = view.session.id;
        const q = view.round!.questions.find((x) => x.generator === 'FRONTIER')!;
        await expect(prisma.$executeRawUnsafe(`UPDATE "InterviewSession" SET "roundBudget" = NULL WHERE "id" = $1`, sessionId)).rejects.toThrow(/InterviewSession_budgets_bounded/);
        await expect(prisma.$executeRawUnsafe(`UPDATE "InterviewSession" SET "generatorsOff" = ARRAY['FRONTIER','LADDER','RELATIONS','SOURCES','CONTINUITY'] WHERE "id" = $1`, sessionId)).rejects.toThrow(/InterviewSession_generators_off_known/);
        await expect(prisma.$executeRawUnsafe(`UPDATE "InterviewSession" SET "roundBudget" = 31 WHERE "id" = $1`, sessionId)).rejects.toThrow(/InterviewSession_budgets_bounded/);
        await expect(prisma.$executeRawUnsafe(`UPDATE "Question" SET "angle" = 'WHY' WHERE "id" = $1`, q.id)).rejects.toThrow(/Question_angle_known/);
        await expect(prisma.$executeRawUnsafe(`UPDATE "Question" SET "targetsFieldKeys" = ARRAY[]::text[] WHERE "id" = $1`, q.id)).rejects.toThrow(/Question_targets_one_or_two/);
        await expect(prisma.$executeRawUnsafe(`UPDATE "Question" SET "continuityRef" = 'proposal:x' WHERE "id" = $1`, q.id)).rejects.toThrow(/Question_continuity_ref_shape/);
    });
});
