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
 *      moved — nobody else's row changes, however long the order (with no
 *      neighbour named, a placed element keeps its rank and an unplaced one
 *      goes to the end of the order, D25; a spent gap first REBALANCES the
 *      order, writing no version: `rankForTarget`);
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
 *   a gap still past the rank's bound after a rebalance    409 ORDER_RANK_EXHAUSTED
 *   an order of more than ORDER_SCOPE_MAX placed elements  409 ORDER_SCOPE_TOO_LARGE
 *
 * A move that leaves the element where it is (already between the two, act
 * unchanged) writes nothing and records no version. The unique
 * (bookId, kind, orderRank) is the guarantee behind the lock.
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleFieldRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import { ElementOrderInput } from '@/app-layer/schemas/bible';
import { decodeFieldValue } from '@/lib/bible/field-values';
import { isOrderedKind } from '@/lib/bible/kinds';
import { compareRanks, placeRank, rebalancedRanks } from '@/lib/bible/story-order';
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

function exhausted(): ConflictError {
    return new ConflictError('There is no more room at that place in the order.', { reason: 'ORDER_RANK_EXHAUSTED' });
}

/** Every placed element of one order (id and rank), or 409 ORDER_SCOPE_TOO_LARGE past `ORDER_SCOPE_MAX`: never a cut read. */
export async function readPlacedOrder(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, kind: BibleElementKind): Promise<Array<{ id: string; orderRank: string }>> {
    const ranked = await BibleElementRepository.rankedInOrder(db, ctx.workspaceId, bookId, kind, ORDER_SCOPE_MAX + 1);
    if (ranked.length > ORDER_SCOPE_MAX) throw new ConflictError('This order is too long to move in.', { reason: 'ORDER_SCOPE_TOO_LARGE' });
    return ranked.map((r) => ({ id: r.id, orderRank: r.orderRank as string }));
}

/** The act each beat stands in (its lane), or null. Only the act is read, one value an element. */
export async function actsOf(db: PrismaTx, ctx: WorkspaceRequestContext, ids: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>(ids.map((id) => [id, null]));
    for (let i = 0; i < ids.length; i += 1_000) {
        for (const r of await BibleFieldRepository.valuesOfKey(db, ctx.workspaceId, ids.slice(i, i + 1_000), ACT_FIELD_KEY)) {
            const v = decodeFieldValue(r.value);
            out.set(r.elementId, typeof v === 'string' ? v : null);
        }
    }
    return out;
}

/** Where an element is asked to go: the neighbours by id, as a view drew them. */
export interface OrderTarget {
    after: string | null;
    before: string | null;
}

/**
 * The rank an element takes at `target`, under the order's lock the CALLER
 * holds (Phase 3.2; 3.H). The rules:
 *
 *   NEIGHBOURS   each named one must be a placed element of the order (409
 *                ORDER_STALE otherwise), and the rank is strictly between them
 *                and unique in the whole order (`placeRank`).
 *   NONE NAMED   the end of the whole order. The story order is ONE free order
 *                per book and kind, the rank alone (decision D25 as the owner
 *                amended it, 2026-11-20): a beat's act draws its lane on the
 *                plot board and never decides its place, so a beat in a later
 *                act may stand before one in an earlier act, and 4.2 reads
 *                before and after from the rank alone.
 *   REBALANCE    (issue #50 item 7) a gap split past the rank's bound is not
 *                refused at once: the whole order is given short, evenly
 *                spaced ranks in the same order (`rebalancedRanks`), and the
 *                rank is computed again. Only a rank still past the bound
 *                is 409 ORDER_RANK_EXHAUSTED.
 */
export async function rankForTarget(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    element: { id: string; kind: BibleElementKind },
    target: OrderTarget,
): Promise<{ rank: string; rebalanced: number }> {
    let ranked = await readPlacedOrder(db, ctx, bookId, element.kind);
    const decide = (order: ReadonlyArray<{ id: string; orderRank: string }>) => {
        const rankOf = new Map(order.map((r) => [r.id, r.orderRank] as const));
        const neighbour = (id: string | null) => {
            if (id === null) return null;
            const rank = rankOf.get(id);
            if (rank === undefined) throw stale();
            return rank;
        };
        const others = order.filter((r) => r.id !== element.id);
        const placement = { after: neighbour(target.after), before: neighbour(target.before) };
        return placeRank(
            others.map((r) => r.orderRank),
            placement,
        );
    };
    let decision = decide(ranked);
    let rebalanced = 0;
    if (!decision.ok && decision.reason === 'ORDER_RANK_EXHAUSTED') {
        rebalanced = await rebalanceOrder(db, ctx, bookId, element.kind, ranked);
        ranked = await readPlacedOrder(db, ctx, bookId, element.kind);
        decision = decide(ranked);
    }
    if (!decision.ok) throw decision.reason === 'ORDER_STALE' ? stale() : exhausted();
    return { rank: decision.rank, rebalanced };
}

/**
 * REBALANCE one (book, kind) order (Phase 3.H, issue #50 item 7, decision
 * D25): every placed element gets a short rank, evenly spaced, in exactly the
 * order it stood in. The CALLER holds the order's lock (two rebalances, or a
 * rebalance and a move, cannot interleave). Deterministic: the same order
 * gives the same ranks.
 *
 * IT WRITES NO VERSION. A version records a change an author (or an accepted
 * proposal, naming its answers: rule 1) made to an element; a rebalance
 * changes no element's place relative to any other — what the board, the
 * timeline, the PDF and 4.2's before / after read is the same before and after
 * — only the keys that encode it. A version per element would put hundreds of
 * entries the author never made in their history and make every open tab's
 * next save of those elements a VERSION_CONFLICT. A restore never applies an
 * old rank (3.2), so an older snapshot's rank stays history only. One audit
 * row records it, with the count.
 */
async function rebalanceOrder(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, kind: BibleElementKind, ranked: ReadonlyArray<{ id: string; orderRank: string }>): Promise<number> {
    const sorted = [...ranked].sort((a, b) => compareRanks(a.orderRank, b.orderRank));
    const ranks = rebalancedRanks(sorted.length);
    await BibleElementRepository.rebalanceOrder(
        db,
        ctx.workspaceId,
        bookId,
        kind,
        sorted.map((r) => r.id),
        ranks,
    );
    await logEvent(ctx, { action: 'BIBLE_ORDER_REBALANCED', entityType: 'Book', entityId: bookId, details: { bookId, kind, elementCount: sorted.length } }, { db });
    return sorted.length;
}

/**
 * Place a NEW, unplaced element of an ordered kind inside the caller's
 * transaction (Phase 3.3: accepting the beat "What happens between these?"
 * proposed; 3.H: the place the author chose once its slot changed). The 3.2
 * move's rules: the CALLER holds the order's lock (`lockOrder`, taken before
 * any element lock) and the element's; the rank by `rankForTarget` (a
 * neighbour no longer placed is 409 ORDER_STALE: the element never lands
 * anywhere the author did not choose, decision D25); one version marked
 * `movedInOrder`, naming what the placement came from (`meta`: an accepted
 * proposal's is INTERVIEW, naming its answers, rule 1).
 */
export async function placeNewElementInOrderTx(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    element: { id: string; kind: BibleElementKind },
    target: OrderTarget,
    meta: Pick<VersionMeta, 'source' | 'sourceAnswerIds'> = { source: 'MANUAL' },
): Promise<{ orderRank: string; versionNumber: number }> {
    if (!isOrderedKind(element.kind)) throw new ValidationError('Only plot beats and timeline events have a story order.', { reason: 'ORDER_NOT_ALLOWED', kind: element.kind });
    const { rank } = await rankForTarget(db, ctx, bookId, element, target);
    await BibleElementRepository.setOrderRank(db, ctx.workspaceId, bookId, element.id, rank);
    const version = await recordVersion(db, ctx, bookId, element.id, { ...meta, movedInOrder: true });
    await logEvent(
        ctx,
        { action: 'BIBLE_ELEMENT_MOVED', entityType: 'BibleElement', entityId: element.id, details: { bookId, kind: element.kind, versionNumber: version.versionNumber, rankChanged: true, actChanged: false } },
        { db },
    );
    return { orderRank: rank, versionNumber: version.versionNumber };
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

            const values = await readFieldValues(db, ctx, elementId);
            const currentAct = typeof values.get(ACT_FIELD_KEY) === 'string' ? (values.get(ACT_FIELD_KEY) as string) : null;
            const actChanges = parsed.act !== undefined && parsed.act !== currentAct;
            const ranked = await readPlacedOrder(db, ctx, bookId, kind);
            const rankOf = new Map(ranked.map((r) => [r.id, r.orderRank] as const));
            const neighbour = (id: string | null) => {
                if (id === null) return null;
                const rank = rankOf.get(id);
                if (rank === undefined) throw stale();
                return rank;
            };
            const after = neighbour(parsed.after);
            const before = neighbour(parsed.before);
            const current = element.orderRank;
            // Already there: between the two named. With none named a placed element stays where it is, whatever its act:
            // one free order (D25 as amended), so an act change alone moves no rank.
            const standsThere =
                current !== null && (after === null || compareRanks(after, current) < 0) && (before === null || compareRanks(current, before) < 0);
            if (standsThere && !actChanges) {
                const versionNumber = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, elementId);
                return { elementId, orderRank: current, act: currentAct, versionNumber, moved: false };
            }

            let rank = current;
            if (!standsThere) {
                rank = (await rankForTarget(db, ctx, bookId, { id: elementId, kind }, { after: parsed.after, before: parsed.before })).rank;
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
