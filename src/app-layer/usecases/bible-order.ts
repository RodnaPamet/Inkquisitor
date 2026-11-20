/**
 * Story order (Phase 3.2, decision D22): moving a plot beat within and between
 * its acts, and a timeline event along the timeline. The order is kept in the
 * BIBLE (`BibleElement.orderRank`, a fractional rank, `src/lib/bible/story-order.ts`)
 * — the plot board and the timeline only derive positions from it — so the
 * interviews and the continuity checks of 4.2 read before and after from the
 * same rows the maps draw.
 *
 * A MOVE IS A SAVE OF THE ELEMENT (`bible.edit`), in one transaction:
 *
 *   1. `lockOrder(book, kind)` — the order's advisory lock, FIRST, so two moves
 *      of one order queue and each computes its rank from the ranks the other
 *      left (`placeRank`), never the same one;
 *   2. the element's own lock, then `assertBaseVersion` (409
 *      `VERSION_CONFLICT`: the card was saved elsewhere since it was drawn);
 *   3. the new rank, strictly between the neighbours the author saw (`after`
 *      and `before`) and unique in the whole order, written to the ONE element
 *      moved — nobody else's row changes, however long the order;
 *   4. for a beat dropped into another lane, its `act` field, through the
 *      field path every save takes (`writeFieldValues`, the template's options);
 *   5. one `BibleEntryVersion`, `movedInOrder`, and an audit row.
 *
 * Refused, writing nothing:
 *
 *   a kind with no order                                   400 ORDER_NOT_ALLOWED
 *   an act for anything but a beat                         400 ORDER_ACT_NOT_ALLOWED
 *   a neighbour that is the element itself                 400 ORDER_SELF
 *   a neighbour that is not a placed element of the        409 ORDER_STALE (someone moved,
 *   order, or neighbours no longer in that order               unplaced or deleted it meanwhile)
 *   a gap split past the rank's bound                      409 ORDER_RANK_EXHAUSTED
 *
 * A move that leaves the element where it is (already between the two, act
 * unchanged) writes nothing and records no version. The unique
 * (bookId, kind, orderRank) is the guarantee behind the lock.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import { ElementOrderInput } from '@/app-layer/schemas/bible';
import { isOrderedKind } from '@/lib/bible/kinds';
import { compareRanks, placeRank } from '@/lib/bible/story-order';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, ValidationError } from '@/lib/errors/types';
import { assertBaseVersion, isUniqueViolation, readFieldValues, recordVersion, requireBook, requireElement, writeFieldValues, type VersionMeta } from './bible-common';

/** Placed elements one order may hold before a move is refused (far past any book's beats or events). */
export const ORDER_SCOPE_MAX = 10_000;

/** The template field a beat's act lives in. */
export const ACT_FIELD_KEY = 'act';

export interface OrderMoveResult {
    elementId: string;
    /** The element's rank now (unchanged when `moved` is false). */
    orderRank: string | null;
    /** The beat's act now, or null (an event, or a beat with none). */
    act: string | null;
    /** The element's latest version: the next save's base. */
    versionNumber: number;
    /** False when the element already stood there: nothing was written. */
    moved: boolean;
}

function stale(): ConflictError {
    return new ConflictError('The order changed since this view was drawn.', { reason: 'ORDER_STALE' });
}

/**
 * Place a NEW, unplaced element of an ordered kind between two of its kind's
 * elements, inside the caller's transaction (Phase 3.3: accepting the beat
 * "What happens between these?" proposed). The 3.2 move's rules: the CALLER
 * holds the order's lock (`lockOrder`, taken before any element lock) and the
 * element's; one rank strictly between the neighbours (`placeRank`), one
 * version marked `movedInOrder`. A neighbour no longer placed (moved out of
 * the order, deleted) is an open end, so the element still lands beside the
 * one that remains; with neither, it stays unplaced and nothing is written.
 * The version names what the placement came from (`meta`: an accepted
 * proposal's is INTERVIEW, naming its answers, rule 1).
 */
export async function placeNewElementInOrderTx(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    element: { id: string; kind: string },
    neighbours: { after: string | null; before: string | null },
    meta: Pick<VersionMeta, 'source' | 'sourceAnswerIds'> = { source: 'MANUAL' },
): Promise<{ placed: boolean; orderRank: string | null; versionNumber: number | null }> {
    if (!isOrderedKind(element.kind)) return { placed: false, orderRank: null, versionNumber: null };
    const ranked = await BibleElementRepository.rankedInOrder(db, ctx.workspaceId, bookId, element.kind, ORDER_SCOPE_MAX + 1);
    if (ranked.length > ORDER_SCOPE_MAX) throw new ConflictError('This order is too long to move in.', { reason: 'ORDER_SCOPE_TOO_LARGE' });
    const rankOf = new Map(ranked.map((r) => [r.id, r.orderRank as string] as const));
    const after = neighbours.after ? (rankOf.get(neighbours.after) ?? null) : null;
    let before = neighbours.before ? (rankOf.get(neighbours.before) ?? null) : null;
    // Moved past each other since: the earlier one is kept, and the element goes after it.
    if (after !== null && before !== null && compareRanks(after, before) >= 0) before = null;
    if (after === null && before === null) return { placed: false, orderRank: null, versionNumber: null };
    const others = ranked.filter((r) => r.id !== element.id).map((r) => r.orderRank as string);
    let decision = placeRank(others, { after, before });
    if (!decision.ok && decision.reason === 'ORDER_STALE') {
        // The order moved between the two (a beat placed between them meanwhile): beside the earlier one.
        before = null;
        decision = placeRank(others, { after, before });
        if (!decision.ok && after === null) return { placed: false, orderRank: null, versionNumber: null };
    }
    if (!decision.ok) throw new ConflictError('There is no more room at that place in the order.', { reason: 'ORDER_RANK_EXHAUSTED' });
    await BibleElementRepository.setOrderRank(db, ctx.workspaceId, bookId, element.id, decision.rank);
    const version = await recordVersion(db, ctx, bookId, element.id, { ...meta, movedInOrder: true });
    await logEvent(
        ctx,
        { action: 'BIBLE_ELEMENT_MOVED', entityType: 'BibleElement', entityId: element.id, details: { bookId, kind: element.kind, versionNumber: version.versionNumber, rankChanged: true, actChanged: false } },
        { db },
    );
    return { placed: true, orderRank: decision.rank, versionNumber: version.versionNumber };
}

export async function moveElementInOrder(ctx: WorkspaceRequestContext, bookId: string, elementId: string, input: unknown): Promise<OrderMoveResult> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = ElementOrderInput.parse(input);
    if (parsed.after === elementId || parsed.before === elementId) {
        throw new ValidationError('An element cannot be placed beside itself.', { reason: 'ORDER_SELF' });
    }
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            await requireBook(db, ctx, bookId);
            // The kind decides which order's lock to take; it never changes.
            const { kind } = await requireElement(db, ctx, bookId, elementId);
            if (!isOrderedKind(kind)) throw new ValidationError('Only plot beats and timeline events have a story order.', { reason: 'ORDER_NOT_ALLOWED', kind });
            if (parsed.act !== undefined && kind !== 'PLOT_BEAT') {
                throw new ValidationError('Only a plot beat has an act.', { reason: 'ORDER_ACT_NOT_ALLOWED' });
            }

            await BibleElementRepository.lockOrder(db, bookId, kind);
            await BibleElementRepository.lock(db, elementId);
            const element = await requireElement(db, ctx, bookId, elementId);
            await assertBaseVersion(db, ctx, elementId, parsed.baseVersion);

            const ranked = await BibleElementRepository.rankedInOrder(db, ctx.workspaceId, bookId, kind, ORDER_SCOPE_MAX + 1);
            if (ranked.length > ORDER_SCOPE_MAX) throw new ConflictError('This order is too long to move in.', { reason: 'ORDER_SCOPE_TOO_LARGE' });
            const rankOf = new Map(ranked.map((r) => [r.id, r.orderRank as string] as const));
            const neighbour = (id: string | null) => {
                if (id === null) return null;
                const rank = rankOf.get(id);
                if (rank === undefined) throw stale();
                return rank;
            };
            const after = neighbour(parsed.after);
            const before = neighbour(parsed.before);

            const values = await readFieldValues(db, ctx, elementId);
            const currentAct = typeof values.get(ACT_FIELD_KEY) === 'string' ? (values.get(ACT_FIELD_KEY) as string) : null;
            const actChanges = parsed.act !== undefined && parsed.act !== currentAct;
            const current = element.orderRank;
            const standsThere =
                current !== null && (after === null || compareRanks(after, current) < 0) && (before === null || compareRanks(current, before) < 0);
            if (standsThere && !actChanges) {
                const versionNumber = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, elementId);
                return { elementId, orderRank: current, act: currentAct, versionNumber, moved: false };
            }

            let rank = current;
            if (!standsThere) {
                const others = ranked.filter((r) => r.id !== elementId).map((r) => r.orderRank as string);
                const decision = placeRank(others, { after, before });
                if (!decision.ok) {
                    if (decision.reason === 'ORDER_STALE') throw stale();
                    throw new ConflictError('There is no more room at that place in the order.', { reason: 'ORDER_RANK_EXHAUSTED' });
                }
                rank = decision.rank;
                await BibleElementRepository.setOrderRank(db, ctx.workspaceId, bookId, elementId, rank);
            }
            if (actChanges) await writeFieldValues(db, ctx, element, [{ key: ACT_FIELD_KEY, value: parsed.act }]);

            const version = await recordVersion(db, ctx, bookId, elementId, { source: 'MANUAL', movedInOrder: true });
            await logEvent(
                ctx,
                {
                    action: 'BIBLE_ELEMENT_MOVED',
                    entityType: 'BibleElement',
                    entityId: elementId,
                    details: { bookId, kind, versionNumber: version.versionNumber, rankChanged: rank !== current, actChanged: actChanges },
                },
                { db },
            );
            return { elementId, orderRank: rank, act: actChanges ? (parsed.act ?? null) : currentAct, versionNumber: version.versionNumber, moved: true };
        });
    } catch (err) {
        // The unique (bookId, kind, orderRank) behind the lock: a writer that
        // skipped the lock took the place first.
        if (isUniqueViolation(err)) throw stale();
        throw err;
    }
}
