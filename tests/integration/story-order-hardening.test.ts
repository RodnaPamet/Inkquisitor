/**
 * Phase 3.H: story order, slots and locks, against a real database.
 *
 *   a changed slot     accepting the beat proposed for a gap whose neighbour was
 *                      deleted, moved or that another beat now fills is refused
 *                      409 SLOT_CHANGED, writing nothing; the author then names
 *                      where it goes, or accepts it unplaced (D25, owner: "refuse
 *                      and ask"); the review shows the change and the act's beats
 *   one beat a slot    a later round proposes no second beat for a gap that has
 *                      one, and the session goes on with that beat (#53 item 1;
 *                      D25 as amended: slot-beat-follow-up.test.ts has the flow)
 *   a link's ends      an accepted link names the ends it was created between
 *   one free order     the rank alone is the story order: an act change keeps
 *                      the beat's place unless neighbours are named, and an
 *                      unplaced beat with none goes to the end (D25 as amended)
 *   a rebalance        a spent gap rebalances the order and the move succeeds,
 *                      with one version (the move's) and one audit row (#50 item 7)
 *   lock order         a map save takes the order's lock after the map's, so it
 *                      queues behind an import re-ranking beats instead of
 *                      deadlocking with it (#50 item 2); a relation's removal
 *                      takes the relation's lock (#53 item 4)
 *   long orders        the bundle import sees a taken place however long the
 *                      order (#50 item 3)
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, deleteElement, getElement } from '@/app-layer/usecases/bible-elements';
import { addRelation, removeRelation, saveRelationFields } from '@/app-layer/usecases/bible-relations';
import { moveElementInOrder } from '@/app-layer/usecases/bible-order';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { nextRound, startInterview } from '@/app-layer/usecases/interviews';
import { closeRoundAndReconcile, reconcileRound } from '@/app-layer/usecases/enrichment-reconcile';
import { acceptProposal, getSessionReview, listPendingStructure } from '@/app-layer/usecases/enrichment-review';
import { saveStoryMap } from '@/app-layer/usecases/story-maps';
import { exportBibleBundle } from '@/app-layer/usecases/bible-export';
import { importBibleBundle, type ImportDeps } from '@/app-layer/usecases/bible-import';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { readZip, writeZip } from '@/lib/archive/zip';
import { compareRanks, ORDER_RANK_MAX, rebalancedRanks } from '@/lib/bible/story-order';
import { PENDING_SUBJECT_ID } from '@/lib/interview/subjects';
import { AppError } from '@/lib/errors/types';
import type { ScanResult } from '@/lib/storage/av-scan';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { ZodError } from 'zod';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { failing, stubReconciler } from '../helpers/enrichment';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const deps = { generator: fakeGenerator(), embedder: stubQuestionEmbedder };
const clean: ImportDeps = { scan: async (): Promise<ScanResult> => ({ status: 'CLEAN', engine: 'test', durationMs: 0 }) };

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

/** Resolve when some backend is waiting on an advisory lock. */
async function untilWaitingOnAdvisoryLock() {
    for (let i = 0; i < 400; i++) {
        const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        if (Number(row.n) > 0) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('nothing waited on an advisory lock');
}

async function book(title = 'The Salt Ledger') {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title })).id;
    return { ctx, bookId };
}

const versionOf = async (ctx: WorkspaceRequestContext, bookId: string, id: string) => (await getElement(ctx, bookId, id)).versionNumber;
const rankOf = async (id: string) => (await prisma.bibleElement.findUniqueOrThrow({ where: { id }, select: { orderRank: true } })).orderRank;
async function move(ctx: WorkspaceRequestContext, bookId: string, id: string, after: string | null, before: string | null, act?: string) {
    return moveElementInOrder(ctx, bookId, id, { baseVersion: await versionOf(ctx, bookId, id), after, before, ...(act ? { act } : {}) });
}
async function beat(ctx: WorkspaceRequestContext, bookId: string, name: string, act: string | null = 'opening') {
    return createElement(ctx, bookId, { kind: 'PLOT_BEAT', name, fields: act ? [{ key: 'act', value: act }] : [] });
}
async function orderOf(bookId: string): Promise<string[]> {
    const rows = await prisma.bibleElement.findMany({ where: { bookId, kind: 'PLOT_BEAT', orderRank: { not: null } }, select: { id: true, orderRank: true } });
    return rows.sort((a, b) => compareRanks(a.orderRank!, b.orderRank!)).map((r) => r.id);
}

type View = Awaited<ReturnType<typeof startInterview>>;
async function answerAll(ctx: WorkspaceRequestContext, bookId: string, view: View, words: (i: number) => string) {
    let i = 0;
    for (const q of view.round!.questions) {
        const body = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: words(i++) };
        await answerQuestion(ctx, bookId, view.session.id, q.id, body);
    }
}

/** Two adjacent placed beats of the opening act, a "What happens between these?" session on them, its round answered and reconciled. */
async function proposedSlotBeat() {
    const { ctx, bookId } = await book();
    const first = await beat(ctx, bookId, 'The ferry sinks');
    const second = await beat(ctx, bookId, 'The trial at Saltmere');
    await move(ctx, bookId, first.id, null, null);
    await move(ctx, bookId, second.id, first.id, null);
    const view = await startInterview(ctx, bookId, { scope: 'BETWEEN', afterElementId: first.id, beforeElementId: second.id, depth: 2, detail: 3 }, deps);
    await answerAll(ctx, bookId, view, (i) => `Answer ${i}: the tide turned when the lamp went out.`);
    await closeRoundAndReconcile(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true }, { reconciler: stubReconciler() });
    const pending = await listPendingStructure(ctx, bookId);
    const proposal = pending.proposals.find((p) => p.kind === 'NEW_ELEMENT')!;
    const links = pending.proposals.filter((p) => p.kind === 'NEW_RELATION');
    expect(proposal).toBeDefined();
    return { ctx, bookId, first, second, sessionId: view.session.id, proposal, links };
}

describe('a changed slot: refuse and ask (D25)', () => {
    it('a neighbour deleted: the acceptance as proposed is 409 SLOT_CHANGED and writes nothing; the review says so and offers the act’s beats', async () => {
        const { ctx, bookId, first, second, sessionId, proposal } = await proposedSlotBeat();
        await deleteElement(ctx, bookId, second.id);
        const count = await prisma.bibleElement.count({ where: { bookId } });
        expect(await refusal(acceptProposal(ctx, bookId, sessionId, proposal.id, {}))).toMatchObject({ status: 409, details: { reason: 'SLOT_CHANGED', change: 'NEIGHBOUR_GONE' } });
        expect(await prisma.bibleElement.count({ where: { bookId } })).toBe(count);
        expect(await prisma.enrichmentProposal.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'PENDING' });

        const review = await getSessionReview(ctx, bookId, sessionId);
        expect(review.newElements[0].slot).toEqual({
            afterElementId: first.id,
            afterName: 'The ferry sinks',
            beforeElementId: second.id,
            beforeName: null,
            act: 'opening',
            changed: 'NEIGHBOUR_GONE',
            choices: [{ elementId: first.id, name: 'The ferry sinks' }],
            choicesTruncated: false,
        });

        // The author chooses: after the first beat.
        const made = await acceptProposal(ctx, bookId, sessionId, proposal.id, { placement: { after: first.id, before: null } });
        expect(made.placed).toBe(true);
        expect(await orderOf(bookId)).toEqual([first.id, made.elementId]);
    });

    it('a neighbour moved to another act: refused; accepted unplaced, it keeps its act and no place, with one version naming the answers', async () => {
        const { ctx, bookId, second, sessionId, proposal } = await proposedSlotBeat();
        await move(ctx, bookId, second.id, null, null, 'crisis');
        expect((await refusal(acceptProposal(ctx, bookId, sessionId, proposal.id, {}))).details).toMatchObject({ reason: 'SLOT_CHANGED', change: 'NEIGHBOUR_MOVED' });
        const made = await acceptProposal(ctx, bookId, sessionId, proposal.id, { placement: { unplaced: true } });
        expect(made.placed).toBe(false);
        expect(await rankOf(made.elementId!)).toBeNull();
        expect(await prisma.bibleField.findFirst({ where: { elementId: made.elementId!, key: 'act' } })).not.toBeNull();
        const versions = await prisma.bibleEntryVersion.findMany({ where: { elementId: made.elementId! } });
        expect(versions.map((v) => [v.source, v.movedInOrder])).toEqual([['INTERVIEW', false]]);
        expect(versions[0].sourceAnswerIds.length).toBeGreaterThan(0);
    });

    it('another beat placed in the gap: refused GAP_FILLED; a place the author names is taken, and a stale one is ORDER_STALE', async () => {
        const { ctx, bookId, first, second, sessionId, proposal } = await proposedSlotBeat();
        const between = await beat(ctx, bookId, 'A beat between');
        await move(ctx, bookId, between.id, first.id, second.id);
        expect((await refusal(acceptProposal(ctx, bookId, sessionId, proposal.id, {}))).details).toMatchObject({ reason: 'SLOT_CHANGED', change: 'GAP_FILLED' });
        const unplaced = await beat(ctx, bookId, 'Never placed');
        expect((await refusal(acceptProposal(ctx, bookId, sessionId, proposal.id, { placement: { after: unplaced.id, before: null } }))).details).toMatchObject({ reason: 'ORDER_STALE' });
        const made = await acceptProposal(ctx, bookId, sessionId, proposal.id, { placement: { after: between.id, before: second.id } });
        expect(await orderOf(bookId)).toEqual([first.id, between.id, made.elementId, second.id]);
    });

    it('the slot as it stood is placed between its two, as before; a placement is refused for anything but a slot’s beat', async () => {
        const { ctx, bookId, first, second, sessionId, proposal, links } = await proposedSlotBeat();
        expect((await getSessionReview(ctx, bookId, sessionId)).newElements[0].slot).toMatchObject({ changed: null, choices: [] });
        expect((await refusal(acceptProposal(ctx, bookId, sessionId, links[0].id, { placement: { unplaced: true } }))).details).toMatchObject({ reason: 'PLACEMENT_NOT_ALLOWED' });
        const made = await acceptProposal(ctx, bookId, sessionId, proposal.id, {});
        expect(await orderOf(bookId)).toEqual([first.id, made.elementId, second.id]);
        // A link's acceptance names the ends it was created between (#53 item 3).
        const link = await acceptProposal(ctx, bookId, sessionId, links[0].id, {});
        const row = await prisma.bibleRelation.findUniqueOrThrow({ where: { id: link.relationId! } });
        expect(link.relationEnds).toEqual({ fromElementId: row.fromElementId, toElementId: row.toElementId });
    });
});

describe('one beat a slot, across rounds (#53 item 1)', () => {
    it('a round reconciled after another proposed the gap’s beat proposes no second one, and the session goes on with that beat', async () => {
        const { ctx, bookId } = await book();
        const first = await beat(ctx, bookId, 'The ferry sinks');
        const second = await beat(ctx, bookId, 'The trial at Saltmere');
        await move(ctx, bookId, first.id, null, null);
        await move(ctx, bookId, second.id, first.id, null);
        const view = await startInterview(ctx, bookId, { scope: 'BETWEEN', afterElementId: first.id, beforeElementId: second.id, depth: 2, detail: 3 }, deps);
        // Round 1's reconcile fails: its answers wait. Round 2 asks about the gap again, and its reconcile proposes the beat.
        await answerAll(ctx, bookId, view, (i) => `Harbour ${i}: the harbour master burns the ledger.`);
        await closeRoundAndReconcile(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true }, { reconciler: failing('TIMEOUT') });
        const round2 = await nextRound(ctx, bookId, view.session.id, deps);
        expect(round2.round!.questions.every((q) => q.subjectId === PENDING_SUBJECT_ID)).toBe(true);
        await answerAll(ctx, bookId, round2, (i) => `Smugglers ${i}: smugglers seize the ferry office.`);
        await closeRoundAndReconcile(ctx, bookId, view.session.id, String(round2.round!.number), { skipUnanswered: true }, { reconciler: stubReconciler() });
        const slotBeats = () => prisma.enrichmentProposal.findMany({ where: { sessionId: view.session.id, kind: 'NEW_ELEMENT', fillsSlot: true } });
        expect(await slotBeats()).toHaveLength(1);

        // Round 1 run again: its answers would name a second beat for the same gap.
        const rerun = await reconcileRound(ctx, bookId, view.session.id, String(view.round!.number), { reconciler: stubReconciler() });
        expect(rerun.status).toBe('DONE');
        expect(await slotBeats()).toHaveLength(1);

        // The gap has its beat, and the session goes on with it (D25 as amended): round 1's rerun proposed its answers
        // as further fields of that beat rather than a second one, and nothing the beat holds is asked again.
        const beatId = (await slotBeats())[0].id;
        const further = await prisma.enrichmentProposal.findMany({ where: { sessionId: view.session.id, kind: 'FIELD' } });
        expect(further.every((f) => f.targetProposalId === beatId && f.elementId === null && f.operation === 'ADD')).toBe(true);
        const held = new Set((await getSessionReview(ctx, bookId, view.session.id)).newElements.find((n) => n.id === beatId)!.fields.map((f) => f.field.key));
        expect(held.size).toBeGreaterThan(0);
        const after = await nextRound(ctx, bookId, view.session.id, deps).catch((err: unknown) => err);
        if (after instanceof AppError) expect(after.details).toMatchObject({ reason: 'INTERVIEW_ENDED' });
        else for (const q of (after as View).round?.questions ?? []) expect(q.targetsFieldKeys.some((k) => held.has(k))).toBe(false);
    });
});

describe('one free order (D25 as amended, #50 item 4)', () => {
    it('an act change with no neighbour named keeps the beat\u2019s place; an unplaced one goes to the end of the whole order', async () => {
        const { ctx, bookId } = await book();
        const open = await beat(ctx, bookId, 'Opening beat', 'opening');
        const crisis = await beat(ctx, bookId, 'Crisis beat', 'crisis');
        const resolution = await beat(ctx, bookId, 'Resolution beat', 'resolution');
        await move(ctx, bookId, open.id, null, null);
        await move(ctx, bookId, crisis.id, null, null);
        await move(ctx, bookId, resolution.id, null, null);
        expect(await orderOf(bookId)).toEqual([open.id, crisis.id, resolution.id]);
        // An unplaced beat dropped into the empty escalation lane (no neighbour named): the end of the whole order,
        // not after the earlier acts' beats.
        const escalation = await beat(ctx, bookId, 'Escalation beat', null);
        const placed = await move(ctx, bookId, escalation.id, null, null, 'escalation');
        expect(placed).toMatchObject({ moved: true, act: 'escalation' });
        expect(await orderOf(bookId)).toEqual([open.id, crisis.id, resolution.id, escalation.id]);
        // A placed beat moved into another, empty act: its act changes and its rank does not.
        const rank = await rankOf(open.id);
        const before = await versionOf(ctx, bookId, open.id);
        const moved = await move(ctx, bookId, open.id, null, null, 'resolution');
        expect(moved).toMatchObject({ moved: true, act: 'resolution', orderRank: rank });
        expect(await rankOf(open.id)).toBe(rank);
        expect(await versionOf(ctx, bookId, open.id)).toBe(before + 1);
        expect(await orderOf(bookId)).toEqual([open.id, crisis.id, resolution.id, escalation.id]);
    });

    it('the author places a beat of a later act before a beat of an earlier one, and the order is the rank alone', async () => {
        const { ctx, bookId } = await book();
        const open = await beat(ctx, bookId, 'Opening beat', 'opening');
        const crisis = await beat(ctx, bookId, 'Crisis beat', 'crisis');
        await move(ctx, bookId, open.id, null, null);
        await move(ctx, bookId, crisis.id, open.id, null);
        // A crisis beat dragged before the opening beat, with its neighbour named.
        const early = await beat(ctx, bookId, 'Early crisis', 'crisis');
        await move(ctx, bookId, early.id, null, open.id);
        expect(await orderOf(bookId)).toEqual([early.id, open.id, crisis.id]);
        // And an opening beat after the crisis beats, by naming them.
        const late = await beat(ctx, bookId, 'Late opening', 'opening');
        await move(ctx, bookId, late.id, crisis.id, null);
        expect(await orderOf(bookId)).toEqual([early.id, open.id, crisis.id, late.id]);
        // Moving into another act while naming neighbours places it between them.
        await move(ctx, bookId, late.id, early.id, open.id, 'escalation');
        expect(await orderOf(bookId)).toEqual([early.id, late.id, open.id, crisis.id]);
    });
});

describe('a rebalance (#50 item 7)', () => {
    it('a spent gap rebalances the whole order in place, and the move lands; only the moved beat gets a version', async () => {
        const { ctx, bookId } = await book();
        const ids: string[] = [];
        for (const name of ['One', 'Two', 'Three', 'Four']) ids.push((await beat(ctx, bookId, name)).id);
        // Two neighbours whose gap is spent: ranks a 64-character key apart, as ~300 inserts at one spot leave them.
        const tight = `i${'0'.repeat(ORDER_RANK_MAX - 2)}1`;
        await prisma.bibleElement.update({ where: { id: ids[0] }, data: { orderRank: 'i' } });
        await prisma.bibleElement.update({ where: { id: ids[1] }, data: { orderRank: tight } });
        await prisma.bibleElement.update({ where: { id: ids[2] }, data: { orderRank: 'r' } });
        const versionsBefore = await prisma.bibleEntryVersion.count({ where: { bookId } });

        const moved = await move(ctx, bookId, ids[3], ids[0], ids[1]);
        expect(moved.moved).toBe(true);
        expect(await orderOf(bookId)).toEqual([ids[0], ids[3], ids[1], ids[2]]);
        // The others were re-ranked, short again, in the same order...
        const ranks = await Promise.all([ids[0], ids[1], ids[2]].map(rankOf));
        expect(ranks.every((r) => r !== null && r.length <= 3)).toBe(true);
        expect(new Set(rebalancedRanks(3))).toEqual(new Set(ranks));
        // ...and wrote no version: the moved beat's move is the one version (rule 1 holds: nobody's story changed).
        expect(await prisma.bibleEntryVersion.count({ where: { bookId } })).toBe(versionsBefore + 1);
        expect(await prisma.auditLog.count({ where: { action: 'BIBLE_ORDER_REBALANCED', entityId: bookId } })).toBe(1);
    });
});

describe('lock order: map → names → order → element → relation (#50 item 2, #53 item 4)', () => {
    it('a plot board save waits for the order an import re-ranks, rather than deadlocking with it on the beats’ rows', async () => {
        const { ctx, bookId } = await book();
        const a = await beat(ctx, bookId, 'Alpha');
        const b = await beat(ctx, bookId, 'Beta');
        await move(ctx, bookId, a.id, null, null);
        await move(ctx, bookId, b.id, a.id, null);
        const [ra, rb] = [(await rankOf(a.id))!, (await rankOf(b.id))!];
        let saving: Promise<unknown> | null = null;
        // What an import does (bible-import.ts): the order's lock, then each beat it re-ranks, FOR UPDATE (the rank is
        // in a unique index). A save adding those beats as nodes takes a KEY SHARE lock on each: in the opposite order,
        // Postgres aborts one of the two (40P01), and the author saw a 500.
        await prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bible-order:' + bookId + ':PLOT_BEAT'}))`;
                await tx.$executeRaw`UPDATE "BibleElement" SET "orderRank" = NULL WHERE "id" = ${b.id}`;
                saving = saveStoryMap(ctx, bookId, 'plot', {
                    expectedVersion: 0,
                    nodes: [
                        { elementId: a.id, x: 0, y: 0, w: 200, h: 88, lane: null },
                        { elementId: b.id, x: 0, y: 0, w: 200, h: 88, lane: null },
                    ],
                    edges: [],
                    freeform: [],
                });
                saving.catch(() => undefined);
                // The save queues on the ORDER's lock, holding no beat's row.
                await untilWaitingOnAdvisoryLock();
                await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
                await tx.$executeRaw`UPDATE "BibleElement" SET "orderRank" = ${rb} WHERE "id" = ${a.id}`;
                await tx.$executeRaw`UPDATE "BibleElement" SET "orderRank" = ${ra} WHERE "id" = ${b.id}`;
            },
            { timeout: 20_000 },
        );
        await expect(saving!).resolves.toMatchObject({ saved: true });
        expect(await orderOf(bookId)).toEqual([b.id, a.id]);
    });

    it('removing a relation takes its lock: it queues behind a save of the relation’s fields and is read under it', async () => {
        const { ctx, bookId } = await book();
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren' });
        const tomas = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Tomas' });
        const relation = await addRelation(ctx, bookId, { fromElementId: wren.id, toElementId: tomas.id, type: 'related_to' });
        let removing: Promise<unknown> | null = null;
        await prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bible-relation:' + relation.id}))`;
                removing = removeRelation(ctx, bookId, relation.id);
                removing.catch(() => undefined);
                await untilWaitingOnAdvisoryLock();
                expect(await tx.bibleRelation.count({ where: { id: relation.id } })).toBe(1);
            },
            { timeout: 20_000 },
        );
        await expect(removing!).resolves.toEqual({ id: relation.id });
        expect(await prisma.bibleRelation.count({ where: { id: relation.id } })).toBe(0);
        // And the save it queued behind finds it gone: 404, never a 500.
        expect((await refusal(saveRelationFields(ctx, bookId, relation.id, { baseVersion: 1, fields: [{ key: 'nature', value: 'Old friends.' }] }))).status).toBe(404);
    });
});

describe('a long order (#50 item 3)', () => {
    it('the bundle import sees a taken place past ten thousand placed beats: ORDER_TAKEN, never a 500', async () => {
        const { ctx, bookId } = await book('Long order');
        const mine = await beat(ctx, bookId, 'The one in the bundle');
        await move(ctx, bookId, mine.id, null, null);
        const exported = readZip((await exportBibleBundle(ctx, bookId)).bytes, { maxEntries: 100, maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22, maxRatio: 1000 });
        // 10,050 more placed beats, written directly (the order the import used to read was capped at 10,001).
        const { workspaceId } = await prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: { workspaceId: true } });
        const ranks = rebalancedRanks(10_050).map((r) => `a${r}`);
        for (let i = 0; i < ranks.length; i += 1_000) {
            await prisma.bibleElement.createMany({
                data: ranks.slice(i, i + 1_000).map((orderRank, j) => ({ workspaceId, bookId, kind: 'PLOT_BEAT' as const, name: `Filler ${i + j}`, slug: `filler-${i + j}`, orderRank })),
            });
        }
        // A place the capped read would not have seen.
        const seen = new Set((await prisma.$transaction((tx) => BibleElementRepository.rankedInOrder(tx, workspaceId, bookId, 'PLOT_BEAT', 10_001))).map((r) => r.orderRank));
        const unseen = ranks.find((r) => !seen.has(r))!;
        expect(unseen).toBeDefined();
        const path = [...exported.keys()].find((p) => p.startsWith('plot_beat/') && p !== 'plot_beat/_index.md')!;
        const text = new TextDecoder().decode(exported.get(path)!);
        const changed = new Map(exported);
        changed.set(path, new TextEncoder().encode(text.replace(/^order: .*$/m, `order: ${unseen}`)));
        const refused = await refusal(importBibleBundle(ctx, bookId, writeZip(changed), {}, clean));
        expect(refused.status).toBe(400);
        expect((refused.details.problems as Array<{ path: string; reason: string }>).map((p) => [p.path, p.reason])).toEqual([[path, 'ORDER_TAKEN']]);
    }, 60_000);
});
