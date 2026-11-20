/**
 * What a canvas interview asks about (Phase 3.3), resolved when it starts and
 * frozen on the session. Not a public usecase module: it runs inside the
 * start's transaction, after `bible.edit` was asked.
 *
 *   SELECTION  ("Grill this", and an edge's "Question this relation"): the
 *              elements selected, and the relations in scope — those selected
 *              and every relation of the book BETWEEN two selected elements.
 *              Every id must be the book's (404 otherwise: another book's or
 *              workspace's element reads as missing); nothing at all is 400
 *              SCOPE_EMPTY (rule 6: a session over nothing would "complete"
 *              having asked nothing); more relations than a session holds is
 *              400 SCOPE_TOO_LARGE (select fewer), never a silent cut.
 *   BETWEEN    ("What happens between these?"): two neighbouring plot beats
 *              of one act lane, both placed in story order, the first before
 *              the second and no beat of that lane between them. The session
 *              asks about the beat that does not exist yet (`subjects.ts`);
 *              reconcile proposes it as a NEW_ELEMENT that fills the slot, and
 *              accepting it places it between them through the order move.
 *              Anything else is 400 SLOT_INVALID naming the problem.
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleElementRepository, BibleFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { SELECTION_RELATIONS_MAX } from '@/app-layer/schemas/interview';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { decodeFieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import { compareRanks } from '@/lib/bible/story-order';
import { ACT_FIELD_KEY, ORDER_SCOPE_MAX } from './bible-order';

/** The kind a BETWEEN session's element not yet created takes: a plot beat (the plot board's slots). */
export const SLOT_KIND: BibleKind = 'PLOT_BEAT';

export interface SelectionScope {
    elementIds: string[];
    relationIds: string[];
    /** The kinds of the elements selected (their craft packs). */
    kinds: BibleKind[];
}

/** Resolve a selection: every id the book's, the relations between the elements added, nothing empty or too large. */
export async function resolveSelection(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, input: { elementIds?: readonly string[]; relationIds?: readonly string[] }): Promise<SelectionScope> {
    const elementIds = [...new Set(input.elementIds ?? [])];
    const chosenRelations = [...new Set(input.relationIds ?? [])];
    if (elementIds.length === 0 && chosenRelations.length === 0) {
        throw new ValidationError('Select at least one element or relation to ask about.', { reason: 'SCOPE_EMPTY' });
    }
    const elements = await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, elementIds);
    if (elements.length !== elementIds.length) throw new NotFoundError('Element not found.');
    const relations = await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, bookId, chosenRelations);
    if (relations.length !== chosenRelations.length) throw new NotFoundError('Relation not found.');
    const between = await BibleRelationRepository.listBetween(db, ctx.workspaceId, bookId, elementIds, SELECTION_RELATIONS_MAX + 1);
    const relationIds = [...new Set([...chosenRelations, ...between.map((r) => r.id)])];
    if (relationIds.length > SELECTION_RELATIONS_MAX) {
        throw new ValidationError('That selection holds more relations than one interview can ask about.', { reason: 'SCOPE_TOO_LARGE', max: SELECTION_RELATIONS_MAX });
    }
    // Element order: the order `listByIds` reads them in (kind, then name), so a session's subjects are stable.
    return { elementIds: elements.map((e) => e.id), relationIds, kinds: [...new Set(elements.map((e) => e.kind as BibleKind))] };
}

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

/** The act a beat stands in (the lane), or null. */
async function actsOf(db: PrismaTx, ctx: WorkspaceRequestContext, ids: readonly string[]): Promise<Map<string, string | null>> {
    const rows = await BibleFieldRepository.listForElements(db, ctx.workspaceId, ids, 50);
    const out = new Map<string, string | null>(ids.map((id) => [id, null]));
    for (const r of rows) {
        if (r.key !== ACT_FIELD_KEY) continue;
        const v = decodeFieldValue(r.value);
        out.set(r.elementId, typeof v === 'string' ? v : null);
    }
    return out;
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
    const ranked = await BibleElementRepository.rankedInOrder(db, ctx.workspaceId, bookId, SLOT_KIND as BibleElementKind, ORDER_SCOPE_MAX + 1);
    const inside = ranked.filter((r) => r.orderRank !== null && compareRanks(after.orderRank!, r.orderRank) < 0 && compareRanks(r.orderRank, before.orderRank!) < 0).map((r) => r.id);
    if (inside.length > 0) {
        const insideActs = await actsOf(db, ctx, inside);
        if (inside.some((id) => (insideActs.get(id) ?? null) === act)) throw slotInvalid('NOT_ADJACENT');
    }
    return { kind: SLOT_KIND, afterElementId: afterId, beforeElementId: beforeId, act };
}
