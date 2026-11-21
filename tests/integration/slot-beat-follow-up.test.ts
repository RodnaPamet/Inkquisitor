/**
 * "What happens between these?" GOES ON WITH ITS BEAT (Phase 3.H; decision
 * D25 as the owner amended it, 2026-11-20), against a real database.
 *
 *   later rounds      once a round has proposed the gap's beat, the next asks
 *                     about the beat's own remaining fields: still the beat not
 *                     yet created (`aboutPending`), never a field its proposal
 *                     holds (rule 5), never a challenge of one
 *   field proposals   reconcile proposes them as ADD-only FIELD proposals that
 *                     name the beat's proposal, with no element and no base
 *                     version, and no second beat for the gap
 *   acceptance        before the beat: 409 END_NOT_CREATED; after it: one
 *                     version of the created element naming the answers; a
 *                     rejected beat or a deleted element: 409 END_GONE; never
 *                     in bulk
 *   the end           the session finishes FRONTIER_EMPTY once nothing is left
 *   the database      the CHECK and the trigger hold the new shape
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, deleteElement, getElement } from '@/app-layer/usecases/bible-elements';
import { moveElementInOrder } from '@/app-layer/usecases/bible-order';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { nextRound, startInterview } from '@/app-layer/usecases/interviews';
import { closeRoundAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';
import { acceptProposal, bulkAcceptProposals, getSessionReview, rejectProposal } from '@/app-layer/usecases/enrichment-review';
import { PENDING_SUBJECT_ID } from '@/lib/interview/subjects';
import { AppError } from '@/lib/errors/types';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { stubReconciler } from '../helpers/enrichment';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const deps = { generator: fakeGenerator(), embedder: stubQuestionEmbedder };

async function refusal(p: Promise<unknown>): Promise<{ status: number; details: Record<string, unknown> }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, details: (err.details ?? {}) as Record<string, unknown> };
        throw err;
    }
    throw new Error('expected a refusal');
}

type View = Awaited<ReturnType<typeof startInterview>>;

async function answerAndClose(ctx: WorkspaceRequestContext, bookId: string, view: View, words: string) {
    let i = 0;
    for (const q of view.round!.questions) {
        const body = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: `${words} (${i++})` };
        await answerQuestion(ctx, bookId, view.session.id, q.id, body);
    }
    return closeRoundAndReconcile(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true }, { reconciler: stubReconciler() });
}

/** Two adjacent beats of the opening act, a BETWEEN session on them, round 1 answered and reconciled: the gap's beat is proposed. */
async function beatProposed() {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title: 'The Salt Ledger' })).id;
    const first = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: 'The ferry sinks', fields: [{ key: 'act', value: 'opening' }] });
    const second = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: 'The trial at Saltmere', fields: [{ key: 'act', value: 'opening' }] });
    await moveElementInOrder(ctx, bookId, first.id, { baseVersion: 1, after: null, before: null });
    await moveElementInOrder(ctx, bookId, second.id, { baseVersion: 1, after: first.id, before: null });
    const view = await startInterview(ctx, bookId, { scope: 'BETWEEN', afterElementId: first.id, beforeElementId: second.id, depth: 3, detail: 3 }, deps);
    const round1Keys = view.round!.questions.flatMap((q) => q.targetsFieldKeys);
    await answerAndClose(ctx, bookId, view, 'The harbour master burns the ledger at the quay');
    const beat = await prisma.enrichmentProposal.findFirstOrThrow({ where: { sessionId: view.session.id, kind: 'NEW_ELEMENT', fillsSlot: true } });
    // What the beat's proposal holds, read as the review reads it (decrypted in the workspace's context).
    const held = (await getSessionReview(ctx, bookId, view.session.id)).newElements.find((n) => n.id === beat.id)!.fields.map((f) => f.field.key);
    return { ctx, bookId, first, second, sessionId: view.session.id, beat, held, round1Keys };
}

/** Round 2 of the session, answered and reconciled: the further-field proposals for the beat. */
async function followUp(at: Awaited<ReturnType<typeof beatProposed>>) {
    const round2 = await nextRound(at.ctx, at.bookId, at.sessionId, deps);
    await answerAndClose(at.ctx, at.bookId, round2, 'Smugglers seize the ferry office before dawn');
    const fields = await prisma.enrichmentProposal.findMany({ where: { sessionId: at.sessionId, kind: 'FIELD' }, include: { citations: true } });
    return { round2, fields };
}

describe('later rounds ask about the proposed beat', () => {
    it('round 2 asks the beat’s remaining fields: still the beat not yet created, nothing its proposal holds, no challenge', async () => {
        const at = await beatProposed();
        const held = at.held;
        expect(held.length).toBeGreaterThan(0);
        const round2 = await nextRound(at.ctx, at.bookId, at.sessionId, deps);
        expect(round2.session.status).not.toBe('COMPLETED');
        const questions = round2.round!.questions;
        expect(questions.length).toBeGreaterThan(0);
        expect(questions.every((q) => q.subjectId === PENDING_SUBJECT_ID && q.elementId === at.first.id)).toBe(true);
        const asked = questions.flatMap((q) => q.targetsFieldKeys);
        for (const key of held) expect(asked).not.toContain(key);
        expect(asked).not.toContain('act');
        expect(questions.every((q) => q.mode === 'FRONTIER')).toBe(true);
    });

    it('its answers become ADD field proposals naming the beat’s proposal, with no element, no base version and no second beat', async () => {
        const at = await beatProposed();
        const { round2, fields } = await followUp(at);
        expect(fields.length).toBeGreaterThan(0);
        for (const f of fields) {
            expect(f).toMatchObject({ elementId: null, targetProposalId: at.beat.id, baseVersion: null, operation: 'ADD', status: 'PENDING' });
            expect(round2.round!.questions.flatMap((q) => q.targetsFieldKeys)).toContain(f.fieldKey);
            expect(f.citations.length).toBeGreaterThan(0);
        }
        expect(await prisma.enrichmentProposal.count({ where: { sessionId: at.sessionId, kind: 'NEW_ELEMENT' } })).toBe(1);
        // The neighbours get no link of their own from a later round.
        expect(await prisma.enrichmentProposal.count({ where: { sessionId: at.sessionId, kind: 'NEW_RELATION', newFromProposalId: null, newToProposalId: null } })).toBe(0);
    });
});

describe('accepting a field of the beat', () => {
    it('waits for the beat (END_NOT_CREATED), then writes one version of the element it created, naming its answers', async () => {
        const at = await beatProposed();
        const { fields } = await followUp(at);
        const field = fields[0];

        const early = await refusal(acceptProposal(at.ctx, at.bookId, at.sessionId, field.id, { baseVersion: 0 }));
        expect(early).toMatchObject({ status: 409, details: { reason: 'END_NOT_CREATED', proposalId: at.beat.id } });
        // The review shows it against the beat, waiting.
        const before = (await getSessionReview(at.ctx, at.bookId, at.sessionId)).fields.find((f) => f.id === field.id)!;
        expect(before).toMatchObject({ elementId: null, slotBeat: { proposalId: at.beat.id, state: 'PENDING' }, bulkEligible: false });
        // Never in bulk, even once the beat exists.
        expect((await refusal(bulkAcceptProposals(at.ctx, at.bookId, at.sessionId, { items: [{ proposalId: field.id, baseVersion: 1 }] }))).details.reason).toBe('BULK_INELIGIBLE');

        const made = await acceptProposal(at.ctx, at.bookId, at.sessionId, at.beat.id, {});
        const elementId = made.elementId!;
        const view = (await getSessionReview(at.ctx, at.bookId, at.sessionId)).fields.find((f) => f.id === field.id)!;
        expect(view).toMatchObject({ elementId, slotBeat: { state: 'CREATED' }, currentValue: null });
        const base = (await getElement(at.ctx, at.bookId, elementId)).versionNumber;
        expect(view.currentVersion).toBe(base);
        expect((await refusal(bulkAcceptProposals(at.ctx, at.bookId, at.sessionId, { items: [{ proposalId: field.id, baseVersion: base }] }))).details.reason).toBe('BULK_INELIGIBLE');

        const decided = await acceptProposal(at.ctx, at.bookId, at.sessionId, field.id, { baseVersion: base });
        expect(decided).toMatchObject({ status: 'ACCEPTED', elementId, versionNumber: base + 1 });
        const stored = await prisma.bibleField.findFirst({ where: { elementId, key: field.fieldKey! } });
        expect(stored).not.toBeNull();
        const version = await prisma.bibleEntryVersion.findFirstOrThrow({ where: { elementId, versionNumber: base + 1 } });
        expect(version.source).toBe('INTERVIEW');
        expect([...version.sourceAnswerIds].sort()).toEqual(field.citations.map((c) => c.answerId).sort());
        const row = await prisma.enrichmentProposal.findUniqueOrThrow({ where: { id: field.id } });
        expect(row.versionId).toBe(version.id);
    });

    it('a rejected beat: its fields are refused END_GONE, and the review says so', async () => {
        const at = await beatProposed();
        const { fields } = await followUp(at);
        await rejectProposal(at.ctx, at.bookId, at.sessionId, at.beat.id);
        expect((await refusal(acceptProposal(at.ctx, at.bookId, at.sessionId, fields[0].id, { baseVersion: 0 }))).details.reason).toBe('END_GONE');
        expect((await getSessionReview(at.ctx, at.bookId, at.sessionId)).fields.find((f) => f.id === fields[0].id)).toMatchObject({ slotBeat: { state: 'GONE' } });
        // It can still be rejected.
        expect((await rejectProposal(at.ctx, at.bookId, at.sessionId, fields[0].id)).status).toBe('REJECTED');
    });

    it('an accepted beat whose element is deleted: its fields are refused END_GONE', async () => {
        const at = await beatProposed();
        const { fields } = await followUp(at);
        const made = await acceptProposal(at.ctx, at.bookId, at.sessionId, at.beat.id, {});
        await deleteElement(at.ctx, at.bookId, made.elementId!);
        expect((await refusal(acceptProposal(at.ctx, at.bookId, at.sessionId, fields[0].id, { baseVersion: 1 }))).details.reason).toBe('END_GONE');
    });

    it('an element deleted while the acceptance waits for its lock is END_GONE too, never a 404', async () => {
        const at = await beatProposed();
        const { fields } = await followUp(at);
        const made = await acceptProposal(at.ctx, at.bookId, at.sessionId, at.beat.id, {});
        let accepting: Promise<unknown> | null = null;
        // A deletion holding the element's lock (as `deleteElement` does) while the acceptance has already read the beat.
        await prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bible-element:' + made.elementId}))`;
                accepting = acceptProposal(at.ctx, at.bookId, at.sessionId, fields[0].id, { baseVersion: 1 });
                accepting.catch(() => undefined);
                for (let i = 0; i < 400; i++) {
                    const [row] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
                    if (Number(row.n) > 0) break;
                    await new Promise((r) => setTimeout(r, 25));
                }
                await tx.$executeRaw`DELETE FROM "BibleElement" WHERE "id" = ${made.elementId}`;
            },
            { timeout: 20_000 },
        );
        const refused = await refusal(accepting!);
        expect(refused).toMatchObject({ status: 409, details: { reason: 'END_GONE' } });
    });
});

describe('the session runs to its end', () => {
    it('round after round about the beat, it finishes FRONTIER_EMPTY; a field the accepted beat holds is not asked', async () => {
        const at = await beatProposed();
        // Accept the beat mid-session, and fill one more of its fields on the element itself.
        const made = await acceptProposal(at.ctx, at.bookId, at.sessionId, at.beat.id, {});
        const element = await getElement(at.ctx, at.bookId, made.elementId!);
        const held = new Set([...at.held, 'act']);
        const free = (await prisma.bibleField.findMany({ where: { elementId: element.id }, select: { key: true } })).map((f) => f.key);
        for (const k of free) held.add(k);
        let view = await nextRound(at.ctx, at.bookId, at.sessionId, deps);
        const asked: string[] = [];
        for (let i = 0; i < 12 && view.session.status !== 'COMPLETED'; i++) {
            const keys = view.round!.questions.flatMap((q) => q.targetsFieldKeys);
            for (const k of keys) expect(held.has(k)).toBe(false);
            expect(view.round!.questions.every((q) => q.subjectId === PENDING_SUBJECT_ID)).toBe(true);
            asked.push(...keys);
            const closed = await answerAndClose(at.ctx, at.bookId, view, 'The lamp at the quay goes dark');
            if (closed.interview.session.status === 'COMPLETED') {
                view = closed.interview;
                break;
            }
            view = await nextRound(at.ctx, at.bookId, at.sessionId, deps);
        }
        expect(asked.length).toBeGreaterThan(0);
        expect(view.session).toMatchObject({ status: 'COMPLETED', stopReason: 'FRONTIER_EMPTY' });
    });
});

describe('the database holds the shape', () => {
    it('a FIELD proposal names an element or a slot’s beat, never both; a beat field is ADD only and has no base; the target is its session’s beat', async () => {
        const at = await beatProposed();
        const { fields } = await followUp(at);
        const f = fields[0];
        const insert = (patch: Record<string, unknown>) =>
            prisma.enrichmentProposal.create({
                data: {
                    workspaceId: f.workspaceId,
                    bookId: f.bookId,
                    sessionId: f.sessionId,
                    roundId: f.roundId,
                    kind: 'FIELD',
                    fieldKey: f.fieldKey,
                    operation: 'ADD',
                    proposedValue: '"The lamp at the quay goes dark."',
                    targetProposalId: at.beat.id,
                    ...patch,
                },
            });
        await expect(insert({ operation: 'UPDATE' })).rejects.toThrow(/EnrichmentProposal_kind_shape/);
        await expect(insert({ baseVersion: 1 })).rejects.toThrow(/EnrichmentProposal_kind_shape/);
        await expect(insert({ elementId: at.first.id, baseVersion: 1 })).rejects.toThrow(/EnrichmentProposal_kind_shape/);
        // Another kind of proposal of the session (a link) is not a beat.
        const link = await prisma.enrichmentProposal.findFirst({ where: { sessionId: at.sessionId, kind: 'NEW_RELATION' } });
        expect(link).not.toBeNull();
        await expect(insert({ targetProposalId: link!.id })).rejects.toThrow(/ENRICHMENT_TARGET_NOT_SLOT_BEAT/);
    });
});
