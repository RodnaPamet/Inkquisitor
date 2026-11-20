/**
 * A BETWEEN slot (Phase 3.3; 3.H): the place between two neighbouring plot
 * beats of one act that "What happens between these?" asks about, and what
 * has become of it since. Kept apart from `interview-scope.ts` because the
 * acceptance that places a slot's beat (`enrichment-review.ts`) is on the
 * bible's write path, which must not reach a dial module
 * (`tests/guards/dials-stay-off-the-bible-write-path.test.ts`); the interview
 * scope's request schemas do.
 *
 *   resolveBetweenSlot   the slot at the start: two placed beats of one lane,
 *                        adjacent in it, the first before the second (400
 *                        SLOT_INVALID naming the problem otherwise);
 *   slotChangeOf         how it changed since (D25, "refuse and ask");
 *   slotLaneChoices      where a changed slot's beat may go instead;
 *   slotTakenBy          whether the session's slot already has its beat
 *                        (#53 item 1: one beat per slot, across rounds).
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { EnrichmentProposalRepository } from '@/app-layer/repositories/enrichment.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import type { BibleKind } from '@/lib/bible/kinds';
import { compareRanks } from '@/lib/bible/story-order';
import { actsOf, readPlacedOrder } from './bible-order';

/** The kind a BETWEEN session's element not yet created takes: a plot beat (the plot board's slots). */
export const SLOT_KIND: BibleKind = 'PLOT_BEAT';

export interface BetweenSlot {
    kind: BibleKind;
    afterElementId: string;
    beforeElementId: string;
    /** The act lane the two share, or null when neither has one. */
    act: string | null;
}

function slotInvalid(problem: string): ValidationError {
    return new ValidationError('Those two beats do not have an empty place between them.', { reason: 'SLOT_INVALID', problem });
}

/** Resolve a BETWEEN slot: two placed beats of one lane, adjacent in it, the first before the second. */
export async function resolveBetweenSlot(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, afterId: string, beforeId: string): Promise<BetweenSlot> {
    if (afterId === beforeId) throw slotInvalid('SAME_ELEMENT');
    const ends = await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, [afterId, beforeId]);
    const after = ends.find((e) => e.id === afterId);
    const before = ends.find((e) => e.id === beforeId);
    if (!after || !before) throw new NotFoundError('Element not found.');
    if (after.kind !== SLOT_KIND || before.kind !== SLOT_KIND) throw slotInvalid('NOT_PLOT_BEATS');
    if (after.orderRank === null || before.orderRank === null) throw slotInvalid('NOT_PLACED');
    if (compareRanks(after.orderRank, before.orderRank) >= 0) throw slotInvalid('NOT_IN_ORDER');
    const acts = await actsOf(db, ctx, [afterId, beforeId]);
    const act = acts.get(afterId) ?? null;
    if (act !== (acts.get(beforeId) ?? null)) throw slotInvalid('DIFFERENT_LANES');
    // No beat of the same lane strictly between them.
    const ranked = await readPlacedOrder(db, ctx, bookId, SLOT_KIND as BibleElementKind);
    const inside = ranked.filter((r) => compareRanks(after.orderRank!, r.orderRank) < 0 && compareRanks(r.orderRank, before.orderRank!) < 0).map((r) => r.id);
    if (inside.length > 0) {
        const insideActs = await actsOf(db, ctx, inside);
        if (inside.some((id) => (insideActs.get(id) ?? null) === act)) throw slotInvalid('NOT_ADJACENT');
    }
    return { kind: SLOT_KIND, afterElementId: afterId, beforeElementId: beforeId, act };
}

/**
 * How a BETWEEN session's slot has changed since the session started (Phase
 * 3.H, issue #53 item 2, owner decision D25: "refuse and ask"), or null when
 * it still stands: both neighbours there, placed, in the slot's act, the first
 * before the second, with no beat of that act between them. Accepting the beat
 * proposed for a changed slot is refused (409 SLOT_CHANGED, naming this) until
 * the author chooses where it goes or accepts it unplaced.
 */
export type SlotChange = 'NEIGHBOUR_GONE' | 'NEIGHBOUR_UNPLACED' | 'NEIGHBOUR_MOVED' | 'GAP_FILLED';

export async function slotChangeOf(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    session: { slotAfterElementId: string | null; slotBeforeElementId: string | null; slotAct: string | null },
): Promise<SlotChange | null> {
    if (!session.slotAfterElementId || !session.slotBeforeElementId) return 'NEIGHBOUR_GONE';
    try {
        const slot = await resolveBetweenSlot(db, ctx, bookId, session.slotAfterElementId, session.slotBeforeElementId);
        return slot.act === (session.slotAct ?? null) ? null : 'NEIGHBOUR_MOVED';
    } catch (err) {
        if (err instanceof NotFoundError) return 'NEIGHBOUR_GONE';
        const problem = err instanceof ValidationError ? (err.details as { reason?: string; problem?: string } | undefined) : undefined;
        if (problem?.reason !== 'SLOT_INVALID') throw err;
        if (problem.problem === 'NOT_PLACED') return 'NEIGHBOUR_UNPLACED';
        if (problem.problem === 'NOT_ADJACENT') return 'GAP_FILLED';
        return 'NEIGHBOUR_MOVED';
    }
}

/** Beats a changed slot's beat may be placed among: the placed beats of the slot's act, in story order. */
export const SLOT_CHOICES_MAX = 100;

export async function slotLaneChoices(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    act: string | null,
): Promise<{ choices: Array<{ elementId: string; name: string }>; truncated: boolean }> {
    const ranked = await readPlacedOrder(db, ctx, bookId, SLOT_KIND as BibleElementKind);
    const acts = await actsOf(db, ctx, ranked.map((r) => r.id));
    const lane = ranked.filter((r) => (acts.get(r.id) ?? null) === act).sort((a, b) => compareRanks(a.orderRank, b.orderRank));
    const kept = lane.slice(0, SLOT_CHOICES_MAX);
    const names = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, kept.map((r) => r.id))).map((e) => [e.id, e.name] as const));
    return { choices: kept.flatMap((r) => (names.has(r.id) ? [{ elementId: r.id, name: names.get(r.id)! }] : [])), truncated: lane.length > SLOT_CHOICES_MAX };
}

/**
 * Whether a BETWEEN session's slot already has its beat (Phase 3.H, issue #53
 * item 1, decision D25): a beat proposed for it and still PENDING, or accepted
 * with its element still in the book. A slot holds ONE beat. Once it has one,
 * the session asks nothing more about the gap (there is no gap: what happens
 * between the two is that beat, and a session started on the beat asks against
 * its stored fields, rule 5), and reconcile refuses a second beat for it
 * (`SLOT_TAKEN`) rather than storing a duplicate the author would have to
 * reject. A rejected beat, or one whose element was deleted, frees the slot.
 */
export async function slotTakenBy(db: PrismaTx, ctx: WorkspaceRequestContext, session: { id: string; bookId: string }): Promise<boolean> {
    const holders = await EnrichmentProposalRepository.slotHolders(db, ctx.workspaceId, session.id, 20);
    if (holders.some((h) => h.status === 'PENDING')) return true;
    const created = holders.flatMap((h) => (h.createdElementId ? [h.createdElementId] : []));
    if (created.length === 0) return false;
    return (await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, created)).length > 0;
}
