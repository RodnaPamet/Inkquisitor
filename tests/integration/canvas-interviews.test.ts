/**
 * Interviews from the canvas against a real PostgreSQL (Phase 3.3, D24).
 *
 *   SELECTION ("Grill this")   the frontier holds the selected elements, the
 *                              relations selected and every relation between
 *                              two selected elements — and nothing else; an
 *                              empty selection is SCOPE_EMPTY, another book's
 *                              element a 404
 *   an edge alone              a session about one relation: its questions are
 *                              about the relation's fields, filed under its
 *                              declaring end with the relation named; a field
 *                              the relation already holds is not asked (rule 5)
 *   BETWEEN                    two neighbouring beats; the stub reconciler
 *                              proposes the beat between them and two causal
 *                              links; a link waits for its new end
 *                              (END_NOT_CREATED), the beat accepted is placed
 *                              between the two in story order, then the links
 *                              are created with a version naming their answers
 *   RELATION_FIELD             accepting writes the relation's next version
 *                              under its lock (VERSION_CONFLICT otherwise)
 *   cross-book                 a slot or selection naming another book's
 *                              element is refused before anything is written
 *   the bundle                 relation fields export and import back
 *   search                     a relation's field is found from both ends
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { addRelation, getRelation, saveRelationFields } from '@/app-layer/usecases/bible-relations';
import { moveElementInOrder } from '@/app-layer/usecases/bible-order';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { startInterview } from '@/app-layer/usecases/interviews';
import { closeRoundAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';
import { acceptProposal, getSessionReview, listPendingStructure } from '@/app-layer/usecases/enrichment-review';
import { searchBook } from '@/app-layer/usecases/book-search';
import { exportBibleBundle } from '@/app-layer/usecases/bible-export';
import { importBibleBundle, type ImportDeps } from '@/app-layer/usecases/bible-import';
import type { ScanResult } from '@/lib/storage/av-scan';
import { compareRanks } from '@/lib/bible/story-order';
import { PENDING_SUBJECT_ID } from '@/lib/interview/subjects';
import { AppError } from '@/lib/errors/types';
import { ZodError } from 'zod';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { scripted, stubReconciler } from '../helpers/enrichment';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

async function refusal(p: Promise<unknown>): Promise<{ status: number; details: Record<string, unknown> }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, details: (err.details ?? {}) as Record<string, unknown> };
        if (err instanceof ZodError) return { status: 400, details: {} };
        throw err;
    }
    throw new Error('expected a refusal');
}

const clean: ImportDeps = { scan: async (): Promise<ScanResult> => ({ status: 'CLEAN', engine: 'test', durationMs: 0 }) };

const deps = { generator: fakeGenerator(), embedder: stubQuestionEmbedder };

async function book() {
    const owner = await createAccount();
    const ctx = workspaceCtx(owner);
    const bookId = (await createBook(ctx, { title: 'The Salt Ledger' })).id;
    return { owner, ctx, bookId };
}

/** Answer every question of a round in words, close it, reconcile it with `reconciler`. */
async function answerAndClose(ctx: WorkspaceRequestContext, bookId: string, view: Awaited<ReturnType<typeof startInterview>>, reconciler = stubReconciler(), words = (i: number) => `Answer ${i}: the tide turned when the lamp went out.`) {
    const sessionId = view.session.id;
    let i = 0;
    for (const q of view.round!.questions) {
        const body = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: words(i++) };
        await answerQuestion(ctx, bookId, sessionId, q.id, body);
    }
    return closeRoundAndReconcile(ctx, bookId, sessionId, String(view.round!.number), { skipUnanswered: true }, { reconciler });
}

describe('SELECTION: "Grill this"', () => {
    it('asks only about the selected elements and the relations between them', async () => {
        const { ctx, bookId } = await book();
        const mara = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara Vell' });
        const tam = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Tam Vell' });
        const outsider = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Iver Holt' });
        const between = await addRelation(ctx, bookId, { fromElementId: mara.id, toElementId: tam.id, type: 'sibling_of' });
        const away = await addRelation(ctx, bookId, { fromElementId: mara.id, toElementId: outsider.id, type: 'opposes' });

        const view = await startInterview(ctx, bookId, { scope: 'SELECTION', elementIds: [mara.id, tam.id], relationIds: [], depth: 2, detail: 3 }, deps);
        const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: view.session.id } });
        expect(session.scope).toBe('SELECTION');
        expect([...session.scopeElementIds].sort()).toEqual([mara.id, tam.id].sort());
        // The relation between the two selected was added; the one to an unselected element was not.
        expect(session.scopeRelationIds).toEqual([between.id]);

        const subjects = new Set(view.round!.questions.map((q) => q.subjectId));
        expect(subjects.has(mara.id)).toBe(true);
        expect(subjects.has(tam.id)).toBe(true);
        expect(subjects.has(between.id)).toBe(true);
        expect(subjects.has(outsider.id)).toBe(false);
        expect(subjects.has(away.id)).toBe(false);
        // A relation's questions are filed under its declaring end, naming the relation.
        for (const q of view.round!.questions.filter((x) => x.relationId !== null)) {
            expect(q.relationId).toBe(between.id);
            expect(q.elementId).toBe(mara.id);
            expect(['history', 'wants', 'unspoken', 'change']).toContain(q.targetsFieldKeys[0]);
        }
    });

    it('refuses an empty selection and another book’s element, writing nothing', async () => {
        const { ctx, bookId } = await book();
        const otherBook = (await createBook(ctx, { title: 'Another' })).id;
        const foreign = await createElement(ctx, otherBook, { kind: 'CHARACTER', name: 'Elsewhere' });
        const before = await prisma.interviewSession.count({ where: { bookId } });
        expect((await refusal(startInterview(ctx, bookId, { scope: 'SELECTION', elementIds: [], relationIds: [], depth: 2, detail: 3 }, deps))).status).toBe(400);
        const cross = await refusal(startInterview(ctx, bookId, { scope: 'SELECTION', elementIds: [foreign.id], relationIds: [], depth: 2, detail: 3 }, deps));
        expect(cross.status).toBe(404);
        expect(await prisma.interviewSession.count({ where: { bookId } })).toBe(before);
    });
});

describe('an edge alone: "Question this relation"', () => {
    it('asks about the relation’s fields, never one it already holds, and its answer becomes a RELATION_FIELD change', async () => {
        const { ctx, bookId } = await book();
        const mara = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara Vell' });
        const guild = await createElement(ctx, bookId, { kind: 'FACTION', name: 'The Salt Guild' });
        const rel = await addRelation(ctx, bookId, { fromElementId: mara.id, toElementId: guild.id, type: 'member_of' });
        const v1 = await getRelation(ctx, bookId, rel.id);
        expect(v1.versionNumber).toBe(1);
        await saveRelationFields(ctx, bookId, rel.id, { baseVersion: 1, fields: [{ key: 'basis', value: 'She was born into it.' }] });

        const view = await startInterview(ctx, bookId, { scope: 'SELECTION', elementIds: [], relationIds: [rel.id], depth: 2, detail: 3 }, deps);
        const asked = view.round!.questions.flatMap((q) => q.targetsFieldKeys);
        expect(view.round!.questions.every((q) => q.relationId === rel.id && q.subjectId === rel.id && q.elementId === mara.id)).toBe(true);
        expect(asked).not.toContain('basis'); // the relation already answers it (rule 5)
        expect(asked.length).toBeGreaterThan(0);

        const closed = await answerAndClose(ctx, bookId, view, stubReconciler(), () => 'She owes the guild three crossings a season.');
        expect(closed.reconcile).toMatchObject({ status: 'DONE', outcome: 'OK' });
        const review = await getSessionReview(ctx, bookId, view.session.id);
        expect(review.relationFields.length).toBeGreaterThan(0);
        const p = review.relationFields[0];
        expect(p.relation.from.id).toBe(mara.id);

        // A stale base version is a conflict; the current one writes the relation's next version, naming the answers.
        expect((await refusal(acceptProposal(ctx, bookId, view.session.id, p.id, { baseVersion: 1 }))).details.reason).toBe('VERSION_CONFLICT');
        const decision = await acceptProposal(ctx, bookId, view.session.id, p.id, { baseVersion: p.currentVersion });
        expect(decision.relationId).toBe(rel.id);
        const versions = await prisma.bibleRelationVersion.findMany({ where: { relationId: rel.id }, orderBy: { versionNumber: 'asc' } });
        expect(versions.map((v) => v.source)).toEqual(['MANUAL', 'MANUAL', 'INTERVIEW']);
        expect(versions[2].sourceAnswerIds.length).toBeGreaterThan(0);
        const after = await getRelation(ctx, bookId, rel.id);
        expect(after.fields.find((f) => f.field.key === p.fieldKey)?.value).toBe('She owes the guild three crossings a season.');

        // Word search finds the relation's field, from both of its ends.
        const found = await searchBook(ctx, bookId, { q: 'crossings season' });
        const names = found.hits.map((h) => h.name).sort();
        expect(names).toEqual(['Mara Vell', 'The Salt Guild']);
        expect(found.hits[0].matches[0]).toMatchObject({ source: 'relationField' });
    });
});

describe('BETWEEN: "What happens between these?"', () => {
    async function twoBeats() {
        const b = await book();
        const first = await createElement(b.ctx, b.bookId, { kind: 'PLOT_BEAT', name: 'The ferry sinks', fields: [{ key: 'act', value: 'opening' }] });
        const second = await createElement(b.ctx, b.bookId, { kind: 'PLOT_BEAT', name: 'The trial at Saltmere', fields: [{ key: 'act', value: 'opening' }] });
        await moveElementInOrder(b.ctx, b.bookId, first.id, { baseVersion: 1, after: null, before: null });
        await moveElementInOrder(b.ctx, b.bookId, second.id, { baseVersion: 1, after: first.id, before: null });
        return { ...b, first, second };
    }

    it('proposes the beat between and its causal links; the links wait for it; accepted, it sits between the two', async () => {
        const { ctx, bookId, first, second } = await twoBeats();
        const view = await startInterview(ctx, bookId, { scope: 'BETWEEN', afterElementId: first.id, beforeElementId: second.id, depth: 2, detail: 3 }, deps);
        expect(view.round!.questions.length).toBeGreaterThan(0);
        expect(view.round!.questions.every((q) => q.subjectId === PENDING_SUBJECT_ID && q.elementId === first.id)).toBe(true);
        // The act is the slot's: never asked.
        expect(view.round!.questions.flatMap((q) => q.targetsFieldKeys)).not.toContain('act');

        const closed = await answerAndClose(ctx, bookId, view);
        expect(closed.reconcile).toMatchObject({ status: 'DONE', outcome: 'OK' });
        const pending = await listPendingStructure(ctx, bookId);
        const beat = pending.proposals.find((p) => p.kind === 'NEW_ELEMENT');
        const links = pending.proposals.filter((p) => p.kind === 'NEW_RELATION');
        expect(beat).toMatchObject({ kind: 'NEW_ELEMENT', newKind: 'PLOT_BEAT', slot: { afterElementId: first.id, beforeElementId: second.id, act: 'opening' } });
        expect(links).toHaveLength(2);
        // Nothing is created before acceptance.
        expect(await prisma.bibleElement.count({ where: { bookId } })).toBe(2);

        // A link to the beat not yet created waits for it.
        expect((await refusal(acceptProposal(ctx, bookId, view.session.id, links[0].id, {}))).details.reason).toBe('END_NOT_CREATED');

        const made = await acceptProposal(ctx, bookId, view.session.id, beat!.id, {});
        expect(made.placed).toBe(true);
        const beats = await prisma.bibleElement.findMany({ where: { bookId, kind: 'PLOT_BEAT' }, select: { id: true, orderRank: true } });
        const ordered = [...beats].sort((a, b) => compareRanks(a.orderRank!, b.orderRank!)).map((b) => b.id);
        expect(ordered).toEqual([first.id, made.elementId, second.id]);
        const actField = await prisma.bibleField.findFirst({ where: { elementId: made.elementId!, key: 'act' } });
        expect(actField).not.toBeNull();
        // Both of its versions — created, then placed — name the answers they came from (rule 1).
        const madeVersions = await prisma.bibleEntryVersion.findMany({ where: { elementId: made.elementId! }, orderBy: { versionNumber: 'asc' } });
        expect(madeVersions.map((v) => [v.source, v.movedInOrder])).toEqual([
            ['INTERVIEW', false],
            ['INTERVIEW', true],
        ]);
        expect(madeVersions.every((v) => v.sourceAnswerIds.length > 0)).toBe(true);

        for (const link of links) {
            const decided = await acceptProposal(ctx, bookId, view.session.id, link.id, {});
            const v = await prisma.bibleRelationVersion.findFirstOrThrow({ where: { relationId: decided.relationId! } });
            expect(v).toMatchObject({ versionNumber: 1, source: 'INTERVIEW' });
            expect(v.sourceAnswerIds.length).toBeGreaterThan(0);
        }
        const relations = await prisma.bibleRelation.findMany({ where: { bookId }, select: { fromElementId: true, toElementId: true, type: true } });
        expect(relations).toEqual(
            expect.arrayContaining([
                { fromElementId: first.id, toElementId: made.elementId, type: 'causes' },
                { fromElementId: made.elementId, toElementId: second.id, type: 'causes' },
            ]),
        );
        expect((await listPendingStructure(ctx, bookId)).proposals).toHaveLength(0);
    });

    it('refuses a slot that is not one, and another book’s beat', async () => {
        const { ctx, bookId, first, second } = await twoBeats();
        const third = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: 'A beat between', fields: [{ key: 'act', value: 'opening' }] });
        await moveElementInOrder(ctx, bookId, third.id, { baseVersion: 1, after: first.id, before: second.id });
        const start = (a: string, b: string) => startInterview(ctx, bookId, { scope: 'BETWEEN', afterElementId: a, beforeElementId: b, depth: 2, detail: 3 }, deps);
        expect((await refusal(start(first.id, second.id))).details).toMatchObject({ reason: 'SLOT_INVALID', problem: 'NOT_ADJACENT' });
        expect((await refusal(start(second.id, first.id))).details).toMatchObject({ reason: 'SLOT_INVALID', problem: 'NOT_IN_ORDER' });
        const otherBook = (await createBook(ctx, { title: 'Another' })).id;
        const foreign = await createElement(ctx, otherBook, { kind: 'PLOT_BEAT', name: 'Elsewhere' });
        expect((await refusal(start(first.id, foreign.id))).status).toBe(404);
    });
});

describe('NEW_RELATION from a selection', () => {
    it('is refused when the model names an element outside the scope, and accepted when grounded and cited', async () => {
        const { ctx, bookId } = await book();
        const mara = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara Vell' });
        const tam = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Tam Vell' });
        const outsider = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Iver Holt' });
        const view = await startInterview(ctx, bookId, { scope: 'SELECTION', elementIds: [mara.id, tam.id], relationIds: [], depth: 2, detail: 3 }, deps);
        const words = 'Mara Vell taught Tam Vell to read the tides.';
        const reconciler = scripted((facts) => {
            const answer = facts.answers.find((a) => a.status === 'ANSWERED' && typeof a.answer === 'string')!;
            return {
                operations: [],
                newElements: [],
                newRelations: [
                    { fromElementId: mara.id, toElementId: outsider.id, type: 'mentor_of', note: words, fields: [], cites: [answer.answerId] },
                    { fromElementId: mara.id, toElementId: tam.id, type: 'mentor_of', note: words, fields: [], cites: [answer.answerId] },
                ],
            };
        });
        const closed = await answerAndClose(ctx, bookId, view, reconciler, () => words);
        expect(closed.reconcile!.proposed.NEW_RELATION).toBe(1);
        const review = await getSessionReview(ctx, bookId, view.session.id);
        expect(review.newRelations).toHaveLength(1);
        const decided = await acceptProposal(ctx, bookId, view.session.id, review.newRelations[0].id, {});
        const rel = await prisma.bibleRelation.findUniqueOrThrow({ where: { id: decided.relationId! } });
        expect(rel).toMatchObject({ fromElementId: mara.id, toElementId: tam.id, type: 'mentor_of' });
        // Accepting it twice is refused: it is decided.
        expect((await refusal(acceptProposal(ctx, bookId, view.session.id, review.newRelations[0].id, {}))).status).toBe(409);
    });
});

describe('the bundle carries relation fields', () => {
    it('exports them and imports them back into an empty book, byte for byte', async () => {
        const { ctx, bookId } = await book();
        const mara = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara Vell' });
        const guild = await createElement(ctx, bookId, { kind: 'FACTION', name: 'The Salt Guild' });
        const rel = await addRelation(ctx, bookId, { fromElementId: mara.id, toElementId: guild.id, type: 'member_of' });
        await saveRelationFields(ctx, bookId, rel.id, { baseVersion: 1, fields: [{ key: 'terms', value: 'Three crossings a season.' }] });
        const first = await exportBibleBundle(ctx, bookId);
        const empty = (await createBook(ctx, { title: 'Empty' })).id;
        await importBibleBundle(ctx, empty, first.bytes, { bookDetails: 'apply' }, clean);
        const copied = await prisma.bibleRelation.findFirstOrThrow({ where: { bookId: empty } });
        expect((await getRelation(ctx, empty, copied.id)).fields.find((f) => f.field.key === 'terms')?.value).toBe('Three crossings a season.');
        const second = await exportBibleBundle(ctx, empty);
        expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
        // A repeat import changes nothing and writes no relation version.
        const versions = await prisma.bibleRelationVersion.count({ where: { relationId: copied.id } });
        await importBibleBundle(ctx, empty, first.bytes, { bookDetails: 'apply' }, clean);
        expect(await prisma.bibleRelationVersion.count({ where: { relationId: copied.id } })).toBe(versions);
    });
});
