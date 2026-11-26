/**
 * HARDENING CONTINUOUS QUESTIONING (Phase 4.H-a, D31; issue #66), against a
 * real PostgreSQL. The question generator is the deterministic fake; nothing
 * reaches a model or a network.
 *
 *   item 2   a field held by a proposal raised WHILE the round was worded is not asked at persist
 *   item 3   the hard repetition gate holds a BETWEEN slot's beat to the session's earlier questions in the database
 *   item 4   a question's fact and a fact's answer are composite (workspaceId, id) keys
 *   item 5   a pair question answered "decide later" names the pair on the Continuity page
 *   item 6   the ladder's history is read a page at a time, and a cut is named (never silent)
 *   #63      the gap hunt counts a relation between two elements of one kind once
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { addRelation } from '@/app-layer/usecases/bible-relations';
import { moveElementInOrder } from '@/app-layer/usecases/bible-order';
import { answerQuestion, decideLater } from '@/app-layer/usecases/interview-answers';
import { closeRound, nextRound, startInterview } from '@/app-layer/usecases/interviews';
import { closeRoundAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';
import { getContinuityPage } from '@/app-layer/usecases/continuity';
import { loadGeneratorInputs } from '@/app-layer/usecases/interview-generators';
import { frontierOf, loadInterviewState, requireSession } from '@/app-layer/usecases/interview-state';
import { gapSignals } from '@/app-layer/repositories/interrogation.repository';
import { QuestionRepository } from '@/app-layer/repositories/interview.repository';
import { generateCandidates, ladderKey } from '@/lib/interview/generators';
import { PENDING_SUBJECT_ID } from '@/lib/interview/subjects';
import type { QuestionGenerator } from '@/lib/interview/generator';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { FRONTIER_ONLY, stubQuestionEmbedder } from '../helpers/interview';
import { scripted, stubReconciler } from '../helpers/enrichment';
import { ingestText } from '../helpers/sources';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const embedder = stubQuestionEmbedder;
type Ctx = ReturnType<typeof workspaceCtx>;
type View = Awaited<ReturnType<typeof startInterview>>;

async function fresh(title: string) {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title })).id;
    return { ctx, bookId };
}

describe('held fields at persist (#66 item 2)', () => {
    it('a proposal another session raises while this round is worded holds its field: the question is not asked', async () => {
        const { ctx, bookId } = await fresh('Raced');
        const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt' })).id;
        // Session B asks about the want and the author answers it; its round is not closed yet.
        const b = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3, generatorsOff: [...FRONTIER_ONLY] }, { generator: fakeGenerator(), embedder });
        const asked = b.round!.questions.find((q) => q.kind === 'OPEN' && q.targetsFieldKeys.length === 1)!;
        const fieldKey = asked.targetsFieldKeys[0];
        const words = 'Wren wants to keep the weir standing through the flood.';
        await answerQuestion(ctx, bookId, b.session.id, asked.id, { text: words });

        // Session A's round is claimed before B closes; while A's questions are worded, B closes and proposes the want.
        const inner = fakeGenerator({ mutate: (q) => ({ ...q, text: `In a word, ${q.text}` }) });
        let raced = false;
        const racing: QuestionGenerator = {
            unavailableReason: () => null,
            async generateCandidates(request, signal) {
                if (!raced) {
                    raced = true;
                    const reconciler = scripted((facts) => {
                        const a = facts.answers.find((x) => x.answer === words)!;
                        return { operations: [{ elementId, fieldKey, op: 'ADD', value: words, cites: [a.answerId] }], newElements: [], newRelations: [] };
                    });
                    const closed = await closeRoundAndReconcile(ctx, bookId, b.session.id, String(b.round!.number), { skipUnanswered: true }, { reconciler });
                    expect(closed.reconcile!.proposed.ADD).toBe(1);
                }
                return inner.generateCandidates(request, signal);
            },
        };
        const a = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3, generatorsOff: [...FRONTIER_ONLY] }, { generator: racing, embedder });
        expect(raced).toBe(true);
        // Before 4.H-a the holds were read only at the claim, and the field was asked with its change still pending.
        const askedInA = await runWithoutRls({ reason: 'test' }, (db) => db.question.findMany({ where: { sessionId: a.session.id }, select: { targetsFieldKeys: true } }));
        expect(askedInA.some((q) => q.targetsFieldKeys.includes(fieldKey))).toBe(false);
        const round = await runWithoutRls({ reason: 'test' }, (db) => db.interviewRound.findFirstOrThrow({ where: { sessionId: a.session.id, number: 1 }, select: { metrics: true } }));
        expect((round.metrics as { staleAtPersist?: number }).staleAtPersist).toBeGreaterThanOrEqual(1);
    }, 60_000);
});

describe('the hard repetition gate and a BETWEEN slot’s beat (#66 item 3)', () => {
    async function betweenSession() {
        const { ctx, bookId } = await fresh('The Gap');
        const first = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: 'The ferry sinks', fields: [{ key: 'act', value: 'opening' }] });
        const second = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: 'The trial at Saltmere', fields: [{ key: 'act', value: 'opening' }] });
        await moveElementInOrder(ctx, bookId, first.id, { baseVersion: 1, after: null, before: null });
        await moveElementInOrder(ctx, bookId, second.id, { baseVersion: 1, after: first.id, before: null });
        const view = await startInterview(ctx, bookId, { scope: 'BETWEEN', afterElementId: first.id, beforeElementId: second.id, depth: 3, detail: 3 }, { generator: fakeGenerator(), embedder });
        return { ctx, bookId, first, second, view };
    }

    it('the book-wide lookup finds the session’s earlier questions about the beat, and no other session’s', async () => {
        const at = await betweenSession();
        const pending = await runWithoutRls({ reason: 'test' }, (db) => db.question.findFirstOrThrow({ where: { sessionId: at.view.session.id, aboutPending: true }, select: { elementId: true, dedupeKey: true } }));
        const probe = { elementId: pending.elementId, dedupeKey: pending.dedupeKey };
        const found = await runInWorkspaceContext(at.ctx, (db) => QuestionRepository.findExactRepeats(db, at.ctx.workspaceId, at.bookId, [{ ...probe, pendingIn: { sessionId: at.view.session.id } }]));
        expect(found).toEqual([{ elementId: PENDING_SUBJECT_ID, dedupeKey: pending.dedupeKey }]);
        const other = await runInWorkspaceContext(at.ctx, (db) => QuestionRepository.findExactRepeats(db, at.ctx.workspaceId, at.bookId, [{ ...probe, pendingIn: { sessionId: 'another-session' } }]));
        expect(other).toEqual([]);
    }, 60_000);

    it('a round asking about the beat probes the database for it at persist (never the in-memory deduplication alone)', async () => {
        const at = await betweenSession();
        for (const q of at.view.round!.questions) await answerQuestion(at.ctx, at.bookId, at.view.session.id, q.id, q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'Smugglers seize the ferry office before dawn.' });
        await closeRoundAndReconcile(at.ctx, at.bookId, at.view.session.id, String(at.view.round!.number), { skipUnanswered: true }, { reconciler: stubReconciler() });
        const spy = jest.spyOn(QuestionRepository, 'findExactRepeats');
        try {
            const round2 = await nextRound(at.ctx, at.bookId, at.view.session.id, { generator: fakeGenerator(), embedder });
            expect(round2.round!.questions.some((q) => q.subjectId === PENDING_SUBJECT_ID)).toBe(true);
            const probes = spy.mock.calls.flatMap((c) => c[3]);
            expect(probes.some((p) => p.pendingIn?.sessionId === at.view.session.id && p.elementId === at.first.id)).toBe(true);
        } finally {
            spy.mockRestore();
        }
    }, 60_000);
});

describe('composite cross-row keys (#66 item 4)', () => {
    it('a question cannot name another workspace’s fact, nor a fact another workspace’s answer; a deletion clears only the id', async () => {
        const one = await fresh('Mine');
        const two = await fresh('Theirs');
        const elementId = (await createElement(one.ctx, one.bookId, { kind: 'CHARACTER', name: 'Mara' })).id;
        await ingestText(one.ctx, { kind: 'book', bookId: one.bookId }, 'Mara wants the salt road reopened before winter.');
        const fact = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findFirstOrThrow({ where: { workspaceId: one.ctx.workspaceId, status: 'PENDING' }, select: { id: true } }));
        const view = await startInterview(one.ctx, one.bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder });
        const source = view.round!.questions.find((q) => q.generator === 'SOURCES');
        expect(source?.storyFactId).toBe(fact.id);
        // The other workspace's fact and answer, named by id alone: the database refuses both (as the superuser too).
        const theirElement = (await createElement(two.ctx, two.bookId, { kind: 'CHARACTER', name: 'Ida' })).id;
        await ingestText(two.ctx, { kind: 'book', bookId: two.bookId }, 'Ida wants the ferry ledger burned before spring.');
        const theirFact = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findFirstOrThrow({ where: { workspaceId: two.ctx.workspaceId }, select: { id: true } }));
        const theirs = await startInterview(two.ctx, two.bookId, { scope: 'ELEMENT', elementId: theirElement, depth: 2, detail: 3, generatorsOff: [...FRONTIER_ONLY] }, { generator: fakeGenerator(), embedder });
        await answerQuestion(two.ctx, two.bookId, theirs.session.id, theirs.round!.questions[0].id, { text: 'She keeps the ledger.' });
        const theirAnswer = await runWithoutRls({ reason: 'test' }, (db) => db.answer.findFirstOrThrow({ where: { sessionId: theirs.session.id }, select: { id: true } }));
        await expect(runWithoutRls({ reason: 'test' }, (db) => db.$executeRaw`UPDATE "Question" SET "storyFactId" = ${theirFact.id} WHERE id = ${source!.id}`)).rejects.toThrow(/foreign key/i);
        // The decision's own write (the only one that may name an answer): refused by the key, not by a trigger.
        await expect(
            runWithoutRls({ reason: 'test' }, (db) => db.$executeRaw`UPDATE "StoryFact" SET "status" = 'CONFIRMED', "decidedAt" = now(), "decidedByAnswerId" = ${theirAnswer.id} WHERE id = ${fact.id}`),
        ).rejects.toThrow(/foreign key/i);
        // The fact goes (its source removed): the question keeps its workspace, its fact link cleared.
        await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.delete({ where: { id: fact.id } }));
        const after = await runWithoutRls({ reason: 'test' }, (db) => db.question.findUniqueOrThrow({ where: { id: source!.id }, select: { workspaceId: true, storyFactId: true } }));
        expect(after).toEqual({ workspaceId: one.ctx.workspaceId, storyFactId: null });
    }, 60_000);
});

describe('a pair question answered "decide later" (#66 item 5)', () => {
    it('names the pair on the Continuity page, never the first element with its field, and leaves once the pair is related', async () => {
        const { ctx, bookId } = await fresh('Undecided');
        const wren = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt' })).id;
        const quill = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Harbourmaster Quill' })).id;
        const view: View = await startInterview(ctx, bookId, { scope: 'KIND', kind: 'CHARACTER', depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder });
        const pair = view.round!.questions.find((q) => q.generator === 'RELATIONS' && q.angle === 'WANTS')!;
        await decideLater(ctx, bookId, view.session.id, pair.id);
        const later = (await getContinuityPage(ctx, bookId)).decideLater.items.find((d) => d.question === pair.text)!;
        expect(later).toMatchObject({ elementId: wren, pair: { elementId: quill, elementName: 'Harbourmaster Quill' }, fieldKeys: [] });
        await addRelation(ctx, bookId, { fromElementId: wren, toElementId: quill, type: 'related_to' });
        expect((await getContinuityPage(ctx, bookId)).decideLater.items.some((d) => d.question === pair.text)).toBe(false);
    }, 60_000);
});

describe('the ladder’s history read (#66 item 6)', () => {
    it('is paged, so an answered layer past the first page is still held; past its ceiling the cut is named and the ladder asks nothing', async () => {
        const { ctx, bookId } = await fresh('Deep');
        const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt', fields: [{ key: 'role', value: 'The lock-keeper’s daughter.' }] })).id;
        const ladderOnly = { generatorsOff: ['FRONTIER', 'RELATIONS', 'SOURCES', 'CONTINUITY'] as string[] };
        const deps = { generator: fakeGenerator(), embedder };
        let view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 5, detail: 3, ...ladderOnly }, deps);
        for (let round = 0; round < 2; round++) {
            for (const q of view.round!.questions) await answerQuestion(ctx, bookId, view.session.id, q.id, { text: `The deeper answer ${round}: she opens the lock for smugglers.` });
            await closeRound(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true });
            view = await nextRound(ctx, bookId, view.session.id, deps);
        }
        const asked = await runWithoutRls({ reason: 'test' }, (db) => db.question.count({ where: { bookId, generator: 'LADDER' } }));
        expect(asked).toBeGreaterThanOrEqual(3);
        const inputs = async (bounds: { page: number; max: number }) =>
            runInWorkspaceContext(ctx, async (db) => {
                const session = await requireSession(db, ctx, bookId, view.session.id);
                const state = await loadInterviewState(db, ctx, session);
                return loadGeneratorInputs(db, ctx, session, state, frontierOf(state, session.depth), bounds);
            });
        // One question a page: the oldest (the answered WHAT) is on the last page read.
        const paged = await inputs({ page: 1, max: 100 });
        expect(paged.historyCut).toBe(false);
        expect(paged.ladder.answered.has(ladderKey(elementId, 'role', 'WHAT'))).toBe(true);
        expect(paged.ladder.answered.has(ladderKey(elementId, 'role', 'WHY'))).toBe(true);
        // A ceiling below the history: named, and the ladder proposes nothing it cannot prove unanswered (rule 5).
        const cut = await inputs({ page: 1, max: 1 });
        expect(cut.historyCut).toBe(true);
        expect(generateCandidates(cut).filter((c) => c.generator === 'LADDER')).toEqual([]);
        // Why: read silently, the cut history holds neither answered layer, and the ladder would ask one again.
        expect(cut.ladder.answered.has(ladderKey(elementId, 'role', 'WHAT'))).toBe(false);
        expect(generateCandidates({ ...cut, historyCut: false }).some((c) => c.generator === 'LADDER')).toBe(true);
    }, 60_000);
});

describe('the gap hunt’s signals (#63)', () => {
    it('a relation between two elements of one kind counts once for that kind', async () => {
        const { ctx, bookId } = await fresh('Kin');
        const a = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren Holt' })).id;
        const b = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ida Marsh' })).id;
        const place = (await createElement(ctx, bookId, { kind: 'SETTING', name: 'Harrow Weir' })).id;
        await addRelation(ctx, bookId, { fromElementId: a, toElementId: b, type: 'related_to' });
        await addRelation(ctx, bookId, { fromElementId: a, toElementId: place, type: 'related_to' });
        const signals = await runInWorkspaceContext(ctx, (db: Parameters<typeof gapSignals>[0]) => gapSignals(db, ctx.workspaceId, bookId));
        const byKind = new Map(signals.map((s) => [s.kind, s.relations] as const));
        // Two relations touch a character (one between two characters): two, never three.
        expect(byKind.get('CHARACTER')).toBe(2);
        expect(byKind.get('SETTING')).toBe(1);
    });
});

export type { Ctx };
